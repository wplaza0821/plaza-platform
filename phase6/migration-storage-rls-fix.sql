-- Fix storage RLS: contractor INSERT/SELECT was broken (NULL WITH CHECK, and wrong path comparison)
-- All storage paths use project UUID as folder, not project code

DROP POLICY IF EXISTS plz_storage_contractor_insert ON storage.objects;
CREATE POLICY plz_storage_contractor_insert ON storage.objects
  FOR INSERT TO public
  WITH CHECK (
    plz_role() = 'contractor'
    AND bucket_id = ANY (ARRAY['plans-specs','submittals','lien-waivers','change-orders','project-photos'])
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'project_id')
  );

DROP POLICY IF EXISTS plz_storage_contractor_read ON storage.objects;
CREATE POLICY plz_storage_contractor_read ON storage.objects
  FOR SELECT TO public
  USING (
    plz_role() = 'contractor'
    AND bucket_id = ANY (ARRAY['field-reports','plans-specs','submittals','project-photos','lien-waivers','change-orders'])
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'project_id')
  );

DROP POLICY IF EXISTS plz_storage_member_write ON storage.objects;
CREATE POLICY plz_storage_member_write ON storage.objects
  FOR INSERT TO public
  WITH CHECK (
    plz_role() = 'member'
    AND bucket_id = ANY (ARRAY['plans-specs','submittals','lien-waivers','change-orders','project-photos','field-reports'])
    AND plz_has_storage_prefix((storage.foldername(name))[1])
  );

DROP POLICY IF EXISTS plz_storage_staff_write ON storage.objects;
CREATE POLICY plz_storage_staff_write ON storage.objects
  FOR INSERT TO public
  WITH CHECK (
    plz_role() = 'staff'
    AND bucket_id = ANY (ARRAY['plans-specs','submittals','lien-waivers','change-orders','project-photos','field-reports','sov-imports'])
    AND plz_has_storage_prefix((storage.foldername(name))[1])
  );
