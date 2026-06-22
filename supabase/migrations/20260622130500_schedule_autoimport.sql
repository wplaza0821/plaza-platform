-- 20260622_schedule_autoimport.sql
-- Wire up schedule auto-import: contractor uploads -> owner analyzes (analyze-schedule
-- edge fn parses XLSX/CSV/MSP-XML/PDF) -> owner approves -> schedule_tasks materialized
-- into the Gantt.
--
-- The analyze-schedule edge function writes several columns onto schedule_imports that
-- the originally-deployed table is missing. Add them idempotently. Also relax the
-- status check so the full analyze/apply lifecycle is allowed.

alter table public.schedule_imports
  add column if not exists analysis      jsonb,
  add column if not exists task_count    integer,
  add column if not exists source_format text,
  add column if not exists analyzed_by   text,
  add column if not exists error_detail  text;

-- Drop any existing status check constraint(s) on schedule_imports, then add a
-- permissive one covering the full lifecycle.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.schedule_imports'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.schedule_imports drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.schedule_imports
  add constraint schedule_imports_status_chk
  check (status in ('pending','analyzing','analyzed','applied','rejected','failed'));
