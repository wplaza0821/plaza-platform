-- =====================================================================
-- PLAZACORE PHASE 2 — STORAGE RLS (step 7)
-- Scope storage.objects so contractors can only read files under THEIR
-- project's folder. Files are pathed by project CODE (e.g. "26011/...."),
-- while the contractor JWT carries project_id (UUID) — so we map UUID->code.
--
-- Buckets affected (all private): field-reports, plans-specs, submittals,
--   sov-imports, project-photos, lien-waivers.
-- Owner: full access. Contractor: read/insert only within their project
-- code prefix. No JWT: nothing.
--
-- Run AFTER migration.sql. Transactional.
-- =====================================================================

begin;

-- Helper: the project CODE for the caller's JWT project_id (NULL for owner/none)
create or replace function plz_project_code() returns text
  language sql stable security definer set search_path = public as $$
    select p.code from public.projects p
    where p.id = nullif(auth.jwt() ->> 'project_id','')::uuid
$$;

-- The top-level folder of a storage object name == project code in our convention.
-- storage.foldername(name) returns text[]; element 1 is the first path segment.
-- We compare it to the caller's project code.

-- Drop any prior plz storage policies (id idempotent)
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

-- OWNER: full access to all plazacore buckets
create policy plz_storage_owner_all on storage.objects for all
  using (plz_is_owner()
         and bucket_id in ('field-reports','plans-specs','submittals',
                           'sov-imports','project-photos','lien-waivers'))
  with check (plz_is_owner()
         and bucket_id in ('field-reports','plans-specs','submittals',
                           'sov-imports','project-photos','lien-waivers'));

-- CONTRACTOR: read objects only within their project code folder
create policy plz_storage_contractor_read on storage.objects for select
  using (
    plz_role() = 'contractor'
    and bucket_id in ('field-reports','plans-specs','submittals','project-photos','lien-waivers')
    and (storage.foldername(name))[1] = plz_project_code()
  );

-- CONTRACTOR: insert objects only within their project code folder
-- (covers contractor-side uploads: pay app attachments, photos, deficiency photos)
create policy plz_storage_contractor_insert on storage.objects for insert
  with check (
    plz_role() = 'contractor'
    and bucket_id in ('submittals','project-photos','lien-waivers')
    and (storage.foldername(name))[1] = plz_project_code()
  );

commit;

-- NOTE: The frontend uploads some objects pathed by project UUID
-- (STATE.activeProjectId) rather than code. If/when those exist, add a second
-- contractor policy comparing (storage.foldername(name))[1] = (auth.jwt()->>'project_id').
-- Current live field-reports objects are all code-prefixed (verified 2026-06-07).
