# Phase 2 Test & Cutover Plan

Run top to bottom. Do NOT run `migration.sql` until steps 1-5 pass.

## Pre-reqs (you / William provides)
- [ ] Supabase **JWT Secret** (Dashboard > Settings > API > JWT Secret)
- [ ] Choose a NEW owner password (the old `PlazaOwner2026` is burned — it's in git history)
- [ ] Generate its hash:  `printf '%s' 'NEWPASSWORD' | shasum -a 256`
- [ ] Supabase CLI installed + logged in, or use dashboard function deploy

## Step 1 — Deploy edge function (no app impact)
```
supabase functions deploy auth-token --no-verify-jwt --project-ref xpeppmurxgbqlsabswqn
supabase secrets set JWT_SECRET='<jwt secret>' OWNER_PASSWORD_HASH='<sha256 hex>' --project-ref xpeppmurxgbqlsabswqn
```
Verify with curl:
```
curl -s -X POST https://xpeppmurxgbqlsabswqn.supabase.co/functions/v1/auth-token \
  -H 'content-type: application/json' -H 'apikey: <anon key>' \
  -d '{"mode":"owner","password":"<new pw>"}' | jq .
# expect: { jwt, role:"owner", ... }
```
Decode the jwt at jwt.io — confirm `user_role:"owner"`, `role:"authenticated"`.

## Step 2 — Test contractor mint
```
curl ... -d '{"mode":"contractor","token":"<a real access_token from contractors table>"}'
# expect jwt with user_role:"contractor", project_id matching that contractor
```

## Step 3 — Deploy frontend patch to a STAGING copy first
- Apply `frontend-patch.md` to a copy of index.html.
- Serve locally (`python3 -m http.server`) pointed at live Supabase (still permissive).
- Owner login with new password → loads, all tabs work.
- Open `?key=<token>` → contractor view loads, sees only their project.

## Step 4 — Ship frontend to production
- Commit + push patched index.html. GitHub Pages serves it.
- Hard-refresh https://plazacore.plazaandassociates.com — confirm owner + a
  contractor link both still work (still on permissive RLS = safe).

## Step 5 — Dry-run the migration in a transaction (no commit)
In SQL editor, paste `migration.sql` but change final `commit;` to `rollback;`.
Confirm it runs with no errors. Then restore `commit;` for the real run.

## Step 6 — CUTOVER
- Run `migration.sql` (with `commit;`).
- Immediately test in a fresh browser:
  - [ ] Owner login works, sees all 3 projects
  - [ ] Contractor link works, sees ONLY their project
  - [ ] In devtools console, try reading another project as the contractor:
        `await sb.from('rfis').select('*')` → returns only their project's rows
  - [ ] Anon (no auth, e.g. curl with just anon key) → returns `[]` / 401
- If ANYTHING is broken → run `rollback.sql` (restores permissive state instantly),
  then debug.

## Step 7 — Storage RLS (after table cutover verified)
Buckets are private, but add storage.objects policies scoping by `project_id/`
path prefix so a contractor can't fetch another project's signed files. (Owner:
all. Contractor: name like `<project_id>/%`.) Drafted separately once cutover holds.

## Step 8 — Cleanup / rotate
- [ ] Rotate the Supabase **service_role** key (it sat plaintext in workspace).
- [ ] Update `data/supabase-plazacore.json` with rotated key (or move to secrets).
- [ ] Confirm old owner password no longer works anywhere.
- [ ] Squash git history note: old password is in prior commits — consider repo
      history scrub if the repo is ever public (currently check repo visibility).
```
```
