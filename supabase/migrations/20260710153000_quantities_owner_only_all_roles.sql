-- HARD RULE (William, 2026-07-10): NO ONE may modify repair quantities except
-- the OWNER (William). Members were already stripped of writes in
-- 20260710150000_member_read_only.sql. This removes the remaining STAFF write
-- paths so quantity data is owner-write-only across every surface:
--   * repair_quantity_items  (the line items)
--   * repair_stacks          (the stacks)
--   * quantity_imports       (spreadsheet import + approve-to-quantities flow)
-- qty_recon_map is already owner-only (qrm_owner_all) and is left as-is.
--
-- Owner retains full write via the pre-existing rqi_owner_all / rqs_owner_all
-- FOR ALL policies. All roles keep their SELECT (read) policies. Downloads and
-- viewing are unaffected.

-- repair_quantity_items: drop staff write, keep staff read.
DROP POLICY IF EXISTS rqi_staff_insert ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_staff_update ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_staff_delete ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_staff_all    ON public.repair_quantity_items;

-- repair_stacks: drop staff write, keep staff read.
DROP POLICY IF EXISTS rqs_staff_insert ON public.repair_stacks;
DROP POLICY IF EXISTS rqs_staff_update ON public.repair_stacks;
DROP POLICY IF EXISTS rqs_staff_delete ON public.repair_stacks;
DROP POLICY IF EXISTS rqs_staff_all    ON public.repair_stacks;

-- quantity_imports: restrict insert/update to owner only (was owner/staff).
DROP POLICY IF EXISTS qi_insert ON public.quantity_imports;
CREATE POLICY qi_insert ON public.quantity_imports
  FOR INSERT WITH CHECK (
    coalesce((auth.jwt() ->> 'user_role'), '') = 'owner'
  );

DROP POLICY IF EXISTS qi_update ON public.quantity_imports;
CREATE POLICY qi_update ON public.quantity_imports
  FOR UPDATE USING (
    coalesce((auth.jwt() ->> 'user_role'), '') = 'owner'
  );
-- qi_delete is already owner-only; qi_select (read) is left intact.
