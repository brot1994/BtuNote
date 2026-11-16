// Bentuk data note + lampiran.
import { md5 } from './md5.js';
import { db } from './db.js';

export const COLORS = [
  { id: 'default', name: 'Default' },
  { id: 'red', name: 'Merah' },
  { id: 'orange', name: 'Oranye' },
  { id: 'yellow', name: 'Kuning' },
  { id: 'green', name: 'Hijau' },
  { id: 'teal', name: 'Toska' },
  { id: 'blue', name: 'Biru' },
  { id: 'darkblue', name: 'Biru tua' },
  { id: 'purple', name: 'Ungu' },
  { id: 'pink', name: 'Merah muda' },
  { id: 'brown', name: 'Cokelat' },
  { id: 'gray', name: 'Abu-abu' },
];

export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Date.now().toString(36) + Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

export function newNote(extra = {}) {
  const now = Date.now();
  return cleanNote({ id: uid(), created: now, updated: now, ...extra, dirty: true, rev: null });
}

const FIELDS = ['id', 'title', 'text', 'kind', 'items', 'color', 'pinned', 'archived', 'trashed',
  'labels', 'images', 'files', 'created', 'updated', 'deleted'];

// Rapikan objek dari sumber mana pun (OneDrive / impor) jadi note yang valid.
export function cleanNote(o) {
  if (o.deleted) return { id: o.id, deleted: true, created: o.created || 0, updated: o.updated || 0, rev: o.rev || null, dirty: !!o.dirty };
  return {
    id: o.id,
    title: o.title || '',
    text: o.text || '',
    kind: o.kind === 'list' ? 'list' : 'text',
    items: Array.isArray(o.items) ? o.items.map((i) => ({ id: i.id || uid(), text: i.text || '', done: !!i.done })) : [],
    color: o.color || 'default',
    pinned: !!o.pinned,
    archived: !!o.archived,
    trashed: o.trashed || 0,
    labels: Array.isArray(o.labels) ? [...new Set(o.labels.filter(Boolean))] : [],
    images: Array.isArray(o.images) ? o.images : [],
    files: Array.isArray(o.files) ? o.files : [],
    created: o.created || Date.now(),
    updated: o.updated || Date.now(),
    deleted: false,
    rev: o.rev || null,
    dirty: !!o.dirty,
  };
}

// Bagian yang disimpan di OneDrive (tanpa info sinkron lokal).
export function toRemote(n) {
  const o = {};
  for (const k of FIELDS) if (n[k] !== undefined) o[k] = n[k];
  return o;
}

export function isEmpty(n) {
  return !n.title.trim() && !n.text.trim() && !n.items.some((i) => i.text.trim()) &&
    !n.images.length && !n.files.length;
}

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
  'image/bmp': 'bmp', 'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4', 'text/plain': 'txt',
};
export function extFor(mime, fileName) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(fileName || '');
  if (m) return m[1].toLowerCase();
  return EXT[mime] || 'bin';
}

// Simpan bytes sebagai blob lokal; nama = md5.ext (sama dengan hash en-media di ENEX).
export async function storeBytes(bytes, mime, fileName) {
  const hash = md5(bytes);
  const name = `${hash}.${extFor(mime, fileName)}`;
  if (!(await db.getBlob(name))) {
    await db.putBlob({ name, blob: new Blob([bytes], { type: mime || 'application/octet-stream' }), uploaded: false });
  }
  return { name, hash };
}

// Gambar dari kamera/galeri: perkecil ke maks 2000 px supaya ringan disinkron.
export async function storeImageFile(file) {
  let blob = file;
  try {
    if (/^image\/(jpeg|png|webp|heic)/.test(file.type) && file.size > 500 * 1024) {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    }
  } catch { blob = file; }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return (await storeBytes(bytes, blob.type || 'image/jpeg', blob === file ? file.name : 'foto.jpg')).name;
}

export function hashOf(name) { return name.split('.')[0]; }
