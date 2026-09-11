-- Native (email/password) contractor logins carry no contractor_id claim, and
-- RLS hides the contractors table from the contractor role (it holds every
-- contractor's access_token, so it must stay hidden). The front-end therefore
-- could not resolve "which contractors row am I" and refused to create a pay
-- app draft ("session is missing its contractor identity" — Tareec/TRPV PA#4,
-- 2026-09-11). This SECURITY DEFINER function does the lookup server-side and
-- returns ONLY the caller's own contractors.id — never the row, never a token.
--
-- Resolution: contact_email = the caller's profile email, within the caller's
-- project; fallback = the project's only active contractor. Null otherwise.

create or replace function public.resolve_my_contractor_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.project_id, lower(trim(p.email)) as email
    from public.profiles p
    where p.id = auth.uid()
      and p.app_role = 'contractor'
      and coalesce(p.active, true)
  ),
  live as (
    select c.id, lower(trim(coalesce(c.contact_email, ''))) as email
    from public.contractors c, me
    where c.project_id = me.project_id
      and coalesce(c.active, true)
      and c.revoked_at is null
  )
  select coalesce(
    (select l.id from live l, me where l.email = me.email limit 1),
    (select l.id from live l where (select count(*) from live) = 1)
  );
$$;

revoke all on function public.resolve_my_contractor_id() from public, anon;
grant execute on function public.resolve_my_contractor_id() to authenticated;
