/**
 * Pathwise <-> South Brunswick Genesis server  (server.js)
 *
 * CHANGE SUMMARY (v1.0, new file):
 *  - Serves ./public/index.html (your Pathwise file) and injects /connector.js into it. Original HTML is NOT modified on disk.
 *  - POST /api/login signs in to Genesis with your credentials (form login, cookie jar, kept in memory only).
 *  - Pulls: student id -> gradebook summary (courses + %), per-course assignments (category / name / score / max), schedule.
 *  - Maps everything into Pathwise's import shape ({name, courses:[{n,l,p,d,r,t,g,c,cats:[{n,w,gw,items:[{n,s,m,h}]}]}]}).
 *  - Polls every POLL_MIN minutes (default 15), diffs vs. last snapshot, pushes new/changed grades to the page via SSE (/api/events).
 *  - Localhost-only bind + Host/Origin checks (blocks other websites from poking the API).
 *  - NEVER auto-retries a failed password (avoids locking your Genesis account).
 *
 * !! UNTESTED against the live SBHS Genesis (no network path to it from where this was written). URLs/selectors follow
 *    standard Genesis conventions. If a parse comes back empty: run with DEBUG=1, hit /api/raw/<page>, open ./debug/*.html,
 *    and adjust SCHED_QUERY / the parse* functions below. Everything Genesis-specific is in the "GENESIS" section.
 *
 * Run:  npm install && node server.js   (Node 20+)   then open http://localhost:3000
 * Env:  PORT=3000  POLL_MIN=15  DEBUG=1  GENESIS_BASE=https://parents.sbschools.org/genesis
 *       GENESIS_USER / GENESIS_PASS (optional, enables unattended login at startup)  STUDENT_ID (optional override)
 *       SCHED_QUERY (optional override for the schedule page query string)
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const cheerio = require('cheerio');

const PORT = +process.env.PORT || 3000;
const POLL_MIN = Math.max(5, +process.env.POLL_MIN || 15);           // floor 5 min: be polite to the district's server
const BASE = (process.env.GENESIS_BASE || 'https://parents.sbschools.org/genesis').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const DEBUG = !!process.env.DEBUG;
const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DBG = path.join(ROOT, 'debug'), DATA = path.join(ROOT, 'data');
const SNAP = path.join(DATA, 'snapshot.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

/* ============================== GENESIS ============================== */
class Genesis {
  constructor() { this.jar = new Map(); this.sid = process.env.STUDENT_ID || ''; }
  // Fetch with manual redirects so cookies are captured at every hop and never sent off the Genesis origin.
  async req(url, { method = 'GET', form } = {}) {
    let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop < 8; hop++) {
      const u = new URL(url, ORIGIN);
      if (u.origin !== ORIGIN) throw new Error('Redirected off Genesis origin: ' + u.origin);
      const headers = { 'user-agent': 'Mozilla/5.0 (Pathwise local sync)', cookie: [...this.jar].map(([k, v]) => k + '=' + v).join('; ') };
      if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(u, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), u).href;
        if (![307, 308].includes(res.status)) { method = 'GET'; body = undefined; }
        continue;
      }
      return { html: await res.text(), url: u.href, status: res.status };
    }
    throw new Error('Too many redirects');
  }
  loggedOut(html) { return /name=["']j_password["']/i.test(html); }
  async login(user, pass) {
    this.jar.clear();
    await this.req(`${BASE}/parents?gohome=true`);                                   // seeds JSESSIONID
    const r = await this.req(`${BASE}/j_security_check`, { method: 'POST', form: { j_username: user, j_password: pass } });
    if (this.loggedOut(r.html) || /invalid (user|login|password)/i.test(r.html)) throw new Error('Genesis rejected the login (bad username/password, or this account uses SSO/MFA).');
    const home = r.html.includes('studentid') ? r : await this.req(`${BASE}/parents?gohome=true`);
    if (!this.sid) { const m = home.html.match(/studentid=(\d+)/i); if (m) this.sid = m[1]; }
    if (!this.sid) throw new Error('Logged in but could not find a student id. Set STUDENT_ID in the environment.');
    this.name = clean(cheerio.load(home.html)('.studentName, #studentName, .name').first().text()) || '';
    return home.html;
  }
  async page(label, query) {
    const r = await this.req(`${BASE}/parents?${query}&studentid=${this.sid}`);
    if (this.loggedOut(r.html)) { const e = new Error('SESSION_EXPIRED'); e.expired = true; throw e; }
    // Vercel's deployed function filesystem is read-only (except /tmp). Keep
    // diagnostics in memory there; only save raw HTML when running locally.
    if (DEBUG && process.env.VERCEL !== '1') {
      try {
        fs.mkdirSync(DBG, { recursive: true });
        fs.writeFileSync(path.join(DBG, label.replace(/\W+/g, '_') + '.html'), r.html);
      } catch (err) {
        // Debug file output is optional and must never break the Genesis request.
        console.warn('[Pathwise] Could not write debug HTML:', err.message);
      }
    }
    return r.html;
  }
}

// --- parsers (Genesis-specific; tune these first if output is empty) ---
const re = { frac: /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/, pct: /(\d{1,3}(?:\.\d+)?)\s*%/ };
const cellsOf = ($, tr) => $(tr).children('th,td').map((_, c) => clean($(c).text())).get();
const leafTables = $ => $('table').filter((_, t) => !$(t).find('table').length);   // innermost tables only: avoids double-counting nested layouts

function inspectGradebook(html) {
  const $ = cheerio.load(html);
  const tables = $('table').map((_, t) => ({
    headers: $(t).find('tr').first().find('th,td').map((__, c) => clean($(c).text())).get().slice(0, 12),
    rows: $(t).find('tr').slice(0, 8).map((__, tr) => ({
      cells: cellsOf($, tr).slice(0, 12),
      links: $(tr).find('a').map((___, a) => ({ text: clean($(a).text()).slice(0, 100), href: ($(a).attr('href') || '').slice(0, 300) })).get().slice(0, 5)
    })).get()
  })).get().filter(t => t.rows.length).slice(0, 8);
  return { title: clean($('title').text()), urlHints: $('form').map((_, f) => $(f).attr('action') || '').get().slice(0, 5), tables, bodyTextStart: clean($('body').text()).slice(0, 1800) };
}

function parseGradebook(html) {                // -> [{n, g, code, section, mp}]
  const $ = cheerio.load(html), out = [], seen = new Set();
  // Some Genesis layouts expose courseCode links and percentage cells.
  $('tr').each((_, tr) => {
    const a = $(tr).find('a').filter((_, el) => /courseCode|courseSection|listassignments/i.test($(el).attr('href') || '')).first(), href = a.attr('href') || '';
    const cells = cellsOf($, tr), m = cells.map(x => x.match(re.pct)).find(Boolean);
    const n = clean(a.text()) || cells.find(x => /[A-Za-z]{4}/.test(x) && !re.pct.test(x) && x.length < 70);
    if (!m || !n || seen.has(n)) return;
    seen.add(n);
    const q = href ? new URL(href, ORIGIN).searchParams : new URLSearchParams();
    out.push({ n, g: +m[1], code: q.get('courseCode') || '', section: q.get('courseSection') || '', mp: q.get('mp') || '' });
  });
  if (out.length) return out;

  // South Brunswick's parent gradebook can render the whole course list inside
  // one layout cell, with labels such as "FY | Course Name Teacher MP1 ... FG 91 (A-)".
  // In that layout course names are plain text (not courseCode links) and final
  // grades are numbers without a percent sign, so parse those segments as a fallback.
  const text = clean($('body').text());
  const parts = text.split(/(?=\b(?:FY|Q[1-4])\s*\|\s*)/i);
  for (const part of parts) {
    const start = part.match(/^((?:FY|Q[1-4]))\s*\|\s*/i);
    if (!start) continue;
    const periodAt = part.search(/\bMP[1-4]\s+\d{1,2}\/\d{1,2}\s+to\s+\d{1,2}\/\d{1,2}/i);
    if (periodAt < 0) continue;
    let title = clean(part.slice(start[0].length, periodAt));
    // Remove the teacher suffix shown by Genesis, e.g. "Payne, Taylor" or "Robinson / Thuel".
    title = title.replace(/\s+[A-Z][A-Za-z'’-]+,\s*[A-Z][A-Za-z'’-]+\s*$/, '');
    title = title.replace(/\s+[A-Z][A-Za-z'’-]+(?:\s*\/\s*[A-Z][A-Za-z'’-]+)+\s*$/, '');
    const gradeMatch = part.match(/\bFG\s+(\d{1,3})(?:\s*\(([A-F][+-]?)\))?/i);
    if (!title || !gradeMatch || seen.has(title)) continue;
    const grade = Number(gradeMatch[1]);
    if (grade < 0 || grade > 100) continue;
    seen.add(title);
    out.push({ n: title, g: grade, code: '', section: '', mp: start[1].toUpperCase() === 'FY' ? '' : start[1].toUpperCase() });
  }
  return out;
}
function parseAssignments(html) {              // -> {items:[{cat,n,s,m}], weights:{cat:w}}
  const $ = cheerio.load(html), items = [], weights = {};
  leafTables($).each((_, t) => {
    let ix = null, wx = null;
    $(t).find('tr').each((_, tr) => {
      const cells = cellsOf($, tr); if (!cells.length) return;
      const low = cells.map(x => x.toLowerCase());
      const ci = low.findIndex(x => x.includes('category'));
      if (!ix && !wx && ci >= 0) {                                              // header row detection
        const ni = low.findIndex(x => x.includes('assignment') || x === 'name' || x.includes('title'));
        if (ni >= 0) ix = { cat: ci, name: ni, score: low.findIndex(x => x === 'grade' || x.includes('score') || x.includes('points')) };
        else { const wi = low.findIndex(x => x.includes('weight') || x.includes('%')); if (wi >= 0) wx = { cat: ci, w: wi }; }
        return;
      }
      if (wx) { const w = (cells[wx.w] || '').match(/(\d+(?:\.\d+)?)/); if (cells[wx.cat] && w) weights[cells[wx.cat]] = +w[1]; return; }
      if (!ix) return;
      // If a Grade/Score column was found use ONLY it (a "--" there means ungraded); else scan cells AFTER the name column (dates like 10/2 sit before it).
      const f = ix.score >= 0 ? (cells[ix.score] || '').match(re.frac) : cells.slice(ix.name + 1).map(x => x.match(re.frac)).find(Boolean);
      if (!f) return;                                                           // ungraded / "--" / "Exempt": skip
      items.push({ cat: cells[ix.cat] || 'Other', n: cells[ix.name] || 'Assignment', s: +f[1], m: +f[2] });
    });
  });
  return { items, weights };
}
function parseSchedule(html) {                 // -> [{n,p,d,r,t,start,end}]
  const $ = cheerio.load(html), out = [], seen = new Set();
  const timeRange = /((?:\d{1,2}:\d{2}\s*[AP]M?)|(?:\d{1,2}\s*[AP]M?))\s*(?:-|–|to)\s*((?:\d{1,2}:\d{2}\s*[AP]M?)|(?:\d{1,2}\s*[AP]M?))/i;
  leafTables($).each((_, t) => {
    let ix = null;
    $(t).find('tr').each((_, tr) => {
      const cells = cellsOf($, tr); if (!cells.length) return;
      const low = cells.map(x => x.toLowerCase()), f = keys => low.findIndex(x => keys.some(w => x === w || x.includes(w)));
      if (!ix) {
        const n=f(['course','class','course name','description']);
        const p=f(['period','period #','period number']);
        const d=f(['day','rotation','cycle']);
        const tm=f(['time','meeting time','period time']);
        if(n>=0 && (p>=0 || tm>=0)) { ix={n,p,d,t:f(['teacher','instructor']),r:f(['room','location']),tm}; return; }
      }
      if (!ix || ix.n < 0 || !cells[ix.n]) return;
      const periodText = ix.p >= 0 ? cells[ix.p] : '';
      const timeText = [ix.tm>=0?cells[ix.tm]:'', ...cells].join(' ');
      const pm = periodText.match(/(?:period\s*)?(\d{1,2})/i) || (ix.tm>=0 ? cells[ix.tm].match(/(?:period\s*)?(\d{1,2})/i) : null);
      const dayText = (ix.d>=0?cells[ix.d]:'')+' '+periodText+' '+cells[ix.n];
      const dayMatches = [...dayText.matchAll(/(?:^|\b)(A|B)(?:\s*[-/]\s*(A|B))?(?=\b|$)/gi)].flatMap(m=>[m[1],m[2]].filter(Boolean).map(x=>x.toUpperCase()));
      const days=[...new Set(dayMatches)];
      const tmMatch = timeText.match(timeRange);
      const start=tmMatch?tmMatch[1].replace(/\s+/g,' ').trim():'';
      const end=tmMatch?tmMatch[2].replace(/\s+/g,' ').trim():'';
      const n=clean(cells[ix.n]);
      const p=pm?Math.min(12,Math.max(1,+pm[1])):null;
      const d=days.length===1?days[0]:days.length>1?'AB':'';
      const key=[norm(n),p,d,start,end].join('|');
      if (!n || seen.has(key)) return; seen.add(key);
      out.push({n,p,d,r:ix.r>=0?cells[ix.r]:'',t:ix.t>=0?cells[ix.t]:'',start,end});
    });
  });
  return out.sort((a,b)=>(a.p??99)-(b.p??99)||a.n.localeCompare(b.n));
}
// Candidate schedule queries, tried in order until one parses. Override with SCHED_QUERY.
const SCHED_QUERIES = [process.env.SCHED_QUERY, 'tab1=studentdata&tab2=schedule&action=form', 'tab1=studentdata&tab2=studentsummary&action=form'].filter(Boolean);

const level = n => /\bAP\b|Advanced Placement/i.test(n) ? 'AP' : /Honors|\bHon\b/i.test(n) ? 'Honors' : 'CP';
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function pull(g) {                        // full sync -> Pathwise import JSON
  const gradebookHtml = await g.page('gradebook', 'tab1=studentdata&tab2=gradebook&tab3=weeklysummary&action=form');
  const gb = parseGradebook(gradebookHtml);
  if (!gb.length) {
    const e = new Error('Signed in to Genesis, but Pathwise could not recognize any classes in the gradebook.');
    if (DEBUG) e.debug = inspectGradebook(gradebookHtml);
    throw e;
  }
  let sched = [];
  for (const q of SCHED_QUERIES) { try { sched = parseSchedule(await g.page('schedule', q)); } catch (e) { if (e.expired) throw e; } if (sched.length) break; }
  const courses = [];
  for (const c of gb) {
    await sleep(300);                                                           // gentle pacing between course pages
    let a = { items: [], weights: {} };
    try {
      // Plain-text Genesis gradebook layouts don't expose courseCode/courseSection
      // links. Do not request an assignment page without those identifiers.
      if (c.code && c.section) {
        const qs = new URLSearchParams({ tab1: 'studentdata', tab2: 'gradebook', tab3: 'listassignments', action: 'form', courseCode: c.code, courseSection: c.section });
        if (c.mp) qs.set('mp', c.mp);
        a = parseAssignments(await g.page('assign_' + c.n, qs.toString()));
      }
    } catch (e) { if (e.expired) throw e; }
    const catNames = [...new Set(a.items.map(i => i.cat))];
    const eq = catNames.length ? Math.round(100 / catNames.length) : 0;        // fallback when Genesis doesn't expose weights
    const cats = catNames.map(cn => { const w = a.weights[cn] ?? eq; return { n: cn, w, gw: w, items: a.items.filter(i => i.cat === cn).map(i => ({ n: i.n, s: i.s, m: i.m, h: 0 })) }; });
    const cn=norm(c.n); const s = sched.find(x => norm(x.n) === cn) || sched.find(x => norm(x.n).includes(cn) || cn.includes(norm(x.n))) || {};
    courses.push({ n: c.n, l: level(c.n), p: s.p || 1, d: s.d || '', r: s.r || '', t: s.t || '', start:s.start||'', end:s.end||'', g: c.g, c: 1, cats });
  }
  if (!courses.length) throw new Error('Signed in to Genesis, but no classes could be imported.');
  return { name: g.name || undefined, school: 'sb', schedule: sched, courses, syncedAt: new Date().toISOString() };
}


module.exports = { Genesis, pull, parseGradebook, inspectGradebook };
