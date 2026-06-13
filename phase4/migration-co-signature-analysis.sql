-- PLAZACORE — Change Order signature gate + AI document analysis
-- Adds the columns the analyze-co edge function writes, and a HARD database
-- trigger so a CO can NEVER be marked 'approved' unless it has been
-- signature-verified (signed = true). This holds regardless of path
-- (app UI, direct PostgREST, raw SQL by a non-owner, etc).
--
-- Flow: owner clicks Approve -> analyze-co edge fn reads the executed CO file,
-- confirms signatures, extracts line items, sets signed=true + analysis, THEN
-- approval proceeds and the items roll into a new SOV version.
-- Idempotent + transactional.

begin;

-- 1. Analysis / signature columns on change_orders
alter table change_orders add column if not exists signed boolean not null default false;
alter table change_orders add column if not exists signature_summary text;     -- human-readable: who signed / what's missing
alter table change_orders add column if not exists analysis jsonb;             -- full structured extraction (line items, total, confidence)
alter table change_orders add column if not exists analyzed_at timestamptz;
alter table change_orders add column if not exists analyzed_by text;

-- 2. HARD signature gate: block approval unless signature-verified.
--    Applies to every CO (approved == fully executed). PCOs are 'pending'/proposed,
--    so they are unaffected until someone tries to set status='approved'.
create or replace function plz_co_require_signature()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'approved' and coalesce(new.signed, false) is not true then
    raise exception 'CO % cannot be approved: executed document is not signature-verified. Run document analysis first.', coalesce(new.co_number::text, '(new)')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_co_require_signature on change_orders;
create trigger trg_co_require_signature
  before insert or update on change_orders
  for each row execute function plz_co_require_signature();

commit;

-- ROLLBACK (manual):
--   drop trigger if exists trg_co_require_signature on change_orders;
--   drop function if exists plz_co_require_signature();
--   alter table change_orders drop column if exists signed, drop column if exists signature_summary,
--     drop column if exists analysis, drop column if exists analyzed_at, drop column if exists analyzed_by;
