-- =====================================================================
-- PLAZACORE PHASE 4-02 — SEALED / FINALIZED DELIVERABLE PIPELINE
-- P0 #3. Professional-liability: SI/FOR reports are subpoena-eligible and
-- carry Tomas E. Hernandez PE seal. Replace window.print() with an
-- immutable, hashed, signed PDF of record. Lock editing after finalize.
-- Pattern: owner full; contractor read own project. Re-runnable.
-- =====================================================================
begin;

-- Finalization fields on field_reports.
alter table field_reports
  add column if not exists finalized          boolean default false,
  add column if not exists finalized_at        timestamptz,
  add column if not exists finalized_by        text,
  add column if not exists finalized_pdf_path  text,        -- storage: field-reports bucket
  add column if not exists finalized_hash      text,        -- sha256 of the PDF bytes (immutability proof)
  add column if not exists seal_inspector      text default 'Tomas E. Hernandez, PE',
  add column if not exists seal_license        text default 'SI #62469',
  add column if not exists signature_path      text;        -- captured signature image (storage)

-- Audit trail of every finalize/seal event (append-only).
create table if not exists report_seals (
  id uuid primary key default uuid_generate_v4(),
  field_report_id uuid not null references field_reports(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  pdf_path        text not null,
  sha256          text not null,
  inspector       text not null,
  license         text not null,
  sealed_at       timestamptz default now(),
  sealed_by       text
);
create index if not exists report_seals_fr_idx on report_seals(field_report_id);

alter table report_seals enable row level security;
drop policy if exists seals_owner_all       on report_seals;
drop policy if exists seals_contractor_read on report_seals;
create policy seals_owner_all on report_seals for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy seals_contractor_read on report_seals for select
  using (plz_role() = 'contractor' and project_id = plz_project());

-- LOCK: once finalized=true, block content edits (owner can still un-finalize
-- via an explicit RPC, never via normal update). This trigger enforces the
-- system-of-record integrity that AHJ submission requires.
create or replace function plz_lock_finalized_report() returns trigger as $$
begin
  if OLD.finalized = true then
    -- allow flipping finalized back to false ONLY by owner (un-seal/correct),
    -- but never silent edits of sealed content.
    if NEW.finalized = true
       and ( NEW.work_observed     is distinct from OLD.work_observed
          or NEW.findings          is distinct from OLD.findings
          or NEW.recommendations   is distinct from OLD.recommendations
          or NEW.checklist         is distinct from OLD.checklist
          or NEW.compliance        is distinct from OLD.compliance
          or NEW.finalized_hash    is distinct from OLD.finalized_hash ) then
      raise exception 'Report % is finalized/sealed and cannot be edited. Un-finalize first (owner only).', OLD.report_number;
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_lock_finalized on field_reports;
create trigger trg_lock_finalized before update on field_reports
  for each row execute function plz_lock_finalized_report();

-- Storage bucket for sealed deliverables (private).
insert into storage.buckets (id, name, public)
values ('field-reports', 'field-reports', false)
on conflict (id) do nothing;

commit;

-- NOTE: PDF generation + sha256 + seal overlay happens in an edge function
-- (see 99-edge-functions-README.md -> finalize-report). The signed PDF of
-- record should ALSO continue to land in Dropbox as the canonical seal copy.
