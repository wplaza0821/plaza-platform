-- Phase 6 · AUTO-GENERATED RLS rewrite: project_id=plz_project() -> plz_has_project(project_id).
-- Membership-based multi-project scoping. Idempotent. Generated from live pg_policies.

drop policy if exists "plan_pins_contractor_rw" on public.plan_pins;
create policy "plan_pins_contractor_rw" on public.plan_pins for all to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "seals_contractor_read" on public.report_seals;
create policy "seals_contractor_read" on public.report_seals for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "projects_contractor_read" on public.projects;
create policy "projects_contractor_read" on public.projects for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(id))));

drop policy if exists "sov_contractor_read" on public.sov_items;
create policy "sov_contractor_read" on public.sov_items for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "co_contractor_read" on public.change_orders;
create policy "co_contractor_read" on public.change_orders for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "docs_contractor_read" on public.documents;
create policy "docs_contractor_read" on public.documents for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('plans'::text)));

drop policy if exists "rfis_contractor_read" on public.rfis;
create policy "rfis_contractor_read" on public.rfis for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('rfis'::text)));

drop policy if exists "rfis_contractor_write" on public.rfis;
create policy "rfis_contractor_write" on public.rfis for insert to public
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('rfis'::text)));

drop policy if exists "rfis_contractor_update" on public.rfis;
create policy "rfis_contractor_update" on public.rfis for update to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('rfis'::text)));

drop policy if exists "sub_contractor_read" on public.submittals;
create policy "sub_contractor_read" on public.submittals for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('submittals'::text)));

drop policy if exists "sub_contractor_write" on public.submittals;
create policy "sub_contractor_write" on public.submittals for insert to public
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('submittals'::text)));

drop policy if exists "sub_contractor_update" on public.submittals;
create policy "sub_contractor_update" on public.submittals for update to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('submittals'::text)));

drop policy if exists "pa_contractor_read" on public.pay_apps;
create policy "pa_contractor_read" on public.pay_apps for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('payapps'::text)));

drop policy if exists "pa_contractor_write" on public.pay_apps;
create policy "pa_contractor_write" on public.pay_apps for insert to public
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('payapps'::text)));

drop policy if exists "pa_contractor_update" on public.pay_apps;
create policy "pa_contractor_update" on public.pay_apps for update to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('payapps'::text) AND (status = ANY (ARRAY['draft'::text, 'submitted'::text]))))
  with check ((status = ANY (ARRAY['draft'::text, 'submitted'::text])));

drop policy if exists "pal_contractor_rw" on public.pay_app_lines;
create policy "pal_contractor_rw" on public.pay_app_lines for all to public
  using (((plz_role() = 'contractor'::text) AND (EXISTS ( SELECT 1 FROM pay_apps p WHERE ((p.id = pay_app_lines.pay_app_id) AND (plz_has_project(p.project_id)))))))
  with check (((plz_role() = 'contractor'::text) AND (EXISTS ( SELECT 1 FROM pay_apps p WHERE ((p.id = pay_app_lines.pay_app_id) AND (plz_has_project(p.project_id)))))));

drop policy if exists "ms_contractor_read" on public.milestones;
create policy "ms_contractor_read" on public.milestones for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "lw_contractor_read" on public.lien_waivers;
create policy "lw_contractor_read" on public.lien_waivers for select to public
  using (((plz_role() = 'contractor'::text) AND (EXISTS ( SELECT 1 FROM pay_apps p WHERE ((p.id = lien_waivers.pay_app_id) AND (plz_has_project(p.project_id)))))));

drop policy if exists "lw_contractor_write" on public.lien_waivers;
create policy "lw_contractor_write" on public.lien_waivers for insert to public
  with check (((plz_role() = 'contractor'::text) AND (EXISTS ( SELECT 1 FROM pay_apps p WHERE ((p.id = lien_waivers.pay_app_id) AND (plz_has_project(p.project_id)))))));

drop policy if exists "routing_contractor_read" on public.routing_events;
create policy "routing_contractor_read" on public.routing_events for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "photos_contractor_rw" on public.photos;
create policy "photos_contractor_rw" on public.photos for all to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "fr_contractor_read" on public.field_reports;
create policy "fr_contractor_read" on public.field_reports for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "def_contractor_rw" on public.deficiencies;
create policy "def_contractor_rw" on public.deficiencies for all to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "daily_contractor_rw" on public.daily_reports;
create policy "daily_contractor_rw" on public.daily_reports for all to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "markups_contractor_read" on public.plan_markups;
create policy "markups_contractor_read" on public.plan_markups for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('plans'::text)));

drop policy if exists "tasks_member_read" on public.tasks;
create policy "tasks_member_read" on public.tasks for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "markups_contractor_insert" on public.plan_markups;
create policy "markups_contractor_insert" on public.plan_markups for insert to public
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('plans'::text)));

drop policy if exists "markups_contractor_update" on public.plan_markups;
create policy "markups_contractor_update" on public.plan_markups for update to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('plans'::text)))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('plans'::text)));

drop policy if exists "tasks_member_insert" on public.tasks;
create policy "tasks_member_insert" on public.tasks for insert to public
  with check (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "tasks_member_update" on public.tasks;
create policy "tasks_member_update" on public.tasks for update to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id)) AND ((assigned_to = (auth.uid())::text) OR (created_by = (auth.uid())::text))))
  with check (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "tasks_contractor_read" on public.tasks;
create policy "tasks_contractor_read" on public.tasks for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "tasks_contractor_update" on public.tasks;
create policy "tasks_contractor_update" on public.tasks for update to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "tasks_contractor_insert" on public.tasks;
create policy "tasks_contractor_insert" on public.tasks for insert to public
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id))));

drop policy if exists "dsets_contractor_read" on public.drawing_sets;
create policy "dsets_contractor_read" on public.drawing_sets for select to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('plans'::text)));

drop policy if exists "projects_member_read" on public.projects;
create policy "projects_member_read" on public.projects for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(id))));

drop policy if exists "rfis_member_read" on public.rfis;
create policy "rfis_member_read" on public.rfis for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "sub_member_read" on public.submittals;
create policy "sub_member_read" on public.submittals for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "co_member_read" on public.change_orders;
create policy "co_member_read" on public.change_orders for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "docs_member_read" on public.documents;
create policy "docs_member_read" on public.documents for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "dsets_member_read" on public.drawing_sets;
create policy "dsets_member_read" on public.drawing_sets for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "fr_member_read" on public.field_reports;
create policy "fr_member_read" on public.field_reports for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "markups_member_read" on public.plan_markups;
create policy "markups_member_read" on public.plan_markups for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "lw_member_read" on public.lien_waivers;
create policy "lw_member_read" on public.lien_waivers for select to public
  using (((plz_role() = 'member'::text) AND (EXISTS ( SELECT 1 FROM pay_apps p WHERE ((p.id = lien_waivers.pay_app_id) AND (plz_has_project(p.project_id)))))));

drop policy if exists "ms_member_read" on public.milestones;
create policy "ms_member_read" on public.milestones for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "pa_member_read" on public.pay_apps;
create policy "pa_member_read" on public.pay_apps for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "sov_member_read" on public.sov_items;
create policy "sov_member_read" on public.sov_items for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "def_member_read" on public.deficiencies;
create policy "def_member_read" on public.deficiencies for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "daily_member_read" on public.daily_reports;
create policy "daily_member_read" on public.daily_reports for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "photos_member_read" on public.photos;
create policy "photos_member_read" on public.photos for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "seals_member_read" on public.report_seals;
create policy "seals_member_read" on public.report_seals for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "routing_member_read" on public.routing_events;
create policy "routing_member_read" on public.routing_events for select to public
  using (((plz_role() = 'member'::text) AND (plz_has_project(project_id))));

drop policy if exists "pal_member_read" on public.pay_app_lines;
create policy "pal_member_read" on public.pay_app_lines for select to public
  using (((plz_role() = 'member'::text) AND (EXISTS ( SELECT 1 FROM pay_apps p WHERE ((p.id = pay_app_lines.pay_app_id) AND (plz_has_project(p.project_id)))))));

drop policy if exists "co_contractor_write" on public.change_orders;
create policy "co_contractor_write" on public.change_orders for insert to public
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('cos'::text)));

drop policy if exists "co_contractor_update" on public.change_orders;
create policy "co_contractor_update" on public.change_orders for update to public
  using (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('cos'::text) AND (status = 'pending'::text)))
  with check (((plz_role() = 'contractor'::text) AND (plz_has_project(project_id)) AND plz_perm('cos'::text) AND (status = 'pending'::text)));
