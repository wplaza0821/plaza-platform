# Plazacore functional test suite

Playwright tests that boot `../index.html` as every role the platform knows
(owner, staff, member, member+no_financials, contractor with full module
permissions, contractor with a single permission) and verify:

- the app shell boots with the correct `role-*` body class
- the **tab visibility matrix** — which nav tools each role may see
  (Users owner-only, Financials hidden under `no_financials`, contractor
  module permissions, legacy-session Profile hiding)
- every visible tab renders its page with **zero uncaught JS errors**
- access guards hold even when navigation is forced via `switchTab()`
- edit affordances (e.g. ＋ New Project) hidden for read-only roles
- nav groups auto-hide when all their tools are permission-hidden
- the collapsible rail (persists across reload) and the mobile strip layout

No real backend is touched: `*.supabase.co` is stubbed with fixtures, and the
CDN modules (supabase-js, pdf.js) are vendored from npm because the app's
jsdelivr URLs may be unreachable in CI sandboxes. Service workers are blocked
so route stubbing stays authoritative.

## Running

```bash
cd tests
npm install        # once
npm test           # builds vendor/ bundles, then runs the suite
```

Requires a Chromium Playwright can find (CI images: set
`PLAYWRIGHT_BROWSERS_PATH` or edit `executablePath` in
`playwright.config.js`).

`debug-boot.js` prints browser console/page errors for one role when the shell
won't boot; `screenshot.js <outdir>` captures desktop/collapsed/mobile shots.
