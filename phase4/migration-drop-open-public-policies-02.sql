-- Plazacore RLS cleanup 2026-09-08 — PHASE 2
-- Adds role-scoped replacements for deficiency_followups and documents,
-- then drops their wide-open PUBLIC policies. Patterns copied from the
-- existing phase4 policies on `deficiencies` and `documents`.
BEGIN;

-- deficiency_followups: mirror of the `deficiencies` policy set
CREATE POLICY "dfu_owner_all" ON public.deficiency_followups AS PERMISSIVE FOR ALL TO public
  USING (plz_is_owner()) WITH CHECK (plz_is_owner());
CREATE POLICY "dfu_contractor_rw" ON public.deficiency_followups AS PERMISSIVE FOR ALL TO public
  USING ((plz_role() = 'contractor'::text) AND plz_has_project(project_id))
  WITH CHECK ((plz_role() = 'contractor'::text) AND plz_has_project(project_id));
CREATE POLICY "dfu_staff_read" ON public.deficiency_followups AS PERMISSIVE FOR SELECT TO public
  USING ((plz_role() = 'staff'::text) AND plz_has_project(project_id));
CREATE POLICY "dfu_member_read" ON public.deficiency_followups AS PERMISSIVE FOR SELECT TO public
  USING ((plz_role() = 'member'::text) AND plz_has_project(project_id));
CREATE POLICY "dfu_client_read" ON public.deficiency_followups AS PERMISSIVE FOR SELECT TO public
  USING ((plz_role() = 'client'::text) AND plz_has_project(project_id));

-- documents: read policies already exist; add the write paths
CREATE POLICY "docs_staff_write" ON public.documents AS PERMISSIVE FOR ALL TO public
  USING ((plz_role() = 'staff'::text) AND plz_has_project(project_id))
  WITH CHECK ((plz_role() = 'staff'::text) AND plz_has_project(project_id));
CREATE POLICY "docs_contractor_insert" ON public.documents AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((plz_role() = 'contractor'::text) AND plz_has_project(project_id) AND plz_perm('plans'::text));

DROP POLICY IF EXISTS "anon delete deficiency_followups" ON public.deficiency_followups;
DROP POLICY IF EXISTS "anon insert deficiency_followups" ON public.deficiency_followups;
DROP POLICY IF EXISTS "anon read deficiency_followups"   ON public.deficiency_followups;
DROP POLICY IF EXISTS "anon update deficiency_followups" ON public.deficiency_followups;
DROP POLICY IF EXISTS "anon insert documents" ON public.documents;
DROP POLICY IF EXISTS "anon read documents"   ON public.documents;

COMMIT;

-- NOT DROPPED (deliberate, 2026-09-08):
--   "anon read contractors" / "anon insert contractors" / "anon update contractors"
-- tryBootAuth() (index.html) looks a contractor up by access_token using the ANON
-- key before any JWT exists. No RLS policy can express "match this one secret"
-- without also permitting a full table dump. Closing this requires moving the
-- lookup into a SECURITY DEFINER RPC (or the existing mintToken edge function)
-- and then dropping these three. Until then contractors.access_token is readable
-- with the public anon key. Tracked as the next RLS work item.
