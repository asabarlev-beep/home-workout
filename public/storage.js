// Local-first storage for the workout diary.
// Implements the window.storage interface the app already calls (get / set / list). Every write lands in
// localStorage first and is pushed to /api/kv in the background, so a workout without signal is never lost.
// Reads pull the server copy once on load; the newer timestamp per key wins. Other devices' edits show up on the next load.
(() => {
  const mem = new Map();
  let useLs = true;
  try { localStorage.setItem('wkt', '1'); localStorage.removeItem('wkt'); } catch { useLs = false; }
  const getRaw = (k) => (useLs ? localStorage.getItem(k) : (mem.get(k) ?? null));
  const setRaw = (k, v) => { if (useLs) localStorage.setItem(k, v); else mem.set(k, v); };
  const rawKeys = () => (useLs ? Object.keys(localStorage) : [...mem.keys()]);

  const rd = (k) => { try { return JSON.parse(getRaw('wk:' + k)); } catch { return null; } };
  const dirtySet = () => { try { return new Set(JSON.parse(getRaw('wkdirty') || '[]')); } catch { return new Set(); } };

  let pillEl = null;
  function saveDirty(s) {
    setRaw('wkdirty', JSON.stringify([...s]));
    if (!pillEl && document.body) {
      pillEl = document.createElement('div');
      pillEl.textContent = '● ממתין לסנכרון';
      pillEl.style.cssText = 'position:fixed;top:6px;left:6px;z-index:60;font:11px sans-serif;padding:3px 8px;border-radius:999px;background:#242b35;color:#8b93a0;border:1px solid #2e3540;display:none';
      document.body.appendChild(pillEl);
    }
    if (pillEl) pillEl.style.display = s.size ? 'block' : 'none';
  }

  const loginWaiters = [];
  function showLogin() {
    if (document.getElementById('wkLogin')) return;
    const wrap = document.createElement('div');
    wrap.id = 'wkLogin';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:16px';
    wrap.innerHTML =
      '<div style="background:#1b2028;border:1px solid #2e3540;border-radius:16px;padding:20px;width:100%;max-width:320px;display:flex;flex-direction:column;gap:12px;color:#eef1e8;font-family:sans-serif;direction:rtl">' +
      '<h3 style="margin:0">כניסה</h3>' +
      '<input id="wkPw" type="password" autocomplete="current-password" style="font-size:16px;padding:10px;border-radius:10px;border:1px solid #2e3540;background:#12151a;color:#eef1e8">' +
      '<div id="wkNote" style="min-height:1em;font-size:13px;color:#ff6f6f"></div>' +
      '<button id="wkGo" style="padding:12px;border-radius:12px;border:0;background:#d7ff3f;color:#12151a;font-weight:800;font-size:15px">כניסה</button>' +
      '</div>';
    document.body.appendChild(wrap);
    const input = document.getElementById('wkPw');
    const note = document.getElementById('wkNote');
    async function submit() {
      const res = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      }).catch(() => null);
      if (res && res.ok) {
        wrap.remove();
        await sync();
        loginWaiters.splice(0).forEach((f) => f());
      } else {
        note.textContent = !res ? 'אין חיבור' : res.status === 429 ? 'יותר מדי ניסיונות. נסו שוב בעוד שעה.' : 'סיסמה שגויה';
      }
    }
    document.getElementById('wkGo').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  }

  let busy = null;
  function sync() {
    if (busy) return busy;
    busy = (async () => {
      try {
        const res = await fetch('/api/kv', { credentials: 'same-origin', signal: AbortSignal.timeout(6000) });
        if (res.status === 401) { showLogin(); return 'auth'; }
        if (!res.ok) return 'fail';
        const { items } = await res.json();
        const dirty = dirtySet();
        for (const it of items) {
          const l = rd(it.key);
          if (l && l.t >= it.updated) continue; // ours is as new or newer (and will be pushed if dirty)
          setRaw('wk:' + it.key, JSON.stringify({ v: it.value, t: it.updated }));
          dirty.delete(it.key);
        }
        saveDirty(dirty);
        let failed = false;
        for (const k of dirty) {
          const o = rd(k);
          if (!o) continue;
          const r = await fetch('/api/kv/' + encodeURIComponent(k), {
            method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: o.v, updated: o.t }), signal: AbortSignal.timeout(8000),
          });
          if (r.status === 401) { showLogin(); return 'auth'; }
          if (!r.ok) { failed = true; continue; }
          const cur = rd(k);
          if (cur && cur.t === o.t) { const d = dirtySet(); d.delete(k); saveDirty(d); } // unchanged while sending
        }
        return failed ? 'fail' : 'ok';
      } catch {
        return 'fail';
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  const ready = (async () => {
    if ((await sync()) === 'auth') await new Promise((res) => loginWaiters.push(res));
  })();

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(sync, 800); };
  addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && dirtySet().size) sync(); });
  setInterval(() => { if (document.visibilityState === 'visible' && dirtySet().size) sync(); }, 30000);
  saveDirty(dirtySet());

  window.storage = {
    async get(key) {
      await ready;
      const o = rd(key);
      if (!o) throw new Error('not found');
      return { key, value: o.v, shared: false };
    },
    async set(key, value) {
      setRaw('wk:' + key, JSON.stringify({ v: String(value), t: Date.now() }));
      const d = dirtySet(); d.add(key); saveDirty(d);
      soon();
      return { key, value, shared: false };
    },
    async list(prefix = '') {
      await ready;
      return { keys: rawKeys().filter((k) => k.startsWith('wk:' + prefix)).map((k) => k.slice(3)), prefix, shared: false };
    },
  };
})();
