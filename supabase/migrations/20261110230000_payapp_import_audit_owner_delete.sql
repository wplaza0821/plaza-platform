-- Owner may delete audit-trail entries (William, 2026-11-10: "If I ever want to
-- delete the trail, I want to have the ability").
-- Still enforced for everyone else, and for everyone on edits:
--   * UPDATE is rejected for every role, owner included: an entry can be removed,
--     never silently altered;
--   * DELETE only with an owner JWT (service role, staff, contractors and direct
--     SQL without an owner JWT are still rejected);
--   * TRUNCATE stays rejected.
create or replace function plz_pa_audit_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and plz_is_owner() then
    return old;
  end if;
  raise exception 'pay_app_import_audits: % is not permitted%', tg_op,
    case when tg_op = 'DELETE' then ' (owner only)' else '' end
    using errcode = '42501';
end;
$$;

drop policy if exists paa_owner_delete on pay_app_import_audits;
create policy paa_owner_delete on pay_app_import_audits
  for delete using (plz_is_owner());

grant delete on pay_app_import_audits to authenticated;

comment on table pay_app_import_audits is
  'Audit trail of pay-application imports and cross-checks. UPDATE and TRUNCATE are rejected for every role; DELETE is owner-only. No FK to pay_apps so the record survives pay-app deletion.';
