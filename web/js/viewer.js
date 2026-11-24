// Penampil gambar & PDF layar penuh dengan cubit-zoom (pinch), geser, ketuk dua kali, dan roda mouse.

// ---------- zoom & geser ----------
function zoomPan(box, el, baseSize, onChange) {
  let s = 1; let tx = 0; let ty = 0;
  const pts = new Map();
  let pinch = null;
  let vel = { x: 0, y: 0, t: 0 };
  let raf = 0;
  let lastTap = { t: 0, x: 0, y: 0 };
  let down = null;

  const rect = () => box.getBoundingClientRect();
  function clamp() {
    const { w, h } = baseSize();
    const W = w * s; const H = h * s;
    const vw = box.clientWidth; const vh = box.clientHeight;
    tx = W <= vw ? (vw - W) / 2 : Math.min(0, Math.max(vw - W, tx));
    ty = H <= vh ? (vh - H) / 2 : Math.min(0, Math.max(vh - H, ty));
  }
  function apply() {
    clamp();
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    if (onChange) onChange({ s, tx, ty });
  }
  function zoomAt(ns, cx, cy) {
    ns = Math.max(1, Math.min(8, ns));
    tx = cx - ((cx - tx) * ns) / s;
    ty = cy - ((cy - ty) * ns) / s;
    s = ns;
    apply();
  }
  function animateZoom(target, cx, cy) {
    cancelAnimationFrame(raf);
    const s0 = s; const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 220);
      const e = 1 - (1 - k) ** 3;
      zoomAt(s0 + (target - s0) * e, cx, cy);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function fling() {
    cancelAnimationFrame(raf);
    let vx = vel.x * 16; let vy = vel.y * 16;
    const step = () => {
      vx *= 0.94; vy *= 0.94;
      if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) return;
      tx += vx; ty += vy;
      apply();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    cancelAnimationFrame(raf);
    box.setPointerCapture(e.pointerId);
    const r = rect();
    pts.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (pts.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      if (down) down.moved = true;
    }
    vel = { x: 0, y: 0, t: performance.now() };
  });
  box.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const r = rect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, p);
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
      tx += mx - pinch.mx; ty += my - pinch.my;
      zoomAt(s * (d / (pinch.d || d)), mx, my);
      pinch = { d, mx, my };
    } else if (pts.size === 1) {
      const dx = p.x - prev.x; const dy = p.y - prev.y;
      tx += dx; ty += dy;
      const now = performance.now();
      const dt = Math.max(1, now - vel.t);
      vel = { x: 0.7 * (dx / dt) + 0.3 * vel.x, y: 0.7 * (dy / dt) + 0.3 * vel.y, t: now };
      apply();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { // satu jari masih menempel setelah pinch
      vel = { x: 0, y: 0, t: performance.now() };
      return;
    }
    if (pts.size) return;
    const now = performance.now();
    if (down && !down.moved && now - down.t < 300) {
      const r = rect();
      const x = e.clientX - r.left; const y = e.clientY - r.top;
      if (now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
        animateZoom(s > 1.2 ? 1 : 2.5, x, y);
        lastTap = { t: 0, x: 0, y: 0 };
      } else lastTap = { t: now, x, y };
    } else if (now - vel.t < 80) fling();
    down = null;
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    const r = rect();
    if (e.ctrlKey || e.metaKey) zoomAt(s * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { tx -= e.deltaX; ty -= e.deltaY; apply(); }
  }, { passive: false });

  const ro = new ResizeObserver(() => apply());
  ro.observe(box);
  apply();
  return {
    get state() { return { s, tx, ty }; },
    zoomBy(k) { zoomAt(s * k, box.clientWidth / 2, box.clientHeight / 2); },
    reset() { s = 1; tx = 0; ty = 0; apply(); },
    refresh: apply,
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); },
  };
}

// ---------- gambar ----------
export function showImage(v, url) {
  v.innerHTML = '<div class="vbox"><img class="vimg" alt="" draggable="false"></div>';
  const box = v.querySelector('.vbox');
  const img = v.querySelector('.vimg');
  let size = { w: 1, h: 1 };
  const fit = () => {
    const nw = img.naturalWidth || 1; const nh = img.naturalHeight || 1;
    const k = Math.min(box.clientWidth / nw, box.clientHeight / nh);
    size = { w: nw * k, h: nh * k };
    img.style.width = `${size.w}px`;
    img.style.height = `${size.h}px`;
  };
  const zp = zoomPan(box, img, () => size);
  img.onload = () => { fit(); zp.reset(); };
  new ResizeObserver(() => { fit(); zp.refresh(); }).observe(box);
  img.src = url;
  return zp;
}

// ---------- PDF ----------
let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('../lib/pdfjs/pdf.min.js').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return m;
    });
  }
  return pdfjsP;
}

export async function showPdf(v, blob, onInfo) {
  v.innerHTML = '<div class="vbox"><div class="vpages"></div></div><div class="vmsg">Membuka PDF…</div>';
  const box = v.querySelector('.vbox');
  const wrap = v.querySelector('.vpages');
  const msg = v.querySelector('.vmsg');
  let doc;
  try {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await blob.arrayBuffer());
    doc = await pdfjs.getDocument({
      data, standardFontDataUrl: new URL('../lib/pdfjs/standard_fonts/', import.meta.url).href,
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    msg.textContent = e && e.name === 'PasswordException' ? 'PDF ini dikunci password, buka di aplikasi lain.' : `PDF tidak bisa dibuka: ${e.message || e}`;
    return null;
  }
  const GAP = 10;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas');
    c.className = 'vpage';
    wrap.appendChild(c);
    pages.push({ p, w: vp.width, h: vp.height, c, top: 0, hgt: 0, rs: 0, task: null });
  }
  msg.hidden = true;
  let size = { w: 1, h: 1 };
  let zp = null;
  const layout = () => {
    const bw = Math.min(box.clientWidth - (box.clientWidth > 700 ? 48 : 0), 1000);
    let y = 0;
    for (const pg of pages) {
      pg.top = y;
      pg.hgt = (bw * pg.h) / pg.w;
      Object.assign(pg.c.style, { left: '0px', top: `${y}px`, width: `${bw}px`, height: `${pg.hgt}px` });
      y += pg.hgt + GAP;
    }
    size = { w: bw, h: Math.max(1, y - GAP) };
    wrap.style.width = `${size.w}px`;
    wrap.style.height = `${size.h}px`;
    for (const pg of pages) pg.rs = 0; // perlu dirender ulang
  };

  let timer = null;
  let busy = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  async function renderVisible() {
    if (busy) { timer = setTimeout(renderVisible, 120); return; }
    busy = true;
    try {
      const { s, ty } = zp.state;
      const vh = box.clientHeight;
      const vis = pages.filter((pg) => pg.top * s + ty < vh * 1.5 && (pg.top + pg.hgt) * s + ty > -vh * 0.5);
      const cur = pages.findIndex((pg) => (pg.top + pg.hgt) * s + ty > vh * 0.3);
      if (onInfo) onInfo(`${Math.max(1, cur + 1)} / ${pages.length}`);
      // buang render halaman yang jauh supaya hemat memori
      for (const pg of pages) {
        if (!vis.includes(pg) && pg.rs) { pg.c.width = 1; pg.c.height = 1; pg.rs = 0; }
      }
      for (const pg of vis) {
        const cssW = parseFloat(pg.c.style.width);
        let target = (cssW * s * dpr) / pg.w;
        const maxPx = 4096 / Math.max(pg.w, pg.h);
        target = Math.min(target, maxPx);
        if (pg.rs && Math.abs(pg.rs - target) / target < 0.25) continue;
        const vp = pg.p.getViewport({ scale: target });
        const off = document.createElement('canvas');
        off.width = Math.floor(vp.width);
        off.height = Math.floor(vp.height);
        pg.task = pg.p.render({ canvasContext: off.getContext('2d'), viewport: vp });
        try { await pg.task.promise; } catch { continue; }
        pg.c.width = off.width; pg.c.height = off.height;
        pg.c.getContext('2d').drawImage(off, 0, 0);
        pg.rs = target;
      }
    } finally { busy = false; }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(renderVisible, 140); };
  layout();
  zp = zoomPan(box, wrap, () => size, schedule);
  new ResizeObserver(() => { layout(); zp.refresh(); schedule(); }).observe(box);
  renderVisible();
  return { zp, destroy() { clearTimeout(timer); zp.destroy(); doc.destroy(); } };
}
