-- Phase 6 · Keep legacy single-project writes in sync with project_members.
-- invite-user and manage-user(set_role) still set profiles.project_id. This
-- trigger mirrors any non-null project_id into project_members so those paths
-- automatically grant membership without code changes to the edge functions.
-- (Removing a project is done via the Projects modal -> project_members directly;
--  we do NOT auto-delete here, so multi-project users keep their other projects
--  even if profiles.project_id is later changed.)

create or replace function plz_sync_primary_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.project_id is not null then
    insert into project_members (user_id, project_id)
      values (NEW.id, NEW.project_id)
    on conflict do nothing;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_primary_project on profiles;
create trigger trg_sync_primary_project
  after insert or update of project_id on profiles
  for each row execute function plz_sync_primary_project();
