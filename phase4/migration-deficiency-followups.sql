-- ============================================================
-- Plazacore — Deficiency Follow-up Tracking
-- Ensures every deficiency is addressed and followed up on.
-- Safe / idempotent: re-runnable.
-- ============================================================

-- 1. Scheduling column on the deficiency itself: when is the next
--    follow-up due? NULL on an open item == "needs to be scheduled".
alter table deficiencies
  add column if not exists next_follow_up_date date;

create index if not exists deficiencies_next_follow_up_idx
  on deficiencies(next_follow_up_date);

-- 2. Threaded follow-up log — one row per check-in / chase / action.
create table if not exists deficiency_followups (
  id uuid primary key default uuid_generate_v4(),
  deficiency_id uuid not null references deficiencies(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  action text default 'note' check (action in ('note','contacted','reinspected','escalated','scheduled','resolved')),
  note text,
  status_at_time text,            -- snapshot of deficiency status when logged
  next_follow_up_date date,       -- what this entry scheduled (if any)
  created_by text default 'owner',
  created_at timestamptz default now()
);

create index if not exists deficiency_followups_def_idx
  on deficiency_followups(deficiency_id);
create index if not exists deficiency_followups_project_idx
  on deficiency_followups(project_id);

alter table deficiency_followups enable row level security;

drop policy if exists "anon read deficiency_followups"   on deficiency_followups;
drop policy if exists "anon insert deficiency_followups" on deficiency_followups;
drop policy if exists "anon update deficiency_followups" on deficiency_followups;
drop policy if exists "anon delete deficiency_followups" on deficiency_followups;

create policy "anon read deficiency_followups"   on deficiency_followups for select using (true);
create policy "anon insert deficiency_followups" on deficiency_followups for insert with check (true);
create policy "anon update deficiency_followups" on deficiency_followups for update using (true);
create policy "anon delete deficiency_followups" on deficiency_followups for delete using (true);
