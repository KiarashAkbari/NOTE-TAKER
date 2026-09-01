/* ==========================================================================
   PERSONAL OS — sync.js  (v2)

   Optional Google Drive appDataFolder sync. Local-first: the app is fully
   usable offline via localStorage; this layer only mirrors state to a single
   hidden JSON file in the user's own Drive so the same Google account sees
   identical data on any device/browser. Free tier, no backend, no third party
   other than Google's own API.

   Design rules that must not be relaxed:

   1. Google's token API is only ever called from a real user click (per
      Google's own guidance). No automatic/background/silent token requests —
      they are unreliable across browsers, especially on mobile, and can
      surface a full login page unexpectedly. The cached token is reused while
      valid; once it truly expires the button asks for one tap.

   2. Google's GSI script is injected lazily, only when a token is actually
      needed. A user who never signs in makes zero third-party requests, which
      is what privacy.html promises. Drive REST calls need only the bearer
      token, so a cached token can sync with no GSI script at all.

   3. Uploads must never create a second data file. remoteFileId is resolved
      (or re-resolved) before any create.
   ========================================================================== */

const GOOGLE_CLIENT_ID = '173858466609-ma8o00vpgpog0ghnkl0rhttfe0bqm6uf.apps.googleusercontent.com';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'personal-os-data.json';
const SIGNED_IN_FLAG = 'pos-google-signed-in';
const TOKEN_CACHE_KEY = 'pos-google-token-cache';
const EXPIRY_SAFETY_MS = 2 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 1500;

let accessToken = null;
let remoteFileId = null;
let tokenClient = null;
let gsiPromise = null;
let syncing = false;

const syncEls = { btn: null, light: null, status: null };

class AuthExpiredError extends Error {}

/* ---------- UI ---------------------------------------------------------- */

function initSyncUI() {
  const mount = document.getElementById('sync-mount');
  if (!mount) return;

  mount.innerHTML = `
    <span class="label">SYNC</span>
    <span class="light off" id="sync-light" aria-hidden="true"></span>
    <span class="mono" id="sync-status">OFF</span>
    <button class="icon-btn" id="sync-btn">SIGN IN</button>
  `;

  syncEls.btn = document.getElementById('sync-btn');
  syncEls.light = document.getElementById('sync-light');
  syncEls.status = document.getElementById('sync-status');

  // Every requestToken() below originates from this click — a genuine user
  // gesture, which is what makes the flow reliable on every browser.
  syncEls.btn.addEventListener('click', () => {
    if (accessToken) signOutWithConfirm();
    else requestToken();
  });

  setSyncState('offline');
}

const SYNC_MODES = {
  offline:    ['off',    'OFF',        'SIGN IN',   'Sync is off. Data stays in this browser.'],
  connecting: ['accent', 'SYNCING…',   'SIGN IN',   'Talking to Google Drive…'],
  synced:     ['on',     'SYNCED',     'SIGN OUT',  'Synced to your Google Drive app folder.'],
  error:      ['accent', 'ERROR',      'RETRY',     'Sync failed. Local data is safe.'],
  expired:    ['accent', 'TAP TO SYNC', 'RECONNECT', 'Session expired. Tap to reconnect.'],
};

function setSyncState(mode) {
  if (!syncEls.light) return;
  const [lightClass, label, btnLabel, title] = SYNC_MODES[mode];
  syncEls.light.className = 'light ' + lightClass;
  syncEls.status.textContent = label;
  syncEls.btn.textContent = btnLabel;
  syncEls.btn.title = title;
  syncEls.btn.setAttribute('aria-label', title);
}

function notify(message, opts) {
  if (window.PersonalOS && window.PersonalOS.toast) window.PersonalOS.toast(message, opts);
}

/* ---------- Token cache (the only thing checked automatically on load) --- */

function cacheToken(token, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  try {
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ token, expiresAt }));
  } catch (e) { /* storage blocked — token simply won't survive a refresh */ }
}

function readCachedToken() {
  let raw = null;
  try { raw = localStorage.getItem(TOKEN_CACHE_KEY); } catch (e) { return null; }
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw);
    if (token && Date.now() < expiresAt - EXPIRY_SAFETY_MS) return { token, expiresAt };
  } catch (e) { /* fall through */ }
  clearCachedToken();
  return null;
}

function clearCachedToken() {
  try { localStorage.removeItem(TOKEN_CACHE_KEY); } catch (e) { /* ignore */ }
}

/* ---------- Google Identity Services (lazy) ----------------------------- */

function loadGsi() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => {
      // The library defines google.accounts.oauth2 slightly after onload
      // in some browsers, so poll briefly rather than assuming.
      let tries = 0;
      (function wait() {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) resolve();
        else if (tries++ < 40) setTimeout(wait, 50);
        else reject(new Error('gsi unavailable'));
      })();
    };
    script.onerror = () => reject(new Error('gsi blocked'));
    document.head.appendChild(script);
  });

  // Let a later click retry after a failure (offline, blocker, flaky network).
  gsiPromise.catch(() => { gsiPromise = null; });
  return gsiPromise;
}

async function requestToken() {
  setSyncState('connecting');
  try {
    await loadGsi();
  } catch (e) {
    setSyncState('error');
    notify('Could not reach Google. Check your connection or ad blocker — your notes are still saved locally.', { duration: 8000 });
    return;
  }

  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: onTokenResponse,
    });
  }
  tokenClient.requestAccessToken({ prompt: '' });
}

async function onTokenResponse(resp) {
  if (!resp || resp.error) {
    accessToken = null;
    setSyncState('expired');
    // access_denied means the user closed the picker; not worth a toast.
    if (resp && resp.error && resp.error !== 'access_denied') {
      notify('Google sign-in did not complete. Tap SYNC to try again.', { duration: 6000 });
    }
    return;
  }
  accessToken = resp.access_token;
  try { localStorage.setItem(SIGNED_IN_FLAG, '1'); } catch (e) { /* ignore */ }
  cacheToken(resp.access_token, resp.expires_in || 3600);
  await performInitialSync({ announce: true });
}

async function signOutWithConfirm() {
  const ask = window.PersonalOS && window.PersonalOS.confirmAction;
  if (ask) {
    const ok = await ask({
      title: 'TURN OFF SYNC',
      message: 'Stop syncing this browser with Google Drive?',
      detail: [
        'Your notes stay in this browser and in Drive.',
        'Nothing is deleted. You can sign back in any time.',
      ],
      okLabel: 'TURN OFF',
      danger: false,
    });
    if (!ok) return;
  }
  signOut();
  notify('Sync turned off. Local data untouched.', { duration: 3000 });
}

function signOut() {
  const token = accessToken;
  accessToken = null;
  remoteFileId = null;
  try { localStorage.removeItem(SIGNED_IN_FLAG); } catch (e) { /* ignore */ }
  clearCachedToken();
  setSyncState('offline');
  // Best-effort: drop the token server-side too so it can't be reused.
  if (token && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(token); } catch (e) { /* ignore */ }
  }
}

/* ---------- Drive REST -------------------------------------------------- */

function authHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

// If any Drive call comes back unauthorized, the token has actually expired —
// surface "reconnect" instead of erroring silently.
function isAuthError(res) {
  return res.status === 401 || res.status === 403;
}

async function findRemoteFile() {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}` +
              `&fields=files(id,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`;
  const res = await fetch(url, { headers: authHeaders() });
  if (isAuthError(res)) throw new AuthExpiredError();
  if (!res.ok) throw new Error('drive list failed');
  const data = await res.json();
  return data.files && data.files.length ? data.files[0] : null;
}

async function downloadRemote(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: authHeaders(),
  });
  if (isAuthError(res)) throw new AuthExpiredError();
  if (!res.ok) throw new Error('drive download failed');
  return res.json();
}

async function uploadRemote(content) {
  // Never create blindly: without this lookup a fresh page load that pushes
  // before it has listed the folder would create a duplicate data file.
  if (!remoteFileId) {
    const existing = await findRemoteFile();
    if (existing) remoteFileId = existing.id;
  }

  const metadata = remoteFileId
    ? { name: DRIVE_FILE_NAME }
    : { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };

  const boundary = 'pos-boundary-' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(content)}\r\n` +
    `--${boundary}--`;

  const url = remoteFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${remoteFileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;

  const res = await fetch(url, {
    method: remoteFileId ? 'PATCH' : 'POST',
    headers: { ...authHeaders(), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (isAuthError(res)) throw new AuthExpiredError();
  if (res.status === 404) {
    // File was deleted in Drive behind our back — forget the id so the next
    // attempt recreates it instead of failing forever.
    remoteFileId = null;
    throw new Error('drive target missing');
  }
  if (!res.ok) throw new Error('drive upload failed');
  const data = await res.json();
  remoteFileId = data.id;
}

/* ---------- Sync orchestration ------------------------------------------ */

/* Conflict resolution is last-write-wins on meta.updatedAt. That is only
   correct because every local mutation goes through app.js saveState(), which
   stamps that field. */
async function performInitialSync({ announce = false } = {}) {
  if (syncing) return;
  syncing = true;
  setSyncState('connecting');
  try {
    const file = await findRemoteFile();
    const local = window.PersonalOS.getState();
    const localUpdatedAt = (local.meta && local.meta.updatedAt) || 0;

    if (!file) {
      await uploadRemote(local);
      setSyncState('synced');
      if (announce) notify('Sync on. This browser is now backed up to your Drive.', { duration: 4000 });
      return;
    }

    remoteFileId = file.id;
    const remote = await downloadRemote(file.id);
    const remoteUpdatedAt = (remote && remote.meta && remote.meta.updatedAt) || 0;

    if (remoteUpdatedAt > localUpdatedAt) {
      window.PersonalOS.setState(remote);
      if (announce) notify('Pulled your newer data from Google Drive.', { duration: 4000 });
    } else if (localUpdatedAt > remoteUpdatedAt) {
      await uploadRemote(local);
      if (announce) notify('Pushed this browser\'s newer data to Google Drive.', { duration: 4000 });
    } else if (announce) {
      notify('Sync on. Already up to date.', { duration: 3000 });
    }
    setSyncState('synced');
  } catch (e) {
    handleSyncError(e);
  } finally {
    syncing = false;
  }
}

function handleSyncError(e) {
  if (e instanceof AuthExpiredError) {
    accessToken = null;
    clearCachedToken();
    setSyncState('expired');
    notify('Google session expired. Tap SYNC to reconnect — nothing was lost.', { duration: 7000 });
  } else {
    setSyncState('error');
  }
}

let pushDebounce = null;
let pushPending = false;

function schedulePush() {
  if (!accessToken) return;
  clearTimeout(pushDebounce);
  pushDebounce = setTimeout(runPush, PUSH_DEBOUNCE_MS);
}

async function runPush() {
  if (!accessToken) return;
  if (syncing) { pushPending = true; return; } // coalesce instead of racing
  syncing = true;
  try {
    setSyncState('connecting');
    await uploadRemote(window.PersonalOS.getState());
    setSyncState('synced');
  } catch (e) {
    handleSyncError(e);
  } finally {
    syncing = false;
    if (pushPending) { pushPending = false; schedulePush(); }
  }
}

window.addEventListener('pos:save', schedulePush);

// A pending debounced push would otherwise be lost on navigation.
window.addEventListener('pagehide', () => {
  if (accessToken && pushDebounce) {
    clearTimeout(pushDebounce);
    runPush();
  }
});

// Coming back online after a failure should recover without a click, since
// this path reuses the existing token and calls no Google auth API.
window.addEventListener('online', () => {
  if (accessToken) performInitialSync();
});

document.addEventListener('DOMContentLoaded', () => {
  initSyncUI();

  let signedInBefore = false;
  try { signedInBefore = localStorage.getItem(SIGNED_IN_FLAG) === '1'; } catch (e) { /* ignore */ }
  if (!signedInBefore) return; // never signed in: no Google script, no requests

  const cached = readCachedToken();
  if (cached) {
    // Reuse the still-valid token — no Google API call, no UI, no popup.
    accessToken = cached.token;
    performInitialSync();
  } else {
    // Token genuinely expired. Do NOT call Google automatically —
    // just show the button as needing a tap.
    setSyncState('expired');
  }
});
