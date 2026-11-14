/* ==========================================================================
   PERSONAL OS — app.js  (v2)

   Local-first: localStorage is the source of truth for instant reads/writes.
   sync.js (loaded after this file) hooks into saveState() via the 'pos:save'
   event to mirror state to Google Drive's appDataFolder when signed in.

   Invariants worth knowing before editing:
   - Every mutation must go through saveState(); it stamps meta.updatedAt,
     which is the ONLY field sync.js uses to resolve local-vs-remote conflicts.
   - PersonalOS.setState() deliberately does NOT dispatch 'pos:save'. That
     asymmetry is what stops a remote -> local -> remote push loop.
   - All rendering is innerHTML template strings, so every interpolated value
     must pass through escapeHtml()/escapeAttr().
   - The app must keep working with zero network access. No dependencies,
     no build step, no accounts, no cost. Keep it that way.
   - Helpers called from renderers (pad, toLocalDate/Time, timeRemaining) live
     at module scope. Nesting them inside another function compiles fine but
     dies at runtime with ReferenceError — that shipped once already.
   - Notification permission is only ever requested from a user gesture at the
     moment they engage the reminder UI, and only used for due alarms while
     the app is open.
   ========================================================================== */

const STORAGE_KEY = 'personal-os-v1';
const THEME_KEY = 'pos-theme';
const FIRED_ALARMS_KEY = 'pos-fired-alarms';
const SCHEMA_VERSION = 2;

const STATUS_ORDER = ['not_started', 'in_progress', 'done'];
const STATUS_LABEL = { not_started: 'NOT STARTED', in_progress: 'IN PROGRESS', done: 'DONE' };
const VIEWS = ['notes', 'tasks', 'organize'];
const TAG_MAX = 24;
const TOAST_MAX = 3;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- State: load, sanitize, save ---------------------------------- */

/* Anything read from localStorage or Google Drive is untrusted: it may come
   from an older schema, a hand-edited backup, or a half-written write. Coerce
   it into shape rather than letting NaN/undefined leak into sorting + render.

   Forward compatibility matters here because sync is last-write-wins across
   devices. If one browser runs a newer version that added a field, an older
   browser must not strip it and push the lossy copy back to Drive. So unknown
   keys are carried through untouched, and the highest schema version seen is
   preserved rather than downgraded. */

const KNOWN_ITEM_FIELDS = ['id', 'title', 'body', 'tagIds', 'createdAt', 'updatedAt', 'pinned', 'status', 'alarmAt', 'alarmLabel'];

function carryUnknown(raw, target) {
  Object.keys(raw).forEach(key => {
    // __proto__ from JSON.parse is an own property; assigning it via spread is
    // harmless but pointless, and skipping it keeps the object shape obvious.
    if (key === '__proto__' || KNOWN_ITEM_FIELDS.includes(key)) return;
    target[key] = raw[key];
  });
  return target;
}

function sanitizeItem(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const now = Date.now();
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const item = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter(t => typeof t === 'string') : [],
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
  if (kind === 'note') {
    item.pinned = raw.pinned === true;
  } else {
    item.status = STATUS_ORDER.includes(raw.status) ? raw.status : 'not_started';
  }
  item.alarmAt = Number.isFinite(raw.alarmAt) ? raw.alarmAt : null;
  item.alarmLabel = typeof raw.alarmLabel === 'string' ? raw.alarmLabel : '';
  return carryUnknown(raw, item);
}

function sanitizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const tags = [];
  const seenTagIds = new Set();

  (Array.isArray(src.tags) ? src.tags : []).forEach(t => {
    if (!t || typeof t !== 'object') return;
    const name = typeof t.name === 'string' ? t.name.trim().slice(0, TAG_MAX) : '';
    if (!name) return;
    const id = typeof t.id === 'string' && t.id && !seenTagIds.has(t.id) ? t.id : uid();
    seenTagIds.add(id);
    tags.push({ id, name });
  });

  const validTagIds = new Set(tags.map(t => t.id));
  const dedupeTags = ids => [...new Set(ids)].filter(id => validTagIds.has(id));

  const notes = (Array.isArray(src.notes) ? src.notes : [])
    .map(n => sanitizeItem(n, 'note'))
    .filter(Boolean);
  const tasks = (Array.isArray(src.tasks) ? src.tasks : [])
    .map(t => sanitizeItem(t, 'task'))
    .filter(Boolean);

  // Drop references to tags that no longer exist so counts never lie.
  notes.forEach(n => { n.tagIds = dedupeTags(n.tagIds); });
  tasks.forEach(t => { t.tagIds = dedupeTags(t.tagIds); });

  const updatedAt = Number.isFinite(src.meta && src.meta.updatedAt) ? src.meta.updatedAt : 0;
  const version = Number.isFinite(src.version) && src.version > SCHEMA_VERSION
    ? src.version
    : SCHEMA_VERSION;

  /* Carry unknown keys untouched — items already do this via carryUnknown,
     and the same promise is made for the state envelope and meta, so an
     older browser never strips a newer schema's data on a Drive round-trip. */
  const rawMeta = src.meta && typeof src.meta === 'object' ? src.meta : {};
  const meta = {};
  Object.keys(rawMeta).forEach(k => {
    if (k === '__proto__' || k === 'updatedAt') return;
    meta[k] = rawMeta[k];
  });
  meta.updatedAt = updatedAt;

  const out = { version, notes, tasks, tags, meta };
  Object.keys(src).forEach(k => {
    if (k === '__proto__' || ['version', 'notes', 'tasks', 'tags', 'meta'].includes(k)) return;
    out[k] = src[k];
  });
  return out;
}

let storageAvailable = true;
let quotaWarned = false;

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    // Storage blocked (private mode, cookies disabled). Run in-memory.
    storageAvailable = false;
  }
  if (!raw) return sanitizeState(null);
  try {
    return sanitizeState(JSON.parse(raw));
  } catch (e) {
    // Corrupt payload: keep a copy so nothing is silently destroyed.
    try { localStorage.setItem(STORAGE_KEY + '-corrupt-' + Date.now(), raw); } catch (_) {}
    return sanitizeState(null);
  }
}

function persist() {
  if (!storageAvailable) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    if (!quotaWarned) {
      quotaWarned = true;
      toast('Could not save — browser storage is full. Export a backup.', { duration: 8000 });
    }
    return false;
  }
}

function saveState(skipEvent) {
  state.meta = state.meta || {};
  state.meta.updatedAt = Date.now();
  const ok = persist();
  // The event fires even when localStorage is unavailable: in-memory state is
  // still worth pushing to Drive if the user is signed in.
  if (!skipEvent) window.dispatchEvent(new CustomEvent('pos:save', { detail: state }));
  return ok;
}

/* THE mutation path. The central invariant — every change must stamp
   meta.updatedAt via saveState(), or it silently loses the next Drive
   comparison — used to depend on ~15 call sites each remembering to pair
   saveState() with renderAll(). Funnelling them through here makes forgetting
   impossible: mutate, persist, repaint, optionally tell the user.

   Deliberately not a whole-state undo snapshot: restoring an entire snapshot
   would also revert unrelated edits made between the delete and the UNDO tap.
   Callers that support undo capture the minimum they need (see restoreItems). */
function commit(mutate, opts = {}) {
  mutate();
  saveState();
  renderAll();
  if (opts.message) toast(opts.message, opts.toast);
}

/* Shared undo for "removed N things from a list": splice them back at their
   original indices, lowest first, so order is preserved even when the list has
   changed length in the meantime. */
function restoreItems(getList, removed) {
  return () => {
    commit(() => {
      const list = getList();
      removed
        .slice()
        .sort((a, b) => a.index - b.index)
        .forEach(({ item, index }) => list.splice(Math.min(index, list.length), 0, item));
    }, { message: 'Restored.', toast: { duration: 2000 } });
  };
}

let state = loadState();
let activeView = 'notes';
let activeTagFilter = 'all';
let searchQuery = '';
let modalContext = null; // { type: 'note'|'task', id: string|null, status, tagIds }

/* ---------- DOM refs ----------------------------------------------------- */

const els = {
  viewBtns: document.querySelectorAll('.view-btn'),
  viewPanels: document.querySelectorAll('.view-panel'),
  searchInput: document.getElementById('search-input'),
  tagFilterList: document.getElementById('tag-filter-list'),
  notesList: document.getElementById('notes-list'),
  notesCount: document.getElementById('notes-count'),
  tasksCount: document.getElementById('tasks-count'),
  newNoteBtn: document.getElementById('new-note-btn'),
  newTaskBtn: document.getElementById('new-task-btn'),
  clearDoneBtn: document.getElementById('clear-done-btn'),
  newTagInput: document.getElementById('new-tag-input'),
  newTagBtn: document.getElementById('new-tag-btn'),
  organizeList: document.getElementById('organize-list'),
  globalProgress: document.getElementById('global-progress'),
  globalLight: document.getElementById('global-light'),
  railStats: document.getElementById('rail-stats'),
  storageMeta: document.getElementById('storage-meta'),
  themeBtn: document.getElementById('theme-btn'),
  themeLabel: document.getElementById('theme-label'),
  helpBtn: document.getElementById('help-btn'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  resetBtn: document.getElementById('reset-btn'),
  reportBtn: document.getElementById('report-btn'),
  reportCopyBtn: document.getElementById('report-copy-btn'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalForm: document.getElementById('modal-form'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalSave: document.getElementById('modal-save'),
  modalDelete: document.getElementById('modal-delete'),
  modalClose: document.getElementById('modal-close'),
  confirmBackdrop: document.getElementById('confirm-backdrop'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmMessage: document.getElementById('confirm-message'),
  confirmDetail: document.getElementById('confirm-detail'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmCancel: document.getElementById('confirm-cancel'),
  confirmClose: document.getElementById('confirm-close'),
  helpBackdrop: document.getElementById('help-backdrop'),
  helpClose: document.getElementById('help-close'),
  helpOk: document.getElementById('help-ok'),
  toastStack: document.getElementById('toast-stack'),
  metaThemeColor: document.getElementById('meta-theme-color'),
  alarmsBar: document.getElementById('alarms-bar'),
  alarmBackdrop: document.getElementById('alarm-backdrop'),
  alarmTitle: document.getElementById('alarm-title'),
  alarmItem: document.getElementById('alarm-item'),
  alarmLabel: document.getElementById('alarm-label'),
  alarmKind: document.getElementById('alarm-kind'),
  alarmDismiss: document.getElementById('alarm-dismiss'),
};

/* ---------- Helpers ------------------------------------------------------ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Local time, not UTC — the old ISO slice showed the wrong day for anyone
   east/west of GMT late in the day. These helpers are module-scope on
   purpose: renderers, quick-select and the alarm bar all call them, and
   nesting them inside another function silently produced ReferenceErrors. */
const pad = n => String(n).padStart(2, '0');
const toLocalDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toLocalTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* Time remaining until a timestamp, used by alarm badges + countdowns. */
function timeRemaining(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'ALARM';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}M`;
  const hour = Math.floor(diff / 3600000);
  if (hour < 24) return `${hour}H`;
  return `${Math.floor(diff / 86400000)}D`;
}

function formatDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - ts;
  const min = 60000, hour = 3600000, day = 86400000;
  if (diff >= 0 && diff < min) return 'JUST NOW';
  if (diff >= 0 && diff < hour) return `${Math.floor(diff / min)}M AGO`;
  if (diff >= 0 && diff < day) return `${Math.floor(diff / hour)}H AGO`;
  if (diff >= 0 && diff < 7 * day) return `${Math.floor(diff / day)}D AGO`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 'S'}`;
}

/* ---------- Toasts (with undo) ------------------------------------------ */

function toast(message, opts = {}) {
  const { actionLabel, onAction, duration = 5000 } = opts;
  const el = document.createElement('div');
  el.className = 'toast';

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.appendChild(msg);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // fallback when animations are disabled
  };

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => { dismiss(); onAction(); });
    el.appendChild(btn);
    el.dataset.hasAction = '1';
  }

  els.toastStack.appendChild(el);

  /* Cap the stack so a burst of changes can't cover the UI. Evict the oldest
     entry, preferring one with no UNDO so a reversible action stays reversible,
     but never the toast just added — otherwise a genuinely important message
     ("storage is full") is dropped the instant three undo toasts are on screen. */
  while (els.toastStack.children.length > TOAST_MAX) {
    const others = Array.from(els.toastStack.children).filter(t => t !== el);
    const victim = others.find(t => !t.dataset.hasAction) || others[0];
    if (!victim) break;
    victim.remove();
  }

  timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------- Theme ------------------------------------------------------- */

const THEME_CYCLE = ['system', 'light', 'dark'];
const THEME_META = {
  system: ['SYS', 'system'],
  light: ['LGT', 'light'],
  dark: ['DRK', 'dark'],
};

function readThemePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_CYCLE.includes(v) ? v : 'system';
  } catch (e) { return 'system'; }
}

const systemLight = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(pref) {
  const resolved = pref === 'system' ? (systemLight.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = resolved;
  if (els.metaThemeColor) {
    els.metaThemeColor.setAttribute('content', resolved === 'light' ? '#F4F3F1' : '#0F0E12');
  }
  const [short, word] = THEME_META[pref];
  els.themeLabel.textContent = short;
  els.themeBtn.title = `Theme: ${word}`;
  els.themeBtn.setAttribute('aria-label', `Change theme, currently ${word}`);
}

let themePref = readThemePref();
applyTheme(themePref);

els.themeBtn.addEventListener('click', () => {
  themePref = THEME_CYCLE[(THEME_CYCLE.indexOf(themePref) + 1) % THEME_CYCLE.length];
  try { localStorage.setItem(THEME_KEY, themePref); } catch (e) { /* non-fatal */ }
  applyTheme(themePref);
});

// Follow the OS only while the user is on "system".
systemLight.addEventListener('change', () => {
  if (themePref === 'system') applyTheme('system');
});

/* ---------- Dialog plumbing (focus trap + Esc + restore focus) ---------- */

const dialogStack = [];
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex]:not([tabindex="-1"])';

function openDialog(backdrop, opts = {}) {
  // Guard against the same dialog being pushed twice: there is only one
  // element per dialog, so a duplicate entry could never be popped and would
  // permanently wedge the stack (killing Esc and all keyboard shortcuts).
  if (dialogStack.some(d => d.backdrop === backdrop)) return false;

  dialogStack.push({
    backdrop,
    restore: document.activeElement,
    onClose: opts.onClose || null,
  });
  backdrop.classList.add('is-active');
  const target = opts.focus || backdrop.querySelector(FOCUSABLE);
  if (target) target.focus();
  return true;
}

function closeDialog(backdrop) {
  const idx = dialogStack.findIndex(d => d.backdrop === backdrop);
  if (idx === -1) return;
  const [entry] = dialogStack.splice(idx, 1);
  backdrop.classList.remove('is-active');

  /* Focus must not be left inside a now-hidden dialog. If it is, every
     keyboard shortcut dies, because isTyping() sees the stranded field and
     assumes the user is typing. Browsers usually reset this when the element
     becomes display:none, but only if it was the active element at that
     moment — restoring to a non-focusable opener (e.g. document.body after a
     keyboard shortcut) leaves it behind. Blur explicitly. */
  if (backdrop.contains(document.activeElement)) document.activeElement.blur();

  if (entry.onClose) entry.onClose();

  const restore = entry.restore;
  if (restore && document.contains(restore) && typeof restore.focus === 'function'
      && !backdrop.contains(restore)) {
    restore.focus();
  }
}

function topDialog() {
  return dialogStack.length ? dialogStack[dialogStack.length - 1] : null;
}

// Click on the backdrop itself (never a child) dismisses.
[els.modalBackdrop, els.confirmBackdrop, els.helpBackdrop, els.alarmBackdrop].forEach(backdrop => {
  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) requestClose(backdrop);
  });
});

function requestClose(backdrop) {
  if (backdrop === els.modalBackdrop) { requestCloseEditor(); return; }
  if (backdrop === els.confirmBackdrop) { resolveConfirm(false); return; }
  closeDialog(backdrop);
}

/* ---------- Confirm dialog (replaces window.confirm) -------------------- */

let confirmResolver = null;

/* Returns a promise so callers read like the old confirm() but get a real,
   themed, keyboard-accessible dialog that can explain the consequences.

   There is exactly one confirm element, so overlapping calls (a double-click
   on DELETE, or a second destructive action while the first is still asking)
   must be rejected rather than stacked. Stacking pushed a second entry onto
   dialogStack that nothing could ever pop, which left every keyboard shortcut
   dead for the rest of the session. */
function confirmAction({ title = 'CONFIRM', message, detail = [], okLabel = 'DELETE', danger = true }) {
  if (confirmResolver) return Promise.resolve(false);

  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;

  if (detail.length) {
    els.confirmDetail.innerHTML = detail.map(d => `<li>${escapeHtml(d)}</li>`).join('');
    els.confirmDetail.hidden = false;
  } else {
    els.confirmDetail.innerHTML = '';
    els.confirmDetail.hidden = true;
  }

  els.confirmOk.textContent = okLabel;
  els.confirmOk.className = danger ? 'btn-danger' : 'btn-primary';

  return new Promise(resolve => {
    confirmResolver = resolve;
    // Focus lands on CANCEL so a stray Enter never destroys anything.
    openDialog(els.confirmBackdrop, {
      focus: els.confirmCancel,
      // Covers closes that bypass resolveConfirm (e.g. Esc handled elsewhere).
      onClose: () => {
        const pending = confirmResolver;
        confirmResolver = null;
        if (pending) pending(false);
      },
    });
  });
}

function resolveConfirm(value) {
  if (!confirmResolver) return;
  const resolver = confirmResolver;
  confirmResolver = null;   // cleared first so onClose does not double-resolve
  closeDialog(els.confirmBackdrop);
  resolver(value);
}

els.confirmOk.addEventListener('click', () => resolveConfirm(true));
els.confirmCancel.addEventListener('click', () => resolveConfirm(false));
els.confirmClose.addEventListener('click', () => resolveConfirm(false));

/* ---------- Shortcuts dialog ------------------------------------------- */

els.helpBtn.addEventListener('click', () => openDialog(els.helpBackdrop, { focus: els.helpOk }));
els.helpClose.addEventListener('click', () => closeDialog(els.helpBackdrop));
els.helpOk.addEventListener('click', () => closeDialog(els.helpBackdrop));

/* ---------- View switching ---------------------------------------------- */

function setView(view) {
  if (!VIEWS.includes(view)) return;
  activeView = view;
  els.viewBtns.forEach(btn => {
    const on = btn.dataset.view === view;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  els.viewPanels.forEach(panel => {
    const on = panel.id === `view-${view}`;
    panel.classList.toggle('is-active', on);
    panel.hidden = !on;
  });
  renderAll();
}

els.viewBtns.forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
  // Arrow-key navigation is expected of a real tablist.
  btn.addEventListener('keydown', e => {
    const i = VIEWS.indexOf(btn.dataset.view);
    let next = null;
    if (e.key === 'ArrowRight') next = VIEWS[(i + 1) % VIEWS.length];
    if (e.key === 'ArrowLeft') next = VIEWS[(i - 1 + VIEWS.length) % VIEWS.length];
    if (!next) return;
    e.preventDefault();
    setView(next);
    document.getElementById(`tab-${next}`).focus();
  });
});

/* ---------- Search + filtering ----------------------------------------- */

let searchDebounce = null;
els.searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = els.searchInput.value.trim();
    renderAll();
  }, 120);
});

els.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape' && els.searchInput.value) {
    e.stopPropagation();
    clearSearch();
  }
});

function clearSearch() {
  els.searchInput.value = '';
  searchQuery = '';
  renderAll();
}

function matchesTag(item) {
  if (activeTagFilter === 'all') return true;
  if (activeTagFilter === 'untagged') return (item.tagIds || []).length === 0;
  return (item.tagIds || []).includes(activeTagFilter);
}

function matchesSearch(item) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  if (`${item.title} ${item.body}`.toLowerCase().includes(q)) return true;
  // Searching a tag name should surface everything carrying that tag.
  return (item.tagIds || []).some(id => {
    const tag = tagsById.get(id);
    return tag && tag.name.toLowerCase().includes(q);
  });
}

function visible(item) {
  return matchesTag(item) && matchesSearch(item);
}

/* Case-insensitive match positions in the RAW string, so highlighting can
   escape each segment independently.

   Doing it the other way round — escaping first, then regexing — lets a query
   like "amp;" match inside the entity produced by escaping "&", splitting
   `&amp;` into `&` + `<mark>amp;</mark>` and rendering a literal "&amp;".
   Never run the needle over escaped output. */
function highlight(text) {
  const raw = String(text);
  if (!searchQuery) return escapeHtml(raw);

  const haystack = raw.toLowerCase();
  const needle = searchQuery.toLowerCase();
  if (!needle) return escapeHtml(raw);

  let out = '';
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    out += escapeHtml(raw.slice(cursor, at));
    out += `<mark>${escapeHtml(raw.slice(at, at + needle.length))}</mark>`;
    cursor = at + needle.length;
  }
  return out + escapeHtml(raw.slice(cursor));
}

function truncate(str, max) {
  const clean = str.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

/* ---------- Tag filter rail -------------------------------------------- */

function chipHtml(id, label, count) {
  const on = activeTagFilter === id;
  return `<button type="button" class="tag-chip${on ? ' is-active' : ''}" data-filter="${escapeAttr(id)}"` +
         ` aria-pressed="${on}"><span>${escapeHtml(label)}</span>` +
         `<span class="chip-count mono">${count}</span></button>`;
}

function renderTagFilterRail() {
  const chips = [chipHtml('all', 'ALL', state.notes.length + state.tasks.length)];

  state.tags.forEach(tag => {
    const u = tagUsage.get(tag.id) || { notes: 0, tasks: 0 };
    chips.push(chipHtml(tag.id, tag.name.toUpperCase(), u.notes + u.tasks));
  });

  if (untaggedCount > 0 && state.tags.length > 0) {
    chips.push(chipHtml('untagged', 'UNTAGGED', untaggedCount));
  }

  els.tagFilterList.innerHTML = chips.join('');
}

els.tagFilterList.addEventListener('click', e => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  const id = btn.dataset.filter;
  // Clicking the active filter clears it — fewer clicks to get back to ALL.
  activeTagFilter = (id !== 'all' && activeTagFilter === id) ? 'all' : id;
  renderAll();
});

/* ---------- Notes ------------------------------------------------------- */

/* One innerHTML write for the whole list plus one delegated listener, instead
   of createElement + innerHTML + addEventListener per card. With a few hundred
   notes the per-card version spent most of a repaint in the HTML parser. */
function noteCardHtml(note) {
  const alarmBadge = note.alarmAt ? `<span class="alarm-badge" title="${escapeAttr(note.alarmLabel || 'ALARM')}">${timeRemaining(note.alarmAt)}</span>` : '';
  return `
    <div class="card" role="button" tabindex="0" data-note-id="${escapeAttr(note.id)}"
         aria-label="Edit note: ${escapeAttr(note.title || 'untitled')}">
      <div class="card-title">${note.pinned ? '<span aria-hidden="true">★ </span>' : ''}${highlight(note.title || 'UNTITLED')}</div>
      <div class="card-body">${highlight(truncate(note.body || '', 260))}</div>
      <div class="card-tags">${renderTagPills(note.tagIds)}</div>
      <div class="card-meta">${alarmBadge}${escapeHtml(formatDate(note.updatedAt))}</div>
    </div>`;
}

function renderNotes() {
  const filtered = state.notes.filter(visible);

  if (filtered.length === 0) {
    els.notesList.innerHTML = state.notes.length === 0
      ? '<div class="empty-state">NO NOTES YET<span class="empty-hint">PRESS N OR HIT + NEW NOTE</span></div>'
      : '<div class="empty-state">NOTHING MATCHES THIS FILTER<span class="empty-hint">CLEAR THE SEARCH OR TAG FILTER</span></div>';
    return;
  }

  els.notesList.innerHTML = filtered
    .slice()
    // Pinned first, then most recently touched.
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.updatedAt - a.updatedAt)
    .map(noteCardHtml)
    .join('');
}

/* Delegated once at startup — survives every re-render. */
els.notesList.addEventListener('click', e => {
  const card = e.target.closest('[data-note-id]');
  if (card) openNoteModal(card.dataset.noteId);
});

els.notesList.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const card = e.target.closest('[data-note-id]');
  if (!card) return;
  e.preventDefault();
  openNoteModal(card.dataset.noteId);
});

/* ---------- Tasks ------------------------------------------------------- */

/* role="group" + an inner title button, NOT role="button" on the card: a
   button may not contain other interactive controls, and this card owns three
   status buttons. The title button is the edit affordance, so Enter/Space work
   natively; Arrow keys move status, which no button consumes. */
function taskCardHtml(task) {
  const dots = STATUS_ORDER.map(s =>
    `<button type="button" class="status-dot${s === task.status ? ' is-current' : ''}" data-status="${s}"` +
    ` title="Move to ${STATUS_LABEL[s]}" aria-label="Move to ${STATUS_LABEL[s]}"` +
    `${s === task.status ? ' aria-current="true"' : ''}></button>`).join('');

  const alarmBadge = task.alarmAt ? `<span class="alarm-badge" title="${escapeAttr(task.alarmLabel || 'ALARM')}">${timeRemaining(task.alarmAt)}</span>` : '';

  return `
    <div class="task-card${task.status === 'done' ? ' is-done' : ''}" draggable="true"
         role="group" data-task-id="${escapeAttr(task.id)}"
         aria-label="${escapeAttr(`${task.title || 'Untitled'} — ${STATUS_LABEL[task.status]}`)}">
      <button type="button" class="task-open">${highlight(task.title || 'UNTITLED')}</button>
      ${task.body ? `<div class="card-meta">${alarmBadge}${highlight(truncate(task.body, 90))}</div>` : alarmBadge ? `<div class="card-meta">${alarmBadge}</div>` : ''}
      <div class="task-card-foot">
        <div class="card-tags">${renderTagPills(task.tagIds)}</div>
        <div class="status-select" role="group" aria-label="Status">${dots}</div>
      </div>
    </div>`;
}

function renderTasks() {
  const shown = state.tasks.filter(visible);

  STATUS_ORDER.forEach(status => {
    const items = shown
      .filter(t => t.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    document.getElementById(`count-${status}`).textContent = items.length;
    document.getElementById(`col-${status}`).innerHTML = items.length === 0
      ? '<div class="empty-state">—</div>'
      : items.map(taskCardHtml).join('');
  });
}

/* Delegated once per column, so re-rendering never re-binds anything. */
document.querySelectorAll('[data-drop-status]').forEach(zone => {
  zone.addEventListener('click', e => {
    const card = e.target.closest('[data-task-id]');
    if (!card) return;
    const id = card.dataset.taskId;
    const dot = e.target.closest('.status-dot');
    if (dot) { setTaskStatus(id, dot.dataset.status); return; }
    if (e.target.closest('.task-open')) openTaskModal(id);
  });

  // Arrow keys nudge status without stealing Enter/Space from the button.
  zone.addEventListener('keydown', e => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    const card = e.target.closest('[data-task-id]');
    if (!card) return;
    const task = state.tasks.find(t => t.id === card.dataset.taskId);
    if (!task) return;
    e.preventDefault();
    const i = STATUS_ORDER.indexOf(task.status);
    setTaskStatus(task.id, STATUS_ORDER[(i + delta + STATUS_ORDER.length) % STATUS_ORDER.length],
      { keepFocus: task.id });
  });

  zone.addEventListener('dragstart', e => {
    const card = e.target.closest('[data-task-id]');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.taskId);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });

  zone.addEventListener('dragend', e => {
    const card = e.target.closest('[data-task-id]');
    if (card) card.classList.remove('is-dragging');
    // A drag cancelled with Esc fires no drop, so clear every highlight.
    document.querySelectorAll('.is-drop-target')
      .forEach(z => z.classList.remove('is-drop-target'));
  });

  // dragenter/dragleave fire for every descendant, so a plain dragleave
  // handler unlights the column the moment the pointer crosses onto a card
  // inside it. Count enters/leaves instead of trusting a single event.
  let depth = 0;

  zone.addEventListener('dragenter', e => {
    e.preventDefault();
    depth++;
    zone.classList.add('is-drop-target');
  });

  zone.addEventListener('dragover', e => {
    e.preventDefault();                       // required to allow the drop
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('is-drop-target');     // covers a missed dragenter
  });

  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('is-drop-target');
  });

  zone.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('is-drop-target');
    const id = e.dataTransfer.getData('text/plain');
    if (id) setTaskStatus(id, zone.dataset.dropStatus);
  });
});

function setTaskStatus(id, status, opts = {}) {
  const task = state.tasks.find(t => t.id === id);
  if (!task || !STATUS_ORDER.includes(status) || task.status === status) return;

  commit(() => {
    task.status = status;
    task.updatedAt = Date.now();
  });

  if (opts.keepFocus) {
    // renderAll() replaced the card, so re-focus the rebuilt one. The card
    // itself is not focusable; its title button is.
    const again = document.querySelector(`.task-card[data-task-id="${opts.keepFocus}"] .task-open`);
    if (again) again.focus();
  }
}

els.clearDoneBtn.addEventListener('click', async () => {
  const done = state.tasks.filter(t => t.status === 'done');
  if (done.length === 0) return;

  const ok = await confirmAction({
    title: 'CLEAR DONE',
    message: `Delete ${plural(done.length, 'completed task').toLowerCase()}?`,
    detail: done.slice(0, 6).map(t => `· ${truncate(t.title || 'Untitled', 40)}`)
      .concat(done.length > 6 ? [`· …and ${done.length - 6} more`] : []),
    okLabel: 'DELETE THEM',
  });
  if (!ok) return;

  const removed = done.map(t => ({ item: t, index: state.tasks.indexOf(t) }));

  commit(() => { state.tasks = state.tasks.filter(t => t.status !== 'done'); }, {
    message: `Deleted ${plural(done.length, 'task').toLowerCase()}.`,
    toast: {
      actionLabel: 'UNDO',
      duration: 8000,
      onAction: restoreItems(() => state.tasks, removed),
    },
  });
});

/* ---------- Tag pills / picker (shared by notes + tasks) ---------------- */

/* Rebuilt once per render pass. Without these, every pill did a linear
   state.tags.find() and every tag row/chip re-scanned all notes and tasks,
   making a full repaint O(items x tags). */
let tagsById = new Map();
let tagUsage = new Map();   // tagId -> { notes, tasks }
let untaggedCount = 0;

function refreshTagIndex() {
  tagsById = new Map(state.tags.map(t => [t.id, t]));

  tagUsage = new Map(state.tags.map(t => [t.id, { notes: 0, tasks: 0 }]));
  untaggedCount = 0;

  const tally = (items, key) => items.forEach(item => {
    if (item.tagIds.length === 0) { untaggedCount++; return; }
    item.tagIds.forEach(id => {
      const entry = tagUsage.get(id);
      if (entry) entry[key]++;
    });
  });

  tally(state.notes, 'notes');
  tally(state.tasks, 'tasks');
}

function renderTagPills(tagIds) {
  if (!tagIds || tagIds.length === 0) return '';
  return tagIds
    .map(id => tagsById.get(id))
    .filter(Boolean)
    .map(t => `<span class="pill">${escapeHtml(t.name.toUpperCase())}</span>`)
    .join('');
}

function renderTagPicker(selectedIds) {
  if (state.tags.length === 0) {
    return '<span class="field-meta">NO TAGS YET — ADD THEM IN ORGANIZE</span>';
  }
  return state.tags.map(tag => `
    <button type="button" class="tag-chip${selectedIds.includes(tag.id) ? ' is-active' : ''}"
            data-tag-id="${escapeAttr(tag.id)}" aria-pressed="${selectedIds.includes(tag.id)}">${escapeHtml(tag.name.toUpperCase())}</button>
  `).join('');
}

function attachTagPickerHandlers() {
  const container = document.getElementById('field-tags');
  if (!container) return;
  container.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const on = chip.classList.toggle('is-active');
      chip.setAttribute('aria-pressed', String(on));
    });
  });
}

function getSelectedTagIds() {
  const container = document.getElementById('field-tags');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.tag-chip.is-active')).map(c => c.dataset.tagId);
}

/* ---------- Editor modal ------------------------------------------------ */

function openNoteModal(id) {
  const note = id ? state.notes.find(n => n.id === id) : null;
  if (id && !note) return;

  modalContext = { type: 'note', id, pinned: note ? note.pinned === true : false };
  els.modalTitle.textContent = id ? 'EDIT NOTE' : 'NEW NOTE';
  els.modalDelete.hidden = !id;

  const alarmDate = note && note.alarmAt ? toLocalDate(note.alarmAt) : '';
  const alarmTime = note && note.alarmAt ? toLocalTime(note.alarmAt) : '';
  const alarmLabel = note && note.alarmLabel ? note.alarmLabel : '';

  els.modalBody.innerHTML = `
    <div>
      <label for="field-title">TITLE</label>
      <input type="text" id="field-title" value="${escapeAttr(note ? note.title : '')}" placeholder="Note title" autocomplete="off">
    </div>
    <div>
      <label for="field-body">BODY</label>
      <textarea id="field-body" placeholder="Write here…">${escapeHtml(note ? note.body : '')}</textarea>
      <div class="field-meta" id="field-counter"></div>
    </div>
    <div>
      <label>TAGS</label>
      <div class="tag-picker" id="field-tags">${renderTagPicker(note ? note.tagIds : [])}</div>
    </div>
    <div>
      <label>OPTIONS</label>
      <div class="tag-picker">
        <button type="button" class="tag-chip${modalContext.pinned ? ' is-active' : ''}" id="field-pin"
                aria-pressed="${modalContext.pinned}">★ PIN TO TOP</button>
      </div>
    </div>
    <div>
      <label>REMINDER</label>
      <div class="alarm-row">
        <input type="date" id="field-alarm-date" value="${escapeAttr(alarmDate)}">
        <input type="time" id="field-alarm-time" value="${escapeAttr(alarmTime)}">
      </div>
      <div class="alarm-quick">
        <button type="button" class="tag-chip" data-quick="today">TODAY</button>
        <button type="button" class="tag-chip" data-quick="tomorrow">TOMORROW</button>
        <button type="button" class="tag-chip" data-quick="week">NEXT WEEK</button>
        <button type="button" class="tag-chip" data-quick="month">NEXT MONTH</button>
      </div>
      <div class="alarm-row">
        <input type="text" id="field-alarm-label" value="${escapeAttr(alarmLabel)}" placeholder="Label (optional)" autocomplete="off">
        <button type="button" class="btn-ghost btn-sm" id="field-calendar" title="Download calendar file">ICS</button>
      </div>
      <div class="field-meta" id="field-alarm-display"></div>
    </div>
    ${note ? `<div class="field-meta">CREATED ${escapeHtml(formatDate(note.createdAt))} · UPDATED ${escapeHtml(formatDate(note.updatedAt))}</div>` : ''}
  `;

  const pinBtn = document.getElementById('field-pin');
  pinBtn.addEventListener('click', () => {
    modalContext.pinned = pinBtn.classList.toggle('is-active');
    pinBtn.setAttribute('aria-pressed', String(modalContext.pinned));
  });

  attachQuickSelect();
  updateAlarmDisplay();

  const calBtn = document.getElementById('field-calendar');
  calBtn.addEventListener('click', () => {
    const alarmAt = readAlarmFromFields();
    const alarmLabelEl = document.getElementById('field-alarm-label');
    if (alarmAt) {
      downloadICS({
        id: note ? note.id : '__new__',
        title: (document.getElementById('field-title') || {}).value || 'Note',
        body: (document.getElementById('field-body') || {}).value || '',
        alarmAt,
        alarmLabel: alarmLabelEl ? alarmLabelEl.value : '',
      });
    } else {
      toast('Set a date/time first.', { duration: 3000 });
    }
  });

  attachTagPickerHandlers();
  attachCounter();
  openEditor();
}

function openTaskModal(id) {
  const task = id ? state.tasks.find(t => t.id === id) : null;
  if (id && !task) return;

  modalContext = { type: 'task', id, status: task ? task.status : 'not_started' };
  els.modalTitle.textContent = id ? 'EDIT TASK' : 'NEW TASK';
  els.modalDelete.hidden = !id;

  const alarmDate = task && task.alarmAt ? toLocalDate(task.alarmAt) : '';
  const alarmTime = task && task.alarmAt ? toLocalTime(task.alarmAt) : '';
  const alarmLabel = task && task.alarmLabel ? task.alarmLabel : '';

  els.modalBody.innerHTML = `
    <div>
      <label for="field-title">TITLE</label>
      <input type="text" id="field-title" value="${escapeAttr(task ? task.title : '')}" placeholder="Task title" autocomplete="off">
    </div>
    <div>
      <label for="field-body">NOTES</label>
      <textarea id="field-body" placeholder="Optional details…">${escapeHtml(task ? task.body : '')}</textarea>
      <div class="field-meta" id="field-counter"></div>
    </div>
    <div>
      <label>STATUS</label>
      <div class="tag-picker" id="field-status">
        ${STATUS_ORDER.map(s => `<button type="button" class="tag-chip${s === modalContext.status ? ' is-active' : ''}" data-status="${s}" aria-pressed="${s === modalContext.status}">${STATUS_LABEL[s]}</button>`).join('')}
      </div>
    </div>
    <div>
      <label>TAGS</label>
      <div class="tag-picker" id="field-tags">${renderTagPicker(task ? task.tagIds : [])}</div>
    </div>
    <div>
      <label>REMINDER</label>
      <div class="alarm-row">
        <input type="date" id="field-alarm-date" value="${escapeAttr(alarmDate)}">
        <input type="time" id="field-alarm-time" value="${escapeAttr(alarmTime)}">
      </div>
      <div class="alarm-quick">
        <button type="button" class="tag-chip" data-quick="today">TODAY</button>
        <button type="button" class="tag-chip" data-quick="tomorrow">TOMORROW</button>
        <button type="button" class="tag-chip" data-quick="week">NEXT WEEK</button>
        <button type="button" class="tag-chip" data-quick="month">NEXT MONTH</button>
      </div>
      <div class="alarm-row">
        <input type="text" id="field-alarm-label" value="${escapeAttr(alarmLabel)}" placeholder="Label (optional)" autocomplete="off">
        <button type="button" class="btn-ghost btn-sm" id="field-calendar" title="Download calendar file">ICS</button>
      </div>
      <div class="field-meta" id="field-alarm-display"></div>
    </div>
    ${task ? `<div class="field-meta">CREATED ${escapeHtml(formatDate(task.createdAt))} · UPDATED ${escapeHtml(formatDate(task.updatedAt))}</div>` : ''}
  `;

  // Status lives on modalContext, not on a DOM expando like the old
  // modalBody._getStatus, so a re-render can never drop it.
  document.querySelectorAll('#field-status .tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      modalContext.status = chip.dataset.status;
      document.querySelectorAll('#field-status .tag-chip').forEach(c => {
        const on = c === chip;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', String(on));
      });
    });
  });

  const calBtn = document.getElementById('field-calendar');
  calBtn.addEventListener('click', () => {
    const alarmAt = readAlarmFromFields();
    const alarmLabelEl = document.getElementById('field-alarm-label');
    if (alarmAt) {
      downloadICS({
        id: task ? task.id : '__new__',
        title: (document.getElementById('field-title') || {}).value || 'Task',
        body: (document.getElementById('field-body') || {}).value || '',
        alarmAt,
        alarmLabel: alarmLabelEl ? alarmLabelEl.value : '',
      });
    } else {
      toast('Set a date/time first.', { duration: 3000 });
    }
  });

  attachQuickSelect();
  updateAlarmDisplay();
  attachTagPickerHandlers();
  attachCounter();
  openEditor();
}

function attachCounter() {
  const body = document.getElementById('field-body');
  const counter = document.getElementById('field-counter');
  if (!body || !counter) return;
  const update = () => {
    const chars = body.value.length;
    const words = body.value.trim() ? body.value.trim().split(/\s+/).length : 0;
    counter.textContent = `${words} WORDS · ${chars} CHARS`;
  };
  body.addEventListener('input', update);
  update();
}

function openEditor() {
  openDialog(els.modalBackdrop, {
    focus: document.getElementById('field-title'),
    onClose: () => { modalContext = null; },
  });
  snapshotEditor();
}

/* Dirty tracking so closing a half-written note asks first instead of
   silently throwing the text away. */
let editorSnapshot = '';

function editorFingerprint() {
  const title = document.getElementById('field-title');
  const body = document.getElementById('field-body');
  const dateEl = document.getElementById('field-alarm-date');
  const timeEl = document.getElementById('field-alarm-time');
  const alarmLabel = document.getElementById('field-alarm-label');
  if (!title || !body || !modalContext) return '';
  return JSON.stringify([
    title.value,
    body.value,
    getSelectedTagIds().slice().sort(),
    modalContext.status || '',
    modalContext.pinned || false,
    dateEl ? dateEl.value : '',
    timeEl ? timeEl.value : '',
    alarmLabel ? alarmLabel.value : '',
  ]);
}

function snapshotEditor() { editorSnapshot = editorFingerprint(); }
function editorIsDirty() { return editorSnapshot !== editorFingerprint(); }

async function requestCloseEditor() {
  if (!modalContext) { closeDialog(els.modalBackdrop); return; }
  if (editorIsDirty()) {
    const discard = await confirmAction({
      title: 'UNSAVED CHANGES',
      message: 'Discard your changes to this item?',
      okLabel: 'DISCARD',
    });
    if (!discard) return;
  }
  closeDialog(els.modalBackdrop);
}

els.modalClose.addEventListener('click', requestCloseEditor);

els.modalForm.addEventListener('submit', e => {
  e.preventDefault();
  saveFromEditor();
});

function saveFromEditor() {
  if (!modalContext) return;
  const titleEl = document.getElementById('field-title');
  const bodyEl = document.getElementById('field-body');
  const title = titleEl.value.trim();
  const body = bodyEl.value;
  const tagIds = getSelectedTagIds();
  const now = Date.now();

  // An entirely empty item is almost always an accident.
  if (!title && !body.trim()) {
    toast('Nothing to save — add a title or some text.');
    titleEl.focus();
    return;
  }

  const isNew = !modalContext.id;
  const kind = modalContext.type === 'note' ? 'Note' : 'Task';
  const list = modalContext.type === 'note' ? state.notes : state.tasks;
  const existing = isNew ? null : list.find(i => i.id === modalContext.id);

  /* The item can vanish mid-edit: another tab deleted it, or a Drive pull
     replaced the whole state. Never throw the typed text away — re-create the
     item with its original id and say so. */
  const recovered = !isNew && !existing;

  const alarmAt = readAlarmFromFields();
  const alarmLabelEl = document.getElementById('field-alarm-label');
  const alarmLabel = alarmLabelEl ? alarmLabelEl.value.trim() : '';

  if (modalContext.type === 'note') {
    const fields = { title, body, tagIds, pinned: modalContext.pinned === true, updatedAt: now, alarmAt, alarmLabel };
    if (existing) Object.assign(existing, fields);
    else state.notes.push({ id: modalContext.id || uid(), createdAt: now, ...fields });
  } else {
    const status = STATUS_ORDER.includes(modalContext.status) ? modalContext.status : 'not_started';
    const fields = { title, body, tagIds, status, updatedAt: now, alarmAt, alarmLabel };
    if (existing) Object.assign(existing, fields);
    else state.tasks.push({ id: modalContext.id || uid(), createdAt: now, ...fields });
  }

  snapshotEditor(); // prevents the dirty prompt on the way out
  closeDialog(els.modalBackdrop);
  commit(() => {}, {
    message: recovered
      ? `${kind} had been deleted elsewhere — restored it with your changes.`
      : `${kind} ${isNew ? 'created' : 'saved'}.`,
    toast: { duration: recovered ? 7000 : 2500 },
  });
  checkAlarms();
}

els.modalDelete.addEventListener('click', async () => {
  if (!modalContext || !modalContext.id) return;
  const { type, id } = modalContext;
  const listOf = () => (type === 'note' ? state.notes : state.tasks);
  const index = listOf().findIndex(i => i.id === id);
  if (index === -1) return;
  const item = listOf()[index];

  const ok = await confirmAction({
    title: type === 'note' ? 'DELETE NOTE' : 'DELETE TASK',
    message: `Delete "${truncate(item.title || 'Untitled', 60)}"?`,
    detail: [
      type === 'note' && item.body ? `${item.body.trim().split(/\s+/).length} words of text` : '',
      `Created ${formatDate(item.createdAt)}`,
      'You can undo this right after.',
    ].filter(Boolean),
  });
  if (!ok) return;

  snapshotEditor();
  closeDialog(els.modalBackdrop);

  commit(() => { listOf().splice(index, 1); }, {
    message: `${type === 'note' ? 'Note' : 'Task'} deleted.`,
    toast: {
      actionLabel: 'UNDO',
      duration: 8000,
      onAction: restoreItems(listOf, [{ item, index }]),
    },
  });
});

els.newNoteBtn.addEventListener('click', () => openNoteModal(null));
els.newTaskBtn.addEventListener('click', () => openTaskModal(null));

/* ---------- Organize: tag CRUD ----------------------------------------- */

function renderOrganize() {
  if (state.tags.length === 0) {
    els.organizeList.innerHTML = '<div class="empty-state">NO TAGS YET<span class="empty-hint">TAGS GROUP NOTES AND TASKS TOGETHER</span></div>';
    return;
  }

  els.organizeList.innerHTML = state.tags.map(tag => {
    const u = tagUsage.get(tag.id) || { notes: 0, tasks: 0 };
    return `
      <div class="organize-row" data-tag-id="${escapeAttr(tag.id)}">
        <span class="tag-name" contenteditable="true" spellcheck="false" role="textbox"
              aria-label="Rename tag ${escapeAttr(tag.name)}">${escapeHtml(tag.name.toUpperCase())}</span>
        <span class="tag-stats">${u.notes} NOTES · ${u.tasks} TASKS</span>
        <span class="tag-actions"><button type="button" class="tag-delete">DELETE</button></span>
      </div>`;
  }).join('');
}

/* Delegated once. Inline rename saves on blur or Enter and reverts on Escape;
   the DOM is the draft, `state` is only touched on a successful commit. */
function tagFromEvent(e) {
  const row = e.target.closest('[data-tag-id]');
  if (!row) return null;
  return state.tags.find(t => t.id === row.dataset.tagId) || null;
}

function commitRename(nameEl, tag) {
  const next = nameEl.textContent.trim().slice(0, TAG_MAX);
  const revert = () => { nameEl.textContent = tag.name.toUpperCase(); };

  if (!next || next.toUpperCase() === tag.name.toUpperCase()) return revert();
  if (state.tags.some(t => t.id !== tag.id && t.name.toLowerCase() === next.toLowerCase())) {
    toast(`A tag named "${next}" already exists.`);
    return revert();
  }
  commit(() => { tag.name = next; }, { message: 'Tag renamed.', toast: { duration: 2000 } });
}

els.organizeList.addEventListener('click', e => {
  if (!e.target.closest('.tag-delete')) return;
  const tag = tagFromEvent(e);
  if (tag) deleteTag(tag.id);
});

els.organizeList.addEventListener('focusout', e => {
  if (!e.target.classList.contains('tag-name')) return;
  const tag = tagFromEvent(e);
  if (tag) commitRename(e.target, tag);
});

els.organizeList.addEventListener('keydown', e => {
  if (!e.target.classList.contains('tag-name')) return;
  const tag = tagFromEvent(e);
  if (!tag) return;
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.textContent = tag.name.toUpperCase(); e.target.blur(); }
});

async function deleteTag(id) {
  const tag = state.tags.find(t => t.id === id);
  if (!tag) return;
  const noteCount = state.notes.filter(n => n.tagIds.includes(id)).length;
  const taskCount = state.tasks.filter(t => t.tagIds.includes(id)).length;

  const ok = await confirmAction({
    title: 'DELETE TAG',
    message: `Delete the tag "${tag.name}"?`,
    detail: [
      `It will be removed from ${plural(noteCount, 'note').toLowerCase()} and ${plural(taskCount, 'task').toLowerCase()}.`,
      'The notes and tasks themselves are kept.',
    ],
    okLabel: 'DELETE TAG',
  });
  if (!ok) return;

  const index = state.tags.indexOf(tag);
  // Remember only which items referenced the tag, so undo cannot resurrect
  // unrelated edits made while the toast was on screen.
  const affected = [...state.notes, ...state.tasks]
    .filter(i => i.tagIds.includes(id))
    .map(i => i.id);

  commit(() => {
    state.tags.splice(index, 1);
    state.notes.forEach(n => { n.tagIds = n.tagIds.filter(t => t !== id); });
    state.tasks.forEach(t => { t.tagIds = t.tagIds.filter(t2 => t2 !== id); });
    if (activeTagFilter === id) activeTagFilter = 'all';
  }, {
    message: `Tag "${tag.name}" deleted.`,
    toast: {
      actionLabel: 'UNDO',
      duration: 8000,
      onAction: () => commit(() => {
        state.tags.splice(Math.min(index, state.tags.length), 0, tag);
        [...state.notes, ...state.tasks].forEach(item => {
          if (affected.includes(item.id) && !item.tagIds.includes(id)) item.tagIds.push(id);
        });
      }, { message: 'Restored.', toast: { duration: 2000 } }),
    },
  });
}

function addTag() {
  const name = els.newTagInput.value.trim().slice(0, TAG_MAX);
  if (!name) return;
  if (state.tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    toast(`A tag named "${name}" already exists.`);
    els.newTagInput.select();
    return;
  }
  els.newTagInput.value = '';
  commit(() => { state.tags.push({ id: uid(), name }); });
  els.newTagInput.focus();
}

els.newTagBtn.addEventListener('click', addTag);
els.newTagInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addTag(); }
});

/* ---------- Backup: export / import / reset ----------------------------- */

/* Export is a plain Blob download — no server, no upload, no third party.
   This is the escape hatch that keeps the app free of lock-in. */
els.exportBtn.addEventListener('click', () => {
  const payload = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadTextFile(`personal-os-backup-${stamp}.json`, payload, 'application/json');
  toast('Backup downloaded.', { duration: 3000 });
});

els.importBtn.addEventListener('click', () => els.importFile.click());

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files && els.importFile.files[0];
  if (!file) return;
  els.importFile.value = ''; // allow re-importing the same filename

  let incoming;
  try {
    incoming = sanitizeState(JSON.parse(await file.text()));
  } catch (e) {
    toast('That file is not a valid Personal OS backup.', { duration: 6000 });
    return;
  }

  const ok = await confirmAction({
    title: 'IMPORT BACKUP',
    message: 'Replace everything currently in this browser with the backup?',
    detail: [
      `Backup contains ${plural(incoming.notes.length, 'note').toLowerCase()}, ${plural(incoming.tasks.length, 'task').toLowerCase()}, ${plural(incoming.tags.length, 'tag').toLowerCase()}.`,
      `You currently have ${plural(state.notes.length, 'note').toLowerCase()}, ${plural(state.tasks.length, 'task').toLowerCase()}, ${plural(state.tags.length, 'tag').toLowerCase()}.`,
      'Undo is offered right after, but export first if unsure.',
    ],
    okLabel: 'REPLACE',
  });
  if (!ok) return;

  /* Whole-state replacement is the one case where a full snapshot IS the right
     undo unit: the user asked to swap everything at once. */
  const previous = JSON.parse(JSON.stringify(state));

  commit(() => {
    state = incoming;
    activeTagFilter = 'all';
  }, {
    message: 'Backup imported.',
    toast: {
      actionLabel: 'UNDO',
      duration: 9000,
      onAction: () => commit(() => { state = sanitizeState(previous); }, {
        message: 'Reverted to your previous data.',
        toast: { duration: 3000 },
      }),
    },
  });
});

els.resetBtn.addEventListener('click', async () => {
  const ok = await confirmAction({
    title: 'DELETE ALL DATA',
    message: 'Permanently delete every note, task and tag in this browser?',
    detail: [
      `${plural(state.notes.length, 'note')} · ${plural(state.tasks.length, 'task')} · ${plural(state.tags.length, 'tag')}`,
      'Export a backup first if you might want any of it later.',
    ],
    okLabel: 'DELETE EVERYTHING',
  });
  if (!ok) return;

  // Second gate: this is the one action with no cheap way back if the
  // undo toast is missed, and it also propagates to Drive.
  const reallyOk = await confirmAction({
    title: 'ARE YOU SURE',
    message: 'This clears local data and, if sync is on, the copy in your Google Drive too.',
    okLabel: 'YES, DELETE ALL',
  });
  if (!reallyOk) return;

  const previous = JSON.parse(JSON.stringify(state));

  commit(() => {
    state = sanitizeState(null);
    activeTagFilter = 'all';
    searchQuery = '';
    els.searchInput.value = '';
  }, {
    message: 'All data deleted.',
    toast: {
      actionLabel: 'UNDO',
      duration: 10000,
      onAction: () => commit(() => { state = sanitizeState(previous); }, {
        message: 'Everything restored.',
        toast: { duration: 3000 },
      }),
    },
  });
});

/* ---------- Daily report (explicit tap only; nothing runs by itself) -------

   A plain-Markdown summary of the current local day, generated from state at
   the moment you tap. Reports are derived on demand and never persisted —
   there is no report history in localStorage to go stale.

   Delivery is deliberately pluggable: REPORT_TARGETS maps a target id to a
   deliver(markdown) function. Shipping today: download + clipboard (both
   fully local). Adding e.g. a GitHub commit or Drive upload later means one
   new entry here plus its config UI — and, because it would touch the
   network, a privacy.html + CSP update in the same commit. */

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function startOfLocalDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function cleanLine(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function countWords(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function buildReportMarkdown(nowTs = Date.now()) {
  const now = new Date(nowTs);
  const dayStart = startOfLocalDay(nowTs);
  const dayEnd = dayStart + 86400000;
  const inToday = ts => Number.isFinite(ts) && ts >= dayStart && ts < dayEnd;
  const today = toLocalDate(nowTs);

  /* "Done today" cannot be derived from a dedicated timestamp (the schema has
     none), only from updatedAt — so a task done *any* prior day but touched
     today counts, and we say so in the report instead of overclaiming. */
  const doneToday = state.tasks.filter(t => t.status === 'done' && inToday(t.updatedAt));
  const createdToday = [
    ...state.tasks.filter(t => inToday(t.createdAt)).map(t => ({ kind: 'task', title: t.title, createdAt: t.createdAt })),
    ...state.notes.filter(n => inToday(n.createdAt)).map(n => ({ kind: 'note', title: n.title, createdAt: n.createdAt })),
  ].sort((a, b) => a.createdAt - b.createdAt);
  const notesTouched = state.notes.filter(n => inToday(n.updatedAt)).sort((a, b) => b.updatedAt - a.updatedAt);
  const wordsToday = notesTouched.reduce((sum, n) => sum + countWords(n.body), 0);
  const openTasks = state.tasks.filter(t => t.status !== 'done');
  const inProgress = state.tasks.filter(t => t.status === 'in_progress');

  const tagsInPlay = new Set();
  state.notes.filter(n => inToday(n.updatedAt)).forEach(n => (n.tagIds || []).forEach(id => tagsInPlay.add(id)));
  state.tasks.filter(t => inToday(t.updatedAt)).forEach(t => (t.tagIds || []).forEach(id => tagsInPlay.add(id)));
  const tagNames = [...tagsInPlay]
    .map(id => (tagsById.get(id) || {}).name)
    .filter(Boolean)
    .map(n => n.toUpperCase());

  const horizon = nowTs + 86400000;
  const upcoming = [...state.notes, ...state.tasks]
    .filter(i => i.alarmAt && i.alarmAt >= dayStart && i.alarmAt < horizon)
    .sort((a, b) => a.alarmAt - b.alarmAt);

  const md = [];
  md.push(`# DAILY REPORT — ${WEEKDAYS[now.getDay()]} ${today}`);
  md.push('');
  md.push(`PERSONAL OS · generated ${toLocalTime(nowTs)} local · produced on this device — nothing was sent anywhere`);
  md.push('');

  md.push('## DONE TODAY');
  md.push('(item is DONE and was touched today)');
  if (doneToday.length) doneToday.forEach(t => md.push(`- [task] ${cleanLine(t.title) || 'Untitled'}`));
  else md.push('- (nothing moved to done today)');
  md.push('');

  md.push('## CREATED TODAY');
  if (createdToday.length) createdToday.forEach(i => md.push(`- [${i.kind}] ${cleanLine(i.title) || 'Untitled'} — ${toLocalTime(i.createdAt)}`));
  else md.push('- (nothing created today)');
  md.push('');

  md.push('## NOTES TOUCHED TODAY');
  if (notesTouched.length) {
    notesTouched.forEach(n => {
      md.push(`- ${cleanLine(n.title) || 'UNTITLED'} — ${countWords(n.body)} words${inToday(n.createdAt) ? ' (new)' : ' (edited)'} · ${toLocalTime(n.updatedAt)}`);
    });
    md.push(`- total: ${wordsToday} words across ${notesTouched.length} note${notesTouched.length === 1 ? '' : 's'}`);
  } else {
    md.push('- (no notes touched today)');
  }
  md.push('');

  md.push('## TAGS IN PLAY TODAY');
  md.push(tagNames.length ? `- ${tagNames.join(' · ')}` : '- (none)');
  md.push('');

  md.push('## REMINDERS — TODAY & NEXT 24H');
  if (upcoming.length) {
    upcoming.forEach(i => {
      const kind = state.notes.includes(i) ? 'note' : 'task';
      const label = cleanLine(i.alarmLabel || '');
      md.push(`- ${toLocalDate(i.alarmAt)} ${toLocalTime(i.alarmAt)} — ${cleanLine(i.title) || 'Untitled'}${label ? ' — ' + label : ''} (${kind})`);
    });
  } else {
    md.push('- (none scheduled)');
  }
  md.push('');

  md.push('## SNAPSHOT');
  md.push(`- Open tasks: ${openTasks.length} (${inProgress.length} in progress) · Notes: ${state.notes.length} · Tags: ${state.tags.length}`);
  md.push(`- Words in today's notes: ${wordsToday}`);
  md.push('');
  md.push('---');
  md.push('Generated locally by PERSONAL OS. No data left this browser.');
  md.push('');
  return md.join('\n');
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

const REPORT_TARGETS = {
  download: {
    deliver: md => { downloadTextFile(`personal-os-report-${toLocalDate(Date.now())}.md`, md, 'text/markdown;charset=utf-8'); return 'Report downloaded.'; },
  },
  clipboard: {
    deliver: async md => {
      const ok = await copyTextToClipboard(md);
      if (!ok) throw new Error('clipboard unavailable');
      return 'Report copied to clipboard.';
    },
  },
};

async function deliverReport(targetId) {
  const target = REPORT_TARGETS[targetId];
  if (!target) return;
  /* Build from a consistent snapshot: the app is synchronous, so a tap can
     never observe a half-written state anyway — but capture `now` once so
     the filename and the header agree. */
  const nowTs = Date.now();
  const md = buildReportMarkdown(nowTs);
  try {
    const message = await target.deliver(md);
    toast(message, { duration: 3000 });
  } catch (e) {
    toast('Could not deliver the report — nothing was sent or changed.', { duration: 5000 });
  }
}

if (els.reportBtn) els.reportBtn.addEventListener('click', () => deliverReport('download'));
if (els.reportCopyBtn) els.reportCopyBtn.addEventListener('click', () => deliverReport('clipboard'));

/* ---------- Readouts ---------------------------------------------------- */

/* Cheap text updates for chrome that lives in panel headers. Kept out of the
   panel renderers so switching views never shows a stale count. */
function renderHeaderCounts() {
  const filtering = Boolean(searchQuery) || activeTagFilter !== 'all';
  const shownNotes = filtering ? state.notes.filter(visible).length : state.notes.length;
  const shownTasks = filtering ? state.tasks.filter(visible).length : state.tasks.length;

  els.notesCount.textContent = filtering ? `${shownNotes}/${state.notes.length}` : String(state.notes.length);
  els.tasksCount.textContent = filtering ? `${shownTasks}/${state.tasks.length}` : String(state.tasks.length);
  els.clearDoneBtn.hidden = !state.tasks.some(t => t.status === 'done');
}

function renderGlobalProgress() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === 'done').length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  els.globalProgress.textContent = `${done}/${total} · ${pct}%`;
  els.globalLight.className = 'light' + (total === 0 ? ' off' : pct === 100 ? ' on' : pct > 0 ? ' accent' : ' off');
}

function renderStats() {
  els.railStats.textContent = `${plural(state.notes.length, 'NOTE')} · ${plural(state.tasks.length, 'TASK')}`;
  if (!els.storageMeta) return;

  if (!storageAvailable) {
    els.storageMeta.textContent = 'BROWSER STORAGE UNAVAILABLE — CHANGES LAST ONLY FOR THIS SESSION';
    return;
  }

  /* Only the ORGANIZE panel shows this, and serialising the whole state to
     measure it costs more than the rest of a repaint combined at scale.
     Skip it entirely while the panel is hidden. */
  if (activeView !== 'organize') return;

  const bytes = new Blob([JSON.stringify(state)]).size;
  els.storageMeta.textContent =
    `LOCAL DATA: ${formatBytes(bytes)} · LAST CHANGE: ${formatDate(state.meta.updatedAt || Date.now())}`;
}

/* ---------- Keyboard shortcuts ----------------------------------------- */

function isTyping(el) {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

document.addEventListener('keydown', e => {
  // Esc always addresses the top-most dialog first.
  if (e.key === 'Escape') {
    const top = topDialog();
    if (top) { e.preventDefault(); requestClose(top.backdrop); return; }
    if (searchQuery) { clearSearch(); return; }
  }

  // Cmd/Ctrl+Enter saves the editor from anywhere inside it.
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && modalContext) {
    e.preventDefault();
    saveFromEditor();
    return;
  }

  if (dialogStack.length || isTyping(document.activeElement)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case '1': setView('notes'); break;
    case '2': setView('tasks'); break;
    case '3': setView('organize'); break;
    case 'n': case 'N': e.preventDefault(); setView('notes'); openNoteModal(null); break;
    case 't': case 'T': e.preventDefault(); setView('tasks'); openTaskModal(null); break;
    case '/': e.preventDefault(); els.searchInput.focus(); els.searchInput.select(); break;
    default: break;
  }
});

// Focus trap: keep Tab inside the front-most dialog.
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const top = topDialog();
  if (!top) return;
  const focusable = Array.from(top.backdrop.querySelectorAll(FOCUSABLE))
    .filter(el => el.offsetParent !== null && !el.hidden);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* Warn before losing an in-progress edit on refresh/close. */
window.addEventListener('beforeunload', e => {
  if (modalContext && editorIsDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* Another tab of the same app changed the data — adopt it instead of
   letting the two tabs silently diverge and overwrite each other. */
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try {
    const incoming = sanitizeState(JSON.parse(e.newValue));
    if ((incoming.meta.updatedAt || 0) <= (state.meta.updatedAt || 0)) return;
    state = incoming;
    notifiedAlarms.clear();
    renderAll();
    toast('Updated from another tab.', { duration: 2500 });
  } catch (err) { /* ignore malformed cross-tab payloads */ }
});

/* ---------- Alarm helper functions (shared by note + task modals) -------- */

function readAlarmFromFields() {
  const dateEl = document.getElementById('field-alarm-date');
  const timeEl = document.getElementById('field-alarm-time');
  if (!dateEl || !timeEl || !dateEl.value || !timeEl.value) return null;
  return new Date(dateEl.value + 'T' + timeEl.value).getTime() || null;
}

function updateAlarmDisplay() {
  const display = document.getElementById('field-alarm-display');
  if (!display) return;
  const alarmAt = readAlarmFromFields();
  display.textContent = alarmAt ? 'ALARM SET: ' + formatDate(alarmAt) : '';
}

/* Permission is requested here — and only here — i.e. from a real gesture at
   the moment the user engages the reminder UI. Never on an unrelated first
   click: the permission would have no context, and browsers penalise exactly
   that. */
function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  try {
    const p = Notification.requestPermission();
    if (p && typeof p.catch === 'function') p.catch(() => { /* user dismissed */ });
  } catch (e) { /* older signature without promise — nothing useful to do */ }
}

function attachQuickSelect() {
  document.querySelectorAll('.alarm-quick .tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const dateEl = document.getElementById('field-alarm-date');
      const timeEl = document.getElementById('field-alarm-time');
      if (!dateEl || !timeEl) return;
      const now = new Date();
      const target = new Date(now);
      switch (chip.dataset.quick) {
        case 'today': {
          // Round up to the next hour, but never fall into tomorrow: a 23:30
          // "TODAY" tap means later today, not 00:00 next day.
          target.setMinutes(0, 0, 0);
          target.setHours(target.getHours() + 1);
          if (target.getDate() !== now.getDate()) {
            target.setTime(new Date(now).setHours(23, 59, 0, 0));
          }
          break;
        }
        case 'tomorrow': target.setDate(target.getDate() + 1); break;
        case 'week': target.setDate(target.getDate() + 7); break;
        case 'month': target.setMonth(target.getMonth() + 1); break;
      }
      if (chip.dataset.quick !== 'today') {
        target.setMinutes(0, 0, 0);
        target.setHours(target.getHours() + 1);
      }
      dateEl.value = toLocalDate(target.getTime());
      timeEl.value = toLocalTime(target.getTime());
      updateAlarmDisplay();
      ensureNotificationPermission();
    });
  });
  const dateEl = document.getElementById('field-alarm-date');
  const timeEl = document.getElementById('field-alarm-time');
  if (dateEl) dateEl.addEventListener('change', () => { updateAlarmDisplay(); ensureNotificationPermission(); });
  if (timeEl) timeEl.addEventListener('change', () => { updateAlarmDisplay(); ensureNotificationPermission(); });
}

/* ---------- Alarm / Reminder + Calendar --------------------------------- */
let alarmInterval = null;
let notifiedAlarms = new Set();

function initAlarmCheck() {
  /* No Notification permission request here. It is requested only when the
     user engages the reminder UI (see ensureNotificationPermission) — asking
     on an unrelated first click teaches people to distrust the app. */
  checkAlarms();
  alarmInterval = setInterval(checkAlarms, 1000);
}

/* Two open tabs share the same 1s ticker; without coordination both would
   ring the same alarm. A synchronous localStorage marker is the simplest
   mutual exclusion available. Entries expire after a day so the key never
   accumulates. */
function claimFiredAlarm(id, at) {
  if (!storageAvailable) return true; // better to double-ring than swallow an alarm
  try {
    const now = Date.now();
    let map = {};
    try { map = JSON.parse(localStorage.getItem(FIRED_ALARMS_KEY)) || {}; } catch (_) { map = {}; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
    Object.keys(map).forEach(k => { if (!Number.isFinite(map[k]) || now - map[k] > 86400000) delete map[k]; });
    const key = id + ':' + at;
    if (map[key]) return false;
    map[key] = now;
    localStorage.setItem(FIRED_ALARMS_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    return true; // storage blocked — fire anyway
  }
}

function checkAlarms() {
  try {
    const now = Date.now();
    const toFire = [...state.notes, ...state.tasks].filter(
      item => item.alarmAt && !notifiedAlarms.has(item.id) && item.alarmAt <= now
    );
    if (toFire.length) {
      const ring = [];
      toFire.forEach(item => {
        notifiedAlarms.add(item.id);
        if (claimFiredAlarm(item.id, item.alarmAt)) ring.push(item);
      });
      ring.forEach(fireAlarm);
      // One commit for the whole batch: stamps updatedAt once, repaints once,
      // and keeps saveState() behind its single caller (commit).
      commit(() => {
        toFire.forEach(item => { item.alarmAt = null; item.alarmLabel = ''; });
      });
    }
    updateAlarmBadges();
    updateAlarmCountdowns();
  } catch (e) { /* guard interval against transient errors */ }
}

function updateAlarmBadges() {
  document.querySelectorAll('.alarm-badge').forEach(el => {
    const card = el.closest('[data-note-id]') || el.closest('[data-task-id]');
    if (!card) return;
    const id = card.dataset.noteId || card.dataset.taskId;
    const item = state.notes.find(n => n.id === id) || state.tasks.find(t => t.id === id);
    if (item && item.alarmAt) el.textContent = timeRemaining(item.alarmAt);
  });
}

function formatCountdown(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'ALARM NOW';
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}D ${h % 24}H LEFT`;
  if (h > 0) return `${h}H ${m % 60}M LEFT`;
  if (m > 0) return `${m}M ${s % 60}S LEFT`;
  return `${s}S LEFT`;
}

function alarmChipHtml(item) {
  const kind = state.notes.includes(item) ? 'note' : 'task';
  const when = toLocalDate(item.alarmAt).slice(5) + ' ' + toLocalTime(item.alarmAt);
  return `
    <div class="alarm-chip" role="group" data-alarm-id="${escapeAttr(item.id)}" data-alarm-kind="${kind}">
      <button type="button" class="alarm-chip-open" title="Open ${kind}">
        <span class="alarm-chip-title">${escapeHtml(item.title || 'UNTITLED')}</span>
        <span class="alarm-chip-when">${escapeHtml(when)}</span>
        <span class="alarm-chip-timer alarm-countdown">${escapeHtml(formatCountdown(item.alarmAt))}</span>
      </button>
      <button type="button" class="alarm-chip-clear" title="Clear alarm" aria-label="Clear alarm">×</button>
    </div>`;
}

function renderAlarmsBar() {
  const withAlarm = [...state.notes, ...state.tasks]
    .filter(i => i.alarmAt)
    .sort((a, b) => a.alarmAt - b.alarmAt);
  if (withAlarm.length === 0) {
    els.alarmsBar.hidden = true;
    els.alarmsBar.innerHTML = '';
    return;
  }
  els.alarmsBar.hidden = false;
  els.alarmsBar.innerHTML =
    '<span class="alarms-bar-label">ALARMS</span>' +
    '<div class="alarms-bar-list">' + withAlarm.map(alarmChipHtml).join('') + '</div>';
}

function updateAlarmCountdowns() {
  document.querySelectorAll('#alarms-bar .alarm-countdown').forEach(el => {
    const chip = el.closest('.alarm-chip');
    if (!chip) return;
    const id = chip.dataset.alarmId;
    const item = state.notes.find(n => n.id === id) || state.tasks.find(t => t.id === id);
    if (item && item.alarmAt) el.textContent = formatCountdown(item.alarmAt);
  });
}

if (els.alarmsBar) {
  els.alarmsBar.addEventListener('click', e => {
    const chip = e.target.closest('.alarm-chip');
    if (!chip) return;
    const id = chip.dataset.alarmId;
    const kind = chip.dataset.alarmKind;
    if (e.target.closest('.alarm-chip-clear')) {
      clearAlarm(id, kind);
      return;
    }
    if (kind === 'note') openNoteModal(id);
    else openTaskModal(id);
  });
}

function clearAlarm(id, kind) {
  const list = kind === 'note' ? state.notes : state.tasks;
  const item = list.find(i => i.id === id);
  if (!item || !item.alarmAt) return;
  commit(() => {
    item.alarmAt = null;
    item.alarmLabel = '';
  }, { message: 'Alarm cleared.', toast: { duration: 2000 } });
}

let originalTitle = document.title;

function restoreAlarmTitle() {
  document.title = originalTitle;
}

function playAlarmSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = [440, 554, 660];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.15);
    });
    // Second cycle after a gap
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + 0.9 + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9 + i * 0.25 + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + 0.9 + i * 0.25);
      osc.stop(ctx.currentTime + 0.9 + i * 0.25 + 0.15);
    });
  } catch (e) { /* web audio not available */ }
}

function fireAlarm(item) {
  const label = item.alarmLabel || item.title || 'Untitled';
  const kind = state.notes.includes(item) ? 'Note' : 'Task';
  playAlarmSound();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
  document.title = 'ALARM: ' + label;
  /* Deliver a real notification only if permission was already granted —
     this path never requests it. Limitation: without a service worker this
     only fires while the app is open. */
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('PERSONAL OS — ALARM', { body: `${label} (${kind})`, tag: 'pos-alarm-' + item.id });
    } catch (e) { /* blocked at OS level — the in-app dialog is the fallback */ }
  }
  const alreadyOpen = els.alarmBackdrop && els.alarmBackdrop.classList.contains('is-active');
  if (els.alarmBackdrop && els.alarmTitle && els.alarmItem && els.alarmLabel && els.alarmKind && els.alarmDismiss) {
    if (!alreadyOpen) {
      els.alarmTitle.textContent = 'ALARM';
      els.alarmItem.textContent = item.title || 'UNTITLED';
      els.alarmLabel.textContent = label;
      els.alarmKind.textContent = kind;
      els.alarmKind.className = 'pill';
      openDialog(els.alarmBackdrop, { focus: els.alarmDismiss, onClose: restoreAlarmTitle });
    }
  }
  toast('ALARM: ' + label + ' — ' + kind, { duration: 10000 });
}

if (els.alarmDismiss) {
  /* No manual title reset here: closeDialog() fires onClose, which restores
     the title — so Esc, backdrop clicks and DISMISS all take one path. */
  els.alarmDismiss.addEventListener('click', () => closeDialog(els.alarmBackdrop));
}

function downloadICS(item) {
  if (!item.alarmAt) return;
  const fmt = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const now = fmt(new Date());
  const start = fmt(new Date(item.alarmAt));
  const end = fmt(new Date(item.alarmAt + 3600000));
  const esc = s => String(s).replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
  const title = esc(item.title || 'Event');
  const desc = esc(item.body || '');
  const label = esc(item.alarmLabel || '');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Personal OS//EN',
    'BEGIN:VEVENT',
    `UID:${item.id || uid()}@personal-os`,
    `DTSTAMP:${now}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${desc}${label ? '\\n' + label : ''}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${label || title}`,
    'TRIGGER:-PT5M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(item.title || 'event').replace(/[^a-z0-9]/gi, '_')}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Calendar file downloaded. Open it to add to your calendar.', { duration: 5000 });
}

/* ---------- Master render ---------------------------------------------- */

/* Full-redraw rendering is intentional: it is simple and the data set is
   personal-scale. It is still wasteful to rebuild panels the user cannot see,
   and worse, doing so moves focus-bearing DOM out from under an open editor.
   Only the active panel is painted; setView() repaints on switch. Chrome that
   is always visible (rail, counters) renders every time. */
const PANEL_RENDERERS = {
  notes: renderNotes,
  tasks: renderTasks,
  organize: renderOrganize,
};

function renderAll() {
  refreshTagIndex();
  renderTagFilterRail();
  PANEL_RENDERERS[activeView]();
  renderHeaderCounts();
  renderGlobalProgress();
  renderStats();
  renderAlarmsBar();
}

renderAll();
initAlarmCheck();

if (!storageAvailable) {
  toast('Browser storage is blocked, so nothing will be saved after you close this tab.', { duration: 9000 });
}

/* ---------- Public hooks for sync.js ------------------------------------ */

window.PersonalOS = {
  getState: () => state,

  /* Called by sync.js when Drive has newer data. Intentionally silent on the
     'pos:save' channel: emitting it here would trigger an immediate push back
     to Drive and loop. */
  setState: (newState) => {
    state = sanitizeState(newState);
    notifiedAlarms.clear();
    persist();
    renderAll();
  },

  renderAll,
  toast,
  confirmAction,
};
