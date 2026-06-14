// Supabase Edge Function: notify-activity
// Phase 5 · Project-wide activity fan-out. Fires on ANY upload/action in a
// project and notifies the standing recipients: PM (projects.pm_id) + Client
// (projects.client_id), plus the explicit assignee when the record has one.
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
//     "event": "created"|"updated", "actor_id": "<uuid|null>" }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
      return { cols: "id, project_id, submittal_number, description, status, assigned_to",
        label: "Submittal", link: "#submittals", assignee: "assigned_to",
        title: (r) => `Submittal ${r.submittal_number ?? ""}${r.description ? ": " + r.description : ""}` };
    case "change_orders":
      return { cols: "id, project_id, co_number, description, status",
        label: "Change Order", link: "#cos",
        title: (r) => `CO-${String(r.co_number ?? "").padStart(3, "0")}${r.description ? ": " + r.description : ""}` };
    case "rfis":
      return { cols: "id, project_id, rfi_number, subject, status, assigned_to, ball_in_court",
        label: "RFI", link: "#rfis", assignee: "assigned_to",
        title: (r) => `RFI #${r.rfi_number ?? ""}${r.subject ? ": " + r.subject : ""}` };
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
  // Don't notify whoever performed the action.
  if (actorId && UUID_RE.test(actorId)) recipientIds.delete(actorId);
  if (recipientIds.size === 0) return json({ ok: true, skipped: "no_recipients" });

  // Resolve actor name for the message.
  let actorName = "Someone";
  if (actorId && UUID_RE.test(actorId)) {
    const { data: ap } = await admin.from("profiles").select("full_name").eq("id", actorId).maybeSingle();
    if (ap?.full_name) actorName = ap.full_name;
  }

  const verb = event === "updated" ? "updated" : "uploaded";
  const titleStr = proj.title(rec as any).slice(0, 160);
  const headline = `${proj.label} ${verb}: ${titleStr}`;
  const linkUrl = `${APP_URL}/${proj.link}`;

  const results: any[] = [];
  for (const uid of recipientIds) {
    const { data: prof } = await admin.from("profiles")
      .select("id, full_name, email, phone, active").eq("id", uid).maybeSingle();
    if (!prof || prof.active === false) continue;

    const email = prof.email ? String(prof.email).trim() : "";
    const phone = prof.phone ? String(prof.phone).trim() : "";
    const willEmail = !!email && /.+@.+\..+/.test(email);
    const willSms = !!phone && /^\+[1-9]\d{6,14}$/.test(phone);

    const { data: inserted } = await admin.from("notifications").insert({
      user_id: prof.id, project_id: projectId, kind: refTable,
      title: headline, body: `${projectName} — by ${actorName}`,
      link: proj.link, ref_table: refTable, ref_id: refId,
      email_to: willEmail ? email : null, email_status: willEmail ? "pending" : "skipped",
      sms_to: willSms ? phone : null, sms_status: willSms ? "pending" : "skipped",
    }).select("id").single();

    let emailStatus = "skipped", smsStatus = "skipped";
    if (willEmail) {
      const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1a1a1a">
        <p>Hi ${prof.full_name || "there"},</p>
        <p>A new activity was posted on <strong>${projectName}</strong>:</p>
        <p style="font-size:16px;font-weight:600;margin:14px 0">${proj.label} ${verb}: ${titleStr}</p>
        <p style="color:#555">Posted by ${actorName}.</p>
        <p style="margin-top:18px"><a href="${linkUrl}" style="background:#0b5fff;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open in Plazacore</a></p>
        <p style="color:#888;font-size:12px;margin-top:22px">Plaza &amp; Associates · Plazacore</p>
      </div>`;
      emailStatus = await sendEmail(email, `[Plazacore] ${headline} — ${projectName}`, html);
    }
    if (willSms) {
      smsStatus = await sendSms(phone, `Plazacore: ${headline} (${projectName}) by ${actorName}. ${APP_URL}`);
    }
    if (inserted) {
      await admin.from("notifications").update({ email_status: emailStatus, sms_status: smsStatus }).eq("id", inserted.id);
    }
    results.push({ user: prof.id, email: emailStatus, sms: smsStatus });
  }

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
