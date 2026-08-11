-- ############################################################################
-- ## ⛔ SUPERSEDED — DO NOT RUN. Historical record only.                     ##
-- ##                                                                        ##
-- ## Superseded by: migration-co-signature-override.sql (2026-08-10)        ##
-- ##                                                                        ##
-- ## That later migration CREATE OR REPLACEs plz_co_require_signature() with
-- ## a superset body: it keeps the all-blocks gate below AND adds the owner
-- ## signature-override subsystem (owner-only enforcement, mandatory written
-- ## reason, server-side by/at attribution, override clearing, and automatic
-- ## invalidation when a replacement document is uploaded).
-- ##
-- ## Re-running THIS file would CREATE OR REPLACE the function back to the
-- ## older body and DESTROY the entire override subsystem in production —
-- ## silently, with no error. CO #8 was approved under a documented override
-- ## and would become unupdatable; the override UI in index.html would break.
-- ##
-- ## Live function body verified 2026-08-11 to be the override version.
-- ## To re-assert the gate, run migration-co-signature-override.sql instead.
-- ############################################################################
--
-- PLAZACORE — Change Order signature gate: require EVERY block signed
-- Hardens the existing signature gate (migration-co-signature-analysis.sql).
--
-- Problem: COs were being approved with MISSING signatures. The prior rule only
-- required an Owner+Contractor subset; a form that also carried an Architect,
-- Engineer, or Special Inspector block could be approved with those left blank.
--
-- Fix (defense in depth): the analyze-co edge function now enumerates EVERY
-- signature block on the document into analysis.signature_blocks[] and only sets
-- signed=true when NONE are blank. This trigger adds a DB-level backstop so that
-- even if a stale/hand-crafted row arrives with signed=true while the persisted
-- analysis still lists an unsigned block, approval is rejected.
--
-- Idempotent + transactional.

begin;

create or replace function plz_co_require_signature()
returns trigger
language plpgsql
as $$
declare
  unsigned_count int;
begin
  if new.status = 'approved' then
    -- 1. Base gate: must be signature-verified.
    if coalesce(new.signed, false) is not true then
      raise exception 'CO % cannot be approved: executed document is not signature-verified. Run document analysis first.', coalesce(new.co_number::text, '(new)')
        using errcode = 'check_violation';
    end if;

    -- 2. All-blocks gate: if the analysis enumerated signature blocks, EVERY one
    --    must be signed. A blank block on the form blocks approval regardless of role.
    if new.analysis is not null
       and jsonb_typeof(new.analysis -> 'signature_blocks') = 'array' then
      select count(*) into unsigned_count
      from jsonb_array_elements(new.analysis -> 'signature_blocks') b
      where coalesce((b ->> 'signed')::boolean, false) is not true;

      if unsigned_count > 0 then
        raise exception 'CO % cannot be approved: % signature block(s) on the document are still blank/unsigned. All parties must sign before approval.', coalesce(new.co_number::text, '(new)'), unsigned_count
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Trigger definition unchanged (function body replaced above).
drop trigger if exists trg_co_require_signature on change_orders;
create trigger trg_co_require_signature
  before insert or update on change_orders
  for each row execute function plz_co_require_signature();

commit;

-- ROLLBACK (manual): restore the prior function body from
--   migration-co-signature-analysis.sql, then re-create the trigger.
