# Plazacore Phase 4 — Edge Functions

Three Deno edge functions, all cloned from the proven `notify-task` pattern
(service-role admin client, caller-JWT validation, CORS locked to prod origin,
best-effort Twilio, no secrets logged/returned).

Copy each folder into the repo's `supabase/functions/` and deploy.

## 1. notify-route  (P0 — routing/notification loop)
Generalized fan-out for RFIs / Submittals / Deficiencies. In-app bell + Twilio SMS.
- Invoked by the app on create / ball-in-court change: `{ ref_table, ref_id, event:"created"|"ball_in_court_change" }`
- Invoked by a daily cron for due/overdue reminders (de-dupes within 20h).
- Reuses the existing `notifications` table + Twilio secrets. No new secrets.
```
supabase functions deploy notify-route --no-verify-jwt
```
Daily reminder cron (Supabase scheduled function or host cron) iterates
`plz_open_action_items where overdue` and calls notify-route per row.

## 2. finalize-report  (P0 — sealed deliverable)
OWNER ONLY. Renders the report HTML server-side, hashes the bytes (sha256),
stores in private `field-reports` bucket, writes append-only `report_seals`,
flips `field_reports.finalized=true` (DB trigger then locks content edits).
- Optional secret `PDF_RENDER_URL`: an HTML→PDF endpoint (e.g. a small
  Browserless/Gotenberg instance) that takes `{html}` and returns PDF bytes.
  If unset, it seals the HTML + hash (still immutable) and a later worker can
  rasterize. Set this before treating the in-app artifact as AHJ-final.
- Keep writing the sealed file to Dropbox via the existing sync so Dropbox
  remains canonical seal-of-record.
```
supabase functions deploy finalize-report --no-verify-jwt
# optional:
supabase secrets set PDF_RENDER_URL="https://<your-pdf-renderer>/pdf"
```

## 3. qb-billing  (P1 — QuickBooks bridge)
OWNER ONLY. In-app side of recurring billing: queue/mark service_invoices.
- QB OAuth/connector creds stay on the HOST (per TOOLS.md) — NOT in an edge
  secret. The host step (monthly_invoicer.py or a thin companion) does the
  actual QB create/send + A/R pull, then calls this fn `mark_sent`/`mark_paid`
  with the returned `qb_invoice_id` / `ar_balance`.
- Duplicate guard: one invoice per project per period (mirrors monthly_invoicer).
```
supabase functions deploy qb-billing --no-verify-jwt
```

## Security notes
- All three reject anon; require a valid app JWT. finalize-report + qb-billing
  additionally require owner (claim `user_role=owner`, with profiles fallback).
- Twilio creds + QB creds are read only from env/host, never logged or returned.
- ⚠️ Per TOOLS.md the Twilio auth token was exposed in chat 2026-06-07 — confirm
  it was rotated before relying on expanded SMS fan-out.
