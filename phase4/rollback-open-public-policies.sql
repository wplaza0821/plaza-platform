-- ROLLBACK: recreate the 36 wide-open PERMISSIVE {public} policies dropped 2026-09-08
-- Generated from live pg_policies. Run only to restore prior (insecure) state.
BEGIN;
CREATE POLICY "anon insert change_orders" ON public."change_orders" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read change_orders" ON public."change_orders" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update change_orders" ON public."change_orders" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon insert contractors" ON public."contractors" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read contractors" ON public."contractors" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update contractors" ON public."contractors" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon delete deficiency_followups" ON public."deficiency_followups" AS PERMISSIVE FOR DELETE TO public
  USING (true);
CREATE POLICY "anon insert deficiency_followups" ON public."deficiency_followups" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read deficiency_followups" ON public."deficiency_followups" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update deficiency_followups" ON public."deficiency_followups" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon insert documents" ON public."documents" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read documents" ON public."documents" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon insert lien_waivers" ON public."lien_waivers" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read lien_waivers" ON public."lien_waivers" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon insert pay_app_lines" ON public."pay_app_lines" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read pay_app_lines" ON public."pay_app_lines" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update pay_app_lines" ON public."pay_app_lines" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon insert pay_apps" ON public."pay_apps" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read pay_apps" ON public."pay_apps" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update pay_apps" ON public."pay_apps" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon insert projects" ON public."projects" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read projects" ON public."projects" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update projects" ON public."projects" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon insert rfis" ON public."rfis" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read rfis" ON public."rfis" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update rfis" ON public."rfis" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon delete sov" ON public."sov_items" AS PERMISSIVE FOR DELETE TO public
  USING (true);
CREATE POLICY "anon insert sov" ON public."sov_items" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read sov" ON public."sov_items" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update sov" ON public."sov_items" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
CREATE POLICY "anon delete submittal_files" ON public."submittal_files" AS PERMISSIVE FOR DELETE TO public
  USING (true);
CREATE POLICY "anon insert submittal_files" ON public."submittal_files" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read submittal_files" ON public."submittal_files" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon insert submittals" ON public."submittals" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon read submittals" ON public."submittals" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon update submittals" ON public."submittals" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
COMMIT;

-- ---- Appended 2026-09-08: rollback for -03-contractors ----
-- Only run alongside reverting index.html to the anon-lookup version.
DROP POLICY IF EXISTS "contractors_participant_read" ON public.contractors;
CREATE POLICY "anon read contractors" ON public."contractors" AS PERMISSIVE FOR SELECT TO public
  USING (true);
CREATE POLICY "anon insert contractors" ON public."contractors" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "anon update contractors" ON public."contractors" AS PERMISSIVE FOR UPDATE TO public
  USING (true);
