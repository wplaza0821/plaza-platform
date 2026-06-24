-- Defense-in-depth: a pay app cannot leave 'draft' (i.e. be submitted, reviewed,
-- approved, approved_as_noted, or paid) unless a partial release & waiver of lien
-- row exists for it in lien_waivers. This enforces the rule at the DATABASE layer
-- so the UI button, raw PostgREST/API calls, and any future client are all gated
-- (the prior gate was UI-only, which let PayApp #1 reach 'approved' with no waiver).

create or replace function enforce_waiver_before_submit()
returns trigger
language plpgsql
as $$
begin
  -- Only enforce on the transition OUT of draft into a submitted/locked status.
  -- Allow staying in draft, and allow already-non-draft rows to change freely
  -- (e.g. approve -> paid), since the waiver was required at submit time.
  if NEW.status is distinct from OLD.status
     and OLD.status = 'draft'
     and NEW.status in ('submitted','under_review','approved','approved_as_noted','paid')
  then
    if not exists (
      select 1 from lien_waivers w where w.pay_app_id = NEW.id
    ) then
      raise exception 'A partial release & waiver of lien must be uploaded before this pay application can be submitted.'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_waiver_before_submit on pay_apps;

create trigger trg_enforce_waiver_before_submit
  before update on pay_apps
  for each row
  execute function enforce_waiver_before_submit();
