// Impor dari Google Keep (hasil Google Takeout: file .zip, atau file .json + lampiran yang sudah diekstrak).
import { readZip } from './zip.js';
import { newNote, storeBytes, uid } from './model.js';
import { db } from './db.js';

const COLOR = {
  DEFAULT: 'default', RED: 'red', ORANGE: 'orange', YELLOW: 'yellow', GREEN: 'green', TEAL: 'teal',
  BLUE: 'blue', CERULEAN: 'darkblue', PURPLE: 'purple', PINK: 'pink', BROWN: 'brown', GRAY: 'gray',
};

const base = (p) => p.split('/').pop();
const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();

// files: daftar File dari input. Mengembalikan jumlah note yang diimpor.
export async function importKeep(files, { label = '', onProgress } = {}) {
  // Kumpulkan semua entri (dari zip maupun file lepas)
  const entries = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
      entries.push(...await readZip(f));
    } else {
      entries.push({ name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) });
    }
  }
  const byName = new Map();
  const byStem = new Map();
  for (const e of entries) {
    byName.set(base(e.name).toLowerCase(), e);
    byStem.set(stem(base(e.name)), e);
  }
  const jsons = entries.filter((e) => /\.json$/i.test(e.name) && !/Labels\.txt$/i.test(e.name));
  if (!jsons.length) throw new Error('Tidak ada note Google Keep di file ini. Pilih file .zip dari Google Takeout.');

  const existing = new Set((await db.allNotes()).filter((n) => !n.deleted).map((n) => `${n.created}|${n.title}`));
  const td = new TextDecoder();
  const result = [];
  let skipped = 0;
  let i = 0;
  for (const e of jsons) {
    i++;
    let k;
    try { k = JSON.parse(td.decode(await e.read())); } catch { continue; }
    if (!k || typeof k !== 'object' || !('textContent' in k || 'listContent' in k || 'title' in k)) continue;
    if (k.isTrashed) { skipped++; continue; }
    const created = k.createdTimestampUsec ? Math.round(k.createdTimestampUsec / 1000) : Date.now();
    const updated = k.userEditedTimestampUsec ? Math.round(k.userEditedTimestampUsec / 1000) : created;
    const title = (k.title || '').trim();
    if (existing.has(`${created}|${title}`)) { skipped++; continue; } // sudah pernah diimpor

    const images = [];
    const atts = [];
    for (const a of k.attachments || []) {
      const fn = base(a.filePath || '');
      const ent = byName.get(fn.toLowerCase()) || byStem.get(stem(fn));
      if (!ent) continue;
      const data = await ent.read();
      const mime = a.mimetype || 'application/octet-stream';
      const realName = base(ent.name);
      const { name } = await storeBytes(data, mime, realName);
      if (mime.startsWith('image/')) images.push(name);
      else atts.push({ name, title: realName, mime, size: data.length });
    }

    let text = k.textContent || '';
    for (const an of k.annotations || []) {
      if (an.url && !text.includes(an.url)) text += `${text ? '\n' : ''}${an.title ? `${an.title} ` : ''}${an.url}`;
    }
    const isList = Array.isArray(k.listContent) && k.listContent.length > 0;
    const labels = (k.labels || []).map((l) => l.name).filter(Boolean);
    if (label) labels.push(label);
    const n = newNote({
      title,
      kind: isList ? 'list' : 'text',
      text: isList ? '' : text,
      items: isList ? k.listContent.map((it) => ({ id: uid(), text: it.text || '', done: !!it.isChecked })) : [],
      color: COLOR[k.color] || 'default',
      pinned: !!k.isPinned,
      archived: !!k.isArchived,
      labels, images, files: atts, created, updated,
    });
    if (isList) n.items = [...n.items.filter((x) => !x.done), ...n.items.filter((x) => x.done)];
    result.push(n);
    existing.add(`${created}|${title}`);
    if (onProgress) onProgress(i, jsons.length);
  }
  await db.putNotes(result);
  return { count: result.length, skipped };
}
