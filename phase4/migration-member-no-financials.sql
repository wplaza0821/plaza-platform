-- migration-member-no-financials.sql
-- William: Noel should be a MEMBER (read-only inspector) with NO financials.
-- But Edwin (client/property manager) is ALSO a member and SHOULD see pay apps.
-- So we can't strip financials from the whole member role. Instead: a per-user
-- "no_financials" flag (profiles.perms->>'no_financials'), read DIRECTLY from
-- the DB so it takes effect instantly (no token refresh). Default off => existing
-- members (Edwin) keep financial visibility. We gate the member financial READ
-- policies with NOT plz_no_financials(). Idempotent.

-- Helper: true when the current user's profile is flagged no_financials.
create or replace function plz_no_financials()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce(
    (select (perms ->> 'no_financials')::boolean
       from profiles where id = auth.uid()),
    false)
$$;
revoke all on function plz_no_financials() from public;
grant execute on function plz_no_financials() to authenticated;

-- Re-create the 5 member financial READ policies with the gate.
drop policy if exists pa_member_read on pay_apps;
create policy pa_member_read on pay_apps for select
  using (plz_role() = 'member' and plz_has_project(project_id) and not plz_no_financials());

drop policy if exists sov_member_read on sov_items;
create policy sov_member_read on sov_items for select
  using (plz_role() = 'member' and plz_has_project(project_id) and not plz_no_financials());

drop policy if exists co_member_read on change_orders;
create policy co_member_read on change_orders for select
  using (plz_role() = 'member' and plz_has_project(project_id) and not plz_no_financials());

drop policy if exists pal_member_read on pay_app_lines;
create policy pal_member_read on pay_app_lines for select
  using (plz_role() = 'member' and not plz_no_financials() and exists (
    select 1 from pay_apps p where p.id = pay_app_lines.pay_app_id and plz_has_project(p.project_id)));

drop policy if exists lw_member_read on lien_waivers;
create policy lw_member_read on lien_waivers for select
  using (plz_role() = 'member' and not plz_no_financials() and exists (
    select 1 from pay_apps p where p.id = lien_waivers.pay_app_id and plz_has_project(p.project_id)));
