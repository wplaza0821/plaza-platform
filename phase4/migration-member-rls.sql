-- migration-member-rls.sql
-- Root cause of "member can't see their project / no Terrazas for Tareec":
-- the `member` role was only ever granted RLS on `tasks` and `plan_pins`.
-- Every other table allowed only owner + contractor, so a signed-in member
-- saw an empty app even with a correct project_id claim in their JWT.
--
-- This grants member SELECT across all project-scoped tables, mirroring the
-- existing contractor read policies but WITHOUT the per-module plz_perm() gate
-- (members are internal Plaza staff, not external contractors, so they get full
-- read on the project they're assigned to). Writes are intentionally left as-is
-- (members already have task read/update); expand later if needed.
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE.

-- projects: keyed on id (not project_id)
drop policy if exists projects_member_read on projects;
create policy projects_member_read on projects
  for select using (plz_role() = 'member' and id = plz_project());

-- standard project_id = plz_project() tables
drop policy if exists rfis_member_read on rfis;
create policy rfis_member_read on rfis
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists sub_member_read on submittals;
create policy sub_member_read on submittals
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists co_member_read on change_orders;
create policy co_member_read on change_orders
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists docs_member_read on documents;
create policy docs_member_read on documents
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists dsets_member_read on drawing_sets;
create policy dsets_member_read on drawing_sets
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists fr_member_read on field_reports;
create policy fr_member_read on field_reports
  for select using (plz_role() = 'member' and project_id = plz_project());

-- lien_waivers: scoped through parent pay_apps (no direct project_id)
drop policy if exists lw_member_read on lien_waivers;
create policy lw_member_read on lien_waivers
  for select using (
    plz_role() = 'member'
    and exists (
      select 1 from pay_apps p
      where p.id = lien_waivers.pay_app_id
        and p.project_id = plz_project()
    )
  );

drop policy if exists ms_member_read on milestones;
create policy ms_member_read on milestones
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists pa_member_read on pay_apps;
create policy pa_member_read on pay_apps
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists sov_member_read on sov_items;
create policy sov_member_read on sov_items
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists def_member_read on deficiencies;
create policy def_member_read on deficiencies
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists daily_member_read on daily_reports;
create policy daily_member_read on daily_reports
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists photos_member_read on photos;
create policy photos_member_read on photos
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists markups_member_read on plan_markups;
create policy markups_member_read on plan_markups
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists seals_member_read on report_seals;
create policy seals_member_read on report_seals
  for select using (plz_role() = 'member' and project_id = plz_project());

drop policy if exists routing_member_read on routing_events;
create policy routing_member_read on routing_events
  for select using (plz_role() = 'member' and project_id = plz_project());

-- pay_app_lines: scoped through parent pay_apps (no direct project_id)
drop policy if exists pal_member_read on pay_app_lines;
create policy pal_member_read on pay_app_lines
  for select using (
    plz_role() = 'member'
    and exists (
      select 1 from pay_apps p
      where p.id = pay_app_lines.pay_app_id
        and p.project_id = plz_project()
    )
  );

-- inspection_templates: not project-scoped (shared library), role-only read
drop policy if exists insp_tpl_member_read on inspection_templates;
create policy insp_tpl_member_read on inspection_templates
  for select using (plz_role() = 'member');
