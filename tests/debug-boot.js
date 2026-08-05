// One-off boot diagnostic: prints console + pageerrors + request failures.
const { chromium } = require('@playwright/test');
const { stubSupabase, stubCdn, SESSIONS } = require('./helpers');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    proxy: process.env.HTTPS_PROXY
      ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' }
      : undefined,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
  await stubCdn(page);
  await stubSupabase(page);
  await page.addInitScript((s) => {
    sessionStorage.setItem('plaza_session_auth_v3', JSON.stringify(s));
  }, SESSIONS.owner);
  await page.goto('http://localhost:4179/index.html');
  await page.waitForTimeout(8000);
  console.log('appShell display:', await page.locator('#appShell').evaluate((el) => getComputedStyle(el).display).catch(() => 'n/a'));
  console.log('body class:', await page.evaluate(() => document.body.className));
  await browser.close();
})();
