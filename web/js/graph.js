// Akses OneDrive lewat Microsoft Graph.
import { auth } from './auth.js';
import { ROOT } from './config.js';

const G = 'https://graph.microsoft.com/v1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function call(path, opts = {}, attempt = 0) {
  const token = await auth.getToken();
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  let r;
  try {
    r = await fetch(path.startsWith('http') ? path : G + path, { ...opts, headers });
  } catch (e) {
    throw new HttpError(0, 'Tidak ada koneksi');
  }
  if ((r.status === 429 || r.status === 503 || r.status === 504) && attempt < 4) {
    const wait = (parseInt(r.headers.get('Retry-After') || '0', 10) || 2 ** attempt) * 1000;
    await sleep(Math.min(wait, 30000));
    return call(path, opts, attempt + 1);
  }
  if (!r.ok) {
    let msg = `OneDrive error ${r.status}`;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* abaikan */ }
    throw new HttpError(r.status, msg);
  }
  return r;
}

const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
const itemPath = (rel) => `/me/drive/root:/${enc(`${ROOT}/${rel}`)}`;

async function ensureFolder(parentRel, name) {
  const parent = parentRel ? `/me/drive/root:/${enc(parentRel)}:/children` : '/me/drive/root/children';
  try {
    await call(parent, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
  } catch (e) {
    if (e.status !== 409) throw e; // 409 = sudah ada
  }
}

async function listAll(url) {
  const out = [];
  let next = url;
  while (next) {
    const j = await (await call(next)).json();
    out.push(...j.value);
    next = j['@odata.nextLink'] || null;
  }
  return out;
}

export const graph = {
  async me() {
    const j = await (await call('/me?$select=displayName,userPrincipalName')).json();
    return { name: j.displayName, email: j.userPrincipalName };
  },

  async ensureFolders() {
    await ensureFolder('', ROOT);
    await ensureFolder(ROOT, 'notes');
    await ensureFolder(ROOT, 'files');
  },

  // Daftar file note di OneDrive: [{name, eTag, url}]
  async listNotes() {
    const items = await listAll(`${itemPath('notes')}:/children?$top=999`);
    return items.filter((i) => i.file && i.name.endsWith('.json')).map((i) => ({
      name: i.name, eTag: i.eTag, url: i['@microsoft.graph.downloadUrl'],
    }));
  },

  async listFiles() {
    const items = await listAll(`${itemPath('files')}:/children?$top=999&$select=name,size`);
    return new Set(items.map((i) => i.name));
  },

  async download(url) {
    const r = await fetch(url);
    if (!r.ok) throw new HttpError(r.status, `Gagal unduh (${r.status})`);
    return r;
  },

  async downloadFile(name) {
    // Ambil info file lengkap (tanpa $select) supaya link unduhan pasti ikut
    const j = await (await call(itemPath(`files/${name}`))).json();
    const url = j['@microsoft.graph.downloadUrl'];
    if (url) return (await graph.download(url)).blob();
    return (await call(`${itemPath(`files/${name}`)}:/content`)).blob();
  },

  async getNote(id) {
    const j = await (await call(itemPath(`notes/${id}.json`))).json();
    const url = j['@microsoft.graph.downloadUrl'];
    const obj = await (url ? await graph.download(url) : await call(`${itemPath(`notes/${id}.json`)}:/content`)).json();
    return { obj, eTag: j.eTag };
  },

  // Simpan note. ifMatch = eTag lama (null untuk note baru). Lempar HttpError 412 kalau bentrok.
  async putNote(id, obj, ifMatch) {
    const headers = { 'Content-Type': 'application/json' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    const r = await call(`${itemPath(`notes/${id}.json`)}:/content`, {
      method: 'PUT', headers, body: JSON.stringify(obj),
    });
    const j = await r.json();
    return j.eTag;
  },

  async uploadFile(name, blob) {
    if (blob.size <= 4 * 1024 * 1024) {
      await call(`${itemPath(`files/${name}`)}:/content`, {
        method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
      });
      return;
    }
    // File besar: upload session per potongan 5 MB (kelipatan 320 KiB)
    const s = await (await call(`${itemPath(`files/${name}`)}:/createUploadSession`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    })).json();
    const CH = 320 * 1024 * 16;
    for (let start = 0; start < blob.size; start += CH) {
      const end = Math.min(start + CH, blob.size);
      const r = await fetch(s.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` },
        body: blob.slice(start, end),
      });
      if (!r.ok) throw new HttpError(r.status, `Upload gagal (${r.status})`);
    }
  },
};
