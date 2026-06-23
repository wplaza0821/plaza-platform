// Supabase Edge Function: analyze-co
// Owner-only. Given a change_orders.id, downloads the attached executed CO
// document from the private `change-orders` bucket, sends it to Anthropic
// (Claude) to (a) verify it is SIGNED/executed and (b) extract the line-item
// breakdown + total, then writes the result back to the change_orders row:
//   signed, signature_summary, analysis (jsonb), analyzed_at, analyzed_by.
//
// It does NOT approve the CO and does NOT touch the SOV — the frontend reads
// the result and, only if signed===true, proceeds to set status='approved'
// (which the DB trigger now permits) and rolls the extracted lines into a new
// SOV version. This keeps the LLM key server-side and the signature gate hard.
//
// Deploy:  supabase functions deploy analyze-co --no-verify-jwt
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto-injected)
//   JWT_SECRET                 (custom owner-token verification; already set)
//   CO_LLM_API_KEY             (Anthropic API key — REQUIRED, set this)
//   CO_LLM_MODEL               (optional; default claude-sonnet-4-5)
//
// Request (POST JSON), owner's app JWT in Authorization header:
//   { "co_id": "<uuid>" }
// Response:
//   200 {
//     ok:true, signed:boolean, signature_summary, total, line_items:[{description,amount}],
//     amount_typed, reconciles:boolean, confidence
//   }
//   4xx { error:"<reason>" }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = (Deno.env.get("PLAZACORE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
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

const SYSTEM_PROMPT =
  "You are a construction contract analyst for Plaza and Associates (structural " +
  "engineering / special inspection). You analyze a CHANGE ORDER document. Two tasks:\n\n" +
  "(1) SIGNATURE VERIFICATION: determine whether this is a FULLY EXECUTED change order. " +
  "Rules — read carefully:\n" +
  "  • A signature block is SIGNED only when it contains a VISIBLE SIGNATURE MARK: a handwritten " +
  "    cursive/initials stroke, an e-signature image, a DocuSign/Adobe Sign completion stamp, " +
  "    a wet-ink scan, or a digital certificate badge. " +
  "  • A typed name, a printed label, or an empty line does NOT constitute a signature. " +
  "  • DO NOT attempt to identify or extract the signer's name from the signature image or " +
  "    cursive mark — cursive is illegible and you will guess wrong. " +
  "  • Instead, identify the ROLE of each signed block using only the printed LABEL above or " +
  "    beside it (e.g. 'Owner', 'Contractor', 'Architect', 'Engineer', 'GC', 'Subcontractor'). " +
  "    If the label is not legible, use 'Unknown party'. " +
  "  • A change order is considered signed (signed=true) when at minimum the Owner block AND " +
  "    the Contractor block both have visible signature marks. " +
  "  • Be conservative: when in doubt whether a mark is a real signature, treat it as unsigned. " +
  "  • signature_summary must list: which ROLE blocks are signed, and which required blocks " +
  "    (Owner / Contractor) are missing or blank. Example: " +
  "    'Owner block: signed. Contractor block: signed. Architect block: not present.' " +
  "    or 'Owner block: signed. Contractor block: blank — awaiting signature.' " +
  "    Do NOT include any guessed names — roles only.\n\n" +
  "(2) LINE-ITEM EXTRACTION: extract every cost line item with its description and dollar amount, " +
  "plus the document's stated grand total.\n\n" +
  "Respond ONLY with a single minified JSON object, no prose, no markdown, of the exact shape: " +
  '{"signed":boolean,"signature_summary":"roles-based summary, no names",' +
  '"line_items":[{"description":"string","amount":number}],"total":number,"confidence":number} ' +
  "where confidence is 0..1. amount and total are plain numbers (no $ or commas). If there is a " +
  "single lump-sum value and no breakdown, return one line_item equal to the total.";

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

  // 1. Owner auth (same dual-path as invite-user / manage-user)
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
    if (!prof || prof.app_role !== "owner" || prof.active === false) {
      return json({ error: "forbidden_owner_only" }, 403);
    }
    analyzedBy = prof.full_name || prof.email || "owner";
  }

  // 2. Input
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const coId = String(body.co_id || "").trim();
  if (!coId) return json({ error: "co_id_required" }, 400);

  // 3. Load the CO row
  const { data: co, error: coErr } = await admin
    .from("change_orders")
    .select("id, co_number, amount, file_path, file_name")
    .eq("id", coId)
    .maybeSingle();
  if (coErr) return json({ error: "co_lookup_failed" }, 500);
  if (!co) return json({ error: "co_not_found" }, 404);
  if (!co.file_path) {
    return json({ error: "no_document", message: "Upload the executed change order document before approving." }, 422);
  }

  // 4. Download the file bytes from storage (service role)
  const { data: blob, error: dlErr } = await admin.storage
    .from("change-orders")
    .download(co.file_path);
  if (dlErr || !blob) return json({ error: "download_failed", detail: dlErr?.message }, 500);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const b64 = bytesToBase64(bytes);
  const name = (co.file_name || co.file_path).toLowerCase();
  const isPdf = name.endsWith(".pdf");
  const mediaType = isPdf ? "application/pdf"
    : name.endsWith(".png") ? "image/png"
    : "image/jpeg";

  // 5. Build the Anthropic message (document for PDFs, image for JPG/PNG)
  const docBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image",    source: { type: "base64", media_type: mediaType,        data: b64 } };

  const userText =
    `This is change order CO-${String(co.co_number ?? "").padStart(3, "0")}. ` +
    `The contractor-entered amount is $${Number(co.amount || 0).toFixed(2)}. ` +
    `Verify signatures and extract the line-item breakdown per your instructions.`;

  let llmJson: any;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [docBlock, { type: "text", text: userText }],
        }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return json({ error: "llm_failed", status: resp.status, detail: t.slice(0, 500) }, 502);
    }
    const data = await resp.json();
    const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    llmJson = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: "llm_parse_failed", detail: String(e).slice(0, 300) }, 502);
  }

  // 6. Normalize
  const signed = llmJson?.signed === true;
  const signature_summary = String(llmJson?.signature_summary || (signed ? "Signatures detected." : "No valid signatures detected."));
  const rawItems = Array.isArray(llmJson?.line_items) ? llmJson.line_items : [];
  const line_items = rawItems
    .map((li: any) => ({ description: String(li?.description || "").trim(), amount: Number(li?.amount) || 0 }))
    .filter((li: any) => li.description || li.amount);
  const extractedTotal = Number(llmJson?.total) || line_items.reduce((s: number, li: any) => s + li.amount, 0);
  const confidence = Math.max(0, Math.min(1, Number(llmJson?.confidence) || 0));
  const amountTyped = Number(co.amount || 0);
  const reconciles = Math.abs(extractedTotal - amountTyped) <= Math.max(1, amountTyped * 0.01);

  const analysis = {
    line_items,
    total: extractedTotal,
    confidence,
    amount_typed: amountTyped,
    reconciles,
    model: LLM_MODEL,
  };

  // 7. Persist analysis (signed gate column included). This is what the DB
  //    trigger later checks when status flips to 'approved'.
  const { error: upErr } = await admin
    .from("change_orders")
    .update({
      signed,
      signature_summary,
      analysis,
      analyzed_at: new Date().toISOString(),
      analyzed_by: analyzedBy,
    })
    .eq("id", coId);
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  return json({
    ok: true,
    signed,
    signature_summary,
    total: extractedTotal,
    line_items,
    amount_typed: amountTyped,
    reconciles,
    confidence,
  });
});
