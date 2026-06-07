-- ============================================================
-- Plazacore — Plan Markups (redlining) table + JWT-scoped RLS
-- Phase 2 pattern: owner full access; contractor scoped to own project.
-- Safe to run multiple times (idempotent-ish: drops policies first).
-- ============================================================

create table if not exists plan_markups (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  page_number int  not null default 1,          -- 1-based PDF page
  shapes      jsonb not null default '[]'::jsonb, -- array of {type,points,color,width,text,...}
  created_by  text,                              -- AUTH.name
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (document_id, page_number)              -- one markup layer per doc page
);

create index if not exists plan_markups_doc_idx  on plan_markups(document_id);
create index if not exists plan_markups_proj_idx on plan_markups(project_id);

alter table plan_markups enable row level security;

-- Clean slate on policies (re-runnable)
drop policy if exists markups_owner_all          on plan_markups;
drop policy if exists markups_contractor_read     on plan_markups;
drop policy if exists markups_contractor_insert   on plan_markups;
drop policy if exists markups_contractor_update   on plan_markups;
drop policy if exists markups_anon_all            on plan_markups;

-- Owner: full access
create policy markups_owner_all on plan_markups for all
  using (plz_is_owner()) with check (plz_is_owner());

-- Contractor: read markups on their own project (requires 'plans' perm)
create policy markups_contractor_read on plan_markups for select
  using (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('plans'));

-- Contractor: create markups on their own project's plans
create policy markups_contractor_insert on plan_markups for insert
  with check (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('plans'));

-- Contractor: update markups on their own project's plans
create policy markups_contractor_update on plan_markups for update
  using  (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('plans'))
  with check (plz_role() = 'contractor' and project_id = plz_project() and plz_perm('plans'));

-- NOTE: no contractor DELETE policy on purpose — owner-only deletes (audit trail).

-- keep updated_at fresh
create or replace function plz_touch_markup() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_touch_markup on plan_markups;
create trigger trg_touch_markup before update on plan_markups
  for each row execute function plz_touch_markup();
