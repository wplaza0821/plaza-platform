// Supabase Edge Function: manage-user
// Owner-only user administration: resend invite, cancel/revoke invite,
// deactivate / reactivate, change role/project, update phone. Every action is
// written to public.user_activity for the audit log. Uses SERVICE ROLE.
//
// Deploy:  supabase functions deploy manage-user --no-verify-jwt
// Auth:    OWNER's JWT in Authorization header. Role is verified server-side
//          against profiles.app_role (never trusts the client).
//
// Request (POST JSON):
//   { "action": "resend_invite"  , "user_id": "<uuid>" }
//   { "action": "cancel_invite"  , "user_id": "<uuid>" }      // deletes the auth user if never signed in
//   { "action": "deactivate"     , "user_id": "<uuid>" }      // suspend: active=false + ban (cannot sign in)
//   { "action": "reactivate"     , "user_id": "<uuid>" }
//   { "action": "remove_user"    , "user_id": "<uuid>" }      // HARD DELETE: removes auth user + profile (any state)
//   { "action": "set_role"       , "user_id": "<uuid>", "app_role": "staff", "project_id": "<uuid>|null" }
//   { "action": "set_phone"      , "user_id": "<uuid>", "phone": "+1305..."|null }
// Response: 200 { ok:true, action, user_id, ... } | 4xx { error }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const JWT_SECRET   = Deno.env.get("JWT_SECRET")!;
const REDIRECT_TO  = "https://plazacore.plazaandassociates.com";

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

// CORS: allow prod + staging origins (echo the caller's origin if allowed).
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

  // Two valid owner login paths: custom owner-password JWT (iss=plazacore-auth,
  // signed with JWT_SECRET) OR a real GoTrue session. Accept either.
  let callerId: string | null = null;
  let callerEmail: string | null = null;
  const customOwner = await isCustomOwnerToken(token);
  if (!customOwner) {
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
    callerId = userData.user.id;

    const { data: callerProf, error: profErr } = await admin
      .from("profiles").select("app_role, active, email").eq("id", callerId).maybeSingle();
    if (profErr) return json({ error: "profile_lookup_failed" }, 500);
    if (!callerProf || callerProf.app_role !== "owner" || callerProf.active === false) {
      return json({ error: "forbidden_owner_only" }, 403);
    }
    callerEmail = callerProf.email ?? null;
  }

  // ---------- 2. Parse ----------
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action  = String(body.action || "");
  const userId  = String(body.user_id || "");
  if (!userId) return json({ error: "user_id_required" }, 400);
  if (userId === callerId && (action === "deactivate" || action === "cancel_invite" || action === "remove_user" || (action === "set_role" && body.app_role !== "owner"))) {
    return json({ error: "cannot_demote_or_disable_self" }, 400);
  }

  // Target profile + auth state.
  const { data: target } = await admin
    .from("profiles").select("*").eq("id", userId).maybeSingle();
  if (!target) return json({ error: "user_not_found" }, 404);
  const { data: authUser } = await admin.auth.admin.getUserById(userId);
  const everSignedIn = !!authUser?.user?.last_sign_in_at;

  // helper: write audit row as the owner (actor = caller).
  const logActivity = async (act: string, detail: Record<string, unknown>) => {
    await admin.from("user_activity").insert({
      actor_id: callerId, actor_email: callerEmail ?? "owner-password",
      subject_id: userId, action: act,
      project_id: target.project_id ?? null, detail,
    });
  };

  // ---------- 3. Dispatch ----------
  try {
    switch (action) {
      case "resend_invite": {
        const { error } = await admin.auth.admin.inviteUserByEmail(target.email, {
          data: { full_name: target.full_name, app_role: target.app_role, perms: target.perms,
                  ...(target.phone ? { phone: target.phone } : {}),
                  ...(target.company ? { company: target.company } : {}),
                  ...(target.project_id ? { project_id: target.project_id } : {}) },
          redirectTo: REDIRECT_TO,
        });
        if (error && !/already|registered|exists/i.test(error.message)) {
          // Already-registered users can't be re-invited; send a recovery/magic link instead.
          const { error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email: target.email });
          if (linkErr) return json({ error: linkErr.message }, 400);
        }
        await admin.from("profiles").update({ invited_by: callerId, invited_at: new Date().toISOString() }).eq("id", userId);
        await logActivity("invite_resent", { email: target.email });
        return json({ ok: true, action, user_id: userId, status: "invite_resent" });
      }

      case "cancel_invite": {
        if (everSignedIn) return json({ error: "user_already_active_use_deactivate" }, 409);
        // Never signed in -> safe to fully delete the auth user + profile.
        const { error: delErr } = await admin.auth.admin.deleteUser(userId);
        if (delErr) return json({ error: delErr.message }, 400);
        await logActivity("invite_cancelled", { email: target.email });
        // profile row is removed by ON DELETE cascade from auth.users; ensure gone.
        await admin.from("profiles").delete().eq("id", userId);
        return json({ ok: true, action, user_id: userId, status: "invite_cancelled" });
      }

      case "deactivate": {
        await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" }); // ~100 yrs
        await admin.from("profiles").update({ active: false, updated_at: new Date().toISOString() }).eq("id", userId);
        await logActivity("deactivated", { email: target.email });
        return json({ ok: true, action, user_id: userId, status: "deactivated" });
      }

      case "remove_user": {
        // Hard delete: permanently removes the auth user (any state, signed-in or
        // not). The profiles row drops via ON DELETE cascade; we also delete
        // explicitly in case the FK isn't cascading. The owner cannot remove self
        // (guarded above). Audit row is written to a non-cascading table, so it
        // survives the user deletion.
        await logActivity("removed", { email: target.email, full_name: target.full_name, app_role: target.app_role });
        const { error: delErr } = await admin.auth.admin.deleteUser(userId);
        if (delErr && !/not.*found/i.test(delErr.message)) {
          return json({ error: delErr.message }, 400);
        }
        await admin.from("profiles").delete().eq("id", userId);
        return json({ ok: true, action, user_id: userId, status: "removed" });
      }

      case "reactivate": {
        await admin.auth.admin.updateUserById(userId, { ban_duration: "none" });
        await admin.from("profiles").update({ active: true, updated_at: new Date().toISOString() }).eq("id", userId);
        await logActivity("reactivated", { email: target.email });
        return json({ ok: true, action, user_id: userId, status: "reactivated" });
      }

      case "set_role": {
        const newRole = String(body.app_role || "");
        if (!ALLOWED_ROLES.includes(newRole)) return json({ error: "invalid_role" }, 400);
        const newProject = body.project_id ? String(body.project_id) : null;
        const patch: Record<string, unknown> = { app_role: newRole, project_id: newProject, updated_at: new Date().toISOString() };
        await admin.from("profiles").update(patch).eq("id", userId);
        // keep auth metadata in sync (used on token refresh / RLS claims if any).
        await admin.auth.admin.updateUserById(userId, { user_metadata: { ...(authUser?.user?.user_metadata||{}), app_role: newRole, project_id: newProject } });
        await logActivity("role_changed", { from: target.app_role, to: newRole, project_id: newProject });
        return json({ ok: true, action, user_id: userId, app_role: newRole });
      }

      case "set_phone": {
        const phone = body.phone ? String(body.phone).trim() : null;
        if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) return json({ error: "phone_must_be_e164" }, 400);
        await admin.from("profiles").update({ phone, updated_at: new Date().toISOString() }).eq("id", userId);
        await logActivity("phone_changed", { phone });
        return json({ ok: true, action, user_id: userId, phone });
      }

      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "manage_user_failed" }, 500);
  }
});
