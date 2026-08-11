// Supabase Edge Function: analyze-dailylog
// Owner/staff. Given a daily_log_documents.id, downloads the uploaded daily-log
// scan from the private `field-reports` bucket, sends it to Anthropic (Claude) to
// extract EVERY visit day recorded in it, and writes the structured result back to
// the daily_log_documents row: analysis (jsonb), analyzed_at, analyzed_by.
//
// It does NOT create daily_reports rows. The frontend shows the extracted days for
// review and only writes them on explicit Apply. Same discipline as analyze-co:
// the LLM never mutates the record of authority on its own.
//
// A single scan normally contains MANY days (a week or a month of field sheets),
// so the output is an array of days, each tagged with its source page.
//
// Deploy:  supabase functions deploy analyze-dailylog --no-verify-jwt
// Secrets (shared with analyze-co, already set):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto-injected)
//   JWT_SECRET, CO_LLM_API_KEY, CO_LLM_MODEL (optional)
//
// Request (POST JSON), app JWT in Authorization header:
//   { "doc_id": "<uuid>" }
// Response:
//   200 { ok:true, days:[...], warnings:[...], page_count:number }
//   4xx { error:"<reason>" }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = (Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const JWT_SECRET   = Deno.env.get("JWT_SECRET")!;
const LLM_API_KEY  = Deno.env.get("CO_LLM_API_KEY") || "";
const LLM_MODEL    = Deno.env.get("CO_LLM_MODEL") || "claude-sonnet-4-6";

// Emit per-call token usage to the edge-function log so spend is attributable
// per module instead of arriving as one opaque line on the Anthropic bill.
// Query with: supabase functions logs analyze-dailylog | grep llm_usage
function logUsage(fn: string, data: any) {
  const u = data?.usage || {};
  console.log(JSON.stringify({
    evt: "llm_usage",
    fn,
    model: data?.model ?? LLM_MODEL,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    stop_reason: data?.stop_reason ?? null,
  }));
}

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

async function customTokenRole(token: string): Promise<string | null> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const payload: any = await verify(token, key);
    if (payload?.iss !== "plazacore-auth") return null;
    return String(payload?.user_role || "") || null;
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
  "You are a construction field-records analyst for Plaza and Associates (structural " +
  "engineering / special inspection). You are given a scanned DAILY LOG / daily field " +
  "report document. It may be typed, handwritten, or a mix, and it normally contains " +
  "MANY separate days — one sheet or block per site visit.\n\n" +
  "TASK: extract EVERY distinct visit day recorded in the document, in chronological order.\n\n" +
  "RULES — read carefully, these matter more than completeness:\n" +
  "• TRANSCRIBE, DO NOT INTERPRET. Report what the sheet says. Never invent, infer, " +
  "  smooth over, or 'helpfully' complete a field. This is a legal field record that may " +
  "  be produced in litigation or to a building official.\n" +
  "• DATES: report_date must be ISO 'YYYY-MM-DD'. Only output a date you can actually read " +
  "  on the sheet. If the year is not printed anywhere, use the year given in the user " +
  "  message as context, and say so in the day's 'notes_for_reviewer'. If a date is " +
  "  illegible or absent, set report_date to null and explain in 'notes_for_reviewer' — " +
  "  NEVER guess a date, and never derive one from sequence position.\n" +
  "• ILLEGIBLE HANDWRITING: put '[illegible]' inline exactly where you cannot read words. " +
  "  Do not omit the passage silently and do not guess at it.\n" +
  "• EMPTY FIELDS: if the sheet leaves a field blank, return null for it. Do not write " +
  "  'N/A', do not copy a value from a neighbouring day, and do not carry a value forward.\n" +
  "• crew_count must be an integer you can actually read; otherwise null. Never estimate " +
  "  it from a description of the work.\n" +
  "• VISITS AND PERSONNEL — this is the primary purpose of the extraction. Capture every " +
  "  person, inspector, trade, subcontractor, official, or company recorded as present or " +
  "  visiting that day. Put the log's own inspector/author in 'inspector', and everyone " +
  "  else in 'visitors' as a comma-separated list, preserving titles and company names as " +
  "  written (e.g. 'Tomas E. Hernandez PE (Plaza & Associates), City of Miami inspector, " +
  "  ABC Waterproofing (4 men)'). If a visitor's name is illegible, record the legible part " +
  "  plus '[illegible]'.\n" +
  "• SAFETY: if the sheet records no incident, return 'None'. If the field is blank/absent, " +
  "  return null. These are different facts and must not be conflated.\n" +
  "• 'page' is the 1-based page number of the source PDF that the day was read from.\n" +
  "• 'confidence' is 0..1 for that day's overall legibility.\n" +
  "• If a single day spans multiple pages, merge it into ONE entry and cite the first page.\n" +
  "• If the document contains no readable daily-log day at all, return an empty days array " +
  "  and explain why in warnings.\n\n" +
  "Respond ONLY with a single minified JSON object, no prose and no markdown fence, of the " +
  "exact shape:\n" +
  '{"days":[{"report_date":"YYYY-MM-DD|null","inspector":"string|null",' +
  '"weather":"string|null","temperature":"string|null","crew_count":number|null,' +
  '"work_performed":"string|null","materials_delivered":"string|null",' +
  '"equipment_on_site":"string|null","visitors":"string|null","delays":"string|null",' +
  '"safety_incidents":"string|null","notes":"string|null",' +
  '"notes_for_reviewer":"string|null","page":number,"confidence":number}],' +
  '"warnings":["string"]}';

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

  // 1. Auth — owner or staff (field records are staff work, unlike CO approval).
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);

  let analyzedBy = "owner";
  const customRole = await customTokenRole(token);
  if (customRole) {
    if (!["owner", "staff"].includes(customRole)) return json({ error: "forbidden" }, 403);
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
    if (!prof || !["owner", "staff"].includes(String(prof.app_role)) || prof.active === false) {
      return json({ error: "forbidden" }, 403);
    }
    analyzedBy = prof.full_name || prof.email || "staff";
  }

  // 2. Input
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const docId = String(body.doc_id || "").trim();
  if (!docId) return json({ error: "doc_id_required" }, 400);

  // 3. Load the document row
  const { data: doc, error: docErr } = await admin
    .from("daily_log_documents")
    .select("id, project_id, file_path, file_name")
    .eq("id", docId)
    .maybeSingle();
  if (docErr) return json({ error: "doc_lookup_failed" }, 500);
  if (!doc) return json({ error: "doc_not_found" }, 404);
  if (!doc.file_path) return json({ error: "no_document" }, 422);

  // 4. Download the scan
  const { data: blob, error: dlErr } = await admin.storage
    .from("field-reports")
    .download(doc.file_path);
  if (dlErr || !blob) return json({ error: "download_failed", detail: dlErr?.message }, 500);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const b64 = bytesToBase64(bytes);
  const name = (doc.file_name || doc.file_path).toLowerCase();
  const isPdf = name.endsWith(".pdf");
  const mediaType = isPdf ? "application/pdf"
    : name.endsWith(".png") ? "image/png"
    : "image/jpeg";

  const docBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image",    source: { type: "base64", media_type: mediaType,        data: b64 } };

  // Project context helps disambiguate a year that the sheets omit.
  const { data: proj } = await admin
    .from("projects")
    .select("code, name")
    .eq("id", doc.project_id)
    .maybeSingle();

  const uploadYear = new Date().getUTCFullYear();
  const userText =
    `This is a scanned daily log for project ${proj?.code || ""} ${proj?.name || ""}`.trim() +
    `. Extract every visit day per your instructions. If a sheet omits the year, ` +
    `assume ${uploadYear} and note that assumption in notes_for_reviewer. ` +
    `Do not guess any date you cannot read.`;

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
        // Many days x many fields — needs considerably more room than a CO.
        max_tokens: 16000,
        // Deterministic extraction: sampling variance on dates/quantities is
        // pure downside, and it is what drives truncation + reparse retries.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: [docBlock, { type: "text", text: userText }] }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return json({ error: "llm_failed", status: resp.status, detail: t.slice(0, 500) }, 502);
    }
    const data = await resp.json();
    logUsage("analyze-dailylog", data);
    // A truncated response yields invalid JSON; say so plainly instead of half-parsing.
    if (data?.stop_reason === "max_tokens") {
      return json({
        error: "too_many_days",
        message: "The scan holds more days than one pass can extract. Split the PDF (e.g. one month at a time) and upload again.",
      }, 413);
    }
    const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    llmJson = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: "llm_parse_failed", detail: String(e).slice(0, 300) }, 502);
  }

  // 5. Normalize + validate server-side. Never trust shapes from a model.
  const str = (v: unknown) => {
    const s = (v === null || v === undefined) ? "" : String(v).trim();
    return s && s.toLowerCase() !== "null" ? s : null;
  };
  const intOrNull = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  const warnings: string[] = Array.isArray(llmJson?.warnings)
    ? llmJson.warnings.map((w: unknown) => String(w)).filter(Boolean) : [];

  const rawDays = Array.isArray(llmJson?.days) ? llmJson.days : [];
  const days = rawDays.map((d: any, i: number) => {
    let report_date = str(d?.report_date);
    // A date must be real and calendar-valid, not merely ISO-shaped.
    if (report_date && !ISO.test(report_date)) report_date = null;
    if (report_date) {
      const t = Date.parse(report_date + "T00:00:00Z");
      if (!Number.isFinite(t)) report_date = null;
      else if (report_date !== new Date(t).toISOString().slice(0, 10)) report_date = null;
    }
    return {
      report_date,
      inspector:           str(d?.inspector),
      weather:             str(d?.weather),
      temperature:         str(d?.temperature),
      crew_count:          intOrNull(d?.crew_count),
      work_performed:      str(d?.work_performed),
      materials_delivered: str(d?.materials_delivered),
      equipment_on_site:   str(d?.equipment_on_site),
      visitors:            str(d?.visitors),
      delays:              str(d?.delays),
      safety_incidents:    str(d?.safety_incidents),
      notes:               str(d?.notes),
      notes_for_reviewer:  str(d?.notes_for_reviewer),
      page:                intOrNull(d?.page) ?? (i + 1),
      confidence:          Math.max(0, Math.min(1, Number(d?.confidence) || 0)),
    };
  })
  // A day with no date AND no narrative is noise, not a record.
  .filter((d: any) => d.report_date || d.work_performed || d.visitors || d.notes);

  const undated = days.filter((d: any) => !d.report_date).length;
  if (undated) {
    warnings.push(`${undated} extracted day(s) have no readable date and must be dated by hand before they can be saved.`);
  }
  // Flag same-date collisions: either a genuine duplicate sheet or a misread date.
  const seen = new Map<string, number>();
  for (const d of days) {
    if (!d.report_date) continue;
    seen.set(d.report_date, (seen.get(d.report_date) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) {
    warnings.push(`Repeated date(s) in this scan: ${dupes.join(", ")}. Check for a duplicate sheet or a misread date.`);
  }
  const lowConf = days.filter((d: any) => d.confidence > 0 && d.confidence < 0.6).length;
  if (lowConf) {
    warnings.push(`${lowConf} day(s) were hard to read (confidence < 0.6) — verify these against the scan.`);
  }

  const analysis = { days, warnings, model: LLM_MODEL, extracted_at: new Date().toISOString() };

  const { error: upErr } = await admin
    .from("daily_log_documents")
    .update({
      analysis,
      analyzed_at: new Date().toISOString(),
      analyzed_by: analyzedBy,
      page_count: days.length ? Math.max(...days.map((d: any) => d.page || 1)) : null,
    })
    .eq("id", docId);
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  return json({ ok: true, days, warnings, page_count: analysis.days.length });
});
