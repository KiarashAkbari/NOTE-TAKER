# AGENTS.md

Static, dependency-free web app: `index.html` + `app.js` + `sync.js` + `sw.js` +
`style.css` + `privacy.html`. There is no `package.json`, no build, no bundler,
no test runner, and no CI. Do not add any of those, and do not introduce a
framework or npm dependency — see "Non-negotiables".

## Running and verifying

```sh
python3 -m http.server 8000   # from the repo root
node --check app.js && node --check sync.js && node --check sw.js
```

- Open over `http://localhost:8000`, not `file://`: Google OAuth rejects
  `file://` origins, so sync cannot be exercised that way.
- Sync only works from an origin registered in the Google Cloud console for
  the hardcoded client id, which in practice means the GitHub Pages origin.
  Locally you can reach the sign-in button but not complete the flow.
- **`node --check` is necessary but nowhere near sufficient.** It parses; it
  does not resolve names. A helper accidentally declared *inside* another
  function still passes and then throws `ReferenceError` at its real call site.
  That exact mistake shipped in the alarm feature and disabled sync (see
  "Module scope" below). Anything touching a render path needs the jsdom run.
- There is no automated suite in the repo. For behavioural changes, drive the
  real UI in jsdom from a scratch directory (`/tmp`), and keep the harness out
  of the repo:
  - `npm i jsdom@22` — **not** the latest. jsdom 27 pulls an ESM-only
    `html-encoding-sniffer` that `require()` cannot load on this box's Node 18.
  - Load `index.html` with `runScripts: 'dangerously'`, stub `window.matchMedia`
    (jsdom lacks it and the pre-paint theme bootstrap calls it), seed
    `localStorage['personal-os-v1']`, then `eval` `app.js` **before** `sync.js`
    and dispatch `DOMContentLoaded`.
  - Stub `window.fetch` to fake Drive. Listen for `window`'s `error` event:
    a render throw inside a delegated listener is reported there, not raised
    out of `dispatchEvent`, so a naive harness reports success on broken code.
  - Cards carry no per-node listeners, so synthesise real events
    (`new w.MouseEvent('click', { bubbles: true })` on the element) rather than
    calling `.click()` on a child that does not exist.
  - **Top-level `let` / `const` are invisible to `w.eval()`.** Indirect eval gets
    its own lexical scope, so `w.eval('ringing')` throws `ReferenceError` while
    `w.checkAlarms()` works — function declarations land on the global object,
    lexical bindings do not. Assert on observable state (`document.body.classList`,
    `document.title`, `localStorage`) instead of reaching for internals, and drive
    `sync.js` through its real cached-token path rather than assigning
    `accessToken`.
  - Alarms and notifications need doubles for `Notification`,
    `navigator.serviceWorker`, `navigator.vibrate` and `AudioContext`. Make the
    `AudioContext` double resume **asynchronously**: browsers do not flip to
    `running` in the same tick, and a synchronous fake hides the autoplay-policy
    path entirely.
  - Notifications are raised through a promise (`serviceWorker.ready`), so
    `await` a macrotask before asserting on them.
- Throwaway linters, via `npx` from a scratch dir:
  - `html-validate@8` on both HTML files. Pin the major: v9's formatter needs
    `node:util.styleText`, absent on Node 18. It enforces `type` on every
    `<button>`.
  - `css-tree` for parse errors, and to assert both `html[data-theme]` blocks
    declare an identical set of custom properties.

## Git

- Work lands on `v2`; `main` is what GitHub Pages publishes. Do not push to
  `main` without being asked. They currently differ only by `README.md` and
  `environment.gif` — the app files are identical on both.
- Git refuses to run here until you add the ownership exception (the checkout
  is root-owned but the files belong to `ubuntu`):
  `git -c safe.directory=/root/note-taker <cmd>`.

## Architecture

Load order is load-bearing. `app.js` must run before `sync.js`.

- `localStorage['personal-os-v1']` is the source of truth. `app.js` owns it;
  `sync.js` never touches it.
- `window.PersonalOS` (`getState` / `setState` / `renderAll` / `toast` /
  `confirmAction`) is the only interface between the two files. It is assigned
  on the **last lines** of `app.js`, after the initial `renderAll()`. So any
  throw during first paint means `PersonalOS` never exists, and `sync.js` — which
  loads fine and mounts its own UI regardless — fails on every push with
  `getState of undefined`. A render bug is a sync outage; treat it that way.
- **`commit(mutate, opts)` is the single mutation path.** It runs the mutation,
  calls `saveState()` (which stamps `state.meta.updatedAt` and dispatches
  `pos:save`), repaints, then optionally toasts. `saveState()` has exactly one
  caller, `commit()`, by design — do not add another. Conflict resolution is
  last-write-wins on `meta.updatedAt` alone, so a mutation that skips `commit()`
  silently loses to Drive.
- `PersonalOS.setState()` deliberately does *not* dispatch `pos:save`. That
  asymmetry is the only thing preventing a remote → local → remote push loop.
  It looks like a bug. It is not.
- Rendering is full-redraw `innerHTML` template strings, but only for the
  **active** panel (`PANEL_RENDERERS[activeView]`). Painting hidden panels wasted
  most of every repaint and moved focus-bearing DOM under open dialogs. A
  consequence for testing: a bug in `taskCardHtml` is invisible until you switch
  to TASKS.
- Cards are built as HTML strings and bound with **delegated** listeners on the
  static containers (`#notes-list`, each `[data-drop-status]` column,
  `#organize-list`, `#tag-filter-list`, `#alarms-bar`). A repaint must bind zero
  new listeners; identify targets with `data-note-id` / `data-task-id` /
  `data-tag-id` / `data-alarm-id`.
- `refreshTagIndex()` rebuilds `tagsById` / `tagUsage` / `untaggedCount` once per
  render pass. Never do `state.tags.find()` per item inside a render.
- Every interpolated value must pass through `escapeHtml()` / `escapeAttr()`.
  `highlight()` finds matches in the **raw** string and escapes each segment;
  never run a needle over already-escaped output or a query like `amp;` will
  split the `&amp;` entity.
- All state read from storage or Drive goes through `sanitizeState()`, which
  coerces types, regenerates missing ids/timestamps, and prunes tag references
  that no longer resolve. It also **preserves unknown fields and a higher
  `version`** so an older browser cannot strip a newer one's data and push the
  lossy copy back to Drive. Extend `KNOWN_ITEM_FIELDS` when adding fields.
- `openDialog()` / `closeDialog()` maintain `dialogStack` and are guarded
  against double-push; `confirmAction()` rejects a second concurrent call.
  `closeDialog()` blurs focus still inside the closing dialog — otherwise
  `isTyping()` sees a stranded field and every keyboard shortcut dies.
  Side effects that must be undone on close belong in the `onClose` option, not
  on a specific button's handler: backdrop `mousedown` and `Esc` both reach
  `closeDialog()` without touching your button.

### Alarms / reminders

- Notes **and** tasks carry `alarmAt` (epoch ms or `null`) and `alarmLabel`.
  Both are in `KNOWN_ITEM_FIELDS`; `sanitizeItem()` coerces them.
- `initAlarmCheck()` starts `setInterval(checkAlarms, 1000)` **and** re-checks on
  `visibilitychange` / `focus` / `pageshow`. Those event hooks are not belt-and-
  braces: a hidden tab's timers are throttled to roughly once a minute and a
  locked phone suspends them entirely, so the interval alone is what used to make
  a manual refresh necessary.
- Firing is a mutation (it clears the alarm fields), so it goes through
  `commit()` **once per tick**, not once per item. `checkAlarms()` captures
  `label` and `kind` before mutating, because `fireAlarms()` cannot recover either
  after `alarmLabel` is blanked and the item is still in `state.notes`.
- `notifiedAlarms` (a `Set` of ids) is the once-only guard. Any wholesale state
  replacement must clear it or a re-armed alarm on the same id can never fire
  again — the cross-tab `storage` handler and `PersonalOS.setState()` both do.
  It is deliberately not persisted: a past-due alarm fires again after a reload,
  which is the desired behaviour for something you may have missed.
- **`startRinging()` / `stopRinging()` are the only places ringing begins and
  ends.** One session object owns the chime interval, the vibration interval, the
  title-flash interval, the `is-ringing` class on `<body>` and the outstanding
  notifications. Five different gestures dismiss an alarm — DISMISS, `Esc`,
  backdrop click, notification tap, notification swipe — and every one of them
  routes through `stopRinging()`. Add a sixth the same way; do not clear a timer
  in a handler. `stopRinging()` calls `closeDialog()`, whose `onClose` calls
  `stopRinging()` again, so it nulls the session **before** closing to break the
  cycle.
- Audio is one page-lifetime `AudioContext`, unlocked by the first
  `pointerdown` / `keydown`. Autoplay policy means an alarm firing before any
  gesture is silent, so `startRinging()` arms a one-shot gesture listener that
  starts the chime late if the alarm is still going. Never construct a context
  per chime.
- Notification permission is requested in `saveFromEditor()` when the user arms
  an alarm — a real gesture, with the reason on screen. Do not move it back to a
  blanket first-click prompt: a user who never sets a reminder must never be asked.
- **`showAlarmNotification()` must prefer the service worker.** Android has no
  `new Notification()` — it throws — so `registration.showNotification()` is the
  only path that works there, and it is also what lets the notification outlive
  the tab. It waits on `navigator.serviceWorker.ready` rather than reading
  `swRegistration`, because a past-due alarm fires during the first render, long
  before `register()` resolves.
- Notification delivery is asynchronous. `showAlarmNotification()` is tagged
  with the active ringing session id, so a service worker that starts only after
  the user dismisses an alarm cannot resurrect a stale OS notification. Preserve
  that guard if this code is refactored.
- `sw.js` handles `notificationclick` and `notificationclose` by `postMessage`-ing
  the page, because the page owns the sound. The worker cannot schedule anything:
  without a server to send a Web Push there is no way to alert a device whose
  browser is closed. Do not add code that pretends otherwise — the README states
  the limits and the ICS handoff plainly, and users rely on that being true.
- `sw.js` is deliberately **network-first**. This repo has no build step, no
  hashed filenames and no version handshake, so a cache-first worker would pin
  users to a stale `app.js` with no way out. Cache writes in the fetch handler
  must stay in `event.waitUntil()`: a mobile worker may terminate after returning
  the network response otherwise, leaving the offline cache only intermittently
  updated. An offline miss must return a real `Response` (the existing 503), not
  `undefined`, which makes `respondWith()` throw.
- Two different countdown formatters, on purpose: `timeRemaining()` for the
  coarse one-unit card badge, `formatCountdown()` for the ticking alarms-bar
  chip. Both floor, so a 60-minute gap reads `59M`.
- The alarms bar is a grid area (`grid-area: alarms`) in `.app-grid`, declared in
  both the desktop and the `max-width: 900px` `grid-template-areas`. Adding
  chrome rows means editing both.
- Ringing animations are `infinite` and keyed off `body.is-ringing`. The
  `prefers-reduced-motion` block deliberately **exempts** them — an alarm must
  still read as ringing — but downgrades them to slow opacity/colour cycling with
  no transforms, well under the 3Hz photosensitivity threshold.
- `privacy.html` covers the service worker and the notification permission
  explicitly. Both were added there when they were added here; keep that true.

### Cross-device delivery

- Alarm data rides the normal Drive sync. `sync.js` polls every 60s and on
  `focus` / `visibilitychange`, so any signed-in device with the app open
  converges on its own and its local tick fires the alarm.
- `pullRemoteChanges()` reuses the cached bearer token and calls **no** Google
  auth API, which is what keeps it inside the "never request a token outside a
  user click" rule. It also rate-limits itself (`REMOTE_PULL_MIN_GAP_MS`) because
  `focus` and `visibilitychange` both fire on an app switch.
- A background poll must stay silent about network failures — only
  `AuthExpiredError` surfaces, since only that needs a tap. Reporting flaky Wi-Fi
  from a poll the user never asked for turns the badge red for no reason.
- `pullRemoteChanges()` adopts remote state only when it is **strictly** newer.
  On equal timestamps a repaint would fight whatever the user is typing.
- Pushes and pulls share `syncing`. If a `pos:save` arrives while an initial sync
  or background pull owns that lock, `runPush()` sets `pushPending`; the operation
  that releases the lock must call `flushPendingPush()`. Otherwise a local edit
  made while Drive is being read is silently never uploaded.

## Non-negotiables

These encode past bugs and external requirements. Changing them needs a reason.

- **Never call `tokenClient.requestAccessToken()` outside a real user click.**
  Commit `66ac8d8` removed silent renewal because it is unreliable across
  browsers and can throw up a full login page unexpectedly. On expiry, show the
  `expired` state and wait for a tap.
- **The GSI script is injected lazily**, only when a token is actually needed.
  A user who never signs in must make zero third-party requests, because
  `privacy.html` promises exactly that. Cached-token syncs need no GSI at all —
  Drive REST only needs the bearer token.
- **`uploadRemote()` must resolve `remoteFileId` before creating**, otherwise a
  fresh page load that pushes before listing the folder creates a second data
  file and the two copies diverge.
- **The multipart boundary must be checked against the payload**
  (`makeBoundary()`). A note containing the literal boundary truncates the
  upload and corrupts the stored file.
- **Free and serverless.** No backend, no analytics, no paid service, no npm
  runtime dependency, no CDN beyond Google's own auth script.
- **`privacy.html` is a Google OAuth consent-screen requirement** and makes
  concrete claims (no backend, no analytics, `drive.appdata` only, zero
  third-party requests before sign-in). If data handling changes, update it.
- **No `window.confirm` / `alert` / `prompt`.** Use `confirmAction()` (themed,
  focus-trapped, promise-based, focuses CANCEL so a stray Enter destroys
  nothing) and offer `toast(msg, { actionLabel: 'UNDO', onAction })` after any
  destructive action.
- **Undo restores the minimum, not a whole-state snapshot.** `restoreItems()`
  splices items back at their original indices so edits the user made while the
  toast was still up are not reverted. Whole-state snapshots are correct only
  for import and delete-all.
- **Never lose typed text.** Saving an item that vanished mid-edit (another tab,
  or a Drive pull) re-creates it under its original id and says so.

## Conventions

- **Module scope.** Declare every helper at the top level of the file. A `const`
  or `function` nested inside another function is invisible to `node --check`
  and only explodes when something outside calls it. `pad` / `toLocalDate` /
  `toLocalTime` / `timeRemaining` were all once trapped inside `formatDate()`,
  after its early-return chain: `formatDate` itself kept working, every card
  render threw, and sync died silently because the throw beat the
  `window.PersonalOS` assignment. Grep the call sites before moving a helper.
- `app.js` and `sync.js` share one global lexical scope. A top-level `const`
  declared in both is a `SyntaxError` that silently kills sync — check for
  collisions when adding names.
- Task status strings are coupled to DOM ids: `not_started` / `in_progress` /
  `done` map to `col-<status>` and `count-<status>` in `index.html`. Adding a
  status means editing the HTML, `STATUS_ORDER`, `STATUS_LABEL`, and the CSS.
- Colors come only from the per-theme tokens in `style.css`. `--accent` differs
  between themes on purpose: brand `#FF6600` is 2.65:1 on the light background
  and fails contrast, so light mode uses `#A83C00`. Fills use `--accent` with
  `--on-accent` (likewise `--danger` / `--on-danger`). Both theme blocks must
  define the identical token set.
- Do not fade small text with `opacity`. `--fg-dim` is already at the AA
  minimum; 10px labels at 70% opacity measured ~3:1.
- A card that contains its own buttons must be `role="group"` with an inner
  `<button>` for its primary action — never `role="button"` around buttons.
- Theme is `html[data-theme]`, resolved before first paint by an inline script
  in `index.html`. `privacy.html` needs the same bootstrap or it renders
  unstyled, since every color token is scoped to `html[data-theme]`.
- UI text is uppercase mono for labels; status uses the `.light on|accent|off`
  dot pattern; `--gap` and the sectioned `/* ---------- */` comment layout are
  the existing house style.
- Bump `personal-os-v1` (and migrate) only if the persisted shape changes
  incompatibly; `sanitizeState()` handles additive changes already.
