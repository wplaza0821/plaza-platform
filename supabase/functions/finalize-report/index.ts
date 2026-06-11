// Supabase Edge Function: finalize-report
// Phase 4 · Seals an SI / field-observation report into an immutable PDF of
// record. Generates HTML -> PDF, computes sha256 of the bytes, stores the PDF
// in the private `field-reports` bucket, writes an append-only report_seals
// row, and flips field_reports.finalized=true (the DB trigger then locks
// content edits). OWNER ONLY — these carry Tomas E. Hernandez PE seal and are
// AHJ-submittable / subpoena-eligible.
//
// Deploy:  supabase functions deploy finalize-report --no-verify-jwt
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto-injected)
//   PDF_RENDER_URL   (optional) external HTML->PDF render endpoint that accepts
//                    { html } and returns application/pdf bytes. If unset, the
//                    function stores the sealed HTML + hash and marks the report
//                    finalized with content_type text/html (still immutable +
//                    hashed); a follow-up worker can rasterize to PDF.
//
// Request (POST JSON), owner's app JWT in Authorization header:
//   { "field_report_id": "<uuid>", "signature_path": "<storage path>"?(optional) }
// Response:
//   200 { ok:true, pdf_path, sha256, seal_id }
//   4xx { error:"<reason>" }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const PDF_RENDER_URL = Deno.env.get("PDF_RENDER_URL") || "";
const APP_URL = "https://plazacore.plazaandassociates.com";
const ALLOWED_ORIGINS = [APP_URL, "https://wplaza0821.github.io"];
function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : APP_URL;
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Build the sealed report HTML (server-side; deterministic source of record).
function buildHtml(r: any, projectName: string, checklistRows: string, generatedAt: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Georgia,serif;margin:48px;color:#111}
    h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #999}
    .meta{font-size:12px;color:#333}.kv{margin:2px 0}table{width:100%;border-collapse:collapse;font-size:12px}
    td,th{border:1px solid #bbb;padding:4px 6px;text-align:left}.seal{margin-top:40px;border-top:2px solid #111;padding-top:10px;font-size:12px}
    .hash{font-family:monospace;font-size:10px;color:#666;margin-top:8px;word-break:break-all}
  </style></head><body>
  <h1>${esc(r.report_type === "special_inspection" ? "Special Inspection Report" : "Field Observation Report")}</h1>
  <div class="meta">
    <div class="kv"><b>Report No:</b> ${esc(r.report_number)}</div>
    <div class="kv"><b>Project:</b> ${esc(projectName)}</div>
    <div class="kv"><b>Visit Date:</b> ${esc(r.visit_date)}</div>
    <div class="kv"><b>Inspector:</b> ${esc(r.inspector)}</div>
    <div class="kv"><b>Weather:</b> ${esc(r.weather)} ${esc(r.temp_range)}</div>
    <div class="kv"><b>Compliance:</b> ${esc(r.compliance)}</div>
  </div>
  <h2>Work Observed</h2><div>${esc(r.work_observed)}</div>
  <h2>Findings</h2><div>${esc(r.findings)}</div>
  ${checklistRows ? `<h2>Inspection Checklist</h2><table><tr><th>Item</th><th>Code Ref</th><th>Result</th><th>Note</th></tr>${checklistRows}</table>` : ""}
  <h2>Deficiencies Noted</h2><div>${esc(r.deficiencies_noted)}</div>
  <h2>Recommendations</h2><div>${esc(r.recommendations)}</div>
  <div class="seal">
    <div><b>${esc(r.seal_inspector || "Tomas E. Hernandez, PE")}</b> — ${esc(r.seal_license || "SI #62469")}</div>
    <div>Plaza and Associates · 2222 Ponce de Leon Boulevard, Coral Gables, FL 33134</div>
    <div>Finalized: ${esc(generatedAt)}</div>
  </div>
  </body></html>`;
}

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Validate caller + require OWNER role (claim from JWT).
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
  // user_role claim is injected by plz_access_token_hook.
  const role = (userData.user.app_metadata as any)?.user_role
            ?? (userData.user.user_metadata as any)?.user_role ?? "";
  // Fall back to profiles lookup if claim absent.
  let isOwner = role === "owner";
  if (!isOwner) {
    const { data: prof } = await admin.from("profiles").select("app_role").eq("id", userData.user.id).maybeSingle();
    isOwner = prof?.app_role === "owner";
  }
  if (!isOwner) return json({ error: "owner_only" }, 403);

  // 2. Parse input
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const frId = String(payload.field_report_id || "").trim();
  if (!UUID_RE.test(frId)) return json({ error: "valid_field_report_id_required" }, 400);

  // 3. Load report (service role)
  const { data: r, error: rErr } = await admin
    .from("field_reports").select("*").eq("id", frId).maybeSingle();
  if (rErr) return json({ error: "report_lookup_failed" }, 500);
  if (!r) return json({ error: "report_not_found" }, 404);
  if (r.finalized === true) return json({ error: "already_finalized" }, 409);

  let projectName = "Project";
  if (r.project_id) {
    const { data: p } = await admin.from("projects").select("name, code").eq("id", r.project_id).maybeSingle();
    if (p) projectName = p.name || p.code || projectName;
  }

  // Render checklist rows from the filled checklist jsonb (if any).
  let checklistRows = "";
  let pass = 0, fail = 0, na = 0;
  try {
    const items = Array.isArray(r.checklist) ? r.checklist : [];
    for (const it of items) {
      const res = String(it.result ?? it.value ?? "");
      if (/^pass$/i.test(res)) pass++; else if (/^fail$/i.test(res)) fail++; else if (/^n\/?a$/i.test(res)) na++;
      checklistRows += `<tr><td>${esc(it.label ?? it.key)}</td><td>${esc(it.code_ref ?? "")}</td><td>${esc(res)}</td><td>${esc(it.note ?? "")}</td></tr>`;
    }
  } catch (_e) { /* tolerate malformed checklist */ }

  const generatedAt = new Date().toISOString();
  const html = buildHtml(r, projectName, checklistRows, generatedAt);

  // 4. Produce bytes: PDF if a renderer is configured, else sealed HTML.
  let bytes: Uint8Array;
  let contentType: string;
  let ext: string;
  if (PDF_RENDER_URL) {
    try {
      const rendered = await fetch(PDF_RENDER_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ html }),
      });
      if (!rendered.ok) return json({ error: "pdf_render_failed" }, 502);
      bytes = new Uint8Array(await rendered.arrayBuffer());
      contentType = "application/pdf"; ext = "pdf";
    } catch (_e) { return json({ error: "pdf_render_unreachable" }, 502); }
  } else {
    bytes = new TextEncoder().encode(html);
    contentType = "text/html"; ext = "html";
  }

  const sha = await sha256Hex(bytes);
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const pdfPath = `${r.project_id}/${esc(r.report_number || frId)}-${stamp}.${ext}`;

  // 5. Upload to private bucket (service role)
  const up = await admin.storage.from("field-reports").upload(pdfPath, bytes, {
    contentType, upsert: false,
  });
  if (up.error) return json({ error: "storage_upload_failed", detail: up.error.message }, 500);

  // 6. Append-only seal record
  const { data: seal, error: sealErr } = await admin.from("report_seals").insert({
    field_report_id: frId, project_id: r.project_id, pdf_path: pdfPath, sha256: sha,
    inspector: r.seal_inspector || "Tomas E. Hernandez, PE",
    license: r.seal_license || "SI #62469", sealed_by: userData.user.id,
  }).select("id").single();
  if (sealErr) return json({ error: "seal_insert_failed" }, 500);

  // 7. Flip finalized flags (trigger locks content from here on)
  const { error: finErr } = await admin.from("field_reports").update({
    finalized: true, finalized_at: generatedAt, finalized_by: userData.user.id,
    finalized_pdf_path: pdfPath, finalized_hash: sha,
    pass_count: pass, fail_count: fail, na_count: na,
    signature_path: (payload.signature_path ? String(payload.signature_path) : r.signature_path) ?? null,
    status: "approved",
  }).eq("id", frId);
  if (finErr) return json({ error: "finalize_update_failed", detail: finErr.message }, 500);

  // NOTE: a Dropbox copy of the sealed file should also be written by the
  // existing report-sync pipeline so Dropbox remains canonical seal-of-record.
  return json({ ok: true, pdf_path: pdfPath, sha256: sha, seal_id: seal.id, content_type: contentType });
});
