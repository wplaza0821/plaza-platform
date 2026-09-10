// Supabase Edge Function: send-sms
// Server-side SMS relay for trusted automation (the OpenClaw reminder cron).
// Keeps Twilio credentials in Supabase secrets only — callers never hold them.
//
// Auth: Authorization: Bearer <PLAZACORE_SECRET_KEY>  (service key; reject anything else)
// Request (POST, JSON): { "to": "+1XXXXXXXXXX", "body": "..." }
// Response: 200 { ok:true, twilio_status } | 4xx/5xx { ok:false, error }
//
// Kill-switch: honors SMS_ENABLED like notify-task / notify-route.
// Deploy: supabase functions deploy send-sms --no-verify-jwt

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const secret = Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!token || !secret || token !== secret) return json({ ok: false, error: "forbidden" }, 403);

  if ((Deno.env.get("SMS_ENABLED") || "").toLowerCase() !== "true") return json({ ok: false, error: "sms_disabled" }, 503);

  let p: { to?: string; body?: string } = {};
  try { p = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const to = String(p.to || "").trim(), body = String(p.body || "").trim();
  if (!/^\+[1-9]\d{6,14}$/.test(to)) return json({ ok: false, error: "invalid_to" }, 400);
  if (!body) return json({ ok: false, error: "empty_body" }, 400);

  const sid = Deno.env.get("TWILIO_ACCOUNT_SID") || "", auth = Deno.env.get("TWILIO_AUTH_TOKEN") || "", from = Deno.env.get("TWILIO_FROM") || "";
  if (!sid || !auth || !from) return json({ ok: false, error: "twilio_not_configured" }, 503);

  const form = new URLSearchParams({ From: from, To: to, Body: body.slice(0, 320) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${auth}`), "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ ok: false, error: "twilio_error", code: j.code, message: j.message }, 502);
  return json({ ok: true, twilio_status: j.status });
});
