-- ============================================================
-- Plazacore Phase B Layer 2 — Interactive Tasks RLS
-- Adds staff/member roles to task access; project-wide visibility (option a):
--   owner/staff  -> ALL tasks (read+write, all projects)
--   member       -> read ALL tasks on THEIR project; may UPDATE status on tasks
--                   assigned to them OR that they created; may INSERT on their project
--   contractor   -> (existing) read + update own project; + allow INSERT own project
-- assigned_to stores the assignee profile id (uuid as text) going forward.
-- Re-runnable (drops the policies it manages first). Reuses plz_role/plz_is_owner/plz_project.
-- ============================================================

-- make sure RLS is on (it already is from Phase 2, but idempotent-safe)
alter table tasks enable row level security;

-- ---- AUTO-STAMP created_by on insert ----
-- The member-update policy below keys off created_by = auth.uid()::text, but the
-- app never sets created_by. Stamp it server-side so a member can update tasks
-- they create. Only fills when null (owner/staff inserts via service paths keep theirs).
create or replace function plz_tasks_stamp_created_by() returns trigger as $$
begin
  if new.created_by is null and auth.uid() is not null then
    new.created_by := (auth.uid())::text;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
drop trigger if exists trg_tasks_created_by on tasks;
create trigger trg_tasks_created_by before insert on tasks
  for each row execute function plz_tasks_stamp_created_by();

-- drop the policies we are (re)defining
drop policy if exists tasks_owner_all          on tasks;
drop policy if exists tasks_contractor_read     on tasks;
drop policy if exists tasks_contractor_update    on tasks;
drop policy if exists tasks_staff_all             on tasks;
drop policy if exists tasks_member_read            on tasks;
drop policy if exists tasks_member_insert            on tasks;
drop policy if exists tasks_member_update             on tasks;
drop policy if exists tasks_contractor_insert          on tasks;

-- ---- OWNER: full control, all projects ----
create policy tasks_owner_all on tasks for all
  using (plz_is_owner()) with check (plz_is_owner());

-- ---- STAFF: full control, all projects (internal team) ----
create policy tasks_staff_all on tasks for all
  using (plz_role() = 'staff') with check (plz_role() = 'staff');

-- ---- MEMBER: project-wide read (option a) ----
create policy tasks_member_read on tasks for select
  using (plz_role() = 'member' and project_id = plz_project());
-- member may create tasks on their own project
create policy tasks_member_insert on tasks for insert
  with check (plz_role() = 'member' and project_id = plz_project());
-- member may update tasks on their project that are theirs (assigned or created)
create policy tasks_member_update on tasks for update
  using (plz_role() = 'member' and project_id = plz_project()
         and (assigned_to = (auth.uid())::text or created_by = (auth.uid())::text))
  with check (plz_role() = 'member' and project_id = plz_project());

-- ---- CONTRACTOR: project-wide read + update (existing) + allow insert ----
create policy tasks_contractor_read on tasks for select
  using (plz_role() = 'contractor' and project_id = plz_project());
create policy tasks_contractor_update on tasks for update
  using (plz_role() = 'contractor' and project_id = plz_project())
  with check (plz_role() = 'contractor' and project_id = plz_project());
create policy tasks_contractor_insert on tasks for insert
  with check (plz_role() = 'contractor' and project_id = plz_project());

-- NOTE: anon/none role has NO policy -> sees nothing, cannot write. (Phase 2 closed anon.)
