/* ==========================================================================
   PERSONAL OS — sync.js
   Optional Google Drive appDataFolder sync. Local-first: the app fully works
   offline via localStorage. When signed in, this layer mirrors state to a
   single hidden JSON file in the user's Drive so the same Google account
   sees identical data on any device/browser.

   IMPORTANT: Google's token API is only ever called from a real user click
   (per Google's own guidance). No automatic/background/silent token
   requests are made — those are unreliable across browsers, especially on
   mobile, and can surface a full login page unexpectedly. Instead, the
   cached token is reused while valid, and the button clearly asks for one
   tap to reconnect once it truly expires.
   ========================================================================== */

const GOOGLE_CLIENT_ID = '173858466609-ma8o00vpgpog0ghnkl0rhttfe0bqm6uf.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'personal-os-data.json';
const SIGNED_IN_FLAG = 'pos-google-signed-in';
const TOKEN_CACHE_KEY = 'pos-google-token-cache';
const EXPIRY_SAFETY_MS = 2 * 60 * 1000;

let accessToken = null;
let remoteFileId = null;
let tokenClient = null;

const syncEls = { btn: null, light: null, status: null };

function initSyncUI() {
  const readout = document.querySelector('.status-readout');
  if (!readout) return;

  const wrap = document.createElement('div');
  wrap.className = 'status-readout';
  wrap.style.marginLeft = '20px';
  wrap.innerHTML = `
    <span class="label">SYNC</span>
    <span class="light off" id="sync-light"></span>
    <span class="mono" id="sync-status">OFFLINE</span>
    <button class="btn-primary" id="sync-btn" style="margin-left:8px;">SIGN IN</button>
  `;
  readout.after(wrap);

  syncEls.btn = document.getElementById('sync-btn');
  syncEls.light = document.getElementById('sync-light');
  syncEls.status = document.getElementById('sync-status');

  // Every call to requestToken from here is a direct result of this click —
  // a genuine user gesture, which is what makes the flow reliable everywhere.
  syncEls.btn.addEventListener('click', () => {
    if (accessToken) {
      signOut();
    } else {
      requestToken();
    }
  });
}

function setSyncState(mode) {
  if (!syncEls.light) return;
  const map = {
    offline:    ['off',    'OFFLINE',         'SIGN IN'],
    connecting: ['accent', 'SYNCING…',        'SIGN IN'],
    synced:     ['on',     'SYNCED',          'SIGN OUT'],
    error:      ['accent', 'SYNC ERROR',      'RETRY'],
    expired:    ['accent', 'TAP TO RECONNECT', 'RECONNECT'],
  };
  const [lightClass, label, btnLabel] = map[mode];
  syncEls.light.className = 'light ' + lightClass;
  syncEls.status.textContent = label;
  syncEls.btn.textContent = btnLabel;
}

// ---------- Token cache (the only thing checked automatically on load) ----------

function cacheToken(token, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ token, expiresAt }));
}

function readCachedToken() {
  const raw = localStorage.getItem(TOKEN_CACHE_KEY);
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() < expiresAt - EXPIRY_SAFETY_MS) return { token, expiresAt };
  } catch (e) { /* fall through */ }
  localStorage.removeItem(TOKEN_CACHE_KEY);
  return null;
}

function clearCachedToken() {
  localStorage.removeItem(TOKEN_CACHE_KEY);
}

// ---------- Google Identity Services ----------

function waitForGoogle(cb, attempts = 0) {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    cb();
  } else if (attempts < 50) {
    setTimeout(() => waitForGoogle(cb, attempts + 1), 100);
  } else {
    setSyncState('error');
  }
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: onTokenResponse,
  });
}

// Only ever invoked from the click handler above — never automatically.
function requestToken() {
  if (!tokenClient) return;
  setSyncState('connecting');
  tokenClient.requestAccessToken({ prompt: '' });
}

async function onTokenResponse(resp) {
  if (resp.error) {
    accessToken = null;
    setSyncState('expired');
    return;
  }
  accessToken = resp.access_token;
  localStorage.setItem(SIGNED_IN_FLAG, '1');
  cacheToken(resp.access_token, resp.expires_in || 3600);
  await performInitialSync();
}

function signOut() {
  accessToken = null;
  remoteFileId = null;
  localStorage.removeItem(SIGNED_IN_FLAG);
  clearCachedToken();
  setSyncState('offline');
}

function authHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

// If any Drive call comes back unauthorized, the token has actually expired —
// surface "reconnect" instead of erroring silently.
function isAuthError(res) {
  return res.status === 401 || res.status === 403;
}

async function findRemoteFile() {
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id,modifiedTime)`;
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
  const metadata = remoteFileId
    ? { name: DRIVE_FILE_NAME }
    : { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
  const boundary = 'pos-boundary';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(content)}\r\n` +
    `--${boundary}--`;

  const url = remoteFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${remoteFileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: remoteFileId ? 'PATCH' : 'POST',
    headers: { ...authHeaders(), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (isAuthError(res)) throw new AuthExpiredError();
  if (!res.ok) throw new Error('drive upload failed');
  const data = await res.json();
  remoteFileId = data.id;
}

class AuthExpiredError extends Error {}

async function performInitialSync() {
  try {
    const file = await findRemoteFile();
    const local = window.PersonalOS.getState();

    if (!file) {
      await uploadRemote(local);
      setSyncState('synced');
      return;
    }

    remoteFileId = file.id;
    const remote = await downloadRemote(file.id);
    const remoteUpdatedAt = (remote.meta && remote.meta.updatedAt) || 0;
    const localUpdatedAt = (local.meta && local.meta.updatedAt) || 0;

    if (remoteUpdatedAt > localUpdatedAt) {
      window.PersonalOS.setState(remote);
    } else if (localUpdatedAt > remoteUpdatedAt) {
      await uploadRemote(local);
    }
    setSyncState('synced');
  } catch (e) {
    handleSyncError(e);
  }
}

function handleSyncError(e) {
  if (e instanceof AuthExpiredError) {
    accessToken = null;
    clearCachedToken();
    setSyncState('expired');
  } else {
    setSyncState('error');
  }
}

let pushDebounce = null;
function schedulePush() {
  if (!accessToken) return;
  clearTimeout(pushDebounce);
  pushDebounce = setTimeout(async () => {
    try {
      setSyncState('connecting');
      await uploadRemote(window.PersonalOS.getState());
      setSyncState('synced');
    } catch (e) {
      handleSyncError(e);
    }
  }, 1500);
}

window.addEventListener('pos:save', schedulePush);

document.addEventListener('DOMContentLoaded', () => {
  initSyncUI();
  waitForGoogle(() => {
    initTokenClient();

    if (localStorage.getItem(SIGNED_IN_FLAG) !== '1') return;

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
});
