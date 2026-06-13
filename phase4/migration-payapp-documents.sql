-- PLAZACORE — Pay App supporting documents (e.g. formal Change Order PDF)
-- Lets a contractor attach the executed/formal change-order document (or other
-- backup) directly to a pay application, alongside the required lien waiver.
-- Files live in the existing private 'change-orders' storage bucket (contractor
-- insert is already allowed there within their project-code folder).
--
-- RLS mirrors lien_waivers exactly: owner full; contractor read+insert scoped
-- through the parent pay_app; member insert; staff read. Idempotent + transactional.

begin;

create table if not exists pay_app_documents (
  id uuid primary key default uuid_generate_v4(),
  pay_app_id uuid references pay_apps(id) on delete cascade,
  doc_type text not null default 'change_order'
    check (doc_type in ('change_order','backup','correspondence','other')),
  co_number int,                            -- optional: links to a CO number
  file_path text not null,                  -- storage path in 'change-orders' bucket
  file_name text,
  file_size bigint,
  uploaded_at timestamptz default now(),
  uploaded_by text
);

create index if not exists pay_app_documents_payapp_idx on pay_app_documents(pay_app_id);

alter table pay_app_documents enable row level security;

-- ---------- OWNER: full ----------
drop policy if exists pad_owner_all on pay_app_documents;
create policy pad_owner_all on pay_app_documents for all
  using (plz_is_owner()) with check (plz_is_owner());

-- ---------- CONTRACTOR: read + insert (scoped via parent pay_app, gated on payapps) ----------
drop policy if exists pad_contractor_read on pay_app_documents;
create policy pad_contractor_read on pay_app_documents for select
  using (plz_role() = 'contractor' and exists (
            select 1 from pay_apps p
            where p.id = pay_app_documents.pay_app_id and p.project_id = plz_project()));

drop policy if exists pad_contractor_write on pay_app_documents;
create policy pad_contractor_write on pay_app_documents for insert
  with check (plz_role() = 'contractor' and plz_perm('payapps') and exists (
            select 1 from pay_apps p
            where p.id = pay_app_documents.pay_app_id and p.project_id = plz_project()));

-- ---------- MEMBER (internal staff): read + insert, scoped via parent pay_app ----------
drop policy if exists pad_member_read on pay_app_documents;
create policy pad_member_read on pay_app_documents for select
  using (plz_role() = 'member' and exists (
            select 1 from pay_apps p
            where p.id = pay_app_documents.pay_app_id and p.project_id = plz_project()));

drop policy if exists pad_member_write on pay_app_documents;
create policy pad_member_write on pay_app_documents for insert
  with check (plz_role() = 'member' and exists (
            select 1 from pay_apps p
            where p.id = pay_app_documents.pay_app_id and p.project_id = plz_project()));

-- ---------- STAFF: read across their assigned projects ----------
drop policy if exists pad_staff_read on pay_app_documents;
create policy pad_staff_read on pay_app_documents for select
  using (plz_role() = 'staff' and exists (
            select 1 from pay_apps p
            where p.id = pay_app_documents.pay_app_id and p.project_id = plz_project()));

commit;

-- ROLLBACK (manual): drop table pay_app_documents cascade;
