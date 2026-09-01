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
- `saveState()` stamps `state.meta.updatedAt` and dispatches `pos:save`;
  `sync.js` debounces that into a Drive upload.
- Conflict resolution is last-write-wins on `meta.updatedAt` alone. **Every
  mutation must go through `saveState()`** or changes silently lose to Drive.
- `PersonalOS.setState()` deliberately does *not* dispatch `pos:save`. That
  asymmetry is the only thing preventing a remote → local → remote push loop.
  It looks like a bug. It is not.
- Rendering is full-redraw `innerHTML` template strings via `renderAll()`.
  Every interpolated value must pass through `escapeHtml()` / `escapeAttr()`.
  `highlight()` is safe because it escapes both haystack and needle before
  inserting `<mark>`.
- All state read from storage or Drive goes through `sanitizeState()`, which
  coerces types, regenerates missing ids/timestamps, and prunes tag references
  that no longer resolve. Extend it when adding fields; nothing else validates.

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
- **Free and serverless.** No backend, no analytics, no paid service, no npm
  runtime dependency, no CDN beyond Google's own auth script.
- **`privacy.html` is a Google OAuth consent-screen requirement** and makes
  concrete claims (no backend, no analytics, `drive.appdata` only, zero
  third-party requests before sign-in). If data handling changes, update it.
- **No `window.confirm` / `alert` / `prompt`.** Use `confirmAction()` (themed,
  focus-trapped, promise-based, focuses CANCEL so a stray Enter destroys
  nothing) and offer `toast(msg, { actionLabel: 'UNDO', onAction })` after any
  destructive action.

## Conventions

- Task status strings are coupled to DOM ids: `not_started` / `in_progress` /
  `done` map to `col-<status>` and `count-<status>` in `index.html`. Adding a
  status means editing the HTML, `STATUS_ORDER`, `STATUS_LABEL`, and the CSS.
- Colors come only from the per-theme tokens in `style.css`. `--accent` differs
  between themes on purpose: brand `#FF6600` is 2.65:1 on the light background
  and fails contrast, so light mode uses `#A83C00`. Fills use `--accent` with
  `--on-accent` (likewise `--danger` / `--on-danger`). Both theme blocks must
  define the identical token set.
- Theme is `html[data-theme]`, resolved before first paint by an inline script
  in `index.html`. `privacy.html` needs the same bootstrap or it renders
  unstyled, since every color token is scoped to `html[data-theme]`.
- UI text is uppercase mono for labels; status uses the `.light on|accent|off`
  dot pattern; `--gap` and the sectioned `/* ---------- */` comment layout are
  the existing house style.
- Bump `personal-os-v1` (and migrate) only if the persisted shape changes
  incompatibly; `sanitizeState()` handles additive changes already.
