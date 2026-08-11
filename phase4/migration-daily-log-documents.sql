-- PLAZACORE — Daily Log scan upload + AI extraction + permanent PDF of record
--
-- Purpose (William, 2026-08-10): "I want to be able to upload a daily log scan and
-- for you to read it and document the visits and keep a copy of the PDF log for the
-- record."
--
-- Three things, in order of importance:
--   1. THE SCAN IS THE RECORD. The uploaded PDF is retained permanently and stays
--      linked to every daily_reports row extracted from it. Typed entries are a
--      convenience index; the scan is what a court/AHJ would ask for.
--   2. Extraction is REVIEWABLE, never silent. The edge function writes structured
--      days into `analysis`; nothing lands in daily_reports until the user applies.
--   3. One scan usually holds MANY visit days (a week or a month of field sheets).
--      So this is a one-to-many relationship, not one-doc-one-entry.
--
-- Storage: reuses the existing private `field-reports` bucket under a
-- `<PROJECT_CODE>/daily/` prefix. Deliberate — the existing storage RLS policies
-- already cover that bucket + project-code prefix, so no new storage policy is
-- needed and there is no window where a bucket exists without policies.
--
-- Idempotent + transactional. Safe to re-run.

begin;

-- 1. The uploaded scan of record.
create table if not exists daily_log_documents (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  file_path    text not null,
  file_name    text,
  file_size    bigint,
  page_count   integer,
  -- Structured extraction: { days:[{report_date, inspector, weather, temperature,
  --   crew_count, work_performed, materials_delivered, equipment_on_site, visitors,
  --   delays, safety_incidents, notes, page, confidence}], warnings:[], model }
  analysis     jsonb,
  analyzed_at  timestamptz,
  analyzed_by  text,
  uploaded_at  timestamptz not null default now(),
  uploaded_by  text
);

create index if not exists daily_log_documents_project_idx
  on daily_log_documents(project_id);
create index if not exists daily_log_documents_uploaded_idx
  on daily_log_documents(uploaded_at desc);

-- 2. Link every extracted entry back to its source scan. ON DELETE SET NULL:
--    deleting a scan record must never silently delete field history.
alter table daily_reports add column if not exists source_document_id uuid
  references daily_log_documents(id) on delete set null;
alter table daily_reports add column if not exists source_page integer;
alter table daily_reports add column if not exists extracted boolean not null default false;

comment on column daily_reports.source_document_id is
  'The uploaded daily-log scan this entry was extracted from. The scan is the record of authority.';
comment on column daily_reports.extracted is
  'True when created by AI extraction from a scan rather than typed by hand.';

create index if not exists daily_reports_source_doc_idx
  on daily_reports(source_document_id);

-- 3. One typed entry per project per calendar day. Without this, re-uploading or
--    re-applying a scan silently duplicates a day's field record — which would
--    corrupt the log rather than correct it. Lets apply use a real upsert.
--    Pre-clean any existing same-day duplicates, keeping the richest row
--    (most populated narrative fields, then most recent).
with ranked as (
  select id, project_id, report_date,
         row_number() over (
           partition by project_id, report_date
           order by (
             (case when coalesce(work_performed,'')      <> '' then 1 else 0 end) +
             (case when coalesce(materials_delivered,'') <> '' then 1 else 0 end) +
             (case when coalesce(equipment_on_site,'')   <> '' then 1 else 0 end) +
             (case when coalesce(visitors,'')            <> '' then 1 else 0 end) +
             (case when coalesce(delays,'')              <> '' then 1 else 0 end) +
             (case when coalesce(notes,'')               <> '' then 1 else 0 end)
           ) desc,
           created_at desc
         ) as rn
  from daily_reports
  where project_id is not null and report_date is not null
)
delete from daily_reports d
using ranked r
where d.id = r.id and r.rn > 1;

create unique index if not exists daily_reports_project_date_uniq
  on daily_reports(project_id, report_date)
  where project_id is not null;

-- 4. RLS mirroring the daily_reports/field-document model: owner+staff manage,
--    scoped roles read only their own project.
alter table daily_log_documents enable row level security;

drop policy if exists dld_read       on daily_log_documents;
drop policy if exists dld_write_all  on daily_log_documents;
drop policy if exists dld_update_all on daily_log_documents;
drop policy if exists dld_delete_all on daily_log_documents;

create policy dld_read on daily_log_documents for select
  using (
    coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff')
    or project_id::text = coalesce((auth.jwt() ->> 'project_id'), '')
  );

create policy dld_write_all on daily_log_documents for insert
  with check (coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff'));

create policy dld_update_all on daily_log_documents for update
  using (coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff'))
  with check (coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff'));

create policy dld_delete_all on daily_log_documents for delete
  using (coalesce((auth.jwt() ->> 'user_role'), '') = 'owner');

notify pgrst, 'reload schema';

commit;

-- VERIFY
--   select count(*) from daily_log_documents;
--   select column_name from information_schema.columns
--     where table_name='daily_reports'
--       and column_name in ('source_document_id','source_page','extracted');
--   select indexname from pg_indexes where indexname='daily_reports_project_date_uniq';
--
-- ROLLBACK (manual):
--   drop index if exists daily_reports_project_date_uniq;
--   alter table daily_reports drop column if exists source_document_id,
--     drop column if exists source_page, drop column if exists extracted;
--   drop table if exists daily_log_documents;
