-- Fix v2: storage.foldername returns project code strings (e.g. '26011'), 
-- not UUIDs. We need to join through the projects table to match.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper function: given a path prefix string, check if auth.uid() is a member
-- of the project whose code matches that prefix.
CREATE OR REPLACE FUNCTION public.plz_has_storage_prefix(prefix text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select plz_is_owner()
      or exists (
        select 1
          from project_members pm
          join projects p on p.id = pm.project_id
         where pm.user_id = auth.uid()
           and (p.id::text = prefix OR p.code = prefix)
      )
$$;

-- Drop and recreate member + staff storage READ policies using new helper
DROP POLICY IF EXISTS plz_storage_member_read ON storage.objects;
DROP POLICY IF EXISTS plz_storage_staff_read  ON storage.objects;

CREATE POLICY plz_storage_member_read ON storage.objects
  FOR SELECT TO public
  USING (
    plz_role() = 'member'
    AND bucket_id = ANY(ARRAY[
      'field-reports','plans-specs','submittals',
      'project-photos','lien-waivers','change-orders'
    ])
    AND plz_has_storage_prefix((storage.foldername(name))[1])
  );

CREATE POLICY plz_storage_staff_read ON storage.objects
  FOR SELECT TO public
  USING (
    plz_role() = 'staff'
    AND bucket_id = ANY(ARRAY[
      'field-reports','plans-specs','submittals',
      'project-photos','lien-waivers','change-orders'
    ])
    AND plz_has_storage_prefix((storage.foldername(name))[1])
  );

-- Fix write policies similarly
DROP POLICY IF EXISTS plz_storage_member_write ON storage.objects;
DROP POLICY IF EXISTS plz_storage_staff_write  ON storage.objects;

CREATE POLICY plz_storage_member_write ON storage.objects
  FOR INSERT TO public
  WITH CHECK (
    plz_role() = 'member'
    AND bucket_id = ANY(ARRAY['field-reports','plans-specs','submittals','project-photos'])
    AND plz_has_storage_prefix((storage.foldername(name))[1])
  );

CREATE POLICY plz_storage_staff_write ON storage.objects
  FOR INSERT TO public
  WITH CHECK (
    plz_role() = 'staff'
    AND bucket_id = ANY(ARRAY['field-reports','plans-specs','submittals','project-photos'])
    AND plz_has_storage_prefix((storage.foldername(name))[1])
  );
