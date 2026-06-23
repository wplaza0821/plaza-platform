// Supabase Edge Function: auth-token
// Mints a short-lived, signed JWT scoped to the caller's role + project.
// Deploy:  supabase functions deploy auth-token --no-verify-jwt
// Secrets: supabase secrets set JWT_SECRET=<the project's JWT secret>
//          supabase secrets set OWNER_PASSWORD_HASH=<sha256 hex of owner password>
//
// IMPORTANT: JWT_SECRET MUST be the Supabase project's JWT secret
// (Dashboard > Settings > API > JWT Secret). Tokens signed with it are
// accepted by PostgREST/RLS as auth.jwt().
//
// This function is the ONLY code that reads the contractors table or checks
// the owner password. It uses the SERVICE ROLE key (server-side only).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = (Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const JWT_SECRET   = Deno.env.get("JWT_SECRET")!;
const OWNER_HASH   = Deno.env.get("OWNER_PASSWORD_HASH")!;

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h sessions (covers a full workday; app also handles expiry gracefully)

const cors = {
  "Access-Control-Allow-Origin": "https://plazacore.plazaandassociates.com",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signingKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let payload: { mode?: string; password?: string; token?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const key = await signingKey();
  const base = {
    // PostgREST requires `role` to be a valid Postgres role for the request.
    // We keep DB role = authenticated and put OUR role in a custom claim.
    role: "authenticated",
    iss: "plazacore-auth",
    iat: getNumericDate(0),
    exp: getNumericDate(TOKEN_TTL_SECONDS),
  };

  // ---------- OWNER ----------
  if (payload.mode === "owner") {
    if (!payload.password) return json({ error: "missing_password" }, 400);
    const hash = await sha256Hex(payload.password);
    if (hash !== OWNER_HASH) return json({ error: "invalid_credentials" }, 401);

    const jwt = await create(
      { alg: "HS256", typ: "JWT" },
      { ...base, user_role: "owner", name: "William Plaza" },
      key,
    );
    return json({ jwt, role: "owner", name: "William Plaza", expires_in: TOKEN_TTL_SECONDS });
  }

  // ---------- CONTRACTOR ----------
  if (payload.mode === "contractor") {
    if (!payload.token) return json({ error: "missing_token" }, 400);
    const { data: c, error } = await admin
      .from("contractors")
      .select("id, name, project_id, permissions, active")
      .eq("access_token", payload.token)
      .eq("active", true)
      .maybeSingle();
    if (error) return json({ error: "lookup_failed" }, 500);
    if (!c) return json({ error: "invalid_token" }, 401);

    const jwt = await create(
      { alg: "HS256", typ: "JWT" },
      {
        ...base,
        user_role: "contractor",
        project_id: c.project_id,
        contractor_id: c.id,
        perms: c.permissions ?? {},
        name: c.name,
      },
      key,
    );
    return json({
      jwt,
      role: "contractor",
      name: c.name,
      project_id: c.project_id,
      permissions: c.permissions ?? {},
      expires_in: TOKEN_TTL_SECONDS,
    });
  }

  return json({ error: "unknown_mode" }, 400);
});
