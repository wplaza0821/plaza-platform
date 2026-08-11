-- =====================================================================
-- PLAZACORE PHASE 4-05 — DRAWING VERSION SETS (P1 #7) + PUNCH CLOSEOUT (P1 #8)
-- Re-runnable.
-- =====================================================================
begin;

-- ---------- DRAWING / SHEET VERSION SETS ----------
create table if not exists drawing_sets (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  set_name   text not null,        -- "100% CDs", "Permit Set", "Bulletin 3"
  issue_date date,
  discipline text,
  notes      text,
  created_at timestamptz default now(),
  unique (project_id, set_name)
);
create index if not exists drawing_sets_proj_idx on drawing_sets(project_id);

alter table documents
  add column if not exists set_id uuid references drawing_sets(id);

alter table drawing_sets enable row level security;
drop policy if exists dsets_owner_all       on drawing_sets;
drop policy if exists dsets_contractor_read on drawing_sets;
create policy dsets_owner_all on drawing_sets for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy dsets_contractor_read on drawing_sets for select
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('plans'));

-- AUTO-SUPERSEDE: when a new 'current' document with same sheet_number is added
-- to a project, flip the prior current sheet to 'superseded'.
create or replace function plz_supersede_sheet() returns trigger as $$
begin
  if NEW.sheet_number is not null and NEW.status = 'current' then
    update documents
       set status='superseded'
     where project_id = NEW.project_id
       and sheet_number = NEW.sheet_number
       and id <> NEW.id
       and status='current';
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_supersede_sheet on documents;
create trigger trg_supersede_sheet after insert on documents
  for each row execute function plz_supersede_sheet();

-- ---------- PUNCH LIST CLOSEOUT WORKFLOW (extends deficiencies) ----------
alter table deficiencies
  add column if not exists ball_in_court    text default 'contractor'
       check (ball_in_court in ('contractor','engineer','owner')),
  add column if not exists closeout_photo_id uuid,
  add column if not exists verified_by      text,
  add column if not exists verified_at      timestamptz,
  add column if not exists trade            text;       -- discipline/trade for punch grouping

-- Verify gate: a deficiency can only reach 'verified'/'closed' if a closeout
-- photo is attached (closeout evidence required).
create or replace function plz_punch_closeout_gate() returns trigger as $$
begin
  if NEW.status in ('verified','closed')
     and OLD.status not in ('verified','closed')
     and NEW.closeout_photo_id is null
     and (NEW.photo_ids is null or array_length(NEW.photo_ids,1) is null) then
    raise exception 'Deficiency % cannot be verified/closed without a closeout photo.', coalesce(NEW.deficiency_no, NEW.id::text);
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_punch_closeout on deficiencies;
create trigger trg_punch_closeout before update on deficiencies
  for each row execute function plz_punch_closeout_gate();

commit;
