// Saved sessions: compact storage format, session list and progress over time.
import { flightSummary, COURT } from './engine.js'; import { t, num, getLang } from './i18n.js';
const r = (v, d = 2) => v == null || !isFinite(v) ? null : +(+v).toFixed(d);
const med = a => { a = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
export function sessionStats(sh) { const n = sh.length, c = k => sh.filter(s => s.result === k).length;
  return { n, inPct: n ? r(100 * c('in') / n, 1) : 0, net: c('net'), long: c('long'), wide: c('wide'), close: sh.filter(s => s.close).length, speed: r(med(sh.map(s => s.speed)), 1), clear: r(med(sh.filter(s => s.result !== 'net').map(s => s.clear)), 2), rpm: r(med(sh.map(s => s.rpm)), 0) }; }
export const pack = sh => sh.map(s => ({ t: r(s.t), w: s.who === 'opp' ? 'o' : 'm', f: s.far ? 1 : 0, r: s.result, c: s.close ? 1 : 0, nh: s.netHit ? 1 : 0, sv: s.serve ? 1 : 0, hd: s.side === 'R' || s.side === 'L' ? s.side : '', tg: s.target || '', sp: r(s.speed, 1), cl: r(s.cl, 4), ...(s.sideCl ? { sc: r(s.sideCl, 4) } : {}), ...(s.hit ? { hi: 1 } : {}), ...(s.heard ? { he: 1 } : {}), ...(s.feet ? { fe: s.feet } : {}), ...(s.rec ? { rc: s.rec } : {}), ...(s.toss ? { ts: [s.toss.z, s.toss.x, s.toss.dt, s.toss.top ? 1 : 0] } : {}), ...(s.bounce ? { bo: 1 } : {}), ...(s.speedSd ? { ss: r(s.speedSd, 1) } : {}), cs: r(s.clSd, 4), rpm: r(s.rpm, 0), rs: r(s.rpmSd, 0), ...(s.lc && s.lc.verdict ? { rv: [s.lc.verdict, s.lc.cm, s.lc.unc, s.lc.line, s.reviewed ? 1 : 0] } : {}),
  lx: r(s.land[0]), ly: r(s.land[1]), sx: r(s.landSd[0]), sy: r(s.landSd[1]), nx: s.net ? r(s.net[0]) : null, nz: s.net ? r(s.net[2]) : null, clr: r(s.clear), cls: r(s.clearSd), tl: r(s.tLand), p: s.p0.map(v => r(v, 3)), v: s.v0.map(v => r(v, 3)) }));
const N = v => (typeof v === 'number' && isFinite(v)) ? v : 0, RES = ['in', 'net', 'long', 'wide'];
export const unpack = list => list.filter(q => q && Array.isArray(q.p) && Array.isArray(q.v) && q.p.length === 3 && q.v.length === 3).map(q => { const x = [...q.p.map(N), ...q.v.map(N), N(q.cl), N(q.sc)];
  return { t: N(q.t), who: q.w === 'o' ? 'opp' : 'me', far: !!q.f, result: RES.includes(q.r) ? q.r : 'wide', close: !!q.c, netHit: !!q.nh, serve: !!q.sv, side: q.hd === 'R' || q.hd === 'L' ? q.hd : '', target: q.tg === 'left' || q.tg === 'right' ? q.tg : null, speed: N(q.sp), speedSd: N(q.ss), hit: !!q.hi, heard: !!q.he, bounce: !!q.bo, ...(Array.isArray(q.fe) && q.fe.length === 2 ? { feet: q.fe.map(N) } : {}), ...(Array.isArray(q.rc) && q.rc.length === 2 ? { rec: q.rc.map(N) } : {}), ...(Array.isArray(q.ts) && q.ts.length === 4 ? { toss: { z: N(q.ts[0]), x: N(q.ts[1]), dt: N(q.ts[2]), top: !!q.ts[3] } } : {}), cl: N(q.cl), sideCl: N(q.sc), clSd: N(q.cs), rpm: N(q.rpm), rpmSd: N(q.rs), ...(Array.isArray(q.rv) && ['in', 'out', 'close'].includes(q.rv[0]) ? { lc: { verdict: q.rv[0], cm: N(q.rv[1]), unc: N(q.rv[2]), line: ['baseline', 'service', 'side', 'centre'].includes(q.rv[3]) ? q.rv[3] : 'side' }, reviewed: !!q.rv[4] } : {}),
    land: [N(q.lx), N(q.ly)], landSd: [N(q.sx), N(q.sy)], net: q.nz == null ? null : [N(q.nx), COURT.NET, N(q.nz)], clear: q.clr == null ? null : N(q.clr), clearSd: N(q.cls), tLand: N(q.tl), p0: x.slice(0, 3), v0: x.slice(3, 6),
    path: flightSummary(x).path, flatPath: flightSummary([...x.slice(0, 6), 0]).path }; });
export function thumb(img, max = 420) { const c = document.createElement('canvas'), k = Math.min(1, max / Math.max(img.width, img.height)); const full = document.createElement('canvas'); full.width = img.width; full.height = img.height; full.getContext('2d').putImageData(img, 0, 0);
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(full, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.6); }
export const fmtDate = iso => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? String(iso) : d.toLocaleDateString(getLang() === 'pt' ? 'pt-BR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const safeThumb = s => (typeof s === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s)) ? s : '';
const E = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function renderSessions(host, sessions, onOpen, onDelete) { host.innerHTML = '';
  for (const s of sessions.slice().reverse()) { const st = s.stats || {}, card = E('article', 'sess'), src = safeThumb(s.thumb); if (src) { const im = E('img'); im.src = src; im.alt = ''; card.appendChild(im); }
    const b = E('div', 'b'); b.appendChild(E('h3', '', fmtDate(s.date))); b.appendChild(E('p', '', `${t(['coach', 'serve', 'match'].includes(s.mode) ? s.mode : 'coach')} · ${N(st.n)} ${t('shots')}`));
    b.appendChild(E('p', '', `${num(N(st.inPct))}% ${t('inPct')} · ${num(N(st.speed))} km/h · ${num(N(st.clear), 2)} m · ${num(Math.round(N(st.rpm) / 50) * 50)} rpm`));
    const row = E('div', 'row'), o = E('button', 'btn', t('open')), d = E('button', 'btn link', t('del')); o.onclick = () => onOpen(s); let armed = false; d.onclick = () => { if (!armed) { armed = true; d.textContent = t('delYes'); setTimeout(() => { armed = false; d.textContent = t('del'); }, 4000); } else onDelete(s); };
    row.appendChild(o); row.appendChild(d); b.appendChild(row); card.appendChild(b); host.appendChild(card); } }

const NS = 'http://www.w3.org/2000/svg', css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function lineChart(host, title, pts, unit, dec) { const fig = E('figure'); fig.appendChild(E('figcaption', '', title)); const W = 260, H = 120, pl = 34, pb = 20, pt = 8, pr = 10, svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart');
  const el = (n, a, text) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
  const ys = pts.map(p => p[1]); let lo = Math.min(...ys), hi = Math.max(...ys); if (hi - lo < 1e-9) { hi += 1; lo -= 1; } const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const X = i => pl + (pts.length === 1 ? 0.5 : i / (pts.length - 1)) * (W - pl - pr), Y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
  for (const v of [lo + pad, hi - pad]) { el('line', { x1: pl, x2: W - pr, y1: Y(v), y2: Y(v), stroke: css('--sand'), 'stroke-width': .6 }); el('text', { x: pl - 5, y: Y(v) + 4, 'text-anchor': 'end' }, num(v, dec)); }
  el('polyline', { points: pts.map((p, i) => `${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' '), fill: 'none', stroke: css('--saddle'), 'stroke-width': 2 });
  pts.forEach((p, i) => { const last = i === pts.length - 1, c = el('circle', { cx: X(i), cy: Y(p[1]), r: last ? 5 : 4, fill: last ? css('--ball') : css('--saddle'), stroke: last ? css('--espresso') : '#fff', 'stroke-width': 1.5 }); const tt = document.createElementNS(NS, 'title'); tt.textContent = `${fmtDate(p[0])}: ${num(p[1], dec)} ${unit}`; c.appendChild(tt); });
  el('text', { x: pl, y: H - 5 }, fmtDate(pts[0][0])); if (pts.length > 1) el('text', { x: W - pr, y: H - 5, 'text-anchor': 'end' }, fmtDate(pts[pts.length - 1][0]));
  fig.appendChild(svg); host.appendChild(fig); }
export function renderProgress(box, textEl, host, sessions) { host.innerHTML = ''; const ok = sessions.filter(s => s.stats && N(s.stats.n) > 0); box.hidden = false;
  if (ok.length < 2) { textEl.textContent = t('progNeed'); return; }
  const M = [['inPct', 'mIn', '%', 0, t('pts')], ['speed', 'mSpeed', 'km/h', 0, 'km/h'], ['clear', 'mClear', 'm', 2, 'm'], ['rpm', 'mSpin', 'rpm', 0, 'rpm']], last = ok[ok.length - 1], prev = ok.slice(0, -1), parts = [];
  for (const [k, lab, unit, dec, du] of M) { lineChart(host, `${t(lab)} (${unit})`, ok.map(s => [s.date, N(s.stats[k])]), unit, dec); const avg = prev.reduce((a, s) => a + N(s.stats[k]), 0) / prev.length, d = N(last.stats[k]) - avg; parts.push(`${t(lab)} ${d >= 0 ? '+' : '−'}${num(Math.abs(d), dec)} ${du}`); }
  textEl.textContent = t('progText', { d: fmtDate(last.date), a: parts.join('; ') }); }
