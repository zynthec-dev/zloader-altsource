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
  if (path === '/zloader/') return new Response('<html>zLoader</html>');
  if (path === '/zloader/site.css' || path === '/zloader/site.js' || path.startsWith('/assets/')) return new Response('asset');
  return new Response('Not found', { status: 404 });
} } };
const fetchAt = (host, path = '/', method = 'GET') => worker.fetch(new Request(`https://${host}${path}`, {method}), env);
for (const path of ['/', '/source.json', '/source.json?test=1']) {
 const response = await fetchAt('source.zloader.de', path);
 assert.equal(response.status, 200);
 assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
 assert.equal(response.headers.get('access-control-allow-origin'), '*');
 assert.deepEqual(await response.json(), {apps: []});
}
assert.equal(await (await fetchAt('source.zloader.de', '/', 'HEAD')).text(), '');
assert.equal((await fetchAt('source.zloader.de', '/', 'OPTIONS')).status, 204);
assert.equal((await fetchAt('source.zloader.de', '/', 'POST')).status, 405);
assert.equal((await fetchAt('source.zloader.de', '/assets/source-icon.png')).status, 200);
assert.equal(await (await fetchAt('zloader.de')).text(), '<html>zLoader</html>');
for (const path of ['/site.css', '/site.js']) assert.equal((await fetchAt('zloader.de',path)).status, 200);
const admin = await fetchAt('admin.zloader.de');
assert.equal(await admin.text(), '<html>Admin</html>');
assert.equal(admin.headers.get('x-frame-options'), 'DENY');
assert.equal((await fetchAt('admin.zloader.de', '/api/status')).status, 503);
for (const path of ['/admin.css','/base.css','/admin.js']) {
 await fetchAt('admin.zloader.de', path);
 assert.equal(new URL(calls.at(-1).url).pathname, '/admin'+path);
}
for (const host of ['source.zloader.de','zloader.de','admin.zloader.de']) {
 for (const path of ['/admin-api.js','/_worker.js','/missing','/zloader/index.html']) {
  assert.equal((await fetchAt(host,path)).status, 404, host+path);
 }
}
for (const host of ['source.zloader.de','zloader.de']) {
 for (const path of ['/admin/', '/api/status']) assert.equal((await fetchAt(host,path)).status,404);
}
console.log('Cloudflare routing: separate hosts, source root/JSON, HEAD/CORS, assets, admin API and host isolation passed.');
