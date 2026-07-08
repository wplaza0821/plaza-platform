// Supabase Edge Function: analyze-payapp
// =====================================================================
// Given a pay_app_documents.id (doc_type='pay_application'), downloads the
// contractor's uploaded G702/G703 pay application PDF from the private
// `change-orders` bucket (payapp/ prefix), sends it to Anthropic (Claude) to
// extract the continuation-sheet line items — per line: item number,
// description, work completed THIS PERIOD (col E), materials presently
// stored (col F) — plus the G702 header figures for reconciliation.
//
// It does NOT write pay_app_lines — the frontend shows a review screen with
// the extracted values matched against the project's actual SOV items, and
// values only land after a human clicks Apply (same review->apply pattern as
// analyze-co / analyze-quantities). The LLM key stays server-side.
//
// Deploy:  supabase functions deploy analyze-payapp --no-verify-jwt
// Secrets (reuses the CO analyzer key):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY / PLAZACORE_SECRET_KEY, SUPABASE_ANON_KEY
//   JWT_SECRET, CO_LLM_API_KEY, CO_LLM_MODEL (optional)
//
// Request (POST JSON), app JWT in Authorization header. Allowed callers:
//   owner, staff, or the contractor the pay app belongs to.
//   { "doc_id": "<uuid>" }
// Response:
//   200 { ok:true, line_count, header:{...}, confidence, warnings:[...] }
//   4xx { error:"<reason>" }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = (Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const JWT_SECRET   = Deno.env.get("JWT_SECRET")!;
const LLM_API_KEY  = Deno.env.get("CO_LLM_API_KEY") || "";
const LLM_MODEL    = Deno.env.get("CO_LLM_MODEL") || "claude-sonnet-4-5";

const ALLOWED_ORIGINS = [
  "https://plazacore.plazaandassociates.com",
  "https://wplaza0821.github.io",
];
function corsFor(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Verify our custom plazacore-auth JWT and return its payload (or null).
async function customTokenPayload(token: string): Promise<Record<string, unknown> | null> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const payload = await verify(token, key);
    if (payload?.iss !== "plazacore-auth") return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const SYSTEM_PROMPT =
  "You are a construction billing analyst for Plaza and Associates (structural " +
  "engineering / special inspection / owner's representation). You are given a " +
  "contractor's PAY APPLICATION document — usually AIA G702 (Application and " +
  "Certificate for Payment) with a G703 Continuation Sheet, but possibly a " +
  "similar non-AIA format. Extract the billing values exactly as stated. Tasks:\n\n" +
  "(1) CONTINUATION SHEET LINE ITEMS — for EVERY schedule-of-values line on the " +
  "continuation sheet, extract:\n" +
  "  • item_no: the item number/code exactly as printed (string; keep leading zeros, dots, dashes).\n" +
  "  • description: the work description exactly as printed.\n" +
  "  • scheduled_value: column C, the line's scheduled value in dollars.\n" +
  "  • previous: column D, work completed from previous applications (dollars; 0 if blank).\n" +
  "  • this_period: column E, work completed THIS PERIOD (dollars; 0 if blank).\n" +
  "  • stored: column F, materials presently stored (dollars; 0 if blank).\n" +
  "  • total_completed: column G if printed (dollars; null if not shown).\n" +
  "  Rules: skip subtotal/section-header rows that carry no billing of their own; " +
  "  include zero-dollar lines (E=0,F=0) so the schedule stays complete; numbers " +
  "  are plain (no $ or commas); never invent a value — use 0 for blank cells and " +
  "  null only where a column is genuinely absent from the document.\n\n" +
  "(2) G702 HEADER / CERTIFICATE FIGURES — extract when present (null when absent):\n" +
  "  • application_no, period_to (ISO date if determinable), contract_sum_orig,\n" +
  "    change_order_net, contract_sum_to_date, total_completed_stored (line 4),\n" +
  "    retainage_amount (line 5 total), earned_less_retainage (line 6),\n" +
  "    previous_certificates (line 7), current_payment_due (line 8).\n\n" +
  "(3) LIEN RELEASE / WAIVER DETECTION — if the uploaded file ALSO contains a " +
  "conditional/unconditional waiver and release of lien (some contractors merge " +
  "them into one PDF), set waiver_included=true and waiver_amount to its stated " +
  "amount (null if not stated). Otherwise waiver_included=false.\n\n" +
  "Respond ONLY with a single minified JSON object, no prose, no markdown: " +
  '{"lines":[{"item_no":"string","description":"string","scheduled_value":number,' +
  '"previous":number,"this_period":number,"stored":number,"total_completed":number|null}],' +
  '"header":{"application_no":number|null,"period_to":"YYYY-MM-DD"|null,' +
  '"contract_sum_orig":number|null,"change_order_net":number|null,' +
  '"contract_sum_to_date":number|null,"total_completed_stored":number|null,' +
  '"retainage_amount":number|null,"earned_less_retainage":number|null,' +
  '"previous_certificates":number|null,"current_payment_due":number|null},' +
  '"waiver_included":boolean,"waiver_amount":number|null,"confidence":number}' +
  " where confidence is 0..1.";

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!LLM_API_KEY) return json({ error: "analyzer_not_configured" }, 503);

  // 1. Auth — owner/staff (custom or Supabase JWT) or the owning contractor.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);

  let callerRole = "";           // 'owner' | 'staff' | 'contractor'
  let callerContractorId = "";   // set when contractor
  let analyzedBy = "user";

  const custom = await customTokenPayload(token);
  if (custom) {
    callerRole = String(custom.user_role || "");
    callerContractorId = String(custom.contractor_id || "");
    analyzedBy = String(custom.name || callerRole || "user");
  } else {
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("app_role, active, full_name, email")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profErr) return json({ error: "profile_lookup_failed" }, 500);
    if (!prof || prof.active === false) return json({ error: "forbidden" }, 403);
    callerRole = String(prof.app_role || "");
    analyzedBy = prof.full_name || prof.email || "user";
  }
  if (!["owner", "staff", "contractor"].includes(callerRole)) {
    return json({ error: "forbidden" }, 403);
  }

  // 2. Input
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const docId = String(body.doc_id || "").trim();
  if (!docId) return json({ error: "doc_id_required" }, 400);

  // 3. Load the document row + its pay app (status/ownership checks)
  const { data: doc, error: docErr } = await admin
    .from("pay_app_documents")
    .select("id, pay_app_id, doc_type, file_path, file_name")
    .eq("id", docId)
    .maybeSingle();
  if (docErr) return json({ error: "doc_lookup_failed" }, 500);
  if (!doc) return json({ error: "doc_not_found" }, 404);
  if (doc.doc_type !== "pay_application") {
    return json({ error: "wrong_doc_type", message: "Only doc_type='pay_application' can be analyzed." }, 422);
  }
  if (!doc.file_path) return json({ error: "no_file" }, 422);

  const { data: pa, error: paErr } = await admin
    .from("pay_apps")
    .select("id, project_id, contractor_id, status, sov_version")
    .eq("id", doc.pay_app_id)
    .maybeSingle();
  if (paErr || !pa) return json({ error: "pay_app_not_found" }, 404);

  // Contractors may only analyze docs on their OWN draft pay apps.
  if (callerRole === "contractor") {
    if (!callerContractorId || pa.contractor_id !== callerContractorId) {
      return json({ error: "forbidden_not_your_pay_app" }, 403);
    }
  }
  // Values can only be applied to drafts; analyzing a locked app is pointless.
  if (pa.status !== "draft") {
    return json({ error: "not_draft", message: "Pay app is no longer in draft — values cannot be imported." }, 422);
  }

  // 4. Download the PDF bytes from storage (service role)
  const { data: blob, error: dlErr } = await admin.storage
    .from("change-orders")
    .download(doc.file_path);
  if (dlErr || !blob) return json({ error: "download_failed", detail: dlErr?.message }, 500);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) return json({ error: "file_too_large" }, 422);
  const b64 = bytesToBase64(bytes);
  const name = (doc.file_name || doc.file_path).toLowerCase();
  const isPdf = name.endsWith(".pdf");
  const mediaType = isPdf ? "application/pdf"
    : name.endsWith(".png") ? "image/png"
    : "image/jpeg";
  const docBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image",    source: { type: "base64", media_type: mediaType,        data: b64 } };

  // 5. Pull the pay app's SOV schedule so the model can anchor item numbers.
  const { data: sovItems } = await admin
    .from("sov_items")
    .select("item_no, description, scheduled_value, version, is_alternate")
    .eq("project_id", pa.project_id);
  const ver = pa.sov_version || 1;
  const schedule = (sovItems || [])
    .filter((i: any) => (i.version || 1) === ver && !i.is_alternate)
    .map((i: any) => `${i.item_no} | ${i.description} | ${Number(i.scheduled_value || 0).toFixed(2)}`)
    .join("\n");

  const userText =
    "Extract this pay application per your instructions. For reference, the project's " +
    "schedule of values (item_no | description | scheduled_value) is:\n" + schedule +
    "\nMatch extracted item_no values to this schedule where possible (use the schedule's " +
    "item_no spelling when the document clearly refers to the same line).";

  // 6. LLM call
  let llmJson: any;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [docBlock, { type: "text", text: userText }],
        }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return json({ error: "llm_failed", status: resp.status, detail: t.slice(0, 500) }, 502);
    }
    const data = await resp.json();
    const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    llmJson = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: "llm_parse_failed", detail: String(e).slice(0, 300) }, 502);
  }

  // 7. Normalize + basic validation
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const rawLines = Array.isArray(llmJson?.lines) ? llmJson.lines : [];
  const lines = rawLines
    .map((l: any) => ({
      item_no: String(l?.item_no ?? "").trim(),
      description: String(l?.description ?? "").trim(),
      scheduled_value: num(l?.scheduled_value),
      previous: num(l?.previous),
      this_period: num(l?.this_period),
      stored: num(l?.stored),
      total_completed: numOrNull(l?.total_completed),
    }))
    .filter((l: any) => l.item_no || l.description);
  if (!lines.length) return json({ error: "no_lines_extracted" }, 422);

  const h = llmJson?.header || {};
  const header = {
    application_no: numOrNull(h.application_no),
    period_to: typeof h.period_to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(h.period_to) ? h.period_to : null,
    contract_sum_orig: numOrNull(h.contract_sum_orig),
    change_order_net: numOrNull(h.change_order_net),
    contract_sum_to_date: numOrNull(h.contract_sum_to_date),
    total_completed_stored: numOrNull(h.total_completed_stored),
    retainage_amount: numOrNull(h.retainage_amount),
    earned_less_retainage: numOrNull(h.earned_less_retainage),
    previous_certificates: numOrNull(h.previous_certificates),
    current_payment_due: numOrNull(h.current_payment_due),
  };
  const confidence = Math.max(0, Math.min(1, Number(llmJson?.confidence) || 0));
  const waiver_included = llmJson?.waiver_included === true;
  const waiver_amount = numOrNull(llmJson?.waiver_amount);

  // Reconciliation warnings (surfaced on the review screen)
  const warnings: string[] = [];
  const sumG = lines.reduce((s: number, l: any) =>
    s + (l.total_completed ?? (l.previous + l.this_period + l.stored)), 0);
  if (header.total_completed_stored != null &&
      Math.abs(sumG - header.total_completed_stored) > Math.max(1, header.total_completed_stored * 0.005)) {
    warnings.push(
      `Continuation-sheet total ($${sumG.toFixed(2)}) does not match G702 line 4 ` +
      `($${header.total_completed_stored.toFixed(2)}).`,
    );
  }
  if (confidence < 0.7) warnings.push("Low extraction confidence — verify every value against the PDF.");

  const analysis = {
    lines, header, waiver_included, waiver_amount, confidence, warnings,
    model: LLM_MODEL, sov_version: ver,
  };

  // 8. Persist onto the document row (frontend reads it for review/apply)
  const { error: upErr } = await admin
    .from("pay_app_documents")
    .update({
      analysis,
      analyzed_at: new Date().toISOString(),
      analyzed_by: analyzedBy,
    })
    .eq("id", docId);
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  return json({
    ok: true,
    line_count: lines.length,
    header,
    waiver_included,
    confidence,
    warnings,
  });
});
