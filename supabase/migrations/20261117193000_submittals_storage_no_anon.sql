-- Close the public submittals bucket hole (William, 2026-11-17).
-- Three early policies granted every caller, including unauthenticated anon-key
-- requests, read / upload / delete on the whole `submittals` bucket. The role
-- policies (plz_storage_owner_all, *_staff_*, *_member_read, *_contractor_*)
-- already cover every legitimate path, so the anon ones are dropped.
DROP POLICY IF EXISTS "anon read submittals storage"   ON storage.objects;
DROP POLICY IF EXISTS "anon upload submittals"         ON storage.objects;
DROP POLICY IF EXISTS "anon delete submittals storage" ON storage.objects;

-- Removing an attachment ("Remove" in a submittal) previously relied on the anon
-- delete grant for non-owners. Keep that working, scoped to the caller's project:
-- staff by membership, contractors by their project code.
DROP POLICY IF EXISTS plz_storage_submittals_delete ON storage.objects;
CREATE POLICY plz_storage_submittals_delete ON storage.objects
  FOR DELETE USING (
    bucket_id = 'submittals' AND (
      (plz_role() = 'staff' AND plz_has_storage_prefix((storage.foldername(name))[1]))
      OR (plz_role() = 'contractor' AND (storage.foldername(name))[1] = plz_project_code())
    )
  );
