-- Re-issue pay-app delete policies with EXPLICIT role targeting.
-- The prior migration created delete policies with the default (to public) but
-- anon deletes still no-op'd on this project. Target anon + authenticated
-- explicitly to match how the other working delete policies behave under the
-- new Supabase publishable-key role mapping.

drop policy if exists "anon delete pay_apps" on pay_apps;
create policy "anon delete pay_apps" on pay_apps
  for delete to anon, authenticated using (true);

drop policy if exists "anon delete pay_app_lines" on pay_app_lines;
create policy "anon delete pay_app_lines" on pay_app_lines
  for delete to anon, authenticated using (true);

drop policy if exists "anon delete lien_waivers" on lien_waivers;
create policy "anon delete lien_waivers" on lien_waivers
  for delete to anon, authenticated using (true);

do $$
begin
  if to_regclass('public.pay_app_documents') is not null then
    execute 'drop policy if exists "anon delete pay_app_documents" on pay_app_documents';
    execute 'create policy "anon delete pay_app_documents" on pay_app_documents for delete to anon, authenticated using (true)';
  end if;
end $$;
