-- =====================================================================
-- PLAZACORE PHASE 4 — CHANGE ORDER ATTACHMENTS + CO -> SOV ROLL-IN
-- Two capabilities:
--   1. Contractors can attach a file to a change order (the executed CO PDF).
--   2. When an owner APPROVES a CO, it is rolled into the Schedule of Values
--      as a new SOV line under a NEW SOV version (AIA-correct: in-flight pay
--      apps stay frozen on their old version; the next pay app picks up the
--      CO line and the G703 total reconciles to the Revised Contract Sum).
--
-- Reconciliation note (no double count):
--   G702 line 1 (Original Contract Sum) = projects.contract_value  [UNCHANGED]
--   G702 line 2 (Net Change by COs)     = sum(approved, non-PCO CO amounts)
--   G702 line 3 (Contract Sum to Date)  = line1 + line2
--   The new SOV version's G703 grand total = base SOV + CO lines = line3.
--   We DO NOT bump projects.contract_value on approval, so the CO appears
--   exactly once on each side of the reconciliation.
--
-- Idempotent. Transactional.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. change_orders: attachment + roll-in tracking columns
-- ---------------------------------------------------------------------
alter table change_orders add column if not exists file_path text;
alter table change_orders add column if not exists file_name text;
alter table change_orders add column if not exists file_size bigint;
alter table change_orders add column if not exists applied_to_sov boolean default false;
alter table change_orders add column if not exists sov_version_applied int;

-- ---------------------------------------------------------------------
-- 2. sov_items: provenance so CO-derived lines are identifiable
-- ---------------------------------------------------------------------
alter table sov_items add column if not exists source text default 'base';
alter table sov_items add column if not exists co_id uuid references change_orders(id) on delete set null;

-- ---------------------------------------------------------------------
-- 3. Storage bucket for CO attachments (private)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('change-orders', 'change-orders', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 4. Storage RLS — re-create the plz_* object policies INCLUDING the new
--    'change-orders' bucket. Mirrors phase2/migration-storage.sql exactly,
--    adding 'change-orders' to each bucket list. Owner: full. Contractor:
--    read + insert within their project CODE folder. (Files are pathed by
--    project code, e.g. "26011/co/...", matching plz_project_code().)
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'plz_%'
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;

create policy plz_storage_owner_all on storage.objects for all
  using (plz_is_owner()
         and bucket_id in ('field-reports','plans-specs','submittals',
                           'sov-imports','project-photos','lien-waivers','change-orders'))
  with check (plz_is_owner()
         and bucket_id in ('field-reports','plans-specs','submittals',
                           'sov-imports','project-photos','lien-waivers','change-orders'));

create policy plz_storage_contractor_read on storage.objects for select
  using (
    plz_role() = 'contractor'
    and bucket_id in ('field-reports','plans-specs','submittals','project-photos','lien-waivers','change-orders')
    and (storage.foldername(name))[1] = plz_project_code()
  );

create policy plz_storage_contractor_insert on storage.objects for insert
  with check (
    plz_role() = 'contractor'
    and bucket_id in ('submittals','project-photos','lien-waivers','change-orders')
    and (storage.foldername(name))[1] = plz_project_code()
  );

commit;

-- ROLLBACK (manual):
--   delete from storage.buckets where id='change-orders';
--   alter table change_orders drop column if exists file_path, drop column if exists file_name,
--     drop column if exists file_size, drop column if exists applied_to_sov, drop column if exists sov_version_applied;
--   alter table sov_items drop column if exists source, drop column if exists co_id;
--   (then re-run phase2/migration-storage.sql to restore the original bucket lists)
