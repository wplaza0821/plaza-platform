-- =====================================================================
-- PLAZACORE PHASE 4-03 — RFI / SUBMITTAL ROUTING + NOTIFICATION LOOP
-- P0 #4. Reuse the proven notify-task fan-out (in-app + Twilio SMS) on
-- ball-in-court changes and due-date reminders. Adds the workflow plumbing.
-- Re-runnable.
-- =====================================================================
begin;

-- RFIs: add ball-in-court + assignee so routing has a target.
alter table rfis
  add column if not exists ball_in_court text default 'engineer'
       check (ball_in_court in ('contractor','engineer','owner','architect')),
  add column if not exists assigned_to   text,            -- profile id / contact
  add column if not exists distribution  text[],          -- cc list
  add column if not exists last_notified_at timestamptz;

-- Submittals already have ball_in_court + reviewer; add assignee + dates.
alter table submittals
  add column if not exists assigned_to   text,
  add column if not exists due_date      date,
  add column if not exists distribution  text[],
  add column if not exists last_notified_at timestamptz;

-- Generic routing-event log so notify fan-out has an audit trail and the
-- reminder cron knows what was already sent.
create table if not exists routing_events (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  ref_table  text not null,        -- 'rfis' | 'submittals' | 'deficiencies'
  ref_id     uuid not null,
  event      text not null,        -- 'created' | 'ball_in_court_change' | 'due_reminder' | 'overdue'
  to_party   text,
  channel    text,                 -- 'in_app' | 'sms' | 'email'
  payload    jsonb,
  created_at timestamptz default now()
);
create index if not exists routing_events_ref_idx on routing_events(ref_table, ref_id);

alter table routing_events enable row level security;
drop policy if exists routing_owner_all       on routing_events;
drop policy if exists routing_contractor_read on routing_events;
create policy routing_owner_all on routing_events for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy routing_contractor_read on routing_events for select
  using (plz_role() = 'contractor' and project_id = plz_project());

-- Helper view: everything currently open + overdue, for the reminder cron
-- and the dashboard. Owner-scoped via RLS on underlying tables.
create or replace view plz_open_action_items as
  select 'rfi'::text as kind, id, project_id, rfi_number::text as ref_no, subject as title,
         ball_in_court, assigned_to, due_date, status,
         (due_date is not null and due_date < current_date and status='open') as overdue
    from rfis where status in ('open','answered')
  union all
  select 'submittal', id, project_id, submittal_number, coalesce(description,spec_section),
         ball_in_court, assigned_to, due_date, status,
         (due_date is not null and due_date < current_date and status='pending') as overdue
    from submittals where status in ('pending','revise_resubmit')
  union all
  select 'deficiency', id, project_id, coalesce(deficiency_no,''), description,
         responsible_party, responsible_party, due_date, status,
         (due_date is not null and due_date < current_date and status in ('open','in_repair')) as overdue
    from deficiencies where status in ('open','in_repair');

commit;

-- NOTE: the edge function 'notify-route' (see README) is invoked by the
-- frontend on create / ball_in_court change, and by a daily cron for
-- due/overdue reminders. It writes a notifications row (existing table) and
-- calls Twilio exactly like notify-task. Pass {ref_table, ref_id, event}.
