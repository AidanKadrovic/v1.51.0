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

All image and audio assets referenced by the page must sit next to `index.html` in the same folder (see **Assets** below) or the game will load with missing art/sound.

## Backend

Accounts, sessions, game-state sync, and the leaderboard are handled by a Google Apps Script Web App backed by a Google Sheet. The frontend talks to it entirely through one endpoint:

```
const SHEET_API_URL = '...' // near the top of the <script> block
```

If you fork this project or move it to a new Sheet/Apps Script deployment, update `SHEET_API_URL` to point at your own Web App URL. All account creation, login, save/load, and leaderboard reads/writes go through this single constant.

## Features

- **Core loop** — tap the avatar to earn moneys; buy upgrades to boost income and automate clicking.
- **Shop** — Click Boost, Auto Clicker, DVD Logo (bouncing screensaver easter egg), Amogus, Roblox Noob, Screaming Goat, Custom Cursors, Background Switcher, Icon Modifier, Offline Earnings, and more, plus a separate **Prestige Shop**. Shop items are filterable by category (All / Visuals / Customization / Plain).
- **Stats** — profile (avatar/username), moneys, prestige, gems, plus subtabs for Friends, Mods, and Messages.
- **Leaderboard** — global and friends-only rankings.
- **Achievements** — unlockable achievement list with hint system.
- **Workshop / Mods** — browse, install, and upload user mods; installed mods list. Mods made in the editor can run **CGC** code (see below).
- **Friends & Messages** — friend requests, friend picker, and a simple chat system.
- **Tutorial** — first-time walkthrough that highlights each tab; replayable from Settings.
- **Click Effects:** Confetti, Screen Shake, Bubbles and Squish, picked from the Click Effects picker after buying it in the shop.
- **Settings** — mute SFX, light/dark theme, low performance mode (simplifies effects + shows an FPS counter), layout switcher (center/left/right, PC & tablet only), reset data, reset tutorial, view team applications, credits, log out, delete account, and **Debug Mode**.
- **Debug Mode** — a draggable panel (Settings → Debug Mode → Open) showing live FPS, a few key stats (username, moneys, prestige, gems, click power), a Test Notification button, and a Page Ratio selector (Default / Phone / Tablet / PC) that previews the page at a real device viewport width in an embedded iframe, so responsive breakpoints trigger for real.
- **Responsive UI** — the game runs on desktop, tablet, and phones (Samsung and iPhone browsers included). On narrow phone widths the main tab bar (Stats / Leaderboard / Shop / Achievements / Settings) switches from labeled pill tabs to a row of circular icon buttons.

## Assets

Expected in the same folder as `index.html`:

- **Images**: `profile.png`, `appearchar.png`, `tutorial-guide.png`, `biggie.png`, `arrow.png`, `money.png`, `heart.png`, `gems.png`, role icons (`admin.png`, `dev.png`, `mod.png`, `owner.png`, `director.png`, `fam.png`, `cc.png`), a `profiles/` folder for user profile pictures, and `maksy.ico` (favicon).
- **Fonts**: `Pusab.ttf`, `pixelated.ttf`, `MeFont.ttf` (custom `@font-face` fonts), plus Google Fonts (Fredoka One, Poppins, Inter) loaded from CDN.
- **Audio**: the default background track, the tutorial and auth-screen tracks, and the selectable Music Player tracks (see the `SONGS` array in the script for the current filename list).

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

**music.json, cursors.json, backgrounds.json:** a list of `{ "label": "Name shown in the picker", "file": "file name" }`. File names work like every other asset: put the file next to `index.html` (or in `extras/` and write `extras/name.mp3`). For cursors and backgrounds, `"default"` means the normal cursor or plain color background.

**fonts.json:** a list of `{ "label", "value", "family", "fallback", "file", "google" }`.
- `value`: short id, letters, numbers, `-` and `_` only. Never change it for an existing font, players' saved choice uses it.
- `family`: the font's name.
- `fallback`: used while it loads, like `cursive` or `sans-serif`.
- `file` (optional): a font file next to `index.html`, like `caveat.ttf`.
- `google` (optional): `true` to load the family from Google Fonts.

Rules:
- Valid JSON only: double quotes, commas between entries, no comma after the last one, no comments.
- Players keep their picked song when songs are added or reordered (it is matched by file name).
- Keep the lists inside `index.html` roughly in sync as a backup.

## Versioning

Near the top of `index.html`:

```html
<!-- Game version: 1.21.0 | Deployment: 205 | Update both on every release, see README.md -->
<meta name="game-version" content="1.21.0">
```

Bump both the version comment and the `game-version` meta tag on every release. The deployment number is an internal counter for tracking Apps Script/Sheet deployments — increment it whenever the backend Web App is redeployed, even if the game version string doesn't change.

## Code layout

Everything lives in one file:

- `<style>` block — all CSS, organized into commented sections (e.g. `/* ---------- SHOP ---------- */`, `/* ---------- DEBUG PANEL ---------- */`). Responsive rules live in `@media (max-width:480px)` (phone) and `@media (min-width:481px)` / `(min-width:769px)` (tablet/desktop) blocks.
- HTML body — the auth flow (title/username/password/login screens), the main app shell (`#page-sidebar` with the avatar/counter, `#page-main` with the tab bar and content list), and a stack of overlay elements (tutorial, workshop, friend picker, debug panel, confirm dialogs, etc.) that are shown/hidden via JS rather than being separate pages.
- `<script>` block — game state (`game` object, persisted via `saveGame()`), the `TABS` array driving the main nav, per-tab render functions (`renderShop`, `renderStats`, `renderLeaderboard`, `renderAchievements`, `renderSettings`), and feature-specific sections (audio/music player, tutorial engine, workshop/mods, friends & chat, debug panel).

## Notes for future changes

- The main nav is data-driven — add/remove a tab by editing the `TABS` array and adding a matching branch in `renderActiveTab()`. Give it an entry in `TAB_ICONS` too, so it gets a circular icon on phone widths.
- Low performance mode and the phone/tablet/PC responsive layout are independent systems — low-perf mode simplifies visuals and is opt-in/detected by device, while responsive layout is purely CSS media queries plus the icon-vs-label swap on `.tab-btn`.
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
- Keep `CGC_EXAMPLE_BAKERY` working: load it in the editor and click Run test after any change.
- `MOD_EDITOR_SIZE_LIMIT` (250K) caps a mod's files, payload and code together.
