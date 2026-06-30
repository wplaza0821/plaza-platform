-- 20260630160000_quantity_autoimport.sql
-- Repair-Quantity spreadsheet auto-import (mirrors schedule_autoimport pattern).
--
-- Flow: owner/staff uploads a spreadsheet of field-measured repair quantities to
-- the private `quantity-imports` storage bucket -> a quantity_imports row is
-- created (status 'pending') -> owner clicks Analyze (analyze-quantities edge fn
-- parses XLSX/CSV with AI, normalizes arbitrary column layouts into stack /
-- tower / floor / repair_type / dimensions) -> result stored on
-- quantity_imports.analysis -> owner reviews -> Apply materializes
-- repair_quantity_items (auto-creating any missing repair_stacks) and flips the
-- import to 'applied'. LLM key stays server-side; owner controls the write.

create table if not exists public.quantity_imports (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  file_name     text,
  file_path     text,
  file_size     bigint,
  status        text not null default 'pending',
  analysis      jsonb,
  item_count    integer,
  source_format text,
  uploaded_by   text,
  analyzed_by   text,
  error_detail  text,
  created_at    timestamptz not null default now(),
  analyzed_at   timestamptz,
  applied_at    timestamptz
);

alter table public.quantity_imports
  add constraint quantity_imports_status_chk
  check (status in ('pending','analyzing','analyzed','applied','rejected','failed'));

create index if not exists quantity_imports_project_idx
  on public.quantity_imports(project_id, created_at desc);

-- Tag materialized rows with the import they came from, so a re-apply can
-- cleanly supersede its own previous rows (mirrors schedule_tasks.import_id).
alter table public.repair_quantity_items
  add column if not exists import_id uuid references public.quantity_imports(id) on delete set null;

create index if not exists rqi_import_idx
  on public.repair_quantity_items(import_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.quantity_imports enable row level security;

-- Owner/staff (custom owner token OR profiles.app_role in owner/staff) full access;
-- contractors/members scoped to their project for read. Mirrors the project's
-- existing helper predicates used elsewhere (auth.jwt() claims).
do $$
begin
  -- read: any authenticated user on their active project (owner/staff see all of theirs)
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quantity_imports' and policyname='qi_select') then
    create policy qi_select on public.quantity_imports
      for select using (
        coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff')
        or project_id = nullif(auth.jwt() ->> 'project_id','')::uuid
      );
  end if;
  -- insert: owner/staff only
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quantity_imports' and policyname='qi_insert') then
    create policy qi_insert on public.quantity_imports
      for insert with check (
        coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff')
      );
  end if;
  -- update: owner/staff only
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quantity_imports' and policyname='qi_update') then
    create policy qi_update on public.quantity_imports
      for update using (
        coalesce((auth.jwt() ->> 'user_role'), '') in ('owner','staff')
      );
  end if;
  -- delete: owner only
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quantity_imports' and policyname='qi_delete') then
    create policy qi_delete on public.quantity_imports
      for delete using (
        coalesce((auth.jwt() ->> 'user_role'), '') = 'owner'
      );
  end if;
end $$;

comment on table public.quantity_imports is
  'Spreadsheet imports of field repair quantities. analyze-quantities edge fn parses + AI-normalizes; owner reviews then applies into repair_quantity_items (auto-creating missing repair_stacks).';
