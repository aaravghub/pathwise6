/**
 * connector.js — injected into Pathwise by server.js (your HTML file is never edited on disk).
 *
 * CHANGE SUMMARY (v1.0, new file):
 *  - Intercepts the "Sign in" button (capture phase) and sends credentials to the LOCAL server (/api/login) instead of ignoring them.
 *  - Maps the server's data into Pathwise state `S`, KEEPING your what-if scores and per-class targets across syncs.
 *  - Auto-restores the session on page load if the server is already connected.
 *  - Listens to /api/events: toast + re-render when new grades land. Adds a "Sync now" button in the header.
 *  - Password field is cleared right after the request; nothing is stored in localStorage by this script.
 *
 * Relies on Pathwise globals (top-level `let S`, `save`, `render`, `$`, `esc`) — shared across classic <script> tags.
 */
(() => {
  'use strict';
  const j = async (p, o) => { const r = await fetch(p, o), d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; };
  const post = (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });

  // Toast (textContent only: grade/assignment names come from Genesis, treat as untrusted)
  const toast = (msg, ms = 9000) => {
    let t = document.getElementById('pw-toast');
    if (!t) { t = document.createElement('div'); t.id = 'pw-toast'; t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));max-width:520px;margin:0 auto;background:var(--acc);color:var(--accink);padding:12px 16px;border-radius:14px;font-weight:700;font-size:14px;white-space:pre-line;z-index:50;box-shadow:0 6px 24px rgba(0,0,0,.25)';
      document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
  };
  const note = msg => { let n = document.getElementById('pw-msg'); const row = document.querySelector('button[data-act="login"]')?.parentElement;
    if (!n && row) { n = document.createElement('p'); n.id = 'pw-msg'; n.className = 'mu'; n.setAttribute('role', 'alert'); row.after(n); } if (n) n.textContent = msg; };

  // Merge server data into Pathwise state, preserving user-only fields (what-ifs, targets).
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
    b.onclick = async () => { b.disabled = true; b.textContent = 'Syncing…'; try { adopt(await post('/api/sync')); toast('Synced with Genesis'); } catch (e) { toast('Sync failed: ' + e.message); } b.disabled = false; b.textContent = 'Sync now'; };
    so.before(b, ' ');
  }

  // 1) Login hook — capture phase on document runs before Pathwise's own handler; stop it so the demo login doesn't fire.
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-act="login"]'); if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const u = document.getElementById('gu'), p = document.getElementById('gp'), user = u && u.value.trim(), pass = p && p.value;
    if (!user || !pass) return note('Enter your Genesis username and password.');
    b.disabled = true; note('Signing in to Genesis and pulling your data… (can take ~15 s)');
    try { const d = await post('/api/login', { user, pass }); p.value = ''; adopt(d); listen(); toast('Connected. Checking for new grades every few minutes.'); }
    catch (err) { note(err.message); if (p) p.value = ''; }
    b.disabled = false;
  }, true);

  // 2) Logout hook — also drops the server session (don't stop propagation: Pathwise still clears its own state).
  document.addEventListener('click', e => { if (e.target.closest('button[data-act="logout"]')) post('/api/logout').catch(() => {}); }, true);

  // 3) Live updates from the server's poller.
  let es;
  function listen() {
    if (es) return; es = new EventSource('/api/events');
    es.addEventListener('update', async ev => { const { changes } = JSON.parse(ev.data); try { adopt(await j('/api/data')); } catch {} toast('New grades:\n' + changes.slice(0, 6).join('\n') + (changes.length > 6 ? '\n+' + (changes.length - 6) + ' more' : ''), 15000);
      if (window.Notification && Notification.permission === 'granted') new Notification('Pathwise: new grades', { body: changes.slice(0, 3).join('\n') }); });
    es.addEventListener('auth', ev => { toast(JSON.parse(ev.data).error); S.auth = 0; save(); render(); es.close(); es = null; });
  }

  // 4) Restore on load if the server already holds a Genesis session (e.g. started with GENESIS_USER/GENESIS_PASS).
  j('/api/data').then(d => { adopt(d); listen(); }).catch(() => {});
})();
