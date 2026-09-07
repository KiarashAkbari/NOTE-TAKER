# // PERSONAL_OS(1)_NOTE-TAKER

![Vanilla JS](https://img.shields.io/badge/CORE-VANILLA_JS-000000?style=for-the-badge&logo=javascript&logoColor=FF6600)
![Zero Dependencies](https://img.shields.io/badge/DEPENDENCIES-0-FF6600?style=for-the-badge&logoColor=white)
![No Build](https://img.shields.io/badge/BUILD_STEP-NONE-000000?style=for-the-badge&logoColor=FF6600)
![Local First](https://img.shields.io/badge/STORAGE-LOCAL_FIRST-000000?style=for-the-badge&logo=googlechrome&logoColor=FF6600)
![Drive Sync](https://img.shields.io/badge/SYNC-DRIVE_APPDATA-FF6600?style=for-the-badge&logo=googledrive&logoColor=white)
![Cost](https://img.shields.io/badge/COST-%240_FOREVER-000000?style=for-the-badge&logoColor=white)

```text
SYSTEM_STATUS:    OPERATIONAL
SOURCE_OF_TRUTH:  localStorage['personal-os-v1']
SYNC_LAYER:       GOOGLE_DRIVE_APPDATAFOLDER (OPT-IN)
BACKEND:          NONE — THERE IS NO SERVER TO TRUST
PAYLOAD:          6 STATIC FILES · ~40 KB GZIPPED
```

**[ LIVE_SYSTEM ]** → **https://kiarashakbari.github.io/NOTE-TAKER/** ·
[PRIVACY_POLICY](https://kiarashakbari.github.io/NOTE-TAKER/privacy.html)

---

## // 01_SYSTEM_OVERVIEW

**PERSONAL OS** is a notes, task-board, and tag-organizer app that ships as six
static files. No framework. No bundler. No `node_modules`. No account. No
server. Open the page and it works, instantly.

Your data lives in your browser. If you want the same data on your phone, you
tap SIGN IN and it mirrors to a hidden file in **your own** Google Drive. Not a
server we run. There is no server we run.

Every interaction is offline — reads and writes hit `localStorage` synchronously,
so nothing waits on a network. A service worker caches the app's own files, so
after the first visit even a cold load works with no connection at all. It caches
code, never your notes, and it talks to nothing.

### [ THE_NUMBERS ]

| METRIC | VALUE |
| --- | --- |
| Runtime dependencies | **0** |
| Build / install steps | **0** |
| Backend services | **0** |
| Analytics / telemetry / trackers | **0** |
| Third-party requests before you sign in | **0** |
| Total source (6 files, uncompressed) | **~143 KB** |
| Wire weight of the app itself, gzipped | **~40 KB** |
| Monthly cost to run | **$0** |

### [ CORE_CAPABILITIES ]

> **LOCAL-FIRST BY CONSTRUCTION:** `localStorage` is the source of truth, not a
> cache. Every read and write is synchronous — no spinner, no request, no
> "reconnecting…".
>
> **OPT-IN DRIVE SYNC:** One hidden JSON file in your Drive `appDataFolder`,
> reachable only by this app — invisible in your normal file list.
>
> **ZERO-TRACE UNTIL CONSENT:** Google's sign-in script is injected lazily, only
> at the moment a token is needed. Never sign in, and no third party is ever
> contacted.
>
> **UNDO ON EVERY DESTRUCTIVE ACTION:** Notes, tasks, tags, CLEAR DONE, import,
> and DELETE ALL are all reversible from the toast that follows.
>
> **NO DATA JAIL:** EXPORT BACKUP writes plain JSON straight from the browser.
> Walk away with everything, any time, in one click.
>
> **KEYBOARD-COMPLETE:** Create, search, edit, save, and move tasks between
> columns without touching the mouse.
>
> **REMINDERS THAT NEED NO SERVER:** Alarm any note or task and it rings on every
> signed-in device that has the app open — system notification, looping chime,
> vibration — until you turn it off. A closed browser cannot be woken without a
> server, so `.ics` export hands that case to your real calendar.
>
> **WORKS WITH THE NETWORK UNPLUGGED:** A service worker caches the app itself,
> so a cold load with no connection still opens. It stores code, not notes.
>
> **FORWARD-COMPATIBLE STATE:** An old browser cannot strip a newer schema's
> fields and push the lossy copy back over your good data.

---

## // 02_ARCHITECTURE_PIPELINE

Load order is load-bearing: `app.js` owns the data, `sync.js` only mirrors it.

```text
[ BROWSER_TAB ]
       |
       v
[ index.html ] — pre-paint theme bootstrap → html[data-theme] (no flash)
       |
       +──> [ app.js ] ................................ OWNS THE DATA
       |       |
       |       |── state  <────────>  localStorage['personal-os-v1']
       |       |── commit(mutate) ──> saveState()
       |       |                        |── stamps state.meta.updatedAt
       |       |                        └── dispatch 'pos:save'
       |       |── render: ACTIVE PANEL ONLY (innerHTML template strings)
       |       |── delegated listeners on static containers (repaint binds 0)
       |       |── setInterval(checkAlarms, 1000) ──> fire ──> commit()
       |       |                                        └── ring until dismissed
       |       └── window.PersonalOS = { getState, setState, renderAll,
       |                                 toast, confirmAction }
       |
       +──> [ sw.js ] .................................. OFFLINE + NOTIFY
       |       |
       |       |── network-first cache of the app's own files
       |       └── showNotification() — the only path that works on Android
       |              ^ tap/swipe ──postMessage──> page stops ringing
       |
       └──> [ sync.js ] ............................... OPTIONAL MIRROR
               |
               |── on 'pos:save'  ──> debounce 1.5s ──> multipart upload
               |── on load + cached token ──> pull, compare meta.updatedAt
               |── poll 60s + on focus/visible ──> pull (no auth call)
               |── last-write-wins on that single timestamp
               └── Google Drive appDataFolder / personal-os-data.json
                      ^ scope: drive.appdata — nothing else in your Drive
```

### [ INVARIANTS ]

| RULE | WHY IT EXISTS |
| --- | --- |
| `commit()` is the only mutation path | It is what stamps `meta.updatedAt`. A mutation that skips it silently loses the last-write-wins race against Drive. |
| `saveState()` has exactly one caller | Single choke point for persist + repaint + sync signal. A firing alarm is a mutation like any other: it goes through `commit()`, once per tick rather than once per item. |
| `PersonalOS.setState()` does **not** emit `pos:save` | That asymmetry is the only thing preventing a remote → local → remote push loop. It looks like a bug. It is not. |
| Only the active panel repaints | Painting hidden panels wasted most of every repaint and moved focus-bearing DOM out from under open dialogs. |
| Every interpolated value passes `escapeHtml()` / `escapeAttr()` | Full-redraw `innerHTML` rendering with user text in it. |
| `highlight()` matches the **raw** string, escapes per segment | Regexing already-escaped output lets a query like `amp;` split `&amp;` in half. |
| Uploads resolve `remoteFileId` before creating | Otherwise a fresh load that pushes early creates a second data file and the two copies diverge. |
| The multipart boundary is checked against the payload | A note containing the literal boundary would truncate the upload and corrupt the stored file. |
| Token requests happen **only** on a real user click | Silent renewal is unreliable across browsers and can throw up a full login page unprompted. On expiry the app waits for a tap. |
| Every helper is declared at module scope | `node --check` resolves no names. Three date helpers once sat *inside* `formatDate()`: it kept working, every card render threw `ReferenceError`, and because the throw beat the `window.PersonalOS` assignment at the end of `app.js`, sync died with it. |
| Ringing starts and stops in exactly one place | `startRinging()` / `stopRinging()` own the chime, the vibration, the title flash and the CSS class together. Five different things dismiss an alarm; each one calling `clearInterval` itself is how you end up with a tab that buzzes forever. |
| Background polls never report a network error | A poll the user did not ask for must not turn the badge red behind their back. Only an expired token — which genuinely needs a tap — surfaces from `pullRemoteChanges()`. |

---

## // 03_QUICKSTART

### [ MODE_A: JUST_USE_IT ]

Open **https://kiarashakbari.github.io/NOTE-TAKER/**. That's the whole install.
Nothing to download, no account to create.

### [ MODE_B: RUN_IT_LOCALLY ]

```bash
git clone https://github.com/KiarashAkbari/NOTE-TAKER.git
cd NOTE-TAKER
python3 -m http.server 8000
# open http://localhost:8000
```

Serve it over HTTP rather than double-clicking the file: Google OAuth rejects
`file://` origins, so sync cannot be exercised that way. Notes, tasks, tags,
search, and themes work either way.

There is nothing to install, build, compile, or transpile. If you added a
`package.json`, you'd be the first.

### [ MODE_C: DEPLOY_YOUR_OWN ]

Any static host works, because it *is* static.

```bash
# GitHub Pages: push to a branch, then Settings → Pages → select that branch.
# Netlify / Vercel / Cloudflare Pages: no build command, output dir = repo root.
```

Notes, tasks, and tags work on your fork immediately. To enable **sync** on your
own origin, register your own OAuth client — see `05_SYNC_PROTOCOL`.

### [ VERIFY_A_CHANGE ]

```bash
node --check app.js && node --check sync.js
```

That is a syntax check, not a test suite — it parses the files without resolving
a single name. It will happily wave through a helper declared in the wrong
scope, which is exactly how a `ReferenceError` once reached production. Load the
page and exercise what you touched. Contributors' notes on driving the real UI
headlessly live in [`AGENTS.md`](AGENTS.md).

---

## // 04_OPERATIONAL_MANUAL

Three views, switched by the tabs in the header or by pressing `1` `2` `3`. Below
900px the layout collapses to a single column and the task board stacks, so the
same app works on a phone.

### [ 01 / NOTES ]

Title, body, and tags, with a live `WORDS · CHARS` counter in the editor.
`★ PIN TO TOP` floats a note above the rest; everything else sorts by most
recently touched. Timestamps read as `JUST NOW`, `12M AGO`, `3D AGO`, then fall
back to an absolute date.

### [ 02 / TASKS ]

Three columns — **NOT STARTED**, **IN PROGRESS**, **DONE** — with live counts
and a global `PROGRESS` readout in the header. Move a task in whichever way
suits you:

* **Click** one of the three status dots on the card.
* **Drag** the card into another column.
* **Focus** the card and press `←` / `→`.

`✕ CLEAR DONE` bulk-clears the done column, and appears only when there is
something to clear. It is undoable.

### [ 03 / ORGANIZE ]

Create tags, rename them inline (click the name, `Enter` commits, `Esc` reverts),
and see exactly how many notes and tasks each one carries. Duplicate names are
rejected. Deleting a tag prunes it from every item that referenced it — and is
undoable.

Also the data console: **EXPORT BACKUP** (plain JSON, downloaded locally),
**IMPORT BACKUP**, and **DELETE ALL DATA**, plus a readout of how many bytes
you're actually using.

### [ REMINDERS ]

Any note or task can carry one alarm: a date, a time, and an optional label.
`TODAY` / `TOMORROW` / `NEXT WEEK` / `NEXT MONTH` fill the fields in one tap,
rounded to the next hour.

Anything armed shows up in the **alarms bar** across the top, sorted soonest
first, each chip ticking down live. Click a chip to open the item; click its `×`
to clear the alarm. Cards carry a coarse badge of their own — `45M`, `3H`, `2D`.

When one comes due it **keeps going until you turn it off**: a system
notification that stays on screen, a chime on a loop, repeating vibration, a
pulsing dialog, and a tab title that flashes. Dismissing it anywhere — the
DISMISS button, `Esc`, clicking outside, or tapping/swiping the notification —
stops all of it at once.

Reminders sync, so an alarm you set on your laptop rings on your phone too.
Every signed-in device that has the app open pulls changes on its own, without a
refresh; a device that was asleep or backgrounded catches up the instant you look
at it, and anything that came due while you were away fires then rather than
being swallowed.

#### What it cannot do, honestly

**A device where the app is fully closed will not ring.** Waking a closed
browser requires Web Push, and Web Push requires a server to send the message at
the alarm's moment. This app has no server — that is the whole premise — and the
one browser API that would have scheduled a notification locally
(`TimestampTrigger`) was never standardised and has been removed. So:

| SITUATION | WHAT HAPPENS |
| --- | --- |
| App open, tab focused | Rings immediately. |
| App open, different tab or app | System notification + sound. On another app it may be up to ~1 min late if the browser throttles the tab. |
| Phone screen locked, browser still running | Notification when the browser is next allowed to run; immediate once you unlock/open it. |
| Browser closed, or phone rebooted | **Nothing.** Fires when you next open the app. |

For an alarm that must wake a sleeping phone, use the `ICS` button in the editor:
it downloads a standard calendar file, generated locally, and your own calendar
app then owns the alert — with all the OS-level reliability this cannot have.

### [ SEARCH_&_FILTER ]

The rail filters notes and tasks *together*, across title, body, and tag name,
with every match highlighted. Tag chips filter by tag, including an `UNTAGGED`
bucket, and each chip shows its own count.

### [ KEYBOARD_MATRIX ]

| KEY | ACTION |
| --- | --- |
| `1` `2` `3` | Switch view |
| `N` | New note |
| `T` | New task |
| `/` | Focus search |
| `Enter` / `Space` | Open the focused card |
| `←` `→` | Move the focused task between columns |
| `⌘/Ctrl` + `Enter` | Save the open editor |
| `Esc` | Close the top dialog, or clear the search |
| `Tab` | Trapped inside the front-most dialog |

### [ SAFETY_BEHAVIOURS ]

These are the details that decide whether you trust an app with your notes.

* **No `window.confirm`.** Destructive actions open a themed, focus-trapped
  dialog that spells out exactly what will happen and focuses CANCEL — so a
  stray `Enter` destroys nothing.
* **Undo restores the minimum.** Deleted items are spliced back at their
  original indices, so edits you made while the toast was still up survive.
* **Typed text is never lost.** If the item you're editing vanishes mid-edit
  (another tab, or a Drive pull), saving re-creates it under its original id and
  tells you so.
* **Refresh protection.** Closing the tab with a dirty editor prompts first.
* **Cross-tab coherence.** A second tab's changes are adopted instead of
  silently overwriting yours.
* **Blocked storage is announced,** not swallowed: private mode tells you up
  front that nothing will persist.
* **Themes** are dark / light / follow-system, resolved *before* first paint.
  Both palettes are contrast-checked — brand `#FF6600` measures 2.65:1 on the
  light background, so light mode uses `#A83C00` instead.

---

## // 05_SYNC_PROTOCOL

Sync is entirely optional and off until you tap SIGN IN. What it does:

1. Requests one OAuth scope: **`drive.appdata`**. That grants access to this
   app's own hidden folder and **nothing else** — not your files, not Gmail, not
   contacts.
2. Reads/writes a single file, `personal-os-data.json`, in your Drive
   `appDataFolder`. It never appears in your normal Drive listing.
3. On load with a still-valid cached token, it pulls and compares
   `meta.updatedAt`. Newer side wins.
4. On every local change, it debounces 1.5s and pushes. A pending push is
   flushed on `pagehide` so navigating away doesn't drop it.
5. While signed in it also pulls once a minute, and immediately whenever you
   return to the tab, so a change made on another device shows up without a
   refresh. Both reuse the token already in hand — no auth call, no popup — and
   a failed poll is kept quiet rather than flipping the badge to ERROR.
6. If a sync fails and the connection later returns, it retries by itself —
   reusing the token it already has, with no click and no Google auth call.
7. On expiry it stops and waits for a tap. It will never ambush you with a login
   screen.

### [ STATUS_READOUT ]

| INDICATOR | MEANING |
| --- | --- |
| `OFF` | Sync is off. Data stays in this browser. |
| `SYNCING…` | Talking to Google Drive. |
| `SYNCED` | Mirrored to your Drive app folder. |
| `ERROR` | Sync failed. Local data is safe. |
| `TAP TO SYNC` | Session expired — one tap reconnects. |

### [ ENABLING_SYNC_ON_YOUR_OWN_FORK ]

The shipped client id is registered for the published GitHub Pages origin only,
so on your own domain you must register your own:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External. Add the `.../auth/drive.appdata` scope
   and a privacy policy URL — point it at your deployed `privacy.html`.
4. **Credentials → Create OAuth client ID → Web application.** Add your
   authorized JavaScript origins, e.g. `https://<you>.github.io` and
   `http://localhost:8000`.
5. Paste the client id into `GOOGLE_CLIENT_ID` at the top of `sync.js`.

No client secret, no redirect URI, no backend. The browser holds a short-lived
access token and talks to Drive REST directly.

---

## // 06_FILE_STRUCTURE

```text
/ROOT
├── index.html      # [SHELL]   Markup, dialogs, pre-paint theme bootstrap
├── app.js          # [KERNEL]  State, rendering, interaction. Owns localStorage
├── sync.js         # [MIRROR]  Optional Drive layer. Loads AFTER app.js
├── sw.js           # [WORKER]  Offline shell + OS notifications for alarms
├── style.css       # [TOKENS]  Both theme palettes + every component
├── privacy.html    # [LEGAL]   Required by the OAuth consent screen
├── AGENTS.md       # Contributor + AI-agent contract (read before editing)
├── README.md       # This document
└── environment.gif # Screen capture, docs only — not loaded by the app
```

That is the entire application: the first six entries. Everything after them is
documentation. There is no `dist/`, no `node_modules/`, no lockfile, no config.

---

## // 07_DESIGN_CONSTRAINTS

Ground rules for anyone (or anything) sending a patch. Full detail lives in
[`AGENTS.md`](AGENTS.md).

| CONSTRAINT | RATIONALE |
| --- | --- |
| **No npm, no framework, no bundler, no CDN** | Beyond Google's own auth script, nothing is fetched. That promise is the product. |
| **Free and serverless, permanently** | No backend, no analytics, no paid tier, no runtime dependency. |
| **All external state goes through `sanitizeState()`** | It coerces types, regenerates missing ids, prunes dangling tag refs, and preserves unknown fields plus a higher `version`. Extend `KNOWN_ITEM_FIELDS` when you add a field. |
| **Colors come only from the per-theme tokens** | Both theme blocks must define the identical token set. Never dim small text with `opacity` — 10px labels at 70% measure ~3:1. |
| **`privacy.html` makes concrete claims** | If data handling changes, that file changes with it. |
| **`app.js` and `sync.js` share one lexical scope** | A top-level `const` declared in both is a `SyntaxError` that silently kills sync. |

---

## // 08_PRIVACY_LEDGER

```text
>> DATA_AT_REST:        YOUR BROWSER (+ YOUR OWN DRIVE, IF YOU OPT IN)
>> DATA_SENT_TO_DEV:    NONE — THERE IS NOWHERE TO SEND IT
>> ANALYTICS:           NONE
>> COOKIES:             NONE
>> THIRD_PARTIES:       GOOGLE, ONLY AFTER YOU TAP SIGN IN
>> OAUTH_SCOPE:         drive.appdata (THIS APP'S HIDDEN FOLDER ONLY)
>> EXPORT:              PLAIN JSON, ONE CLICK, LOCAL
>> DELETE:              IN-APP, OR REVOKE ACCESS AT
                        myaccount.google.com/permissions
```

Full text: [`privacy.html`](privacy.html).

---

## // 09_ENGINEER_INFO

```text
LEAD_ENGINEER:    KIARASH AKBARI
PROJECT:          PERSONAL_OS // NOTE-TAKER
STACK:            HTML + CSS + JS. THAT IS THE COMPLETE LIST.
SOURCE:           github.com/KiarashAkbari/NOTE-TAKER
CONTACT:          consistentrash@gmail.com
```

Branch layout: work lands on `v2`; `main` is what GitHub Pages publishes.

---

## // 10_LICENSE_AND_LIABILITY

```text
>> LICENSE_TYPE:        GNU GPLv3 (COPYLEFT)
>> CLOSED_SOURCE_USE:   PROHIBITED
>> SOURCE_DISCLOSURE:   MANDATORY
```

**[ NOTICE_OF_NON_LIABILITY ]**

1. **NO WARRANTIES.** Provided "as is", without warranty of any kind, express or
   implied.
2. **YOUR DATA IS YOUR RESPONSIBILITY.** Browser storage can be cleared by the
   browser, by private mode, or by you. Use **EXPORT BACKUP**. The author
   accepts no liability for lost notes.
3. **NO PROFESSIONAL RELIANCE.** This is a personal organizer, not a system of
   record for anything that matters legally, medically, or financially.

*System Halt.*
