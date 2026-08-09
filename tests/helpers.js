// Shared harness: session seeding + Supabase network stubbing.
// The app restores legacy sessions from sessionStorage['plaza_session_auth_v3'];
// contractor sessions re-mint their JWT through /functions/v1/auth-token, which
// the route stub answers. All *.supabase.co REST reads get fixture data so every
// page renders without touching the real backend.

const fs = require('fs');
const path = require('path');

// Syntactically valid (decodable) but unsigned JWT — payload {}.
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.c2ln';

// The sandbox network policy blocks cdn.jsdelivr.net, so the app's CDN
// modules are vendored from npm (see vendor/: esbuild-bundled supabase-js +
// pdfjs-dist build files) and served to the browser via route interception.
const VENDOR = path.join(__dirname, 'vendor');
const CDN_FILES = {
  '/npm/@supabase/supabase-js@2/+esm': 'supabase-js.mjs',
  '/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs': 'pdf.min.mjs',
  '/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs': 'pdf.worker.min.mjs',
};
async function stubCdn(page) {
  await page.route('https://cdn.jsdelivr.net/**', (route) => {
    const file = CDN_FILES[new URL(route.request().url()).pathname];
    if (!file) return route.abort();
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: fs.readFileSync(path.join(VENDOR, file)),
    });
  });
}

const PROJECT_FIXTURE = [{
  id: 'p1',
  code: 'TP-01',
  name: 'Test Project',
  status: 'active',
  client: 'Test Client',
  address: '1 Test St',
  created_at: '2026-01-01T00:00:00Z',
}];

const SESSIONS = {
  owner:      { role: 'owner',  name: 'Test Owner',  jwt: FAKE_JWT },
  staff:      { role: 'staff',  name: 'Test Staff',  jwt: FAKE_JWT },
  member:     { role: 'member', name: 'Test Member', jwt: FAKE_JWT },
  member_nofin: {
    role: 'member', name: 'Field Member', jwt: FAKE_JWT,
    permissions: { no_financials: true },
  },
  contractor: {
    role: 'contractor', name: 'Test GC', token: 'tok-1', jwt: FAKE_JWT,
    projectId: 'p1',
    permissions: { rfis: true, submittals: true, payapps: true, plans: true, cos: true },
  },
  contractor_limited: {
    role: 'contractor', name: 'Limited GC', token: 'tok-2', jwt: FAKE_JWT,
    projectId: 'p1',
    permissions: { rfis: true },
  },
};

async function stubSupabase(page) {
  await page.route('**/*.supabase.co/**', (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.startsWith('/functions/v1/auth-token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jwt: FAKE_JWT, name: 'Test GC' }),
      });
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (method !== 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
      const body = table === 'projects' ? JSON.stringify(PROJECT_FIXTURE) : '[]';
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    // auth/storage/realtime — respond blandly so nothing hangs or throws.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

// Boot the app as a given role. Returns collected uncaught page errors.
async function bootAs(page, roleKey, { viewport } = {}) {
  const session = SESSIONS[roleKey];
  if (!session) throw new Error('unknown role: ' + roleKey);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (viewport) await page.setViewportSize(viewport);
  await stubCdn(page);
  await stubSupabase(page);
  await page.addInitScript((s) => {
    sessionStorage.setItem('plaza_session_auth_v3', JSON.stringify(s));
  }, session);
  await page.goto('/index.html');
  await page.waitForSelector('#appShell', { state: 'visible', timeout: 20_000 });
  // Let boot's async data loads + render settle.
  await page.waitForTimeout(1200);
  return errors;
}

const tabVisible = (page, tab) =>
  page.locator(`#tabs .tab[data-tab="${tab}"]`).isVisible();

module.exports = { SESSIONS, FAKE_JWT, PROJECT_FIXTURE, stubSupabase, stubCdn, bootAs, tabVisible };
