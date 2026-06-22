create or replace function public._tmp_rq_policy_audit()
returns table(tbl text, policyname text, cmd text, qual text, withcheck text)
language sql security definer set search_path=public,pg_catalog as $$
  select tablename::text, policyname::text, cmd::text, qual::text, with_check::text
  from pg_policies
  where tablename in ('repair_quantity_items','repair_stacks')
  order by tablename, cmd, policyname;
$$;
