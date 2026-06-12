-- ============================================================
-- plz_open_action_items v2
--   + adds `tasks` to the open-action-item universe (4th module)
--   + exposes `created_at` so reminders can fire on "pending >24h"
--     (Procore-style aging), not just on due_date.
-- Idempotent: DROP + CREATE (column order changes, so REPLACE won't work).
-- ============================================================
drop view if exists plz_open_action_items;
create view plz_open_action_items as
  select 'rfi'::text as kind, r.id, r.project_id,
         r.rfi_number::text as ref_no, r.subject as title,
         r.ball_in_court, r.assigned_to, r.due_date, r.status, r.created_at,
         (r.due_date is not null and r.due_date < current_date and r.status = 'open') as overdue
    from rfis r
   where r.status = any (array['open','answered'])
  union all
  select 'submittal'::text, s.id, s.project_id,
         s.submittal_number as ref_no, coalesce(s.description, s.spec_section) as title,
         s.ball_in_court, s.assigned_to, s.due_date, s.status, s.created_at,
         (s.due_date is not null and s.due_date < current_date and s.status = 'pending') as overdue
    from submittals s
   where s.status = any (array['pending','revise_resubmit'])
  union all
  select 'deficiency'::text, d.id, d.project_id,
         coalesce(d.deficiency_no,'') as ref_no, d.description as title,
         d.responsible_party as ball_in_court, d.responsible_party as assigned_to,
         d.due_date, d.status, d.created_at,
         (d.due_date is not null and d.due_date < current_date and d.status = any (array['open','in_repair'])) as overdue
    from deficiencies d
   where d.status = any (array['open','in_repair'])
  union all
  select 'task'::text, t.id, t.project_id,
         null::text as ref_no, t.title,
         t.assigned_role as ball_in_court, t.assigned_to,
         t.due_date, t.status, t.created_at,
         (t.due_date is not null and t.due_date < current_date and t.status = any (array['open','in_progress','review'])) as overdue
    from tasks t
   where t.status = any (array['open','in_progress','review']);
