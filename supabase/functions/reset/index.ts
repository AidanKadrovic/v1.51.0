// =====================================================================
// The Clicker Game! PASSWORD RESET + EMAIL                     1.32.0
// =====================================================================
// A SEPARATE Supabase Edge Function from "api", so the main backend is
// never touched. It uses the SAME accounts table and the SAME database
// helpers (make_hash, check_login) that "api" already uses.
//
// It does three things the game asks for:
//   setEmail              a logged-in player adds or changes their email
//   requestPasswordReset  the game asks for a reset code to be emailed
//   resetPassword         the player sends the code and a new password
//
// The email itself is sent by a Google Apps Script mailer (see
// supabase/functions/mcp has nothing to do with this; the mailer script
// is in the chat). This function POSTs the code to that mailer.
//
// TURN IT ON (once), same as any edge function:
//   Supabase dashboard > Edge Functions > Deploy a new function > Via editor.
//   Name it exactly:  reset
//   Paste this whole file, turn OFF "Verify JWT" (same as "api"), Deploy.
//
// NEW COLUMNS on the accounts table (run once in the SQL editor, safe to
// re-run, never deletes anything):
//   alter table accounts
//     add column if not exists email text,
//     add column if not exists email_lower text,
//     add column if not exists reset_code_hash text,
//     add column if not exists reset_expires bigint,
//     add column if not exists reset_tries int not null default 0;
//
// TWO SECRETS to add (Edge Functions > Manage secrets):
//   MAILER_URL     the Apps Script web app URL
//   MAILER_SECRET  the same secret word you put in the Apps Script
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already there for you.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MAILER_URL = Deno.env.get("MAILER_URL") || "";
const MAILER_SECRET = Deno.env.get("MAILER_SECRET") || "";

const CODE_TTL_MS = 15 * 60 * 1000;     // a code works for 15 minutes
const RESEND_COOL_MS = 60 * 1000;       // at most one new code a minute
const MAX_TRIES = 5;                    // wrong-code guesses before the code dies
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0 1 I O
const CODE_LENGTH = 6;
const MAX_EMAIL_CHARS = 200;
const MAX_PASS_CHARS = 200;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, accept",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function lower(s: unknown) {
  return String(s ?? "").trim().toLowerCase();
}

// A real-looking email address, nothing fancy.
function emailOk(s: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= MAX_EMAIL_CHARS;
}

// A random code like "7KQ4MP".
function makeCode() {
  const bytes = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// The code is kept only as a SHA-256 fingerprint, so a database leak never
// shows a live code. We compare by fingerprinting what the player typed.
async function codeHash(code: string) {
  const data = new TextEncoder().encode("cga-reset:" + code.toUpperCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Finds an account by username OR email. Returns the row, or null.
async function findAccount(account: string) {
  const key = lower(account);
  if (!key) return null;
  const byName = await db.from("accounts").select("*").eq("username_lower", key).maybeSingle();
  if (byName.data) return byName.data;
  const byEmail = await db.from("accounts").select("*").eq("email_lower", key).maybeSingle();
  return byEmail.data || null;
}

// Sends the code through the Apps Script mailer. Returns true if it went.
async function sendMail(to: string, code: string, username: string) {
  if (!MAILER_URL || !MAILER_SECRET) return false;
  try {
    const res = await fetch(MAILER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: MAILER_SECRET, to, code, username }),
    });
    const data = await res.json().catch(() => ({}));
    return !!data.ok;
  } catch (_e) {
    return false;
  }
}

// ---- setEmail: a logged-in player adds or changes their email ----
async function setEmail(p: any) {
  const email = String(p.email ?? "").trim();
  // An empty email means "remove my email".
  if (email && !emailOk(email)) return { error: "bademail" };
  // Prove it is really them: username + password must match.
  const { data: playerId } = await db.rpc("check_login", {
    p_user: String(p.username ?? ""),
    p_pass: String(p.password ?? ""),
  });
  if (!playerId) return { error: "invalid" };
  // One email to one account.
  if (email) {
    const taken = await db.from("accounts")
      .select("player_id").eq("email_lower", lower(email)).neq("player_id", playerId).maybeSingle();
    if (taken.data) return { error: "taken" };
  }
  const { error } = await db.from("accounts")
    .update({ email: email || null, email_lower: email ? lower(email) : null })
    .eq("player_id", playerId);
  if (error) return { error: "server" };
  return { success: true };
}

// ---- requestPasswordReset: email a code to the account's address ----
async function requestPasswordReset(p: any) {
  const row = await findAccount(p.account);
  // Same answer whether the account is missing or just has no email, so no
  // one can use this to find out which usernames or emails exist.
  if (!row || !row.email) return { error: "noemail" };

  // Don't let someone spam the mailbox: one code a minute.
  const now = Date.now();
  const lastIssued = Number(row.reset_expires || 0) - CODE_TTL_MS;
  if (lastIssued && now - lastIssued < RESEND_COOL_MS) return { success: true };

  const code = makeCode();
  const { error } = await db.from("accounts").update({
    reset_code_hash: await codeHash(code),
    reset_expires: now + CODE_TTL_MS,
    reset_tries: 0,
  }).eq("player_id", row.player_id);
  if (error) return { error: "server" };

  await sendMail(row.email, code, row.username || "there");
  // Always a plain success, so the reply never reveals the email address.
  return { success: true };
}

// ---- resetPassword: check the code, then set the new password ----
async function resetPassword(p: any) {
  const row = await findAccount(p.account);
  const code = String(p.code ?? "").trim();
  const newPass = String(p.password ?? "");
  if (!newPass || newPass.length > MAX_PASS_CHARS) return { error: "badpass" };
  // A missing account looks the same as a wrong code.
  if (!row || !row.reset_code_hash) return { error: "badcode" };
  if (Date.now() > Number(row.reset_expires || 0)) return { error: "expired" };
  if (Number(row.reset_tries || 0) >= MAX_TRIES) return { error: "toomany" };

  if ((await codeHash(code)) !== row.reset_code_hash) {
    await db.from("accounts").update({ reset_tries: Number(row.reset_tries || 0) + 1 }).eq("player_id", row.player_id);
    return { error: "badcode" };
  }

  // The code was right. Scramble the new password the same way "api" does.
  const { data: hash } = await db.rpc("make_hash", { p_pass: newPass });
  const { error } = await db.from("accounts").update({
    password_hash: hash,
    reset_code_hash: null,
    reset_expires: null,
    reset_tries: 0,
  }).eq("player_id", row.player_id);
  if (error) return { error: "server" };
  return { success: true };
}

// ---- the one entry point ----
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let p: any;
  try {
    p = JSON.parse(await req.text());
  } catch (_e) {
    return json({ error: "badjson" }, 400);
  }

  try {
    if (p.action === "setEmail") return json(await setEmail(p));
    if (p.action === "requestPasswordReset") return json(await requestPasswordReset(p));
    if (p.action === "resetPassword") return json(await resetPassword(p));
    return json({ error: "unknownaction" }, 400);
  } catch (_e) {
    return json({ error: "server" }, 500);
  }
});
