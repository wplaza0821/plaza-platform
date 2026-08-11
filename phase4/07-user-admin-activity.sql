-- =====================================================================
-- PLAZACORE PHASE 4-07 — USER ADMIN: STATUS, LAST-LOGIN, ACTIVITY LOG
-- Adds:
--   1. user_activity  — append-only audit log (who did what, when).
--   2. plz_users()    — owner-only RPC joining profiles + auth.users
--                       last_sign_in_at / confirmation state (the SPA
--                       cannot read auth.users directly).
--   3. plz_user_activity(uuid) — owner-only RPC returning a user's recent
--                       activity feed.
--   4. plz_log_activity(...)   — SECURITY DEFINER helper so the frontend /
--                       edge fns can append rows without direct table grants.
-- Re-runnable. security invoker on read RPCs (owner-gated inside).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Activity log table
-- ---------------------------------------------------------------------
create table if not exists user_activity (
  id          uuid primary key default uuid_generate_v4(),
  actor_id    uuid,                 -- profiles.id / auth.users.id of who acted (nullable: system)
  actor_email text,                 -- denormalized for display even if profile later deleted
  subject_id  uuid,                 -- the user this activity is ABOUT (for the per-user feed)
  action      text not null,        -- 'login' | 'invite_sent' | 'invite_resent' | 'invite_cancelled'
                                     -- | 'deactivated' | 'reactivated' | 'role_changed' | 'rfi_created' | ...
  ref_table   text,                 -- optional: entity touched
  ref_id      uuid,
  project_id  uuid,
  detail      jsonb,                -- freeform: {from, to, email, ...}
  created_at  timestamptz default now()
);
create index if not exists user_activity_subject_idx on user_activity(subject_id, created_at desc);
create index if not exists user_activity_actor_idx   on user_activity(actor_id, created_at desc);
create index if not exists user_activity_created_idx on user_activity(created_at desc);

alter table user_activity enable row level security;
drop policy if exists user_activity_owner_all  on user_activity;
drop policy if exists user_activity_self_read   on user_activity;
-- Owner sees everything.
create policy user_activity_owner_all on user_activity for all
  using (plz_is_owner()) with check (plz_is_owner());
-- A user may read activity about themselves (subject) or by themselves (actor).
create policy user_activity_self_read on user_activity for select
  using (subject_id = auth.uid() or actor_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. SECURITY DEFINER logger — append-only, callable by authenticated users.
--    Runs as owner of the function so it can insert regardless of caller RLS,
--    but it stamps the actor from auth.uid() server-side (can't be spoofed).
-- ---------------------------------------------------------------------
create or replace function plz_log_activity(
  p_action     text,
  p_subject_id uuid    default null,
  p_ref_table  text    default null,
  p_ref_id     uuid    default null,
  p_project_id uuid    default null,
  p_detail     jsonb   default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_email   text;
  v_id      uuid;
begin
  select email into v_email from public.profiles where id = v_actor;
  insert into public.user_activity(actor_id, actor_email, subject_id, action, ref_table, ref_id, project_id, detail)
  values (v_actor, v_email, coalesce(p_subject_id, v_actor), p_action, p_ref_table, p_ref_id, p_project_id, coalesce(p_detail,'{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function plz_log_activity(text,uuid,text,uuid,uuid,jsonb) from public;
grant execute on function plz_log_activity(text,uuid,text,uuid,uuid,jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 3. plz_users() — owner-only directory with auth state + last login.
--    SECURITY DEFINER so it can read auth.users; gated to owner inside.
-- ---------------------------------------------------------------------
create or replace function plz_users()
returns table (
  id              uuid,
  email           text,
  full_name       text,
  app_role        text,
  project_id      uuid,
  phone           text,
  company         text,
  perms           jsonb,
  active          boolean,
  invited_by      uuid,
  invited_at      timestamptz,
  accepted_at     timestamptz,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz,
  invite_pending  boolean,
  activity_count  bigint,
  last_activity_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not plz_is_owner() then
    raise exception 'forbidden: owner only';
  end if;
  return query
    select
      p.id, p.email, p.full_name, p.app_role, p.project_id, p.phone, p.company,
      p.perms, p.active, p.invited_by, p.invited_at, p.accepted_at, p.created_at,
      u.last_sign_in_at,
      u.email_confirmed_at,
      (u.last_sign_in_at is null) as invite_pending,
      (select count(*) from user_activity a where a.subject_id = p.id) as activity_count,
      (select max(a.created_at) from user_activity a where a.actor_id = p.id) as last_activity_at
    from profiles p
    left join auth.users u on u.id = p.id
    order by p.created_at desc;
end;
$$;
revoke all on function plz_users() from public;
grant execute on function plz_users() to authenticated;

-- ---------------------------------------------------------------------
-- 4. plz_user_activity(uuid, int) — owner-only per-user activity feed.
-- ---------------------------------------------------------------------
create or replace function plz_user_activity(p_user uuid, p_limit int default 50)
returns table (
  id uuid, actor_id uuid, actor_email text, subject_id uuid,
  action text, ref_table text, ref_id uuid, project_id uuid,
  detail jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not plz_is_owner() then
    raise exception 'forbidden: owner only';
  end if;
  return query
    select a.id, a.actor_id, a.actor_email, a.subject_id, a.action,
           a.ref_table, a.ref_id, a.project_id, a.detail, a.created_at
      from user_activity a
     where a.actor_id = p_user or a.subject_id = p_user
     order by a.created_at desc
     limit greatest(1, least(p_limit, 500));
end;
$$;
revoke all on function plz_user_activity(uuid,int) from public;
grant execute on function plz_user_activity(uuid,int) to authenticated;

commit;

-- Frontend:
--   const { data: users } = await sb.rpc('plz_users');
--   const { data: feed }  = await sb.rpc('plz_user_activity', { p_user: id, p_limit: 50 });
--   await sb.rpc('plz_log_activity', { p_action:'rfi_created', p_ref_table:'rfis', p_ref_id:newId, p_project_id:pid });
-- Status changes (resend/cancel/deactivate/reactivate/role_change) go through
-- the manage-user edge function (service role) which also writes user_activity.
