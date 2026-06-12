-- Phase 6 · Many-projects-per-user (membership model).
-- Replaces the single profiles.project_id scoping with a project_members table
-- so staff/contractors/members can be on multiple projects from ONE invite.
--
-- plz_has_project(p) reads membership DIRECTLY (SECURITY DEFINER) so assignments
-- take effect instantly with no JWT refresh. Role + perms stay on the profile
-- (same role across a user's projects), which matches "don't invite them twice".

create table if not exists project_members (
  user_id    uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id)
);
create index if not exists idx_project_members_user    on project_members(user_id);
create index if not exists idx_project_members_project on project_members(project_id);

-- Backfill from the existing single-project assignment.
insert into project_members (user_id, project_id)
  select id, project_id from profiles
   where project_id is not null
on conflict do nothing;

-- Membership test used by RLS. Owner sees all; otherwise must be a member.
-- SECURITY DEFINER + reads the table directly -> instant, no token dependency.
create or replace function plz_has_project(p uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select plz_is_owner()
      or exists (
        select 1 from project_members m
         where m.user_id = auth.uid() and m.project_id = p
      )
$$;

-- RLS on the membership table itself.
alter table project_members enable row level security;
drop policy if exists pm_owner_all on project_members;
create policy pm_owner_all on project_members for all using (plz_is_owner()) with check (plz_is_owner());
drop policy if exists pm_self_read on project_members;
create policy pm_self_read on project_members for select using (user_id = auth.uid());
