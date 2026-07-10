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
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

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

// ---------------------------------------------------------------------------
// Native G703 spreadsheet parser (.xlsx/.xls/.csv).
// Most G703 continuation sheets originate in Excel, where the columns are
// unambiguous — no OCR guesswork. When a contractor uploads the native file we
// parse it deterministically (no LLM), which is instant and reconciles exactly.
// The layout varies per contractor, so we DETECT columns from the header text
// rather than assuming fixed positions.
// Returns the SAME shape the LLM path produces: { lines, printed_totals, header }.
// ---------------------------------------------------------------------------
function parseMoney(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[$,\s]/g, "").replace(/[()]/g, ""); // strip $, commas, parens
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseG703Spreadsheet(bytes: Uint8Array): {
  lines: any[];
  printed_totals: any;
  header: any;
} | null {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const lines: any[] = [];

  // A G703 pay app is often split across multiple sheets/pages (e.g. a G702
  // cover sheet on "PAGE 1" and the G703 continuation on "PAGE 2"). We scan
  // EACH sheet independently for its own header band, so a cover sheet with no
  // line items is simply skipped and every continuation sheet contributes rows.
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true }) as any[][];
    if (!rows.length) continue;

    // AIA G703 header labels commonly wrap across up to THREE rows, e.g.:
    //   row n:   A | B | C | ... (column letters)
    //   row n+1: No. | DESCRIPTION OF WORK | ... | SCHEDULED OF VALUES | WORK COMPLETED | ...
    //   row n+2: ...                            | FROM PREVIOUS APPLICATION | THIS PERIOD | ...
    let colDesc = -1, colSched = -1, colPrev = -1, colThis = -1, colStored = -1, colTotal = -1, colItem = -1;
    let headerRowIdx = -1;
    const scanTo = Math.min(rows.length, 45);
    for (let r = 0; r < scanTo; r++) {
      const joined = rows[r].map(norm).join(" | ");
      const bandRows = [rows[r - 1] || [], rows[r], rows[r + 1] || [], rows[r + 2] || []];
      const bandJoined = bandRows.map((br) => br.map(norm).join(" | ")).join(" || ");
      if (joined.includes("scheduled") &&
          (bandJoined.includes("this period") || bandJoined.includes("previous"))) {
        const findCol = (pred: (c: string) => boolean): number => {
          for (const br of bandRows) {
            const idx = br.map(norm).findIndex(pred);
            if (idx >= 0) return idx;
          }
          return -1;
        };
        colDesc   = findCol((c) => c.includes("description"));
        colSched  = findCol((c) => c.includes("scheduled"));
        colPrev   = findCol((c) => c.includes("previous"));
        colThis   = findCol((c) => c.includes("this period"));
        colStored = findCol((c) => (c.includes("stored") || c.includes("mat.")) && !c.includes("total"));
        colTotal  = findCol((c) => c.includes("total") && (c.includes("complet") || c.includes("stored")));
        colItem   = findCol((c) => c === "no." || c === "no" || c === "a" || c.includes("item"));
        if (colItem < 0) colItem = 0;
        headerRowIdx = r;
        break;
      }
    }
    if (headerRowIdx < 0 || colSched < 0 || (colThis < 0 && colPrev < 0)) continue; // no G703 on this sheet

    // Extract detail rows. Keep any row that has BOTH an item number and a
    // description — including $0 lines, so the schedule stays complete for SOV
    // matching (a $0 line applies no change but must map to its SOV item).
    // Skip:
    //  - the wrapped label rows / column-letter row (no item_no or no description)
    //  - section SUBTOTAL rows (they carry a dollar figure but NO item_no, since
    //    the item column is blank on subtotal lines) — already excluded by !item_no.
    //  - section TITLE rows (item code but no description) — excluded by !description.
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.length) continue;
      const item_no = String(row[colItem] ?? "").trim();
      const description = colDesc >= 0 ? String(row[colDesc] ?? "").trim() : "";
      if (!item_no || !description) continue;
      // Guard against the header/label band leaking in (e.g. an "A"/"No." row):
      // a real line's description is not itself a column label.
      const dl = description.toLowerCase();
      if (dl === "description of work" || dl === "description") continue;
      const scheduled_value = parseMoney(row[colSched]);
      const previous = colPrev >= 0 ? parseMoney(row[colPrev]) : 0;
      const this_period = colThis >= 0 ? parseMoney(row[colThis]) : 0;
      const stored = colStored >= 0 ? parseMoney(row[colStored]) : 0;
      const totalRaw = colTotal >= 0 ? parseMoney(row[colTotal]) : (previous + this_period + stored);
      const total_completed = totalRaw !== 0 ? totalRaw : previous + this_period + stored;
      lines.push({ item_no, description, scheduled_value, previous, this_period, stored, total_completed });
    }
  }
  if (!lines.length) return null;

  // Printed totals: sum of the detail lines (the sheet's own subtotal/total rows
  // are excluded above, so these ARE the authoritative column totals).
  const sum = (k: string) => lines.reduce((s, l) => s + (l[k] || 0), 0);
  const printed_totals = {
    printed_scheduled_total: sum("scheduled_value"),
    printed_previous_total: sum("previous"),
    printed_this_period_total: sum("this_period"),
    printed_stored_total: sum("stored"),
    printed_total_completed: sum("total_completed"),
  };
  const header = {
    application_no: null, period_to: null, contract_sum_orig: null, change_order_net: null,
    contract_sum_to_date: null, total_completed_stored: printed_totals.printed_total_completed,
    retainage_amount: null, earned_less_retainage: null, previous_certificates: null, current_payment_due: null,
  };
  return { lines, printed_totals, header };
}

const SYSTEM_PROMPT =
  "You are a meticulous construction billing analyst for Plaza and Associates (structural " +
  "engineering / special inspection / owner's representation). You are given a " +
  "contractor's PAY APPLICATION document — usually AIA G702 (Application and " +
  "Certificate for Payment) with a G703 Continuation Sheet, but possibly a " +
  "similar non-AIA format. The G703 is frequently a DENSE, LOW-RESOLUTION SCAN with " +
  "many narrow columns packed tightly together. ACCURACY IS CRITICAL: these numbers " +
  "authorize payment. Read every digit deliberately. Extract the billing values " +
  "EXACTLY as printed. Tasks:\n\n" +
  "(1) CONTINUATION SHEET LINE ITEMS — for EVERY schedule-of-values line on the " +
  "continuation sheet, extract:\n" +
  "  • item_no: the item number/code exactly as printed (string; keep leading zeros, dots, dashes).\n" +
  "  • description: the work description exactly as printed.\n" +
  "  • scheduled_value: column C, the line's scheduled value in dollars.\n" +
  "  • previous: column D, work completed from PREVIOUS applications (dollars; 0 if blank).\n" +
  "  • this_period: column E, work completed THIS PERIOD (dollars; 0 if blank).\n" +
  "  • stored: column F, materials presently stored (dollars; 0 if blank).\n" +
  "  • total_completed: column G, total completed and stored to date (dollars; if the " +
  "    document does not print column G, compute it as previous+this_period+stored).\n" +
  "  COLUMN DISCIPLINE (the #1 source of error): the AIA G703 columns run left→right " +
  "  as A(item) B(description) C(scheduled value) D(previous) E(this period) F(stored) " +
  "  G(total completed) H(% ) I(balance to finish) [retainage]. On a tight scan it is " +
  "  EASY to slide a value into the wrong column. For each line, the invariant " +
  "  G = D + E + F MUST hold; if your read does not satisfy it, you have mis-assigned a " +
  "  column — RE-READ that row before answering. A large 100%-complete line will show " +
  "  its value in column D (previous) with E=0, NOT in E.\n" +
  "  Rules: skip pure subtotal/section-header rows that carry no billing of their own; " +
  "  include zero-dollar lines so the schedule stays complete; numbers are plain " +
  "  (no $, no commas); never invent a value — use 0 for a blank cell; null only where a " +
  "  column is genuinely absent from the document entirely.\n\n" +
  "(2) PRINTED COLUMN TOTALS (the TOTALS / GRAND TOTAL row at the bottom of the G703) — " +
  "  these are the contractor's own printed checksums. Transcribe them EXACTLY as printed " +
  "  (do not compute — read the printed totals row):\n" +
  "  • printed_scheduled_total (column C total), printed_previous_total (column D total),\n" +
  "    printed_this_period_total (column E total), printed_stored_total (column F total),\n" +
  "    printed_total_completed (column G total). Use null for any total not printed.\n\n" +
  "(3) G702 HEADER / CERTIFICATE FIGURES — extract when present (null when absent):\n" +
  "  • application_no, period_to (ISO date if determinable), contract_sum_orig,\n" +
  "    change_order_net, contract_sum_to_date, total_completed_stored (line 4),\n" +
  "    retainage_amount (line 5 total), earned_less_retainage (line 6),\n" +
  "    previous_certificates (line 7), current_payment_due (line 8).\n\n" +
  "(4) SELF-RECONCILIATION BEFORE YOU ANSWER (mandatory):\n" +
  "  a. For every line confirm G = D + E + F (within $1). Fix any line that fails.\n" +
  "  b. Confirm your extracted line items sum to the printed column totals from (2):\n" +
  "     Σprevious ≈ printed_previous_total, Σthis_period ≈ printed_this_period_total,\n" +
  "     Σstored ≈ printed_stored_total, Σtotal_completed ≈ printed_total_completed.\n" +
  "  c. Confirm Σtotal_completed ≈ G702 line 4 (total_completed_stored).\n" +
  "  If any check is off, you have a mis-read — go back into the columns and correct the " +
  "  offending line(s) until every check reconciles. Set confidence to reflect how well " +
  "  the final numbers reconcile (1.0 only when every checksum ties exactly).\n\n" +
  "(5) LIEN RELEASE / WAIVER DETECTION — if the uploaded file ALSO contains a " +
  "conditional/unconditional waiver and release of lien (some contractors merge " +
  "them into one PDF), set waiver_included=true and waiver_amount to its stated " +
  "amount (null if not stated). Otherwise waiver_included=false.\n\n" +
  "Respond ONLY with a single minified JSON object, no prose, no markdown: " +
  '{"lines":[{"item_no":"string","description":"string","scheduled_value":number,' +
  '"previous":number,"this_period":number,"stored":number,"total_completed":number|null}],' +
  '"printed_totals":{"printed_scheduled_total":number|null,"printed_previous_total":number|null,' +
  '"printed_this_period_total":number|null,"printed_stored_total":number|null,"printed_total_completed":number|null},' +
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
    .select("id, project_id, contractor_id, status, sov_version, pay_app_number")
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
  const name = (doc.file_name || doc.file_path).toLowerCase();
  const isSpreadsheet = /\.(xlsx|xls|csv)$/.test(name);
  const isPdf = name.endsWith(".pdf");
  // b64/docBlock are only needed for the LLM (PDF/image) path.
  const b64 = isSpreadsheet ? "" : bytesToBase64(bytes);
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

  // 5b. Prior-pay-app FLOOR: the immediately preceding pay app's total completed-and-stored.
  //     This pay app's "previous completed" (Σ col D) MUST equal the last pay app's total
  //     completed-to-date, and its own total (Σ col G) can never be LESS than that floor.
  //     Used as a reconciliation anchor — and the ONLY anchor when the sheet prints no
  //     totals row and no G702 line 4.
  let priorTotalCompleted: number | null = null;
  let priorPayAppNumber: number | null = null;
  {
    const curNum = Number(pa.pay_app_number);
    const { data: priors } = await admin
      .from("pay_apps")
      .select("id, pay_app_number, status, total_completed")
      .eq("project_id", pa.project_id)
      .eq("contractor_id", pa.contractor_id)
      .neq("id", pa.id)
      .order("pay_app_number", { ascending: false });
    // Highest-numbered PRIOR pay app that is billed/certified (status !== 'draft').
    const chosen = (priors || []).find((p: any) => {
      const isPrior = !Number.isFinite(curNum) || Number(p.pay_app_number) < curNum;
      return isPrior && String(p.status) !== "draft";
    });
    if (chosen && chosen.total_completed != null) {
      priorTotalCompleted = Number(chosen.total_completed);
      priorPayAppNumber = Number(chosen.pay_app_number);
    }
  }

  // ---- helpers ----
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Tolerance: $1 or 0.1% of the reference, whichever is larger (rounding slack only).
  const tol = (ref: number) => Math.max(1, Math.abs(ref) * 0.001);

  // Hard per-call timeout so a stuck Anthropic request can't wedge the whole
  // edge function (which would surface to the user as a spinning button).
  // NOTE: a dense scanned G703 with 100+ lines legitimately takes ~90s for one
  // pass (measured: 92s / ~7.9k output tokens on TRPV Pay App 2). Set the cap
  // above that real duration so we abort only genuinely-stuck calls, not slow
  // legitimate ones. Two passes worst case (~2x110s) stays within the Edge
  // Function wall-clock budget.
  const LLM_CALL_TIMEOUT_MS = 110000;
  async function callLLM(extraUserText: string): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LLM_CALL_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LLM_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          max_tokens: 16000,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [docBlock, { type: "text", text: userText + extraUserText }],
          }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(t);
      if ((e as any)?.name === "AbortError") throw new Error("llm_timeout: Anthropic call exceeded " + LLM_CALL_TIMEOUT_MS + "ms");
      throw e;
    }
    clearTimeout(t);
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`llm_failed status=${resp.status} ${t.slice(0, 400)}`);
    }
    const data = await resp.json();
    if (data?.stop_reason === "max_tokens") {
      throw new Error("llm_truncated: response hit max_tokens — schedule too long to extract in one pass");
    }
    const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(cleaned);
  }

  function normalize(llmJson: any) {
    const rawLines = Array.isArray(llmJson?.lines) ? llmJson.lines : [];
    const lines = rawLines
      .map((l: any) => {
        const previous = num(l?.previous);
        const this_period = num(l?.this_period);
        const stored = num(l?.stored);
        const tcRaw = numOrNull(l?.total_completed);
        // If G not printed, compute it; keep printed value otherwise.
        const total_completed = tcRaw === null ? (previous + this_period + stored) : tcRaw;
        return {
          item_no: String(l?.item_no ?? "").trim(),
          description: String(l?.description ?? "").trim(),
          scheduled_value: num(l?.scheduled_value),
          previous, this_period, stored, total_completed,
        };
      })
      .filter((l: any) => l.item_no || l.description);
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
    const pt = llmJson?.printed_totals || {};
    const printed_totals = {
      printed_scheduled_total: numOrNull(pt.printed_scheduled_total),
      printed_previous_total: numOrNull(pt.printed_previous_total),
      printed_this_period_total: numOrNull(pt.printed_this_period_total),
      printed_stored_total: numOrNull(pt.printed_stored_total),
      printed_total_completed: numOrNull(pt.printed_total_completed),
    };
    return { lines, header, printed_totals,
      waiver_included: llmJson?.waiver_included === true,
      waiver_amount: numOrNull(llmJson?.waiver_amount),
      confidence: Math.max(0, Math.min(1, Number(llmJson?.confidence) || 0)) };
  }

  // Reconciliation engine: returns {ok, warnings, discrepancies[]} where
  // discrepancies is human+model readable text describing each failed checksum.
  function reconcile(n: any) {
    const { lines, header, printed_totals } = n;
    const sum = (k: string) => lines.reduce((s: number, l: any) => s + (l[k] || 0), 0);
    const sPrev = sum("previous"), sThis = sum("this_period"), sStored = sum("stored"), sG = sum("total_completed");
    const disc: string[] = [];
    const warnings: string[] = [];

    // (a) per-line G = D+E+F
    const badLines = lines.filter((l: any) =>
      Math.abs(l.total_completed - (l.previous + l.this_period + l.stored)) > 1);
    if (badLines.length) {
      disc.push(`${badLines.length} line(s) violate G=D+E+F, e.g. ` +
        badLines.slice(0, 5).map((l: any) =>
          `${l.item_no}: G ${money(l.total_completed)} ≠ D ${money(l.previous)} + E ${money(l.this_period)} + F ${money(l.stored)}`).join("; ") + ".");
    }

    // (b) line sums vs printed column totals
    const cmp = (label: string, got: number, printed: number | null) => {
      if (printed == null) return;
      if (Math.abs(got - printed) > tol(printed)) {
        disc.push(`${label}: extracted line items sum to ${money(got)} but the sheet's printed ${label} total is ${money(printed)} (off by ${money(got - printed)}).`);
      }
    };
    cmp("previous (col D)", sPrev, printed_totals.printed_previous_total);
    cmp("this period (col E)", sThis, printed_totals.printed_this_period_total);
    cmp("stored (col F)", sStored, printed_totals.printed_stored_total);
    cmp("total completed (col G)", sG, printed_totals.printed_total_completed);

    // (c) G total vs G702 line 4
    if (header.total_completed_stored != null &&
        Math.abs(sG - header.total_completed_stored) > tol(header.total_completed_stored)) {
      disc.push(`Continuation-sheet total completed ${money(sG)} does not match G702 line 4 ${money(header.total_completed_stored)} (off by ${money(sG - header.total_completed_stored)}).`);
    }
    // (d) printed G total vs line 4 (document-internal, surfaced only as a warning — that would be a contractor error, not ours)
    if (printed_totals.printed_total_completed != null && header.total_completed_stored != null &&
        Math.abs(printed_totals.printed_total_completed - header.total_completed_stored) > tol(header.total_completed_stored)) {
      warnings.push(`Document may be internally inconsistent: printed G703 total ${money(printed_totals.printed_total_completed)} ≠ G702 line 4 ${money(header.total_completed_stored)}. Verify against the PDF.`);
    }

    // (e) PRIOR-PAY-APP FLOOR anchor. The extracted "previous completed" (Σ col D) must
    //     equal the immediately preceding certified pay app's total completed-to-date, and
    //     the current total (Σ col G) can never be LESS than that floor. This is the ONLY
    //     numeric anchor when the sheet prints no totals row and no G702 line 4.
    if (priorTotalCompleted != null) {
      if (Math.abs(sPrev - priorTotalCompleted) > tol(priorTotalCompleted)) {
        disc.push(`"previous completed" (Σ col D) sums to ${money(sPrev)} but pay app #${priorPayAppNumber} already certified ${money(priorTotalCompleted)} completed-to-date — this pay app's "previous" column must equal that. A prior-billed line was likely mis-read as $0 or put in the wrong column.`);
      }
      if (sG < priorTotalCompleted - tol(priorTotalCompleted)) {
        disc.push(`Total completed-to-date ${money(sG)} is LESS than the prior certified total ${money(priorTotalCompleted)} (pay app #${priorPayAppNumber}) — impossible; completed-to-date can only increase. Re-read the columns.`);
      }
    }

    // Track whether ANY external checksum existed. If the sheet printed no column-G total,
    // no G702 line 4, AND there is no prior pay app to anchor to, we cannot fully verify.
    const hadStrongAnchor =
      printed_totals.printed_previous_total != null ||
      printed_totals.printed_total_completed != null ||
      header.total_completed_stored != null ||
      priorTotalCompleted != null;

    return { ok: disc.length === 0, discrepancies: disc, warnings, hadStrongAnchor };
  }

  // 6. LLM call with self-repair loop. We only RETRY a reconciliation failure
  //    when there is an external anchor to reconcile against (printed totals,
  //    G702 line 4, or a prior certified pay app). If none exists, retrying
  //    cannot improve the result — it only burns time and can hang the button —
  //    so we accept the first extraction and flag it as unverified instead.
  //    Reduced from 3 to 2 passes: a single targeted repair captures nearly all
  //    real fixes; a 3rd pass added latency without materially better accuracy.
  const MAX_PASSES = 2;
  let normalized: any = null;
  let recon: any = null;
  let repairNote = "";
  let lastErr = "";
  let source: "spreadsheet" | "llm" = "llm";

  // 6a. NATIVE SPREADSHEET FAST PATH — no LLM, no OCR, instant + exact.
  //     When the contractor uploaded the native G703 (.xlsx/.xls/.csv) we parse
  //     the columns deterministically and run the SAME reconciliation engine.
  if (isSpreadsheet) {
    let parsed: any = null;
    try {
      parsed = parseG703Spreadsheet(bytes);
    } catch (e) {
      return json({ error: "spreadsheet_parse_failed", detail: String(e).slice(0, 400) }, 422);
    }
    if (!parsed || !parsed.lines?.length) {
      return json({ error: "no_lines_extracted", detail: "Could not locate G703 columns in the spreadsheet. Ensure it is a G703 continuation sheet with Scheduled Value / Previous / This Period columns." }, 422);
    }
    // Normalize through the same normalizer so downstream shape matches the LLM path.
    const n = normalize({ ...parsed, waiver_included: false, waiver_amount: null, confidence: 1 });
    normalized = n;
    recon = reconcile(n);
    source = "spreadsheet";
  } else
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    let llmJson: any;
    try {
      llmJson = await callLLM(repairNote);
    } catch (e) {
      lastErr = String(e).slice(0, 400);
      // Timeout/transport/parse errors are worth one more try.
      if (pass < MAX_PASSES) { repairNote = "\n\nYour previous response could not be used (" + lastErr + "). Return ONLY valid minified JSON per the schema."; continue; }
      return json({ error: "llm_error", detail: lastErr }, 502);
    }
    const n = normalize(llmJson);
    if (!n.lines.length) {
      lastErr = "no_lines_extracted";
      if (pass < MAX_PASSES) { repairNote = "\n\nYour previous response had no line items. Re-read the G703 continuation sheet and extract every line."; continue; }
      return json({ error: "no_lines_extracted" }, 422);
    }
    const r = reconcile(n);
    normalized = n; recon = r;
    if (r.ok) break;
    // No external anchor => a retry cannot verify anything. Stop now and let the
    // downstream "unverified" handling flag it; do not waste a second pass.
    if (!r.hadStrongAnchor) break;
    // Build a targeted repair prompt with the exact discrepancies.
    if (pass < MAX_PASSES) {
      repairNote =
        "\n\nYOUR PREVIOUS EXTRACTION DID NOT RECONCILE against the sheet's own printed " +
        "totals. This almost always means a value was read from the WRONG COLUMN (e.g. a " +
        "100%-complete line's amount placed in 'this period' (E) instead of 'previous' (D), " +
        "or a digit misread). Fix these specific problems by RE-READING the affected rows and " +
        "columns, then return the full corrected JSON:\n- " + r.discrepancies.join("\n- ") +
        "\nEnsure every line satisfies G=D+E+F and that Σ of each column equals the printed " +
        "column totals you transcribed.";
    }
  }

  const { lines, header, printed_totals, waiver_included, waiver_amount } = normalized;
  const fromSpreadsheet = source === "spreadsheet";
  // Confidence: keep the model's, but never report high confidence if it didn't reconcile.
  let confidence = normalized.confidence;
  const warnings: string[] = [...recon.warnings];
  if (!recon.ok) {
    confidence = Math.min(confidence, 0.5);
    warnings.push(
      fromSpreadsheet
        ? "⚠️ The native spreadsheet's line items do not internally reconcile (G ≠ D + E + F on " +
          "one or more lines, or against the prior pay app). Verify the source file. Details: " +
          recon.discrepancies.join(" ")
        : "⚠️ Automatic reconciliation FAILED after " + MAX_PASSES + " attempts — the extracted " +
          "figures do not tie to the pay application's own printed totals. DO NOT rely on these values; " +
          "verify every line against the PDF before applying. Details: " + recon.discrepancies.join(" "),
    );
  }
  if (confidence < 0.7 && recon.ok && !fromSpreadsheet) {
    warnings.push("Model reported low confidence — spot-check values against the PDF.");
  }
  // No external checksum at all (no printed totals, no G702 line 4, no prior pay app):
  // reconciliation was vacuously "ok" but unverified — say so explicitly, cap confidence.
  // For a native spreadsheet the per-line G=D+E+F invariant WAS checked against the file's
  // own numbers, so it is genuinely verified even without an external anchor.
  if (recon.ok && !recon.hadStrongAnchor && !fromSpreadsheet) {
    confidence = Math.min(confidence, 0.6);
    warnings.push(
      "⚠️ Could not auto-verify: this document prints no column totals or G702 line 4, and " +
      "there is no prior certified pay app to anchor against. Values were extracted but NOT " +
      "cross-checked — verify every line against the PDF before applying.",
    );
  }

  const analysis = {
    lines, header, printed_totals, waiver_included, waiver_amount, confidence, warnings,
    reconciled: recon.ok,
    // A native spreadsheet that passes per-line reconciliation is verified even
    // without an external anchor (the columns are unambiguous, not OCR'd).
    verified: recon.ok && (fromSpreadsheet || recon.hadStrongAnchor),
    reconciliation_discrepancies: recon.discrepancies,
    prior_pay_app_number: priorPayAppNumber, prior_total_completed: priorTotalCompleted,
    source, model: fromSpreadsheet ? "native-xlsx-parser" : LLM_MODEL, sov_version: ver,
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
    printed_totals,
    waiver_included,
    confidence,
    reconciled: recon.ok,
    verified: recon.ok && (fromSpreadsheet || recon.hadStrongAnchor),
    source,
    prior_pay_app_number: priorPayAppNumber,
    prior_total_completed: priorTotalCompleted,
    warnings,
  });
});
