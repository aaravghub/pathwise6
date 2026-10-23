/** Pathwise Vercel connector.
 * Credentials are held in page memory only and sent over HTTPS for each sync.
 * Vercel functions do not keep a reliable process/session alive between requests.
 */
(() => {
  'use strict';
  let credentials = null;
  const j = async (p, o) => {
    const r = await fetch(p, o);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'Request failed (' + r.status + ')'); e.debug = d.debug; throw e; }
    return d;
  };
  const post = (p, b) => j(p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b || {})
  });
  const note = msg => {
    let n = document.getElementById('pw-msg');
    const row = document.querySelector('button[data-act="login"]')?.parentElement;
    if (!n && row) { n = document.createElement('p'); n.id = 'pw-msg'; n.className = 'mu'; n.setAttribute('role', 'alert'); row.after(n); }
    if (n) n.textContent = msg;
  };
  const toast = (msg, ms = 7000) => {
    let t = document.getElementById('pw-toast');
    if (!t) { t = document.createElement('div'); t.id = 'pw-toast'; t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;max-width:520px;margin:0 auto;background:var(--acc);color:var(--accink);padding:12px 16px;border-radius:14px;font-weight:700;font-size:14px;white-space:pre-line;z-index:50;box-shadow:0 6px 24px rgba(0,0,0,.25)';
      document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
  };
  function adopt(d) {
    const old = new Map((S.courses || []).map(k => [k.n, k]));
    d.courses.forEach(k => {
      const o = old.get(k.n);
      k.target = o && Number.isFinite(+o.target) ? +o.target : 90;
      if (o) k.cats.forEach(c => { const oc = o.cats.find(x => x.n === c.n); if (oc) c.items.push(...oc.items.filter(i => i.h)); });
    });
    S.courses = d.courses; S.school = 'sb'; S.demo = 0; S.auth = 1; S.open = null;
    if (d.name) S.name = d.name;
    save(); render(); addSyncBtn();
  }
  function addSyncBtn() {
    if (document.getElementById('pw-sync') || !S.auth) return;
    const so = document.getElementById('so'); if (!so) return;
    const b = document.createElement('button'); b.className = 'btn'; b.id = 'pw-sync'; b.textContent = 'Sync now';
    b.onclick = async () => {
      if (!credentials) { toast('Sign in again to sync.'); return; }
      b.disabled = true; b.textContent = 'Syncing…';
      try { adopt(await post('/api/sync', credentials)); toast('Grades synced with Genesis.'); }
      catch (e) { toast('Sync failed: ' + e.message); }
      b.disabled = false; b.textContent = 'Sync now';
    };
    so.before(b, ' ');
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-act="login"]'); if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const u = document.getElementById('gu'), p = document.getElementById('gp');
    const user = u && u.value.trim(), pass = p && p.value;
    if (!user || !pass) return note('Enter your Genesis username and password.');
    b.disabled = true; note('Signing in and retrieving grades… this may take a little while.');
    try {
      const d = await post('/api/login', { user, pass });
      credentials = { user, pass }; p.value = ''; adopt(d);
      note(''); toast('Connected. Use “Sync now” to refresh grades.');
    } catch (err) { if (err.debug) console.error('Pathwise gradebook parser diagnostics:', err.debug); note(err.message + (err.debug ? ' (debug details are in your browser console)' : '')); if (p) p.value = ''; credentials = null; }
    b.disabled = false;
  }, true);
  document.addEventListener('click', e => {
    if (!e.target.closest('button[data-act="logout"]')) return;
    credentials = null;
    const sync = document.getElementById('pw-sync'); if (sync) sync.remove();
  }, true);
})();
