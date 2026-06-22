-- Repair Quantities access control — "Option B" (William, 2026-06-22):
--   * Staff and members may still ADD (insert) repair entries / stacks (field data entry).
--   * Once entered, ONLY the owner (William) may EDIT, DELETE, or CHANGE STATUS (approve).
--   * Contractors remain read-only on their own stacks (unchanged).
--
-- Enforcement is at the database (RLS) level so it cannot be bypassed by the UI.
-- We replace the broad staff "FOR ALL" and the member "FOR UPDATE" policies with
-- SELECT + INSERT-only policies. Owner keeps FOR ALL (full edit/delete/approve).

-- ── repair_quantity_items ────────────────────────────────────────────────────
-- Remove the over-broad write policies.
DROP POLICY IF EXISTS rqi_staff_all     ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_member_update ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_member_insert ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_member_read   ON public.repair_quantity_items;

-- Staff: read + insert only (NO update / delete / status change).
CREATE POLICY rqi_staff_read ON public.repair_quantity_items
  FOR SELECT TO public
  USING (plz_role() = 'staff' AND plz_has_project(project_id));
CREATE POLICY rqi_staff_insert ON public.repair_quantity_items
  FOR INSERT TO public
  WITH CHECK (plz_role() = 'staff' AND plz_has_project(project_id));

-- Member: read + insert only (NO update / delete / status change).
CREATE POLICY rqi_member_read ON public.repair_quantity_items
  FOR SELECT TO public
  USING (plz_role() = 'member' AND plz_has_project(project_id));
CREATE POLICY rqi_member_insert ON public.repair_quantity_items
  FOR INSERT TO public
  WITH CHECK (plz_role() = 'member' AND plz_has_project(project_id));

-- Owner policy (rqi_owner_all, FOR ALL USING plz_is_owner()) is left intact:
-- only the owner can UPDATE (edit / approve / change status) and DELETE.

-- ── repair_stacks ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rqs_staff_all   ON public.repair_stacks;
DROP POLICY IF EXISTS rqs_member_read ON public.repair_stacks;

-- Staff: read + insert only.
CREATE POLICY rqs_staff_read ON public.repair_stacks
  FOR SELECT TO public
  USING (plz_role() = 'staff' AND plz_has_project(project_id));
CREATE POLICY rqs_staff_insert ON public.repair_stacks
  FOR INSERT TO public
  WITH CHECK (plz_role() = 'staff' AND plz_has_project(project_id));

-- Member: read + insert only.
CREATE POLICY rqs_member_read ON public.repair_stacks
  FOR SELECT TO public
  USING (plz_role() = 'member' AND plz_has_project(project_id));
CREATE POLICY rqs_member_insert ON public.repair_stacks
  FOR INSERT TO public
  WITH CHECK (plz_role() = 'member' AND plz_has_project(project_id));

-- Owner policy (rqs_owner_all) left intact: only owner edits/deletes stacks.
-- Contractor read policies (rqs_contractor_read / rqi_contractor_read) left intact.
