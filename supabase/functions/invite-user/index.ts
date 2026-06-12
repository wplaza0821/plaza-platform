// Supabase Edge Function: invite-user
// Owner-only. Invites a new user by email and seeds their profile metadata so
// the plz_handle_new_user() trigger populates the profiles row with the right
// app_role / project_id / perms. Uses the SERVICE ROLE key (server-side only).
//
// Deploy:  supabase functions deploy invite-user --no-verify-jwt
// Secrets (already set for the project; reused here):
//          SUPABASE_URL                  (auto-injected)
//          SUPABASE_SERVICE_ROLE_KEY     (auto-injected)
//          SUPABASE_ANON_KEY             (auto-injected; used to validate caller JWT)
//
// Request (POST, JSON), with the OWNER's JWT in the Authorization header:
//   {
//     "email":      "person@company.com",   // required
//     "full_name":  "Jane Doe",             // optional
//     "app_role":   "member",               // owner | staff | member | contractor
//     "project_id": "<uuid>" | null,         // null = all projects
//     "phone":      "+13055551234" | null,    // E.164
//     "company":    "Acme" | null,
//     "perms":      { ... }                   // contractor module flags
//   }
// Response:
//   200 { "ok": true, "user_id": "<uuid>", "email": "...", "status": "invited" }
//   4xx { "error": "<reason>" }
//
// SECURITY: never trusts the client's claimed role. It validates the caller's
// JWT against GoTrue, then reads THAT user's profiles.app_role server-side and
// requires it to equal 'owner'.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const JWT_SECRET    = Deno.env.get("JWT_SECRET")!;

// Verifies the custom owner JWT minted by the auth-token function (owner-password
// login path). Returns true only for a valid, unexpired token with user_role=owner.
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

// CORS: allow prod + staging origins (echo the caller's origin if allowed),
// mirroring manage-user so the Add User panel works from either URL.
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

const ALLOWED_ROLES = ["owner", "staff", "member", "contractor"];

// service-role client: full admin (auth.admin.*, profiles read).
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ---------- 1. Validate caller JWT + require owner ----------
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing_authorization" }, 401);

  // Two valid owner login paths:
  //  (a) owner-password login -> custom JWT signed with JWT_SECRET (iss=plazacore-auth)
  //  (b) native email/password -> real GoTrue session token
  // Accept either. (a) is verified by signature; (b) is verified via GoTrue + profiles.
  let callerId: string | null = null;
  const customOwner = await isCustomOwnerToken(token);
  if (!customOwner) {
    // Resolve the caller from their GoTrue JWT using a request-scoped client.
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
    callerId = userData.user.id;

    // Authoritative role check: read the caller's profile with service role.
    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("app_role, active")
      .eq("id", callerId)
      .maybeSingle();
    if (profErr) return json({ error: "profile_lookup_failed" }, 500);
    if (!prof || prof.app_role !== "owner" || prof.active === false) {
      return json({ error: "forbidden_owner_only" }, 403);
    }
  }

  // ---------- 2. Parse + validate input ----------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "valid_email_required" }, 400);
  }
  const app_role = String(body.app_role || "member");
  if (!ALLOWED_ROLES.includes(app_role)) {
    return json({ error: "invalid_role" }, 400);
  }
  const full_name  = body.full_name ? String(body.full_name).trim() : "";
  const phone      = body.phone ? String(body.phone).trim() : null;
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
    return json({ error: "phone_must_be_e164" }, 400);
  }
  const company    = body.company ? String(body.company).trim() : null;
  const project_id = body.project_id ? String(body.project_id) : null;
  const perms      = (body.perms && typeof body.perms === "object") ? body.perms : {};

  // raw_user_meta_data the plz_handle_new_user trigger reads to seed the profile.
  const user_metadata: Record<string, unknown> = {
    full_name,
    app_role,
    perms,
  };
  if (phone)      user_metadata.phone = phone;
  if (company)    user_metadata.company = company;
  if (project_id) user_metadata.project_id = project_id;

  // ---------- 3. Invite via admin API ----------
  // inviteUserByEmail sends the built-in invite email (set password link).
  // The redirect lands the user on the prod app.
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    {
      data: user_metadata,
      redirectTo: "https://plazacore.plazaandassociates.com",
    },
  );

  if (inviteErr) {
    // If already invited/registered, surface a clean message.
    const msg = inviteErr.message || "invite_failed";
    const code = /already|registered|exists/i.test(msg) ? 409 : 400;
    return json({ error: msg }, code);
  }

  const newId = invited?.user?.id ?? null;

  // Stamp invited_by / invited_at on the profile (best-effort; trigger created
  // the row from metadata). Non-fatal if it races.
  if (newId) {
    await admin
      .from("profiles")
      .update({ invited_by: callerId, invited_at: new Date().toISOString() })
      .eq("id", newId);
  }

  return json({ ok: true, user_id: newId, email, status: "invited" });
});
