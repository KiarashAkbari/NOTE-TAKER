# NOTE-TAKER — Personal OS

Personal notes, task progress, and organizing web app. Vanilla HTML/CSS/JS, no
build step, no dependencies, no backend, no accounts, no cost. Data lives in
your browser; Google Drive sync is optional.

**Live:** GitHub Pages from `main` · [Privacy policy](privacy.html)

## Free by design

- No server, no database, no analytics, no telemetry, no paid tier.
- Nothing is installed and nothing is bundled — the whole app is four static
  files served as-is.
- If you never sign in, the page makes **zero** network requests. Google's
  sign-in script is fetched only at the moment you tap SIGN IN.
- Optional sync uses your own Google Drive `appDataFolder` (the free hidden
  per-app storage on any Google account), reachable only by this app.
- EXPORT BACKUP writes a plain JSON file straight from the browser, so you can
  leave at any time with all your data.

## Features

**Notes** — title, body, tags, pin-to-top, word/character count, relative
timestamps.

**Tasks** — three columns (not started / in progress / done) with click, drag,
or keyboard status changes, per-column counts, a global completion readout, and
CLEAR DONE for bulk cleanup.

**Organize** — create tags, rename them inline, see how many notes and tasks
use each one, and manage your data (export / import / delete all).

**Search** — filters notes and tasks together across title, body, and tag name,
with matches highlighted.

**Themes** — dark, light, or follow the system. Applied before first paint, so
there is no flash of the wrong theme.

**Undo** — every delete (note, task, tag, clear-done, import, reset) is
reversible from the toast that appears afterwards. Deletions ask first with a
dialog that explains exactly what will happen.

**Sync** — optional Google Drive mirroring so the same Google account sees the
same data in any browser. Last-write-wins on a single timestamp.

## Keyboard

| Key | Action |
| --- | --- |
| `1` `2` `3` | Switch view |
| `N` / `T` | New note / new task |
| `/` | Focus search |
| `Ctrl`/`⌘` + `Enter` | Save the open editor |
| `Esc` | Close dialog, or clear search |
| `←` `→` | Move the focused task between columns |
| `Enter` | Open the focused note or task |

## Running it locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Serve over HTTP rather than opening the file directly: Google OAuth rejects
`file://` origins, so sync cannot be exercised that way. Notes, tasks, tags and
themes work fine either way.

There is nothing to install, build, or compile.

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup, dialogs, pre-paint theme bootstrap |
| `app.js` | State, rendering, all interaction. Owns `localStorage` |
| `sync.js` | Optional Google Drive layer. Loads after `app.js` |
| `style.css` | Design tokens for both themes plus all components |
| `privacy.html` | Privacy policy (required for the OAuth consent screen) |
