-- migration-staff-project-scope.sql
-- William: keep Noel as STAFF but limit him to Terrazas only (no Residences/others).
-- Problem: the 'staff' role was GLOBAL all-projects with rules only on tasks +
-- plan_pins, and NO read on the real project tables. So staff both leaked across
-- all projects AND couldn't see project data. This makes staff project-scoped
-- (via plz_has_project) and grants staff project-scoped READ on every project
-- table, mirroring the member pattern. Staff retains edit on tasks + plan_pins
-- (now scoped to their assigned projects). Idempotent.

-- 1) Scope staff's existing GLOBAL edit rules to project membership ----------
drop policy if exists tasks_staff_all on tasks;
create policy tasks_staff_all on tasks
  for all
  using  (plz_role() = 'staff' and plz_has_project(project_id))
  with check (plz_role() = 'staff' and plz_has_project(project_id));

-- plan_pins: split staff out of the owner_all OR-clause and scope it.
drop policy if exists plan_pins_owner_all on plan_pins;
create policy plan_pins_owner_all on plan_pins
  for all using (plz_is_owner()) with check (plz_is_owner());
drop policy if exists plan_pins_staff_rw on plan_pins;
create policy plan_pins_staff_rw on plan_pins
  for all
  using  (plz_role() = 'staff' and plz_has_project(project_id))
  with check (plz_role() = 'staff' and plz_has_project(project_id));

-- 2) Project-scoped READ for staff on every project table (mirror member) ----
-- direct project_id column tables
drop policy if exists co_staff_read on change_orders;
create policy co_staff_read on change_orders for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists daily_staff_read on daily_reports;
create policy daily_staff_read on daily_reports for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists def_staff_read on deficiencies;
create policy def_staff_read on deficiencies for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists docs_staff_read on documents;
create policy docs_staff_read on documents for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists dsets_staff_read on drawing_sets;
create policy dsets_staff_read on drawing_sets for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists fr_staff_read on field_reports;
create policy fr_staff_read on field_reports for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists ms_staff_read on milestones;
create policy ms_staff_read on milestones for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists pa_staff_read on pay_apps;
create policy pa_staff_read on pay_apps for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists photos_staff_read on photos;
create policy photos_staff_read on photos for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists markups_staff_read on plan_markups;
create policy markups_staff_read on plan_markups for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists seals_staff_read on report_seals;
create policy seals_staff_read on report_seals for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists rfis_staff_read on rfis;
create policy rfis_staff_read on rfis for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists routing_staff_read on routing_events;
create policy routing_staff_read on routing_events for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists sov_staff_read on sov_items;
create policy sov_staff_read on sov_items for select
  using (plz_role() = 'staff' and plz_has_project(project_id));
drop policy if exists sub_staff_read on submittals;
create policy sub_staff_read on submittals for select
  using (plz_role() = 'staff' and plz_has_project(project_id));

-- projects table keys on id
drop policy if exists projects_staff_read on projects;
create policy projects_staff_read on projects for select
  using (plz_role() = 'staff' and plz_has_project(id));

-- subtables without project_id: scope through parent pay_apps
drop policy if exists pal_staff_read on pay_app_lines;
create policy pal_staff_read on pay_app_lines for select
  using (plz_role() = 'staff' and exists (
    select 1 from pay_apps p where p.id = pay_app_lines.pay_app_id and plz_has_project(p.project_id)));
drop policy if exists lw_staff_read on lien_waivers;
create policy lw_staff_read on lien_waivers for select
  using (plz_role() = 'staff' and exists (
    select 1 from pay_apps p where p.id = lien_waivers.pay_app_id and plz_has_project(p.project_id)));

-- plan_pins already has staff RW above; add member-parity read already covered.
