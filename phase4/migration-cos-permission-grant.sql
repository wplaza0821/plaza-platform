-- PLAZACORE — grant 'cos' (Change Orders) permission to contractors
-- The Change Orders module was added but contractors had no 'cos' flag, so the
-- CO tab + "New Change Order" button were hidden for them. This:
--   1. Adds cos:true to the contractors table column DEFAULT (future invites).
--   2. Backfills cos:true onto existing active contractors' permissions.
--   3. Backfills cos:true onto existing contractor profiles' perms (auth path).
-- Idempotent. Transactional.

begin;

-- 1. New default for the contractors table
alter table contractors
  alter column permissions
  set default '{"rfis":true,"submittals":true,"payapps":true,"cos":true,"plans":true}'::jsonb;

-- 2. Backfill existing contractor rows (only add the key if missing/false)
update contractors
  set permissions = coalesce(permissions, '{}'::jsonb) || '{"cos":true}'::jsonb
  where coalesce((permissions ->> 'cos')::boolean, false) = false;

-- 3. Backfill native auth profiles for contractor users (perms drives UI gating)
--    profiles.perms is the JWT-claim source for native logins.
update profiles
  set perms = coalesce(perms, '{}'::jsonb) || '{"cos":true}'::jsonb
  where app_role = 'contractor'
    and coalesce((perms ->> 'cos')::boolean, false) = false;

commit;
