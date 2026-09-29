# AGENTS.md

Static 7 files: `index.html` + `app.js` + `sync.js` + `ai.js` + `sw.js` + `style.css` + `privacy.html` (`ai.js` lazy-loaded). No `package.json`, build, bundler, npm, framework, CI. Do not add any.

## Commands

```sh
python3 -m http.server 8000   # http://localhost:8000 only — file:// breaks OAuth
node --check app.js && node --check sync.js && node --check sw.js && node --check ai.js  # parse-only, misses scope bugs
```

`node --check` is necessary but not sufficient — helpers declared inside another function still pass and throw `ReferenceError` at render. Anything touching render needs jsdom (run from `/tmp`, not repo):
- `npm i jsdom@22` — not latest; 27 pulls ESM-only `html-encoding-sniffer` that fails on Node 18.
- Stub `window.matchMedia` (pre-paint theme bootstrap needs it), seed `localStorage['personal-os-v1']`, `eval` `app.js` **before** `sync.js`, dispatch `DOMContentLoaded`, stub `fetch` for Drive.
- Listen `window` `error` — delegated listener throws report there, not from `dispatchEvent`.
- Cards have no per-node listeners — use `new MouseEvent('click',{bubbles:true})` on container target, not `.click()` on child.
- Top-level `let`/`const` invisible to `w.eval()` — assert `document.body.classList`/`document.title`/`localStorage`, not lexicals. Drive sync via cached-token path, not assigning `accessToken`.

Throwaway linters from scratch dir: `html-validate@8.15` (later 8.x + v9 need `node:util.styleText` missing on 18, enforces `type` on `<button>`), `css-tree` parse + assert both `html[data-theme]` blocks declare identical token set. When `ai.js` heuristics grow, keep `parse()` pure (no DOM/commit) so jsdom can unit-test it without app bootstrapping.

## Architecture — Load Order Is Load-Bearing (`app.js` before `sync.js`)

- `localStorage['personal-os-v1']` is source of truth. `app.js` owns it; `sync.js` never touches it.
- `window.PersonalOS` (`getState`/`setState`/`renderAll`/`toast`/`confirmAction`) assigned **last lines** of `app.js` after first `renderAll()`. Any throw during first paint = `PersonalOS` never exists = sync fails with `getState of undefined`.
- `commit(mutate, opts)` is **single mutation path**: stamps `state.meta.updatedAt`, calls `saveState()` (dispatches `pos:save`), repaints. `saveState()` has one caller by design. `setState()` deliberately does **not** dispatch `pos:save` — prevents remote→local→remote loop.
- Rendering is `innerHTML` full-redraw but `PANEL_RENDERERS[activeView]` only. Never paint hidden panels (wasted work + moves focus under dialogs). Delegated listeners on static containers (`#notes-list`, `[data-drop-status]`, `#organize-list`, `#tag-filter-list`, `#alarms-bar`) — repaint binds zero listeners; targets via `data-note-id`/`data-task-id`/`data-tag-id`/`data-alarm-id`.
- `sanitizeState()` coerces, regenerates ids, prunes dangling `tagIds`, preserves **unknown fields + higher `version`** so older browser can't strip newer data. Extend `KNOWN_ITEM_FIELDS` when adding fields.
- `refreshTagIndex()` builds `tagsById`/`tagUsage`/`untaggedCount` once per render — never `state.tags.find()` per item.
- Every interpolation through `escapeHtml()`/`escapeAttr()`; `highlight()` escapes per segment on raw string, never on already-escaped output.
- Helpers must be **top-level**. `app.js`+`sync.js` share one global lexical scope — duplicate top-level `const` = `SyntaxError` that silently kills sync. Nested helpers inside `formatDate()` once shipped and broke all cards + sync.
- `openDialog()`/`closeDialog()` maintain `dialogStack` (double-push guarded); `closeDialog()` blurs focus inside closing dialog or `isTyping()` kills shortcuts; side effects belong in `onClose`, not button handler. `confirmAction()` is single-instance (rejects concurrent), focuses CANCEL.

## Sync — Don't Break the Lease

- **Never `tokenClient.requestAccessToken()` outside real click.** GSI script lazy-injected only when token needed; cached-token sync needs no GSI. Zero third-party requests if never signed in (`privacy.html` promise). On expiry show `expired` state, wait for tap.
- `uploadRemote()` must resolve `remoteFileId` before `POST` or fresh load creates duplicate file. `makeBoundary()` checks payload for collision. Base scope is `drive.appdata` only; Calendar expansion (below) appends `calendar.events` to same token — don't treat as separate auth.
- Conflict is last-write-wins on `meta.updatedAt` alone. Mutation skipping `commit()` silently loses.
- `pullRemoteChanges()` reuses cached bearer, calls no Google auth API, rate-limited (`REMOTE_PULL_MIN_GAP_MS`), adopts only **strictly newer** `updatedAt`. Push/pull share `syncing`; `pushPending` coalesces `pos:save` during lock, `flushPendingPush()` must drain it. Background polls stay silent except `AuthExpiredError`. `pagehide` flushes pending push; `online` event retries with cached token (no GSI).

## Alarms / Reminders

- `alarmAt`/`alarmLabel` on notes+tasks, in `KNOWN_ITEM_FIELDS`. `initAlarmCheck()` = `setInterval(checkAlarms,1000)` + `visibilitychange`/`focus`/`pageshow` (hidden tabs throttle to ~1/min).
- Firing is mutation: `checkAlarms()` captures `label`/`kind` before clearing, `commit()` once per tick (not per item). `notifiedAlarms` Set cleared on `setState()` and cross-tab `storage` event; not persisted (past-due fires again after reload = desired).
- `startRinging()`/`stopRinging()` single owner (chime/vibrate/title-flash/`body.is-ringing`). All 5 dismiss paths (DISMISS/Esc/backdrop/notification tap/swipe) route through `stopRinging()` → nulls before `closeDialog()` to break `onClose` cycle. One page-lifetime `AudioContext` unlocked by first `pointerdown`/`keydown`; `startRinging` arms one-shot gesture resume if suspended.
- `showAlarmNotification()` must prefer `registration.showNotification()` via `navigator.serviceWorker.ready` (Android throws on `new Notification()`; ready needed because alarm can fire before `register()` resolves). Tag with `ringSessionId` so slow worker can't resurrect after dismiss.
- `sw.js` handles `notificationclick`/`notificationclose` via `postMessage` — it cannot schedule; without server, closed browser cannot ring (ICS handoff covers it). `privacy.html` must cover SW + notification permission.

## AI Task Generation — Optional, 100% Free, Offline+Online

- **Toggles:** `pos-ai-enabled` and `pos-calendar-enabled`, both default `OFF`. When off → zero loads, zero requests, zero DOM (mirrors GSI privacy promise). Keep keys as-is; don't rename without migration.
- **UX:** single free-text input → AI creates 1..N notes/tasks with `title`/`body`/`tagIds`/`alarmAt`/`alarmLabel` + calendar event. All fields through existing `commit()` (capture `label`/`kind` before clear) and `KNOWN_ITEM_FIELDS`+`sanitizeItem()` — new fields must extend list or older clients strip them.
- **100% free, no backend, no paid API, no API key, no npm, no CDN** beyond Google's own GSI. Must work **offline and online**. Implement as `ai.js` **lazy-loaded like GSI** (inject only when toggle on + text submitted), vendored static JS cached by `sw.js` (add to `ASSETS`, bump `CACHE` e.g. `personal-os-shell-v2`). Allowed: vendored heuristic date/entity parser (regex/natural-date logic copied as plain JS) or small vendored WASM (e.g. `transformers.js` build) or `window.ai`/`LanguageModel` if present with heuristic fallback. Never require server proxy or runtime `npm install`.
- **Calendar:** ICS mandatory fallback — keep `downloadICS()` (local `Blob` → `.ics`). When `pos-calendar-enabled` is off: ICS + `https://calendar.google.com/calendar/render?action=TEMPLATE&text=&dates=&details=` template URL only (zero-auth). When on: reuse same `accessToken` from single sign-in for Calendar API (see below); ICS stays.

## Single Sign-In — Calendar Optional but One Consent

- **One tap for Drive+Calendar:** extend `sync.js` `tokenClient` scope to one string: `https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events`. Single `requestAccessToken()` on existing SYNC button click yields one `accessToken` for both. Gate actual Calendar `fetch` calls behind `pos-calendar-enabled`; when off, never touch Calendar API.
- Adding a scope requires updating `privacy.html` (OAuth consent-screen requirement) and `GOOGLE_CLIENT_ID` registration for the origin (GitHub Pages + `http://localhost:8000`). Incremental `requestAccessToken({scope: calendar.events})` as second popup is rejected — violates one sign-in preference.
- Handling: reuse cached bearer for Calendar like Drive; no extra GSI call. If consent rejected, keep Drive sync working; surface `expired` only for real auth failure.

## Non-Negotiables

- Free and serverless permanently. No analytics, backend, paid tier, CDN beyond GSI.
- No `window.confirm`/`alert`/`prompt` — use `confirmAction()` + `toast({actionLabel:'UNDO',onAction})` with `restoreItems()` minimal splice (not whole-state snapshot except import/delete-all).
- Never lose typed text — re-create missing id on save. `privacy.html` claims must stay true if data handling changes.
- Colors via per-theme tokens only; both `html[data-theme]` blocks identical set. `--accent` differs by theme for contrast (`#A83C00` light vs `#FF6600` dark). No `opacity` fade on 10px labels.
- `status` strings coupled to `col-<status>`/`count-<status>` DOM ids + `STATUS_ORDER`/`STATUS_LABEL`/`style.css`.

## Git & Conventions

- Work on `v2`; `main` is Pages. `git -c safe.directory=/root/note-taker <cmd>` (root-owned checkout).
- State key is `personal-os-v1` — bump + migrate only on incompatible shape. Theme via `html[data-theme]` pre-paint bootstrap in `index.html` (duplicate in `privacy.html`). Grid areas `topbar`/`alarms`/`rail`/`content` declared in both desktop and `max-width:900px` — editing chrome means editing both.
- Verification after any render/toggle/sync change: exercise **active + hidden panels** (task card bugs invisible until `TASKS`), test both toggles via cached-token + stubbed `fetch` path.
