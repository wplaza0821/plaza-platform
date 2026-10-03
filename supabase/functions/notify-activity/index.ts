// Supabase Edge Function: notify-activity
// Phase 5 · Project-wide activity fan-out. Fires on ANY upload/action in a
// project and notifies the standing recipients: PM (projects.pm_id) + Client
// (projects.client_id) + the project_members team for that same project_id,
// plus the explicit assignee when the record has one. Contractors are excluded
// from pay_apps/change_orders unless assigned. Recipients are always resolved
// from the record's own project_id — never across projects.
//
// Called by Postgres AFTER INSERT/UPDATE triggers via pg_net (service-role
// context), so it cannot be bypassed by writing through the API directly.
// The trigger passes only identifiers; this fn re-loads the record with the
// service role and never trusts client content.
//
// Deploy:  supabase functions deploy notify-activity --no-verify-jwt
//
// Secrets/env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), RESEND_API_KEY,
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
//
// Request (POST JSON), shared-secret in x-notify-secret header:
//   { "ref_table": "<table>", "ref_id": "<uuid>",
//     "event": "insert"|"update" (trigger, lower(TG_OP)) or "created"|"updated",
//     "actor_id": "<uuid|null>" }
// The trigger only fires an UPDATE when `status` changed, so every update here
// is a workflow transition (e.g. submittal Rejected, RFI Answered).
//
// Procore-style workflow messages (2026-10-03): submittals and RFIs get a
// status-specific subject ("Submittal Rejected — Resubmit Required"), a details
// table, the reviewer's comments / official answer, and a per-recipient action
// line (the responsible contractor sees "Action required"; everyone else gets
// it FYI). Header `x-notify-dry-run: 1` (with the secret) renders the messages
// and returns them without sending, inserting, or auditing — for testing.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = (Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const NOTIFY_SECRET = Deno.env.get("NOTIFY_TRIGGER_SECRET") || "";
const APP_URL = "https://plazacore.plazaandassociates.com";
// NOTE: must send from the Resend-VERIFIED domain. Resend was set up on the
// `send.` subdomain (SES SPF + feedback MX + DKIM live there). Sending from the
// bare root (info@plazaandassociates.com) fails SPF (root SPF is Proofpoint/
// GoDaddy with -all and does NOT include Resend/SES), so recipients silently
// junked/dropped the mail even though Resend's API returned 2xx ("sent").
const FROM = Deno.env.get("NOTIFY_FROM") || "Plaza & Associates <info@plazaandassociates.com>";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Per-table: friendly label, how to build a title, link anchor, optional assignee col.
function projectionFor(table: string): null | {
  cols: string; label: string; title: (r: any) => string; link: string; assignee?: string;
} {
  switch (table) {
    case "pay_apps":
      return { cols: "id, project_id, pay_app_number, status",
        label: "Payment Application", link: "#payapps",
        title: (r) => `Pay App #${r.pay_app_number ?? ""}` };
    case "submittals":
      return { cols: "id, project_id, submittal_number, description, spec_section, status, assigned_to, ball_in_court, revision, reviewer, reviewed_at, due_date, notes, submitted_by, submitted_at",
        label: "Submittal", link: "#submittals", assignee: "assigned_to",
        title: (r) => `${r.submittal_number ?? ""} Rev ${r.revision ?? 0}${r.description ? ": " + r.description : ""}` };
    case "change_orders":
      return { cols: "id, project_id, co_number, description, status",
        label: "Change Order", link: "#cos",
        title: (r) => `CO-${String(r.co_number ?? "").padStart(3, "0")}${r.description ? ": " + r.description : ""}` };
    case "rfis":
      return { cols: "id, project_id, rfi_number, subject, question, reference, priority, from_party, to_party, status, assigned_to, ball_in_court, due_date, answer, answered_by, answered_at",
        label: "RFI", link: "#rfis", assignee: "assigned_to",
        title: (r) => `RFI-${String(r.rfi_number ?? "").padStart(3, "0")}${r.subject ? ": " + r.subject : ""}` };
    case "deficiencies":
      return { cols: "id, project_id, deficiency_no, description, status, responsible_party",
        label: "Deficiency", link: "#deficiencies", assignee: "responsible_party",
        title: (r) => `Deficiency ${r.deficiency_no ?? ""}${r.description ? ": " + r.description : ""}` };
    case "daily_reports":
      return { cols: "id, project_id, status", label: "Daily Report", link: "#daily",
        title: (r) => `Daily Report` };
    case "photos":
      return { cols: "id, project_id, file_name", label: "Photo", link: "#photos",
        title: (r) => `Photo${r.file_name ? ": " + r.file_name : ""}` };
    case "documents":
      return { cols: "id, project_id, name, status", label: "Document", link: "#docs",
        title: (r) => `Document${r.name ? ": " + r.name : ""}` };
    case "field_reports":
      return { cols: "id, project_id, report_number, file_name, status", label: "Field Report", link: "#fieldreports",
        title: (r) => `Field Report ${r.report_number ?? ""}` };
    case "tasks":
      return { cols: "id, project_id, title, description, status, assigned_to", label: "Task", link: "#tasks", assignee: "assigned_to",
        title: (r) => `Task${r.title ? ": " + r.title : ""}` };
    case "milestones":
      return { cols: "id, project_id, name, description, status", label: "Milestone", link: "#milestones",
        title: (r) => `Milestone${r.name ? ": " + r.name : ""}` };
    case "plan_markups":
      return { cols: "id, project_id", label: "Plan Markup", link: "#docs",
        title: (_r) => `Plan markup` };
    default:
      return null;
  }
}

async function sendEmail(to: string, subject: string, html: string): Promise<string> {
  if (!RESEND_API_KEY) return "skipped";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.log("RESEND_FAIL", r.status, detail.slice(0, 400));
      return "failed";
    }
    return "sent";
  } catch (_e) { console.log("RESEND_EXC", String(_e).slice(0,200)); return "failed"; }
}

async function sendSms(to: string, body: string): Promise<string> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
  const auth = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
  const from = Deno.env.get("TWILIO_FROM") || "";
  if (!sid || !auth || !from) return "skipped";
  try {
    const form = new URLSearchParams();
    form.set("From", from); form.set("To", to); form.set("Body", body.slice(0, 320));
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${auth}`), "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); console.log("TWILIO_FAIL", r.status, t.slice(0,300)); return "failed"; }
    return "sent";
  } catch (_e) { console.log("TWILIO_EXC", String(_e).slice(0,200)); return "failed"; }
}

/* ---------------- Workflow message building (Procore-style) ---------------- */

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending Review", approved: "Approved", approved_as_noted: "Approved as Noted",
  revise_resubmit: "Revise & Resubmit", rejected: "Rejected",
  open: "Open", answered: "Answered", closed: "Closed", void: "Void",
  draft: "Draft", submitted: "Submitted", under_review: "Under Review", paid: "Paid",
  in_repair: "In Repair", repaired: "Repaired", verified: "Verified",
};
const statusLabel = (s: string) =>
  STATUS_LABEL[s] || (s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");
const STATUS_COLOR: Record<string, string> = {
  approved: "#15803d", approved_as_noted: "#15803d", answered: "#1d4ed8", closed: "#475569",
  rejected: "#b91c1c", revise_resubmit: "#b91c1c", pending: "#b45309", open: "#b45309",
};
const BIC_LABEL: Record<string, string> = { contractor: "Contractor", engineer: "Engineer (Plaza & Associates)", owner: "Owner" };
// Tables where a new row is a file, so "uploaded" is the right verb.
const UPLOAD_TABLES = new Set(["photos", "documents", "field_reports", "plan_markups", "daily_reports"]);

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtDate(v: unknown): string {
  if (!v) return "";
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return s;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

type Workflow = {
  subject: string;            // email subject / in-app title (without project suffix)
  statusText: string;         // e.g. "Rejected"
  statusColor: string;
  rows: [string, string][];   // details table
  commentsLabel?: string;
  comments?: string;          // reviewer comments / official answer
  contractorAction?: string;  // shown to the responsible contractor as "Action required"
  othersNote?: string;        // shown to everyone else
};

function buildWorkflow(table: string, label: string, title: string, created: boolean, r: any): Workflow {
  const st = String(r.status || "");
  const sLabel = statusLabel(st);
  const base: Workflow = { subject: "", statusText: sLabel, statusColor: STATUS_COLOR[st] || "#475569", rows: [] };

  if (table === "submittals") {
    base.rows = [
      ["Submittal", `${r.submittal_number ?? ""} — Revision ${r.revision ?? 0}`],
      ["Description", r.description || ""],
      ["Spec Section", r.spec_section || ""],
      ["Submitted By", r.submitted_by || ""],
      ["Submitted", fmtDate(r.submitted_at)],
      ["Reviewer", r.reviewer || ""],
      ["Reviewed", fmtDate(r.reviewed_at)],
      ["Ball in Court", BIC_LABEL[r.ball_in_court] || r.ball_in_court || ""],
      ["Response Due", fmtDate(r.due_date)],
    ];
    base.commentsLabel = "Reviewer Comments";
    base.comments = r.notes || "";
    if (created || st === "pending") {
      base.subject = created ? `New Submittal for Review: ${title}` : `Submittal Back in Review: ${title}`;
      base.othersNote = "This submittal is now with the engineer for review. You'll be notified when a response is issued.";
    } else if (st === "rejected") {
      base.subject = `Submittal Rejected — Resubmit Required: ${title}`;
      base.contractorAction = `Revise per the reviewer comments below and resubmit as Revision ${(Number(r.revision) || 0) + 1}${r.due_date ? ` by ${fmtDate(r.due_date)}` : ""}. Do not proceed with this work until a resubmittal is approved.`;
      base.othersNote = "The submittal was returned to the contractor for resubmittal.";
    } else if (st === "revise_resubmit") {
      base.subject = `Submittal Returned — Revise & Resubmit: ${title}`;
      base.contractorAction = `Revise per the reviewer comments below and resubmit as Revision ${(Number(r.revision) || 0) + 1}${r.due_date ? ` by ${fmtDate(r.due_date)}` : ""}.`;
      base.othersNote = "The submittal was returned to the contractor for revision.";
    } else if (st === "approved") {
      base.subject = `Submittal Approved: ${title}`;
      base.contractorAction = "Approved. You may proceed in accordance with the submittal and the contract documents.";
      base.othersNote = "The submittal was approved and is closed.";
    } else if (st === "approved_as_noted") {
      base.subject = `Submittal Approved as Noted: ${title}`;
      base.contractorAction = "Approved as noted. Proceed only after incorporating the reviewer comments below; no resubmittal is required unless a comment asks for one.";
      base.othersNote = "The submittal was approved with comments and is closed.";
    } else {
      base.subject = `Submittal ${sLabel}: ${title}`;
    }
    return base;
  }

  if (table === "rfis") {
    base.rows = [
      ["RFI", `RFI-${String(r.rfi_number ?? "").padStart(3, "0")}`],
      ["Subject", r.subject || ""],
      ["Priority", r.priority ? statusLabel(String(r.priority)) : ""],
      ["Reference", r.reference || ""],
      ["From", r.from_party || ""],
      ["To", r.to_party || ""],
      ["Response Due", fmtDate(r.due_date)],
    ];
    if (created || st === "open") {
      base.subject = created ? `New RFI${r.priority === "urgent" ? " (URGENT)" : ""}: ${title}` : `RFI Reopened: ${title}`;
      base.commentsLabel = "Question";
      base.comments = r.question || "";
      base.othersNote = `Awaiting an official response${r.due_date ? ` by ${fmtDate(r.due_date)}` : ""}.`;
    } else if (st === "answered") {
      base.subject = `RFI Answered: ${title}`;
      base.rows.push(["Answered By", r.answered_by || ""], ["Answered", fmtDate(r.answered_at)]);
      base.commentsLabel = "Official Response";
      base.comments = r.answer || "";
      base.contractorAction = "An official response has been issued. Review it below and proceed accordingly. If the response changes cost or time, submit a change order request before proceeding.";
    } else if (st === "closed") {
      base.subject = `RFI Closed: ${title}`;
      base.commentsLabel = "Official Response";
      base.comments = r.answer || "";
    } else {
      base.subject = `RFI ${sLabel}: ${title}`;
    }
    return base;
  }

  // Everything else: correct verb + status, no workflow-specific action.
  if (created) base.subject = UPLOAD_TABLES.has(table) ? `${label} uploaded: ${title}` : `New ${label}: ${title}`;
  else base.subject = `${label} ${sLabel || "updated"}: ${title}`;
  if (sLabel) base.rows = [["Status", sLabel]];
  return base;
}

function renderEmail(w: Workflow, opts: {
  name: string; projectName: string; actorName: string; linkUrl: string; action?: string; note?: string;
}): string {
  const rows = w.rows.filter(([, v]) => String(v || "").trim())
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#0f172a">${esc(v)}</td></tr>`)
    .join("");
  const actionBox = opts.action
    ? `<div style="border-left:4px solid ${w.statusColor};background:#f8fafc;padding:12px 14px;margin:16px 0"><div style="font-weight:700;color:${w.statusColor};margin-bottom:4px">Action required</div><div>${esc(opts.action)}</div></div>`
    : (opts.note ? `<p style="color:#334155">${esc(opts.note)}</p>` : "");
  const comments = w.comments && w.comments.trim()
    ? `<div style="margin:16px 0"><div style="font-weight:600;margin-bottom:6px">${esc(w.commentsLabel || "Comments")}</div><div style="white-space:pre-wrap;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;background:#fff">${esc(w.comments)}</div></div>`
    : "";
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#0f172a;max-width:640px">
    <p>Hi ${esc(opts.name || "there")},</p>
    <p style="margin:0 0 6px 0;color:#475569">${esc(opts.projectName)}</p>
    <p style="font-size:17px;font-weight:700;margin:0 0 10px 0">${esc(w.subject)}</p>
    ${w.statusText ? `<p style="margin:0 0 12px 0"><span style="display:inline-block;background:${w.statusColor};color:#fff;border-radius:999px;padding:3px 12px;font-size:13px;font-weight:600">${esc(w.statusText)}</span></p>` : ""}
    ${actionBox}
    ${rows ? `<table style="border-collapse:collapse;font-size:14px;margin:8px 0">${rows}</table>` : ""}
    ${comments}
    <p style="color:#64748b;font-size:13px">Issued by ${esc(opts.actorName)}.</p>
    <p style="margin-top:18px"><a href="${esc(opts.linkUrl)}" style="background:#0b5fff;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open in Plazacore</a></p>
    <p style="color:#94a3b8;font-size:12px;margin-top:22px">Plaza &amp; Associates · Plazacore</p>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Authn: shared secret from the DB trigger (not a user JWT).
  if (NOTIFY_SECRET && req.headers.get("x-notify-secret") !== NOTIFY_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const refTable = String(payload.ref_table || "").trim();
  const refId = String(payload.ref_id || "").trim();
  const event = String(payload.event || "created").trim();
  const actorId = String(payload.actor_id || "").trim();
  // The trigger sends lower(TG_OP) ("insert"/"update"); older callers sent
  // "created"/"updated". Anything that isn't an insert is a status transition.
  const created = event === "insert" || event === "created";
  const dryRun = req.headers.get("x-notify-dry-run") === "1";

  const proj = projectionFor(refTable);
  if (!proj) return json({ ok: true, skipped: "unmapped_table" });
  if (!UUID_RE.test(refId)) return json({ error: "valid_ref_id_required" }, 400);

  const { data: rec, error: recErr } = await admin.from(refTable).select(proj.cols).eq("id", refId).maybeSingle();
  if (recErr) return json({ error: "record_lookup_failed" }, 500);
  if (!rec) return json({ ok: true, skipped: "record_not_found" });

  const projectId = (rec as any).project_id || null;
  if (!projectId) return json({ ok: true, skipped: "no_project" });

  const { data: project } = await admin.from("projects")
    .select("name, code, pm_id, client_id").eq("id", projectId).maybeSingle();
  const projectName = project?.name || project?.code || "your project";

  // Build recipient set: PM + Client (standing), + assignee if the record has one.
  const recipientIds = new Set<string>();
  if (project?.pm_id) recipientIds.add(project.pm_id);
  if (project?.client_id) recipientIds.add(project.client_id);
  if (proj.assignee) {
    const a = String((rec as any)[proj.assignee] || "").trim();
    if (a && UUID_RE.test(a)) recipientIds.add(a);
  }

  // Project team: everyone in project_members for THIS project, so the working
  // team sees uploads and not just PM/client. Strictly scoped by project_id —
  // a member of another project is never reachable from here.
  // Contractors are held back on the financial tables (pay apps / change
  // orders) so one trade can't watch another trade's money; they still get
  // notified when they are the named assignee (added above).
  const FINANCIAL = new Set(["pay_apps", "change_orders"]);
  const { data: members } = await admin.from("project_members")
    .select("user_id").eq("project_id", projectId);
  const memberIds = (members || [])
    .map((m: any) => String(m.user_id || "").trim())
    .filter((id: string) => UUID_RE.test(id));
  if (memberIds.length) {
    const { data: memberProfiles } = await admin.from("profiles")
      .select("id, app_role, active").in("id", memberIds);
    for (const mp of memberProfiles || []) {
      if ((mp as any).active === false) continue;
      if (FINANCIAL.has(refTable) && (mp as any).app_role === "contractor") continue;
      recipientIds.add((mp as any).id);
    }
  }

  // Don't notify whoever performed the action.
  if (actorId && UUID_RE.test(actorId)) recipientIds.delete(actorId);
  if (recipientIds.size === 0) return json({ ok: true, skipped: "no_recipients" });

  // Resolve actor name for the message.
  let actorName = "Plaza & Associates";
  if (actorId && UUID_RE.test(actorId)) {
    const { data: ap } = await admin.from("profiles").select("full_name").eq("id", actorId).maybeSingle();
    if (ap?.full_name) actorName = ap.full_name;
  }

  const titleStr = proj.title(rec as any).slice(0, 160);
  const wf = buildWorkflow(refTable, proj.label, titleStr, created, rec as any);
  const headline = wf.subject.slice(0, 200);
  const linkUrl = `${APP_URL}/${proj.link}`;
  const assigneeId = proj.assignee ? String((rec as any)[proj.assignee] || "").trim() : "";

  const results: any[] = [];
  const previews: any[] = [];
  for (const uid of recipientIds) {
    const { data: prof } = await admin.from("profiles")
      .select("id, full_name, email, phone, active, app_role").eq("id", uid).maybeSingle();
    if (!prof || prof.active === false) continue;

    // The responsible party sees the action line; everyone else gets it FYI.
    // Responsible = the named assignee, or (when none is named) any contractor
    // on the project team.
    const isResponsible = assigneeId ? prof.id === assigneeId : (prof as any).app_role === "contractor";
    const action = isResponsible ? wf.contractorAction : undefined;
    const note = isResponsible ? undefined : wf.othersNote;
    const subjectLine = `${action ? "Action Required — " : ""}${headline}`;
    const html = renderEmail(wf, { name: prof.full_name || "", projectName, actorName, linkUrl, action, note });

    if (dryRun) {
      previews.push({ user: prof.full_name, email: prof.email, responsible: isResponsible, subject: `[Plazacore] ${subjectLine} — ${projectName}`, html });
      continue;
    }

    const email = prof.email ? String(prof.email).trim() : "";
    const phone = prof.phone ? String(prof.phone).trim() : "";
    const willEmail = !!email && /.+@.+\..+/.test(email);
    // SMS kill-switch: A2P 10DLC not yet authorized -> SMS OFF unless SMS_ENABLED="true".
    const SMS_ENABLED = (Deno.env.get("SMS_ENABLED") || "").toLowerCase() === "true";
    const willSms = SMS_ENABLED && !!phone && /^\+[1-9]\d{6,14}$/.test(phone);

    const { data: inserted } = await admin.from("notifications").insert({
      user_id: prof.id, project_id: projectId, kind: refTable,
      title: subjectLine.slice(0, 240), body: `${projectName} — by ${actorName}`,
      link: proj.link, ref_table: refTable, ref_id: refId,
      email_to: willEmail ? email : null, email_status: willEmail ? "pending" : "skipped",
      sms_to: willSms ? phone : null, sms_status: willSms ? "pending" : "skipped",
    }).select("id").single();

    let emailStatus = "skipped", smsStatus = "skipped";
    if (willEmail) {
      emailStatus = await sendEmail(email, `[Plazacore] ${subjectLine} — ${projectName}`, html);
    }
    if (willSms) {
      smsStatus = await sendSms(phone, `Plazacore: ${subjectLine} (${projectName}). ${APP_URL}`);
    }
    if (inserted) {
      await admin.from("notifications").update({ email_status: emailStatus, sms_status: smsStatus }).eq("id", inserted.id);
    }
    results.push({ user: prof.id, email: emailStatus, sms: smsStatus });
  }

  if (dryRun) return json({ ok: true, dry_run: true, event, created, previews });

  // Audit
  try {
    await admin.from("routing_events").insert({
      project_id: projectId, ref_table: refTable, ref_id: refId,
      event, to_party: null, channel: "activity_fanout",
      payload: { title: titleStr, recipients: results.length, by: actorName },
    });
  } catch (_e) { /* non-fatal */ }

  return json({ ok: true, notified: results });
});
