-- Non-owner access to the audit trail inherits the caller's access to the pay app
-- itself, instead of re-implementing it with plz_project(): staff reach projects
-- through project_members (plz_has_project), contractors need perms.payapps, and
-- members need financial access. The pay_apps RLS already encodes all of that, so
-- the EXISTS below is evaluated under it. A deleted pay app's trail is therefore
-- owner-only, which is intended.
drop policy if exists paa_project_read   on pay_app_import_audits;
drop policy if exists paa_project_insert on pay_app_import_audits;

create policy paa_project_read on pay_app_import_audits
  for select using (
    plz_role() in ('staff','member','contractor')
    and exists (select 1 from pay_apps p
                 where p.id = pay_app_import_audits.pay_app_id
                   and p.project_id = pay_app_import_audits.project_id)
  );

create policy paa_project_insert on pay_app_import_audits
  for insert with check (
    plz_role() in ('staff','contractor')
    and event in ('applied','audit_reviewed','submitted','reopened','deleted')
    and exists (select 1 from pay_apps p
                 where p.id = pay_app_import_audits.pay_app_id
                   and p.project_id = pay_app_import_audits.project_id)
  );
