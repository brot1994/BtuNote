// Impor & ekspor file Evernote (.enex).
import { md5 } from './md5.js';
import { newNote, storeBytes, uid, hashOf } from './model.js';
import { db } from './db.js';

// ---------- util ----------
function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function parseDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec((s || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const childText = (el, tag) => { const c = el.getElementsByTagName(tag)[0]; return c ? c.textContent : ''; };

// ---------- ENML -> teks ----------
const TODO = '\u0001';
const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre',
  'section', 'article', 'header', 'footer', 'table', 'ul', 'ol', 'dl', 'dt', 'dd', 'en-note', 'center']);

function enmlToLines(enml, media) {
  const fixed = enml
    .replace(/<\?xml[^>]*\?>/i, '').replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<(en-todo|en-media|en-crypt)([^>]*?)\/>/gi, '<$1$2></$1>');
  const doc = new DOMParser().parseFromString(`<body>${fixed}</body>`, 'text/html');
  let out = '';
  const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };

  function walk(node, ctx) {
    if (node.nodeType === 3) { out += node.nodeValue.replace(/[\r\n\t]+/g, ' ').replace(/ /g, ' '); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    const style = (node.getAttribute('style') || '').replace(/\s/g, '');
    if (tag === 'br') { out += '\n'; return; }
    if (tag === 'hr') { nl(); out += '———\n'; return; }
    if (tag === 'en-todo') { out += TODO + (node.getAttribute('checked') === 'true' ? 'x' : ' '); return; }
    if (tag === 'en-media') { media.push(node.getAttribute('hash')); return; }
    if (tag === 'en-crypt') { out += '[teks terenkripsi Evernote]'; return; }
    if (tag === 'script' || tag === 'style') return;
    const block = BLOCK.has(tag);
    if (block) nl();
    let c = ctx;
    if (tag === 'ul' || tag === 'ol') c = { list: tag, todo: style.includes('--en-todo:true'), n: 0 };
    if (tag === 'li' && ctx && ctx.list) {
      if (ctx.todo) out += TODO + (style.includes('--en-checked:true') ? 'x' : ' ');
      else out += ctx.list === 'ol' ? `${++ctx.n}. ` : '• ';
    }
    for (const ch of node.childNodes) walk(ch, c);
    if (tag === 'td' || tag === 'th') out += ' | ';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (href && !href.startsWith('evernote:') && !node.textContent.includes(href)) out += ` (${href})`;
    }
    if (block) nl();
  }
  walk(doc.body, null);
  const lines = out.split('\n').map((l) => l.replace(/ \| $/, '').replace(/[ ]+$/, ''));
  // rapikan baris kosong berlebih
  const res = [];
  for (const l of lines) {
    if (!l.trim() && (!res.length || !res[res.length - 1].trim())) continue;
    res.push(l);
  }
  while (res.length && !res[res.length - 1].trim()) res.pop();
  return res;
}

// ---------- impor ----------
export async function importEnex(text, { label = '', onProgress } = {}) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('File .enex tidak bisa dibaca (format rusak).');
  const notesEl = [...xml.getElementsByTagName('note')];
  if (!notesEl.length) throw new Error('Tidak ada note di file ini.');
  const result = [];
  let i = 0;
  for (const el of notesEl) {
    // lampiran
    const byHash = new Map();
    for (const r of el.getElementsByTagName('resource')) {
      const dataEl = r.getElementsByTagName('data')[0];
      if (!dataEl) continue;
      const bytes = b64ToBytes(dataEl.textContent);
      const mime = childText(r, 'mime') || 'application/octet-stream';
      const fileName = childText(r, 'file-name');
      const { name, hash } = await storeBytes(bytes, mime, fileName);
      byHash.set(hash, { name, mime, fileName, size: bytes.length });
    }
    const media = [];
    const lines = enmlToLines(childText(el, 'content'), media);
    const images = [];
    const files = [];
    const used = new Set();
    const addRes = (r) => {
      if (!r || used.has(r.name)) return;
      used.add(r.name);
      if (r.mime.startsWith('image/')) images.push(r.name);
      else files.push({ name: r.name, title: r.fileName || r.name, mime: r.mime, size: r.size });
    };
    media.forEach((h) => addRes(byHash.get(h)));
    byHash.forEach((r) => addRes(r)); // lampiran yang tidak dirujuk di isi

    const nonEmpty = lines.filter((l) => l.trim());
    const todos = nonEmpty.filter((l) => l.startsWith(TODO));
    let kind = 'text';
    let body = '';
    let items = [];
    if (todos.length && todos.length === nonEmpty.length) {
      kind = 'list';
      items = todos.map((l) => ({ id: uid(), done: l[1] === 'x', text: l.slice(2).trim() }));
    } else {
      body = lines.map((l) => (l.startsWith(TODO) ? (l[1] === 'x' ? '☑ ' : '☐ ') + l.slice(2).trim() : l)).join('\n');
    }
    const tags = [...el.getElementsByTagName('tag')].map((t) => t.textContent.trim()).filter(Boolean);
    if (label) tags.push(label);
    const created = parseDate(childText(el, 'created')) || Date.now();
    const updated = parseDate(childText(el, 'updated')) || created;
    const n = newNote({ title: childText(el, 'title').trim(), text: body, kind, items, labels: tags, images, files, created, updated });
    result.push(n);
    if (onProgress) onProgress(++i, notesEl.length);
  }
  await db.putNotes(result);
  return result;
}

// ---------- ekspor ----------
async function blobBytes(name) {
  const b = await db.getBlob(name);
  return b ? { bytes: new Uint8Array(await b.blob.arrayBuffer()), mime: b.blob.type || 'application/octet-stream' } : null;
}

export async function exportEnex(notes) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n');
  parts.push(`<en-export export-date="${fmtDate(Date.now())}" application="BtuNote" version="0.1">\n`);
  let missing = 0;
  for (const n of notes) {
    const res = [];
    const mediaTag = async (name, title) => {
      const b = await blobBytes(name);
      if (!b) { missing++; return ''; }
      const hash = md5(b.bytes);
      res.push({ ...b, hash, title });
      return `<div><en-media type="${esc(b.mime)}" hash="${hash}"/></div>`;
    };
    let body = '';
    for (const img of n.images) body += await mediaTag(img, '');
    if (n.kind === 'list') {
      for (const it of n.items) body += `<div><en-todo checked="${it.done ? 'true' : 'false'}"/>${esc(it.text)}</div>`;
    } else {
      for (const line of n.text.split('\n')) body += line ? `<div>${esc(line)}</div>` : '<div><br/></div>';
    }
    for (const f of n.files) body += await mediaTag(f.name, f.title);
    const enml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${body}</en-note>`;
    parts.push('<note>');
    parts.push(`<title>${esc(n.title || 'Tanpa judul')}</title>`);
    parts.push(`<content><![CDATA[${enml}]]></content>`);
    parts.push(`<created>${fmtDate(n.created)}</created><updated>${fmtDate(n.updated)}</updated>`);
    for (const t of n.labels) parts.push(`<tag>${esc(t)}</tag>`);
    for (const r of res) {
      parts.push(`<resource><data encoding="base64">${bytesToB64(r.bytes)}</data><mime>${esc(r.mime)}</mime>`);
      parts.push(`<resource-attributes><file-name>${esc(r.title || `${r.hash}`)}</file-name></resource-attributes></resource>`);
    }
    parts.push('</note>\n');
  }
  parts.push('</en-export>\n');
  return { blob: new Blob(parts, { type: 'application/enex+xml' }), missing };
}

export { hashOf };
