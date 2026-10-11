import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../site/admin-api.js', import.meta.url), 'utf8');
const code = (await readFile(new URL('../site/_worker.js', import.meta.url), 'utf8'))
  .replace('"./admin-api.js"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(api).toString('base64')}`));
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const calls = [];
const env = { ASSETS: { fetch: async request => {
  calls.push(request);
  const path = new URL(request.url).pathname;
  if (path === '/source.json') return new Response(request.method === 'HEAD' ? null : '{"apps":[]}', {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (path === '/admin/') return new Response('<html>Admin</html>');
  if (path === '/zloader/index.html') return Response.redirect('https://zynthec.com/zloader/',308);
  if (path === '/zloader/') return new Response('<html>zLoader</html>');
  if (path === '/zloader/site.css' || path === '/zloader/site.js' || path.startsWith('/assets/')) return new Response('asset');
  return new Response('Not found', { status: 404 });
} } };
const base = 'https://zynthec.com/zloader';
const request = (path, method = 'GET') => new Request(`${base}${path}`, { method });

let response = await worker.fetch(request('/source.json'), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
assert.equal(response.headers.get('access-control-allow-origin'), '*');
assert.deepEqual(await response.json(), { apps: [] });
assert.equal(new URL(calls.at(-1).url).pathname, '/source.json');

response = await worker.fetch(request('/source.json', 'HEAD'), env);
assert.equal(await response.text(), '');
response = await worker.fetch(request('/source.json', 'OPTIONS'), env);
assert.equal(response.status, 204);
assert.equal(response.headers.get('access-control-allow-origin'), '*');
response = await worker.fetch(request('/source.json', 'POST'), env);
assert.equal(response.status, 405);
response = await worker.fetch(request('/source.json?test=1'), env);
assert.equal(response.status, 200);
response = await worker.fetch(request('/admin'), env);
assert.equal(response.status, 308);
assert.equal(response.headers.get('location'), `${base}/admin/`);
response = await worker.fetch(request('/admin/'), env);
assert.equal(await response.text(), '<html>Admin</html>');
assert.equal(response.headers.get('x-frame-options'), 'DENY');
response = await worker.fetch(request('/admin/api/status'), env);
assert.equal(response.status, 503);
response = await worker.fetch(request('/missing'), env);
assert.equal(response.status, 404);
for (const path of ['', '/']) {
  response = await worker.fetch(request(path), env);
  assert.equal(await response.text(), '<html>zLoader</html>');
  assert.equal(new URL(calls.at(-1).url).pathname, '/zloader/');
}
for (const path of ['/site.css', '/site.js', '/assets/source-icon.png', '/assets/apps/com.zynthec.zLoader.png']) {
  response = await worker.fetch(request(path), env);
  assert.equal(response.status, 200);
}
for (const path of ['/', '/admin/', '/source.json', '/zloader/source', '/zloader/source/admin/', '/zloader-extra', '/zloader/admin-api.js', '/zloader/index.html']) {
  response = await worker.fetch(new Request('https://zynthec.com' + path), env);
  assert.equal(response.status,404,`Retired or unrelated path ${path} must not serve the Source`);
}
for (const [path,target] of [['/','/source.json'],['/source.json','/source.json'],['/assets/source-icon.png','/assets/source-icon.png'],['/admin','/admin']]) {
  response = await worker.fetch(new Request('https://zloader.zynthec.com'+path),env);
  assert.equal(response.status,308);
  assert.equal(response.headers.get('location'),base+target);
}
console.log('Cloudflare routing: landing page/assets, source.json, HEAD, CORS, admin redirect/API, compatibility and retired paths passed.');
