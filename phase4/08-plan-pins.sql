-- =====================================================================
-- PLAZACORE PHASE 4-08 — PLAN PINS (Fieldwire-style sheet markers)
-- A pin is a point on a plan sheet (document + page, normalized 0..1 x/y)
-- that links to a real entity (deficiency / rfi / task / photo) OR is a
-- standalone note. This is what turns the plan viewer into a field tool:
-- walk the building, drop a pin where the problem is, and it becomes a
-- tracked item anchored to the drawing.
-- Re-runnable. RLS mirrors plan_markups (owner all; contractor sees own
-- project; members read).
-- =====================================================================
begin;

create table if not exists plan_pins (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  project_id  uuid not null references projects(id)  on delete cascade,
  page_number int  not null default 1,
  -- normalized position on the page (0..1) so it survives any zoom/scale
  nx          double precision not null,
  ny          double precision not null,
  -- what the pin represents
  ref_table   text,            -- 'deficiencies' | 'rfis' | 'tasks' | 'photos' | null (note-only)
  ref_id      uuid,            -- the linked entity row (nullable for note-only)
  label       text,            -- short caption shown on hover / fallback
  kind        text not null default 'note'
                check (kind in ('deficiency','rfi','task','photo','note')),
  color       text default '#e11d48',
  status      text default 'open',   -- denormalized for quick color-coding (open/closed/answered…)
  created_by  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists plan_pins_doc_idx     on plan_pins(document_id, page_number);
create index if not exists plan_pins_project_idx on plan_pins(project_id);
create index if not exists plan_pins_ref_idx     on plan_pins(ref_table, ref_id);

-- keep updated_at fresh
create or replace function plz_touch_plan_pin()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists plan_pins_touch on plan_pins;
create trigger plan_pins_touch before update on plan_pins
  for each row execute function plz_touch_plan_pin();

alter table plan_pins enable row level security;
drop policy if exists plan_pins_owner_all     on plan_pins;
drop policy if exists plan_pins_member_read    on plan_pins;
drop policy if exists plan_pins_contractor_rw  on plan_pins;
-- Owner/staff: full control.
create policy plan_pins_owner_all on plan_pins for all
  using (plz_is_owner() or plz_role() = 'staff')
  with check (plz_is_owner() or plz_role() = 'staff');
-- Members: read-only across their visible projects.
create policy plan_pins_member_read on plan_pins for select
  using (plz_role() = 'member');
-- Contractors: read + write within their assigned project (so field crews
-- can drop deficiency/photo pins on their own job).
create policy plan_pins_contractor_rw on plan_pins for all
  using (plz_role() = 'contractor' and project_id = plz_project())
  with check (plz_role() = 'contractor' and project_id = plz_project());

commit;

-- Frontend:
--   load:   sb.from('plan_pins').select('*').eq('document_id', doc.id)
--   create: sb.from('plan_pins').insert({document_id, project_id, page_number, nx, ny, kind, ref_table, ref_id, label, color, status, created_by})
--   move:   sb.from('plan_pins').update({nx, ny}).eq('id', pinId)
--   delete: sb.from('plan_pins').delete().eq('id', pinId)
-- Pins render as absolutely-positioned HTML markers over the pv canvas wrap,
-- colored by status, click -> open the linked entity (deficiency/rfi/task) or photo.
