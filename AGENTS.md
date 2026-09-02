# AGENTS.md

Static, dependency-free web app: `index.html` + `app.js` + `sync.js` +
`style.css` + `privacy.html`. There is no `package.json`, no build, no bundler,
no test runner, and no CI. Do not add any of those, and do not introduce a
framework or npm dependency — see "Non-negotiables".

## Running and verifying

```sh
python3 -m http.server 8000   # from the repo root
```

- Open over `http://localhost:8000`, not `file://`: Google OAuth rejects
  `file://` origins, so sync cannot be exercised that way.
- Sync only works from an origin registered in the Google Cloud console for
  the hardcoded client id, which in practice means the GitHub Pages origin.
  Locally you can reach the sign-in button but not complete the flow.
- Syntax check after editing JS: `node --check app.js && node --check sync.js`.
- There is no automated suite in the repo. For behavioural changes, drive the
  real UI in jsdom from a scratch directory (`/tmp`): load `index.html` with
  `runScripts: 'dangerously'`, stub `window.matchMedia` (jsdom lacks it, and
  the theme bootstrap needs it), then `eval` `app.js` before `sync.js` and
  dispatch `DOMContentLoaded`. Stub `window.fetch` to fake Drive. Keep such
  harnesses out of the repo.
- Useful throwaway linters, both invoked via `npx` from a scratch dir:
  `html-validate` (it enforces `type` on every `<button>`, which this repo now
  satisfies) and `css-tree` for parse errors and token checks.

## Git

- Work lands on `v2`; `main` is what GitHub Pages publishes. Do not push to
  `main` without being asked.
- Git refuses to run here until you add the ownership exception (the checkout
  is root-owned but the files belong to `ubuntu`):
  `git -c safe.directory=/root/note-taker <cmd>`.

## Architecture

Load order is load-bearing. `app.js` must run before `sync.js`.

- `localStorage['personal-os-v1']` is the source of truth. `app.js` owns it;
  `sync.js` never touches it.
- `window.PersonalOS` (`getState` / `setState` / `renderAll` / `toast` /
  `confirmAction`) is the only interface between the two files.
- **`commit(mutate, opts)` is the single mutation path.** It runs the mutation,
  calls `saveState()` (which stamps `state.meta.updatedAt` and dispatches
  `pos:save`), repaints, then optionally toasts. `saveState()` has exactly one
  caller by design — do not add another. Conflict resolution is last-write-wins
  on `meta.updatedAt` alone, so a mutation that skips `commit()` silently loses
  to Drive.
- `PersonalOS.setState()` deliberately does *not* dispatch `pos:save`. That
  asymmetry is the only thing preventing a remote → local → remote push loop.
  It looks like a bug. It is not.
- Rendering is full-redraw `innerHTML` template strings, but only for the
  **active** panel (`PANEL_RENDERERS[activeView]`). Painting hidden panels wasted
  most of every repaint and moved focus-bearing DOM under open dialogs.
- Cards are built as HTML strings and bound with **delegated** listeners on the
  static containers (`#notes-list`, each `[data-drop-status]` column,
  `#organize-list`, `#tag-filter-list`). A repaint must bind zero new listeners;
  identify targets with `data-note-id` / `data-task-id` / `data-tag-id`.
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
- `app.js` and `sync.js` share one global lexical scope. A top-level `const`
  declared in both is a `SyntaxError` that silently kills sync — check for
  collisions when adding names.
