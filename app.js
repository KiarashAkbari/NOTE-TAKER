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
   ========================================================================== */

const STORAGE_KEY = 'personal-os-v1';
const THEME_KEY = 'pos-theme';
const SCHEMA_VERSION = 2;

const STATUS_ORDER = ['not_started', 'in_progress', 'done'];
const STATUS_LABEL = { not_started: 'NOT STARTED', in_progress: 'IN PROGRESS', done: 'DONE' };
const VIEWS = ['notes', 'tasks', 'organize'];
const TAG_MAX = 24;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- State: load, sanitize, save ---------------------------------- */

/* Anything read from localStorage or Google Drive is untrusted: it may come
   from an older schema, a hand-edited backup, or a half-written write. Coerce
   it into shape rather than letting NaN/undefined leak into sorting + render. */

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
  return item;
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

  return { version: SCHEMA_VERSION, notes, tasks, tags, meta: { updatedAt } };
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
   east/west of GMT late in the day. */
function formatDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - ts;
  const min = 60000, hour = 3600000, day = 86400000;
  if (diff >= 0 && diff < min) return 'JUST NOW';
  if (diff >= 0 && diff < hour) return `${Math.floor(diff / min)}M AGO`;
  if (diff >= 0 && diff < day) return `${Math.floor(diff / hour)}H AGO`;
  if (diff >= 0 && diff < 7 * day) return `${Math.floor(diff / day)}D AGO`;
  const pad = n => String(n).padStart(2, '0');
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

  // Cap the stack so a burst of changes can't cover the UI, but never drop an
  // undo the user might still want: plain messages are evicted first.
  while (els.toastStack.children.length > 3) {
    const victim = els.toastStack.querySelector('.toast:not([data-has-action])')
      || els.toastStack.firstElementChild;
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
  const entry = {
    backdrop,
    restore: document.activeElement,
    onClose: opts.onClose || null,
  };
  dialogStack.push(entry);
  backdrop.classList.add('is-active');
  const target = opts.focus || backdrop.querySelector(FOCUSABLE);
  if (target) target.focus();
}

function closeDialog(backdrop) {
  const idx = dialogStack.findIndex(d => d.backdrop === backdrop);
  if (idx === -1) return;
  const [entry] = dialogStack.splice(idx, 1);
  backdrop.classList.remove('is-active');
  if (entry.onClose) entry.onClose();
  if (entry.restore && document.contains(entry.restore)) entry.restore.focus();
}

function topDialog() {
  return dialogStack.length ? dialogStack[dialogStack.length - 1] : null;
}

// Click on the backdrop itself (never a child) dismisses.
[els.modalBackdrop, els.confirmBackdrop, els.helpBackdrop].forEach(backdrop => {
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
   themed, keyboard-accessible dialog that can explain the consequences. */
function confirmAction({ title = 'CONFIRM', message, detail = [], okLabel = 'DELETE', danger = true }) {
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
      onClose: () => { if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(false); } },
    });
  });
}

function resolveConfirm(value) {
  const resolver = confirmResolver;
  confirmResolver = null;
  closeDialog(els.confirmBackdrop);
  if (resolver) resolver(value);
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
    const tag = state.tags.find(t => t.id === id);
    return tag && tag.name.toLowerCase().includes(q);
  });
}

function visible(item) {
  return matchesTag(item) && matchesSearch(item);
}

/* Highlight runs on already-escaped text, and the needle is escaped the same
   way, so markup can never be injected through the search box. */
function highlight(text) {
  const escaped = escapeHtml(text);
  if (!searchQuery) return escaped;
  const needle = escapeHtml(searchQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!needle) return escaped;
  return escaped.replace(new RegExp(needle, 'gi'), m => `<mark>${m}</mark>`);
}

function truncate(str, max) {
  const clean = str.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

/* ---------- Tag filter rail -------------------------------------------- */

function countFor(tagId) {
  const hit = item => tagId === 'untagged'
    ? (item.tagIds || []).length === 0
    : (item.tagIds || []).includes(tagId);
  return state.notes.filter(hit).length + state.tasks.filter(hit).length;
}

function renderTagFilterRail() {
  els.tagFilterList.innerHTML = '';

  const addChip = (id, label, count) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip' + (activeTagFilter === id ? ' is-active' : '');
    btn.setAttribute('aria-pressed', String(activeTagFilter === id));
    btn.innerHTML = `<span>${escapeHtml(label)}</span><span class="chip-count mono">${count}</span>`;
    btn.addEventListener('click', () => {
      // Clicking the active filter clears it — fewer clicks to get back to ALL.
      activeTagFilter = activeTagFilter === id ? 'all' : id;
      renderAll();
    });
    els.tagFilterList.appendChild(btn);
  };

  const total = state.notes.length + state.tasks.length;
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'tag-chip' + (activeTagFilter === 'all' ? ' is-active' : '');
  allBtn.setAttribute('aria-pressed', String(activeTagFilter === 'all'));
  allBtn.innerHTML = `<span>ALL</span><span class="chip-count mono">${total}</span>`;
  allBtn.addEventListener('click', () => { activeTagFilter = 'all'; renderAll(); });
  els.tagFilterList.appendChild(allBtn);

  state.tags.forEach(tag => addChip(tag.id, tag.name.toUpperCase(), countFor(tag.id)));

  const untagged = countFor('untagged');
  if (untagged > 0 && state.tags.length > 0) addChip('untagged', 'UNTAGGED', untagged);
}

/* ---------- Notes ------------------------------------------------------- */

function renderNotes() {
  const filtered = state.notes.filter(visible);
  els.notesList.innerHTML = '';
  els.notesCount.textContent = searchQuery || activeTagFilter !== 'all'
    ? `${filtered.length}/${state.notes.length}`
    : String(state.notes.length);

  if (filtered.length === 0) {
    els.notesList.innerHTML = state.notes.length === 0
      ? '<div class="empty-state">NO NOTES YET<span class="empty-hint">PRESS N OR HIT + NEW NOTE</span></div>'
      : '<div class="empty-state">NOTHING MATCHES THIS FILTER<span class="empty-hint">CLEAR THE SEARCH OR TAG FILTER</span></div>';
    return;
  }

  filtered
    .slice()
    // Pinned first, then most recently touched.
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.updatedAt - a.updatedAt)
    .forEach(note => {
      // role=button rather than <button>: a real button may only contain
      // phrasing content, and these cards contain block-level rows.
      const card = document.createElement('div');
      card.className = 'card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Edit note: ${note.title || 'untitled'}`);
      card.innerHTML = `
        <div class="card-title">${note.pinned ? '<span aria-hidden="true">★ </span>' : ''}${highlight(note.title || 'UNTITLED')}</div>
        <div class="card-body">${highlight(truncate(note.body || '', 260))}</div>
        <div class="card-tags">${renderTagPills(note.tagIds)}</div>
        <div class="card-meta">${escapeHtml(formatDate(note.updatedAt))}</div>
      `;
      card.addEventListener('click', () => openNoteModal(note.id));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openNoteModal(note.id);
        }
      });
      els.notesList.appendChild(card);
    });
}

/* ---------- Tasks ------------------------------------------------------- */

function renderTasks() {
  const shown = state.tasks.filter(visible);
  els.tasksCount.textContent = searchQuery || activeTagFilter !== 'all'
    ? `${shown.length}/${state.tasks.length}`
    : String(state.tasks.length);
  els.clearDoneBtn.hidden = state.tasks.filter(t => t.status === 'done').length === 0;

  STATUS_ORDER.forEach(status => {
    const col = document.getElementById(`col-${status}`);
    col.innerHTML = '';
    const items = shown.filter(t => t.status === status);
    document.getElementById(`count-${status}`).textContent = items.length;

    if (items.length === 0) {
      col.innerHTML = '<div class="empty-state">—</div>';
      return;
    }

    items
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach(task => {
        // A div (not a button) because it contains its own status buttons.
        const card = document.createElement('div');
        card.className = 'task-card' + (task.status === 'done' ? ' is-done' : '');
        card.tabIndex = 0;
        card.draggable = true;
        card.dataset.taskId = task.id;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `${task.title || 'Untitled'} — ${STATUS_LABEL[task.status]}. Enter to edit, Space to advance status.`);
        card.innerHTML = `
          <div class="task-title">${highlight(task.title || 'UNTITLED')}</div>
          ${task.body ? `<div class="card-meta">${highlight(truncate(task.body, 90))}</div>` : ''}
          <div class="task-card-foot">
            <div class="card-tags">${renderTagPills(task.tagIds)}</div>
            <div class="status-select">
              ${STATUS_ORDER.map(s => `<button type="button" class="status-dot${s === task.status ? ' is-current' : ''}" data-status="${s}" title="Move to ${STATUS_LABEL[s]}" aria-label="Move to ${STATUS_LABEL[s]}"></button>`).join('')}
            </div>
          </div>
        `;

        card.querySelectorAll('.status-dot').forEach(dot => {
          dot.addEventListener('click', e => {
            e.stopPropagation();
            setTaskStatus(task.id, dot.dataset.status);
          });
        });

        card.addEventListener('click', () => openTaskModal(task.id));
        card.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); openTaskModal(task.id); }
          if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            const next = STATUS_ORDER[(STATUS_ORDER.indexOf(task.status) + 1) % STATUS_ORDER.length];
            setTaskStatus(task.id, next, { keepFocus: task.id });
          }
        });

        card.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', task.id);
          e.dataTransfer.effectAllowed = 'move';
          card.classList.add('is-dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('is-dragging'));

        col.appendChild(card);
      });
  });
}

document.querySelectorAll('[data-drop-status]').forEach(zone => {
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('is-drop-target');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-drop-target'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('is-drop-target');
    const id = e.dataTransfer.getData('text/plain');
    if (id) setTaskStatus(id, zone.dataset.dropStatus);
  });
});

function setTaskStatus(id, status, opts = {}) {
  const task = state.tasks.find(t => t.id === id);
  if (!task || !STATUS_ORDER.includes(status) || task.status === status) return;
  task.status = status;
  task.updatedAt = Date.now();
  saveState();
  renderAll();
  if (opts.keepFocus) {
    const again = document.querySelector(`.task-card[data-task-id="${opts.keepFocus}"]`);
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
  const snapshot = done.map(t => ({ item: t, index: state.tasks.indexOf(t) }));
  state.tasks = state.tasks.filter(t => t.status !== 'done');
  saveState();
  renderAll();
  toast(`Deleted ${plural(done.length, 'task').toLowerCase()}.`, {
    actionLabel: 'UNDO',
    duration: 8000,
    onAction: () => {
      snapshot.sort((a, b) => a.index - b.index).forEach(({ item, index }) => {
        state.tasks.splice(Math.min(index, state.tasks.length), 0, item);
      });
      saveState();
      renderAll();
      toast('Restored.', { duration: 2000 });
    },
  });
});

/* ---------- Tag pills / picker (shared by notes + tasks) ---------------- */

function renderTagPills(tagIds) {
  if (!tagIds || tagIds.length === 0) return '';
  return tagIds
    .map(id => state.tags.find(t => t.id === id))
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
    ${note ? `<div class="field-meta">CREATED ${escapeHtml(formatDate(note.createdAt))} · UPDATED ${escapeHtml(formatDate(note.updatedAt))}</div>` : ''}
  `;

  const pinBtn = document.getElementById('field-pin');
  pinBtn.addEventListener('click', () => {
    modalContext.pinned = pinBtn.classList.toggle('is-active');
    pinBtn.setAttribute('aria-pressed', String(modalContext.pinned));
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
  if (!title || !body || !modalContext) return '';
  return JSON.stringify([
    title.value,
    body.value,
    getSelectedTagIds().slice().sort(),
    modalContext.status || '',
    modalContext.pinned || false,
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

  if (modalContext.type === 'note') {
    if (isNew) {
      state.notes.push({ id: uid(), title, body, tagIds, pinned: modalContext.pinned === true, createdAt: now, updatedAt: now });
    } else {
      const note = state.notes.find(n => n.id === modalContext.id);
      if (!note) { closeDialog(els.modalBackdrop); return; }
      Object.assign(note, { title, body, tagIds, pinned: modalContext.pinned === true, updatedAt: now });
    }
  } else {
    const status = STATUS_ORDER.includes(modalContext.status) ? modalContext.status : 'not_started';
    if (isNew) {
      state.tasks.push({ id: uid(), title, body, tagIds, status, createdAt: now, updatedAt: now });
    } else {
      const task = state.tasks.find(t => t.id === modalContext.id);
      if (!task) { closeDialog(els.modalBackdrop); return; }
      Object.assign(task, { title, body, tagIds, status, updatedAt: now });
    }
  }

  const kind = modalContext.type === 'note' ? 'Note' : 'Task';
  snapshotEditor(); // prevents the dirty prompt on the way out
  saveState();
  closeDialog(els.modalBackdrop);
  renderAll();
  toast(`${kind} ${isNew ? 'created' : 'saved'}.`, { duration: 2500 });
}

els.modalDelete.addEventListener('click', async () => {
  if (!modalContext || !modalContext.id) return;
  const { type, id } = modalContext;
  const list = type === 'note' ? state.notes : state.tasks;
  const index = list.findIndex(i => i.id === id);
  if (index === -1) return;
  const item = list[index];

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

  list.splice(index, 1);
  snapshotEditor();
  saveState();
  closeDialog(els.modalBackdrop);
  renderAll();

  toast(`${type === 'note' ? 'Note' : 'Task'} deleted.`, {
    actionLabel: 'UNDO',
    duration: 8000,
    onAction: () => {
      const target = type === 'note' ? state.notes : state.tasks;
      target.splice(Math.min(index, target.length), 0, item);
      saveState();
      renderAll();
      toast('Restored.', { duration: 2000 });
    },
  });
});

els.newNoteBtn.addEventListener('click', () => openNoteModal(null));
els.newTaskBtn.addEventListener('click', () => openTaskModal(null));

/* ---------- Organize: tag CRUD ----------------------------------------- */

function renderOrganize() {
  els.organizeList.innerHTML = '';
  if (state.tags.length === 0) {
    els.organizeList.innerHTML = '<div class="empty-state">NO TAGS YET<span class="empty-hint">TAGS GROUP NOTES AND TASKS TOGETHER</span></div>';
    return;
  }

  state.tags.forEach(tag => {
    const noteCount = state.notes.filter(n => n.tagIds.includes(tag.id)).length;
    const taskCount = state.tasks.filter(t => t.tagIds.includes(tag.id)).length;
    const row = document.createElement('div');
    row.className = 'organize-row';
    row.innerHTML = `
      <span class="tag-name" contenteditable="true" spellcheck="false" role="textbox"
            aria-label="Rename tag ${escapeAttr(tag.name)}">${escapeHtml(tag.name.toUpperCase())}</span>
      <span class="tag-stats">${noteCount} NOTES · ${taskCount} TASKS</span>
      <span class="tag-actions"><button type="button">DELETE</button></span>
    `;

    // Inline rename: commit on blur or Enter, revert on Escape.
    const nameEl = row.querySelector('.tag-name');
    const commit = () => {
      const next = nameEl.textContent.trim().slice(0, TAG_MAX);
      if (!next || next.toUpperCase() === tag.name.toUpperCase()) {
        nameEl.textContent = tag.name.toUpperCase();
        return;
      }
      if (state.tags.some(t => t.id !== tag.id && t.name.toLowerCase() === next.toLowerCase())) {
        toast(`A tag named "${next}" already exists.`);
        nameEl.textContent = tag.name.toUpperCase();
        return;
      }
      tag.name = next;
      saveState();
      renderAll();
      toast('Tag renamed.', { duration: 2000 });
    };
    nameEl.addEventListener('blur', commit);
    nameEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = tag.name.toUpperCase(); nameEl.blur(); }
    });

    row.querySelector('button').addEventListener('click', () => deleteTag(tag.id));
    els.organizeList.appendChild(row);
  });
}

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
  const affectedNotes = state.notes.filter(n => n.tagIds.includes(id)).map(n => n.id);
  const affectedTasks = state.tasks.filter(t => t.tagIds.includes(id)).map(t => t.id);

  state.tags.splice(index, 1);
  state.notes.forEach(n => { n.tagIds = n.tagIds.filter(t => t !== id); });
  state.tasks.forEach(t => { t.tagIds = t.tagIds.filter(x => x !== id); });
  if (activeTagFilter === id) activeTagFilter = 'all';
  saveState();
  renderAll();

  toast(`Tag "${tag.name}" deleted.`, {
    actionLabel: 'UNDO',
    duration: 8000,
    onAction: () => {
      state.tags.splice(Math.min(index, state.tags.length), 0, tag);
      affectedNotes.forEach(nid => {
        const n = state.notes.find(x => x.id === nid);
        if (n && !n.tagIds.includes(id)) n.tagIds.push(id);
      });
      affectedTasks.forEach(tid => {
        const t = state.tasks.find(x => x.id === tid);
        if (t && !t.tagIds.includes(id)) t.tagIds.push(id);
      });
      saveState();
      renderAll();
      toast('Restored.', { duration: 2000 });
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
  state.tags.push({ id: uid(), name });
  els.newTagInput.value = '';
  saveState();
  renderAll();
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
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `personal-os-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  const previous = JSON.parse(JSON.stringify(state));
  state = incoming;
  activeTagFilter = 'all';
  saveState();
  renderAll();

  toast('Backup imported.', {
    actionLabel: 'UNDO',
    duration: 9000,
    onAction: () => {
      state = sanitizeState(previous);
      saveState();
      renderAll();
      toast('Reverted to your previous data.', { duration: 3000 });
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
  state = sanitizeState(null);
  activeTagFilter = 'all';
  clearSearch();
  saveState();
  renderAll();

  toast('All data deleted.', {
    actionLabel: 'UNDO',
    duration: 10000,
    onAction: () => {
      state = sanitizeState(previous);
      saveState();
      renderAll();
      toast('Everything restored.', { duration: 3000 });
    },
  });
});

/* ---------- Readouts ---------------------------------------------------- */

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
  const bytes = new Blob([JSON.stringify(state)]).size;
  els.storageMeta.textContent = storageAvailable
    ? `LOCAL DATA: ${formatBytes(bytes)} · LAST CHANGE: ${formatDate(state.meta.updatedAt || Date.now())}`
    : 'BROWSER STORAGE UNAVAILABLE — CHANGES LAST ONLY FOR THIS SESSION';
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
    renderAll();
    toast('Updated from another tab.', { duration: 2500 });
  } catch (err) { /* ignore malformed cross-tab payloads */ }
});

/* ---------- Master render ---------------------------------------------- */

function renderAll() {
  renderTagFilterRail();
  renderNotes();
  renderTasks();
  renderOrganize();
  renderGlobalProgress();
  renderStats();
}

renderAll();

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
    persist();
    renderAll();
  },

  renderAll,
  toast,
  confirmAction,
};
