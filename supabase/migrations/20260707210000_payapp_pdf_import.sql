-- Pay App PDF import (AI-assisted G702/G703 extraction)
-- 1. Allow doc_type 'pay_application' on pay_app_documents (contractor uploads
--    their formal pay application PDF; the analyze-payapp edge fn reads it).
-- 2. Add analysis columns to pay_app_documents so the extraction result is
--    persisted next to the document it came from (mirrors change_orders.analysis).

alter table pay_app_documents
  drop constraint if exists pay_app_documents_doc_type_check;

alter table pay_app_documents
  add constraint pay_app_documents_doc_type_check
  check (doc_type in ('change_order','backup','correspondence','other','pay_application'));

alter table pay_app_documents
  add column if not exists analysis    jsonb,
  add column if not exists analyzed_at timestamptz,
  add column if not exists analyzed_by text;

-- 3. Ensure pay_app_documents.pay_app_id cascades on pay-app delete (the table
--    was created outside tracked migrations; guarantee cascade so deleting a
--    rejected/draft pay app cleanly removes its document rows).
do $$
declare
  con text;
begin
  select conname into con
    from pg_constraint
   where conrelid = 'pay_app_documents'::regclass
     and contype = 'f'
     and confrelid = 'pay_apps'::regclass;
  if con is not null then
    execute format('alter table pay_app_documents drop constraint %I', con);
  end if;
  alter table pay_app_documents
    add constraint pay_app_documents_pay_app_id_fkey
    foreign key (pay_app_id) references pay_apps(id) on delete cascade;
exception when others then
  -- non-fatal: if the column/table shape differs, skip silently
  null;
end $$;
