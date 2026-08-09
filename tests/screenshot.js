// Capture UI screenshots for review (not part of the test suite).
const { chromium } = require('@playwright/test');
const { stubSupabase, stubCdn, SESSIONS } = require('./helpers');

const OUT = process.argv[2] || '.';

async function shot(ctx, roleKey, name, { viewport, collapse } = {}) {
  const page = await ctx.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await stubCdn(page);
  await stubSupabase(page);
  await page.addInitScript((s) => {
    sessionStorage.setItem('plaza_session_auth_v3', JSON.stringify(s));
  }, SESSIONS[roleKey]);
  await page.goto('http://localhost:4179/index.html');
  await page.waitForSelector('#appShell', { state: 'visible' });
  await page.waitForTimeout(1500);
  if (collapse) { await page.locator('#railToggle').click(); await page.waitForTimeout(300); }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    proxy: process.env.HTTPS_PROXY
      ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' }
      : undefined,
  });
  await shot(ctx, 'owner', 'owner-desktop');
  await shot(ctx, 'owner', 'owner-collapsed', { collapse: true });
  await shot(ctx, 'contractor_limited', 'contractor-limited');
  await shot(ctx, 'owner', 'mobile', { viewport: { width: 390, height: 844 } });
  await browser.close();
})();
