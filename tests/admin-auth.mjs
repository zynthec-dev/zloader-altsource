import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const code = await readFile(new URL('../site/admin-api.js', import.meta.url), 'utf8');
const { adminAPI, passwordHash } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const folder = await mkdtemp(join(tmpdir(), 'source-admin-auth-'));
const database = join(folder, 'admin.sqlite');
// Use real SQLite to exercise D1 SQL without adding runtime/test dependencies.
const python = `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row
queries=json.load(sys.stdin); result=[]
with db:
 for q in queries:
  before=db.total_changes; cursor=db.execute(q['sql'],q.get('params',[]))
  rows=[dict(r) for r in cursor.fetchall()] if cursor.description else []
  result.append({'results':rows,'meta':{'changes':db.total_changes-before}})
print(json.dumps(result))`;
const execute = statements => JSON.parse(execFileSync('python3', ['-c', python, database], {
  input: JSON.stringify(statements.map(s=>({sql:s.sql,params:s.params}))), encoding: 'utf8',
}));
class Statement {
  constructor(sql) { this.sql=sql; this.params=[]; }
  bind(...params) { this.params=params; return this; }
  async first() { return execute([this])[0].results[0] || null; }
  async run() { return execute([this])[0]; }
}
const db = { prepare: sql => new Statement(sql), batch: async statements => execute(statements) };
const env = { ADMIN_DB: db, ADMIN_ENCRYPTION_KEY: 'ab'.repeat(32) };
const origin = 'https://admin.zloader.de';
const request = (route, body, sessionCookie, headers={}) => new Request(`${origin}/admin/api/${route}`, {
  method:body===undefined?'GET':'POST',
  headers:{'Content-Type':'application/json','X-Admin-Request':'1', Origin:origin,
    ...(sessionCookie?{Cookie:sessionCookie}:{}), ...headers},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
const call = (route, body, cookie, headers) => adminAPI(request(route,body,cookie,headers),env);
const password = 'test-only-password-123';
const token = 'test-only-not-a-real-token';
const originalFetch=globalThis.fetch;
const originalNow=Date.now;
// Keep authentication checks within a known rate-limit window even when the
// real build crosses a quarter-hour boundary. Advance explicitly to test reset.
let testNow=Date.UTC(2026,9,18,12,7,0);
Date.now=()=>testNow;
let upstreamCalls=0;
globalThis.fetch=async (url, options) => {
  upstreamCalls++;
  if(url.startsWith('https://raw.githubusercontent.com/')) return new Response('{"name":"Public catalog"}');
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  if(url.endsWith('/zloader-altsource')) return Response.json({permissions:{push:true}});
  return Response.json({content:'test-content'});
};
try {
  const schema = await readFile(new URL('../migrations/0001_admin.sql', import.meta.url),'utf8');
  execute(schema.split(';').filter(s=>s.trim()).map(sql=>({sql,params:[]})));
  assert.equal((await adminAPI(request('status'),{})).status,503);
  assert.deepEqual(await (await call('status')).json(),{initialized:false,authenticated:false,connected:false});
  assert.equal((await call('github/contents/catalog/content.json')).status,401);
  assert.equal((await call('login',{password},null,{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('setup',{password,token})).status,404);
  assert.equal((await call('connection',{token})).status,404);
  // Administrative provisioning is server-side only, never a browser token form.
  const salt='cd'.repeat(32);
  const key=await crypto.subtle.importKey('raw',Buffer.from(env.ADMIN_ENCRYPTION_KEY,'hex'),'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(token))).toString('hex');
  await db.prepare('INSERT INTO admin_config(id,salt,password_hash,revision,github_token) VALUES(1,?,?,1,?)')
    .bind(salt,await passwordHash(password,salt),`${Buffer.from(iv).toString('hex')}:${encrypted}`).run();
  let response=await call('login',{password});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(await response.text(),/test-only|github_token|password_hash/);
  const config=await db.prepare('SELECT * FROM admin_config').first();
  assert.notEqual(config.github_token,token);
  assert.notEqual(config.password_hash,password);
  assert.equal((await call('setup',{password,token})).status,404);
  assert.equal((await call('login',{password:'wrong-password'})).status,401);
  response=await call('login',{password});
  assert.equal(response.status,200);
  const secondCookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await call('status',undefined,cookie)).json()).authenticated,true);
  assert.equal((await call('github/contents/catalog/content.json',undefined,cookie)).status,200);
  // Secret copy/paste whitespace must not break the Authorization header.
  env.GITHUB_TOKEN = ` \n${token}\r\n`;
  assert.equal((await call('github/contents/catalog/content.json',undefined,cookie)).status,200);
  env.GITHUB_TOKEN = 'invalid\nsecret';
  const beforeMalformed=upstreamCalls;
  response=await call('github/contents/catalog/content.json',undefined,cookie);
  assert.equal(response.status,503);
  assert.match((await response.json()).message,/GITHUB_TOKEN/);
  assert.equal(upstreamCalls,beforeMalformed);
  env.GITHUB_TOKEN = token;
  const healthyFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new TypeError('test upstream failure');};
  assert.equal((await call('github/contents/catalog/content.json',undefined,cookie)).status,502);
  globalThis.fetch=async()=>Response.json({message:'Bad credentials'},{status:401});
  response=await call('github/contents/catalog/content.json',undefined,cookie);
  assert.equal(response.status,503);
  assert.match((await response.json()).message,/abgelehnt/);
  globalThis.fetch=healthyFetch;
  delete env.GITHUB_TOKEN;
  const callsBefore=upstreamCalls;
  assert.equal((await call('github/contents/.github/workflows/deploy.yml',{},cookie)).status,403);
  assert.equal(upstreamCalls,callsBefore);
  assert.equal((await call('password',{currentPassword:'wrong',password:'new-test-password-123'},cookie)).status,401);
  response=await call('password',{currentPassword:password,password:'new-test-password-123'},cookie);
  assert.equal(response.status,200);
  const newCookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await call('status',undefined,cookie)).json()).authenticated,false);
  assert.equal((await (await call('status',undefined,secondCookie)).json()).authenticated,false);
  assert.equal((await (await call('status',undefined,newCookie)).json()).authenticated,true);
  await db.prepare('DELETE FROM admin_attempts').run();
  assert.equal((await call('login',{password})).status,401);
  assert.equal((await call('login',{password:'new-test-password-123'})).status,200);
  assert.equal((await call('logout',{},newCookie)).status,200);
  assert.equal((await (await call('status',undefined,newCookie)).json()).authenticated,false);
  await db.prepare('DELETE FROM admin_attempts').run();
  for(let i=0;i<8;i++) assert.equal((await call('login',{password:'incorrect'})).status,401);
  assert.equal((await call('login',{password:'incorrect'})).status,429);
  testNow+=900_000;
  assert.equal((await call('login',{password:'incorrect'})).status,401);
  // Missing credentials allow catalog viewing and password changes but no writes.
  await db.prepare('DELETE FROM admin_attempts').run();
  await db.prepare("UPDATE admin_config SET github_token='' WHERE id=1").run();
  assert.equal((await call('connection',{token})).status,404);
  response=await call('login',{password:'new-test-password-123'});
  const pendingCookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await call('status',undefined,pendingCookie)).json()).connected,false);
  const catalog=await (await call('github/contents/catalog/content.json',undefined,pendingCookie)).json();
  assert.equal(JSON.parse(Buffer.from(catalog.content,'base64')).name,'Public catalog');
  assert.match(catalog.sha,/^[a-f0-9]{40}$/);
  assert.equal((await call('github/git/blobs',{encoding:'base64',content:'test'},pendingCookie)).status,503);
  env.GITHUB_TOKEN=token;
  assert.equal((await (await call('status',undefined,pendingCookie)).json()).connected,true);
  assert.equal((await call('github/contents/catalog/content.json',undefined,pendingCookie)).status,200);
  assert.equal((await call('connection',{token},pendingCookie)).status,404);
  console.log('PASS: password-only login, encrypted/server-only credentials, public catalog fallback, write blocking, cookies, proxy restrictions, CSRF, password change, revocation, logout and throttling.');
} finally {
  globalThis.fetch=originalFetch;
  Date.now=originalNow;
  await rm(folder,{recursive:true,force:true});
}
