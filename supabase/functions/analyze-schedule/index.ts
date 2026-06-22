// Supabase Edge Function: analyze-schedule
// =====================================================================
// Given a schedule_imports.id, downloads the uploaded schedule file from the
// private `schedule-imports` bucket, parses it into a normalized task list, and
// writes the result back onto the schedule_imports row (analysis jsonb).
//
// It does NOT create schedule_tasks rows — the frontend reviews the analysis and
// the owner clicks "Apply" to materialize tasks (so a re-import can be reviewed
// before it overwrites the live Gantt). This mirrors analyze-co (LLM key stays
// server-side, owner stays in control of the write).
//
// Supported source formats (what contractors actually export from Microsoft):
//   * .xlsx / .xls  — MS Project "Export to Excel", Project-for-web Excel export,
//                     or a Planner/Teams task export. Parsed with SheetJS into
//                     rows, then normalized by Claude (handles arbitrary column
//                     layouts: Task Name / Start / Finish / % Complete / WBS /
//                     Predecessors / Duration / Outline Level).
//   * .csv          — MS Project CSV export. Same path as XLSX.
//   * .xml          — MS Project XML (the universal, lossless MSP schema). Parsed
//                     deterministically (Task UID/Name/Start/Finish/PercentComplete/
//                     OutlineLevel/Milestone/Summary/PredecessorLink), Claude only
//                     used to fill gaps / summarize.
//   * .pdf          — Gantt/Timeline PDF printout. Sent to Claude as a document.
//
// Deploy:  supabase functions deploy analyze-schedule --no-verify-jwt
// Secrets (reuses the CO analyzer key):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto-injected)
//   JWT_SECRET                 (owner custom-token verification — already set)
//   CO_LLM_API_KEY             (Anthropic key — REQUIRED, already set for analyze-co)
//   CO_LLM_MODEL               (optional; default claude-sonnet-4-5)
//
// Request (POST JSON), owner's app JWT in Authorization header:
//   { "import_id": "<uuid>" }
// Response:
//   200 { ok:true, task_count, project_start, project_finish, summary, confidence, warnings }
//   4xx { error:"<reason>" }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

async function isCustomOwnerToken(token: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const payload = await verify(token, key);
    return payload?.iss === "plazacore-auth" && payload?.user_role === "owner";
  } catch {
    return false;
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

// --- date helpers -----------------------------------------------------------
function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // MS Project XML datetime: 2026-06-15T08:00:00
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

// --- MS Project XML deterministic parse -------------------------------------
// The MSP XML schema is stable: <Tasks><Task>...<UID><Name><Start><Finish>
// <PercentComplete><OutlineLevel><Milestone><Summary><PredecessorLink>.
function parseMsprojectXml(text: string): any {
  const tasks: any[] = [];
  const taskBlocks = text.match(/<Task>[\s\S]*?<\/Task>/g) || [];
  const grab = (block: string, tag: string): string | null => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };
  for (const b of taskBlocks) {
    const name = grab(b, "Name");
    if (!name) continue; // skip the project summary / blank rows
    // predecessors: one or more <PredecessorLink><PredecessorUID>n</...><Type>t</Type>...
    const predLinks = b.match(/<PredecessorLink>[\s\S]*?<\/PredecessorLink>/g) || [];
    const TYPE = ["FF", "FS", "SF", "SS"]; // MSP Type codes 0..3
    const preds = predLinks.map((pl) => {
      const uid = grab(pl, "PredecessorUID");
      const type = grab(pl, "Type");
      const lag = num(grab(pl, "LinkLag"));
      const t = type != null ? (TYPE[Number(type)] || "FS") : "FS";
      const lagD = lag ? `${lag > 0 ? "+" : ""}${Math.round(lag / 4800)}d` : ""; // tenths of min -> days approx
      return uid ? `${uid}${t}${lagD}` : "";
    }).filter(Boolean).join(", ");
    tasks.push({
      uid: grab(b, "UID"),
      wbs: grab(b, "WBS"),
      outline_level: num(grab(b, "OutlineLevel")) || 1,
      is_summary: grab(b, "Summary") === "1",
      is_milestone: grab(b, "Milestone") === "1",
      name,
      start: toISODate(grab(b, "Start")),
      finish: toISODate(grab(b, "Finish")),
      pct_complete: num(grab(b, "PercentComplete")),
      predecessors: preds || null,
      notes: grab(b, "Notes"),
    });
  }
  const starts = tasks.map((t) => t.start).filter(Boolean).sort();
  const finishes = tasks.map((t) => t.finish).filter(Boolean).sort();
  return {
    tasks,
    project_start: starts[0] || null,
    project_finish: finishes[finishes.length - 1] || null,
    summary: `Parsed ${tasks.length} tasks from MS Project XML.`,
    confidence: 0.98,
    model: "deterministic-xml",
    warnings: [],
  };
}

// --- XLSX/CSV -> rows of plain objects --------------------------------------
function workbookToRows(bytes: Uint8Array): Record<string, unknown>[] {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

const SYSTEM_PROMPT =
  "You are a construction scheduling analyst for Plaza and Associates (structural " +
  "engineering / special inspection / owner's-rep). You receive the raw rows of a " +
  "project schedule that a contractor exported from Microsoft Project, Project for " +
  "the web, or Microsoft Planner/Teams (column names vary widely: 'Task Name'/'Name'/" +
  "'Activity', 'Start'/'Start Date', 'Finish'/'End Date'/'Due', '% Complete'/'Percent " +
  "Complete', 'WBS', 'Outline Level', 'Duration', 'Predecessors'/'Depends On', " +
  "'Resource Names'/'Assigned To', 'Milestone', 'Summary'). Normalize them into a " +
  "clean task list for a Gantt chart. Rules: (1) Infer which columns map to each field. " +
  "(2) Dates -> ISO YYYY-MM-DD. (3) Keep the original row order via sort_order (0-based). " +
  "(4) outline_level: 1 for top-level; deeper for indented subtasks (infer from WBS dots " +
  "or an Outline Level column; default 1). (5) is_summary=true for parent/summary rows; " +
  "is_milestone=true for zero-duration milestones. (6) pct_complete is a number 0-100. " +
  "(7) predecessors: keep the original dependency string if present (e.g. '12FS+2d'). " +
  "(8) Drop blank rows and the project-title row. " +
  "Respond ONLY with a single minified JSON object, no prose, no markdown, of shape: " +
  '{"tasks":[{"uid":"string|null","wbs":"string|null","outline_level":number,' +
  '"is_summary":boolean,"is_milestone":boolean,"name":"string","start":"YYYY-MM-DD|null",' +
  '"finish":"YYYY-MM-DD|null","duration_days":number|null,"pct_complete":number,' +
  '"predecessors":"string|null","assigned_to":"string|null","notes":"string|null",' +
  '"sort_order":number}],"project_start":"YYYY-MM-DD|null","project_finish":"YYYY-MM-DD|null",' +
  '"data_date":"YYYY-MM-DD|null","summary":"one-line plain-English schedule summary",' +
  '"confidence":number,"warnings":["string"]} where confidence is 0..1.';

async function llmNormalize(payload: { kind: "rows" | "pdf"; rows?: unknown; b64?: string }, fileName: string): Promise<any> {
  const content: any[] = [];
  if (payload.kind === "pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: payload.b64 } });
    content.push({ type: "text", text: `This is a project schedule PDF (${fileName}). Extract and normalize the task/Gantt rows per your instructions.` });
  } else {
    const rowsJson = JSON.stringify(payload.rows).slice(0, 180000);
    content.push({ type: "text", text: `Schedule file: ${fileName}. Raw rows (JSON):\n${rowsJson}\n\nNormalize per your instructions.` });
  }
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
      messages: [{ role: "user", content }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`llm_failed ${resp.status}: ${t.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  parsed.model = LLM_MODEL;
  return parsed;
}

function normalizeAnalysis(a: any): any {
  const rawTasks = Array.isArray(a?.tasks) ? a.tasks : [];
  const tasks = rawTasks.map((t: any, i: number) => ({
    uid: t?.uid != null ? String(t.uid) : null,
    wbs: t?.wbs != null && t.wbs !== "" ? String(t.wbs) : null,
    outline_level: Math.max(1, Number(t?.outline_level) || 1),
    is_summary: t?.is_summary === true,
    is_milestone: t?.is_milestone === true,
    name: String(t?.name || "").trim() || "(unnamed task)",
    start: toISODate(t?.start),
    finish: toISODate(t?.finish),
    duration_days: t?.duration_days != null && t.duration_days !== "" ? Number(t.duration_days) : null,
    pct_complete: Math.max(0, Math.min(100, Number(t?.pct_complete) || 0)),
    predecessors: t?.predecessors ? String(t.predecessors) : null,
    assigned_to: t?.assigned_to ? String(t.assigned_to) : null,
    notes: t?.notes ? String(t.notes) : null,
    sort_order: Number.isFinite(Number(t?.sort_order)) ? Number(t.sort_order) : i,
  })).filter((t: any) => t.name && t.name !== "(unnamed task)");
  const starts = tasks.map((t: any) => t.start).filter(Boolean).sort();
  const finishes = tasks.map((t: any) => t.finish).filter(Boolean).sort();
  return {
    tasks,
    project_start: toISODate(a?.project_start) || starts[0] || null,
    project_finish: toISODate(a?.project_finish) || finishes[finishes.length - 1] || null,
    data_date: toISODate(a?.data_date),
    summary: String(a?.summary || `Parsed ${tasks.length} schedule tasks.`),
    confidence: Math.max(0, Math.min(1, Number(a?.confidence) || 0.7)),
    model: a?.model || LLM_MODEL,
    warnings: Array.isArray(a?.warnings) ? a.warnings.map(String) : [],
  };
}

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

  // 1. Owner auth (dual path: custom owner token OR native owner profile)
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);

  let analyzedBy = "owner";
  const customOwner = await isCustomOwnerToken(token);
  if (!customOwner) {
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
    if (!prof || !(prof.app_role === "owner" || prof.app_role === "staff") || prof.active === false) {
      return json({ error: "forbidden_owner_only" }, 403);
    }
    analyzedBy = prof.full_name || prof.email || "owner";
  }

  // 2. Input
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const importId = String(body.import_id || "").trim();
  if (!importId) return json({ error: "import_id_required" }, 400);

  // 3. Load the import row
  const { data: imp, error: impErr } = await admin
    .from("schedule_imports")
    .select("id, project_id, file_path, file_name, source_format, file_type")
    .eq("id", importId)
    .maybeSingle();
  if (impErr) return json({ error: "import_lookup_failed" }, 500);
  if (!imp) return json({ error: "import_not_found" }, 404);
  if (!imp.file_path) return json({ error: "no_file" }, 422);

  await admin.from("schedule_imports").update({ status: "analyzing" }).eq("id", importId);

  // 4. Download the file bytes.
  // NOTE: the deployed app uploads schedule files to the existing `plans-specs`
  // bucket under `<project_id>/schedule/<ts>_<name>` (the dedicated
  // `schedule-imports` bucket in the original design was never created).
  const SCHEDULE_BUCKET = "plans-specs";
  const dlPath = String(imp.file_path).replace(/^plans-specs\//, "");
  const { data: blob, error: dlErr } = await admin.storage
    .from(SCHEDULE_BUCKET)
    .download(dlPath);
  if (dlErr || !blob) {
    await admin.from("schedule_imports").update({ status: "failed", error_detail: dlErr?.message || "download_failed" }).eq("id", importId);
    return json({ error: "download_failed", detail: dlErr?.message }, 500);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = (imp.file_name || imp.file_path).toLowerCase();
  const fmt = (imp.source_format || imp.file_type || "").toLowerCase().replace(/[^a-z]/g, "") ||
    (name.endsWith(".xml") ? "xml" : name.endsWith(".csv") ? "csv"
      : name.endsWith(".pdf") ? "pdf" : (name.endsWith(".xlsx") || name.endsWith(".xls")) ? "xlsx" : "");

  // 5. Parse per format
  let analysis: any;
  try {
    if (fmt === "xml") {
      const text = new TextDecoder().decode(bytes);
      const det = parseMsprojectXml(text);
      // If the deterministic parse found tasks, use it; else fall back to LLM on the raw text.
      if (det.tasks.length) {
        analysis = normalizeAnalysis(det);
      } else {
        analysis = normalizeAnalysis(await llmNormalize({ kind: "rows", rows: text.slice(0, 180000) }, name));
      }
    } else if (fmt === "pdf") {
      analysis = normalizeAnalysis(await llmNormalize({ kind: "pdf", b64: bytesToBase64(bytes) }, name));
    } else if (fmt === "csv" || fmt === "xlsx") {
      const rows = workbookToRows(bytes);
      if (!rows.length) throw new Error("no_rows_found_in_file");
      analysis = normalizeAnalysis(await llmNormalize({ kind: "rows", rows }, name));
    } else {
      await admin.from("schedule_imports").update({ status: "failed", error_detail: "unsupported_format" }).eq("id", importId);
      return json({ error: "unsupported_format", detail: "Upload .xlsx, .csv, MS Project .xml, or a schedule .pdf." }, 422);
    }
  } catch (e) {
    const detail = String(e).slice(0, 400);
    await admin.from("schedule_imports").update({ status: "failed", error_detail: detail }).eq("id", importId);
    return json({ error: "parse_failed", detail }, 502);
  }

  // 6. Persist analysis onto the import row
  const { error: upErr } = await admin
    .from("schedule_imports")
    .update({
      status: "analyzed",
      analysis,
      task_count: analysis.tasks.length,
      source_format: fmt,
      analyzed_at: new Date().toISOString(),
      analyzed_by: analyzedBy,
      error_detail: null,
    })
    .eq("id", importId);
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  return json({
    ok: true,
    task_count: analysis.tasks.length,
    project_start: analysis.project_start,
    project_finish: analysis.project_finish,
    summary: analysis.summary,
    confidence: analysis.confidence,
    warnings: analysis.warnings,
  });
});
