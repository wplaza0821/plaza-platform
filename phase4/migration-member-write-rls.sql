-- migration-member-write-rls.sql
-- Members (internal Plaza staff) had READ via migration-member-rls.sql but could
-- only WRITE to tasks. Tareec hit "new row violates RLS policy for pay_apps"
-- when creating a pay app. This grants members operational write access,
-- mirroring the existing contractor write policies but WITHOUT the per-module
-- plz_perm() gate (members are internal, not permission-scoped contractors),
-- still scoped to their assigned project (project_id = plz_project()).
--
-- Granted (operational, day-to-day work):
--   pay_apps (insert + update while draft/submitted), pay_app_lines,
--   rfis (insert/update), submittals (insert/update), deficiencies (rw),
--   daily_reports (rw), photos (rw), plan_markups (insert/update),
--   plan_pins (rw), lien_waivers (insert), field_reports (rw).
--
-- Deliberately LEFT owner-only (contractual / admin / locked controls):
--   change_orders, sov_items, projects, drawing_sets, documents, milestones,
--   report_seals, routing_events, inspection_templates, contractors.
--   (Expand later if William wants members to manage these too.)
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE.

-- pay_apps: create + edit while still draft/submitted (mirrors contractor guard,
-- so members can't alter approved/locked pay apps).
drop policy if exists pa_member_write on pay_apps;
create policy pa_member_write on pay_apps
  for insert with check (plz_role() = 'member' and project_id = plz_project());

drop policy if exists pa_member_update on pay_apps;
create policy pa_member_update on pay_apps
  for update using (
    plz_role() = 'member' and project_id = plz_project()
    and status = any (array['draft','submitted'])
  ) with check (status = any (array['draft','submitted']));

-- pay_app_lines: scoped through parent pay_apps
drop policy if exists pal_member_rw on pay_app_lines;
create policy pal_member_rw on pay_app_lines
  for all using (
    plz_role() = 'member'
    and exists (select 1 from pay_apps p
                where p.id = pay_app_lines.pay_app_id and p.project_id = plz_project())
  ) with check (
    plz_role() = 'member'
    and exists (select 1 from pay_apps p
                where p.id = pay_app_lines.pay_app_id and p.project_id = plz_project())
  );

-- rfis
drop policy if exists rfis_member_write on rfis;
create policy rfis_member_write on rfis
  for insert with check (plz_role() = 'member' and project_id = plz_project());
drop policy if exists rfis_member_update on rfis;
create policy rfis_member_update on rfis
  for update using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- submittals
drop policy if exists sub_member_write on submittals;
create policy sub_member_write on submittals
  for insert with check (plz_role() = 'member' and project_id = plz_project());
drop policy if exists sub_member_update on submittals;
create policy sub_member_update on submittals
  for update using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- deficiencies: full rw
drop policy if exists def_member_rw on deficiencies;
create policy def_member_rw on deficiencies
  for all using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- daily_reports: full rw
drop policy if exists daily_member_rw on daily_reports;
create policy daily_member_rw on daily_reports
  for all using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- photos: full rw
drop policy if exists photos_member_rw on photos;
create policy photos_member_rw on photos
  for all using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- plan_markups: insert + update
drop policy if exists markups_member_insert on plan_markups;
create policy markups_member_insert on plan_markups
  for insert with check (plz_role() = 'member' and project_id = plz_project());
drop policy if exists markups_member_update on plan_markups;
create policy markups_member_update on plan_markups
  for update using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- plan_pins: full rw
drop policy if exists plan_pins_member_rw on plan_pins;
create policy plan_pins_member_rw on plan_pins
  for all using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());

-- lien_waivers: insert, scoped through parent pay_apps
drop policy if exists lw_member_write on lien_waivers;
create policy lw_member_write on lien_waivers
  for insert with check (
    plz_role() = 'member'
    and exists (select 1 from pay_apps p
                where p.id = lien_waivers.pay_app_id and p.project_id = plz_project())
  );

-- field_reports: full rw (in-app New Field Report flow + Dropbox sync uses service key)
drop policy if exists fr_member_rw on field_reports;
create policy fr_member_rw on field_reports
  for all using (plz_role() = 'member' and project_id = plz_project())
  with check (plz_role() = 'member' and project_id = plz_project());
