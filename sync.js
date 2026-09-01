/* ==========================================================================
   PERSONAL OS — sync.js
   Optional Google Drive appDataFolder sync. Local-first: the app fully works
   offline via localStorage. When signed in, this layer mirrors state to a
   single hidden JSON file in the user's Drive so the same Google account
   sees identical data on any device/browser.

   The access token is cached in localStorage (with its real expiry) so a
   page refresh does NOT require re-authentication — only an actual token
   expiry (~1hr) does. Each device/browser holds its own independent token;
   signing in on one device never affects another device's session.
   ========================================================================== */

const GOOGLE_CLIENT_ID = '173858466609-ma8o00vpgpog0ghnkl0rhttfe0bqm6uf.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'personal-os-data.json';
const SIGNED_IN_FLAG = 'pos-google-signed-in';
const TOKEN_CACHE_KEY = 'pos-google-token-cache';
const EXPIRY_SAFETY_MS = 2 * 60 * 1000; // treat token as expiring 2 min early

let accessToken = null;
let remoteFileId = null;
let tokenClient = null;
let syncTimer = null;
let hasEverConnectedThisSession = false;

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

  syncEls.btn.addEventListener('click', () => {
    if (accessToken) {
      signOut();
    } else {
      requestToken(true);
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
    expired:    ['accent', 'SESSION EXPIRED', 'RECONNECT'],
  };
  const [lightClass, label, btnLabel] = map[mode];
  syncEls.light.className = 'light ' + lightClass;
  syncEls.status.textContent = label;
  syncEls.btn.textContent = btnLabel;
}

// ---------- Token cache (survives page refresh, not browser restarts beyond expiry) ----------

function cacheToken(token, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ token, expiresAt }));
}

function readCachedToken() {
  const raw = localStorage.getItem(TOKEN_CACHE_KEY);
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() < expiresAt - EXPIRY_SAFETY_MS) {
      return { token, expiresAt };
    }
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

function requestToken(interactive) {
  if (!tokenClient) return;
  setSyncState('connecting');
  tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
}

async function onTokenResponse(resp) {
  if (resp.error) {
    accessToken = null;
    setSyncState(hasEverConnectedThisSession ? 'expired' : 'offline');
    return;
  }
  accessToken = resp.access_token;
  hasEverConnectedThisSession = true;
  localStorage.setItem(SIGNED_IN_FLAG, '1');
  cacheToken(resp.access_token, resp.expires_in || 3600);
  await performInitialSync();
  scheduleTokenRefresh(resp.expires_in || 3600);
}

function scheduleTokenRefresh(expiresInSeconds) {
  clearTimeout(syncTimer);
  const refreshInMs = Math.max((expiresInSeconds * 1000) - EXPIRY_SAFETY_MS - 30000, 30000);
  syncTimer = setTimeout(() => requestToken(false), refreshInMs);
}

function signOut() {
  accessToken = null;
  remoteFileId = null;
  hasEverConnectedThisSession = false;
  localStorage.removeItem(SIGNED_IN_FLAG);
  clearCachedToken();
  clearTimeout(syncTimer);
  setSyncState('offline');
}

function authHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

async function findRemoteFile() {
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id,modifiedTime)`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error('drive list failed');
  const data = await res.json();
  return data.files && data.files.length ? data.files[0] : null;
}

async function downloadRemote(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: authHeaders(),
  });
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
  if (!res.ok) throw new Error('drive upload failed');
  const data = await res.json();
  remoteFileId = data.id;
}

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
      setSyncState('error');
    }
  }, 1500);
}

window.addEventListener('pos:save', schedulePush);

document.addEventListener('DOMContentLoaded', () => {
  initSyncUI();
  waitForGoogle(() => {
    initTokenClient();

    if (localStorage.getItem(SIGNED_IN_FLAG) !== '1') return;
    hasEverConnectedThisSession = true;

    const cached = readCachedToken();
    if (cached) {
      // Reuse the still-valid token from before the refresh — no re-auth needed.
      accessToken = cached.token;
      const remainingSeconds = Math.max((cached.expiresAt - Date.now()) / 1000, 30);
      performInitialSync().then(() => scheduleTokenRefresh(remainingSeconds));
    } else {
      // Token actually expired (or first load) — try one silent refresh.
      requestToken(false);
    }
  });
});
