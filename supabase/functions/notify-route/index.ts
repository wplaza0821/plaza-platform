// Supabase Edge Function: notify-route
// Phase 4 · Generalized routing fan-out for RFIs / Submittals / Deficiencies.
// Clone of notify-task: in-app bell + Twilio SMS, email DEFERRED.
//
// Called fire-and-forget by the app on create / ball-in-court change, AND by a
// daily reminder cron for due/overdue items. Caller passes only identifiers;
// the function re-loads the record itself with the SERVICE ROLE so it never
// trusts client-supplied content.
//
// Deploy:  supabase functions deploy notify-route --no-verify-jwt
//
// Secrets / env (already stored for this project):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto-injected)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (secrets)
//
// Request (POST JSON), caller's app JWT in Authorization header:
//   { "ref_table": "rfis"|"submittals"|"deficiencies",
//     "ref_id": "<uuid>",
//     "event": "created"|"ball_in_court_change"|"due_reminder"|"overdue" }
// Response:
//   200 { ok:true, notification_id, sms_status } | { ok:true, skipped:"..." }
//   4xx { error:"<reason>" }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
// Must send from the Resend-VERIFIED domain (root plazaandassociates.com).
const FROM = Deno.env.get("NOTIFY_FROM") || "Plaza & Associates <info@plazaandassociates.com>";
const APP_URL = "https://plazacore.plazaandassociates.com";

// Which routing events should also send the assignee an email.
const EMAIL_EVENTS = new Set(["created", "reassigned", "status_change", "resolved"]);

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
  } catch (_e) { console.log("RESEND_EXC", String(_e).slice(0, 200)); return "failed"; }
}
// Allow prod + staging origins (echo the caller's origin when allowed).
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
const cors = corsFor(null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TABLES = new Set(["rfis", "submittals", "deficiencies"]);
const ALLOWED_EVENTS = new Set(["created", "ball_in_court_change", "due_reminder", "overdue", "reassigned", "status_change", "followed_up", "resolved"]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json" },
  });
}

// Per-table projection: how to read title / assignee / project / link anchor.
function projectionFor(table: string) {
  switch (table) {
    case "rfis":
      return { cols: "id, project_id, rfi_number, subject, ball_in_court, assigned_to, due_date, status",
               title: (r: any) => `RFI #${r.rfi_number}: ${r.subject ?? ""}`, link: "#rfis" };
    case "submittals":
      return { cols: "id, project_id, submittal_number, description, spec_section, ball_in_court, assigned_to, due_date, status",
               title: (r: any) => `Submittal ${r.submittal_number}: ${r.description ?? r.spec_section ?? ""}`, link: "#submittals" };
    case "deficiencies":
      return { cols: "id, project_id, deficiency_no, description, ball_in_court, responsible_party, due_date, status",
               title: (r: any) => `Deficiency ${r.deficiency_no ?? ""}: ${r.description ?? ""}`, link: "#deficiencies" };
    default:
      return null;
  }
}

Deno.serve(async (req) => {
  // Per-request CORS + json() so the Allow-Origin header can echo the caller.
  const cors = corsFor(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Validate caller JWT
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);

  // 2. Parse + validate input
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const refTable = String(payload.ref_table || "").trim();
  const refId = String(payload.ref_id || "").trim();
  const event = String(payload.event || "created").trim();
  if (!ALLOWED_TABLES.has(refTable)) return json({ error: "invalid_ref_table" }, 400);
  if (!UUID_RE.test(refId)) return json({ error: "valid_ref_id_required" }, 400);
  if (!ALLOWED_EVENTS.has(event)) return json({ error: "invalid_event" }, 400);

  // 3. Load the record (service role)
  const proj = projectionFor(refTable)!;
  const { data: rec, error: recErr } = await admin
    .from(refTable).select(proj.cols).eq("id", refId).maybeSingle();
  if (recErr) return json({ error: "record_lookup_failed" }, 500);
  if (!rec) return json({ error: "record_not_found" }, 404);

  // Resolve assignee: prefer assigned_to (uuid), else responsible_party.
  const assignedRaw = (rec as any).assigned_to ?? (rec as any).responsible_party ?? "";
  const assignedTo = String(assignedRaw || "").trim();
  if (!assignedTo || !UUID_RE.test(assignedTo)) return json({ ok: true, skipped: "no assignee" });

  // 4. Load assignee profile + project name
  const { data: assignee, error: profErr } = await admin
    .from("profiles").select("id, full_name, phone, email, active").eq("id", assignedTo).maybeSingle();
  if (profErr) return json({ error: "profile_lookup_failed" }, 500);
  if (!assignee) return json({ ok: true, skipped: "no assignee" });

  let projectName = "your project";
  const projectId = (rec as any).project_id || null;
  if (projectId) {
    const { data: p } = await admin.from("projects").select("name, code").eq("id", projectId).maybeSingle();
    if (p) projectName = p.name || p.code || projectName;
  }

  const phone = assignee.phone ? String(assignee.phone).trim() : "";
  // SMS kill-switch: A2P 10DLC not yet authorized -> SMS OFF unless SMS_ENABLED="true".
  const SMS_ENABLED = (Deno.env.get("SMS_ENABLED") || "").toLowerCase() === "true";
  const willSms = SMS_ENABLED && !!phone && /^\+[1-9]\d{6,14}$/.test(phone) && assignee.active !== false;
  const email = (assignee as any).email ? String((assignee as any).email).trim() : "";
  const willEmail = !!email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
    && assignee.active !== false && EMAIL_EVENTS.has(event);

  const titleStr = proj.title(rec as any).slice(0, 140);
  const dueStr = (rec as any).due_date ? String((rec as any).due_date) : "n/a";
  const bic = (rec as any).ball_in_court ? String((rec as any).ball_in_court) : "";
  const statusStr = (rec as any).status ? String((rec as any).status) : "";
  const eventLabel: Record<string, string> = {
    created: "New item assigned to you",
    ball_in_court_change: `Ball in your court${bic ? ` (${bic})` : ""}`,
    due_reminder: "Item due soon",
    overdue: "OVERDUE item",
    reassigned: "Reassigned to you",
    status_change: `Status updated${statusStr ? ` → ${statusStr}` : ""}`,
    followed_up: "Follow-up reminder",
    resolved: "Marked resolved",
  };

  // 5. Insert in-app notification (service role; also de-dupes daily reminders)
  if (event === "due_reminder" || event === "overdue") {
    const { data: dup } = await admin
      .from("notifications").select("id")
      .eq("ref_table", refTable).eq("ref_id", refId).eq("kind", refTable)
      .gte("created_at", new Date(Date.now() - 20 * 3600 * 1000).toISOString())
      .maybeSingle();
    if (dup) return json({ ok: true, skipped: "already reminded" });
  }

  const { data: inserted, error: insErr } = await admin.from("notifications").insert({
    user_id: assignee.id,
    project_id: projectId,
    kind: refTable,
    title: `${eventLabel[event]}: ${titleStr}`,
    body: `${projectName} — due ${dueStr}`,
    link: proj.link,
    ref_table: refTable,
    ref_id: refId,
    sms_to: willSms ? phone : null,
    sms_status: willSms ? "pending" : "skipped",
    email_to: willEmail ? email : null,
    email_status: willEmail ? "pending" : "skipped",
  }).select("id").single();
  if (insErr || !inserted) return json({ error: "notification_insert_failed" }, 500);

  // Best-effort: record routing event for audit/cron bookkeeping.
  try {
    await admin.from("routing_events").insert({
      project_id: projectId, ref_table: refTable, ref_id: refId,
      event, to_party: assignee.id, channel: willSms ? "sms" : "in_app",
      payload: { title: titleStr, due: dueStr },
    });
  } catch (_e) { /* non-fatal */ }

  // 6. Twilio SMS (best-effort)
  let smsStatus = willSms ? "pending" : "skipped";
  if (willSms) {
    smsStatus = "failed";
    try {
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
      const auth = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
      const from = Deno.env.get("TWILIO_FROM") || "";
      if (sid && auth && from) {
        const smsBody = `Plazacore: ${eventLabel[event]} — ${titleStr} (${projectName}), due ${dueStr}. ${APP_URL}`;
        const form = new URLSearchParams();
        form.set("From", from); form.set("To", phone); form.set("Body", smsBody.slice(0, 320));
        const twRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          { method: "POST",
            headers: { "Authorization": "Basic " + btoa(`${sid}:${auth}`),
                       "content-type": "application/x-www-form-urlencoded" },
            body: form.toString() });
        smsStatus = twRes.ok ? "sent" : "failed";
      } else { smsStatus = "skipped"; }
    } catch (_e) { smsStatus = "failed"; }
    try { await admin.from("notifications").update({ sms_status: smsStatus }).eq("id", inserted.id); } catch (_e) {}
  }

  // 7. Email (best-effort) for assign/reassign/status_change/resolved.
  let emailStatus = willEmail ? "pending" : "skipped";
  if (willEmail) {
    const subject = `Plazacore: ${eventLabel[event]} — ${titleStr}`;
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">` +
      `<p><strong>${eventLabel[event]}</strong></p>` +
      `<p>${titleStr}</p>` +
      `<p style="color:#555;">Project: ${projectName}<br/>Due: ${dueStr}</p>` +
      `<p><a href="${APP_URL}${proj.link}" style="color:#1a73e8;">Open in Plazacore</a></p>` +
      `</div>`;
    emailStatus = await sendEmail(email, subject, html);
    try { await admin.from("notifications").update({ email_status: emailStatus }).eq("id", inserted.id); } catch (_e) {}
  }

  return json({ ok: true, notification_id: inserted.id, sms_status: smsStatus, email_status: emailStatus });
});
