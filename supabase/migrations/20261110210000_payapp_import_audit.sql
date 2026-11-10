-- Pay application import audit trail (William, 2026-11-10: "make this audit proof")
--
-- Every analysis, apply, audit review, submission, reopen and deletion of a pay
-- application is written here as an immutable record: who, when, the SHA-256 of
-- the exact file that was read, every cross-check finding, and the written reason
-- for every exception that was accepted.
--
-- Append-only by construction:
--   * no UPDATE / DELETE / TRUNCATE for ANY role, service role included (trigger);
--   * created_at and the actor identity are stamped by the database from the JWT,
--     so a client can neither backdate a row nor sign it as someone else;
--   * NO foreign key to pay_apps / pay_app_documents, so deleting a pay app (owner
--     may delete in any status) can never cascade the evidence away.

create table if not exists pay_app_import_audits (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  project_id      uuid not null,
  pay_app_id      uuid not null,
  pay_app_number  int,
  doc_id          uuid,
  event           text not null check (event in
                    ('analyzed','applied','audit_reviewed','submitted','reopened','deleted')),
  actor_name      text,
  actor_email     text,
  actor_role      text,
  file_name       text,
  file_path       text,
  file_sha256     text,
  summary         jsonb not null default '{}'::jsonb,
  findings        jsonb not null default '[]'::jsonb,
  acknowledgments jsonb not null default '[]'::jsonb,
  note            text
);

create index if not exists pay_app_import_audits_pa_idx
  on pay_app_import_audits (pay_app_id, created_at);
create index if not exists pay_app_import_audits_project_idx
  on pay_app_import_audits (project_id, created_at);

comment on table pay_app_import_audits is
  'Immutable audit trail of pay-application imports and cross-checks. Append-only: UPDATE/DELETE/TRUNCATE are rejected for every role. No FK to pay_apps so the record survives pay-app deletion.';

-- 1. Immutability -------------------------------------------------------------
create or replace function plz_pa_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'pay_app_import_audits is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_pa_audit_no_update on pay_app_import_audits;
create trigger trg_pa_audit_no_update
  before update or delete on pay_app_import_audits
  for each row execute function plz_pa_audit_immutable();

drop trigger if exists trg_pa_audit_no_truncate on pay_app_import_audits;
create trigger trg_pa_audit_no_truncate
  before truncate on pay_app_import_audits
  for each statement execute function plz_pa_audit_immutable();

-- 2. Server-stamped time + identity ------------------------------------------
-- Client rows: identity comes from the JWT, never from the payload. Service-role
-- rows (the analyze-payapp edge function) carry the identity the function
-- resolved from the caller's token, so they are trusted as written.
create or replace function plz_pa_audit_stamp() returns trigger
language plpgsql as $$
declare
  claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
begin
  new.created_at := now();
  if coalesce(claims ->> 'role', '') <> 'service_role' then
    new.actor_role  := coalesce(claims ->> 'user_role', new.actor_role);
    new.actor_email := claims ->> 'email';
    if new.event = 'analyzed' then
      raise exception 'analyzed records are written by the analyzer only' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pa_audit_stamp on pay_app_import_audits;
create trigger trg_pa_audit_stamp
  before insert on pay_app_import_audits
  for each row execute function plz_pa_audit_stamp();

-- 3. RLS ----------------------------------------------------------------------
alter table pay_app_import_audits enable row level security;

drop policy if exists paa_owner_read   on pay_app_import_audits;
drop policy if exists paa_owner_insert on pay_app_import_audits;
drop policy if exists paa_project_read on pay_app_import_audits;
drop policy if exists paa_project_insert on pay_app_import_audits;

create policy paa_owner_read on pay_app_import_audits
  for select using (plz_is_owner());

create policy paa_owner_insert on pay_app_import_audits
  for insert with check (plz_is_owner());

-- Staff, members and contractors see the trail for their own project.
create policy paa_project_read on pay_app_import_audits
  for select using (
    plz_role() in ('staff','member','contractor')
    and project_id = plz_project()
  );

-- Staff and contractors who can apply/submit an import must leave a record of it.
-- The pay app must really belong to the caller's project.
create policy paa_project_insert on pay_app_import_audits
  for insert with check (
    plz_role() in ('staff','contractor')
    and project_id = plz_project()
    and event in ('applied','audit_reviewed','submitted')
    and exists (select 1 from pay_apps p
                 where p.id = pay_app_import_audits.pay_app_id
                   and p.project_id = plz_project())
  );

grant select, insert on pay_app_import_audits to authenticated;
revoke update, delete, truncate on pay_app_import_audits from authenticated, anon;
