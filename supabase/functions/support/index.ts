// =====================================================================
// The Clicker Game! SUPPORT A CREATOR                            1.51.0
// =====================================================================
// A SEPARATE Supabase Edge Function from "api", so the main backend is
// never touched. The game calls it at the api link with /api swapped
// for /support (see SUPPORT_API_URL in index.html).
//
// WHAT IT DOES
//   A player with the "cc" (Content Creator) auth gets a Support button
//   on their profile. Pressing it makes you their supporter:
//     - your name shows in the creator's name font
//     - every 5 of a Shop item you buy sends 1 of that item to the creator
//   A player supports one creator at a time.
//
// WHAT IT KEEPS
//   "supports"       one row per supporter: who they support
//   "support_gifts"  items waiting for a creator. The creator's game
//                    picks them up with "claim", which also deletes them,
//                    so an item can only ever be claimed once.
//
// TURN IT ON (once), same as "social", "rooms", "reset" and "mcp":
//   Supabase dashboard > Edge Functions > Deploy a new function > Via editor.
//   Name it exactly:  support
//   Paste this whole file, turn OFF "Verify JWT" (same as "api"), Deploy.
//
// THE TABLES
//   The function tries to make its tables by itself the first time it
//   runs (see ensureTables). If the Support button says it is not set up,
//   run this once in the SQL editor (safe to re-run, never deletes anything):
//
//   create table if not exists supports (
//     player_id text primary key,
//     creator_id text not null,
//     updated_at timestamptz not null default now()
//   );
//   create index if not exists supports_creator_idx on supports (creator_id);
//   create table if not exists support_gifts (
//     id bigint generated always as identity primary key,
//     creator_id text not null,
//     from_name text not null default '',
//     item text not null,
//     amount integer not null default 1,
//     created_at timestamptz not null default now()
//   );
//   create index if not exists support_gifts_creator_idx on support_gifts (creator_id);
//   alter table supports enable row level security;
//   alter table support_gifts enable row level security;
//   notify pgrst, 'reload schema';
//
// Rows are keyed by the account's player_id (not the username), so a
// player who changes their name keeps their supporters.
//
// TRUST: like "api", "rooms" and "social", this function trusts the
// username the game sends.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- settings (keep these in sync with the SUPPORT_ constants in index.html) ----
const CREATOR_AUTH = "cc";              // the auth that gets a Support button
// Shop items a supporter can send. Mods are left out on purpose.
const ITEMS = ["clickBoost", "autoClicker", "dvd", "noob", "noobLevel", "amogus", "amogusTask", "boost", "headStart", "prestigeMult"];
const MAX_AMOUNT = 1000;                // most of one item a single "give" can send
const MAX_LOOKUP = 100;                 // most players one "get" can ask about

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

// "notable" = the tables are missing, "server" = anything else went wrong.
function dbError(error: any) {
  return error && (error.code === "PGRST205" || error.code === "42P01") ? "notable" : "server";
}

// ---------------------------------------------------------------------
// THE TABLES: made once per cold start if they are missing.
// ---------------------------------------------------------------------
const TABLE_SQL = `
  create table if not exists supports (
    player_id text primary key,
    creator_id text not null,
    updated_at timestamptz not null default now()
  );
  create index if not exists supports_creator_idx on supports (creator_id);
  create table if not exists support_gifts (
    id bigint generated always as identity primary key,
    creator_id text not null,
    from_name text not null default '',
    item text not null,
    amount integer not null default 1,
    created_at timestamptz not null default now()
  );
  create index if not exists support_gifts_creator_idx on support_gifts (creator_id);
  alter table supports enable row level security;
  alter table support_gifts enable row level security;
  notify pgrst, 'reload schema';
`;

let tablesReady: Promise<void> | null = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      const url = Deno.env.get("SUPABASE_DB_URL");
      if (!url) return;
      try {
        // Loaded here (not at the top) so a problem with it can never stop the function from starting.
        const pg = await import("https://deno.land/x/postgres@v0.19.3/mod.ts");
        const client = new pg.Client(url);
        await client.connect();
        try {
          await client.queryArray(TABLE_SQL);
        } finally {
          await client.end();
        }
      } catch (_e) {
        // The tables could not be made here. The SQL at the top of this file does the same by hand.
      }
    })();
  }
  return tablesReady;
}

// ---------------------------------------------------------------------
// STORE: every database call lives here.
// ---------------------------------------------------------------------
const ACCOUNT_COLUMNS = "player_id,username,username_lower,auth";
const store = {
  // The account row for a username, or null.
  async getAccount(username: string) {
    const key = lower(username);
    if (!key) return null;
    const { data } = await db.from("accounts").select(ACCOUNT_COLUMNS).eq("username_lower", key).maybeSingle();
    return data || null;
  },
  // The account rows for many usernames at once.
  async getAccounts(lowerNames: string[]) {
    if (!lowerNames.length) return [];
    const { data } = await db.from("accounts").select(ACCOUNT_COLUMNS).in("username_lower", lowerNames);
    return data || [];
  },
  // The account rows for many player ids at once.
  async getAccountsById(playerIds: string[]) {
    if (!playerIds.length) return [];
    const { data } = await db.from("accounts").select(ACCOUNT_COLUMNS).in("player_id", playerIds);
    return data || [];
  },
  // Who each of these players supports: { rows: [{ player_id, creator_id }] }.
  async getSupports(playerIds: string[]) {
    if (!playerIds.length) return { rows: [] };
    const { data, error } = await db.from("supports").select("player_id,creator_id").in("player_id", playerIds);
    if (error) return { error: dbError(error) };
    return { rows: data || [] };
  },
  // Makes or changes a supporter's row.
  async setSupport(playerId: string, creatorId: string) {
    const { error } = await db.from("supports")
      .upsert({ player_id: playerId, creator_id: creatorId, updated_at: new Date().toISOString() }, { onConflict: "player_id" });
    return error ? dbError(error) : "ok";
  },
  async clearSupport(playerId: string) {
    const { error } = await db.from("supports").delete().eq("player_id", playerId);
    return error ? dbError(error) : "ok";
  },
  // How many players support this creator.
  async countSupporters(creatorId: string) {
    const { count, error } = await db.from("supports").select("player_id", { count: "exact", head: true }).eq("creator_id", creatorId);
    return error ? 0 : Number(count || 0);
  },
  async addGifts(rows: Record<string, unknown>[]) {
    const { error } = await db.from("support_gifts").insert(rows);
    return error ? dbError(error) : "ok";
  },
  // Deletes a creator's waiting items and hands back what was deleted, in one step,
  // so two tabs asking at the same moment can never both get the same item.
  async takeGifts(creatorId: string) {
    const { data, error } = await db.from("support_gifts").delete().eq("creator_id", creatorId).select("from_name,item,amount");
    if (error) return { error: dbError(error) };
    return { rows: data || [] };
  },
};

// ---------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------
function isCreator(account: any) {
  return !!account && lower(account.auth) === CREATOR_AUTH;
}

// The creator a player supports right now (an account row), or null.
// A creator who lost the "cc" auth no longer counts, so the perks stop.
async function supportedCreator(playerId: string) {
  const got = await store.getSupports([playerId]);
  if (got.error) return { error: got.error };
  const row = (got.rows || [])[0];
  if (!row) return { creator: null };
  const creators = await store.getAccountsById([String(row.creator_id)]);
  const creator = creators[0] || null;
  return { creator: isCreator(creator) ? creator : null };
}

// ---- get: who I support, and who a list of players supports ----
// Answers {
//   mine:       username of the creator I support ("" for nobody)
//   supporters: how many players support me (only counted for creators)
//   people:     { "lowercase username": "creator username" } for the asked names that support somebody
// }
async function get(p: any) {
  const me = await store.getAccount(p.username);
  const names = Array.from(new Set((Array.isArray(p.usernames) ? p.usernames : []).map(lower).filter(Boolean))).slice(0, MAX_LOOKUP) as string[];
  const asked = await store.getAccounts(names);

  const ids = asked.map((a: any) => String(a.player_id));
  if (me) ids.push(String(me.player_id));
  const got = await store.getSupports(Array.from(new Set(ids)));
  if (got.error) return { error: got.error };

  // One lookup for every creator that came up.
  const creatorIdOf: Record<string, string> = {};
  (got.rows || []).forEach((r: any) => { creatorIdOf[String(r.player_id)] = String(r.creator_id); });
  const creators = await store.getAccountsById(Array.from(new Set(Object.values(creatorIdOf))));
  const creatorName: Record<string, string> = {};
  creators.forEach((c: any) => { if (isCreator(c)) creatorName[String(c.player_id)] = String(c.username); });

  const people: Record<string, string> = {};
  asked.forEach((a: any) => {
    const name = creatorName[creatorIdOf[String(a.player_id)]];
    if (name) people[String(a.username_lower)] = name;
  });

  return {
    success: true,
    mine: me ? (creatorName[creatorIdOf[String(me.player_id)]] || "") : "",
    supporters: me && isCreator(me) ? await store.countSupporters(String(me.player_id)) : 0,
    people,
  };
}

// ---- set: start supporting a creator, or stop (creator: "") ----
async function set(p: any) {
  const me = await store.getAccount(p.username);
  if (!me) return { error: "invalid" };
  const myId = String(me.player_id);

  if (!lower(p.creator)) {
    const cleared = await store.clearSupport(myId);
    return cleared === "ok" ? { success: true, mine: "" } : { error: cleared };
  }

  const creator = await store.getAccount(p.creator);
  if (!creator) return { error: "nouser" };
  if (String(creator.player_id) === myId) return { error: "self" };
  if (!isCreator(creator)) return { error: "notcreator" };

  const saved = await store.setSupport(myId, String(creator.player_id));
  if (saved !== "ok") return { error: saved };
  return { success: true, mine: String(creator.username) };
}

// ---- give: send Shop items to the creator I support ----
// gifts: [{ item, amount }]. Items that are not on the ITEMS list are skipped.
async function give(p: any) {
  const me = await store.getAccount(p.username);
  if (!me) return { error: "invalid" };
  const found = await supportedCreator(String(me.player_id));
  if (found.error) return { error: found.error };
  const creator: any = found.creator;
  if (!creator) return { error: "nosupport" };

  const rows = (Array.isArray(p.gifts) ? p.gifts : [])
    .map((g: any) => ({ item: String(g && g.item), amount: Math.min(MAX_AMOUNT, Math.floor(Number(g && g.amount) || 0)) }))
    .filter((g: any) => ITEMS.includes(g.item) && g.amount > 0)
    .slice(0, ITEMS.length)
    .map((g: any) => ({ creator_id: String(creator.player_id), from_name: String(me.username), item: g.item, amount: g.amount }));
  if (!rows.length) return { success: true, sent: 0 };

  const added = await store.addGifts(rows);
  if (added !== "ok") return { error: added };
  return { success: true, sent: rows.length, creator: String(creator.username) };
}

// ---- claim: a creator's game picks up the items waiting for it ----
// Answers { gifts: [{ from, item, amount }] } and deletes them.
async function claim(p: any) {
  const me = await store.getAccount(p.username);
  if (!me) return { error: "invalid" };
  if (!isCreator(me)) return { success: true, gifts: [] };
  const taken = await store.takeGifts(String(me.player_id));
  if (taken.error) return { error: taken.error };
  return {
    success: true,
    gifts: (taken.rows || []).map((r: any) => ({ from: String(r.from_name || ""), item: String(r.item), amount: Number(r.amount) || 0 })),
  };
}

const ACTIONS: Record<string, (p: any) => Promise<any>> = { get, set, give, claim };

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
    const name = String(p.action);
    const action = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
    if (!action) return json({ error: "unknownaction" }, 400);
    await ensureTables();
    return json(await action(p));
  } catch (_e) {
    return json({ error: "server" }, 500);
  }
});
