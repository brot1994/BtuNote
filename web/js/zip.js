// Pembaca file .zip sederhana (tanpa library), membaca per bagian supaya zip besar tidak dimuat sekaligus.
const td = new TextDecoder();

async function bytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Mengembalikan [{name, size, read: () => Promise<Uint8Array>}]
export async function readZip(file) {
  const tailLen = Math.min(file.size, 66000);
  const tail = await bytes(file, file.size - tailLen, file.size);
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('File ini bukan .zip yang valid.');
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  // ZIP64
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('Format zip tidak didukung.');
    const z64off = Number(dv.getBigUint64(loc + 8, true));
    const z = new DataView((await bytes(file, z64off, z64off + 56)).buffer);
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = await bytes(file, cdOff, cdOff + cdSize);
  const c = new DataView(cd.buffer);
  const out = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (c.getUint32(p, true) !== 0x02014b50) break;
    const method = c.getUint16(p + 10, true);
    let csize = c.getUint32(p + 20, true);
    let usize = c.getUint32(p + 24, true);
    const nlen = c.getUint16(p + 28, true);
    const elen = c.getUint16(p + 30, true);
    const clen = c.getUint16(p + 32, true);
    let off = c.getUint32(p + 42, true);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nlen));
    // extra field ZIP64
    let e = p + 46 + nlen;
    const eEnd = e + elen;
    while (e + 4 <= eEnd) {
      const id = c.getUint16(e, true);
      const sz = c.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(c.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(c.getBigUint64(q, true)); q += 8; }
        if (off === 0xffffffff) { off = Number(c.getBigUint64(q, true)); }
      }
      e += 4 + sz;
    }
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    const entry = {
      name, size: usize,
      async read() {
        const h = new DataView((await bytes(file, off, off + 30)).buffer);
        const start = off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
        const data = await bytes(file, start, start + csize);
        if (method === 0) return data;
        if (method === 8) return inflate(data);
        throw new Error(`Metode kompresi ${method} tidak didukung (${name})`);
      },
    };
    out.push(entry);
  }
  return out;
}
