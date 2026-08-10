-- PLAZACORE — Change Order signature gate: OWNER-ONLY documented override
--
-- Purpose (William, 2026-08-10): some COs must be processed before every party has
-- signed. Real case: CO-8 on Terrazas (26011) is a credit reconciling a duplicate
-- payment — the contractor signed 08/05/26, Architect + Owner blocks are blank, and
-- the accounting needs to close now. The signature gate is correct in general and
-- must stay; what was missing is a deliberate, attributable exception.
--
-- Design rules:
--   1. OWNER ONLY. staff/member/contractor can never override. Enforced in the
--      trigger (not just the UI), so PostgREST/raw SQL cannot bypass it either.
--   2. NEVER SILENT. An override records who, when, and a mandatory written reason.
--      Missing/blank reason => rejected.
--   3. NOT STICKY. Replacing the CO document clears the override (see part 4), so a
--      swapped-in document is re-verified on its own merits.
--   4. Overriding does NOT fake a signature. `signed` stays false; the CO is marked
--      approved with an explicit override flag. Reports must show it as such.
--
-- ⚠️ SUPERSEDES the function body in BOTH:
--      phase4/migration-co-signature-analysis.sql   (base gate)
--      phase4/migration-co-signature-allblocks.sql  (all-blocks gate)
--    This file is a strict SUPERSET: it keeps the base gate AND the all-blocks gate
--    verbatim, and only adds the override branch in front of them. Apply this LAST.
--    If allblocks is applied after this file, the override is silently lost.
--
-- Idempotent + transactional.

begin;

-- 1. Override audit columns.
alter table change_orders add column if not exists signature_override boolean not null default false;
alter table change_orders add column if not exists signature_override_reason text;
alter table change_orders add column if not exists signature_override_by text;
alter table change_orders add column if not exists signature_override_at timestamptz;

comment on column change_orders.signature_override is
  'Owner-only: approve this CO despite blank signature block(s). Never implies the document is signed.';
comment on column change_orders.signature_override_reason is
  'Mandatory written justification for the override. Appears on reports and in the audit trail.';

-- 2. Gate: base signature check + all-blocks check, with an owner-only override branch.
create or replace function plz_co_require_signature()
returns trigger
language plpgsql
as $$
declare
  unsigned_count int;
  jwt_role       text := coalesce((auth.jwt() ->> 'user_role'), '');
  actor          text := coalesce((auth.jwt() ->> 'email'), '');
begin
  -- ---- Override integrity: policed on EVERY write, not only on approval. ----
  -- Turning the override ON is an owner-only act and always needs a reason.
  if coalesce(new.signature_override, false) is true
     and coalesce(old.signature_override, false) is not true then

    if jwt_role <> 'owner' then
      raise exception 'Only the owner may override the change-order signature requirement (role: %).',
        coalesce(nullif(jwt_role, ''), 'unknown')
        using errcode = 'insufficient_privilege';
    end if;

    if coalesce(btrim(new.signature_override_reason), '') = '' then
      raise exception 'A written reason is required to override the signature requirement on CO %.',
        coalesce(new.co_number::text, '(new)')
        using errcode = 'check_violation';
    end if;

    -- Stamp attribution server-side so it cannot be spoofed or omitted by the client.
    new.signature_override_by := coalesce(nullif(actor, ''), new.signature_override_by, 'owner');
    new.signature_override_at := coalesce(new.signature_override_at, now());
  end if;

  -- Clearing an override is likewise owner-only, and wipes the audit stamps.
  if coalesce(old.signature_override, false) is true
     and coalesce(new.signature_override, false) is not true then
    if jwt_role <> 'owner' then
      raise exception 'Only the owner may clear a change-order signature override (role: %).',
        coalesce(nullif(jwt_role, ''), 'unknown')
        using errcode = 'insufficient_privilege';
    end if;
    new.signature_override_reason := null;
    new.signature_override_by     := null;
    new.signature_override_at     := null;
  end if;

  -- A new/replacement document invalidates any prior override: re-verify on merit.
  if new.file_path is distinct from old.file_path
     and coalesce(new.signature_override, false) is true then
    new.signature_override        := false;
    new.signature_override_reason := null;
    new.signature_override_by     := null;
    new.signature_override_at     := null;
  end if;

  -- ---- Approval gate ----
  if new.status = 'approved' then

    -- Documented owner override: skip the signature checks, keep everything else.
    if coalesce(new.signature_override, false) is true then
      if coalesce(btrim(new.signature_override_reason), '') = '' then
        raise exception 'CO % cannot be approved by override without a written reason.',
          coalesce(new.co_number::text, '(new)')
          using errcode = 'check_violation';
      end if;
      return new;
    end if;

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
        raise exception 'CO % cannot be approved: % signature block(s) on the document are still blank/unsigned. All parties must sign before approval, or the owner may record a documented override.', coalesce(new.co_number::text, '(new)'), unsigned_count
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- INSERT has no OLD row; the override branches above dereference OLD, so route
-- inserts through a thin wrapper that supplies an empty OLD-equivalent.
create or replace function plz_co_require_signature_ins()
returns trigger
language plpgsql
as $$
declare
  unsigned_count int;
  jwt_role       text := coalesce((auth.jwt() ->> 'user_role'), '');
  actor          text := coalesce((auth.jwt() ->> 'email'), '');
begin
  if coalesce(new.signature_override, false) is true then
    if jwt_role <> 'owner' then
      raise exception 'Only the owner may create a change order with a signature override (role: %).',
        coalesce(nullif(jwt_role, ''), 'unknown')
        using errcode = 'insufficient_privilege';
    end if;
    if coalesce(btrim(new.signature_override_reason), '') = '' then
      raise exception 'A written reason is required to override the signature requirement.'
        using errcode = 'check_violation';
    end if;
    new.signature_override_by := coalesce(nullif(actor, ''), new.signature_override_by, 'owner');
    new.signature_override_at := coalesce(new.signature_override_at, now());
    if new.status = 'approved' then
      return new;   -- documented override
    end if;
  end if;

  if new.status = 'approved' then
    if coalesce(new.signed, false) is not true then
      raise exception 'CO % cannot be approved: executed document is not signature-verified. Run document analysis first.', coalesce(new.co_number::text, '(new)')
        using errcode = 'check_violation';
    end if;
    if new.analysis is not null
       and jsonb_typeof(new.analysis -> 'signature_blocks') = 'array' then
      select count(*) into unsigned_count
      from jsonb_array_elements(new.analysis -> 'signature_blocks') b
      where coalesce((b ->> 'signed')::boolean, false) is not true;
      if unsigned_count > 0 then
        raise exception 'CO % cannot be approved: % signature block(s) are blank/unsigned.', coalesce(new.co_number::text, '(new)'), unsigned_count
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_co_require_signature on change_orders;
create trigger trg_co_require_signature
  before update on change_orders
  for each row execute function plz_co_require_signature();

drop trigger if exists trg_co_require_signature_ins on change_orders;
create trigger trg_co_require_signature_ins
  before insert on change_orders
  for each row execute function plz_co_require_signature_ins();

commit;

-- VERIFY (expect: 4 columns present, 2 triggers, override branch in prosrc)
--   select column_name from information_schema.columns
--     where table_name='change_orders' and column_name like 'signature_override%';
--   select tgname from pg_trigger where tgrelid='change_orders'::regclass and not tgisinternal;
--   select prosrc like '%signature_override%' from pg_proc where proname='plz_co_require_signature';
--
-- ROLLBACK (manual):
--   drop trigger if exists trg_co_require_signature_ins on change_orders;
--   drop function if exists plz_co_require_signature_ins();
--   -- then re-apply phase4/migration-co-signature-allblocks.sql to restore the
--   -- pre-override gate, and optionally:
--   -- alter table change_orders drop column if exists signature_override,
--   --   drop column if exists signature_override_reason,
--   --   drop column if exists signature_override_by,
--   --   drop column if exists signature_override_at;
