# The Clicker Game!

A browser-based clicker/idle game by **Here Studios**. Tap the avatar, earn moneys, buy upgrades, prestige, and compete on a shared leaderboard. Built as a single self-contained `index.html` file (vanilla HTML/CSS/JS, no build step) backed by a Supabase database.

## Running it

There's no build process. Either:

- Double-click `index.html` to open it directly in a browser, or
- Serve the folder with any static file server (recommended, since some browsers restrict local file access for scripts/audio):
  ```
  npx serve .
  ```
  or
  ```
  python3 -m http.server
  ```

All image and audio assets must stay in their folders next to `index.html` (see **Assets** below) or the game will load with missing art/sound.

## Backend

Accounts, sessions, game-state sync, and the leaderboard are handled by a Google Apps Script Web App backed by a Google Sheet. The frontend talks to it entirely through one endpoint:

```
const SHEET_API_URL = '...' // near the top of the <script> block
```

If you fork this project or move it to a new Sheet/Apps Script deployment, update `SHEET_API_URL` to point at your own Web App URL. All account creation, login, save/load, and leaderboard reads/writes go through this single constant.

## Features

- **Core loop** - tap the avatar to earn moneys; buy upgrades to boost income and automate clicking.
- **Shop** - Click Boost, Auto Clicker, DVD Logo (bouncing screensaver easter egg), Amogus, Roblox Noob, Screaming Goat, Custom Cursors, Background Switcher, Icon Modifier, Offline Earnings, and more, plus a separate **Prestige Shop**. Shop items are filterable by category (All / Visuals / Customization / Plain).
- **Stats** - profile (avatar/username), moneys, prestige, gems, plus subtabs for Friends, Mods, and Messages.
- **Leaderboard** - global and friends-only rankings.
- **Achievements** - unlockable achievement list with hint system.
- **Workshop / Mods** - browse, install, and upload user mods; installed mods list. Mods made in the editor can run **CGC** code (see below).
- **Mod pricing and Remix** (1.25.0) - in the mod editor, the **Auto** button next to Price sets the price to the storage percent divided by 10. Storage can go past 100%, and every percent over costs 1 extra Gem to upload (`modEditorExtraGems()`). Every mod page has a **Remix** button: if you downloaded the mod, paying `MOD_REMIX_COST` (100) Gems copies it into your editor. A published remix links to the original through `repoUrl` (the `repo_url` column), saved as `<game link>?mod=<original id>` and read by `modRemixSourceId()`.
- **Friends & Messages** - friend requests, friend picker, and a simple chat system.
- **Notification badges** (1.22.0) - a red badge above the Stats tab shows friend requests + unread messages. Inside Stats, Overview shows the friend request count and Messages shows the unread count. Polled every `NOTIF_POLL_MS` (15s).
- **New shop item alert** (1.22.0) - when a shop item becomes affordable for the first time, the Shop tab flickers yellow (purple if the player's favorite color is yellow). Clicking Shop opens the right category, scrolls to the item and flashes it. New items must be added to `SHOP_WATCH_ITEMS` to get the alert.
- **Gameplay extras** (1.24.0) - all in the `GAMEPLAY EXTRAS` section of `index.html`, none of them use the API:
  - **Floating numbers**: a `+N` pops out of the clicker on every click (gold when Lucky Charm doubles it). Off in Low Performance Mode.
  - **Moneys per second**: a chip under the clicker shows the average income of the last 5 seconds.
  - **Combo**: fast clicking multiplies your own clicks: x1.25 at 20, x1.5 at 50, x2 at 100 (`COMBO_TIERS`). It drops after 1.5 seconds without a click.
  - **Lucky Star**: shows up every 2 to 5 minutes for 12 seconds. Catching it gives a Frenzy (x3 on everything for 20 seconds) or a jackpot worth 60 seconds of income.
  - **Daily Reward**: free moneys once a day, growing over a 7 day streak. Saved per account in the `fgd_daily_<username>` localStorage key.
- **Tutorial** - first-time walkthrough that highlights each tab; replayable from Settings.
- **Click Effects:** Confetti, Screen Shake, Bubbles and Squish, picked from the Click Effects picker after buying it in the shop.
- **Settings** - mute SFX, light/dark theme, low performance mode (simplifies effects + shows an FPS counter), layout switcher (center/left/right, PC & tablet only), reset data, reset tutorial, view team applications, credits, download the game (opens the GitHub repo, set in `GAME_REPO_URL`), log out, delete account, and **Debug Mode**.
- **Debug Mode** - a draggable panel (Settings → Debug Mode → Open) showing live FPS, a few key stats (username, moneys, prestige, gems, click power), a Test Notification button, and a Page Ratio selector (Default / Phone / Tablet / PC) that previews the page at a real device viewport width in an embedded iframe, so responsive breakpoints trigger for real.
- **Responsive UI** - the game runs on desktop, tablet, and phones (Samsung and iPhone browsers included). On narrow phone widths the main tab bar (Stats / Leaderboard / Shop / Achievements / Settings) switches from labeled pill tabs to a row of circular icon buttons.

## Assets

Since 1.23.1 every file lives in a folder. Only `index.html` and `README.md` sit in the main folder.

| Folder | What goes in it |
|---|---|
| `audio/music/` | Songs: the Music Player tracks, the default background track, the tutorial track and the login screen track. |
| `audio/sfx/` | Short sound effects: `click.mp3`, `money.mp3`, `touch.mp3`, `mogus.mp3`, `goat.mp3`. |
| `fonts/` | Font files (`.ttf`). `Pusab.ttf`, `pixelated.ttf` and `MeFont.ttf` are loaded with `@font-face`. The rest are account fonts. Google Fonts (Fredoka One, Poppins, Inter) load from the CDN. |
| `images/ui/` | Game art: `profile.png`, `appearchar.png`, `tutorial-guide.png`, `biggie.png`, `arrow.png`, `money.png`, `heart.png`, `gems.png` and `maksy.ico` (favicon). |
| `images/badges/` | Account badges: `admin.png`, `dev.png`, `mod.png`, `owner.png`, `director.png`, `fam.png`, `cc.png`, `ver.png`. |
| `images/cursors/` | Built-in cursors for the Cursor Picker. |
| `images/misc/` | Spare pictures the game does not use yet. |
| `backgrounds/` | Favorite color pictures (`bg_<color>.png`) and the Background Switcher pictures. |
| `profiles/` | Starter profile pictures. Accounts save these paths, so do not rename this folder. |
| `extras/` | Songs players can add to mods. Mods save `extras/<file>`, so do not rename this folder. |
| `settings/` | The JSON lists described below. |
| `pages/` | Extra pages: `cc-rules.html` and the old `test.html` copy of the game. |

**Adding a new file:** drop it in the right folder and write the full path, like `audio/music/newsong.mp3`.

**Old names still work.** Saves, settings files and accounts made before the move can hold a bare name like `duck.png` or `gang.ttf`. `OLD_ASSET_PATHS` and `fixAssetPath()` in `index.html` turn those into the new path. Do not delete entries from `OLD_ASSET_PATHS`, old saves need them.

Missing assets won't crash the game, but will show as broken images or silent audio.

## Settings files

Built-in lists live in the `settings/` folder, so they can be changed without editing `index.html`. The game loads them when the page opens. If a file is missing or has a JSON mistake, the game falls back to the copy written inside `index.html`. Songs, cursors and backgrounds added by mods or uploads always appear after the built-in ones.

| File | What it controls |
|---|---|
| `settings/messages.json` | Loading screen messages. A plain list of text. |
| `settings/music.json` | Songs in the Music Player. |
| `settings/cursors.json` | Cursors in the Cursor Picker. |
| `settings/backgrounds.json` | Backgrounds in the Background Switcher. |
| `settings/fonts.json` | Fonts in the Font Manager. |

**music.json, cursors.json, backgrounds.json:** a list of `{ "label": "Name shown in the picker", "file": "file name" }`. Write the full path from the main folder, like `audio/music/lofi.mp3`, `images/cursors/duck.png`, `backgrounds/zen.jpeg` or `extras/name.mp3`. For cursors and backgrounds, `"default"` means the normal cursor or plain color background.

**fonts.json:** a list of `{ "label", "value", "family", "fallback", "file", "google" }`.
- `value`: short id, letters, numbers, `-` and `_` only. Never change it for an existing font, players' saved choice uses it.
- `family`: the font's name.
- `fallback`: used while it loads, like `cursive` or `sans-serif`.
- `file` (optional): a font file in the `fonts/` folder, like `fonts/caveat.ttf`.
- `google` (optional): `true` to load the family from Google Fonts.

Rules:
- Valid JSON only: double quotes, commas between entries, no comma after the last one, no comments.
- Players keep their picked song when songs are added or reordered (it is matched by file name).
- Keep the lists inside `index.html` roughly in sync as a backup.

## Versioning

Near the top of `index.html`:

```html
<!-- Game version: 1.32.0 | Deployment: 208 | Update both on every release, see README.md -->
<meta name="game-version" content="1.32.0">
```

Bump both the version comment and the `game-version` meta tag on every release. The deployment number is an internal counter for tracking Apps Script/Sheet deployments - increment it whenever the backend Web App is redeployed, even if the game version string doesn't change.

## Code layout

All the code lives in one file, `index.html`:

- `<style>` block - all CSS, organized into commented sections (e.g. `/* ---------- SHOP ---------- */`, `/* ---------- DEBUG PANEL ---------- */`). Responsive rules live in `@media (max-width:480px)` (phone) and `@media (min-width:481px)` / `(min-width:769px)` (tablet/desktop) blocks.
- HTML body - the auth flow (title/username/password/login screens), the main app shell (`#page-sidebar` with the avatar/counter, `#page-main` with the tab bar and content list), and a stack of overlay elements (tutorial, workshop, friend picker, debug panel, confirm dialogs, etc.) that are shown/hidden via JS rather than being separate pages.
- `<script>` block - game state (`game` object, persisted via `saveGame()`), the `TABS` array driving the main nav, per-tab render functions (`renderShop`, `renderStats`, `renderLeaderboard`, `renderAchievements`, `renderSettings`), and feature-specific sections (audio/music player, tutorial engine, workshop/mods, friends & chat, debug panel).

## Notes for future changes

- The main nav is data-driven - add/remove a tab by editing the `TABS` array and adding a matching branch in `renderActiveTab()`. Give it an entry in `TAB_ICONS` too, so it gets a circular icon on phone widths.
- Low performance mode and the phone/tablet/PC responsive layout are independent systems - low-perf mode simplifies visuals and is opt-in/detected by device, while responsive layout is purely CSS media queries plus the icon-vs-label swap on `.tab-btn`.
- The Debug Mode page-ratio preview works by loading `index.html` again in an iframe with `?debugPreview=1`, so real `@media` queries apply inside it. That query flag also mutes audio inside the preview frame to avoid a second copy of the music playing.

## CGC (Clicker Game Code), 1.21.0+

Mods made in the mod editor can include code written in CGC. The full player guide is inside the game: open the mod editor and click the open book button (CGC guide).

How it is built (all in `index.html`):

- `const CGC = (() => { ... })()` is the language: lexer, parser and runtime. It never uses eval. Mod code only reaches the game through a `host` object.
- `cgcLiveHost()` is the host for installed mods. **The moneys, prestige and gems rules live here and nowhere else:**
  - moneys: a mod can add exactly 1 or the player's click boost at a time, max `CGC_MONEY_ADDS_PER_SECOND` (15) times a second, and can subtract moneys the player has. No set, multiply or divide.
  - prestige: only opens the normal prestige confirm, and only if the player has `PRESTIGE_COST` moneys.
  - gems: mods can never change them.
- `cgcTestHost()` is the host for Run test in the editor. Same rules, fake moneys, nothing saved.
- `cgcStartAll()` runs at `startGame()`. Install/update calls `cgcStartMod()`, uninstall calls `cgcStopMod()`.
- Objects are drawn in `#cgc-stage` (z-index 3000: above the game, below the workshop and dialogs).
- Game events sent to mods: `c.click` (avatar click), `c.buy` (shop purchase, detected after any `.buy-btn` click that lowered moneys, prestige or gems), `c.prestige` (end of `doPrestige()`), plus `c.load`, `c.tick` and `c.second` from the runtime.

How a mod is saved (`customFiles` in the workshop row):

- `payload`: `[{ name: "cookie.png", file: "cookie.png", url }]`
- `script`: `[{ name: "main.cgc", file: "main.cgc", url: "data:text/plain;charset=utf-8,..." }]`. The code is a text data URL on purpose, so the API's installed-mods compaction and rehydration handle it like any uploaded file.

Mod data (currencies and `storage.` variables):

- In the save: `game.modData = { modId: { currency: {}, storage: {} } }`.
- To the API: `modData: [{ modId, currency, storage }]` in `saveGameData`, stored in the `mod_data` column. The API adds the column by itself (see `MIGRATIONS` at the top of the edge function), nothing to run by hand.
- Kept through prestige, kept on uninstall (a reinstall gets it back).

Rules for changing CGC:

- New game variables for `v.` go in `cgcGameVar()`. New writable ones need a rule in both hosts.
- New attributes go in `setAttr()` and the Attributes table in `CGC_GUIDE`.
- Keep `CGC_EXAMPLE_PET` (the guide's Hungry pet example) working: load it in the editor and click Run test after any change.
- **Vibecoding: Connect to AI** (1.27.0) - the guide's Vibecoding page is drawn by `cgcRenderVibeAi()`. `CGC_AIS` lists the AIs (ChatGPT, Copilot, Claude, Gemini), their chat links and preferred API models. Connect copies the prompt and opens the chat site. The optional direct link uses the player's own API key, saved only in `localStorage` (`fallgamedev-cgc-ai-key:<id>`), and calls the AI company from the browser (`cgcAiListModels()`, `cgcAiAsk()`). The key never goes to the game's API. Copilot has no public API, so it can't be linked.
- **AI helper in the mod editor** (1.28.0) - above the code box there is an `Ask <AI>` button for each linked AI (`cgcRenderHelper()`). `cgcHelperRun()` builds the prompt (`cgcHelperPrompt()`), asks the AI, reads its `FILE:` blocks (`cgcHelperParse()`), then makes or finds each file: `svg` drawings become images, `sound` note lists become small .wav files, `extras` uses a song from `extras/`, and `link` is tested before use. It puts the code in the editor, runs a test, and sends errors back to the AI up to `CGC_HELPER_MAX_FIXES` times. Undo restores the old code and Payload.
- **AI connector** (1.29.0) - lets AI apps that support connectors (MCP servers), like Claude and ChatGPT, send mods straight into the mod editor. Two parts:
  - Server: `supabase/functions/mcp/index.ts`, a Supabase Edge Function with three tools (`get_cgc_guide`, `get_mod`, `send_mod`). **Turn it on once:** Supabase dashboard > Edge Functions > Deploy a new function > Via editor, name it exactly `mcp`, paste the file, turn OFF "Verify JWT" (same as the `api` function), Deploy. It keeps its data in a private Storage bucket called `ai-links` that it creates by itself. It never touches accounts, moneys or Gems. The connector link is the API link with `api` swapped for `mcp` (`cgcConnectorUrl()`).
  - Game: the **AI connector** button above the code box (`cgcLinkPanelHtml()`). It shows a connect code, checks in with the server every few seconds while the panel is open (`cgcLinkTick()`), loads what the AI sent (`cgcLinkApply()`), runs a test and reports errors back so the AI can fix them.
  - `CGC_GUIDE` inside the function is a copy of the rules in `CGC_VIBE_PROMPT`. When CGC changes, update both and deploy the function again.
- **AI resource packs** (1.30.0) - the AI helper and the AI connector can make files for the editor's Icons, Cursors, Backgrounds and Music sections with no code and no Payload. A file says where it goes with a folder: `FILE: icons/dragon.png` for the Ask buttons, or a `folder` field in the connector's `send_mod`. `CGC_PACK_FOLDERS` holds the sizes (icons 128px, cursors 32px, backgrounds 640px). Code is optional now, so a files-only answer leaves the editor's code alone. **The `mcp` function changed, so paste `supabase/functions/mcp/index.ts` into Supabase and deploy it again.**
- **CGA export and import** (1.31.0) - the mod editor's top bar has `Export .cga` and `Import .cga`. A `.cga` (Clicker Game Archive) is a real zip with a different ending: `mod.json` (details and file list), `code.cgc` (the CGC code), `icon.*`, and the folders `icons/`, `cursors/`, `backgrounds/`, `music/`, `payload/`. Uploaded files are stored as real files, links stay links in `mod.json`. The zip is written and read in the page with no library (`cgaZip()`, `cgaUnzip()`). Import only lets in pictures, sounds, web links and `extras/` songs. Bump `CGA_VERSION` if the layout changes.
- **Forgot password + email** (1.32.0) - a `reset` edge function (`supabase/functions/reset/index.ts`), separate from `api`, with actions setEmail / requestPasswordReset / resetPassword. The game calls it at `RESET_API_URL` (api url with `/api` swapped for `/reset`). Login screen has a `Forgot your password?` link opening a reset overlay; sign-up and Advanced Settings collect a recovery email. **Setup: deploy the `reset` function (Verify JWT off), run the add-column SQL in the README header of that file, set MAILER_URL and MAILER_SECRET secrets, and deploy the Apps Script mailer (its code was shared in chat).** Reset codes are SHA-256 fingerprinted, 15-min, 5 tries, rate-limited, and never reveal whether an email exists.
- Every code box in `CGC_GUIDE` is real CGC. After changing the language or a guide page, paste its code boxes into the editor and run them.
- `MOD_EDITOR_SIZE_LIMIT` (250K) caps a mod's files, payload and code together.
