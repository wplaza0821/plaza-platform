-- PLAZACORE FIX — contractor storage upload/read was never working in prod.
-- Symptom: contractor upload of a pay-app / CO PDF fails with
--   "new row violates row-level security policy"; contractors also can't
--   view their own uploaded files.
--
-- ACTUAL ROOT CAUSE (verified live 2026-07-20):
--   NOT the table RLS, and NOT missing JWT claims. The Access Token Hook
--   (plz_access_token_hook) is registered and injects user_role/project_id/
--   perms correctly (confirmed by simulating the hook for a contractor and by
--   the fact contractors already create tasks/COs). The real bug is a
--   STORAGE PATH MISMATCH:
--     - The app uploads to  `<projectCODE>/payapp/<payAppId>/...`  and
--       `<projectCODE>/co/...`  (path prefixed by projects.code, e.g. "26011").
--     - But the storage policies checked
--         (storage.foldername(name))[1] = auth.jwt()->>'project_id'
--       i.e. folder[1] must equal the project UUID (7326b0b7-...).
--   Code ("26011") != UUID, so INSERT (and the mirror SELECT) always failed.
--
-- FIX: check folder[1] against plz_project_code() (the project CODE) instead of
--   the raw project_id UUID. This matches what the app actually writes and
--   PRESERVES per-project isolation (no cross-project bucket access). Repairs
--   BOTH contractor upload (pay-app docs + CO docs) and contractor read.
--
-- Idempotent.

begin;

-- Contractor INSERT into the shared project buckets, scoped to the caller's
-- own project folder by CODE (what the app actually uploads under).
drop policy if exists plz_storage_contractor_insert on storage.objects;
create policy plz_storage_contractor_insert on storage.objects for insert
  with check (
    plz_role() = 'contractor'
    and bucket_id = any (array[
      'plans-specs','submittals','lien-waivers','change-orders','project-photos'
    ])
    and (storage.foldername(name))[1] = plz_project_code()
  );

-- Mirror SELECT so contractors can view/download what they uploaded.
drop policy if exists plz_storage_contractor_read on storage.objects;
create policy plz_storage_contractor_read on storage.objects for select
  using (
    plz_role() = 'contractor'
    and bucket_id = any (array[
      'field-reports','plans-specs','submittals','project-photos','lien-waivers','change-orders'
    ])
    and (storage.foldername(name))[1] = plz_project_code()
  );

commit;

-- ============================================================
-- NOTE: The table-level pay_app_documents policies (pad_contractor_write /
-- pad_member_write) were NOT the problem and are intentionally left untouched.
-- The earlier draft of this file rewrote them + added a folder-less
-- co_bucket_contractor_insert policy (which would have allowed cross-project
-- writes into the shared change-orders bucket). That approach was rejected in
-- favor of this tighter, root-cause fix.
-- ============================================================
