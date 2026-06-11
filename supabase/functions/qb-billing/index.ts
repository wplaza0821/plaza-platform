// Supabase Edge Function: qb-billing
// Phase 4 · Bridges Plazacore service_invoices -> QuickBooks. OWNER ONLY.
//
// IMPORTANT: This function does NOT embed QuickBooks OAuth/connector logic.
// Plaza's QB integration runs through the `one` CLI connector on the host
// (see TOOLS.md), and the canonical monthly run is scripts/monthly_invoicer.py.
// This edge function's job is the lightweight, in-app side:
//   - record/queue a service invoice row (status=draft)
//   - mark a row as sent/paid and store qb_invoice_id / ar_balance returned by
//     the host-side QB step
// The actual QB create/send + A/R pull is performed by the host (monthly_invoicer
// or a thin companion script) which then POSTs results back here with the
// service role, OR the app writes directly via owner RLS. Keeping QB creds on
// the host (never in an edge secret) preserves the existing security model.
//
// Deploy:  supabase functions deploy qb-billing --no-verify-jwt
//
// Request (POST JSON), owner JWT in Authorization header:
//   { "action": "queue", "project_id": "<uuid>", "period": "2026-06", "amount": 3000, "description": "..." }
//   { "action": "mark_sent", "id": "<uuid>", "qb_invoice_id": "...", "qb_doc_number": "..." }
//   { "action": "mark_paid", "id": "<uuid>", "ar_balance": 0 }
// Response: 200 { ok:true, invoice } | 4xx { error }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = "https://plazacore.plazaandassociates.com";

const cors = {
  "Access-Control-Allow-Origin": APP_URL,
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^\d{4}-\d{2}$/;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Validate caller + require OWNER.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
  const role = (userData.user.app_metadata as any)?.user_role
            ?? (userData.user.user_metadata as any)?.user_role ?? "";
  let isOwner = role === "owner";
  if (!isOwner) {
    const { data: prof } = await admin.from("profiles").select("app_role").eq("id", userData.user.id).maybeSingle();
    isOwner = prof?.app_role === "owner";
  }
  if (!isOwner) return json({ error: "owner_only" }, 403);

  // 2. Parse
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(payload.action || "").trim();

  if (action === "queue") {
    const projectId = String(payload.project_id || "").trim();
    const period = String(payload.period || "").trim();
    const amount = Number(payload.amount ?? 0);
    if (projectId && !UUID_RE.test(projectId)) return json({ error: "invalid_project_id" }, 400);
    if (!PERIOD_RE.test(period)) return json({ error: "period_must_be_YYYY-MM" }, 400);
    if (!(amount > 0)) return json({ error: "amount_must_be_positive" }, 400);

    // Duplicate guard mirrors monthly_invoicer.py: one invoice per project/period.
    const { data: existing } = await admin.from("service_invoices")
      .select("id, status").eq("project_id", projectId).eq("period", period).maybeSingle();
    if (existing) return json({ ok: true, skipped: "already_exists", invoice: existing });

    const { data: inv, error } = await admin.from("service_invoices").insert({
      project_id: projectId || null, period, amount,
      description: payload.description ? String(payload.description) : null,
      status: "draft", due_on_issue: true,
    }).select("*").single();
    if (error) return json({ error: "insert_failed", detail: error.message }, 500);
    return json({ ok: true, invoice: inv });
  }

  if (action === "mark_sent") {
    const id = String(payload.id || "").trim();
    if (!UUID_RE.test(id)) return json({ error: "valid_id_required" }, 400);
    const { data: inv, error } = await admin.from("service_invoices").update({
      status: "sent", sent_at: new Date().toISOString(),
      qb_invoice_id: payload.qb_invoice_id ? String(payload.qb_invoice_id) : null,
      qb_doc_number: payload.qb_doc_number ? String(payload.qb_doc_number) : null,
      updated_at: new Date().toISOString(),
    }).eq("id", id).select("*").single();
    if (error) return json({ error: "update_failed", detail: error.message }, 500);
    return json({ ok: true, invoice: inv });
  }

  if (action === "mark_paid") {
    const id = String(payload.id || "").trim();
    if (!UUID_RE.test(id)) return json({ error: "valid_id_required" }, 400);
    const ar = Number(payload.ar_balance ?? 0);
    const { data: inv, error } = await admin.from("service_invoices").update({
      status: ar > 0 ? "partially_paid" : "paid",
      paid_at: ar > 0 ? null : new Date().toISOString(),
      ar_balance: ar, updated_at: new Date().toISOString(),
    }).eq("id", id).select("*").single();
    if (error) return json({ error: "update_failed", detail: error.message }, 500);
    return json({ ok: true, invoice: inv });
  }

  return json({ error: "unknown_action" }, 400);
});
