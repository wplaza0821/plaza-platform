-- PM + Client recipients per project, + enable pg_net for DB-trigger HTTP calls.
create extension if not exists pg_net with schema extensions;

alter table projects add column if not exists pm_id uuid references profiles(id);
alter table projects add column if not exists client_id uuid references profiles(id);

-- Terrazas: PM = William (owner), Client = Edwin De La Hoz (gm@trpvillage.com, member)
update projects
   set pm_id     = '9935ace3-1864-41b1-b3bf-3f082f40c585',
       client_id = 'cfd1f452-5068-4fb6-b595-9b7c21a8a7f3'
 where id = '7326b0b7-2e32-4e61-bf76-89f88b4f74f0';
