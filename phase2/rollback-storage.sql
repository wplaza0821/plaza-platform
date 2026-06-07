-- Rollback for migration-storage.sql — drops the plz_ storage policies + helper.
-- After this, storage.objects falls back to whatever default policies existed
-- (private buckets: only service_role / owner-context can access by default).
begin;
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'plz_%'
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;
drop function if exists plz_project_code();
commit;
