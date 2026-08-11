-- =====================================================================
-- PLAZACORE PHASE 4 — READ-ONLY SECURITY AUDIT
-- Safe: SELECT-only. No writes, no DDL. Run in Supabase SQL editor.
-- Paste the three result sets back to Lola.
-- =====================================================================

-- (1) Is RLS actually ENABLED on every public table?
--     relrowsecurity=false means policies are IGNORED -> table is wide open.
select
  c.relname                          as table_name,
  c.relrowsecurity                   as rls_enabled,
  c.relforcerowsecurity              as rls_forced,
  (select count(*) from pg_policies p
     where p.schemaname='public' and p.tablename=c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relkind='r'
order by c.relrowsecurity asc, c.relname;   -- false (danger) floats to top

-- (2) Any surviving permissive / anon policies (the Phase-1 leftovers)?
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname='public'
  and (
        qual       ilike '%true%'
     or with_check  ilike '%true%'
     or 'anon' = any(roles)
     or policyname ilike '%anon%'
  )
order by tablename, policyname;

-- (3) Storage bucket policies (sealed reports + photos live here).
select id as bucket_id, name, public
from storage.buckets
order by id;

select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname='storage' and tablename='objects'
order by policyname;
