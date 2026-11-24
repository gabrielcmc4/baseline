import { COURT as C } from './engine.js'; import { t, num } from './i18n.js';
const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, parent, text) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const isEst = s => !!(s.approx || (s.landSd && s.landSd[1] > 3)); // landing depth only estimated: the ball was lost before it came down
export const resLabel = s => t(s.result) + (s.reviewed && s.lc && s.lc.line ? ' (' + t('lcSeen', { cm: Math.abs(s.lc.cm) }) + ')' : isEst(s) && s.result !== 'net' ? ' (' + t('estLand') + ')' : s.close ? ' (' + t(s.lc && s.lc.line ? 'lcTie' : 'closeCall') + ')' : '');
export function spinKind(s) { if (Math.abs(s.cl) < Math.max(s.clSd, 0.02)) return 'flat'; return s.cl > 0 ? 'topspin' : 'slice'; }

export function topView(host, shots, sel, onSelect, mode) {
  host.innerHTML = ''; const k = 22, x0 = -7.6, y1 = 28.5, W = 15.2 * k, H = 32 * k, X = x => (x - x0) * k, Y = y => (y1 - y) * k;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' }, host);
  el('rect', { x: X(-C.D), y: Y(C.LEN), width: 2 * C.D * k, height: C.LEN * k, fill: '#ead9c6' }, svg);
  if (mode === 'serve') for (const sx of [-C.S, 0]) el('rect', { x: X(sx), y: Y(C.LEN - C.SV), width: C.S * k, height: (C.LEN - C.SV - C.NET) * k, fill: '#e0cab1' }, svg);
  const L = (a, b, c, d, w = 2, col = '#fff') => el('line', { x1: X(a), y1: Y(b), x2: X(c), y2: Y(d), stroke: col, 'stroke-width': w }, svg);
  L(-C.D, 0, C.D, 0); L(-C.D, C.LEN, C.D, C.LEN); for (const x of [-C.D, C.D, -C.S, C.S]) L(x, 0, x, C.LEN); L(-C.S, C.SV, C.S, C.SV); L(-C.S, C.LEN - C.SV, C.S, C.LEN - C.SV); L(0, C.SV, 0, C.LEN - C.SV);
  L(-6.4, C.NET, 6.4, C.NET, 2.5, css('--espresso')); el('text', { x: X(6.55), y: Y(C.NET) + 4 }, svg, t('netLbl')); el('text', { x: X(-7.5), y: Y(-1.6) }, svg, t('yourSide'));
  for (const s of shots) el('circle', { cx: X(Math.max(-7, Math.min(7, s.p0[0]))), cy: Y(Math.max(-3, s.p0[1])), r: 2.2, fill: css('--tan'), opacity: .55 }, svg);
  const order = shots.map((s, i) => i).sort((a, b) => (a === sel) - (b === sel));
  for (const i of order) { const s = shots[i]; let x = s.land[0], y = s.land[1]; if (s.result === 'net') { x = s.net ? s.net[0] : x; y = C.NET - 0.35; }
    x = Math.max(-7.2, Math.min(7.2, x)); y = Math.min(28, y); const g = el('g', { style: 'cursor:pointer', tabindex: 0 }, svg); el('title', {}, g, `${fmtTime(s.t)} · ${resLabel(s)} · ${num(s.speed)} km/h`);
    if (i === sel) el('circle', { cx: X(x), cy: Y(y), r: 11, fill: 'none', stroke: css('--espresso'), 'stroke-width': 2 }, g);
    const col = css(s.result === 'in' ? '--in' : '--out'), sty = s.close || isEst(s) ? { fill: '#fff', stroke: col, 'stroke-width': 2.2 } : { fill: col, stroke: '#fff', 'stroke-width': 1.5 };
    if (s.result === 'in') el('circle', { cx: X(x), cy: Y(y), r: 5.5, ...sty }, g);
    else el('rect', { x: X(x) - 4.5, y: Y(y) - 4.5, width: 9, height: 9, ...sty, transform: `rotate(45 ${X(x)} ${Y(y)})` }, g);
    el('circle', { cx: X(x), cy: Y(y), r: 12, fill: 'transparent' }, g); g.addEventListener('click', () => onSelect(i)); g.addEventListener('keydown', e => { if (e.key === 'Enter') onSelect(i); }); }
}
export function sideView(host, shots, sel) {
  host.innerHTML = ''; let zMax = 3.5; for (const s of shots) for (const p of s.path) if (p[2] > zMax) zMax = p[2]; zMax = Math.min(8, Math.ceil(zMax + 0.3));
  const k = 14, kz = 28, xa = -4, xb = 28.5, padL = 24, padB = 40, W = padL + (xb - xa) * k + 8, H = zMax * kz + padB + 22, X = y => padL + (y - xa) * k, Z = z => 22 + (zMax - z) * kz;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' }, host), grid = css('--sand');
  for (let z = 0; z <= zMax; z++) { el('line', { x1: X(xa), x2: X(xb), y1: Z(z), y2: Z(z), stroke: grid, 'stroke-width': z ? .6 : 1.4 }, svg); el('text', { x: padL - 6, y: Z(z) + 4, 'text-anchor': 'end' }, svg, z); }
  for (const [y, lab] of [[0, '0'], [C.SV, num(C.SV, 1)], [C.NET, t('netLbl')], [C.LEN - C.SV, num(C.LEN - C.SV, 1)], [C.LEN, num(C.LEN, 1)]]) { el('line', { x1: X(y), x2: X(y), y1: Z(0), y2: Z(0) + 5, stroke: css('--tan') }, svg); el('text', { x: X(y), y: Z(0) + 18, 'text-anchor': 'middle' }, svg, lab); }
  el('text', { x: X((xa + xb) / 2), y: H - 6, 'text-anchor': 'middle' }, svg, t('distNote')); el('text', { x: 2, y: 11 }, svg, t('heightNote'));
  const pl = (path, a) => el('polyline', Object.assign({ points: path.filter(p => p[1] <= xb).map(p => `${X(p[1]).toFixed(1)},${Z(Math.max(0, p[2])).toFixed(1)}`).join(' '), fill: 'none' }, a), svg);
  const cut = s => s.result === 'net' ? s.path.filter(p => p[1] <= C.NET) : s.path;
  shots.forEach((s, i) => { if (i !== sel) pl(cut(s), { stroke: css(s.result === 'in' ? '--in' : '--out'), 'stroke-width': 1, opacity: sel == null ? .5 : .22 }); });
  el('line', { x1: X(C.NET), x2: X(C.NET), y1: Z(0), y2: Z(C.NET_C), stroke: css('--espresso'), 'stroke-width': 3 }, svg);
  if (sel != null && shots[sel]) { const s = shots[sel]; pl(s.flatPath, { stroke: css('--tan'), 'stroke-width': 2, 'stroke-dasharray': '6 5' }); pl(cut(s), { stroke: css('--espresso'), 'stroke-width': 2.6 });
    const e = s.flatPath[s.flatPath.length - 1], m = s.path[s.path.length - 1];
    el('text', { x: Math.min(X(e[1]) + 6, W - 4), y: Z(0.55), 'text-anchor': 'end' }, svg, t('noSpin') + ' ┄'); el('circle', { cx: X(m[1]), cy: Z(0), r: 5, fill: css('--ball'), stroke: css('--espresso'), 'stroke-width': 1.5 }, svg); }
}
