// =====================================================================
// The Clicker Game! MARKET (mod sales, mod packs, mod boosts)   1.42.0
// =====================================================================
// A SEPARATE Supabase Edge Function from "api", so the main backend is
// never touched. The game calls it at the api link with /api swapped
// for /market (see marketApiUrl() in index.html).
//
// WHAT IT DOES
//   SALES     When someone buys a paid mod (or a mod pack), the Gems are
//             split: AUTHOR_SHARE (60%) goes to the maker, and the rest is
//             shared equally by every staff account (owner, mod, director,
//             dev).
//   PACKS     A maker pays PACK_COST Gems to bundle mods they made into a
//             pack. A pack costs PACK_DISCOUNT (90%) of its mods added up.
//             Buying a pack gives you every mod in it. Mods you already
//             have are left out of the price.
//   BOOSTS    A maker pays Gems to boost one of their mods to the top of
//             the Workshop for a number of days (BOOST_PLANS). Longer costs
//             more. Boosting again adds time.
//
// HOW GEMS REACH PEOPLE
//   The buyer's Gems are taken with the same safe "adjust_balance" step
//   that "api" uses. Makers and staff are paid through the "gifts" table
//   (the one friends' gifts use), so the Gems show up in their game with a
//   banner the next time it checks for gifts, even if they were offline.
//   Paying their account directly would not stick: a game that is open
//   saves its own Gem count every second.
//
// THE STAFF POT
//   40% of a 10 Gem mod is 4 Gems, which can't be split evenly between
//   6 staff. So the staff's part goes into a pot first. Whenever the pot
//   holds at least 1 Gem for everyone, everyone is paid the same whole
//   amount and the leftover stays in the pot for next time. No Gem is lost.
//
// TURN IT ON (once), same as "rooms", "social", "reset" and "mcp":
//   Supabase dashboard > Edge Functions > Deploy a new function > Via editor.
//   Name it exactly:  market
//   Paste this whole file, turn OFF "Verify JWT" (same as "api"), Deploy.
//
// THE TABLES
//   The function tries to make its tables by itself the first time it runs
//   (see ensureTables). If the Workshop says the market tables are missing,
//   run this once in the SQL editor (safe to re-run, never deletes anything):
//
//   create table if not exists mod_packs (
//     id text primary key,
//     name text not null default '',
//     description text not null default '',
//     author text not null default '',
//     author_lower text not null default '',
//     mod_ids jsonb not null default '[]'::jsonb,
//     downloads int not null default 0,
//     created_at timestamptz not null default now()
//   );
//   create table if not exists market_boosts (
//     mod_id text primary key,
//     until bigint not null default 0,
//     updated_at timestamptz not null default now()
//   );
//   create table if not exists market_state (
//     key text primary key,
//     amount bigint not null default 0,
//     version bigint not null default 0
//   );
//   alter table mod_packs enable row level security;
//   alter table market_boosts enable row level security;
//   alter table market_state enable row level security;
//   notify pgrst, 'reload schema';
//
// It reads the "accounts" and "workshop" tables and uses the
// "adjust_balance" and "bump_downloads" helpers that "api" already has.
//
// TRUST: like "api", this function trusts the username the game sends.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- settings (keep these in sync with the MARKET_ constants in index.html) ----
const AUTHOR_SHARE = 0.6;               // the maker's part of every sale. Staff share the rest.
const STAFF_AUTHS = ["owner", "mod", "dir", "director", "dev"]; // who shares the staff part
const PACK_COST = 500;                  // Gems to make a mod pack
const PACK_DISCOUNT = 0.9;              // a pack costs this much of its mods added up
const PACK_MIN_MODS = 2;
const PACK_MAX_MODS = 20;
const MAX_NAME_CHARS = 40;
const MAX_DESC_CHARS = 300;
// days -> Gems. Longer boosts cost more in total but less per day.
const BOOST_PLANS: Record<string, number> = { "1": 500, "3": 1200, "7": 2500, "30": 9000 };
const DAY_MS = 24 * 60 * 60 * 1000;
const PAYER_NAME = "Workshop";          // shows as "Gift from Workshop" in the game

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Text a player typed, with odd invisible characters removed, cut to a safe length.
function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// Turns a database error into one of our error words.
function dbError(error: any) {
  return error && (error.code === "PGRST205" || error.code === "42P01") ? "notable" : "server";
}

// ---------------------------------------------------------------------
// THE TABLES: made once per cold start if they are missing.
// ---------------------------------------------------------------------
const TABLE_SQL = `
  create table if not exists mod_packs (
    id text primary key,
    name text not null default '',
    description text not null default '',
    author text not null default '',
    author_lower text not null default '',
    mod_ids jsonb not null default '[]'::jsonb,
    downloads int not null default 0,
    created_at timestamptz not null default now()
  );
  create table if not exists market_boosts (
    mod_id text primary key,
    until bigint not null default 0,
    updated_at timestamptz not null default now()
  );
  create table if not exists market_state (
    key text primary key,
    amount bigint not null default 0,
    version bigint not null default 0
  );
  alter table mod_packs enable row level security;
  alter table market_boosts enable row level security;
  alter table market_state enable row level security;
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
const store = {
  // The account row for a username (only the columns the market needs), or null.
  async getAccount(username: unknown) {
    const key = lower(username);
    if (!key) return null;
    const { data } = await db.from("accounts").select("player_id,username,username_lower,auth,installed_mods")
      .eq("username_lower", key).maybeSingle();
    return data || null;
  },
  // For a list of lowercase usernames: who keeps their mods anonymous, and each one's rank.
  async getFlags(lowerNames: string[]) {
    if (!lowerNames.length) return {} as Record<string, any>;
    const { data } = await db.from("accounts").select("username_lower,anonymous_mods,auth").in("username_lower", lowerNames);
    const out: Record<string, any> = {};
    (data || []).forEach((a: any) => { out[String(a.username_lower)] = { anonymous: !!a.anonymous_mods, auth: lower(a.auth) }; });
    return out;
  },
  // The usernames of every staff account that shares in sales.
  async getStaffNames() {
    const { data } = await db.from("accounts").select("username,auth");
    return (data || []).filter((a: any) => STAFF_AUTHS.includes(lower(a.auth))).map((a: any) => String(a.username));
  },
  // Adds (positive) or takes (negative) Gems in one safe step. Returns the new balance, or null if there are not enough.
  async adjustGems(playerId: unknown, delta: number): Promise<number | null> {
    const { data, error } = await db.rpc("adjust_balance", { p_player: playerId, p_type: "gems", p_delta: delta });
    if (error || data === null || data === undefined) return null;
    return Number(data);
  },
  // Puts Gems in a player's gift box. Their game adds them and shows a banner.
  async sendGems(toUsername: string, amount: number, note: string) {
    if (amount <= 0 || !toUsername) return;
    await db.from("gifts").insert({
      id: crypto.randomUUID(), from_user: PAYER_NAME, to_user: toUsername, type: "gems", amount,
      note: note.slice(0, 100), claimed: false,
    });
  },
  // One mod from the Workshop (only the small columns), or null.
  async getMod(modId: unknown) {
    const { data } = await db.from("workshop").select("id,name,author,price,downloads").eq("id", String(modId ?? "")).maybeSingle();
    return data || null;
  },
  async getMods(modIds: string[]) {
    if (!modIds.length) return [];
    const { data } = await db.from("workshop").select("id,name,author,price,downloads").in("id", modIds);
    return data || [];
  },
  // Counts one more download for a mod and returns the new number.
  async bumpDownloads(modId: string) {
    const { data } = await db.rpc("bump_downloads", { p_id: modId });
    return Number(data) || 0;
  },
  async listPacks() {
    const { data, error } = await db.from("mod_packs").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) return { error: dbError(error) };
    return { rows: data || [] };
  },
  async getPack(packId: unknown) {
    const { data, error } = await db.from("mod_packs").select("*").eq("id", String(packId ?? "")).maybeSingle();
    if (error) return { error: dbError(error) };
    return { row: data || null };
  },
  async insertPack(row: any) {
    const { error } = await db.from("mod_packs").insert(row);
    return error ? dbError(error) : "ok";
  },
  async updatePack(packId: string, values: Record<string, unknown>) {
    const { error } = await db.from("mod_packs").update(values).eq("id", packId);
    return error ? dbError(error) : "ok";
  },
  async deletePack(packId: string) {
    await db.from("mod_packs").delete().eq("id", packId);
  },
  async countPacksOf(authorLower: string) {
    const { data } = await db.from("mod_packs").select("id").eq("author_lower", authorLower);
    return (data || []).length;
  },
  async listBoosts() {
    const { data, error } = await db.from("market_boosts").select("mod_id,until");
    if (error) return { error: dbError(error) };
    return { rows: data || [] };
  },
  async getBoost(modId: string) {
    const { data } = await db.from("market_boosts").select("mod_id,until").eq("mod_id", modId).maybeSingle();
    return data || null;
  },
  async saveBoost(modId: string, until: number, exists: boolean) {
    const values = { until, updated_at: new Date().toISOString() };
    const { error } = exists
      ? await db.from("market_boosts").update(values).eq("mod_id", modId)
      : await db.from("market_boosts").insert({ mod_id: modId, ...values });
    return error ? dbError(error) : "ok";
  },
  // The staff pot row, made on first use.
  async getPot() {
    const { data } = await db.from("market_state").select("key,amount,version").eq("key", "staff_pot").maybeSingle();
    if (data) return { amount: Number(data.amount) || 0, version: Number(data.version) || 0 };
    await db.from("market_state").insert({ key: "staff_pot", amount: 0, version: 0 });
    return { amount: 0, version: 0 };
  },
  // Saves the pot only if nobody else changed it first (the version still matches).
  async savePot(amount: number, oldVersion: number) {
    const { data, error } = await db.from("market_state").update({ amount, version: oldVersion + 1 })
      .eq("key", "staff_pot").eq("version", oldVersion).select("key");
    return !error && !!data && data.length > 0;
  },
};

// ---------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------

// Shares out the Gems of one sale: the maker's part right away, the rest through the staff pot.
//   total   Gems the buyer paid
//   author  the maker's username
//   what    what was sold, for the note on the gift ("Cool Mod")
async function payOut(total: number, author: string, what: string) {
  if (total <= 0) return;
  const staff = await store.getStaffNames();
  // No staff accounts at all: the maker gets everything.
  const authorCut = staff.length ? Math.floor(total * AUTHOR_SHARE) : total;
  const staffCut = total - authorCut;
  await store.sendGems(author, authorCut, "Sale: " + what);
  if (staffCut <= 0 || !staff.length) return;

  // Add the staff's part to the pot and pay out whatever splits evenly.
  // If two sales land at the same moment, the second one reads the pot again and retries.
  for (let attempt = 0; attempt < 12; attempt++) {
    const pot = await store.getPot();
    const holding = pot.amount + staffCut;
    const each = Math.floor(holding / staff.length);
    const left = holding - each * staff.length;
    if (await store.savePot(left, pot.version)) {
      if (each > 0) await Promise.all(staff.map((name) => store.sendGems(name, each, "Staff share: " + what)));
      return;
    }
    await sleep(15 + Math.floor(Math.random() * 60));
  }
}

// The ids of the mods an account already has installed.
function installedIds(account: any) {
  const list = Array.isArray(account && account.installed_mods) ? account.installed_mods : [];
  return list.filter((m: any) => m && m.id).map((m: any) => String(m.id));
}

// What a pack looks like to the game.
function packView(row: any) {
  return {
    id: row.id, name: row.name, description: row.description, author: row.author,
    modIds: Array.isArray(row.mod_ids) ? row.mod_ids.map(String) : [],
    downloads: Number(row.downloads) || 0, createdAt: row.created_at,
  };
}

// The price of a pack for one buyer: PACK_DISCOUNT of the mods they do not have yet.
// The maker of the pack pays nothing for their own mods.
function packPriceFor(mods: any[], owned: string[], buyerLower: string) {
  const toGet = mods.filter((m) => !owned.includes(String(m.id)));
  const full = toGet.filter((m) => lower(m.author) !== buyerLower).reduce((sum, m) => sum + (Number(m.price) || 0), 0);
  return { toGet, price: Math.floor(full * PACK_DISCOUNT) };
}

// Checks a list of mod ids for a pack: real mods, all made by this player, no repeats.
async function checkPackMods(modIds: unknown, authorLower: string) {
  const ids = Array.from(new Set((Array.isArray(modIds) ? modIds : []).map((x) => String(x ?? "")).filter(Boolean)));
  if (ids.length < PACK_MIN_MODS) return { error: "toofew" };
  if (ids.length > PACK_MAX_MODS) return { error: "toomany" };
  const mods = await store.getMods(ids);
  if (mods.length !== ids.length) return { error: "notfound" };
  if (mods.some((m: any) => lower(m.author) !== authorLower)) return { error: "notyours" };
  return { ids };
}

// ---- get: everything the Workshop needs to draw packs and boosts ----
async function get(p: any) {
  const [packs, boosts] = await Promise.all([store.listPacks(), store.listBoosts()]);
  if (packs.error) return { error: packs.error };
  if (boosts.error) return { error: boosts.error };
  // Anonymous makers: players see "Anonymous" on their packs, like on their mods. The maker and staff see the real name.
  const viewer = lower(p.username);
  const rows = packs.rows || [];
  const flags = await store.getFlags(Array.from(new Set(rows.map((r: any) => String(r.author_lower)).concat(viewer ? [viewer] : []))));
  const viewerIsStaff = !!flags[viewer] && (STAFF_AUTHS.includes(flags[viewer].auth) || flags[viewer].auth === "admin");
  const packList = rows.map((r: any) => {
    const mine = !!viewer && r.author_lower === viewer;
    const hide = !!(flags[r.author_lower] && flags[r.author_lower].anonymous) && !mine && !viewerIsStaff;
    return { ...packView(r), author: hide ? "Anonymous" : r.author, mine };
  });
  const now = Date.now();
  const live: Record<string, number> = {};
  (boosts.rows || []).forEach((b: any) => { if (Number(b.until) > now) live[String(b.mod_id)] = Number(b.until); });
  return {
    success: true,
    packs: packList,
    boosts: live,
    packCost: PACK_COST, packDiscount: PACK_DISCOUNT, boostPlans: BOOST_PLANS, authorShare: AUTHOR_SHARE,
  };
}

// ---- buyMod: buy one paid mod, with the sale shared out ----
// Free mods (and your own mods) cost nothing and only count a download.
async function buyMod(p: any) {
  const mod = await store.getMod(p.modId);
  if (!mod) return { error: "notfound" };
  const buyer = await store.getAccount(p.username);
  if (!buyer) return { error: "invalid" };
  const price = Number(mod.price) || 0;
  const result: any = {};
  if (price > 0 && lower(buyer.username) !== lower(mod.author)) {
    const left = await store.adjustGems(buyer.player_id, -price);
    if (left === null) return { error: "nogems" };
    result.gemsRemaining = left;
    result.charged = price;
    await payOut(price, String(mod.author), String(mod.name));
  }
  const downloads = await store.bumpDownloads(String(mod.id));
  return { success: true, downloads: downloads || (Number(mod.downloads) || 0) + 1, ...result };
}

// ---- createPack: bundle your own mods into a pack (costs PACK_COST Gems) ----
async function createPack(p: any) {
  const account = await store.getAccount(p.username);
  if (!account) return { error: "invalid" };
  const authorLower = lower(account.username);
  const name = cleanText(p.name, MAX_NAME_CHARS);
  if (!name) return { error: "noname" };
  const checked = await checkPackMods(p.modIds, authorLower);
  if (checked.error) return { error: checked.error };
  if ((await store.countPacksOf(authorLower)) >= 10) return { error: "toomanypacks" };

  const row = {
    id: crypto.randomUUID(), name, description: cleanText(p.description, MAX_DESC_CHARS),
    author: String(account.username), author_lower: authorLower, mod_ids: checked.ids, downloads: 0,
    created_at: new Date().toISOString(),
  };
  // Save the pack first, then charge, so a failed save never costs Gems.
  const saved = await store.insertPack(row);
  if (saved !== "ok") return { error: saved };
  const left = await store.adjustGems(account.player_id, -PACK_COST);
  if (left === null) {
    await store.deletePack(row.id); // could not pay after all, undo the pack
    return { error: "nogems" };
  }
  return { success: true, gemsRemaining: left, charged: PACK_COST, pack: { ...packView(row), mine: true } };
}

// ---- updatePack: the maker changes the name, the words or the mods (free) ----
async function updatePack(p: any) {
  const got = await store.getPack(p.packId);
  if (got.error) return { error: got.error };
  if (!got.row) return { error: "notfound" };
  const userLower = lower(p.username);
  if (!userLower || got.row.author_lower !== userLower) return { error: "forbidden" };
  const values: Record<string, unknown> = {};
  if (p.name !== undefined) {
    const name = cleanText(p.name, MAX_NAME_CHARS);
    if (!name) return { error: "noname" };
    values.name = name;
  }
  if (p.description !== undefined) values.description = cleanText(p.description, MAX_DESC_CHARS);
  if (p.modIds !== undefined) {
    const checked = await checkPackMods(p.modIds, userLower);
    if (checked.error) return { error: checked.error };
    values.mod_ids = checked.ids;
  }
  if (Object.keys(values).length) {
    const saved = await store.updatePack(got.row.id, values);
    if (saved !== "ok") return { error: saved };
  }
  return { success: true, pack: { ...packView({ ...got.row, ...values }), mine: true } };
}

// ---- deletePack: the maker (or staff) removes a pack. The mods inside stay. ----
async function deletePack(p: any) {
  const got = await store.getPack(p.packId);
  if (got.error) return { error: got.error };
  if (!got.row) return { success: true };
  const account = await store.getAccount(p.username);
  if (!account) return { error: "invalid" };
  const isStaff = STAFF_AUTHS.includes(lower(account.auth)) || lower(account.auth) === "admin";
  if (got.row.author_lower !== lower(account.username) && !isStaff) return { error: "forbidden" };
  await store.deletePack(got.row.id);
  return { success: true };
}

// ---- buyPack: get every mod in a pack for PACK_DISCOUNT of the price ----
// "expect" is the price the game showed. If the real price is different (a mod's
// price changed, or the game's list of installed mods was old) nothing is charged
// and the real price is sent back so the game can ask again.
async function buyPack(p: any) {
  const got = await store.getPack(p.packId);
  if (got.error) return { error: got.error };
  if (!got.row) return { error: "notfound" };
  const buyer = await store.getAccount(p.username);
  if (!buyer) return { error: "invalid" };
  const ids = (Array.isArray(got.row.mod_ids) ? got.row.mod_ids : []).map(String);
  const mods = await store.getMods(ids); // mods that were deleted since are simply left out
  const { toGet, price } = packPriceFor(mods, installedIds(buyer), lower(buyer.username));
  if (!toGet.length) return { error: "haveall" };
  if (p.expect !== undefined && Math.floor(Number(p.expect)) !== price) return { error: "pricechanged", price };

  const result: any = { charged: 0 };
  if (price > 0) {
    const left = await store.adjustGems(buyer.player_id, -price);
    if (left === null) return { error: "nogems", price };
    result.gemsRemaining = left;
    result.charged = price;
    await payOut(price, String(got.row.author), String(got.row.name) + " (pack)");
  }
  await Promise.all(toGet.map((m: any) => store.bumpDownloads(String(m.id))));
  await store.updatePack(got.row.id, { downloads: (Number(got.row.downloads) || 0) + 1 });
  return { success: true, modIds: toGet.map((m: any) => String(m.id)), ...result };
}

// ---- boostMod: the maker pays to put a mod at the top of the Workshop ----
// plan = how many days ("1", "3", "7" or "30"). Boosting a boosted mod adds the days on.
async function boostMod(p: any) {
  const plan = String(p.plan ?? "");
  const price = Object.prototype.hasOwnProperty.call(BOOST_PLANS, plan) ? BOOST_PLANS[plan] : 0;
  if (!price) return { error: "badplan" };
  const mod = await store.getMod(p.modId);
  if (!mod) return { error: "notfound" };
  const account = await store.getAccount(p.username);
  if (!account) return { error: "invalid" };
  if (lower(mod.author) !== lower(account.username)) return { error: "notyours" };

  const left = await store.adjustGems(account.player_id, -price);
  if (left === null) return { error: "nogems" };
  const now = Date.now();
  const current = await store.getBoost(String(mod.id));
  const until = Math.max(now, Number(current && current.until) || 0) + Number(plan) * DAY_MS;
  const saved = await store.saveBoost(String(mod.id), until, !!current);
  if (saved !== "ok") {
    await store.adjustGems(account.player_id, price); // the boost could not be saved: give the Gems back
    return { error: saved };
  }
  return { success: true, gemsRemaining: left, charged: price, until };
}

const ACTIONS: Record<string, (p: any) => Promise<any>> = { get, buyMod, createPack, updatePack, deletePack, buyPack, boostMod };

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
