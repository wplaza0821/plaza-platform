-- migration-contractor-cos-rls.sql
-- Tareec (contractor) must submit submittals, change orders, AND pay apps.
-- Submittals + pay_apps already have contractor write policies (gated on
-- plz_perm('submittals') / plz_perm('payapps')). Change orders did NOT — the
-- change_orders table was owner-only. This adds contractor insert + update
-- (while still pending) gated on a new 'cos' permission flag, mirroring the
-- existing submittals/payapps pattern.
--
-- Contractors can create a CO and edit it while status='pending'; once an owner
-- moves it to approved/rejected/void it locks (owner_all still has full control).
-- Idempotent.

drop policy if exists co_contractor_write on change_orders;
create policy co_contractor_write on change_orders
  for insert with check (
    plz_role() = 'contractor'
    and project_id = plz_project()
    and plz_perm('cos')
  );

drop policy if exists co_contractor_update on change_orders;
create policy co_contractor_update on change_orders
  for update using (
    plz_role() = 'contractor'
    and project_id = plz_project()
    and plz_perm('cos')
    and status = 'pending'
  ) with check (
    plz_role() = 'contractor'
    and project_id = plz_project()
    and plz_perm('cos')
    and status = 'pending'
  );
