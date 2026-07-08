-- Enable client-side deletion of pay applications (and their child rows).
--
-- Root cause of "can't delete a rejected pay app": RLS is enabled on pay_apps
-- but there was NO delete policy, so PostgREST silently no-ops the DELETE
-- (returns HTTP 200 / 0 rows). The UI (owner-only for rejected, draft for all)
-- already gates who sees the button; these policies just let the delete through
-- at the DB layer. Child tables get delete policies too (belt-and-suspenders in
-- addition to the on-delete-cascade FKs).

-- pay_apps
drop policy if exists "anon delete pay_apps" on pay_apps;
create policy "anon delete pay_apps" on pay_apps for delete using (true);

-- pay_app_lines
drop policy if exists "anon delete pay_app_lines" on pay_app_lines;
create policy "anon delete pay_app_lines" on pay_app_lines for delete using (true);

-- lien_waivers
drop policy if exists "anon delete lien_waivers" on lien_waivers;
create policy "anon delete lien_waivers" on lien_waivers for delete using (true);

-- pay_app_documents (table created outside tracked migrations; guard existence)
do $$
begin
  if to_regclass('public.pay_app_documents') is not null then
    execute 'alter table pay_app_documents enable row level security';
    execute 'drop policy if exists "anon delete pay_app_documents" on pay_app_documents';
    execute 'create policy "anon delete pay_app_documents" on pay_app_documents for delete using (true)';
    -- ensure read/insert/update too, in case they were never created
    execute 'drop policy if exists "anon read pay_app_documents" on pay_app_documents';
    execute 'create policy "anon read pay_app_documents" on pay_app_documents for select using (true)';
    execute 'drop policy if exists "anon insert pay_app_documents" on pay_app_documents';
    execute 'create policy "anon insert pay_app_documents" on pay_app_documents for insert with check (true)';
    execute 'drop policy if exists "anon update pay_app_documents" on pay_app_documents';
    execute 'create policy "anon update pay_app_documents" on pay_app_documents for update using (true)';
  end if;
end $$;
