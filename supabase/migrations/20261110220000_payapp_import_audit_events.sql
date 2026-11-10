-- A contractor deleting their own draft pay app leaves a record too (the owner
-- already can). Reopen stays owner-only in the app; allowing the event here is
-- harmless because the pay_apps policies decide who can actually reopen.
drop policy if exists paa_project_insert on pay_app_import_audits;
create policy paa_project_insert on pay_app_import_audits
  for insert with check (
    plz_role() in ('staff','contractor')
    and project_id = plz_project()
    and event in ('applied','audit_reviewed','submitted','reopened','deleted')
    and exists (select 1 from pay_apps p
                 where p.id = pay_app_import_audits.pay_app_id
                   and p.project_id = plz_project())
  );
