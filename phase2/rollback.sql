-- =====================================================================
-- PLAZACORE PHASE 2 — ROLLBACK
-- Instantly restores the permissive (Phase 1) policies. Use ONLY if the
-- cutover breaks the live app and you need to recover immediately.
-- After running this, the DB is wide-open again (Phase 1 state) — re-secure ASAP.
-- =====================================================================

begin;

-- Drop Phase 2 policies + helper functions.
do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in (
        'projects','contractors','sov_items','pay_apps','pay_app_lines',
        'lien_waivers','rfis','submittals','change_orders','documents',
        'tasks','photos','field_reports','deficiencies','daily_reports','milestones')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

drop function if exists plz_perm(text);
drop function if exists plz_is_owner();
drop function if exists plz_project();
drop function if exists plz_role();

-- Restore Phase 1 permissive policies (read + write for all listed tables).
do $$
declare t text;
begin
  foreach t in array array[
    'projects','contractors','sov_items','pay_apps','pay_app_lines',
    'lien_waivers','rfis','submittals','change_orders','documents',
    'tasks','photos','field_reports','deficiencies','daily_reports','milestones']
  loop
    execute format('create policy %I on public.%I for select using (true)', 'anon read '||t, t);
    execute format('create policy %I on public.%I for insert with check (true)', 'anon insert '||t, t);
    execute format('create policy %I on public.%I for update using (true)', 'anon update '||t, t);
  end loop;
  -- delete policies that existed in Phase 1
  foreach t in array array['sov_items','tasks','photos','deficiencies','daily_reports','milestones']
  loop
    execute format('create policy %I on public.%I for delete using (true)', 'anon delete '||t, t);
  end loop;
end $$;

commit;
