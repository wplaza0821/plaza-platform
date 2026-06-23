// Supabase Edge Function: notify-task
// Phase B · Layer 3 notifications fan-out (IN-APP BELL + SMS; email DEFERRED).
//
// Called fire-and-forget by the app right after a NEW task is created. The
// caller passes only { task_id }; the function re-loads the task itself with
// the SERVICE ROLE so it never trusts client-supplied task content. It inserts
// a notifications row for the assignee (in-app bell) and, when the assignee has
// an active profile with an E.164 phone, sends an SMS via the Twilio REST API.
//
// Deploy:  supabase functions deploy notify-task --no-verify-jwt
//   (--no-verify-jwt because we validate the caller's JWT ourselves below; this
//    mirrors invite-user so the same CORS + auth pattern applies.)
//
// Secrets / env (Twilio secrets already stored for this project):
//   SUPABASE_URL                (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   SUPABASE_ANON_KEY           (auto-injected; used to validate caller JWT)
//   TWILIO_ACCOUNT_SID          (secret)
//   TWILIO_AUTH_TOKEN           (secret)
//   TWILIO_FROM                 (secret; E.164 sender, e.g. +17867553224)
//
// Request (POST, JSON), with the caller's app JWT in the Authorization header:
//   { "task_id": "<uuid>" }
// Response:
//   200 { "ok": true, "notification_id": "<uuid>", "sms_status": "sent|failed|skipped" }
//   200 { "ok": true, "skipped": "no assignee" }     // nothing to notify
//   4xx { "error": "<reason>" }
//
// SECURITY: the caller must be an authenticated app user (any role). We do NOT
// trust the caller's claimed identity for content — we only require that the
// request comes from a valid logged-in user (reject anon). Twilio creds are read
// ONLY from Deno.env and are never logged or returned.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = (Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

const APP_URL = "https://plazacore.plazaandassociates.com";

// CORS locked to the prod origin, mirroring invite-user / auth-token.
const cors = {
  "Access-Control-Allow-Origin": APP_URL,
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// service-role client: bypasses RLS to load the task + assignee profile and to
// insert the notifications row (clients are not allowed to insert directly).
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ---------- 1. Validate caller JWT (must be a logged-in app user) ----------
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);

  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);

  // ---------- 2. Parse input ----------
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const taskId = String(payload.task_id || "").trim();
  if (!taskId || !UUID_RE.test(taskId)) {
    return json({ error: "valid_task_id_required" }, 400);
  }

  // ---------- 3. Load the task (service role; do not trust client content) ----------
  const { data: task, error: taskErr } = await admin
    .from("tasks")
    .select("id, title, project_id, assigned_to, priority, due_date, status")
    .eq("id", taskId)
    .maybeSingle();
  if (taskErr) return json({ error: "task_lookup_failed" }, 500);
  if (!task) return json({ error: "task_not_found" }, 404);

  // No assignee (or legacy free-text assignee that is not a profile uuid) ->
  // nothing to notify.
  const assignedTo = task.assigned_to ? String(task.assigned_to).trim() : "";
  if (!assignedTo || !UUID_RE.test(assignedTo)) {
    return json({ ok: true, skipped: "no assignee" });
  }

  // ---------- 4. Load assignee profile + project context (service role) ----------
  const { data: assignee, error: profErr } = await admin
    .from("profiles")
    .select("id, full_name, phone, active")
    .eq("id", assignedTo)
    .maybeSingle();
  if (profErr) return json({ error: "profile_lookup_failed" }, 500);
  if (!assignee) {
    // assigned_to is a uuid but no profile row (e.g. deleted user) -> skip.
    return json({ ok: true, skipped: "no assignee" });
  }

  let projectName = "your project";
  if (task.project_id) {
    const { data: proj } = await admin
      .from("projects")
      .select("name, code")
      .eq("id", task.project_id)
      .maybeSingle();
    if (proj) projectName = proj.name || proj.code || projectName;
  }

  const phone = assignee.phone ? String(assignee.phone).trim() : "";
  const phoneOk = !!phone && /^\+[1-9]\d{6,14}$/.test(phone);
  // SMS kill-switch: A2P 10DLC not yet authorized -> SMS OFF unless SMS_ENABLED="true".
  const SMS_ENABLED = (Deno.env.get("SMS_ENABLED") || "").toLowerCase() === "true";
  const willSms = SMS_ENABLED && phoneOk && assignee.active !== false;

  const titleStr = String(task.title || "task");
  const priorityStr = task.priority ? String(task.priority) : "normal";
  const dueStr = task.due_date ? String(task.due_date) : "n/a";

  // ---------- 5. Insert the in-app notification row (service role) ----------
  const notifRow = {
    user_id: assignee.id,
    project_id: task.project_id || null,
    kind: "task",
    title: `New task: ${titleStr}`,
    body: `Assigned to you on ${projectName} — priority ${priorityStr}, due ${dueStr}`,
    link: "#tasks",
    ref_table: "tasks",
    ref_id: task.id,
    sms_to: willSms ? phone : null,
    sms_status: willSms ? "pending" : "skipped",
    email_to: null,
    email_status: "skipped", // email DEFERRED (Phase B Option C)
  };

  const { data: inserted, error: insErr } = await admin
    .from("notifications")
    .insert(notifRow)
    .select("id")
    .single();
  if (insErr || !inserted) {
    return json({ error: "notification_insert_failed" }, 500);
  }
  const notificationId = inserted.id;

  // ---------- 6. Send SMS via Twilio (best-effort; never fails the request) ----------
  let smsStatus = willSms ? "pending" : "skipped";
  if (willSms) {
    smsStatus = "failed"; // pessimistic default until Twilio confirms success
    try {
      const sid   = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
      const auth  = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
      const from  = Deno.env.get("TWILIO_FROM") || "";
      if (sid && auth && from) {
        // Keep the SMS body < 320 chars.
        let smsTitle = titleStr;
        if (smsTitle.length > 80) smsTitle = smsTitle.slice(0, 77) + "...";
        const smsBody =
          `Plazacore: New task '${smsTitle}' assigned to you on ${projectName}. Open: ${APP_URL}`;
        const form = new URLSearchParams();
        form.set("From", from);
        form.set("To", phone);
        form.set("Body", smsBody.slice(0, 320));

        const twRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              "Authorization": "Basic " + btoa(`${sid}:${auth}`),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
        );
        smsStatus = twRes.ok ? "sent" : "failed";
      } else {
        smsStatus = "skipped"; // creds missing -> treat as skipped, row persists
      }
    } catch (_e) {
      // Capture nothing sensitive. Twilio failure must NOT fail the request.
      smsStatus = "failed";
    }

    // Update the row's sms_status (best-effort).
    try {
      await admin
        .from("notifications")
        .update({ sms_status: smsStatus })
        .eq("id", notificationId);
    } catch (_e) { /* non-fatal */ }
  }

  return json({ ok: true, notification_id: notificationId, sms_status: smsStatus });
});
