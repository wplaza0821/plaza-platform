-- ============================================================
-- Plazacore Phase 3 — Native Supabase Auth + Profiles + Notifications
-- INVITE-ONLY. Native auth JWT carries app claims via Access Token Hook,
-- so existing Phase 2 RLS (plz_role/plz_project/plz_perm/plz_is_owner) keeps working.
-- Re-runnable (drops policies/triggers first).
-- ============================================================

-- ---------- 1. PROFILES ----------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique not null,
  full_name   text,
  phone       text,                              -- E.164 for SMS, e.g. +13055551234
  company     text,
  avatar_url  text,
  -- app authorization (mirrors the custom-JWT model)
  app_role    text not null default 'member'     -- owner | staff | member | contractor
              check (app_role in ('owner','staff','member','contractor')),
  project_id  uuid references projects(id) on delete set null,  -- null = all projects (staff/owner)
  perms       jsonb not null default '{}'::jsonb,
  active       boolean not null default true,
  -- invite metadata
  invited_by  uuid references auth.users(id) on delete set null,
  invited_at  timestamptz default now(),
  accepted_at timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists profiles_role_idx    on profiles(app_role);
create index if not exists profiles_project_idx on profiles(project_id);

-- auto-create a profile row when an auth user is created (invite or signup).
-- Pulls metadata the inviter set in raw_user_meta_data.
create or replace function plz_handle_new_user() returns trigger as $$
begin
  insert into profiles (id, email, full_name, phone, company, app_role, project_id, perms)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'phone',''),
    nullif(new.raw_user_meta_data->>'company',''),
    coalesce(new.raw_user_meta_data->>'app_role','member'),
    (nullif(new.raw_user_meta_data->>'project_id',''))::uuid,
    coalesce((new.raw_user_meta_data->>'perms')::jsonb, '{}'::jsonb)
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_new_user on auth.users;
create trigger trg_new_user after insert on auth.users
  for each row execute function plz_handle_new_user();

-- updated_at touch
create or replace function plz_touch_profile() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
drop trigger if exists trg_touch_profile on profiles;
create trigger trg_touch_profile before update on profiles
  for each row execute function plz_touch_profile();

-- ---------- 2. ACCESS TOKEN HOOK ----------
-- Injects app claims into the NATIVE Supabase JWT at mint time, so the same
-- plz_* helpers (which read auth.jwt() ->> 'user_role' etc.) keep working.
-- Enable in Dashboard: Authentication > Hooks > Custom Access Token = plz_access_token_hook
create or replace function plz_access_token_hook(event jsonb)
returns jsonb language plpgsql stable as $$
declare
  claims    jsonb;
  prof      profiles%rowtype;
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
    -- inactive / unknown -> minimal, no app powers
    claims := jsonb_set(claims, '{user_role}', '"none"'::jsonb);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- the hook runs as supabase_auth_admin; let it read profiles
grant usage on schema public to supabase_auth_admin;
grant select on profiles to supabase_auth_admin;
grant execute on function plz_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------- 3. PROFILES RLS ----------
alter table profiles enable row level security;
drop policy if exists profiles_self_read     on profiles;
drop policy if exists profiles_self_update    on profiles;
drop policy if exists profiles_owner_all       on profiles;
drop policy if exists profiles_staff_read       on profiles;

-- everyone can read their own profile
create policy profiles_self_read on profiles for select
  using (id = auth.uid());
-- users can update their own non-privileged fields (role/project/perms guarded below)
create policy profiles_self_update on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());
-- owner: full control (invite, set roles, deactivate)
create policy profiles_owner_all on profiles for all
  using (plz_is_owner()) with check (plz_is_owner());
-- staff: read all profiles (for assignee pickers)
create policy profiles_staff_read on profiles for select
  using (plz_role() = 'staff');

-- Guard: non-owners must NOT escalate their own role/project/perms.
create or replace function plz_guard_profile() returns trigger as $$
begin
  if plz_is_owner() then return new; end if;
  if new.app_role is distinct from old.app_role
     or new.project_id is distinct from old.project_id
     or new.perms is distinct from old.perms
     or new.active is distinct from old.active then
    raise exception 'not authorized to change role/project/perms/active';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
drop trigger if exists trg_guard_profile on profiles;
create trigger trg_guard_profile before update on profiles
  for each row execute function plz_guard_profile();

-- ---------- 4. NOTIFICATIONS ----------
create table if not exists notifications (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade,  -- recipient (in-app)
  project_id  uuid references projects(id) on delete cascade,
  kind        text not null default 'task',     -- task | rfi | submittal | system ...
  title       text not null,
  body        text,
  link        text,                              -- e.g. #tasks or task id
  ref_table   text,                              -- 'tasks'
  ref_id      uuid,                              -- task id
  read_at     timestamptz,
  -- delivery tracking for fan-out
  email_to    text,
  sms_to      text,
  email_status text default 'pending',           -- pending | sent | failed | skipped
  sms_status   text default 'pending',
  created_at  timestamptz default now()
);
create index if not exists notif_user_idx    on notifications(user_id, read_at);
create index if not exists notif_project_idx on notifications(project_id);

alter table notifications enable row level security;
drop policy if exists notif_self_read   on notifications;
drop policy if exists notif_self_update  on notifications;
drop policy if exists notif_owner_all     on notifications;

-- recipients read their own; owner reads all
create policy notif_self_read on notifications for select
  using (user_id = auth.uid() or plz_is_owner());
-- recipients can mark their own read
create policy notif_self_update on notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- owner full
create policy notif_owner_all on notifications for all
  using (plz_is_owner()) with check (plz_is_owner());
-- NOTE: inserts come from the SECURITY-DEFINER task trigger / edge fn, not clients.
