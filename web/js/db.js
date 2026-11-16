// Penyimpanan lokal (IndexedDB): notes, blobs (gambar/lampiran), meta.
const DB_NAME = 'btunote';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('blobs', { keyPath: 'name' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function store(name, mode = 'readonly') {
  const d = await open();
  return d.transaction(name, mode).objectStore(name);
}

export const db = {
  async allNotes() { return req((await store('notes')).getAll()); },
  async getNote(id) { return req((await store('notes')).get(id)); },
  async putNote(n) { return req((await store('notes', 'readwrite')).put(n)); },
  async putNotes(list) {
    const d = await open();
    const tx = d.transaction('notes', 'readwrite');
    const s = tx.objectStore('notes');
    for (const n of list) s.put(n);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
  async delNote(id) { return req((await store('notes', 'readwrite')).delete(id)); },

  async getBlob(name) { return req((await store('blobs')).get(name)); },
  async putBlob(b) { return req((await store('blobs', 'readwrite')).put(b)); },
  async allBlobKeys() { return req((await store('blobs')).getAllKeys()); },
  async allBlobs() { return req((await store('blobs')).getAll()); },
  async delBlob(name) { return req((await store('blobs', 'readwrite')).delete(name)); },

  async meta(key, def = null) {
    const v = await req((await store('meta')).get(key));
    return v === undefined ? def : v;
  },
  async setMeta(key, val) { return req((await store('meta', 'readwrite')).put(val, key)); },
};
