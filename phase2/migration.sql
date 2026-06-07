-- =====================================================================
-- PLAZACORE PHASE 2 — RLS HARDENING (THE CUTOVER)
-- Run ONLY after the auth-token edge function AND the frontend patch are
-- deployed and verified. Run inside the Supabase SQL editor.
--
-- Model:
--   auth.jwt() ->> 'user_role'      = 'owner' | 'contractor'
--   auth.jwt() ->> 'project_id'     = contractor's project uuid
--   auth.jwt() -> 'perms'           = contractor permission flags (jsonb)
--
-- Owner: full access to everything.
-- Contractor: access ONLY to their own project_id rows, gated by perms.
-- No JWT (anon): NO access.
--
-- This script is transactional. If anything errors, nothing is applied.
-- =====================================================================

begin;

-- ---------- helper claims ----------
create or replace function plz_role() returns text
  language sql stable as $$ select auth.jwt() ->> 'user_role' $$;

create or replace function plz_project() returns uuid
  language sql stable as $$ select nullif(auth.jwt() ->> 'project_id','')::uuid $$;

create or replace function plz_is_owner() returns boolean
  language sql stable as $$ select coalesce(auth.jwt() ->> 'user_role','') = 'owner' $$;

create or replace function plz_perm(flag text) returns boolean
  language sql stable as $$
    select plz_is_owner()
        or coalesce((auth.jwt() -> 'perms' ->> flag)::boolean, false)
  $$;

-- ---------- drop ALL existing permissive policies ----------
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'projects','contractors','sov_items','pay_apps','pay_app_lines',
        'lien_waivers','rfis','submittals','change_orders','documents',
        'tasks','photos','field_reports','deficiencies','daily_reports','milestones')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ---------- PROJECTS ----------
-- Owner: all. Contractor: read only their own project.
create policy projects_owner_all on projects for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy projects_contractor_read on projects for select
  using (plz_role() = 'contractor' and id = plz_project());

-- ---------- CONTRACTORS (sensitive: tokens live here) ----------
-- Owner only. Contractors must NOT be able to read other tokens.
create policy contractors_owner_all on contractors for all
  using (plz_is_owner()) with check (plz_is_owner());

-- ---------- SOV (owner-only writes; contractor read of own project) ----------
create policy sov_owner_all on sov_items for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy sov_contractor_read on sov_items for select
  using (plz_role() = 'contractor' and project_id = plz_project());

-- ---------- CHANGE ORDERS (owner-only writes; contractor read own) ----------
create policy co_owner_all on change_orders for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy co_contractor_read on change_orders for select
  using (plz_role() = 'contractor' and project_id = plz_project());

-- ---------- DOCUMENTS / PLANS (perm: plans) ----------
create policy docs_owner_all on documents for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy docs_contractor_read on documents for select
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('plans'));

-- ---------- RFIs (perm: rfis) ----------
create policy rfis_owner_all on rfis for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy rfis_contractor_read on rfis for select
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('rfis'));
create policy rfis_contractor_write on rfis for insert
  with check (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('rfis'));
create policy rfis_contractor_update on rfis for update
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('rfis'));

-- ---------- SUBMITTALS (perm: submittals) ----------
create policy sub_owner_all on submittals for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy sub_contractor_read on submittals for select
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('submittals'));
create policy sub_contractor_write on submittals for insert
  with check (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('submittals'));
create policy sub_contractor_update on submittals for update
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('submittals'));

-- ---------- PAY APPS (perm: payapps) ----------
create policy pa_owner_all on pay_apps for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy pa_contractor_read on pay_apps for select
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('payapps'));
create policy pa_contractor_write on pay_apps for insert
  with check (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('payapps'));
-- Contractor may update ONLY their own draft/submitted pay apps (not approve them).
create policy pa_contractor_update on pay_apps for update
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('payapps')
         and status in ('draft','submitted'))
  with check (status in ('draft','submitted'));

-- ---------- PAY APP LINES (scoped via parent pay_app) ----------
create policy pal_owner_all on pay_app_lines for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy pal_contractor_rw on pay_app_lines for all
  using (plz_role() = 'contractor' and exists (
            select 1 from pay_apps p
            where p.id = pay_app_lines.pay_app_id and p.project_id = plz_project()))
  with check (plz_role() = 'contractor' and exists (
            select 1 from pay_apps p
            where p.id = pay_app_lines.pay_app_id and p.project_id = plz_project()));

-- ---------- LIEN WAIVERS (scoped via parent pay_app) ----------
create policy lw_owner_all on lien_waivers for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy lw_contractor_read on lien_waivers for select
  using (plz_role() = 'contractor' and exists (
            select 1 from pay_apps p
            where p.id = lien_waivers.pay_app_id and p.project_id = plz_project()));
create policy lw_contractor_write on lien_waivers for insert
  with check (plz_role() = 'contractor' and exists (
            select 1 from pay_apps p
            where p.id = lien_waivers.pay_app_id and p.project_id = plz_project()));

-- ---------- TASKS (owner full; contractor read/update own project) ----------
create policy tasks_owner_all on tasks for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy tasks_contractor_read on tasks for select
  using (plz_role() = 'contractor' and project_id = plz_project());
create policy tasks_contractor_update on tasks for update
  using (plz_role() = 'contractor' and project_id = plz_project());

-- ---------- FIELD OPS: photos / field_reports / deficiencies / daily / milestones ----------
-- Owner full; contractor read+insert on own project (these are open to all
-- contractor roles per defaultContractorModules in the UI).
create policy photos_owner_all on photos for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy photos_contractor_rw on photos for all
  using (plz_role() = 'contractor' and project_id = plz_project())
  with check (plz_role() = 'contractor' and project_id = plz_project());

create policy fr_owner_all on field_reports for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy fr_contractor_read on field_reports for select
  using (plz_role() = 'contractor' and project_id = plz_project());

create policy def_owner_all on deficiencies for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy def_contractor_rw on deficiencies for all
  using (plz_role() = 'contractor' and project_id = plz_project())
  with check (plz_role() = 'contractor' and project_id = plz_project());

create policy daily_owner_all on daily_reports for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy daily_contractor_rw on daily_reports for all
  using (plz_role() = 'contractor' and project_id = plz_project())
  with check (plz_role() = 'contractor' and project_id = plz_project());

create policy ms_owner_all on milestones for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy ms_contractor_read on milestones for select
  using (plz_role() = 'contractor' and project_id = plz_project());

commit;

-- =====================================================================
-- POST-CUTOVER: storage buckets are still private; ensure storage RLS
-- policies also scope by project path prefix. See TEST-PLAN.md step 7.
-- =====================================================================
