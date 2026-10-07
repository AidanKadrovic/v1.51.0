// =====================================================================
// The Clicker Game! ROOMS + SERVERS (multiplayer)               1.40.0
// =====================================================================
// A SEPARATE Supabase Edge Function from "api", so the main backend is
// never touched. The game calls it at the api link with /api swapped
// for /rooms (see ROOMS_API_URL in index.html).
//
// WHAT A ROOM IS
//   A room or server is one shared game save that many players play at
//   the same time. It starts from a clean slate. The save is the "state"
//   column (JSON), built the same way as an account's save but separate
//   from every account.
//     room    free, private, joined with a room code. It is deleted when
//             the host leaves (or stops answering for HOST_TIMEOUT_MS).
//     server  costs SERVER_COST Gems to open, always up, public, shown in
//             the server browser. Can have an entrance fee, admins and
//             extra owners.
//
// THE MONTHLY BILL (1.40.0)
//   A server costs RENT_COST Gems every RENT_PERIOD_MS (30 days). The Gems
//   come out of the host's account by themselves. If the host does not
//   have enough, the bill is "late": the server stays open for
//   RENT_GRACE_MS (a week) and the host's game shows a warning. After
//   that week the server is "offline": nobody can open it until the bill
//   is paid. Nothing is deleted, it just waits.
//   Everything about the bill lives in the room's meta column:
//     meta.rentDue    when the next bill is due (a time in milliseconds)
//     meta.rentTried  the last time someone tried to pay it
//   No new table columns and no new secrets are needed.
//
// HOW PLAYERS STAY IN SYNC
//   Every couple of seconds each player sends what changed on their
//   screen since the last answer ("deltas" for numbers, "sets" for
//   on/off values). The function adds everyone's changes to the shared
//   save and sends the new save back. Adding (instead of overwriting)
//   is what lets two players click at the same moment without losing
//   clicks.
//
// TURN IT ON (once), same as "reset" and "mcp":
//   Supabase dashboard > Edge Functions > Deploy a new function > Via editor.
//   Name it exactly:  rooms
//   Paste this whole file, turn OFF "Verify JWT" (same as "api"), Deploy.
//
// THE TABLE
//   The function tries to make its "rooms" table by itself the first time
//   it runs (see ensureTable). If the Rooms tab says the table is missing,
//   run this once in the SQL editor (safe to re-run, never deletes anything):
//
//   create table if not exists rooms (
//     id text primary key,
//     kind text not null default 'room',
//     name text not null default '',
//     icon text not null default '',
//     category text not null default 'Other',
//     password_hash text,
//     fee int not null default 0,
//     host text not null default '',
//     host_lower text not null default '',
//     host_seen bigint not null default 0,
//     state jsonb not null default '{}'::jsonb,
//     members jsonb not null default '{}'::jsonb,
//     messages jsonb not null default '[]'::jsonb,
//     meta jsonb not null default '{}'::jsonb,
//     version bigint not null default 0,
//     created_at timestamptz not null default now(),
//     updated_at timestamptz not null default now()
//   );
//   alter table rooms enable row level security;
//   notify pgrst, 'reload schema';
//
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_URL are already
// there for you. No new secrets are needed.
//
// TRUST: like "api", this function trusts the username the game sends.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- settings (keep the first four in sync with the ROOM_ constants in index.html) ----
const SERVER_COST = 1000;               // Gems to open a server
const RENT_COST = 250;                  // Gems a server costs every month (ROOM_RENT_COST in index.html)
const RENT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // one "month" between bills
const RENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;   // a late server stays open this long, then goes offline
const RENT_HEAD_START_MS = 60 * 60 * 1000;       // the host's own game gets this long to pay before anyone else's visit tries
const RENT_RETRY_MS = 60 * 60 * 1000;            // time between two tries that were started by someone who is not the host
const RENT_OWNER_RETRY_MS = 15 * 1000;           // time between two tries by the host (stops two tabs from paying twice)
const MAX_FEE = 10000;                  // biggest entrance fee, in Gems
const MAX_NAME_CHARS = 30;
const MAX_MESSAGE_CHARS = 200;
const MAX_PASSWORD_CHARS = 60;
const MAX_ONLINE = 30;                  // players online in one room at once
const MAX_SERVERS_PER_PLAYER = 3;
const MAX_MESSAGES = 60;                // how many chat messages a room keeps
const MAX_STATE_KEYS = 80;              // how many values a shared save can hold
const ONLINE_MS = 30 * 1000;            // seen this recently = online
const HOST_TIMEOUT_MS = 3 * 60 * 1000;  // a room closes when its host is gone this long
const STALE_ROOM_MS = 10 * 60 * 1000;   // forgotten rooms are swept after this long
const MEMBER_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // offline server members are forgotten after a week
const SEEN_WRITE_MS = 10 * 1000;        // a quiet player's "last seen" is only saved this often
const MESSAGE_COOL_MS = 700;            // time between two messages from one player
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0 1 I O
const CODE_LENGTH = 6;
const CATEGORIES = ["Chill", "Grind", "Speedrun", "Friends", "Competitive", "Roleplay", "Other"];

// Who can do what. A bigger number can manage a smaller one.
const RANK: Record<string, number> = { member: 0, admin: 1, owner: 2, host: 3 };

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

// A random code like "7KQ4MP". It is the room's id AND its join code.
function makeCode() {
  const bytes = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// Room passwords are kept only as a SHA-256 fingerprint.
async function passHash(roomId: string, password: string) {
  const data = new TextEncoder().encode("cga-room:" + roomId + ":" + password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------
// THE TABLE: made once per cold start if it is missing.
// ---------------------------------------------------------------------
const TABLE_SQL = `
  create table if not exists rooms (
    id text primary key,
    kind text not null default 'room',
    name text not null default '',
    icon text not null default '',
    category text not null default 'Other',
    password_hash text,
    fee int not null default 0,
    host text not null default '',
    host_lower text not null default '',
    host_seen bigint not null default 0,
    state jsonb not null default '{}'::jsonb,
    members jsonb not null default '{}'::jsonb,
    messages jsonb not null default '[]'::jsonb,
    meta jsonb not null default '{}'::jsonb,
    version bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  alter table rooms enable row level security;
  notify pgrst, 'reload schema';
`;

let tableReady: Promise<void> | null = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
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
        // The table could not be made here. The SQL at the top of this file does the same by hand.
      }
    })();
  }
  return tableReady;
}

// ---------------------------------------------------------------------
// STORE: every database call lives here, so the rules below never touch
// the database directly.
// ---------------------------------------------------------------------
const store = {
  // The account row for a username, or null.
  async getAccount(username: string) {
    const key = lower(username);
    if (!key) return null;
    const { data } = await db.from("accounts").select("*").eq("username_lower", key).maybeSingle();
    return data || null;
  },
  async setGems(playerId: unknown, gems: number) {
    await db.from("accounts").update({ gems }).eq("player_id", playerId);
  },
  // { row } when found, { row: null } when there is no such room, { error } when the database failed.
  async getRoom(id: string) {
    const { data, error } = await db.from("rooms").select("*").eq("id", id).maybeSingle();
    if (error) return { error: error.code === "PGRST205" || error.code === "42P01" ? "notable" : "server" };
    return { row: data || null };
  },
  // "ok", "taken" (the code is already used) or an error word.
  async insertRoom(row: any) {
    const { error } = await db.from("rooms").insert(row);
    if (!error) return "ok";
    if (error.code === "23505") return "taken";
    if (error.code === "PGRST205" || error.code === "42P01") return "notable";
    return "server";
  },
  // Saves the row only if nobody else saved it first (the version still matches).
  async saveRoom(row: any, oldVersion: number) {
    const { data, error } = await db.from("rooms").update({
      name: row.name,
      icon: row.icon,
      category: row.category,
      host_seen: row.host_seen,
      state: row.state,
      members: row.members,
      messages: row.messages,
      meta: row.meta,
      version: oldVersion + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id).eq("version", oldVersion).select("id");
    if (error) return "server";
    return data && data.length ? "ok" : "conflict";
  },
  async deleteRoom(id: string) {
    await db.from("rooms").delete().eq("id", id);
  },
  async listServers() {
    const { data, error } = await db.from("rooms")
      .select("id,kind,name,icon,category,fee,password_hash,host,host_lower,members,meta,created_at")
      .eq("kind", "server").order("updated_at", { ascending: false }).limit(100);
    if (error) return { error: error.code === "PGRST205" || error.code === "42P01" ? "notable" : "server" };
    return { rows: data || [] };
  },
  // Every server one player hosts (for the monthly bill).
  async listServersOf(hostLower: string) {
    const { data, error } = await db.from("rooms").select("id,kind,name,icon,host,host_lower,meta")
      .eq("kind", "server").eq("host_lower", hostLower);
    if (error) return { error: error.code === "PGRST205" || error.code === "42P01" ? "notable" : "server" };
    return { rows: data || [] };
  },
  async countServersOf(hostLower: string) {
    const { data } = await db.from("rooms").select("id").eq("kind", "server").eq("host_lower", hostLower);
    return (data || []).length;
  },
  // A player can host one room at a time: opening a new one closes the old one.
  async deleteRoomsOf(hostLower: string) {
    await db.from("rooms").delete().eq("kind", "room").eq("host_lower", hostLower);
  },
  // Rooms whose host vanished without leaving.
  async sweepStaleRooms() {
    await db.from("rooms").delete().eq("kind", "room").lt("host_seen", Date.now() - STALE_ROOM_MS);
  },
};

// ---------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------

// Text a player typed, trimmed and cut to a safe length.
function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// Profile pictures are links or game files. Uploaded pictures (data: links) are too big to keep per member.
function cleanIcon(value: unknown) {
  const s = String(value ?? "");
  if (s.length > 300) return "";
  return /^(https?:\/\/|profiles\/|images\/)/.test(s) ? s : "";
}

// The clean-slate save a new room starts from. The game sends its own fresh
// values (click power starts at 1, not 0), and only plain values are kept.
function cleanState(value: unknown) {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  Object.keys(value as object).slice(0, MAX_STATE_KEYS).forEach((k) => {
    const v = (value as any)[k];
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k)) return;
    if (typeof v === "number" ? isFinite(v) && v >= 0 : typeof v === "boolean" || (typeof v === "string" && v.length <= 100)) out[k] = v;
  });
  return out;
}

// The role of a player in a room: "host", "owner", "admin", "member", or "" if they are not in it.
function roleOf(room: any, userLower: string) {
  if (room.host_lower === userLower) return "host";
  const m = room.members[userLower];
  if (!m) return "";
  return m.role === "owner" || m.role === "admin" ? m.role : "member";
}

function isOnline(member: any, now: number) {
  return now - Number(member.seen || 0) < ONLINE_MS;
}

// Adds a line to the room's chat. A system line has no sender.
function pushMessage(room: any, sender: string, text: string) {
  room.meta.msgSeq = Number(room.meta.msgSeq || 0) + 1;
  room.messages.push({ id: room.meta.msgSeq, u: sender, t: text, at: Date.now() });
  if (room.messages.length > MAX_MESSAGES) room.messages = room.messages.slice(-MAX_MESSAGES);
}

// Makes sure the JSON columns have the shape the rules expect.
function tidy(room: any) {
  if (!room.state || typeof room.state !== "object" || Array.isArray(room.state)) room.state = {};
  if (!room.members || typeof room.members !== "object" || Array.isArray(room.members)) room.members = {};
  if (!Array.isArray(room.messages)) room.messages = [];
  if (!room.meta || typeof room.meta !== "object" || Array.isArray(room.meta)) room.meta = {};
  if (!Array.isArray(room.meta.banned)) room.meta.banned = [];
  if (!Array.isArray(room.meta.paid)) room.meta.paid = [];
  room.version = Number(room.version || 0);
  return room;
}

// ---------------------------------------------------------------------
// THE MONTHLY BILL (1.40.0)
// ---------------------------------------------------------------------

// Where a server's bill stands right now:
//   "none"     not a server (rooms are free)
//   "paid"     nothing to pay yet
//   "late"     the bill is due and not paid. The server is still open for a week.
//   "offline"  the week is over. Nobody can open the server until the bill is paid.
function rentStatus(room: any, now: number) {
  if (room.kind !== "server") return "none";
  const due = Number((room.meta && room.meta.rentDue) || 0);
  if (!due || now < due) return "paid";
  return now < due + RENT_GRACE_MS ? "late" : "offline";
}

// A server from before 1.40.0 has no bill date yet. Its first bill is a month
// after the first time it is touched. Returns true if the room was changed.
function startRent(room: any, now: number) {
  if (room.kind !== "server" || Number(room.meta.rentDue || 0)) return false;
  room.meta.rentDue = now + RENT_PERIOD_MS;
  return true;
}

// The bill details the game shows (the due date, and when the server would go offline).
function rentInfo(room: any, now: number) {
  const due = Number((room.meta && room.meta.rentDue) || 0);
  return { status: rentStatus(room, now), cost: RENT_COST, due, offlineAt: due ? due + RENT_GRACE_MS : 0 };
}

// True when a visit by someone who is NOT the host should try to pay the bill.
// The host's own game gets a head start, because it also takes the Gems off the
// host's screen. This is the backup for a host who is not playing right now.
function rentBackupReady(room: any, now: number) {
  if (rentStatus(room, now) === "paid" || room.kind !== "server") return false;
  return now >= Number(room.meta.rentDue || 0) + RENT_HEAD_START_MS && now - Number(room.meta.rentTried || 0) >= RENT_RETRY_MS;
}

// Tries to pay one server's bill out of the host's Gems. Returns how many Gems it took (0 = not paid).
//   byOwner = true   the host's own game is asking (it takes the Gems off the host's screen too)
//   byOwner = false  someone else touched the server while the host was away
// It works in three steps so a busy server can never be charged twice:
//   1. "claim" the try by saving meta.rentTried (only one request can win that save)
//   2. take the Gems from the host's account
//   3. move the due date forward
async function settleRent(roomId: string, byOwner: boolean) {
  let hostName = "";
  const claim = await mutate(roomId, (room) => {
    const now = Date.now();
    const started = startRent(room, now);
    const mine = () => (started ? { write: true, reply: { claimed: false } } : { reply: { claimed: false } });
    if (rentStatus(room, now) !== "late" && rentStatus(room, now) !== "offline") return mine();
    if (!byOwner && !rentBackupReady(room, now)) return mine();
    if (byOwner && now - Number(room.meta.rentTried || 0) < RENT_OWNER_RETRY_MS) return mine();
    room.meta.rentTried = now;
    hostName = room.host;
    return { write: true, reply: { claimed: true } };
  });
  if (!claim || !claim.claimed) return 0;

  const account = await store.getAccount(hostName);
  if (!account) return 0;
  const gems = Number(account.gems);
  const readable = account.gems != null && isFinite(gems);
  // Gems that can't be read here are checked by the host's own game, so only the host's game may go on.
  if (!readable && !byOwner) return 0;
  if (readable) {
    if (gems < RENT_COST) return 0; // not enough: the bill stays late
    await store.setGems(account.player_id, gems - RENT_COST);
  }

  const done = await mutate(roomId, (room) => {
    const now = Date.now();
    const wasOffline = rentStatus(room, now) === "offline";
    // A server that was offline starts a fresh month today. Otherwise the next bill is a month after the old date.
    let due = wasOffline ? now + RENT_PERIOD_MS : Number(room.meta.rentDue || 0) + RENT_PERIOD_MS;
    if (due <= now) due = now + RENT_PERIOD_MS; // missed months are not billed again
    room.meta.rentDue = due;
    room.meta.rentTried = 0;
    pushMessage(room, "", "The monthly bill (" + RENT_COST + " Gems) was paid." + (wasOffline ? " The server is back online!" : ""));
    return { write: true, reply: { ok: true } };
  });
  if (!done || !done.ok) {
    // The date could not be saved (very rare), so give the Gems back.
    if (readable) await store.setGems(account.player_id, gems);
    return 0;
  }
  return RENT_COST;
}

// What one player gets to see of a room. sinceMsg = the last chat line they already have.
function view(room: any, userLower: string, sinceMsg: number) {
  const now = Date.now();
  const role = roleOf(room, userLower);
  const members = Object.keys(room.members).map((key) => {
    const m = room.members[key];
    return {
      username: m.username,
      role: roleOf(room, key),
      online: isOnline(m, now),
      taps: Number(m.taps || 0),
      icon: m.icon || "",
    };
  });
  const out: any = {
    success: true,
    version: room.version,
    state: room.state,
    role,
    room: {
      id: room.id,
      kind: room.kind,
      name: room.name,
      icon: room.icon,
      category: room.category,
      fee: Number(room.fee || 0),
      hasPassword: !!room.password_hash,
      host: room.host,
      createdAt: room.created_at,
      rent: room.kind === "server" ? rentInfo(room, now) : null, // the monthly bill (1.40.0)
    },
    members,
    messages: room.messages.filter((m: any) => Number(m.id) > sinceMsg),
  };
  // Only the people who can unban get the ban list.
  if (RANK[role] >= 1) out.banned = room.meta.banned;
  return out;
}

// Reads a room, lets "change" edit it, and saves it. If another player saved
// first, it reads the room again and retries, so no change is ever lost.
// change() returns { reply } and can add write:true (save) or remove:true (delete the room).
async function mutate(roomId: string, change: (room: any) => Promise<any> | any) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const got = await store.getRoom(roomId);
    if (got.error) return { error: got.error };
    if (!got.row) return { error: "closed" };
    const room = tidy(got.row);
    const oldVersion = room.version;
    const out = await change(room);
    if (out.remove) {
      await store.deleteRoom(roomId);
      return out.reply;
    }
    if (!out.write) return out.reply;
    const saved = await store.saveRoom(room, oldVersion);
    if (saved === "ok") {
      room.version = oldVersion + 1;
      return typeof out.reply === "function" ? out.reply(room) : out.reply;
    }
    if (saved !== "conflict") return { error: "server" };
    await sleep(15 + Math.floor(Math.random() * 60));
  }
  return { error: "busy" };
}

// Takes Gems from an account. Returns an error word, or "" when it worked.
// The game also takes the Gems on the player's screen (its save is what the "api" function stores).
async function chargeGems(account: any, amount: number) {
  if (amount <= 0) return "";
  const gems = Number(account.gems);
  if (account.gems == null || !isFinite(gems)) return ""; // gems are not readable here, the game checks them
  if (gems < amount) return "nogems";
  await store.setGems(account.player_id, gems - amount);
  return "";
}

// ---- create: open a new room or server ----
async function create(p: any) {
  const account = await store.getAccount(p.username);
  if (!account) return { error: "invalid" };
  const username = String(account.username || p.username);
  const userLower = lower(username);

  const kind = p.kind === "server" ? "server" : "room";
  const name = cleanText(p.name, MAX_NAME_CHARS);
  if (!name) return { error: "noname" };
  const password = String(p.password ?? "").slice(0, MAX_PASSWORD_CHARS);
  const icon = cleanText(p.icon, 16) || "\u{1F3E0}";
  const category = CATEGORIES.includes(p.category) ? p.category : "Other";
  // Only servers can have an entrance fee.
  const fee = kind === "server" ? Math.min(MAX_FEE, Math.max(0, Math.floor(Number(p.fee) || 0))) : 0;

  if (kind === "server") {
    if ((await store.countServersOf(userLower)) >= MAX_SERVERS_PER_PLAYER) return { error: "toomany" };
    const charge = await chargeGems(account, SERVER_COST);
    if (charge) return { error: charge };
  } else {
    await store.deleteRoomsOf(userLower);
  }
  await store.sweepStaleRooms();

  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = makeCode();
    const room = tidy({
      id,
      kind,
      name,
      icon,
      category,
      password_hash: password ? await passHash(id, password) : null,
      fee,
      host: username,
      host_lower: userLower,
      host_seen: now,
      state: cleanState(p.state),
      members: { [userLower]: { username, role: "owner", seen: now, taps: 0, seq: 0, icon: cleanIcon(p.avatar) } },
      messages: [],
      // rentDue: a new server's first monthly bill is a month from now.
      meta: kind === "server"
        ? { banned: [], paid: [userLower], bank: 0, msgSeq: 0, rentDue: now + RENT_PERIOD_MS, rentTried: 0 }
        : { banned: [], paid: [userLower], bank: 0, msgSeq: 0 },
      version: 0,
    });
    pushMessage(room, "", username + " opened the " + kind + ".");
    const result = await store.insertRoom(room);
    if (result === "ok") {
      room.created_at = new Date().toISOString();
      const out = view(room, userLower, 0);
      out.charged = kind === "server" ? SERVER_COST : 0;
      return out;
    }
    if (result !== "taken") return { error: result };
  }
  return { error: "server" };
}

// ---- join: enter a room with its code (and password, and fee) ----
async function join(p: any) {
  const account = await store.getAccount(p.username);
  if (!account) return { error: "invalid" };
  const username = String(account.username || p.username);
  const userLower = lower(username);
  const roomId = cleanText(p.roomId, 12).toUpperCase();
  if (!roomId) return { error: "notfound" };
  let charged = 0;
  let rentBackup = false; // true = try to pay the monthly bill after this

  const reply = await mutate(roomId, async (room) => {
    const now = Date.now();
    if (room.meta.banned.includes(userLower)) return { reply: { error: "banned" } };
    // MONTHLY BILL: nobody gets into a server that is offline, not even the host.
    startRent(room, now);
    rentBackup = rentBackupReady(room, now);
    if (rentStatus(room, now) === "offline") return { reply: { error: "unpaid", rent: rentInfo(room, now) } };
    // A room whose host is long gone is closed instead of joined.
    if (room.kind === "room" && now - Number(room.host_seen || 0) > HOST_TIMEOUT_MS && room.host_lower !== userLower) {
      return { remove: true, reply: { error: "closed" } };
    }
    const already = !!room.members[userLower];
    if (!already) {
      if (room.password_hash && (await passHash(room.id, String(p.password ?? ""))) !== room.password_hash) {
        return { reply: { error: p.password ? "badpass" : "needpass", fee: Number(room.fee || 0) } };
      }
      const online = Object.values(room.members).filter((m: any) => isOnline(m, now)).length;
      if (online >= MAX_ONLINE) return { reply: { error: "full" } };
      // The entrance fee is paid once. Coming back later is free.
      const fee = Number(room.fee || 0);
      if (fee > 0 && !room.meta.paid.includes(userLower)) {
        if (!p.payFee) return { reply: { error: "needfee", fee } };
        // mutate() can run this twice if two players save at once: only take the Gems the first time.
        if (!charged) {
          const charge = await chargeGems(account, fee);
          if (charge) return { reply: { error: charge, fee } };
          charged = fee;
        }
        room.meta.paid.push(userLower);
        room.meta.bank = Number(room.meta.bank || 0) + fee;
      }
      // Forget plain members who have not been seen for a week, so the list stays small.
      Object.keys(room.members).forEach((key) => {
        const m = room.members[key];
        if (key !== room.host_lower && m.role !== "owner" && m.role !== "admin" && now - Number(m.seen || 0) > MEMBER_KEEP_MS) {
          delete room.members[key];
        }
      });
      room.members[userLower] = { username, role: "member", seen: now, taps: 0, seq: 0, icon: cleanIcon(p.avatar) };
      pushMessage(room, "", username + " joined.");
    } else {
      room.members[userLower].seen = now;
      room.members[userLower].seq = 0; // the game starts counting its saves from 1 again
      if (p.avatar) room.members[userLower].icon = cleanIcon(p.avatar);
    }
    if (room.host_lower === userLower) room.host_seen = now;
    return { write: true, reply: (saved: any) => view(saved, userLower, 0) };
  });
  if (reply && reply.success) reply.charged = charged;
  // MONTHLY BILL: the host is away, so this visit tries to pay from the host's Gems.
  // If that brings an offline server back, the player is let in right away.
  if (rentBackup && !charged) {
    const paid = await settleRent(roomId, false);
    if (paid && reply && reply.error === "unpaid" && !p.rentRetried) return await join({ ...p, rentRetried: true });
  }
  return reply;
}

// ---- sync: send my changes, get the shared save back ----
async function sync(p: any) {
  const userLower = lower(p.username);
  const roomId = cleanText(p.roomId, 12).toUpperCase();
  const sinceMsg = Math.max(0, Math.floor(Number(p.lastMsg) || 0));
  const seq = Math.max(0, Math.floor(Number(p.seq) || 0));
  const deltas = p.deltas && typeof p.deltas === "object" ? p.deltas : {};
  const sets = p.sets && typeof p.sets === "object" ? p.sets : {};
  const taps = Math.max(0, Math.min(100000, Math.floor(Number(p.taps) || 0)));
  let payout = 0;
  let rentBackup = false; // true = try to pay the monthly bill after this

  const reply = await mutate(roomId, (room) => {
    const now = Date.now();
    if (room.meta.banned.includes(userLower)) return { reply: { error: "banned" } };
    const me = room.members[userLower];
    if (!me) return { reply: { error: "kicked" } };
    // MONTHLY BILL: an offline server sends everyone out until the bill is paid.
    const rentStarted = startRent(room, now);
    rentBackup = rentBackupReady(room, now);
    if (rentStatus(room, now) === "offline") return { reply: { error: "unpaid", rent: rentInfo(room, now) } };
    // A normal room ends when its host has been gone too long.
    if (room.kind === "room" && room.host_lower !== userLower && now - Number(room.host_seen || 0) > HOST_TIMEOUT_MS) {
      return { remove: true, reply: { error: "closed" } };
    }

    let write = rentStarted; // an old server just got its first bill date: save it
    // seq stops one save from being added twice when the game had to send it again.
    const fresh = seq > Number(me.seq || 0);
    if (fresh) {
      const keyOk = (k: string) => /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k);
      Object.keys(deltas).forEach((k) => {
        const d = Number(deltas[k]);
        if (!keyOk(k) || !isFinite(d) || d === 0) return;
        if (!(k in room.state) && Object.keys(room.state).length >= MAX_STATE_KEYS) return;
        const current = typeof room.state[k] === "number" ? room.state[k] : 0;
        const next = Math.max(0, current + d); // nothing in a save can go below zero
        if (isFinite(next)) room.state[k] = next;
        write = true;
      });
      Object.keys(sets).forEach((k) => {
        const v = sets[k];
        if (!keyOk(k)) return;
        const okType = typeof v === "boolean" || (typeof v === "string" && v.length <= 100);
        if (!okType) return;
        if (!(k in room.state) && Object.keys(room.state).length >= MAX_STATE_KEYS) return;
        room.state[k] = v;
        write = true;
      });
      if (taps > 0) {
        me.taps = Number(me.taps || 0) + taps;
        write = true;
      }
      if (write) me.seq = seq;
    }
    // The host collects the entrance fees players paid.
    if (room.host_lower === userLower && Number(room.meta.bank || 0) > 0) {
      payout = Number(room.meta.bank);
      room.meta.bank = 0;
      write = true;
    }
    // A quiet player's "last seen" is only saved now and then, to keep saves rare.
    if (write || now - Number(me.seen || 0) > SEEN_WRITE_MS) {
      me.seen = now;
      if (room.host_lower === userLower) room.host_seen = now;
      write = true;
    }
    if (!write) return { reply: view(room, userLower, sinceMsg) };
    return { write: true, reply: (saved: any) => view(saved, userLower, sinceMsg) };
  });
  if (reply && reply.success && payout > 0) reply.payout = payout;
  if (rentBackup) await settleRent(roomId, false); // MONTHLY BILL: the host is away, pay from their Gems if they have enough
  return reply;
}

// ---- chat: say something in the room's messages box ----
async function chat(p: any) {
  const userLower = lower(p.username);
  const roomId = cleanText(p.roomId, 12).toUpperCase();
  const text = cleanText(p.text, MAX_MESSAGE_CHARS);
  const sinceMsg = Math.max(0, Math.floor(Number(p.lastMsg) || 0));
  if (!text) return { error: "empty" };
  return await mutate(roomId, (room) => {
    const me = room.members[userLower];
    if (!me) return { reply: { error: "kicked" } };
    const now = Date.now();
    if (now - Number(me.lastMsg || 0) < MESSAGE_COOL_MS) return { reply: { error: "slow" } };
    me.lastMsg = now;
    pushMessage(room, me.username, text);
    return { write: true, reply: (saved: any) => view(saved, userLower, sinceMsg) };
  });
}

// ---- leave: walk out. If the host leaves a normal room, the room is gone. ----
async function leave(p: any) {
  const userLower = lower(p.username);
  const roomId = cleanText(p.roomId, 12).toUpperCase();
  return await mutate(roomId, (room) => {
    const me = room.members[userLower];
    if (!me) return { reply: { success: true } };
    if (room.kind === "room" && room.host_lower === userLower) {
      return { remove: true, reply: { success: true, closed: true } };
    }
    if (room.kind === "server" && (room.host_lower === userLower || me.role === "owner" || me.role === "admin")) {
      // Staff keep their spot (and their role) in a server, they just go offline.
      me.seen = 0;
    } else {
      delete room.members[userLower];
    }
    pushMessage(room, "", me.username + " left.");
    return { write: true, reply: { success: true } };
  });
}

// ---- moderate: kick, ban, unban, or change a role ----
async function moderate(p: any) {
  const userLower = lower(p.username);
  const targetLower = lower(p.target);
  const roomId = cleanText(p.roomId, 12).toUpperCase();
  const what = String(p.what || "");
  const sinceMsg = Math.max(0, Math.floor(Number(p.lastMsg) || 0));
  if (!targetLower) return { error: "notfound" };
  if (targetLower === userLower) return { error: "self" };

  return await mutate(roomId, (room) => {
    const myRole = roleOf(room, userLower);
    const myRank = RANK[myRole] ?? -1;
    if (myRank < 1) return { reply: { error: "forbidden" } };
    const done = { write: true, reply: (saved: any) => view(saved, userLower, sinceMsg) };

    if (what === "unban") {
      room.meta.banned = room.meta.banned.filter((b: string) => b !== targetLower);
      return done;
    }

    const target = room.members[targetLower];
    const targetRank = target ? RANK[roleOf(room, targetLower)] : 0;
    // You can only manage players below you. Nobody can manage the host.
    if (targetLower === room.host_lower || targetRank >= myRank) return { reply: { error: "forbidden" } };

    if (what === "kick" || what === "ban") {
      const name = target ? target.username : String(p.target);
      if (target) delete room.members[targetLower];
      if (what === "ban") {
        if (!room.meta.banned.includes(targetLower)) room.meta.banned.push(targetLower);
        if (room.meta.banned.length > 500) room.meta.banned = room.meta.banned.slice(-500);
        pushMessage(room, "", name + " was banned.");
      } else {
        if (!target) return { reply: { error: "notfound" } };
        pushMessage(room, "", name + " was kicked.");
      }
      return done;
    }

    if (what === "role") {
      // Admins and extra owners only exist in servers, and only owners hand out roles.
      if (room.kind !== "server" || myRank < 2) return { reply: { error: "forbidden" } };
      if (!target) return { reply: { error: "notfound" } };
      const role = p.role === "owner" || p.role === "admin" ? p.role : "member";
      target.role = role;
      pushMessage(room, "", target.username + " is now " + (role === "member" ? "a member" : role === "admin" ? "an admin" : "an owner") + ".");
      return done;
    }
    return { reply: { error: "unknownaction" } };
  });
}

// ---- remove: the host deletes their server for good ----
async function remove(p: any) {
  const userLower = lower(p.username);
  const roomId = cleanText(p.roomId, 12).toUpperCase();
  return await mutate(roomId, (room) => {
    if (room.host_lower !== userLower) return { reply: { error: "forbidden" } };
    return { remove: true, reply: { success: true, closed: true } };
  });
}

// ---- browse: the public server list ----
async function browse(p: any) {
  const userLower = lower(p.username);
  await store.sweepStaleRooms();
  const got = await store.listServers();
  if (got.error) return { error: got.error };
  const now = Date.now();
  // MONTHLY BILL: pay for a few servers whose host is away (a handful per visit keeps the list fast).
  const paidNow: Record<string, boolean> = {};
  let tries = 0;
  for (const row of (got.rows || [])) {
    if (tries >= 3) break;
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    if (!rentBackupReady({ kind: "server", meta }, now)) continue;
    tries++;
    if (await settleRent(row.id, false)) paidNow[row.id] = true;
  }
  const servers = (got.rows || []).map((row: any) => {
    const members = row.members && typeof row.members === "object" ? row.members : {};
    const keys = Object.keys(members);
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    const rent = rentInfo({ kind: "server", meta }, now);
    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      category: row.category,
      fee: Number(row.fee || 0),
      hasPassword: !!row.password_hash,
      host: row.host,
      online: keys.filter((k) => isOnline(members[k], now)).length,
      members: keys.length,
      mine: row.host_lower === userLower,
      joined: !!members[userLower],
      createdAt: row.created_at,
      // "paid", "late" or "offline". Only the host gets the dates.
      rent: paidNow[row.id] ? "paid" : rent.status,
      rentDue: row.host_lower === userLower && !paidNow[row.id] ? rent.due : 0,
      rentOfflineAt: row.host_lower === userLower && !paidNow[row.id] ? rent.offlineAt : 0,
    };
  });
  // Busiest servers first. Offline servers go to the bottom.
  servers.sort((a: any, b: any) =>
    Number(a.rent === "offline") - Number(b.rent === "offline") || b.online - a.online || b.members - a.members);
  return { success: true, servers, serverCost: SERVER_COST, rentCost: RENT_COST, categories: CATEGORIES };
}

// ---- rent: the host's game checks on the monthly bill of every server they host ----
// The game calls this when it starts and every few minutes.
//   pay: false  only look. Nothing is charged.
//   pay: true   pay every bill that is due, up to "max" bills (the game works out how many it can afford).
// The answer lists each server with its status, and "charged" = the Gems taken, so the game
// can take the same Gems off the host's screen.
async function rent(p: any) {
  const account = await store.getAccount(p.username);
  if (!account) return { error: "invalid" };
  const userLower = lower(account.username || p.username);
  const got = await store.listServersOf(userLower);
  if (got.error) return { error: got.error };

  let budget = p.pay ? Math.max(0, Math.min(MAX_SERVERS_PER_PLAYER, Math.floor(Number(p.max ?? MAX_SERVERS_PER_PLAYER)) || 0)) : 0;
  let charged = 0;
  const paid: string[] = [];
  const servers: any[] = [];
  for (const first of (got.rows || [])) {
    let room = tidy(first);
    const now = Date.now();
    const needsStart = !Number(room.meta.rentDue || 0);
    const due = rentStatus(room, now) !== "paid";
    if (needsStart) {
      // An old server: give it its first bill date (a month from now). Nothing is charged.
      await mutate(room.id, (r) => (startRent(r, Date.now()) ? { write: true, reply: { ok: true } } : { reply: { ok: true } }));
    } else if (due && budget > 0) {
      const took = await settleRent(room.id, true);
      if (took) { charged += took; budget--; paid.push(room.name); }
    }
    if (needsStart || due) {
      const again = await store.getRoom(room.id);
      if (again.row) room = tidy(again.row);
    }
    const info = rentInfo(room, Date.now());
    servers.push({ id: room.id, name: room.name, icon: room.icon, status: info.status, due: info.due, offlineAt: info.offlineAt });
  }
  return { success: true, servers, charged, paid, rentCost: RENT_COST, graceMs: RENT_GRACE_MS };
}

const ACTIONS: Record<string, (p: any) => Promise<any>> = { create, join, sync, chat, leave, moderate, remove, browse, rent };

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
    await ensureTable();
    return json(await action(p));
  } catch (_e) {
    return json({ error: "server" }, 500);
  }
});
