// Isolated UI regression: all GitHub traffic is intercepted; no real token is used.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ADMIN_TEST_URL || 'http://127.0.0.1:8767/zloader/admin/';
const screenshots = process.env.ADMIN_SCREENSHOTS || '/tmp/zynthec-altstore-source-admin-qa';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, colorScheme: 'light' });
 const page = await context.newPage();
 if (process.env.ADMIN_TEST_ROOT) {
  // Serve the exact generated site through Playwright to avoid host LAN permission prompts.
  await page.route('http://127.0.0.1:8767/**', async route => {
   let path = new URL(route.request().url()).pathname;
   if (path.startsWith('/zloader/')) path=path.slice('/zloader'.length);
   if (path.endsWith('/')) path += 'index.html';
   const types = { html:'text/html', css:'text/css', js:'text/javascript', png:'image/png' };
   try { await route.fulfill({ body: await readFile(process.env.ADMIN_TEST_ROOT + path), contentType: types[path.split('.').pop()] || 'application/octet-stream' }); }
   catch { await route.fulfill({ status:404, body:'Not found' }); }
  });
 }
 const errors = []; const consoleErrors = []; const mutations = [];
 page.on('pageerror', error => errors.push(error.message));
 page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
 const content = { localApps: {
  'example.other': { name: 'Another App', ipaFile: 'Another.ipa', marketingVersion: '1.0' },
  'de.renewitt.mipet': { name: 'miPet', ipaFile: 'miPet-0.3-beta.ipa', marketingVersion: '0.3-beta' }
 }, uploadedApps: [] };
 let settings = { name:'zLoader Source', subtitle:'iOS Apps', description:'Offizielle Source', tintColor:'#147D60', identifier:'com.zynthec.source', sourceURL:'https://zynthec.com/zloader/source.json', iconURL:'https://zynthec.com/zloader/assets/source-icon.png', githubRepository:'zynthec-dev/zynthec-altstore-source', releaseTag:'apps' };
 let settingsSha = 'SETTINGS_SHA'; let remoteSettingsChanged = false; let rejectRef = false;
 const blobs = new Map(); const trees = new Map(); let sequence = 0; let pendingTree;
 await page.route('https://zynthec.com/zloader/assets/source-icon.png', route => route.fulfill({ contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4x8AAAAASUVORK5CYII=', 'base64') }));
 let authenticated = false; let initialized = true; let connected = true; let testPassword = 'TEST_ONLY_PASSWORD_123';
 await page.route('**/admin/api/*', async route => {
  const action = new URL(route.request().url()).pathname.split('/').at(-1);
  const body = route.request().postDataJSON();
  let payload = {}; let status = 200;
  if (action === 'status') payload = {initialized,authenticated,connected};
  if (action === 'login') { if(body.password !== testPassword) {status=401;payload={message:'Passwort ist nicht korrekt.'};} else {authenticated=true;payload={authenticated:true};} }
  if (action === 'password') {
   if(body.currentPassword !== testPassword) {status=401;payload={message:'Das aktuelle Passwort ist nicht korrekt.'};}
   else {testPassword=body.password;payload={authenticated:true};}
  }
  if (action === 'logout') authenticated=false;
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
 });
 await page.route('**/admin/api/github/**', async route => {
  const method = route.request().method(), url = route.request().url();
  const body = method !== 'GET' ? JSON.parse(route.request().postData() || '{}') : null;
  if (method !== 'GET') mutations.push({ method, url, body: route.request().postData() });
  let payload;
  if (url.includes('/contents/catalog/settings.json')) payload = { sha:remoteSettingsChanged ? 'CHANGED_ELSEWHERE' : settingsSha, content:Buffer.from(JSON.stringify(settings)).toString('base64') };
  else if (url.includes('/contents/')) payload = method === 'GET' ? {sha:'TEST_ONLY', content:Buffer.from(JSON.stringify(content)).toString('base64')} : {content:{sha:'NEXT_TEST_SHA'}};
  else if (url.endsWith('/git/blobs')) { const sha = (++sequence).toString(16).padStart(40, 'a'); blobs.set(sha, Buffer.from(body.content, 'base64')); payload = { sha }; }
  else if (url.endsWith('/git/trees')) { const sha = `tree-${++sequence}`; trees.set(sha, body.tree); payload = {sha}; }
  else if (url.endsWith('/git/commits') && method === 'POST') { pendingTree = body.tree; payload = {sha:`commit-${++sequence}`}; }
  else if (url.includes('/git/commits/')) payload = {tree:{sha:'BASE_TREE'}};
  else if (url.includes('/git/ref/heads/')) payload = {object:{sha:'HEAD_SHA'}};
  else if (url.includes('/git/refs/heads/')) {
   if (rejectRef) { await route.fulfill({status:422, contentType:'application/json', body:JSON.stringify({message:'Not a fast forward'})}); return; }
   const entry = trees.get(pendingTree).find(item=>item.path==='catalog/settings.json');
   settingsSha = entry.sha; settings = JSON.parse(blobs.get(entry.sha)); payload = {object:{sha:body.sha}};
  } else payload = {permissions:{push:true}};
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
 });
 await page.goto(base);
 assert.equal(page.url(), base);
 assert.equal(await page.title(), 'zynthec App-Verwaltung');
 assert.ok(await page.getByRole('heading', {name:'Apps verwalten.'}).isVisible(), 'Meaningful login screen must render');
 await page.screenshot({ path: `${screenshots}/login-light.png`, fullPage: true, animations: "disabled" });
 await page.locator('#appearance').selectOption('dark');
 await page.screenshot({ path: `${screenshots}/login-dark.png`, fullPage: true, animations: "disabled" });
 await page.reload();
 assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
 await page.locator('#password').fill(testPassword);
 await page.locator('#connect').click();
 await page.locator('#dashboard:not(.hidden)').waitFor();
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('zynthecAdmin')),null);
 assert.equal(await page.locator('#password').inputValue(),'');
 await page.locator('#changePassword').click();
 await page.locator('#passwordForm input[name="currentPassword"]').fill(testPassword);
 await page.locator('#passwordForm input[name="password"]').fill('NEW_TEST_PASSWORD_123');
 await page.locator('#passwordForm input[name="confirmation"]').fill('MISMATCH');
 await page.getByRole('button',{name:'Passwort speichern',exact:true}).click();
 await page.getByText('Die Passwörter stimmen nicht überein.').waitFor();
 await page.locator('#passwordForm input[name="confirmation"]').fill('NEW_TEST_PASSWORD_123');
 await page.screenshot({path:`${screenshots}/password-change.png`,fullPage:true});
 await page.getByRole('button',{name:'Passwort speichern',exact:true}).click();
 await page.locator('#passwordEditor').waitFor({state:'hidden'});
 assert.equal(testPassword,'NEW_TEST_PASSWORD_123');
 assert.equal(await page.locator('#sourceName').innerText(), 'zLoader Source');
 assert.match(await page.locator('.admin-item').first().innerText(), /Another App/);
 await page.screenshot({ path: `${screenshots}/dashboard-dark.png`, fullPage: true, animations: "disabled" });
 await page.locator('.admin-item').first().press('Enter');
 await page.locator('#editorForm input[name="name"]').fill('');
 await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
 assert.equal(await page.locator('#editor').evaluate(e => e.open), false);
 assert.equal(mutations.length, 0, 'Cancel must not submit changes');
 await page.locator('#editSource').click();
 await page.locator('#sourceForm input[name="name"]').fill('Nicht speichern');
 await page.locator('#cancelSource').click();
 assert.equal(mutations.length, 0, 'Cancelling source settings must not write');
 await page.locator('#editSource').click();
 await page.locator('#sourceForm input[name="icon"]').setInputFiles({name:'invalid.png', mimeType:'image/png', buffer:Buffer.from('not a png')});
 await page.getByRole('button', {name:'Source speichern', exact:true}).click();
 await page.getByText('Bitte ein gültiges PNG-Bild auswählen.').waitFor();
 assert.equal(mutations.length, 0, 'Invalid icons must be rejected before any write');
 await page.locator('#cancelSource').click();
 await page.locator('#editSource').click();
 remoteSettingsChanged = true;
 await page.getByRole('button', {name:'Source speichern', exact:true}).click();
 await page.getByText(/Die Source wurde inzwischen geändert/).waitFor();
 assert.equal(mutations.length, 0, 'Changed source settings must not be overwritten');
 remoteSettingsChanged = false;
 await page.locator('#cancelSource').click();
 await page.locator('#editSource').click();
 await page.locator('#sourceForm input[name="name"]').fill('Meine Source');
 await page.locator('#sourceForm input[name="subtitle"]').fill('Eigene Apps');
 await page.locator('#sourceForm textarea[name="description"]').fill('Meine neue Beschreibung');
 await page.locator('#sourceForm input[name="tintColor"]').fill('#123456');
 const png = await readFile(new URL('../icon.png', import.meta.url));
 await page.locator('#sourceForm input[name="icon"]').setInputFiles({name:'icon.png', mimeType:'image/png', buffer:png});
 await page.screenshot({path:`${screenshots}/source-settings-desktop.png`, fullPage:true, animations:'disabled'});
 await page.getByRole('button', {name:'Source speichern', exact:true}).click();
 await page.locator('#sourceEditor').waitFor({state:'hidden'});
 assert.equal(await page.locator('#sourceName').innerText(), 'Meine Source');
 assert.equal(settings.description, 'Meine neue Beschreibung');
 assert.equal(settings.tintColor, '#123456');
 assert.equal(settings.identifier, 'com.zynthec.source');
 assert.equal(settings.githubRepository, 'zynthec-dev/zynthec-altstore-source');
 assert.equal(settings.sourceURL, 'https://zynthec.com/zloader/source.json');
 const sourceTree = mutations.find(item=>item.url.endsWith('/git/trees'));
 assert.deepEqual(JSON.parse(sourceTree.body).tree.map(item=>item.path), ['catalog/settings.json','icon.png']);
 assert.equal(JSON.parse(mutations.find(item=>item.url.includes('/git/refs/heads/')).body).force, false);
 await page.locator('#editSource').click();
 assert.equal(await page.locator('#sourceForm input[name="name"]').inputValue(), 'Meine Source');
 rejectRef = true;
 await page.locator('#sourceForm input[name="name"]').fill('Nicht überschreiben');
 await page.getByRole('button', {name:'Source speichern', exact:true}).click();
 await page.getByText(/Inzwischen wurde eine andere Änderung gespeichert/).waitFor();
 assert.equal(await page.locator('#sourceName').innerText(), 'Meine Source');
 rejectRef = false;
 await page.locator('#cancelSource').click();
 await page.locator('#changePassword').click();
 await page.screenshot({path:`${screenshots}/password-mobile.png`,fullPage:true,animations:'disabled'});
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Password form must fit mobile');
 await page.locator('#cancelPassword').click();
 await page.locator('.admin-item').first().click();
 assert.equal(await page.locator('#editorForm input[name="name"]').inputValue(), 'Another App');
 await page.getByRole('button', { name: 'Schließen', exact: true }).click();
 await page.locator('#appearance').selectOption('light');
 await page.screenshot({ path: `${screenshots}/dashboard-light.png`, fullPage: true, animations: "disabled" });
 await page.setViewportSize({ width: 390, height: 844 });
 await page.screenshot({ path: `${screenshots}/mobile-light.png`, fullPage: true, animations: "disabled" });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
 await page.locator('#editSource').click();
 await page.screenshot({path:`${screenshots}/source-settings-mobile.png`, fullPage:true, animations:'disabled'});
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Source settings must fit mobile');
 await page.locator('#cancelSource').click();
 await page.locator('.admin-item').first().click();
 await page.screenshot({ path: `${screenshots}/editor-mobile.png`, fullPage: true, animations: "disabled" });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 await page.emulateMedia({ reducedMotion: 'reduce' });
 assert.equal(await page.locator('.primary-button').first().evaluate(e => getComputedStyle(e).transitionDuration), '0s');
 await page.getByRole('button', { name: 'Schließen', exact: true }).click();
 await page.getByRole('button', { name: 'App hochladen' }).click();
 await page.locator('#editorForm input[name="name"]').fill('Demo App');
 await page.locator('#editorForm input[name="marketingVersion"]').fill('1.0');
 await page.locator('#editorForm textarea[name="versionDescription"]').fill('Erste Testversion');
 await page.locator('#editorForm input[name="ipa"]').setInputFiles({ name: 'Demo-1.0.ipa', mimeType: 'application/octet-stream', buffer: Buffer.from('test ipa') });
 await page.getByRole('button', { name: 'Speichern', exact: true }).click();
 await page.locator('#appsList .pin-label').getByText('Veröffentlichung läuft', {exact:true}).waitFor();
 const blob = mutations.filter(item => item.url.endsWith('/git/blobs')).at(-1);
 assert.equal(blob.method, 'POST');
 assert.equal(JSON.parse(blob.body).encoding, 'base64');
 const saved = mutations.find(item => item.method === 'PUT' && item.url.includes('/contents/catalog/content.json'));
 const staged = JSON.parse(Buffer.from(JSON.parse(saved.body).content, 'base64').toString()).uploadedApps[0];
 assert.equal(staged.name, 'Demo App');
 assert.equal(staged.versionDescription, 'Erste Testversion');
 assert.match(staged.releaseTag, /^app-demo-app-v1-0-\d{8}T\d{6}Z-[a-f0-9]{8}$/);
 assert.ok(blobs.has(staged.pendingUpload.sha));
 assert.deepEqual(blobs.get(staged.pendingUpload.sha), Buffer.from('test ipa'));
 await page.locator('#logout').click();
 await page.locator('#loginPanel:not(.hidden)').waitFor();
 assert.equal(authenticated,false);
 assert.equal(await page.locator('#setupToken, #setupConfirm, #token').count(),0);
 connected=false;
 await page.locator('#password').fill(testPassword);
 await page.locator('#connect').click();
 await page.locator('#dashboard:not(.hidden)').waitFor();
 assert.ok(await page.locator('#serverStatus:not(.hidden)').isVisible());
 assert.ok(await page.locator('#addApp').isDisabled());
 assert.ok(await page.locator('#changePassword').isEnabled());
 await page.locator('#changePassword').click();
 await page.locator('#passwordEditor').waitFor({state:'visible'});
 await page.locator('#cancelPassword').click();
 await page.locator('#logout').click();
 await page.locator('#loginPanel:not(.hidden)').waitFor();
 initialized=false;
 await page.reload();
 await page.getByText('Der Admin-Zugang muss serverseitig eingerichtet werden.').waitFor();
 assert.ok(await page.locator('#connect').isDisabled());
 assert.deepEqual(errors, []);
 assert.equal(consoleErrors.length, 1, 'Only the deliberately simulated GitHub conflict may appear in the console');
 assert.match(consoleErrors[0], /status of 422/);
 console.log('PASS: source settings, atomic icon save, conflicts, invalid PNG, cancel, app ordering, staged IPA upload, theme, desktop/mobile and browser errors');
} finally { await browser.close(); }
