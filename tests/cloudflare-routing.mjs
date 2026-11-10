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
for (const path of ['/admin.css','/base.css','/admin.js','/ipa-upload.js']) {
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

// The manifest service never dereferences the loopback URL or touches assets.
const payload = 'http://127.0.0.1:4848/12345678-1234-1234-1234-123456789abc/app.ipa';
const manifestPath = values => '/install/manifest.plist?' + new URLSearchParams({url: payload, bundleid: 'com.example.fixture', version: '1.2+build', name: 'A&B <Fixture>', ...values});
const beforeManifest = calls.length;
const manifest = await fetchAt('source.zloader.de', manifestPath({}));
assert.equal(manifest.status, 200);
assert.equal(manifest.headers.get('cache-control'), 'no-store');
const xml = await manifest.text();
assert.ok(xml.includes('<string>A&amp;B &lt;Fixture&gt;</string>'));
assert.ok(xml.includes('<string>1.2+build</string>'));
assert.ok(xml.includes('<string>'+payload+'</string>'));
assert.equal(await (await fetchAt('source.zloader.de', manifestPath({}), 'HEAD')).text(), '');
assert.equal((await fetchAt('source.zloader.de', manifestPath({}), 'POST')).status, 405);
for (const url of ['https://example.com/app.ipa', 'http://192.168.1.2:4848/app.ipa', 'http://localhost:4848/app.ipa', payload+'?x=1', payload.replace(':4848', ':65536'), payload.replace('/app.ipa', '/../app.ipa'), payload.replace('127.0.0.1','user:pass@127.0.0.1')]) {
 assert.equal((await fetchAt('source.zloader.de', manifestPath({url}))).status, 400, url);
}
for (const values of [{bundleid: '<script>'}, {name: 'bad\u0000name'}, {version: 'bad&version'}, {name: 'x'.repeat(201)}]) {
 assert.equal((await fetchAt('source.zloader.de', manifestPath(values))).status, 400);
}
assert.equal((await fetchAt('source.zloader.de', manifestPath({})+'&url='+encodeURIComponent(payload))).status, 400);
for (const host of ['zloader.de','admin.zloader.de','example.invalid']) assert.equal((await fetchAt(host, manifestPath({}))).status, 404);
assert.equal(calls.length, beforeManifest);
console.log('PASS HTTPS manifest: loopback-only URLs, escaping, bounded metadata, duplicate/host/method rejection and no fetch/storage');
