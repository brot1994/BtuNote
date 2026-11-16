import { db } from './db.js';
import { auth } from './auth.js';
import { graph } from './graph.js';
import { sync, tombstone, fetchBlob } from './sync.js';
import { importEnex, exportEnex } from './enex.js';
import { icon } from './icons.js';
import { COLORS, newNote, uid, isEmpty, storeImageFile, storeBytes } from './model.js';
import { VERSION, TRASH_DAYS } from './config.js';

// ======================= util =======================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const native = window.BtuNative || null;
const LSK = 'btunote.';
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(LSK + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem(LSK + k, JSON.stringify(v)),
};
function autosize(el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
function fmtSize(b) { return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }
function fmtStamp(t) {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Kemarin ${time}`;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// ======================= state =======================
const state = {
  notes: new Map(),
  sec: 'notes', // notes | archive | trash | label
  label: null,
  q: '',
  layout: ls.get('layout', 'grid'),
  theme: ls.get('theme', 'system'),
  selected: new Set(),
  extraLabels: ls.get('labels', []),
};

async function loadNotes() {
  const all = await db.allNotes();
  state.notes = new Map(all.filter((n) => !n.deleted).map((n) => [n.id, n]));
}

function allLabels() {
  const s = new Set(state.extraLabels);
  for (const n of state.notes.values()) n.labels.forEach((l) => s.add(l));
  return [...s].sort((a, b) => a.localeCompare(b, 'id'));
}

function matches(n, q) {
  if (!q) return true;
  const hay = [n.title, n.text, ...n.items.map((i) => i.text), ...n.labels, ...n.files.map((f) => f.title)].join('\n').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function visibleNotes() {
  const list = [];
  for (const n of state.notes.values()) {
    if (state.sec === 'trash') { if (!n.trashed) continue; }
    else if (n.trashed) continue;
    else if (state.sec === 'archive') { if (!n.archived) continue; }
    else if (state.sec === 'label') { if (!n.labels.includes(state.label)) continue; }
    else if (n.archived) continue;
    if (!matches(n, state.q)) continue;
    list.push(n);
  }
  return list.sort((a, b) => b.updated - a.updated);
}

// ======================= blobs → URL =======================
const urls = new Map();
async function blobUrl(name) {
  if (urls.has(name)) return urls.get(name);
  const b = await db.getBlob(name);
  if (!b) return '';
  const u = URL.createObjectURL(b.blob);
  urls.set(name, u);
  return u;
}
function hydrate(root) {
  for (const img of $$('img[data-blob]', root)) {
    const name = img.dataset.blob;
    blobUrl(name).then((u) => {
      if (u) { img.src = u; img.removeAttribute('data-blob'); img.classList.remove('wait'); return; }
      img.classList.add('wait'); // belum ada di HP ini: unduh dari OneDrive sekarang
      fetchBlob(name);
    });
  }
}

// ======================= penyimpanan =======================
async function updateNotes(ids, fn, { touch = true } = {}) {
  const out = [];
  for (const id of ids) {
    const n = await db.getNote(id);
    if (!n || n.deleted) continue;
    fn(n);
    if (touch) n.updated = Date.now();
    n.dirty = true;
    await db.putNote(n);
    state.notes.set(n.id, n);
    out.push(n);
  }
  render();
  sync.soon();
  return out;
}

async function deleteForever(ids) {
  for (const id of ids) {
    const n = await db.getNote(id);
    if (!n) continue;
    await db.putNote(tombstone(n));
    state.notes.delete(id);
  }
  render();
  sync.soon();
}

// ======================= tema & layout =======================
function applyTheme() {
  const dark = state.theme === 'dark' || (state.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  $('#themeColor').content = dark ? '#202124' : '#ffffff';
  if (native && native.setDark) native.setDark(dark ? 'true' : 'false');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ======================= overlay & tombol back =======================
const overlays = [];
let armed = false;       // ada 1 entri history "overlay terbuka"
let backPending = false; // history.back() sedang berjalan
function arm() {
  if (armed || backPending || !overlays.length) return;
  history.pushState({ o: 1 }, '');
  armed = true;
}
function pushOverlay(close) { overlays.push(close); arm(); }
function popOverlay(close) {
  const i = overlays.lastIndexOf(close);
  if (i < 0) return;
  overlays.splice(i, 1);
  if (!overlays.length && armed) { armed = false; backPending = true; history.back(); }
}
window.addEventListener('popstate', () => {
  if (backPending) { backPending = false; arm(); return; }
  armed = false;
  const close = overlays.pop();
  if (close) close(true);
  arm();
});

// ======================= snackbar / popover / dialog =======================
let snackT = null;
function snack(msg, action, fn, ms = 5000) {
  const s = $('#snackbar');
  s.innerHTML = `<span class="sx">${esc(msg)}</span>${action ? `<button class="btn">${esc(action)}</button>` : ''}`;
  s.hidden = false;
  if (action) $('button', s).onclick = () => { s.hidden = true; fn(); };
  clearTimeout(snackT);
  snackT = setTimeout(() => { s.hidden = true; }, ms);
}

let popClose = null;
function popover(anchor, html, bind) {
  closePopover();
  const p = $('#popover');
  p.innerHTML = html;
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth;
  const ph = p.offsetHeight;
  let left = Math.min(r.left, innerWidth - pw - 8);
  let top = r.bottom + 4;
  if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  p.style.left = `${Math.max(8, left)}px`;
  p.style.top = `${top}px`;
  const onDown = (e) => { if (!p.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  document.addEventListener('keydown', onKey);
  popClose = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    p.hidden = true;
    p.innerHTML = '';
    popClose = null;
  };
  if (bind) bind(p);
  return p;
}
function closePopover() { if (popClose) popClose(); }

let dlgClose = null;
function dialog(html, bind) {
  return new Promise((resolve) => {
    if (dlgClose) dlgClose(null);
    const w = $('#dialogWrap');
    const d = $('#dialog');
    d.innerHTML = html;
    w.hidden = false;
    const close = (val, fromPop) => {
      if (dlgClose !== close) return;
      dlgClose = null;
      w.hidden = true;
      d.innerHTML = '';
      if (!fromPop) popOverlay(onPop);
      resolve(val);
    };
    const onPop = () => close(null, true);
    dlgClose = close;
    pushOverlay(onPop);
    w.onclick = (e) => { if (e.target === w) close(null); };
    d.onkeydown = (e) => { if (e.key === 'Escape') close(null); };
    if (bind) bind(d, close);
  });
}
function confirmDlg(title, msg, ok = 'OK', danger = false) {
  return dialog(`<h3>${esc(title)}</h3><p>${esc(msg)}</p>
    <div class="acts"><button class="btn" data-x>Batal</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
  (d, close) => { $('[data-x]', d).onclick = () => close(false); $('[data-ok]', d).onclick = () => close(true); });
}

// ======================= drawer =======================
function renderDrawer() {
  const item = (sec, ic, text, label = null) => {
    const active = state.sec === sec && (sec !== 'label' || state.label === label);
    return `<button class="item ${active ? 'active' : ''}" data-sec="${sec}" ${label !== null ? `data-label="${esc(label)}"` : ''} title="${esc(text)}">${icon(ic)}<span>${esc(text)}</span></button>`;
  };
  const labels = allLabels();
  const themeName = { system: 'Tema: ikuti sistem', light: 'Tema: terang', dark: 'Tema: gelap' }[state.theme];
  $('#drawer').innerHTML = `
    ${item('notes', 'lightbulb', 'Catatan')}
    ${labels.length ? '<div class="cap">Label</div>' : ''}
    ${labels.map((l) => item('label', 'label', l, l)).join('')}
    <button class="item" data-act="labels" title="Edit label">${icon('edit')}<span>Edit label</span></button>
    ${item('archive', 'archive', 'Arsip')}
    ${item('trash', 'delete', 'Sampah')}
    <div class="sep"></div>
    <button class="item" data-act="import" title="Impor dari Evernote">${icon('upload')}<span>Impor dari Evernote (.enex)</span></button>
    <button class="item" data-act="export" title="Ekspor ke .enex">${icon('download')}<span>Ekspor ke .enex</span></button>
    <button class="item" data-act="account" title="OneDrive">${icon('cloud_done')}<span>OneDrive & sinkron</span></button>
    <button class="item" data-act="theme" title="${themeName}">${icon(document.documentElement.classList.contains('dark') ? 'dark' : 'light')}<span>${themeName}</span></button>
    <div class="foot">BtuNote v${VERSION}</div>`;
}

function setDrawer(open) {
  if (!isMobile()) { document.body.classList.toggle('mini', !open); ls.set('mini', !open); return; }
  const was = document.body.classList.contains('drawer-open');
  if (open === was) return;
  document.body.classList.toggle('drawer-open', open);
  $('#scrim').hidden = !open;
  if (open) pushOverlay(closeDrawerPop); else popOverlay(closeDrawerPop);
}
function closeDrawerPop() { document.body.classList.remove('drawer-open'); $('#scrim').hidden = true; }

$('#drawer').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (isMobile()) setDrawer(false);
  if (b.dataset.sec) {
    state.sec = b.dataset.sec;
    state.label = b.dataset.label ?? null;
    clearSelection();
    render();
    scrollTo(0, 0);
    return;
  }
  const act = b.dataset.act;
  if (act === 'labels') editLabelsDialog();
  else if (act === 'import') $('#fileEnex').click();
  else if (act === 'export') exportDialog();
  else if (act === 'account') accountDialog();
  else if (act === 'theme') {
    state.theme = { system: 'light', light: 'dark', dark: 'system' }[state.theme];
    ls.set('theme', state.theme);
    applyTheme();
    renderDrawer();
  }
});

// ======================= grid =======================
function cardHeight(n) {
  let h = 56;
  if (n.title) h += 26 * Math.min(3, Math.ceil(n.title.length / 24));
  if (n.kind === 'list') h += 21 * Math.min(n.items.length, 9);
  else h += 20 * Math.min(12, n.text.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / 30)), 0));
  if (n.images.length) h += n.images.length > 1 ? 120 : 180;
  if (n.labels.length || n.files.length) h += 30;
  return h;
}

function cardHtml(n) {
  const imgs = n.images.slice(0, 6);
  let body = '';
  if (n.title) body += `<div class="t">${esc(n.title)}</div>`;
  if (n.kind === 'list') {
    const open = n.items.filter((i) => !i.done);
    const done = n.items.filter((i) => i.done);
    const show = open.slice(0, 8);
    body += show.map((i) => `<div class="li">${icon('checkbox_blank')}<span>${esc(i.text)}</span></div>`).join('');
    const rest = open.length - show.length;
    if (rest > 0) body += `<div class="more">+${rest} item lagi</div>`;
    if (done.length) body += `<div class="more">+${done.length} item selesai</div>`;
  } else if (n.text) {
    const big = !n.title && n.text.length < 60 && !n.text.includes('\n');
    body += `<div class="x ${big ? 'big' : ''}">${esc(n.text.slice(0, 1500))}</div>`;
  }
  if (!n.title && !n.text && !n.items.length && !imgs.length) body += '<div class="x" style="color:var(--fg2)">Catatan kosong</div>';
  const chips = [
    ...n.files.slice(0, 2).map((f) => `<span class="chip">${icon('attach')}${esc(f.title)}</span>`),
    ...(n.files.length > 2 ? [`<span class="chip">+${n.files.length - 2} file</span>`] : []),
    ...n.labels.map((l) => `<span class="chip">${esc(l)}</span>`),
  ].join('');
  const trash = state.sec === 'trash';
  const acts = trash
    ? `<button class="ib" data-a="forever" title="Hapus permanen">${icon('delete_forever')}</button><button class="ib" data-a="restore" title="Pulihkan">${icon('restore')}</button>`
    : `<button class="ib" data-a="color" title="Warna">${icon('palette')}</button>
       <button class="ib" data-a="label" title="Label">${icon('label')}</button>
       <button class="ib" data-a="archive" title="${n.archived ? 'Batal arsip' : 'Arsipkan'}">${icon(n.archived ? 'unarchive' : 'archive')}</button>
       <button class="ib" data-a="trash" title="Hapus">${icon('delete')}</button>`;
  return `<div class="card ${state.selected.has(n.id) ? 'sel' : ''}" data-id="${n.id}" data-c="${n.color}" tabindex="0">
    <button class="check" data-a="select" title="Pilih">${icon('check')}</button>
    ${!trash ? `<button class="ib pin ${n.pinned ? 'on' : ''}" data-a="pin" title="${n.pinned ? 'Lepas sematan' : 'Sematkan'}">${icon('pin')}</button>` : ''}
    ${imgs.length ? `<div class="imgs ${imgs.length > 1 ? 'multi' : ''}">${imgs.map((i) => `<img data-blob="${esc(i)}" alt="" loading="lazy">`).join('')}</div>` : ''}
    <div class="body">${body}${chips ? `<div class="chips">${chips}</div>` : ''}</div>
    <div class="acts">${acts}</div>
  </div>`;
}

function gridHtml(notes) {
  let cols;
  if (state.layout === 'list') cols = 1;
  else {
    const w = $('#main').clientWidth - (isMobile() ? 16 : 32);
    cols = isMobile() ? 2 : Math.max(1, Math.floor((w + 16) / 256));
  }
  const buckets = Array.from({ length: cols }, () => ({ h: 0, html: [] }));
  for (const n of notes) {
    let b = buckets[0];
    for (const x of buckets) if (x.h < b.h - 40) b = x;
    b.html.push(cardHtml(n));
    b.h += cardHeight(n) + 16;
  }
  return `<div class="grid ${state.layout === 'list' ? 'listmode' : ''}">${buckets.map((b) => `<div class="col">${b.html.join('')}</div>`).join('')}</div>`;
}

let renderQ = false;
function render() {
  if (renderQ) return;
  renderQ = true;
  requestAnimationFrame(() => { renderQ = false; renderNow(); });
}

function renderNow() {
  renderDrawer();
  const notes = visibleNotes();
  const sec = $('#sections');
  let html = '';
  if (state.sec === 'trash') {
    html += `<div class="trash-info">Catatan di Sampah dihapus setelah ${TRASH_DAYS} hari.${notes.length ? ' <button class="btn" data-a="empty-trash">Kosongkan Sampah</button>' : ''}</div>`;
  }
  if (!notes.length) {
    const msg = state.q ? ['search', 'Tidak ada catatan yang cocok'] : {
      notes: ['lightbulb', 'Catatan yang Anda tambahkan akan muncul di sini'],
      archive: ['archive', 'Catatan yang diarsipkan akan muncul di sini'],
      trash: ['delete', 'Tidak ada catatan di Sampah'],
      label: ['label', 'Belum ada catatan dengan label ini'],
    }[state.sec];
    html += `<div class="empty">${icon(msg[0])}${esc(msg[1])}</div>`;
  } else if (state.sec === 'notes' || state.sec === 'label') {
    const pinned = notes.filter((n) => n.pinned);
    const others = notes.filter((n) => !n.pinned);
    if (pinned.length) html += `<div class="sec-title" style="${secAlign()}">Disematkan</div>${gridHtml(pinned)}`;
    if (others.length) html += `${pinned.length ? `<div class="sec-title" style="${secAlign()}">Lainnya</div>` : ''}${gridHtml(others)}`;
  } else {
    html += gridHtml(notes);
  }
  sec.innerHTML = html;
  hydrate(sec);
  $('#composer').hidden = state.sec === 'trash' || state.sec === 'archive';
  $('#brandText').textContent = state.sec === 'notes' ? 'BtuNote' : state.sec === 'archive' ? 'Arsip' : state.sec === 'trash' ? 'Sampah' : state.label;
  $('#btnLayout').innerHTML = icon(state.layout === 'grid' ? 'list' : 'grid');
  $('#btnLayout').title = state.layout === 'grid' ? 'Tampilan daftar' : 'Tampilan petak';
  renderSelbar();
}
function secAlign() {
  if (state.layout === 'list') return 'max-width:600px;margin-left:auto;margin-right:auto';
  if (isMobile()) return '';
  const w = $('#main').clientWidth - 32;
  const cols = Math.max(1, Math.floor((w + 16) / 256));
  return `max-width:${cols * 256 - 16}px;margin-left:auto;margin-right:auto`;
}

// ---------- interaksi kartu ----------
let lpTimer = null;
let lpFired = false;
let lpStart = null;
const sections = $('#sections');
sections.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.button !== 0) return;
  lpFired = false;
  lpStart = [e.clientX, e.clientY];
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    lpFired = true;
    if (navigator.vibrate) navigator.vibrate(20);
    toggleSelect(card.dataset.id);
  }, 480);
});
sections.addEventListener('pointermove', (e) => {
  if (lpStart && Math.hypot(e.clientX - lpStart[0], e.clientY - lpStart[1]) > 10) clearTimeout(lpTimer);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => sections.addEventListener(t, () => clearTimeout(lpTimer)));
sections.addEventListener('contextmenu', (e) => { if (e.target.closest('.card') && isMobile()) e.preventDefault(); });

sections.addEventListener('click', async (e) => {
  if (lpFired) { lpFired = false; return; }
  const a = e.target.closest('[data-a]');
  if (a && a.dataset.a === 'empty-trash') {
    const ids = visibleNotes().map((n) => n.id);
    if (await confirmDlg('Kosongkan Sampah?', `${ids.length} catatan akan dihapus permanen.`, 'Kosongkan', true)) deleteForever(ids);
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (a) {
    e.stopPropagation();
    const act = a.dataset.a;
    if (act === 'select') return toggleSelect(id);
    if (act === 'pin') return updateNotes([id], (n) => { n.pinned = !n.pinned; if (n.pinned) n.archived = false; }, { touch: false });
    if (act === 'archive') return archiveNotes([id]);
    if (act === 'trash') return trashNotes([id]);
    if (act === 'restore') return updateNotes([id], (n) => { n.trashed = 0; });
    if (act === 'forever') {
      if (await confirmDlg('Hapus permanen?', 'Catatan ini tidak bisa dikembalikan.', 'Hapus', true)) deleteForever([id]);
      return;
    }
    if (act === 'color') return colorPopover(a, [id]);
    if (act === 'label') return labelPopover(a, [id]);
    return;
  }
  if (state.selected.size || e.ctrlKey || e.metaKey || e.shiftKey) return toggleSelect(id);
  const n = state.notes.get(id);
  if (n) openEditor(n);
});
sections.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) { const n = state.notes.get(e.target.dataset.id); if (n) openEditor(n); }
});

async function archiveNotes(ids) {
  const arch = !state.notes.get(ids[0])?.archived;
  await updateNotes(ids, (n) => { n.archived = arch; if (arch) n.pinned = false; }, { touch: false });
  snack(arch ? `${ids.length > 1 ? `${ids.length} catatan` : 'Catatan'} diarsipkan` : 'Batal diarsipkan', 'Urungkan',
    () => updateNotes(ids, (n) => { n.archived = !arch; }, { touch: false }));
}
async function trashNotes(ids) {
  await updateNotes(ids, (n) => { n.trashed = Date.now(); n.pinned = false; });
  snack(`${ids.length > 1 ? `${ids.length} catatan` : 'Catatan'} dipindah ke Sampah`, 'Urungkan',
    () => updateNotes(ids, (n) => { n.trashed = 0; }));
}

// ======================= seleksi =======================
function toggleSelect(id) {
  const had = state.selected.size;
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  if (!had && state.selected.size) pushOverlay(clearSelectionPop);
  if (had && !state.selected.size) popOverlay(clearSelectionPop);
  render();
}
function clearSelectionPop() { state.selected.clear(); render(); }
function clearSelection() {
  if (!state.selected.size) return;
  popOverlay(clearSelectionPop);
  state.selected.clear();
  render();
}
function renderSelbar() {
  const n = state.selected.size;
  document.body.classList.toggle('selecting', n > 0);
  $('#selbar').hidden = !n;
  $('#topbar').hidden = !!n;
  if (!n) return;
  $('#selCount').textContent = `${n} dipilih`;
  const trash = state.sec === 'trash';
  const ids = [...state.selected];
  const allPinned = ids.every((id) => state.notes.get(id)?.pinned);
  $('#selActions').innerHTML = trash
    ? `<button class="ib" data-s="restore" title="Pulihkan">${icon('restore')}</button><button class="ib" data-s="forever" title="Hapus permanen">${icon('delete_forever')}</button>`
    : `<button class="ib ${allPinned ? 'on' : ''}" data-s="pin" title="Sematkan">${icon('pin')}</button>
       <button class="ib" data-s="color" title="Warna">${icon('palette')}</button>
       <button class="ib" data-s="label" title="Label">${icon('label')}</button>
       <button class="ib" data-s="archive" title="Arsip">${icon(state.sec === 'archive' ? 'unarchive' : 'archive')}</button>
       <button class="ib" data-s="more" title="Lainnya">${icon('more')}</button>`;
}
$('#selClose').onclick = () => clearSelection();
$('#selActions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  const ids = [...state.selected];
  const s = b.dataset.s;
  if (s === 'pin') {
    const pin = !ids.every((id) => state.notes.get(id)?.pinned);
    await updateNotes(ids, (n) => { n.pinned = pin; if (pin) n.archived = false; }, { touch: false });
  } else if (s === 'color') colorPopover(b, ids);
  else if (s === 'label') labelPopover(b, ids);
  else if (s === 'archive') { clearSelection(); archiveNotes(ids); }
  else if (s === 'restore') { clearSelection(); updateNotes(ids, (n) => { n.trashed = 0; }); }
  else if (s === 'forever') {
    if (await confirmDlg('Hapus permanen?', `${ids.length} catatan akan dihapus permanen.`, 'Hapus', true)) { clearSelection(); deleteForever(ids); }
  } else if (s === 'more') {
    popover(b, `<button class="mi" data-m="trash">${icon('delete')}Hapus</button>
      <button class="mi" data-m="copy">${icon('copy')}Buat salinan</button>
      <button class="mi" data-m="export">${icon('download')}Ekspor ke .enex</button>
      <button class="mi" data-m="all">${icon('select')}Pilih semua</button>`, (p) => {
      p.onclick = async (ev) => {
        const m = ev.target.closest('[data-m]')?.dataset.m;
        if (!m) return;
        closePopover();
        if (m === 'trash') { clearSelection(); trashNotes(ids); }
        if (m === 'copy') { clearSelection(); for (const id of ids) await copyNote(state.notes.get(id)); }
        if (m === 'export') { const list = ids.map((id) => state.notes.get(id)).filter(Boolean); clearSelection(); doExport(list); }
        if (m === 'all') { visibleNotes().forEach((x) => state.selected.add(x.id)); render(); }
      };
    });
  }
});

async function copyNote(n) {
  if (!n) return;
  const c = newNote({ ...JSON.parse(JSON.stringify(n)), id: uid(), pinned: false, items: n.items.map((i) => ({ ...i, id: uid() })) });
  c.created = c.updated = Date.now();
  c.rev = null; c.dirty = true;
  await db.putNote(c);
  state.notes.set(c.id, c);
  render();
  sync.soon();
  return c;
}

// ======================= popover warna & label =======================
function colorPopover(anchor, ids, onPick) {
  const cur = ids.length === 1 ? (ed && ed.note.id === ids[0] ? ed.note.color : state.notes.get(ids[0])?.color) : null;
  popover(anchor, `<div class="palette">${COLORS.map((c) => `<button class="swatch ${c.id} ${cur === c.id ? 'cur' : ''}" data-col="${c.id}" title="${c.name}" style="${c.id !== 'default' ? `background:var(--c-${c.id})` : ''}">${c.id === 'default' ? icon('close') : ''}</button>`).join('')}</div>`,
    (p) => {
      p.onclick = (e) => {
        const b = e.target.closest('[data-col]');
        if (!b) return;
        const col = b.dataset.col;
        $$('.swatch', p).forEach((s) => s.classList.toggle('cur', s === b));
        if (onPick) onPick(col);
        else updateNotes(ids, (n) => { n.color = col; }, { touch: false });
      };
    });
}

function labelPopover(anchor, ids, getNotes, onChange) {
  const notesOf = getNotes || (() => ids.map((id) => state.notes.get(id)).filter(Boolean));
  const draw = (p, q = '') => {
    const labels = allLabels().filter((l) => !q || l.toLowerCase().includes(q.toLowerCase()));
    const ns = notesOf();
    const exact = allLabels().some((l) => l.toLowerCase() === q.trim().toLowerCase());
    $('.lbl-list', p).innerHTML = labels.map((l) => {
      const all = ns.length && ns.every((n) => n.labels.includes(l));
      const some = ns.some((n) => n.labels.includes(l));
      return `<label class="mi"><input type="checkbox" data-l="${esc(l)}" ${all ? 'checked' : ''} ${!all && some ? 'data-ind="1"' : ''}>${esc(l)}</label>`;
    }).join('') + (q.trim() && !exact ? `<button class="mi" data-create="${esc(q.trim())}">${icon('add')}Buat "${esc(q.trim())}"</button>` : '');
    $$('input[data-ind]', p).forEach((i) => { i.indeterminate = true; });
  };
  popover(anchor, `<div class="lbl-head">Beri label catatan</div><input class="lbl-search" placeholder="Masukkan nama label" maxlength="50"><div class="lbl-list"></div>`, (p) => {
    const inp = $('.lbl-search', p);
    draw(p);
    if (!isMobile()) inp.focus();
    inp.oninput = () => draw(p, inp.value);
    const apply = async (label, add) => {
      if (onChange) onChange(label, add);
      else await updateNotes(ids, (n) => {
        n.labels = add ? [...new Set([...n.labels, label])] : n.labels.filter((x) => x !== label);
      }, { touch: false });
      draw(p, inp.value);
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && inp.value.trim()) {
        const v = inp.value.trim();
        const ex = allLabels().find((l) => l.toLowerCase() === v.toLowerCase());
        inp.value = '';
        apply(ex || v, true);
      }
    };
    p.addEventListener('change', (e) => { const l = e.target.dataset.l; if (l) apply(l, e.target.checked); });
    p.addEventListener('click', (e) => {
      const c = e.target.closest('[data-create]');
      if (c) { inp.value = ''; apply(c.dataset.create, true); }
    });
  });
}

// ======================= editor =======================
let ed = null; // { note, isNew, saveT, doneOpen, readonly }

function openEditor(note, opts = {}) {
  closePopover();
  const n = JSON.parse(JSON.stringify(note));
  ed = { note: n, isNew: !!opts.isNew, saveT: null, doneOpen: false, readonly: !!n.trashed };
  $('#editorWrap').hidden = false;
  document.body.style.overflow = 'hidden';
  pushOverlay(closeEditorPop);
  renderEditor();
  const ta = opts.focus === 'title' ? $('.title', $('#editor')) : null;
  if (opts.focus === 'text') {
    const t = n.kind === 'list' ? $('.item.add textarea', $('#editor')) : $('.text', $('#editor'));
    if (t) setTimeout(() => t.focus(), 50);
  } else if (ta) setTimeout(() => ta.focus(), 50);
}

function closeEditorPop() { finishEditor(); }
async function closeEditor() {
  if (!ed) return;
  popOverlay(closeEditorPop);
  await finishEditor();
}
async function finishEditor() {
  if (!ed) return;
  const cur = ed;
  ed = null;
  closePopover();
  $('#editorWrap').hidden = true;
  $('#editor').innerHTML = '';
  document.body.style.overflow = '';
  clearTimeout(cur.saveT);
  const n = cur.note;
  n.items = n.items.filter((i) => i.text.trim() || i.done);
  if (isEmpty(n)) {
    if (!cur.isNew) {
      const stored = await db.getNote(n.id);
      if (stored) { await deleteForever([n.id]); snack('Catatan kosong dibuang'); }
    }
    return;
  }
  if (cur.pending || cur.isNew) await persist(cur, true);
}

function touch() {
  if (!ed || ed.readonly) return;
  ed.note.updated = Date.now();
  ed.note.dirty = true;
  ed.pending = true;
  clearTimeout(ed.saveT);
  const cur = ed;
  ed.saveT = setTimeout(() => persist(cur), 400);
  const st = $('.stamp', $('#editor'));
  if (st) st.textContent = `Diedit ${fmtStamp(ed.note.updated)}`;
}

async function persist(cur, final = false) {
  const n = cur.note;
  if (isEmpty(n) && cur.isNew) return;
  cur.pending = false;
  const stored = await db.getNote(n.id);
  if (stored && stored.rev) n.rev = stored.rev; // versi OneDrive terbaru
  n.dirty = true;
  const copy = JSON.parse(JSON.stringify(n));
  if (final) copy.items = copy.items.filter((i) => i.text.trim() || i.done);
  await db.putNote(copy);
  cur.isNew = false;
  state.notes.set(copy.id, copy);
  render();
  sync.soon();
}

function renderEditor() {
  const n = ed.note;
  const ro = ed.readonly;
  const el = $('#editor');
  el.dataset.c = n.color;
  const imgs = n.images;
  const open = n.items.filter((i) => !i.done);
  const done = n.items.filter((i) => i.done);
  const itemHtml = (i) => `<div class="item ${i.done ? 'done' : ''}" data-iid="${i.id}">
      <button class="ib cb" data-e="check" title="${i.done ? 'Batal centang' : 'Centang'}" ${ro ? 'disabled' : ''}>${icon(i.done ? 'checkbox' : 'checkbox_blank')}</button>
      <textarea rows="1" ${ro ? 'readonly' : ''}>${esc(i.text)}</textarea>
      ${ro ? '' : `<button class="ib rm" data-e="rmitem" title="Hapus item">${icon('close')}</button>`}</div>`;
  el.innerHTML = `
    <div class="scroll">
      ${imgs.length ? `<div class="eimgs ${imgs.length === 1 ? 'one' : ''}">${imgs.map((i) => `<div class="im"><img data-blob="${esc(i)}" data-view="${esc(i)}" alt="">${ro ? '' : `<button class="ib del" data-e="rmimg" data-img="${esc(i)}" title="Hapus gambar">${icon('delete')}</button>`}</div>`).join('')}</div>` : ''}
      <div class="head">
        <button class="ib back" data-e="close" title="Kembali">${icon('back')}</button>
        <textarea class="title" rows="1" placeholder="Judul" ${ro ? 'readonly' : ''}>${esc(n.title)}</textarea>
        ${ro ? '' : `<button class="ib ${n.pinned ? 'on' : ''}" data-e="pin" title="${n.pinned ? 'Lepas sematan' : 'Sematkan'}">${icon('pin')}</button>`}
      </div>
      ${n.kind === 'list' ? `<div class="items">
          ${open.map(itemHtml).join('')}
          ${ro ? '' : `<div class="item add"><span class="plus">${icon('add')}</span><textarea rows="1" placeholder="Item daftar"></textarea></div>`}
          ${done.length ? `<button class="donehead ${ed.doneOpen ? '' : 'closed'}" data-e="donetoggle">${icon('expand')}<span>${done.length} item selesai</span></button>
            ${ed.doneOpen ? done.map(itemHtml).join('') : ''}` : ''}
        </div>` : `<textarea class="text" placeholder="Buat catatan…" ${ro ? 'readonly' : ''}>${esc(n.text)}</textarea>`}
      ${n.files.length ? `<div class="files">${n.files.map((f) => `<div class="file" data-e="openfile" data-f="${esc(f.name)}">${icon('file')}<span class="nm">${esc(f.title)}</span><span class="sz">${fmtSize(f.size || 0)}</span>${ro ? '' : `<button class="ib sm" data-e="rmfile" data-f="${esc(f.name)}" title="Hapus lampiran">${icon('close')}</button>`}</div>`).join('')}</div>` : ''}
      ${n.labels.length ? `<div class="chips">${n.labels.map((l) => `<span class="chip">${esc(l)}${ro ? '' : `<button data-e="rmlabel" data-l="${esc(l)}" title="Hapus label">${icon('close')}</button>`}</span>`).join('')}</div>` : ''}
      <div class="stamp">${ro ? 'Di Sampah · ' : ''}Diedit ${fmtStamp(n.updated)}</div>
    </div>
    <div class="tools">
      ${ro ? `<button class="ib" data-e="restore" title="Pulihkan">${icon('restore')}</button>
              <button class="ib" data-e="forever" title="Hapus permanen">${icon('delete_forever')}</button>`
    : `<button class="ib" data-e="color" title="Warna">${icon('palette')}</button>
       <button class="ib" data-e="image" title="Tambah gambar">${icon('image')}</button>
       <button class="ib" data-e="attach" title="Lampirkan file">${icon('attach')}</button>
       <button class="ib" data-e="kind" title="${n.kind === 'list' ? 'Jadikan teks biasa' : 'Jadikan daftar centang'}">${icon(n.kind === 'list' ? 'text' : 'checkbox')}</button>
       <button class="ib" data-e="label" title="Label">${icon('label')}</button>
       <button class="ib" data-e="archive" title="${n.archived ? 'Batal arsip' : 'Arsipkan'}">${icon(n.archived ? 'unarchive' : 'archive')}</button>
       <button class="ib" data-e="more" title="Lainnya">${icon('more')}</button>`}
      <button class="btn desktop-only" data-e="close">Tutup</button>
    </div>`;
  hydrate(el);
  $$('textarea', el).forEach(autosize);
}

function focusItem(id, atEnd = true, pos = null) {
  const ta = $(`.item[data-iid="${id}"] textarea`, $('#editor'));
  if (!ta) return;
  ta.focus();
  const p = pos ?? (atEnd ? ta.value.length : 0);
  ta.setSelectionRange(p, p);
}

const editorEl = $('#editor');
editorEl.addEventListener('input', (e) => {
  if (!ed) return;
  const t = e.target;
  if (t.tagName === 'TEXTAREA') autosize(t);
  if (t.classList.contains('title')) { ed.note.title = t.value.replace(/\n/g, ' '); touch(); return; }
  if (t.classList.contains('text')) { ed.note.text = t.value; touch(); return; }
  const row = t.closest('.item');
  if (!row) return;
  if (row.classList.contains('add')) {
    const lines = t.value.split('\n');
    const created = lines.map((txt) => ({ id: uid(), text: txt, done: false }));
    const firstDone = ed.note.items.findIndex((i) => i.done);
    const at = firstDone < 0 ? ed.note.items.length : firstDone;
    ed.note.items.splice(at, 0, ...created);
    touch();
    renderEditor();
    focusItem(created[created.length - 1].id);
    return;
  }
  const it = ed.note.items.find((i) => i.id === row.dataset.iid);
  if (!it) return;
  if (t.value.includes('\n')) {
    // tempel teks banyak baris -> jadi beberapa item
    const [first, ...rest] = t.value.split('\n');
    it.text = first;
    const idx = ed.note.items.indexOf(it);
    const created = rest.map((txt) => ({ id: uid(), text: txt, done: false }));
    ed.note.items.splice(idx + 1, 0, ...created);
    touch();
    renderEditor();
    focusItem(created[created.length - 1].id);
    return;
  }
  it.text = t.value;
  touch();
});

editorEl.addEventListener('keydown', (e) => {
  if (!ed || ed.readonly) return;
  const t = e.target;
  if (t.classList.contains('title') && e.key === 'Enter') {
    e.preventDefault();
    const next = ed.note.kind === 'list' ? ($('.item:not(.add) textarea', editorEl) || $('.item.add textarea', editorEl)) : $('.text', editorEl);
    if (next) next.focus();
    return;
  }
  const row = t.closest && t.closest('.item:not(.add)');
  if (!row) return;
  const items = ed.note.items;
  const it = items.find((i) => i.id === row.dataset.iid);
  if (!it) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const pos = t.selectionStart;
    const after = t.value.slice(pos);
    it.text = t.value.slice(0, pos);
    const ni = { id: uid(), text: after, done: false };
    items.splice(items.indexOf(it) + 1, 0, ni);
    touch();
    renderEditor();
    focusItem(ni.id, false);
  } else if (e.key === 'Backspace' && t.selectionStart === 0 && t.selectionEnd === 0) {
    const vis = items.filter((i) => i.done === it.done);
    const prev = vis[vis.indexOf(it) - 1];
    if (!prev && t.value) return;
    e.preventDefault();
    items.splice(items.indexOf(it), 1);
    let focusId = null;
    let pos = null;
    if (prev) { pos = prev.text.length; prev.text += t.value; focusId = prev.id; }
    touch();
    renderEditor();
    if (focusId) focusItem(focusId, false, pos);
    else { const a = $('.item.add textarea', editorEl); if (a) a.focus(); }
  }
});

editorEl.addEventListener('click', async (e) => {
  if (!ed) return;
  const viewImg = e.target.closest('[data-view]');
  if (viewImg && !e.target.closest('[data-e]')) { openViewer(viewImg.dataset.view); return; }
  const b = e.target.closest('[data-e]');
  if (!b) return;
  const n = ed.note;
  const act = b.dataset.e;
  if (act === 'close') return closeEditor();
  if (act === 'pin') { n.pinned = !n.pinned; if (n.pinned) n.archived = false; touch(); renderEditor(); return; }
  if (act === 'check') {
    const it = n.items.find((i) => i.id === b.closest('.item').dataset.iid);
    if (!it) return;
    it.done = !it.done;
    // pindah: selesai -> ke bawah, batal -> ke akhir daftar aktif
    n.items.splice(n.items.indexOf(it), 1);
    if (it.done) n.items.push(it);
    else { const fd = n.items.findIndex((i) => i.done); n.items.splice(fd < 0 ? n.items.length : fd, 0, it); }
    touch(); renderEditor(); return;
  }
  if (act === 'rmitem') {
    const id = b.closest('.item').dataset.iid;
    n.items = n.items.filter((i) => i.id !== id);
    touch(); renderEditor(); return;
  }
  if (act === 'donetoggle') { ed.doneOpen = !ed.doneOpen; renderEditor(); return; }
  if (act === 'rmimg') { n.images = n.images.filter((x) => x !== b.dataset.img); touch(); renderEditor(); return; }
  if (act === 'rmfile') { e.stopPropagation(); n.files = n.files.filter((f) => f.name !== b.dataset.f); touch(); renderEditor(); return; }
  if (act === 'openfile') { const f = n.files.find((x) => x.name === b.dataset.f); if (f) openFile(f); return; }
  if (act === 'rmlabel') { n.labels = n.labels.filter((l) => l !== b.dataset.l); touch(); renderEditor(); return; }
  if (act === 'kind') {
    if (n.kind === 'text') {
      n.items = n.text.split('\n').filter((l) => l.trim()).map((l) => {
        const m = /^\s*(☑|☐|\[[xX ]\]|[-*•])\s*/.exec(l);
        const done = !!m && (m[1] === '☑' || /x/i.test(m[1]));
        return { id: uid(), text: m ? l.slice(m[0].length) : l, done };
      });
      n.items = [...n.items.filter((i) => !i.done), ...n.items.filter((i) => i.done)];
      n.kind = 'list';
    } else {
      n.text = n.items.map((i) => i.text).join('\n');
      n.items = [];
      n.kind = 'text';
    }
    touch(); renderEditor(); return;
  }
  if (act === 'color') {
    colorPopover(b, [n.id], (col) => { n.color = col; editorEl.dataset.c = col; touch(); });
    return;
  }
  if (act === 'label') {
    labelPopover(b, [n.id], () => [n], (label, add) => {
      n.labels = add ? [...new Set([...n.labels, label])] : n.labels.filter((x) => x !== label);
      if (!state.extraLabels.includes(label) && add) { /* label baru otomatis muncul lewat note */ }
      touch(); renderEditor();
    });
    return;
  }
  if (act === 'image') { pickTarget = 'editor'; $('#fileImage').click(); return; }
  if (act === 'attach') { $('#fileAttach').click(); return; }
  if (act === 'archive') {
    n.archived = !n.archived; if (n.archived) n.pinned = false;
    touch();
    const was = n.archived;
    await closeEditor();
    snack(was ? 'Catatan diarsipkan' : 'Batal diarsipkan');
    return;
  }
  if (act === 'restore') {
    const id = n.id;
    await closeEditor();
    updateNotes([id], (x) => { x.trashed = 0; });
    return;
  }
  if (act === 'forever') {
    if (await confirmDlg('Hapus permanen?', 'Catatan ini tidak bisa dikembalikan.', 'Hapus', true)) {
      const id = n.id; await closeEditor(); deleteForever([id]);
    }
    return;
  }
  if (act === 'more') {
    popover(b, `<button class="mi" data-m="trash">${icon('delete')}Hapus catatan</button>
      <button class="mi" data-m="copy">${icon('copy')}Buat salinan</button>
      <button class="mi" data-m="export">${icon('download')}Ekspor ke .enex</button>`, (p) => {
      p.onclick = async (ev) => {
        const m = ev.target.closest('[data-m]')?.dataset.m;
        if (!m) return;
        closePopover();
        if (m === 'trash') {
          if (ed.isNew && isEmpty(n)) { closeEditor(); return; }
          await persist(ed);
          const id = n.id;
          await closeEditor();
          trashNotes([id]);
        }
        if (m === 'copy') { await persist(ed); const c = await copyNote(n); await closeEditor(); if (c) openEditor(c); }
        if (m === 'export') { await persist(ed); doExport([ed.note]); }
      };
    });
  }
});

$('#editorWrap').addEventListener('mousedown', (e) => { if (e.target.id === 'editorWrap') closeEditor(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ed && !popClose && !dlgClose && $('#viewer').hidden) closeEditor();
});

// ---------- gambar & lampiran ----------
let pickTarget = 'editor';
$('#fileImage').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (pickTarget === 'new' || !ed) {
    const n = newNote({ kind: 'text' });
    openEditor(n, { isNew: true });
  }
  const cur = ed;
  for (const f of files) {
    const name = await storeImageFile(f);
    if (!cur.note.images.includes(name)) cur.note.images.push(name);
  }
  if (ed === cur) { touch(); renderEditor(); }
});
$('#fileAttach').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!ed || !files.length) return;
  const cur = ed;
  for (const f of files) {
    if (f.size > 100 * 1024 * 1024) { snack(`${f.name} terlalu besar (maks 100 MB)`); continue; }
    if (f.type.startsWith('image/')) { cur.note.images.push(await storeImageFile(f)); continue; }
    const { name } = await storeBytes(new Uint8Array(await f.arrayBuffer()), f.type, f.name);
    if (!cur.note.files.some((x) => x.name === name)) cur.note.files.push({ name, title: f.name, mime: f.type || 'application/octet-stream', size: f.size });
  }
  if (ed === cur) { touch(); renderEditor(); }
});

async function openFile(f) {
  let b = await db.getBlob(f.name);
  if (!b) {
    snack(`Mengunduh ${f.title}…`, null, null, 30000);
    await fetchBlob(f.name);
    b = await db.getBlob(f.name);
    $('#snackbar').hidden = true;
    if (!b) { snack('Gagal mengunduh file dari OneDrive. Cek koneksi lalu coba lagi.'); return; }
  }
  if (native) { await saveFile(b.blob, f.title, f.mime, true); return; }
  const u = URL.createObjectURL(new Blob([b.blob], { type: f.mime }));
  const a = document.createElement('a');
  a.href = u;
  if (/^(application\/pdf|text\/|image\/|audio\/|video\/)/.test(f.mime)) a.target = '_blank';
  else a.download = f.title;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

function openViewer(name) {
  const v = $('#viewer');
  v.innerHTML = `<img data-blob="${esc(name)}" alt=""><button class="ib vclose" title="Tutup">${icon('back')}</button><button class="ib vdl" title="Simpan">${icon('download')}</button>`;
  v.hidden = false;
  hydrate(v);
  const close = (fromPop) => { v.hidden = true; v.innerHTML = ''; if (!fromPop) popOverlay(onPop); };
  const onPop = () => close(true);
  pushOverlay(onPop);
  $('.vclose', v).onclick = () => close();
  v.onclick = (e) => { if (e.target === v) close(); };
  $('.vdl', v).onclick = async () => { const b = await db.getBlob(name); if (b) saveFile(b.blob, name, b.blob.type); };
}

// ======================= simpan file (ekspor) =======================
async function saveFile(blob, name, mime, openAfter = false) {
  if (native) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    native.saveFile(name, mime || 'application/octet-stream', btoa(s), openAfter ? 'true' : 'false');
    return;
  }
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

// ======================= impor / ekspor ENEX =======================
$('#fileEnex').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const base = files[0].name.replace(/\.enex$/i, '');
  const ok = await dialog(`<h3>Impor dari Evernote</h3>
    <p>${files.length > 1 ? `${files.length} file` : esc(files[0].name)} akan diimpor ke BtuNote.</p>
    <label class="opt"><input type="checkbox" id="impLabelOn" checked>Beri label untuk catatan yang diimpor</label>
    <input type="text" id="impLabel" value="${esc(files.length > 1 ? 'Evernote' : base)}" maxlength="50">
    <p class="muted" style="margin-top:10px">Tag Evernote ikut menjadi label. Format teks (tebal, tabel, dll.) diubah menjadi teks biasa; gambar dan lampiran ikut dipindah.</p>
    <div class="acts"><button class="btn" data-x>Batal</button><button class="btn primary" data-ok>Impor</button></div>`,
  (d, close) => {
    $('[data-x]', d).onclick = () => close(null);
    $('[data-ok]', d).onclick = () => close({ label: $('#impLabelOn', d).checked ? $('#impLabel', d).value.trim() : '' });
  });
  if (!ok) return;
  let total = 0;
  const prog = dialog(`<h3>Mengimpor…</h3><p id="impMsg">Membaca file…</p><div class="progress"><div id="impBar"></div></div>`);
  try {
    for (const f of files) {
      const text = await f.text();
      const res = await importEnex(text, {
        label: ok.label,
        onProgress: (i, n) => {
          const m = $('#impMsg'); const b = $('#impBar');
          if (m) m.textContent = `${f.name}: ${i} / ${n} catatan`;
          if (b) b.style.width = `${Math.round((i / n) * 100)}%`;
        },
      });
      total += res.length;
    }
    if (dlgClose) dlgClose(null);
    await prog;
    await loadNotes();
    state.sec = 'notes'; state.label = null;
    render();
    snack(`${total} catatan berhasil diimpor`);
    sync.soon();
  } catch (err) {
    if (dlgClose) dlgClose(null);
    await prog;
    await loadNotes(); render();
    dialog(`<h3>Impor gagal</h3><p>${esc(err.message || err)}</p><div class="acts"><button class="btn primary" data-ok>OK</button></div>`,
      (d, close) => { $('[data-ok]', d).onclick = () => close(); });
  }
});

async function doExport(notes) {
  if (!notes.length) { snack('Tidak ada catatan untuk diekspor'); return; }
  snack('Menyiapkan file .enex…', null, null, 2000);
  const { blob, missing } = await exportEnex(notes);
  const d = new Date();
  const name = `BtuNote-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${notes.length}catatan.enex`;
  await saveFile(blob, name, 'application/enex+xml');
  snack(`${notes.length} catatan diekspor${missing ? ` (${missing} lampiran belum terunduh, dilewati)` : ''}${native ? ' ke folder Download' : ''}`);
}

function exportDialog() {
  const live = [...state.notes.values()].filter((n) => !n.trashed);
  const labels = allLabels();
  dialog(`<h3>Ekspor ke .enex</h3>
    <p class="muted">File .enex bisa diimpor di Evernote (File → Import). Untuk memilih catatan tertentu, tekan lama / Ctrl+klik catatan lalu pilih ⋮ → Ekspor.</p>
    <label class="opt"><input type="radio" name="sc" value="all" checked>Semua catatan (${live.filter((n) => !n.archived).length})</label>
    <label class="opt"><input type="radio" name="sc" value="allarch">Semua termasuk arsip (${live.length})</label>
    ${state.q ? `<label class="opt"><input type="radio" name="sc" value="search">Hasil pencarian saat ini (${visibleNotes().length})</label>` : ''}
    ${labels.map((l) => `<label class="opt"><input type="radio" name="sc" value="l:${esc(l)}">Label: ${esc(l)} (${live.filter((n) => n.labels.includes(l)).length})</label>`).join('')}
    <div class="acts"><button class="btn" data-x>Batal</button><button class="btn primary" data-ok>Ekspor</button></div>`,
  (d, close) => {
    $('[data-x]', d).onclick = () => close();
    $('[data-ok]', d).onclick = () => {
      const v = $('input[name=sc]:checked', d).value;
      let list;
      if (v === 'all') list = live.filter((n) => !n.archived);
      else if (v === 'allarch') list = live;
      else if (v === 'search') list = visibleNotes();
      else list = live.filter((n) => n.labels.includes(v.slice(2)));
      close();
      doExport(list);
    };
  });
}

// ======================= edit label =======================
function editLabelsDialog() {
  const draw = (d) => {
    $('#lblList', d).innerHTML = allLabels().map((l) => `<div class="lblrow" data-l="${esc(l)}">
      <button class="ib sm" data-del title="Hapus label">${icon('delete')}</button>
      <input type="text" value="${esc(l)}" maxlength="50">
      <button class="ib sm" data-ren title="Ganti nama">${icon('check')}</button></div>`).join('') || '<p class="muted">Belum ada label.</p>';
  };
  dialog(`<h3>Edit label</h3>
    <div class="lblrow"><span class="ib sm">${icon('add')}</span><input type="text" id="lblNew" placeholder="Buat label baru" maxlength="50"><button class="ib sm" id="lblAdd" title="Buat">${icon('check')}</button></div>
    <div id="lblList"></div>
    <div class="acts"><button class="btn" data-x>Selesai</button></div>`,
  (d, close) => {
    draw(d);
    $('[data-x]', d).onclick = () => close();
    const add = () => {
      const v = $('#lblNew', d).value.trim();
      if (!v || allLabels().some((l) => l.toLowerCase() === v.toLowerCase())) return;
      state.extraLabels.push(v); ls.set('labels', state.extraLabels);
      $('#lblNew', d).value = '';
      draw(d); renderDrawer();
    };
    $('#lblAdd', d).onclick = add;
    $('#lblNew', d).onkeydown = (e) => { if (e.key === 'Enter') add(); };
    $('#lblList', d).addEventListener('click', async (e) => {
      const row = e.target.closest('.lblrow');
      if (!row) return;
      const old = row.dataset.l;
      const ids = [...state.notes.values()].filter((n) => n.labels.includes(old)).map((n) => n.id);
      if (e.target.closest('[data-del]')) {
        state.extraLabels = state.extraLabels.filter((l) => l !== old); ls.set('labels', state.extraLabels);
        await updateNotes(ids, (n) => { n.labels = n.labels.filter((l) => l !== old); }, { touch: false });
        if (state.label === old) { state.sec = 'notes'; state.label = null; }
        draw(d); render();
      } else if (e.target.closest('[data-ren]')) {
        const nv = $('input', row).value.trim();
        if (!nv || nv === old) return;
        state.extraLabels = state.extraLabels.map((l) => (l === old ? nv : l)); ls.set('labels', state.extraLabels);
        await updateNotes(ids, (n) => { n.labels = [...new Set(n.labels.map((l) => (l === old ? nv : l)))]; }, { touch: false });
        if (state.label === old) state.label = nv;
        draw(d); render();
      }
    });
  });
}

// ======================= akun & sinkron =======================
function statusText() {
  const s = sync.status;
  if (!auth.isLoggedIn()) return 'Belum tersambung ke OneDrive. Catatan hanya tersimpan di perangkat ini.';
  return {
    idle: `Tersinkron${s.last ? ` · ${fmtStamp(s.last)}` : ''}`,
    syncing: 'Sedang menyinkron…',
    offline: 'Offline — perubahan akan dikirim saat online',
    login: 'Sesi OneDrive habis, perlu login ulang',
    error: `Gagal sinkron: ${s.msg}`,
    off: 'Belum tersambung',
  }[s.state] || '';
}

function accountDialog() {
  const logged = auth.isLoggedIn();
  const acc = auth.account();
  dialog(`<h3>OneDrive</h3>
    ${logged ? `<div class="acct">${icon('account')}<div><b>${esc(acc?.name || 'Akun Microsoft')}</b><small>${esc(acc?.email || '')}</small></div></div>` : ''}
    <p id="stTxt">${esc(statusText())}</p>
    ${logged ? '<p class="muted">Catatan disimpan di folder <b>BtuNote</b> di OneDrive. Buka BtuNote di HP/PC lain dengan akun yang sama untuk sinkron.</p>'
    : `<p class="muted">${native ? 'Login memakai kode: nanti muncul kode yang dimasukkan di halaman microsoft.com/devicelogin.' : 'Anda akan diarahkan ke halaman login Microsoft.'}</p>`}
    <div class="acts">
      ${logged ? '<button class="btn danger" data-out>Logout</button><button class="btn" data-x>Tutup</button><button class="btn primary" data-sync>Sinkron sekarang</button>'
    : '<button class="btn" data-x>Nanti</button><button class="btn primary" data-in>Login OneDrive</button>'}
    </div>`,
  (d, close) => {
    const off = sync.on((ev) => { if (ev.type === 'status') { const t = $('#stTxt', d); if (t) t.textContent = statusText(); } });
    const done = (v) => { off(); close(v); };
    $('[data-x]', d).onclick = () => done();
    const sn = $('[data-sync]', d);
    if (sn) sn.onclick = () => sync.run();
    const li = $('[data-in]', d);
    if (li) li.onclick = () => { done(); auth.login(); };
    const lo = $('[data-out]', d);
    if (lo) lo.onclick = async () => {
      done();
      if (await confirmDlg('Logout dari OneDrive?', 'Catatan tetap ada di perangkat ini, tapi tidak disinkron lagi sampai login ulang.', 'Logout', true)) {
        auth.logout(); sync.reset(); updateSyncUi();
      }
    };
  });
}

function updateSyncUi() {
  const s = sync.status;
  const logged = auth.isLoggedIn();
  const b = $('#btnSync');
  let ic = 'cloud_off';
  if (logged) ic = { idle: 'cloud_done', syncing: 'sync', error: 'error', login: 'cloud_off', offline: 'cloud_off' }[s.state] || 'cloud_done';
  b.innerHTML = icon(ic);
  b.classList.toggle('spin', s.state === 'syncing');
  b.title = statusText();
  $('#btnAccount').innerHTML = icon('account') + (!logged || s.state === 'login' || s.state === 'error' ? '<span class="dot"></span>' : '');
  const ban = $('#banner');
  if (!logged && !ls.get('bannerOff', false)) {
    ban.hidden = false;
    ban.innerHTML = `${icon('cloud_off')}<span>Sambungkan ke OneDrive supaya catatan tersinkron di HP & PC.</span><button class="btn primary" data-b="login">Login</button><button class="ib sm" data-b="x" title="Tutup">${icon('close')}</button>`;
  } else if (logged && s.state === 'login') {
    ban.hidden = false;
    ban.innerHTML = `${icon('cloud_off')}<span>Sesi OneDrive habis. Login lagi untuk melanjutkan sinkron.</span><button class="btn primary" data-b="relogin">Login</button>`;
  } else ban.hidden = true;
}
$('#banner').addEventListener('click', (e) => {
  const b = e.target.closest('[data-b]');
  if (!b) return;
  if (b.dataset.b === 'x') { ls.set('bannerOff', true); updateSyncUi(); }
  else auth.login();
});

function trySilentRelogin() {
  if (native || !navigator.onLine || ed) return false;
  const last = ls.get('silentAt', 0);
  if (Date.now() - last < 10 * 60 * 1000) return false;
  const acc = auth.account();
  if (!acc || !acc.email) return false;
  ls.set('silentAt', Date.now());
  auth.login(acc.email);
  return true;
}

sync.on(async (ev) => {
  if (ev.type === 'status') {
    updateSyncUi();
    if (ev.status.state === 'login' && auth.needsSilentRelogin()) trySilentRelogin();
  }
  if (ev.type === 'notes') {
    await loadNotes();
    if (ed && !ed.pending && ev.ids.includes(ed.note.id) && !$('#editor').contains(document.activeElement)) {
      const fresh = await db.getNote(ed.note.id);
      if (fresh && !fresh.deleted) { ed.note = JSON.parse(JSON.stringify(fresh)); ed.readonly = !!fresh.trashed; renderEditor(); }
    }
    render();
  }
  if (ev.type === 'blobs') { hydrate($('#sections')); if (ed) hydrate($('#editor')); hydrate($('#viewer')); }
});

// Dipanggil oleh APK setelah login native selesai.
window.BtuApp = {
  async onNativeLogin(ok, msg) {
    if (!ok) { if (msg) snack(msg); return; }
    sync.reset();
    try { auth.setAccount(await graph.me()); } catch { /* abaikan */ }
    updateSyncUi();
    sync.run();
    snack('Tersambung ke OneDrive');
  },
  onResume() { sync.run(); },
  // Teks yang dibagikan dari aplikasi lain (menu Share → BtuNote)
  onShare(title, text) {
    if (ed) closeEditor();
    const n = newNote({ title: title || '', text: text || '' });
    openEditor(n, { isNew: true });
    touch();
  },
};

// ======================= topbar & tombol baru =======================
$('#btnMenu').innerHTML = icon('menu');
$('#selClose').innerHTML = icon('close');
$('.search-ic').innerHTML = icon('search');
$('#btnClearSearch').innerHTML = icon('close');
$('#btnSearchMobile').innerHTML = icon('search');
$('#fab').innerHTML = icon('add');
$$('[data-new="list"]').forEach((b) => { b.innerHTML = icon('checkbox'); });
$$('[data-new="image"]').forEach((b) => { b.innerHTML = icon('image'); });

$('#btnMenu').onclick = () => {
  if (isMobile()) setDrawer(!document.body.classList.contains('drawer-open'));
  else setDrawer(document.body.classList.contains('mini'));
};
$('#scrim').onclick = () => setDrawer(false);
$('#btnLayout').onclick = () => { state.layout = state.layout === 'grid' ? 'list' : 'grid'; ls.set('layout', state.layout); render(); };
$('#btnSync').onclick = () => { if (auth.isLoggedIn()) { sync.run(); snack(statusText(), null, null, 2500); } else accountDialog(); };
$('#btnAccount').onclick = () => accountDialog();

const searchInp = $('#search');
searchInp.addEventListener('input', () => {
  state.q = searchInp.value.trim();
  $('#btnClearSearch').hidden = !searchInp.value;
  render();
});
$('#btnClearSearch').onclick = () => { searchInp.value = ''; state.q = ''; $('#btnClearSearch').hidden = true; render(); searchInp.focus(); };
function closeSearchPop() { document.body.classList.remove('searching'); searchInp.value = ''; state.q = ''; render(); }
$('#btnSearchMobile').onclick = () => {
  document.body.classList.add('searching');
  pushOverlay(closeSearchPop);
  searchInp.focus();
};
searchInp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (document.body.classList.contains('searching')) popOverlay(closeSearchPop), closeSearchPop(); else $('#btnClearSearch').click(); } });

function createNote(kind) {
  const extra = { kind };
  if (state.sec === 'label' && state.label) extra.labels = [state.label];
  if (kind === 'list') extra.items = [];
  const n = newNote(extra);
  openEditor(n, { isNew: true, focus: kind === 'list' ? 'text' : 'text' });
}
$('#fab').onclick = () => createNote('text');
$('#composer').addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return createNote('text');
  if (b.dataset.new === 'list') createNote('list');
  else { pickTarget = 'new'; $('#fileImage').click(); }
});
$('#bottombar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return;
  if (b.dataset.new === 'list') createNote('list');
  else { pickTarget = 'new'; $('#fileImage').click(); }
});

let rsT = null;
let lastMobile = isMobile();
addEventListener('resize', () => {
  clearTimeout(rsT);
  rsT = setTimeout(() => {
    if (isMobile() !== lastMobile) { lastMobile = isMobile(); document.body.classList.remove('drawer-open'); $('#scrim').hidden = true; }
    render();
  }, 120);
});

document.addEventListener('keydown', (e) => {
  if (ed || dlgClose || e.target.matches('input, textarea')) return;
  if (e.key === 'c' || e.key === 'n') { e.preventDefault(); createNote('text'); }
  if (e.key === 'l') { e.preventDefault(); createNote('list'); }
  if (e.key === '/') { e.preventDefault(); if (isMobile()) $('#btnSearchMobile').click(); else searchInp.focus(); }
});

// ======================= mulai =======================
async function start() {
  applyTheme();
  if (!isMobile() && ls.get('mini', false)) document.body.classList.add('mini');
  const r = await auth.handleRedirect();
  if (r.done && r.error) {
    if (r.error === 'LOGIN') snack('Sesi Microsoft berakhir, silakan login lagi', 'Login', () => auth.login(), 10000);
    else snack(`Login gagal: ${r.error}`, null, null, 8000);
  }
  if (!r.done && auth.needsSilentRelogin() && trySilentRelogin()) return;
  await loadNotes();
  render();
  updateSyncUi();
  if (auth.isLoggedIn()) {
    if (!auth.account()) graph.me().then((m) => { auth.setAccount(m); }).catch(() => {});
    if (r.done && !r.error) snack('Tersambung ke OneDrive');
  }
  sync.start();
  if (!native && 'serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
start();
