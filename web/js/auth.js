// Login Microsoft (OneDrive).
// - Di browser/PC: alur "authorization code + PKCE" (SPA).
// - Di APK Android: login ditangani native (device code), token diambil lewat jembatan BtuNative.
import { CLIENT_ID, TENANT_ID, SCOPES } from './config.js';

const BASE = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0`;
const LS = 'btunote.auth';
const native = typeof window !== 'undefined' && window.BtuNative ? window.BtuNative : null;

export class AuthError extends Error {
  constructor(msg) { super(msg); this.needLogin = true; }
}

function redirectUri() { return location.origin + location.pathname; }

function load() { try { return JSON.parse(localStorage.getItem(LS)) || null; } catch { return null; } }
function save(v) { if (v) localStorage.setItem(LS, JSON.stringify(v)); else localStorage.removeItem(LS); }

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomStr(n = 48) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function challenge(v) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return b64url(new Uint8Array(h));
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES, ...params });
  const r = await fetch(`${BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description ? j.error_description.split('\n')[0] : `Login gagal (${r.status})`);
    e.code = j.error;
    throw e;
  }
  return j;
}

function storeTokens(j, prev = {}) {
  const v = {
    ...prev,
    at: j.access_token,
    exp: Date.now() + (j.expires_in - 120) * 1000,
    rt: j.refresh_token || prev.rt,
  };
  save(v);
  return v;
}

// ---- jembatan native ----
let cbSeq = 0;
const cbs = new Map();
window.__btuNativeCb = (id, token, err) => {
  const p = cbs.get(id);
  if (!p) return;
  cbs.delete(id);
  if (token) p.resolve(token);
  else if (err === 'LOGIN') p.reject(new AuthError('Perlu login ulang'));
  else p.reject(new Error(err || 'Gagal mengambil token'));
};

export const auth = {
  native: !!native,

  isLoggedIn() {
    if (native) return native.isLoggedIn() === 'true';
    const v = load();
    return !!(v && (v.rt || v.at));
  },

  account() {
    const v = load();
    return v && v.user ? v.user : null;
  },
  setAccount(user) {
    const v = load() || {};
    v.user = user;
    save(v);
  },

  async login(hint) {
    if (native) { native.login(); return; }
    const verifier = randomStr();
    const state = randomStr(16);
    sessionStorage.setItem('btunote.pkce', JSON.stringify({ verifier, state }));
    const p = new URLSearchParams({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
      code_challenge: await challenge(verifier), code_challenge_method: 'S256', state,
      response_mode: 'query',
    });
    if (hint) { p.set('login_hint', hint); p.set('prompt', 'none'); }
    else p.set('prompt', 'select_account');
    location.assign(`${BASE}/authorize?${p}`);
  },

  // Dipanggil saat halaman dibuka: selesaikan login kalau baru kembali dari Microsoft.
  async handleRedirect() {
    if (native) return { done: false };
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return { done: false };
    const saved = JSON.parse(sessionStorage.getItem('btunote.pkce') || 'null');
    sessionStorage.removeItem('btunote.pkce');
    history.replaceState(null, '', redirectUri());
    if (q.has('error')) {
      const err = q.get('error');
      // prompt=none gagal: sesi Microsoft habis, perlu login manual
      return { done: true, error: err === 'login_required' || err === 'interaction_required' ? 'LOGIN' : (q.get('error_description') || err) };
    }
    if (!saved || saved.state !== q.get('state')) return { done: true, error: 'State login tidak cocok, coba lagi.' };
    try {
      const j = await tokenRequest({
        grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(),
        code_verifier: saved.verifier,
      });
      storeTokens(j, { ...(load() || {}), rtAt: Date.now(), expired: false });
      return { done: true };
    } catch (e) {
      return { done: true, error: e.message };
    }
  },

  async getToken() {
    if (native) {
      const id = ++cbSeq;
      return new Promise((resolve, reject) => {
        cbs.set(id, { resolve, reject });
        native.token(id);
      });
    }
    const v = load();
    if (!v || (!v.rt && !v.at)) throw new AuthError('Belum login');
    if (v.at && Date.now() < v.exp) return v.at;
    if (!v.rt || v.expired) throw new AuthError('Sesi habis');
    try {
      const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: v.rt });
      return storeTokens(j, { ...v, rtAt: Date.now() }).at;
    } catch (e) {
      if (['invalid_grant', 'interaction_required', 'login_required'].includes(e.code)) {
        save({ ...v, at: null, expired: true });
        throw new AuthError('Sesi habis');
      }
      throw e;
    }
  },

  // Sesi browser kedaluwarsa (token SPA berlaku 24 jam): coba login ulang tanpa ketik password.
  needsSilentRelogin() {
    if (native) return false;
    const v = load();
    return !!(v && v.expired);
  },

  logout() {
    if (native) native.logout();
    save(null);
  },
};
