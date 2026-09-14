-- Pay application sign-off gate (William, 2026-09-14)
--
-- Before a pay app can be approved, the reviewer must confirm two things on the
-- submitted G702: (1) the engineer/architect certification block is signed, and
-- (2) the notary seal is present. After approval, the fully signed + notarized
-- copy is uploaded back as doc_type = 'executed_payapp'.
--
-- Enforced at the DATABASE layer, not just in the UI, exactly like the existing
-- waiver gate (20260624_require_waiver_before_submit.sql) -- these documents are
-- AHJ-submitted and subpoena-eligible, so a raw PostgREST call must not be able
-- to route around the check.

-- 1. Sign-off stamps. Who confirmed what, and when. Nullable = not yet verified.
alter table pay_apps
  add column if not exists signature_verified_at timestamptz,
  add column if not exists signature_verified_by text,
  add column if not exists notary_verified_at    timestamptz,
  add column if not exists notary_verified_by    text;

comment on column pay_apps.signature_verified_at is
  'Set when the reviewer confirms the engineer/architect certification block is signed. Required before approval.';
comment on column pay_apps.notary_verified_at is
  'Set when the reviewer confirms the notary seal is present. Required before approval.';

-- 2. Allow the executed (signed + notarized) copy as a document type.
alter table pay_app_documents
  drop constraint if exists pay_app_documents_doc_type_check;

alter table pay_app_documents
  add constraint pay_app_documents_doc_type_check
  check (doc_type in ('change_order','backup','correspondence','other','pay_application','executed_payapp'));

-- 3. Gate: no approval without both confirmations.
create or replace function enforce_signoff_before_approve()
returns trigger
language plpgsql
as $$
begin
  -- Clear stale confirmations whenever the pay app goes back for rework, so a
  -- resubmitted app cannot inherit sign-off from a superseded version.
  if NEW.status is distinct from OLD.status
     and NEW.status in ('draft','rejected')
  then
    NEW.signature_verified_at := null;
    NEW.signature_verified_by := null;
    NEW.notary_verified_at    := null;
    NEW.notary_verified_by    := null;
    return NEW;
  end if;

  -- Enforce on entry into an approved state, and on a direct jump to 'paid'
  -- from a status that was never approved.
  if NEW.status is distinct from OLD.status
     and (
       NEW.status in ('approved','approved_as_noted')
       or (NEW.status = 'paid' and OLD.status not in ('approved','approved_as_noted'))
     )
  then
    if NEW.signature_verified_at is null then
      raise exception 'The engineer/architect signature block must be verified before this pay application can be approved.'
        using errcode = 'check_violation';
    end if;
    if NEW.notary_verified_at is null then
      raise exception 'The notary seal must be verified before this pay application can be approved.'
        using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_signoff_before_approve on pay_apps;

create trigger trg_enforce_signoff_before_approve
  before update on pay_apps
  for each row
  execute function enforce_signoff_before_approve();
