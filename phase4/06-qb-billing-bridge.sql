-- =====================================================================
-- PLAZACORE PHASE 4-06 — QUICKBOOKS RECURRING-BILLING BRIDGE (P1 #5)
-- Plaza bills monthly SI/observation service fees via QuickBooks. This table
-- tracks those service invoices inside Plazacore and links to the QB invoice.
-- The actual QB push uses the existing QB connector (see TOOLS.md) via an
-- edge function. Re-runnable.
-- =====================================================================
begin;

create table if not exists service_invoices (
  id uuid primary key default uuid_generate_v4(),
  project_id    uuid references projects(id) on delete set null,
  period        text not null,                -- '2026-06'
  description   text,
  amount        numeric(14,2) not null default 0,
  qb_invoice_id text,                          -- QuickBooks Invoice.Id
  qb_doc_number text,                          -- QB DocNumber
  status        text default 'draft'
       check (status in ('draft','sent','partially_paid','paid','void')),
  due_on_issue  boolean default true,          -- firm standard: due on receipt
  sent_at       timestamptz,
  paid_at       timestamptz,
  ar_balance    numeric(14,2),                 -- pulled back from QB A/R aging
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (project_id, period)                  -- one service invoice per project per month
);
create index if not exists svc_inv_project_idx on service_invoices(project_id);
create index if not exists svc_inv_status_idx  on service_invoices(status);

alter table service_invoices enable row level security;
drop policy if exists svc_inv_owner_all on service_invoices;
-- Owner-only: billing is never exposed to contractors.
create policy svc_inv_owner_all on service_invoices for all
  using (plz_is_owner()) with check (plz_is_owner());

commit;

-- NOTE: edge function 'qb-billing' (see README) maps the live monthly schedule
-- (data/monthly_billing_schedule.json) -> creates QB invoices via the QB
-- connector and writes qb_invoice_id back here. Mirrors scripts/monthly_invoicer.py
-- logic (due-on-issue, duplicate guard) so the two never double-bill.
-- A/R aging widget reads service_invoices.ar_balance refreshed from QB A/R Aging Detail.
