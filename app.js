/* ==========================================================================
   PERSONAL OS — app.js
   Local-first: localStorage is the source of truth for instant reads/writes.
   sync.js (loaded after this file) hooks into saveState() via the 'pos:save'
   event to mirror state to Google Drive's appDataFolder when signed in.
   ========================================================================== */

const STORAGE_KEY = 'personal-os-v1';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      parsed.meta = parsed.meta || { updatedAt: 0 };
      return parsed;
    } catch (e) { /* fall through to default */ }
  }
  return { notes: [], tasks: [], tags: [], meta: { updatedAt: 0 } };
}

function saveState(skipEvent) {
  state.meta = state.meta || {};
  state.meta.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!skipEvent) window.dispatchEvent(new CustomEvent('pos:save', { detail: state }));
}

let state = loadState();
let activeView = 'notes';
let activeTagFilter = 'all';
let modalContext = null; // { type: 'note'|'task', id: string|null }

// ---------- DOM refs ----------

const els = {
  viewBtns: document.querySelectorAll('.view-btn'),
  viewPanels: document.querySelectorAll('.view-panel'),
  tagFilterList: document.getElementById('tag-filter-list'),
  notesList: document.getElementById('notes-list'),
  newNoteBtn: document.getElementById('new-note-btn'),
  newTaskBtn: document.getElementById('new-task-btn'),
  newTagInput: document.getElementById('new-tag-input'),
  newTagBtn: document.getElementById('new-tag-btn'),
  organizeList: document.getElementById('organize-list'),
  globalProgress: document.getElementById('global-progress'),
  globalLight: document.getElementById('global-light'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalSave: document.getElementById('modal-save'),
  modalDelete: document.getElementById('modal-delete'),
  modalClose: document.getElementById('modal-close'),
};

const STATUS_ORDER = ['not_started', 'in_progress', 'done'];
const STATUS_LABEL = { not_started: 'NOT STARTED', in_progress: 'IN PROGRESS', done: 'DONE' };

// ---------- View switching ----------

els.viewBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    activeView = btn.dataset.view;
    els.viewBtns.forEach(b => b.classList.toggle('is-active', b === btn));
    els.viewPanels.forEach(p => p.classList.toggle('is-active', p.id === `view-${activeView}`));
    renderAll();
  });
});

// ---------- Tag filter rail ----------

function renderTagFilterRail() {
  els.tagFilterList.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'tag-chip' + (activeTagFilter === 'all' ? ' is-active' : '');
  allBtn.textContent = 'ALL';
  allBtn.dataset.tag = 'all';
  allBtn.addEventListener('click', () => { activeTagFilter = 'all'; renderAll(); });
  els.tagFilterList.appendChild(allBtn);

  state.tags.forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-chip' + (activeTagFilter === tag.id ? ' is-active' : '');
    btn.textContent = tag.name.toUpperCase();
    btn.addEventListener('click', () => { activeTagFilter = tag.id; renderAll(); });
    els.tagFilterList.appendChild(btn);
  });
}

function itemMatchesFilter(item) {
  if (activeTagFilter === 'all') return true;
  return (item.tagIds || []).includes(activeTagFilter);
}

// ---------- Notes ----------

function renderNotes() {
  const filtered = state.notes.filter(itemMatchesFilter);
  els.notesList.innerHTML = '';
  if (filtered.length === 0) {
    els.notesList.innerHTML = '<div class="empty-state">NO NOTES — CREATE ONE TO BEGIN</div>';
    return;
  }
  filtered
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach(note => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-title">${escapeHtml(note.title || 'UNTITLED')}</div>
        <div class="card-body">${escapeHtml(note.body || '')}</div>
        <div class="card-tags">${renderTagPills(note.tagIds)}</div>
        <div class="card-meta">${formatDate(note.updatedAt)}</div>
      `;
      card.addEventListener('click', () => openNoteModal(note.id));
      els.notesList.appendChild(card);
    });
}

function openNoteModal(id) {
  const note = id ? state.notes.find(n => n.id === id) : null;
  modalContext = { type: 'note', id };
  els.modalTitle.textContent = id ? 'EDIT NOTE' : 'NEW NOTE';
  els.modalDelete.style.display = id ? 'inline-block' : 'none';
  els.modalBody.innerHTML = `
    <div>
      <label>TITLE</label>
      <input type="text" id="field-title" value="${escapeAttr(note?.title || '')}" placeholder="Note title">
    </div>
    <div>
      <label>BODY</label>
      <textarea id="field-body" placeholder="Write here...">${escapeHtml(note?.body || '')}</textarea>
    </div>
    <div>
      <label>TAGS</label>
      <div class="tag-picker" id="field-tags">${renderTagPicker(note?.tagIds || [])}</div>
    </div>
  `;
  attachTagPickerHandlers();
  showModal();
}

// ---------- Tasks ----------

function renderTasks() {
  STATUS_ORDER.forEach(status => {
    const col = document.getElementById(`col-${status}`);
    col.innerHTML = '';
    const items = state.tasks.filter(t => t.status === status && itemMatchesFilter(t));
    document.getElementById(`count-${status}`).textContent = items.length;
    if (items.length === 0) {
      col.innerHTML = '<div class="empty-state">—</div>';
      return;
    }
    items
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach(task => {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.innerHTML = `
          <div>${escapeHtml(task.title || 'UNTITLED')}</div>
          <div class="card-tags">${renderTagPills(task.tagIds)}</div>
          <div class="status-select">
            ${STATUS_ORDER.map(s => `<div class="status-dot${s === task.status ? ' is-current' : ''}" data-status="${s}" data-task="${task.id}" title="${STATUS_LABEL[s]}"></div>`).join('')}
          </div>
        `;
        card.querySelectorAll('.status-dot').forEach(dot => {
          dot.addEventListener('click', (e) => {
            e.stopPropagation();
            setTaskStatus(task.id, dot.dataset.status);
          });
        });
        card.addEventListener('click', () => openTaskModal(task.id));
        col.appendChild(card);
      });
  });
}

function setTaskStatus(id, status) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  task.status = status;
  task.updatedAt = Date.now();
  saveState();
  renderAll();
}

function openTaskModal(id) {
  const task = id ? state.tasks.find(t => t.id === id) : null;
  modalContext = { type: 'task', id };
  els.modalTitle.textContent = id ? 'EDIT TASK' : 'NEW TASK';
  els.modalDelete.style.display = id ? 'inline-block' : 'none';
  const currentStatus = task?.status || 'not_started';
  els.modalBody.innerHTML = `
    <div>
      <label>TITLE</label>
      <input type="text" id="field-title" value="${escapeAttr(task?.title || '')}" placeholder="Task title">
    </div>
    <div>
      <label>NOTES</label>
      <textarea id="field-body" placeholder="Optional details...">${escapeHtml(task?.body || '')}</textarea>
    </div>
    <div>
      <label>STATUS</label>
      <div class="status-select" id="field-status">
        ${STATUS_ORDER.map(s => `<div class="status-dot${s === currentStatus ? ' is-current' : ''}" data-status="${s}" title="${STATUS_LABEL[s]}"></div>`).join('')}
      </div>
    </div>
    <div>
      <label>TAGS</label>
      <div class="tag-picker" id="field-tags">${renderTagPicker(task?.tagIds || [])}</div>
    </div>
  `;
  let selectedStatus = currentStatus;
  document.querySelectorAll('#field-status .status-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      selectedStatus = dot.dataset.status;
      document.querySelectorAll('#field-status .status-dot').forEach(d => d.classList.toggle('is-current', d === dot));
    });
  });
  els.modalBody.dataset.selectedStatus = selectedStatus;
  els.modalBody._getStatus = () => selectedStatus;
  attachTagPickerHandlers();
  showModal();
}

// ---------- Tag picker (shared, notes + tasks) ----------

function renderTagPicker(selectedIds) {
  if (state.tags.length === 0) {
    return '<span class="card-meta">No tags yet — add one in ORGANIZE</span>';
  }
  return state.tags.map(tag => `
    <button type="button" class="tag-chip${selectedIds.includes(tag.id) ? ' is-active' : ''}" data-tag-id="${tag.id}">${escapeHtml(tag.name.toUpperCase())}</button>
  `).join('');
}

function attachTagPickerHandlers() {
  const container = document.getElementById('field-tags');
  if (!container) return;
  container.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('is-active'));
  });
}

function getSelectedTagIds() {
  const container = document.getElementById('field-tags');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.tag-chip.is-active')).map(c => c.dataset.tagId);
}

function renderTagPills(tagIds) {
  if (!tagIds || tagIds.length === 0) return '';
  return tagIds
    .map(id => state.tags.find(t => t.id === id))
    .filter(Boolean)
    .map(t => `<span class="pill">${escapeHtml(t.name.toUpperCase())}</span>`)
    .join('');
}

// ---------- Organize (tags CRUD) ----------

function renderOrganize() {
  els.organizeList.innerHTML = '';
  if (state.tags.length === 0) {
    els.organizeList.innerHTML = '<div class="empty-state">NO TAGS YET — ADD ONE ABOVE</div>';
    return;
  }
  state.tags.forEach(tag => {
    const noteCount = state.notes.filter(n => (n.tagIds || []).includes(tag.id)).length;
    const taskCount = state.tasks.filter(t => (t.tagIds || []).includes(tag.id)).length;
    const row = document.createElement('div');
    row.className = 'organize-row';
    row.innerHTML = `
      <span class="tag-name">${escapeHtml(tag.name.toUpperCase())}</span>
      <span class="tag-stats">${noteCount} NOTES · ${taskCount} TASKS</span>
      <span class="tag-actions"><button data-id="${tag.id}">DELETE</button></span>
    `;
    row.querySelector('button').addEventListener('click', () => deleteTag(tag.id));
    els.organizeList.appendChild(row);
  });
}

function deleteTag(id) {
  if (!confirm('Delete this tag? It will be removed from all notes and tasks.')) return;
  state.tags = state.tags.filter(t => t.id !== id);
  state.notes.forEach(n => { n.tagIds = (n.tagIds || []).filter(tid => tid !== id); });
  state.tasks.forEach(t => { t.tagIds = (t.tagIds || []).filter(tid => tid !== id); });
  if (activeTagFilter === id) activeTagFilter = 'all';
  saveState();
  renderAll();
}

els.newTagBtn.addEventListener('click', () => {
  const name = els.newTagInput.value.trim();
  if (!name) return;
  state.tags.push({ id: uid(), name });
  els.newTagInput.value = '';
  saveState();
  renderAll();
});

els.newTagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.newTagBtn.click();
});

// ---------- Modal lifecycle ----------

function showModal() {
  els.modalBackdrop.classList.add('is-active');
}

function hideModal() {
  els.modalBackdrop.classList.remove('is-active');
  modalContext = null;
}

els.modalClose.addEventListener('click', hideModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) hideModal();
});

els.modalSave.addEventListener('click', () => {
  if (!modalContext) return;
  const title = document.getElementById('field-title').value.trim();
  const body = document.getElementById('field-body').value;
  const tagIds = getSelectedTagIds();
  const now = Date.now();

  if (modalContext.type === 'note') {
    if (modalContext.id) {
      const note = state.notes.find(n => n.id === modalContext.id);
      note.title = title; note.body = body; note.tagIds = tagIds; note.updatedAt = now;
    } else {
      state.notes.push({ id: uid(), title, body, tagIds, createdAt: now, updatedAt: now });
    }
  } else if (modalContext.type === 'task') {
    const status = els.modalBody._getStatus ? els.modalBody._getStatus() : 'not_started';
    if (modalContext.id) {
      const task = state.tasks.find(t => t.id === modalContext.id);
      task.title = title; task.body = body; task.tagIds = tagIds; task.status = status; task.updatedAt = now;
    } else {
      state.tasks.push({ id: uid(), title, body, tagIds, status, createdAt: now, updatedAt: now });
    }
  }
  saveState();
  hideModal();
  renderAll();
});

els.modalDelete.addEventListener('click', () => {
  if (!modalContext || !modalContext.id) return;
  if (!confirm('Delete this item permanently?')) return;
  if (modalContext.type === 'note') {
    state.notes = state.notes.filter(n => n.id !== modalContext.id);
  } else {
    state.tasks = state.tasks.filter(t => t.id !== modalContext.id);
  }
  saveState();
  hideModal();
  renderAll();
});

els.newNoteBtn.addEventListener('click', () => openNoteModal(null));
els.newTaskBtn.addEventListener('click', () => openTaskModal(null));

// ---------- Global progress readout ----------

function renderGlobalProgress() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === 'done').length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  els.globalProgress.textContent = `${done}/${total} · ${pct}%`;
  els.globalLight.className = 'light' + (total === 0 ? '' : pct === 100 ? ' on' : pct > 0 ? ' accent' : ' off');
}

// ---------- Helpers ----------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// ---------- Master render ----------

function renderAll() {
  renderTagFilterRail();
  renderNotes();
  renderTasks();
  renderOrganize();
  renderGlobalProgress();
}

renderAll();

// ---------- Public hooks for sync.js ----------

window.PersonalOS = {
  getState: () => state,
  setState: (newState) => {
    newState.notes = newState.notes || [];
    newState.tasks = newState.tasks || [];
    newState.tags = newState.tags || [];
    newState.meta = newState.meta || { updatedAt: 0 };
    state = newState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();
  },
  renderAll,
};
