# Frontend Patch — index.html (Phase 2)

Goal: stop authenticating with the raw anon key alone. After login (owner) or
token boot (contractor), call the `auth-token` edge function, get a scoped JWT,
and set it on the supabase-js client so every one of the 84 call sites is
automatically authenticated. **No call site needs to change** — they all use the
shared `sb` client, which now carries the JWT.

## Patch 1 — client init + auth endpoint (around line 1112-1125)

REPLACE:
```js
const SUPABASE_URL = 'https://xpeppmurxgbqlsabswqn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_rLNpcKk37j6YR0R_jf8EEw_fvB5wHh4';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
```
WITH:
```js
const SUPABASE_URL = 'https://xpeppmurxgbqlsabswqn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_rLNpcKk37j6YR0R_jf8EEw_fvB5wHh4';
const AUTH_FN_URL  = SUPABASE_URL + '/functions/v1/auth-token';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Attach a minted JWT to the shared client so RLS sees user_role/project_id.
function setSbAuth(jwt) {
  // supabase-js v2: override the Authorization header on the shared client.
  sb.rest.headers['Authorization'] = 'Bearer ' + jwt;
  sb.realtime.setAuth(jwt);
  // storage uses the same gotrue header:
  if (sb.storage && sb.storage.headers) sb.storage.headers['Authorization'] = 'Bearer ' + jwt;
}

async function mintToken(body) {
  const res = await fetch(AUTH_FN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'apikey': SUPABASE_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return res.json(); // { jwt, role, ... }
}
```

DELETE the hardcoded password line (1125):
```js
const OWNER_PASSWORD    = 'PlazaOwner2026';   // <-- remove entirely
```

## Patch 2 — owner login (handleLogin, ~line 1252)

REPLACE the whole `handleLogin` with an async version that verifies server-side:
```js
async function handleLogin(password) {
  const out = await mintToken({ mode: 'owner', password });
  if (!out || !out.jwt) return false;
  setSbAuth(out.jwt);
  AUTH = { role: 'owner', name: out.name || 'William Plaza', jwt: out.jwt };
  sessionStorage.setItem(SESSION_AUTH_KEY, JSON.stringify(AUTH));
  return true;
}
```
> NOTE: the login form submit handler must `await handleLogin(...)`. Find the
> form listener (search `loginForm`) and make its callback `async` + `await`.

## Patch 3 — contractor boot (tryBootAuth, ~line 1206)

After the contractor row is found and BEFORE building `AUTH`, mint a JWT:
```js
    if (contractor) {
      const out = await mintToken({ mode: 'contractor', token: key });
      if (!out || !out.jwt) { handleSbError({message:'Auth failed'}, 'Token rejected'); return false; }
      setSbAuth(out.jwt);
      AUTH = {
        role: 'contractor',
        name: contractor.name,
        contractorId: contractor.id,
        projectId: contractor.project_id,
        permissions: contractor.permissions || defaultContractorModules(),
        token: key,
        jwt: out.jwt,
      };
      sessionStorage.setItem(SESSION_AUTH_KEY, JSON.stringify(AUTH));
      return true;
    }
```

## Patch 4 — restore session (tryBootAuth, sessionStorage branch ~line 1231)

When restoring `saved`, re-attach the stored JWT (and re-mint if expired):
```js
    const saved = JSON.parse(raw);
    if (saved.jwt) setSbAuth(saved.jwt);
    if (saved.role === 'contractor' && saved.token) {
      // re-mint to be safe (JWT may have expired) using the still-valid token
      const out = await mintToken({ mode: 'contractor', token: saved.token });
      if (!out || !out.jwt) { sessionStorage.removeItem(SESSION_AUTH_KEY); return false; }
      setSbAuth(out.jwt);
      saved.jwt = out.jwt;
      sessionStorage.setItem(SESSION_AUTH_KEY, JSON.stringify(saved));
    }
    AUTH = saved;
    return true;
```
> For an expired OWNER session there is no stored password to re-mint with, so
> an expired owner JWT should just fall through to the login screen. That's fine.

## Why this is zero-downtime

Patches 1-4 ship while the **old permissive RLS is still live**. A client with a
JWT works; a client without one ALSO still works (anon policies permit all). Only
when you run `migration.sql` does the JWT become mandatory — and by then every
client is minting one. No moment where the app is broken.

## Contractor token note

`contractors.access_token` lookups now happen INSIDE the edge function (service
role), so locking the `contractors` table to owner-only in the migration does not
break contractor login.
