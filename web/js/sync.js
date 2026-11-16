// Sinkronisasi note lokal <-> folder BtuNote di OneDrive.
// Tiap note = 1 file JSON (notes/<id>.json). Gambar/lampiran = files/<md5>.<ext>.
import { db } from './db.js';
import { graph, HttpError } from './graph.js';
import { auth, AuthError } from './auth.js';
import { POLL_MS, TRASH_DAYS } from './config.js';
import { uid, toRemote, cleanNote } from './model.js';

const listeners = new Set();
let status = { state: 'off', msg: '', last: 0 };
let running = false;
let again = false;
let timer = null;
let foldersOk = false;

function setStatus(state, msg = '') {
  status = { ...status, state, msg };
  if (state === 'idle') status.last = Date.now();
  for (const f of listeners) f({ type: 'status', status });
}
function emitChanged(ids) { for (const f of listeners) f({ type: 'notes', ids }); }

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

function sameContent(a, b) {
  return JSON.stringify(toRemote(a)) === JSON.stringify(toRemote(b));
}

async function purgeTrash() {
  const limit = Date.now() - TRASH_DAYS * 864e5;
  const old = (await db.allNotes()).filter((n) => !n.deleted && n.trashed && n.trashed < limit);
  for (const n of old) await db.putNote(tombstone(n));
  if (old.length) emitChanged(old.map((n) => n.id));
}

export function tombstone(n) {
  return { id: n.id, deleted: true, updated: Date.now(), created: n.created, rev: n.rev || null, dirty: true };
}

async function pushBlobs(names) {
  let remote = null;
  for (const name of names) {
    const b = await db.getBlob(name);
    if (!b || b.uploaded) continue;
    if (!remote) remote = await graph.listFiles();
    if (!remote.has(name)) await graph.uploadFile(name, b.blob);
    b.uploaded = true;
    await db.putBlob(b);
  }
}

async function push() {
  const dirty = (await db.allNotes()).filter((n) => n.dirty);
  if (!dirty.length) return;
  const blobNames = new Set();
  for (const n of dirty) {
    (n.images || []).forEach((x) => blobNames.add(x));
    (n.files || []).forEach((f) => blobNames.add(f.name));
  }
  await pushBlobs([...blobNames]);
  const changed = [];
  for (const n of dirty) {
    // Ambil versi terbaru dari DB (mungkin diedit lagi saat upload)
    const cur = await db.getNote(n.id);
    if (!cur || !cur.dirty) continue;
    if (cur.deleted && !cur.rev) { await db.delNote(cur.id); continue; } // belum pernah diunggah
    const snapshot = JSON.stringify(toRemote(cur));
    try {
      const eTag = await graph.putNote(cur.id, toRemote(cur), cur.rev);
      const latest = await db.getNote(cur.id);
      latest.rev = eTag;
      if (JSON.stringify(toRemote(latest)) === snapshot) latest.dirty = false;
      await db.putNote(latest);
    } catch (e) {
      if (e.status === 412 || e.status === 409) {
        await resolveConflict(cur);
        changed.push(cur.id);
      } else throw e;
    }
  }
  if (changed.length) emitChanged(changed);
}

async function resolveConflict(local) {
  const { obj: remote, eTag } = await graph.getNote(local.id);
  if (remote.deleted || local.deleted || sameContent(local, remote)) {
    // Hapus menang atas hapus; isi sama -> cukup samakan versi; note dihapus di tempat lain tapi diedit di sini -> pakai yang lokal
    local.rev = eTag;
    if (local.deleted && remote.deleted) local.dirty = false;
    await db.putNote(local);
    return;
  }
  // Dua-duanya berubah: simpan versi lokal sebagai salinan, versi OneDrive jadi note asli
  const copy = { ...local, id: uid(), rev: null, dirty: true, created: Date.now(),
    title: `${local.title || ''} (konflik)`.trim() };
  await db.putNote(copy);
  await db.putNote({ ...cleanNote(remote), rev: eTag, dirty: false });
}

async function pull() {
  const remote = await graph.listNotes();
  const local = new Map((await db.allNotes()).map((n) => [n.id, n]));
  const todo = remote.filter((r) => {
    const id = r.name.slice(0, -5);
    const l = local.get(id);
    return !l || (l.rev !== r.eTag && !l.dirty);
  });
  const changed = [];
  await pool(todo, 6, async (r) => {
    const id = r.name.slice(0, -5);
    const obj = await (await graph.download(r.url)).json();
    const cur = await db.getNote(id);
    if (cur && cur.dirty) return; // diedit saat mengunduh, biar push yang menangani
    await db.putNote({ ...cleanNote({ ...obj, id }), rev: r.eTag, dirty: false });
    changed.push(id);
  });
  // Note yang hilang dari OneDrive (dihapus manual di sana): unggah ulang
  const remoteIds = new Set(remote.map((r) => r.name.slice(0, -5)));
  for (const l of local.values()) {
    if (l.rev && !remoteIds.has(l.id) && !l.deleted) { l.rev = null; l.dirty = true; await db.putNote(l); }
  }
  if (changed.length) emitChanged(changed);
}

async function pullBlobs() {
  const have = new Set(await db.allBlobKeys());
  const need = new Set();
  for (const n of await db.allNotes()) {
    if (n.deleted) continue;
    (n.images || []).forEach((x) => { if (!have.has(x)) need.add(x); });
    (n.files || []).forEach((f) => { if (!have.has(f.name)) need.add(f.name); });
  }
  if (!need.size) return;
  let got = 0;
  await pool([...need], 3, async (name) => {
    try {
      const blob = await graph.downloadFile(name);
      await db.putBlob({ name, blob, uploaded: true });
      got++;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  });
  if (got) for (const f of listeners) f({ type: 'blobs' });
}

async function runOnce() {
  if (!auth.isLoggedIn()) { setStatus('off'); return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  setStatus('syncing');
  try {
    if (!foldersOk) { await graph.ensureFolders(); foldersOk = true; }
    await purgeTrash();
    await push();
    await pull();
    await push(); // salinan konflik / unggah ulang
    setStatus('idle');
    pullBlobs().catch((e) => console.warn('blob', e));
  } catch (e) {
    console.warn('sync', e);
    if (e instanceof AuthError) setStatus('login', e.message);
    else if (e instanceof HttpError && e.status === 0) setStatus('offline');
    else setStatus('error', e.message || String(e));
  }
}

export const sync = {
  on(f) { listeners.add(f); return () => listeners.delete(f); },
  get status() { return status; },

  async run() {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await runOnce(); } while (again);
    } finally { running = false; }
  },

  // Dipanggil setelah ada perubahan lokal
  soon() {
    clearTimeout(sync._t);
    sync._t = setTimeout(() => sync.run(), 1500);
  },

  start() {
    if (timer) return;
    const tick = () => { if (document.visibilityState === 'visible') sync.run(); };
    timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('online', () => sync.run());
    window.addEventListener('focus', tick);
    sync.run();
  },

  reset() { foldersOk = false; setStatus(auth.isLoggedIn() ? 'idle' : 'off'); },
};
