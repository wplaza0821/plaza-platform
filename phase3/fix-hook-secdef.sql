-- ============================================================
-- FIX 2: plz_access_token_hook still 500s when GoTrue (role supabase_auth_admin)
-- runs it, even though the same function returns correctly under service_role.
-- Root cause: function was STABLE (not SECURITY DEFINER), so the profiles SELECT
-- executed as supabase_auth_admin and tripped RLS / role visibility.
-- Fix: make it SECURITY DEFINER (runs as function owner, bypasses RLS for its
-- internal read), pin search_path, lock EXECUTE to supabase_auth_admin only.
-- This is the Supabase-recommended pattern for custom access token hooks.
-- Re-runnable.
-- ============================================================

create or replace function plz_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb;
  prof   profiles%rowtype;
begin
  select * into prof from profiles where id = (event->>'user_id')::uuid;
  claims := event->'claims';

  if prof.id is not null and prof.active then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(prof.app_role));
    if prof.project_id is not null then
      claims := jsonb_set(claims, '{project_id}', to_jsonb(prof.project_id::text));
    end if;
    claims := jsonb_set(claims, '{perms}', coalesce(prof.perms, '{}'::jsonb));
  else
    claims := jsonb_set(claims, '{user_role}', '"none"'::jsonb);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Lock down who can run the hook: only the auth admin role GoTrue uses.
revoke execute on function plz_access_token_hook(jsonb) from public;
revoke execute on function plz_access_token_hook(jsonb) from anon, authenticated;
grant  execute on function plz_access_token_hook(jsonb) to supabase_auth_admin;

-- Keep the schema/select grants (harmless; SECURITY DEFINER makes the read work regardless).
grant usage  on schema public to supabase_auth_admin;
grant select on profiles      to supabase_auth_admin;
