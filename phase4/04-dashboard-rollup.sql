-- =====================================================================
-- PLAZACORE PHASE 4-04 — CROSS-PROJECT DASHBOARD ROLLUP (P1 #6)
-- Single RPC the SPA calls once to render the home dashboard. Owner-scoped.
-- Re-runnable.
-- =====================================================================
begin;

create or replace function plz_dashboard()
returns table (
  project_id        uuid,
  project_code      text,
  project_name      text,
  project_status    text,
  open_rfis         bigint,
  overdue_rfis      bigint,
  pending_submittals bigint,
  open_deficiencies bigint,
  critical_defs     bigint,
  open_tasks        bigint,
  reports_this_month bigint,
  last_payapp_status text,
  contract_value    numeric
)
language sql stable
security invoker      -- runs under caller's RLS; owner sees all, contractor sees own
as $$
  select
    p.id, p.code, p.name, p.status,
    (select count(*) from rfis r where r.project_id=p.id and r.status='open'),
    (select count(*) from rfis r where r.project_id=p.id and r.status='open'
        and r.due_date is not null and r.due_date < current_date),
    (select count(*) from submittals s where s.project_id=p.id and s.status='pending'),
    (select count(*) from deficiencies d where d.project_id=p.id and d.status in ('open','in_repair')),
    (select count(*) from deficiencies d where d.project_id=p.id and d.status in ('open','in_repair') and d.severity='critical'),
    (select count(*) from tasks t where t.project_id=p.id and t.status in ('open','in_progress','review')),
    (select count(*) from field_reports f where f.project_id=p.id
        and f.visit_date >= date_trunc('month', current_date)),
    (select pa.status from pay_apps pa where pa.project_id=p.id
        order by pa.pay_app_number desc limit 1),
    p.contract_value
  from projects p
  where p.status <> 'archived'
  order by p.code;
$$;

commit;

-- Frontend: const { data } = await supa.rpc('plz_dashboard');
-- Render one row per project with the rollup badges already styled in renderProjects.
