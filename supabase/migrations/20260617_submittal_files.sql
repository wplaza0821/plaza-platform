-- =====================================================================
-- MIGRATION: submittal_files table + storage bucket
-- Allows contractors to upload PDF data sheets per submittal
-- Created: 2026-06-17
-- =====================================================================

-- Multi-file attachments per submittal (data sheets, shop drawings, samples, etc.)
create table if not exists submittal_files (
  id uuid primary key default uuid_generate_v4(),
  submittal_id uuid not null references submittals(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  file_path text not null,          -- supabase storage path within 'submittals' bucket
  file_name text,
  file_size int,
  file_type text,                   -- 'data_sheet' | 'shop_drawing' | 'sample_certification' | 'other'
  description text,                 -- brief label, e.g. "HILTI ESA-3437 Data Sheet"
  uploaded_by text,
  uploaded_at timestamptz default now()
);

create index if not exists submittal_files_submittal_idx on submittal_files(submittal_id);
create index if not exists submittal_files_project_idx   on submittal_files(project_id);

alter table submittal_files enable row level security;
create policy "anon read submittal_files"   on submittal_files for select using (true);
create policy "anon insert submittal_files" on submittal_files for insert with check (true);
create policy "anon delete submittal_files" on submittal_files for delete using (true);

-- Storage bucket for submittal file uploads
-- NOTE: 'submittals' bucket may already exist from initial schema; this is safe to re-run
insert into storage.buckets (id, name, public)
values ('submittals', 'submittals', false)
on conflict (id) do nothing;

-- Storage RLS: allow anon upload into 'submittals' bucket
-- Path format: {project_code}/{submittal_id}/{timestamp}_{filename}
create policy "anon upload submittals"
  on storage.objects for insert
  with check (bucket_id = 'submittals');

create policy "anon read submittals storage"
  on storage.objects for select
  using (bucket_id = 'submittals');

create policy "anon delete submittals storage"
  on storage.objects for delete
  using (bucket_id = 'submittals');
