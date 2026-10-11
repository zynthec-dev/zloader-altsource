// Browser regression for the public page; production checks never mutate the catalog.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LANDING_TEST_URL || 'https://zynthec.com/zloader';
const origin = new URL(base).origin;
const screenshots = process.env.LANDING_SCREENSHOTS || '/tmp/zloader-landing-qa';
await mkdir(screenshots, { recursive:true });
const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
  args:process.env.CHROME_RESOLVE ? ['--host-resolver-rules='+process.env.CHROME_RESOLVE] : [] });
try {
  const context = await browser.newContext({ viewport:{width:1536,height:1024}, permissions:['clipboard-read','clipboard-write'] });
  if (process.env.LANDING_TEST_ROOT) {
    const api = await readFile(new URL('../site/admin-api.js', import.meta.url), 'utf8');
    const code = (await readFile(new URL('../site/_worker.js', import.meta.url), 'utf8'))
      .replace('"./admin-api.js"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(api).toString('base64')}`));
    const { default:worker } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    await context.route(origin+'/**', async route => {
      const response = await worker.fetch(new Request(route.request().url()), {ASSETS:{fetch:async request => {
        let path = new URL(request.url).pathname;
        if (path.endsWith('/')) path += 'index.html';
        try {
          const types = {html:'text/html',css:'text/css',js:'text/javascript',png:'image/png',json:'application/json'};
          return new Response(await readFile(process.env.LANDING_TEST_ROOT+path), {headers:{'Content-Type':types[path.split('.').pop()] || 'application/octet-stream'}});
        } catch { return new Response('Not found',{status:404}); }
      }}});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  await page.goto(base);
  await page.getByRole('heading',{name:'Deine Apps. Dein iPhone.'}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Auf GitHub',exact:true}).getAttribute('href'),'https://github.com/zynthec-dev/zloader-app');
  assert.equal(await page.getByRole('link',{name:'Source',exact:true}).count(),0);
  assert.equal(await page.getByRole('navigation',{name:'Hauptnavigation'}).getByRole('link').count(),1);
  assert.equal(await page.locator('#source-url').inputValue(),'zynthec.com/zloader/source.json');
  // Playwright APIRequestContext bypasses route interception; read the build for isolated QA.
  const source = process.env.LANDING_TEST_ROOT ? JSON.parse(await readFile(process.env.LANDING_TEST_ROOT+'/source.json','utf8')) : await page.evaluate(async()=>await (await fetch('/zloader/source.json')).json());
  const app = source.apps.find(app=>app.bundleIdentifier==='com.zynthec.zLoader');
  assert.equal(await page.locator('#download').getAttribute('href'),app.versions[0].downloadURL);
  assert.ok(await page.locator('.app-icon').evaluate(image=>image.complete && image.naturalWidth>0));
  assert.ok(await page.locator('.footer').isVisible());
  await page.screenshot({path:screenshots+'/desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Kopieren',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Source-Adresse kopiert.'}).waitFor();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),origin+'/zloader/source.json');
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:screenshots+'/mobile.png',fullPage:true});
  await page.setViewportSize({width:320,height:740});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#download').evaluate(element=>getComputedStyle(element).transitionDuration),'0s');
  const denied = await context.newPage();
  await denied.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>Promise.reject(new Error('Permission denied'))}}));
  await denied.goto(base);
  await denied.locator('#copy').click();
  await denied.getByRole('status').filter({hasText:'manuell kopieren'}).waitFor();
  assert.equal(await denied.locator('#source-url').inputValue(),origin+'/zloader/source.json');
  assert.deepEqual(errors,[]);
  console.log('PASS: landing copy, GitHub/source/latest IPA links, real icon, clipboard and denial fallback, desktop/mobile/320px, reduced motion and browser errors.');
} finally { await browser.close(); }
