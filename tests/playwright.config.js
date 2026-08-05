// Playwright config for the Plazacore access-matrix suite.
// Serves the repo root statically; browser egress rides the sandbox's agent
// proxy (jsdelivr ESM libs) while all *.supabase.co traffic is stubbed in-test.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 60_000,
  retries: 1,
  workers: 4,
  reporter: [['list']],
  webServer: {
    command: 'python3 -m http.server 4179 --directory ..',
    port: 4179,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:4179',
    headless: true,
    ignoreHTTPSErrors: true,
    // The app registers a service worker whose fetch handler would bypass the
    // test route stubs on reload; block SWs so interception stays authoritative.
    serviceWorkers: 'block',
    proxy: process.env.HTTPS_PROXY
      ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' }
      : undefined,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
});
