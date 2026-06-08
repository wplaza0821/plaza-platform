-- ============================================================
-- FIX: plz_access_token_hook 500 at JWT mint.
-- Cause: profiles has RLS enabled; the hook runs as role supabase_auth_admin
-- which has no satisfying SELECT policy, so the lookup fails inside auth.
-- Supabase-documented fix: add an RLS policy letting supabase_auth_admin read
-- profiles. (Grant alone is not enough once RLS is on.)
-- Re-runnable.
-- ============================================================

-- let the auth admin role read profiles for the token hook
drop policy if exists profiles_auth_admin_read on profiles;
create policy profiles_auth_admin_read on profiles
  for select
  to supabase_auth_admin
  using (true);

-- ensure the grants are present (idempotent)
grant usage on schema public to supabase_auth_admin;
grant select on profiles to supabase_auth_admin;
grant execute on function plz_access_token_hook(jsonb) to supabase_auth_admin;
