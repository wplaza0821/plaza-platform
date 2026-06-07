# Plazacore Phase 2 — RLS Hardening Package

**Status:** STAGED. Nothing here has been applied to the live DB or deployed site.
**Author:** Lola · 2026-06-07
**Goal:** Replace wide-open `anon read/write` RLS with JWT-scoped policies so the
database — not the UI — enforces who can see/touch what.

## The problem we are fixing

Today every browser talks to Supabase with the **anon publishable key** and the
RLS policies are `using (true)` / `with check (true)` on every table. That means:

- Anyone with the site URL + devtools can read/write/delete **every project's**
  RFIs, pay apps, lien waivers, SOV, deficiencies — all of it.
- The owner password (`OWNER_PASSWORD`) is hardcoded in `index.html` (view-source).
- Contractor "auth" is just a row lookup on `contractors.access_token` using the
  same anon key — not a real credential.

## The Phase 2 model

We introduce a tiny **Supabase Edge Function (`auth-token`)** that is the ONLY
thing allowed to read the `contractors` table / verify the owner password. It
mints a short-lived **signed JWT** containing the caller's role + project scope:

```
owner JWT:      { role: "owner" }
contractor JWT: { role: "contractor", project_id: "<uuid>", perms: {...}, contractor_id }
```

The frontend attaches that JWT on the supabase-js client. New RLS policies read
`auth.jwt()` claims and scope every row to the caller. No JWT ⇒ no access.

## Apply order (DO NOT REORDER — wrong order = outage)

1. Deploy edge function `auth-token` (see `edge-function/index.ts`) and set the
   `OWNER_PASSWORD_HASH` + `JWT_SECRET` secrets. **App still works during this —
   nothing reads the function yet.**
2. Deploy frontend patch (`frontend-patch.md`). It calls `auth-token`, stores the
   JWT, and sets it on the client. **Old anon policies still permit everything, so
   even un-migrated clients keep working — zero downtime window.**
3. ONLY after #1 and #2 are live and verified: run `migration.sql` to swap the
   policies. This is the cutover. Have `rollback.sql` ready.
4. Rotate the `service_role` key (it currently sits plaintext in the workspace).

## Files

- `edge-function/index.ts` — mints scoped JWTs (Deno / Supabase Edge runtime)
- `migration.sql`          — the JWT-scoped RLS policies (the cutover)
- `rollback.sql`           — instantly restores the permissive policies
- `frontend-patch.md`      — exact code changes to index.html
- `TEST-PLAN.md`           — verification steps before + after cutover
