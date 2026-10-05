// =====================================================================
// The Clicker Game! AI CONNECTOR (MCP server)                  1.29.0
// =====================================================================
// This is a Supabase Edge Function. It lets AI apps that support "connectors"
// (also called MCP servers), like Claude and ChatGPT, talk to the game.
//
// HOW IT FITS TOGETHER
//   1. The player opens the mod editor and clicks "AI connector". The game makes
//      a connect code (like ABCD-2345) and tells this function about it.
//   2. The player adds this function's link to their AI app as a connector and
//      tells the AI their connect code.
//   3. The AI calls the tools below. send_mod leaves a mod here for that code.
//   4. The game checks in every few seconds, picks the mod up, puts it in the
//      editor, makes the files and runs a test. It reports errors back here,
//      and the AI can read them with get_mod.
//
// HOW TO TURN IT ON (once)
//   Supabase dashboard > Edge Functions > Deploy a new function > Via editor.
//   Name it exactly:  mcp
//   Paste this whole file, turn OFF "Verify JWT" (same as the "api" function), Deploy.
//   The connector link is then:  https://YOUR-PROJECT-REF.supabase.co/functions/v1/mcp
//
// Nothing else to set up: it keeps its data in a private Storage bucket that it
// creates by itself. It never touches accounts, moneys or Gems.
// =====================================================================

const BUCKET = "ai-links";                 // private Storage bucket, one small JSON file per connect code
const MAX_CODE_CHARS = 60000;              // biggest CGC code the AI may send
const MAX_FILES = 12;                      // most files in one mod
const MAX_FILE_CHARS = 60000;              // biggest single file (an svg drawing, a note list or a link)
const MAX_BODY_CHARS = 400000;             // biggest request this function reads
const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000; // connect codes stop working a day after the game last checked in
const PROTOCOL_VERSION = "2025-06-18";     // newest MCP version this server was written for
const SERVER_INFO = { name: "the-clicker-game", title: "The Clicker Game!", version: "1.0.0" };

// The CGC language rules. Copied from CGC_VIBE_PROMPT in index.html, keep them in sync.
const CGC_GUIDE = "CGC (Clicker Game Code) is a small Lua-like language for mods in \"The Clicker Game!\". Write ONLY valid CGC. Do not use JavaScript, Lua functions, tables, arrays or anything not listed below.\n\nHOW CGC RUNS\n- The code runs top to bottom once when the mod loads. After that, \"when\" blocks run every time their event happens.\n- Comments start with --\n- Text uses double quotes. Join text with .. like \"Score: \" .. var.score. Use \\n for a new line.\n- There are no functions, tables or for/while loops. Use events, variables and repeat instead.\n- One statement per line.\n\nPREFIXES\nc.        game events: c.load, c.click (the player clicks the game's clicker), c.tick (10 times a second), c.second, c.buy (shop purchase), c.prestige\ncv.       read-only outputs of game events: cv.click (clicks so far), cv.earned, cv.tick, cv.second, cv.buy (item name), cv.prestige, cv.mousex, cv.mousey (0 to 100, last object click)\nv.        game variables you can read: v.moneys, v.prestige, v.gems, v.clickpower, v.boosts, v.autoclickers, v.achievements, v.username, v.hour, v.muted, v.prestigecost\nvar.      your variables. Make them first: var.create(\"score\", 0)\nev.       your events. Make them first: ev.create(\"levelUp\")\nstorage.  like var, but saved to the player's account forever: storage.create(\"best\", 0)\nname.png  a file in the Payload folder, like canvas.cookie.png\n\nSTATEMENTS\nprint(\"text\")\nvar.create(\"name\", startValue)      ev.create(\"name\")      storage.create(\"name\", startValue)\nvar.score.add(1)   .subtract(1)   .multiply(2)   .divide(2)   .set(5)\n   (these math words also work on storage. variables, currencies and number locals)\nlocal name = value\nlocal group = objectA, objectB, objectC      (commas make a group, att on a group changes all of them)\nname = new value                            (changes an existing local)\natt object.attribute = value\nwhen(c.click) ... end\nwhen(ev.levelUp) ... end\nwhen(myObject.click) ... end                (object events: click, hover, leave, drop)\ndo.ev.levelUp                               (runs your event)\ndo.c.click                                  (clicks the game's clicker once)\ndo.c.prestige                               (opens the prestige window, only if the player qualifies)\nif condition then ... elseif condition then ... else ... end\nrepeat(5) ... end                           (max 1000)\nplay(obj)   stop(obj)   show(obj)   hide(obj)   remove(obj)\nEvery when, if and repeat needs its own end. A local made inside a block only exists inside it.\n\nOBJECTS\ncanvas.circle   canvas.rect   canvas.tri   canvas(\"some text\")\ncanvas.cookie.png    a picture from the Payload folder\ncanvas.pop.mp3       a sound object, play it with play(name)\ngame.action          a button in Stats > Mods next to Uninstall. Set its text with att btn.action = \"Text\" and use when(btn.click).\ngame.cur             a currency shown in Stats > Mods, saved automatically. Name it with att gold.cur = \"Gold\". Use it like a number: gold.add(1), if gold >= 10 then\nLimits: 400 objects, 12 actions and 8 currencies per mod.\n\nATTRIBUTES (set with att obj.name = value, read with obj.name)\npos.x, pos.y      0 to 100, percent of the screen. The middle of the object goes there. Default 50, 50 (center).\nsize.x, size.y    pixels, or text like \"100%\" for percent of the screen. \"size\" sets both.\nclickable, dragable, visible, loop      true or false\nscale (1 is normal), rotate (degrees), opacity (0 to 1), layer (higher draws on top, default 1), round (corner radius in pixels for rects and pictures)\ncolor             \"red\", \"#ff8800\" or \"rgb(255, 136, 0)\". Fill color for shapes, letter color for text.\ntext, fontsize    words on a shape or text object, and their size in pixels\nimage             swap a picture: \"other.png\"\nevent             \"levelUp\" makes clicking the object run ev.levelUp\nfile              a sound file. A clickable object with a file plays it when clicked.\nvolume (0 to 1), speed (1 normal, 2 twice as fast, negative plays it backwards)\nActions and currencies only have: action (or cur), color (yellow if not set), icon (a Payload picture). Actions can also have event.\n\nOPERATORS AND FUNCTIONS\n+ - * / % ^      == ~= < > <= >=      and or not      (false, nil, 0 and \"\" count as false)\nfloor(x) ceil(x) round(x, decimals) abs(x) min(a, b) max(a, b) sqrt(x) random(a, b) pick(a, b, c) format(n) text(x) number(x) upper(x) lower(x)\n\nRULES THE GAME ENFORCES (code that breaks them does nothing)\n- Moneys: only v.moneys.add(1) or v.moneys.add(v.clickpower), at most 15 times a second. v.moneys.subtract(n) only works if the player has n. Moneys can't be set, multiplied or divided.\n- Prestige only through do.c.prestige, and only if the player has enough moneys.\n- Gems can never be changed.\n- For any other kind of money, make your own with game.cur.\n\nSTYLE\n- Create every var, ev, storage and local above the lines that use it.\n- Use storage for progress the player should keep.\n- Add a short comment above each part so a kid can follow it.\n\nEXAMPLE OF VALID CGC\nlocal gold = game.cur\natt gold.cur = \"Gold\"\nstorage.create(\"bestStreak\", 0)\n\nlocal button = canvas.circle\natt button.pos.x = 90\natt button.pos.y = 85\natt button.size = 100\natt button.color = \"#ff5da0\"\natt button.clickable = true\natt button.text = \"+1 Gold\"\n\nwhen(button.click)\n  gold.add(1)\n  if gold % 10 == 0 then\n    print(\"You have \" .. format(gold) .. \" gold!\")\n  end\nend";

// How the AI describes the files a mod needs. The GAME turns these into real files.
const FILE_GUIDE = `FILES
Every file name used in the code must already be in the player's Payload folder (get_mod lists them) or be sent in send_mod's "files" list. Each file has a name, a kind and content:
- kind "svg": content is a full <svg> drawing with viewBox, width and height. The game turns it into an image. The name must end in .png. Keep it simple and cartoony with a transparent background. No scripts, no links to other images.
- kind "sound": content is a note list, one note per line: frequency in Hz, then milliseconds. 0 Hz is silence. An optional first line picks the wave: "wave sine", "wave square", "wave saw" or "wave noise". At most 5 seconds in total. The name must end in .wav.
- kind "extras": content is the exact name of a song that comes with the game (get_mod lists them). The name should end in .mp3.
- kind "link": content is a direct https link to a picture (.png .jpg .gif .webp) or sound (.mp3 .wav .ogg) that really exists and is free to use. The game tests it and skips it if it doesn't load. When unsure, use svg or sound instead.
File names use only lowercase letters, numbers, - and _ plus the ending. Use shapes and text instead of files when that looks just as good.

HOW TO WORK
1. Ask the player for their connect code if they didn't give it. The game shows it in the mod editor under "AI connector".
2. Call get_mod to see the code and files they already have, and any errors from the last test.
3. Call send_mod with the COMPLETE new code and any new files.
4. Wait about 10 seconds, then call get_mod again. If "errors" is not empty, fix them and call send_mod again.
5. Tell the player in one or two short, friendly sentences what you made. They are probably a kid.`;

const TOOLS = [
  {
    name: "get_cgc_guide",
    title: "Get the CGC guide",
    description: "Returns the full rules of CGC (Clicker Game Code), the language mods for The Clicker Game! are written in, and how to send files. ALWAYS call this before writing any CGC, because CGC is not Lua or JavaScript.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_mod",
    title: "Read the player's mod",
    description: "Returns what is in the player's mod editor right now: the CGC code, the names of the files in the Payload folder, the songs that come with the game, and the errors from the last test run. Call it before changing a mod, and again about 10 seconds after send_mod to check for errors.",
    inputSchema: {
      type: "object",
      properties: { connect_code: { type: "string", description: "The player's connect code from the game's mod editor, like ABCD-2345." } },
      required: ["connect_code"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "send_mod",
    title: "Send a mod to the game",
    description: "Sends CGC code (and optional files) to the player's mod editor in The Clicker Game!. The game replaces the code in the editor, makes the files, and runs a test. The player can undo it. It never publishes anything and never changes moneys or Gems.",
    inputSchema: {
      type: "object",
      properties: {
        connect_code: { type: "string", description: "The player's connect code from the game's mod editor, like ABCD-2345." },
        code: { type: "string", description: "The COMPLETE CGC code for the mod. It replaces what is in the editor." },
        files: {
          type: "array",
          description: "New files the code needs. See get_cgc_guide for what each kind means.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "File name, like dragon.png or roar.wav." },
              kind: { type: "string", enum: ["svg", "sound", "extras", "link"] },
              content: { type: "string", description: "The svg drawing, the note list, the extras song name, or the https link." },
            },
            required: ["name", "kind", "content"],
            additionalProperties: false,
          },
        },
        message: { type: "string", description: "One or two short sentences for the player about what you made." },
      },
      required: ["connect_code", "code"],
      additionalProperties: false,
    },
  },
];

// ---------- small helpers ----------

// Reads a secret. Works on Supabase (Deno) and in the Node test.
function env(name) {
  if (typeof Deno !== "undefined") return Deno.env.get(name) || "";
  return (globalThis.process && globalThis.process.env[name]) || "";
}

// Any website or AI app may call this, so every answer carries these headers.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// "abcd-2345" -> "ABCD2345". Returns "" if it isn't a real connect code.
// Codes never use 0, 1, I or O, because those are easy to mix up.
function cleanCode(raw) {
  const code = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : "";
}

// ---------- storage: one JSON file per connect code ----------

function storageHeaders(extra) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return { Authorization: "Bearer " + key, apikey: key, ...(extra || {}) };
}
function storageUrl(code) {
  return `${env("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${code}.json`;
}

// Returns the saved link for a code, or null if there is none (or it got too old).
async function readLink(code) {
  const res = await fetch(storageUrl(code), { headers: storageHeaders() });
  if (!res.ok) return null;
  try {
    const link = await res.json();
    if (!link || Date.now() - Number(link.seenAt || 0) > LINK_LIFETIME_MS) return null;
    return link;
  } catch (_e) {
    return null;
  }
}

// Saves the link. Makes the bucket the first time it is needed.
async function writeLink(code, link) {
  const save = () => fetch(storageUrl(code), {
    method: "POST",
    headers: storageHeaders({ "Content-Type": "application/json", "x-upsert": "true" }),
    body: JSON.stringify(link),
  });
  let res = await save();
  if (!res.ok) {
    await fetch(`${env("SUPABASE_URL")}/storage/v1/bucket`, {
      method: "POST",
      headers: storageHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
    });
    res = await save();
  }
  if (!res.ok) throw new Error("storage");
}

// ---------- the game's side: /mcp/link ----------
// POST { code, state }  the game checks in: saves what is in the editor, gets any waiting mod back.
// GET  ?code=...        the game just asks if a mod is waiting.
async function handleGame(req, url) {
  if (req.method === "GET") {
    const code = cleanCode(url.searchParams.get("code"));
    if (!code) return json({ ok: false, error: "badcode" }, 400);
    const link = await readLink(code);
    return json({ ok: true, draft: link ? link.draft || null : null });
  }
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ ok: false, error: "toolarge" }, 413);
    body = JSON.parse(text);
  } catch (_e) {
    return json({ ok: false, error: "badjson" }, 400);
  }
  const code = cleanCode(body.code);
  if (!code) return json({ ok: false, error: "badcode" }, 400);
  const old = (await readLink(code)) || {};
  const st = body.state && typeof body.state === "object" ? body.state : {};
  // Only keep the fields we know, cut down to safe sizes.
  const state = {
    name: String(st.name || "").slice(0, 80),
    code: String(st.code || "").slice(0, MAX_CODE_CHARS),
    files: (Array.isArray(st.files) ? st.files : []).slice(0, 60).map((n) => String(n).slice(0, 60)),
    extras: (Array.isArray(st.extras) ? st.extras : []).slice(0, 100).map((n) => String(n).slice(0, 80)),
    errors: (Array.isArray(st.errors) ? st.errors : []).slice(0, 10).map((n) => String(n).slice(0, 300)),
    testedDraft: String(st.testedDraft || "").slice(0, 40),
  };
  await writeLink(code, { draft: old.draft || null, state, seenAt: Date.now() });
  return json({ ok: true, draft: old.draft || null });
}

// ---------- the AI's side: the three tools ----------

function toolText(text, isError) {
  return { content: [{ type: "text", text }], isError: !!isError };
}

const NO_LINK = "That connect code isn't active. Ask the player to open the mod editor in The Clicker Game!, click \"AI connector\", and read you the code shown there. The editor has to stay open.";

async function callTool(name, args) {
  if (name === "get_cgc_guide") return toolText(CGC_GUIDE + "\n\n" + FILE_GUIDE);

  const code = cleanCode(args.connect_code);
  if (!code) return toolText("That doesn't look like a connect code. It is 8 letters and numbers, like ABCD-2345. Ask the player for it.", true);
  const link = await readLink(code);
  if (!link) return toolText(NO_LINK, true);

  if (name === "get_mod") {
    const st = link.state || {};
    const waiting = link.draft && st.testedDraft !== link.draft.id;
    return toolText(JSON.stringify({
      mod_name: st.name || "",
      code: st.code || "",
      payload_files: st.files || [],
      songs_that_come_with_the_game: st.extras || [],
      errors: st.errors || [],
      note: waiting
        ? "Your last send_mod has not been tested by the game yet. Wait a few seconds and call get_mod again. If this keeps happening, the player may have closed the mod editor."
        : "This is what the game has right now.",
    }, null, 2));
  }

  if (name === "send_mod") {
    const mod = String(args.code || "");
    if (!mod.trim()) return toolText("The code is empty. Send the complete CGC code.", true);
    if (mod.length > MAX_CODE_CHARS) return toolText(`The code is too long (${mod.length} letters, the most is ${MAX_CODE_CHARS}). Make it shorter.`, true);
    const files = Array.isArray(args.files) ? args.files : [];
    if (files.length > MAX_FILES) return toolText(`That is too many files (${files.length}, the most is ${MAX_FILES}).`, true);
    const clean = [];
    for (const f of files) {
      const kind = String((f && f.kind) || "").toLowerCase();
      const content = String((f && f.content) || "");
      const fname = String((f && f.name) || "").trim();
      if (!fname || ["svg", "sound", "extras", "link"].indexOf(kind) === -1) return toolText(`File "${fname}" needs a name and a kind of svg, sound, extras or link.`, true);
      if (content.length > MAX_FILE_CHARS) return toolText(`File "${fname}" is too big. Make it simpler.`, true);
      clean.push({ name: fname.slice(0, 60), kind, content });
    }
    const draft = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      code: mod,
      files: clean,
      message: String(args.message || "").slice(0, 600),
    };
    // seenAt is left alone: only the game checking in keeps a link alive.
    await writeLink(code, { draft, state: link.state || {}, seenAt: link.seenAt });
    return toolText("Sent! The game picks it up within a few seconds, puts it in the mod editor, makes the files and runs a test. Call get_mod in about 10 seconds to see if the test found errors.");
  }

  return toolText(`There is no tool called "${name}".`, true);
}

// ---------- MCP (JSON-RPC over HTTP) ----------

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }; }

// Answers one JSON-RPC message. Returns null for notifications (they get no answer).
async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg && msg.id, -32600, "Invalid Request");
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  const params = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        // Use the version the app asked for when it sent one, so newer and older apps both work.
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: "This connector writes mods for The Clicker Game! in CGC. Call get_cgc_guide first. The player gives you a connect code from the game's mod editor (AI connector button).",
      });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(params.name || "");
      if (!TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        return rpcResult(msg.id, await callTool(name, params.arguments || {}));
      } catch (_e) {
        return rpcResult(msg.id, toolText("The Clicker Game! connector had a problem saving. Try again in a moment.", true));
      }
    }
    // This server has no prompts or resources. Empty lists keep apps that ask anyway happy.
    case "prompts/list":
      return rpcResult(msg.id, { prompts: [] });
    case "resources/list":
      return rpcResult(msg.id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(msg.id, { resourceTemplates: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function handleMcp(req) {
  if (req.method === "GET") {
    // Apps may try to open a live stream. This server answers each request by itself instead.
    const wantsStream = (req.headers.get("accept") || "").includes("text/event-stream");
    if (wantsStream) return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
    return json({ name: SERVER_INFO.title, about: "AI connector (MCP server) for The Clicker Game!. Add this link to your AI app as a custom connector.", tools: TOOLS.map((t) => t.name) });
  }
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json(rpcError(null, -32600, "Request too large"), 413);
    body = JSON.parse(text);
  } catch (_e) {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(handleRpc))).filter((a) => a);
    return answers.length ? json(answers) : new Response(null, { status: 202, headers: CORS });
  }
  const answer = await handleRpc(body);
  return answer ? json(answer) : new Response(null, { status: 202, headers: CORS });
}

// ---------- entry point ----------

export async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS, Allow: "GET, POST, OPTIONS" } });
  const url = new URL(req.url);
  try {
    // .../mcp/link is the game checking in. Everything else is an AI app.
    if (/\/link\/?$/.test(url.pathname)) return await handleGame(req, url);
    return await handleMcp(req);
  } catch (_e) {
    return json({ ok: false, error: "server" }, 500);
  }
}

if (typeof Deno !== "undefined") Deno.serve(handle);
