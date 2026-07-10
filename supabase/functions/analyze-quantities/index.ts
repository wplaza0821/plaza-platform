// Supabase Edge Function: analyze-quantities
// =====================================================================
// Given a quantity_imports.id, downloads the uploaded spreadsheet from the
// private `quantity-imports` bucket, parses it into normalized repair-quantity
// line items, and writes the result onto the quantity_imports row (analysis jsonb).
//
// It does NOT create repair_quantity_items rows — the frontend reviews the
// analysis and the owner clicks "Apply" to materialize entries (auto-creating
// any missing repair_stacks). Mirrors analyze-schedule / analyze-co: the LLM key
// stays server-side and the owner controls the write.
//
// File lives in the existing private `plans-specs` bucket under a `quantity/`
// prefix (reused to avoid a new-bucket policy rollout); the edge fn downloads it
// via service-role so storage RLS is not in the path.
//
// Supported source formats:
//   * .xlsx / .xls  — parsed with SheetJS into rows, normalized by Claude
//                     (arbitrary column layouts: Stack/Tower/Floor/Level/Type/
//                     Width/Length/Height/Depth/Qty/Description/Date/SI Ref).
//   * .csv          — same path as XLSX.
//
// Output items are normalized to the repair_quantity_items shape:
//   { tower, stack_label, floor_level, repair_type, description,
//     length_in, height_in, depth_in, status, si_report_ref,
//     date_observed, date_repaired, notes }
//
// Repair types (key set the app understands):
//   concrete_repair, spall_repair, rebar_treatment, stucco_patch (area)
//   tuck_point, window_sealant (linear), pt_pocket, weep_hole (count)
//   waterproof_membrane (area), other (area)
//
// Deploy:  supabase functions deploy analyze-quantities --no-verify-jwt
// Secrets (reuses the CO analyzer key):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY / PLAZACORE_SECRET_KEY, SUPABASE_ANON_KEY
//   JWT_SECRET, CO_LLM_API_KEY, CO_LLM_MODEL (optional)
//
// Request (POST JSON), owner/staff app JWT in Authorization header:
//   { "import_id": "<uuid>" }
// Response:
//   200 { ok:true, item_count, summary, confidence, warnings }
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

const BUCKET = "plans-specs";

const VALID_TYPES = new Set([
  "concrete_repair", "spall_repair", "rebar_treatment", "stucco_patch",
  "tuck_point", "pt_pocket", "window_sealant", "weep_hole",
  "waterproof_membrane", "other",
]);
const VALID_STATUS = new Set(["pending", "in_progress", "complete", "rejected"]);

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

async function isOwnerOrStaffToken(token: string): Promise<boolean> {
  // 1) Custom owner token minted by auth-token edge fn.
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const payload = await verify(token, key);
    if (payload?.iss === "plazacore-auth" && (payload?.user_role === "owner" || payload?.user_role === "staff")) {
      return true;
    }
  } catch { /* not a custom token; try native below */ }
  // 2) Native Supabase auth user whose profile is owner/staff.
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return false;
    const { data: prof } = await admin
      .from("profiles")
      .select("app_role, active")
      .eq("id", data.user.id)
      .maybeSingle();
    return !!prof && prof.active && (prof.app_role === "owner" || prof.app_role === "staff");
  } catch {
    return false;
  }
}

// --- helpers ----------------------------------------------------------------
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
function workbookToRows(bytes: Uint8Array): Record<string, unknown>[] {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const names = wb.SheetNames || [];
  const multi = names.length > 1;
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as Record<string, unknown>[];
    for (const r of rows) {
      // Skip completely empty rows.
      const hasVal = Object.values(r).some((v) => String(v ?? "").trim() !== "");
      if (!hasVal) continue;
      // Tag each row with its source tab so the LLM can distinguish tabs
      // (e.g. tower / building split across sheets).
      if (multi) out.push({ __sheet: name, ...r });
      else out.push(r);
    }
  }
  return out;
}

const SYSTEM_PROMPT =
  "You are a structural-repair quantity analyst for Plaza and Associates (special " +
  "inspection / concrete restoration). You receive the raw rows of a spreadsheet of " +
  "field-measured repair quantities, organized by building STACK (a vertical column of " +
  "stacked units/balconies) and, for multi-tower projects, by TOWER. Each row is one " +
  "repair observation at a FLOOR/LEVEL within a stack. Column names vary widely " +
  "('Stack'/'Stack No'/'Col', 'Tower'/'Building', 'Floor'/'Level'/'Fl', 'Type'/'Repair " +
  "Type'/'Scope', 'Width'/'W', 'Length'/'L'/'Len', 'Height'/'H', 'Depth'/'D'/'Thickness', " +
  "'Qty'/'SF'/'LF', 'Description'/'Location'/'Notes', 'Date', 'SI Ref'/'Report'). " +
  "Normalize each repair row into a clean line item. RULES: " +
  "(1) Map each repair to one repair_type KEY from this exact set: concrete_repair, " +
  "spall_repair, rebar_treatment, stucco_patch, tuck_point, pt_pocket, window_sealant, " +
  "weep_hole, waterproof_membrane, other. Infer from the text (e.g. 'spall'->spall_repair, " +
  "'caulk'/'sealant'->window_sealant, 'PT'->pt_pocket, 'weep'->weep_hole, 'membrane'/" +
  "'waterproofing'->waterproof_membrane, 'rebar'/'reinforcement'->rebar_treatment, " +
  "'stucco'->stucco_patch, 'tuck'->tuck_point; default concrete_repair if clearly a " +
  "patch/repair, else other). " +
  "(2) DIMENSIONS MUST BE IN INCHES. The app stores length_in (the width), height_in " +
  "(the length/height), depth_in (thickness, optional). Convert feet->inches (x12) if the " +
  "sheet is in feet. For AREA types put the two planar dimensions in length_in & height_in. " +
  "For LINEAR types (tuck_point, window_sealant) put the run length in length_in and leave " +
  "height_in null. For COUNT types (pt_pocket, weep_hole) leave dimensions null and put the " +
  "count in qty_override. " +
  "(3) If the sheet gives a precomputed quantity (SF/LF/EA) but NOT dimensions, set " +
  "qty_override to that number and leave length_in/height_in/depth_in null. " +
  "(4) stack_label: the stack identifier as a SHORT label (e.g. 'Stack 1', 'A', '12'). " +
  "Preserve the contractor's naming. tower: 'Park'/'River'/building name or null. " +
  "If a row has a '__sheet' field, that is the source worksheet TAB name — the workbook " +
  "has multiple tabs. Treat the tab name as context: if it names a tower/building/stack " +
  "(e.g. 'River Tower','Stack A','Bldg 2'), use it to fill tower/stack_label when the row " +
  "itself lacks that column. Do NOT emit '__sheet' as a line item. " +
  "floor_level: e.g. '1F','7F','PH','PENTHOUSE' or null. " +
  "(5) status: map 'done'/'complete'/'repaired'->complete, 'in progress'/'WIP'->in_progress, " +
  "else pending. date_observed/date_repaired -> ISO YYYY-MM-DD or null. " +
  "(6) Drop header rows, blank rows, and pure subtotal/total rows. Keep original order via sort_order (0-based). " +
  "Respond ONLY with a single minified JSON object, no prose, no markdown, of shape: " +
  '{"items":[{"tower":"string|null","stack_label":"string","floor_level":"string|null",' +
  '"repair_type":"<key>","description":"string|null","length_in":number|null,' +
  '"height_in":number|null,"depth_in":number|null,"qty_override":number|null,' +
  '"unit_hint":"area|linear|count|null","status":"pending|in_progress|complete|rejected",' +
  '"si_report_ref":"string|null","date_observed":"YYYY-MM-DD|null",' +
  '"date_repaired":"YYYY-MM-DD|null","notes":"string|null","sort_order":number}],' +
  '"stacks":["unique stack_label values, in order"],"towers":["unique tower values"],' +
  '"summary":"one-line plain-English summary","confidence":number,"warnings":["string"]} ' +
  "where confidence is 0..1.";

async function llmNormalize(rows: unknown, fileName: string): Promise<any> {
  const rowsJson = JSON.stringify(rows).slice(0, 180000);
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: `Repair-quantity spreadsheet: ${fileName}. Raw rows (JSON):\n${rowsJson}\n\nNormalize per your instructions.`,
        }],
      }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`llm_failed ${resp.status}: ${t.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
  const stopReason = data?.stop_reason || null;
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const salvaged = salvageTruncatedItems(cleaned);
    if (!salvaged) throw e;
    parsed = salvaged;
    parsed.warnings = [
      ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
      `Sheet was very large; analysis was truncated${stopReason === "max_tokens" ? " (hit token limit)" : ""} and recovered ${parsed.items?.length || 0} complete items. Some trailing rows may be missing — split the file and re-upload.`,
    ];
    parsed.confidence = Math.min(Number(parsed.confidence) || 0.5, 0.5);
  }
  parsed.model = LLM_MODEL;
  return parsed;
}

// Recover items from a truncated/unterminated JSON "items":[ ... ] array.
function salvageTruncatedItems(raw: string): any | null {
  const key = raw.indexOf('"items"');
  if (key === -1) return null;
  const arrStart = raw.indexOf("[", key);
  if (arrStart === -1) return null;
  const objs: string[] = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = arrStart + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) objStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) { objs.push(raw.slice(objStart, i + 1)); objStart = -1; }
    } else if (ch === "]" && depth === 0) break;
  }
  const items: any[] = [];
  for (const o of objs) { try { items.push(JSON.parse(o)); } catch { /* skip partial */ } }
  if (!items.length) return null;
  const stacks = [...new Set(items.map((it) => it.stack_label).filter(Boolean))];
  const towers = [...new Set(items.map((it) => it.tower).filter(Boolean))];
  return { items, stacks, towers, summary: `Recovered ${items.length} repair items.`, confidence: 0.5, warnings: [] };
}

// Sanitize/clamp the normalized analysis before storing.
function sanitize(parsed: any): any {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const clean = items.map((it: any, idx: number) => {
    let rt = String(it.repair_type || "").trim();
    if (!VALID_TYPES.has(rt)) rt = "concrete_repair";
    let st = String(it.status || "pending").trim();
    if (!VALID_STATUS.has(st)) st = "pending";
    return {
      tower: it.tower ? String(it.tower).trim() : null,
      stack_label: it.stack_label ? String(it.stack_label).trim() : null,
      floor_level: it.floor_level ? String(it.floor_level).trim() : null,
      repair_type: rt,
      description: it.description ? String(it.description).trim() : null,
      length_in: num(it.length_in),
      height_in: num(it.height_in),
      depth_in: num(it.depth_in),
      qty_override: num(it.qty_override),
      unit_hint: it.unit_hint && ["area", "linear", "count"].includes(it.unit_hint) ? it.unit_hint : null,
      status: st,
      si_report_ref: it.si_report_ref ? String(it.si_report_ref).trim() : null,
      date_observed: toISODate(it.date_observed),
      date_repaired: toISODate(it.date_repaired),
      notes: it.notes ? String(it.notes).trim() : null,
      sort_order: Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : idx,
    };
  }).filter((it: any) => it.stack_label); // every repair must belong to a stack
  const stacks = [...new Set(clean.map((c: any) => c.stack_label))];
  const towers = [...new Set(clean.map((c: any) => c.tower).filter(Boolean))];
  return {
    items: clean,
    stacks,
    towers,
    summary: parsed.summary ? String(parsed.summary) : `Parsed ${clean.length} repair items across ${stacks.length} stack(s).`,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.8)),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
    model: parsed.model || LLM_MODEL,
  };
}

Deno.serve(async (req: Request) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const J = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

  if (req.method !== "POST") return J({ error: "method_not_allowed" }, 405);
  if (!LLM_API_KEY) return J({ error: "analyzer_not_configured" }, 400);

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !(await isOwnerOrStaffToken(token))) return J({ error: "forbidden_owner_only" }, 403);

  let importId = "";
  try { importId = (await req.json())?.import_id || ""; } catch { /* */ }
  if (!importId) return J({ error: "missing_import_id" }, 400);

  const { data: imp, error: impErr } = await admin
    .from("quantity_imports").select("*").eq("id", importId).maybeSingle();
  if (impErr || !imp) return J({ error: "import_not_found" }, 404);
  if (!imp.file_path) return J({ error: "no_file" }, 400);

  const fmt = (imp.file_name || imp.file_path || "").toLowerCase();
  if (!/\.(xlsx|xls|csv)$/.test(fmt)) return J({ error: "unsupported_format" }, 400);

  await admin.from("quantity_imports").update({ status: "analyzing" }).eq("id", importId);

  try {
    const { data: file, error: dlErr } = await admin.storage.from(BUCKET).download(imp.file_path);
    if (dlErr || !file) throw new Error("download_failed");
    const bytes = new Uint8Array(await file.arrayBuffer());

    const rows = workbookToRows(bytes);
    if (!rows.length) throw new Error("parse_failed: empty sheet");

    const normalized = await llmNormalize(rows, imp.file_name || "import.xlsx");
    const analysis = sanitize(normalized);
    if (!analysis.items.length) throw new Error("parse_failed: no repair rows recognized");

    await admin.from("quantity_imports").update({
      status: "analyzed",
      analysis,
      item_count: analysis.items.length,
      source_format: fmt.replace(/.*\./, ""),
      analyzed_by: "edge",
      analyzed_at: new Date().toISOString(),
      error_detail: null,
    }).eq("id", importId);

    return J({
      ok: true,
      item_count: analysis.items.length,
      stacks: analysis.stacks,
      summary: analysis.summary,
      confidence: analysis.confidence,
      warnings: analysis.warnings,
    });
  } catch (e) {
    const detail = String((e as Error)?.message || e);
    await admin.from("quantity_imports").update({
      status: "failed", error_detail: detail.slice(0, 500),
    }).eq("id", importId);
    const code = detail.startsWith("download_failed") ? "download_failed"
      : detail.startsWith("parse_failed") ? "parse_failed"
      : detail.startsWith("llm_failed") ? "llm_failed" : "parse_failed";
    return J({ error: code, detail }, 400);
  }
});
