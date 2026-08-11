# Plazacore Phase 4 — Procore Gap-Fill Runbook
**Date:** 2026-06-09 · Author: Lola · For: Plaza & Associates

Goal: close the high-value Procore gaps that fit the firm (SI deliverables, billing,
routing, dashboards, drawing control) WITHOUT building GC-scale cost modules.

## Order of operations

### STEP 0 — SECURITY (do first, blocking)
1. Run `00-readonly-security-audit.sql` in the Supabase SQL editor (READ ONLY, safe).
2. Paste the 3 result sets back to Lola.
3. Lola confirms RLS-enabled + no surviving `anon`/`true` policies, especially on
   **`notifications`** and **`profiles`** (NOT in the phase2 drop-list).
4. If any hole is found, Lola ships `90-phase4-rls-fix.sql` (generated after audit).
   **Do not deploy feature migrations 01–06 to prod until the audit is clean.**

### STEP 1 — Feature migrations (run in order, each is transactional + re-runnable)
| File | Module | Tier | Notes |
|---|---|---|---|
| `01-inspection-templates.sql` | FBC/ASTM/ICRI checklist templates + field_reports.checklist | P0 | seeds 3 starter templates |
| `02-sealed-deliverables.sql` | Immutable sealed PDF, hash, lock-after-finalize, audit | P0 | needs `finalize-report` edge fn |
| `03-rfi-submittal-routing.sql` | ball-in-court, assignee, due dates, routing_events, open-items view | P0 | needs `notify-route` edge fn |
| `04-dashboard-rollup.sql` | `plz_dashboard()` RPC | P1 | frontend `supa.rpc('plz_dashboard')` |
| `05-drawing-sets-punch.sql` | drawing version sets + auto-supersede + punch closeout gate | P1 | triggers |
| `06-qb-billing-bridge.sql` | service_invoices ↔ QuickBooks | P1 | needs `qb-billing` edge fn |

All migrations assume the phase2 helpers exist: `plz_is_owner()`, `plz_role()`,
`plz_project()`, `plz_perm(flag)`. They do — confirmed in phase2/migration.sql.

### STEP 2 — Edge functions (deploy separately; see EDGE-FUNCTIONS.md)
- `finalize-report` — render sealed PDF, sha256, write report_seals + Dropbox copy.
- `notify-route` — fan-out in-app + Twilio SMS on RFI/submittal/deficiency events
  (clone of existing `notify-task`; pass `{ref_table, ref_id, event}`).
- `qb-billing` — push monthly service invoices to QuickBooks (mirror monthly_invoicer.py).

### STEP 3 — Frontend (index.html) wiring — quick wins, low risk
- Dashboard: call `plz_dashboard()`, render rollup badges on project list.
- Inspection templates: when creating a field_report, pick a template → render
  checklist from `schema` jsonb → save answers to `checklist`, compute pass/fail/na.
- Routing: on RFI/submittal create or ball-in-court change → invoke `notify-route`.
- Punch: closeout-photo-required UI on deficiencies (trigger enforces server-side too).
- Overdue badges + CSV/PDF export buttons on RFI/submittal/deficiency logs.
- Fix stale README (says localStorage; it's Supabase-backed).

## Deliberately NOT built (out of scope — would be Procore bloat for an SI firm)
- Schedule/Gantt with dependencies
- Budget / Commitments / Direct Costs / Prime Contract ledger
- Meetings/minutes, OSHA incident log, Timesheets/Crews
- Native mobile app / offline sync
Rationale: Plaza bills recurring engineering services, doesn't run GC cost control.
These add maintenance + stale-data risk with no payoff. Revisit only if a GC-side
need actually appears.

## Rollback
Each migration is `begin/commit`. To roll back a feature: drop the new tables/columns
it added (listed at top of each file). No feature migration drops or alters phase2
RLS policies, so security posture is unaffected by feature rollback.
