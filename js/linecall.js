// Line call: a second, independent look at a ball that landed close to a line.
// The flight fit says where a ball came down from its path in the air; near a line that is not good enough. This module
// goes back to the pictures around the bounce and measures directly: where the ball is in each picture, where its path
// turns back up (the bounce), where the paint of the line is, and how far apart the two are. It uses the court drawing
// only to know where to look and how many centimetres a picture element is there, not to decide.
//
// run(t0, t1, {x, y, w, h}) -> Promise<[{ t, data }]>: every picture between two times (seconds on the player's clock), cut to a window of the full-size picture (RGBA).
// width, height: the size of that full picture. Sets shot.lc = { verdict: 'in' | 'out' | 'close', cm, unc, line, t, uv, edge, ... } when the bounce and the line
// were both found, shot.lcWhy otherwise.
import { COURT } from './engine.js';
const C = COURT, BALL_R = 0.033, MAX_M_PER_PX = 0.06;
const med = a => { const b = ArrayBuffer.isView(a) ? a.slice().sort() : Array.from(a).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; }; // typed arrays sort by number on their own
// the lines a landing can be judged against: [name, axis (0: a line x = v, 1: a line y = v), v, from, to along the other axis, sign of "inside" along the axis]
const medIn = b => { b.sort(); return b[b.length >> 1]; }; // a typed array that is filled again afterwards: sorted where it is
const linesFor = s => { const far = !s.far, y0 = far ? C.NET : 0, y1 = far ? C.LEN : C.NET, L = [];
  if (s.serve) { const ySv = far ? C.LEN - C.SV : C.SV, sg = s.target ? (s.target === 'left' ? -1 : 1) : (s.land[0] >= 0 ? 1 : -1); L.push(['service', 1, ySv, -C.S, C.S, far ? -1 : 1]); L.push(['centre', 0, 0, Math.min(ySv, C.NET), Math.max(ySv, C.NET), sg]); L.push(['side', 0, sg * C.S, Math.min(ySv, C.NET), Math.max(ySv, C.NET), -sg]); }
  else { L.push(['baseline', 1, far ? C.LEN : 0, -C.S, C.S, far ? -1 : 1]); L.push(['side', 0, s.land[0] >= 0 ? C.S : -C.S, y0, y1, s.land[0] >= 0 ? -1 : 1]); }
  return L; };

const linesAll = s => { const far = !s.far, y0 = far ? C.NET : 0, y1 = far ? C.LEN : C.NET, ySv = far ? C.LEN - C.SV : C.SV, sx = s.land[0] >= 0 ? 1 : -1; return [['baseline', 1, far ? C.LEN : 0, -C.D, C.D, far ? -1 : 1], ['service', 1, ySv, -C.S, C.S, far ? -1 : 1], ['side', 0, sx * C.S, y0, y1, -sx], ['centre', 0, 0, Math.min(ySv, C.NET), Math.max(ySv, C.NET), sx]]; }; // for trying the method out on any bounce

export async function reviewLines(shots, cam, run, { width, height, onProgress, signal, debug, all, everyLine } = {}) { if (!width || !height) throw new Error('size');
  const list = shots.filter(s => s.result !== 'net' && s.land && s.tLand > 0 && (all || s.close)).sort((a, b) => a.t - b.t);
  for (let li = 0; li < list.length; li++) { const s = list[li]; if (signal && signal.aborted) return; s.lc = null; s.lcWhy = '';
    try {
      // which line is in question: the one the fitted landing is closest to, measured in its own uncertainty
      const sdx = Math.max(0.15, s.landSd ? s.landSd[0] : 0.3), sdy = Math.max(0.15, s.landSd ? s.landSd[1] : 0.5); let line = null, bestZ = Infinity;
      for (const l of (everyLine ? linesAll(s) : linesFor(s))) { const d = Math.abs(s.land[l[1]] - l[2]), z = d / (l[1] ? sdy : sdx); if (z < bestZ && (typeof everyLine !== 'string' || everyLine === l[0])) { bestZ = z; line = l; } }
      if (!line) { s.lcWhy = 'noline'; continue; }
      // where to look: around the fitted landing, wide enough for what the fit does not know (mostly depth) and for a few pictures of the ball's way in and out
      const tb = s.t + s.tLand, k = width / cam.W, P = X => { const q = cam.project(X); return [q[0] * k, q[1] * k]; }, c0 = P([s.land[0], s.land[1], 0]);
      { const X2 = [s.land[0], s.land[1], 0]; X2[line[1]] += 0.5; const a2 = P(X2); if (0.5 / (Math.hypot(a2[0] - c0[0], a2[1] - c0[1]) || 1e-9) > MAX_M_PER_PX) { s.lcWhy = 'far'; continue; } } // too little picture there: one picture element covers more court than a call can turn on
      const ppm = Math.hypot(P([s.land[0] + 0.5, s.land[1], 0])[0] - P([s.land[0] - 0.5, s.land[1], 0])[0], P([s.land[0] + 0.5, s.land[1], 0])[1] - P([s.land[0] - 0.5, s.land[1], 0])[1]), rBall = Math.max(1.2, BALL_R * ppm), fly = 0.07 * Math.max(8, 0.6 * (s.speed || 60) / 3.6) * ppm; // how far the ball goes in the picture in 0.07 s, roughly
      const spread = [[sdx, 0], [-sdx, 0], [0, sdy], [0, -sdy]].map(d => P([s.land[0] + 1.5 * d[0], s.land[1] + 1.5 * d[1], 0])), half = Math.round(Math.max(90, Math.min(300, Math.max(fly, 24 + Math.max(...spread.map(q => Math.max(Math.abs(q[0] - c0[0]), Math.abs(q[1] - c0[1]))))))));
      const w = Math.min(2 * half, width), h = Math.min(2 * half, height), x0 = Math.max(0, Math.min(width - w, Math.round(c0[0] - half))), y0 = Math.max(0, Math.min(height - h, Math.round(c0[1] - half)));
      const span = Math.min(0.5, 0.2 + 0.12 * sdy); let got = await run(Math.max(0, tb - span), tb + span, { x: x0, y: y0, w, h }); if (!got || got.length < 9) { s.lcWhy = 'nopic'; continue; }
      { const dts = []; for (let i = 1; i < got.length; i++) dts.push(got[i].t - got[i - 1].t); const dt = med(dts), every = dt > 0 && dt < 1 / 90 ? Math.round((1 / 60) / dt) : 1; if (every > 1) got = got.filter((_, i) => i % every === 0); } // slow-motion video: sixty pictures a second are plenty
      const step = (got[got.length - 1].t - got[0].t) / (got.length - 1) || 1 / 60, fr = got.map(g => { const Y = new Uint8Array(w * h), G = new Int16Array(w * h), d = g.data; for (let q = 0, o = 0; q < w * h; q++, o += 4) { const r = d[o], gg = d[o + 1], b = d[o + 2]; Y[q] = (r + 2 * gg + b) >> 2; G[q] = gg + r - 2 * b; } return { t: g.t, Y, G, rgb: d }; });
      if (fr.length < 9) { s.lcWhy = 'nopic'; continue; }
      // the place without the ball: for each element the usual value over those pictures
      const n = fr.length, bgY = new Uint8Array(w * h), bgG = new Int16Array(w * h), buf = new Int16Array(n); for (let q = 0; q < w * h; q++) { for (let i = 0; i < n; i++) buf[i] = fr[i].Y[q]; bgY[q] = medIn(buf); for (let i = 0; i < n; i++) buf[i] = fr[i].G[q]; bgG[q] = medIn(buf); }
      // the ball in each picture: a small spot that is not usually there and is yellower than what is
      const maxA = Math.max(30, 40 * rBall * rBall);
      const spots = fr.map(f => { const m = new Uint8Array(w * h); for (let q = 0; q < w * h; q++) if (f.Y[q] - bgY[q] > 12 || (f.G[q] - bgG[q] > 22 && f.Y[q] - bgY[q] > -4)) m[q] = 1; /* brighter or yellower than usual; darker is the ball's shadow, which lies elsewhere */ const out = [], seen = new Uint8Array(w * h), st = [];
        for (let q0 = 0; q0 < w * h; q0++) { if (!m[q0] || seen[q0]) continue; let cnt = 0, sx = 0, sy = 0, sw = 0, yb = 0, xa = w, xb = 0; seen[q0] = 1; st.push(q0); while (st.length) { const q = st.pop(), x = q % w, y = (q / w) | 0, wt = Math.max(1, f.Y[q] - bgY[q], (f.G[q] - bgG[q]) / 2); cnt++; sx += x * wt; sy += y * wt; sw += wt; if (y > yb) yb = y; if (x < xa) xa = x; if (x > xb) xb = x;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const r = yy * w + xx; if (m[r] && !seen[r]) { seen[r] = 1; st.push(r); } } }
          if (cnt >= 2 && cnt <= maxA) out.push({ x: sx / sw, y: sy / sw, yb, n: cnt, wd: xb - xa + 1 }); } return out; });
      // stretches of smooth movement: a spot followed from picture to picture while it keeps its pace (a ball in flight; the bounce breaks the pace, so it ends one stretch and starts another)
      const maxStep = Math.max(10, 60 * ppm * step * 1.3), used = spots.map(a => new Uint8Array(a.length)), runs = []; // a ball does not cover more than about 60 m/s
      for (let a = 0; a < n - 1; a++) for (let ai = 0; ai < spots[a].length; ai++) { if (used[a][ai]) continue; const ch = [[a, spots[a][ai]]], idx = [[a, ai]]; let last = spots[a][ai], lf = a, vx = null, vy = null;
        for (let b = a + 1; b < n && b - lf <= 2; b++) { let pick = -1, bd = Infinity; const gap = b - lf; for (let bi = 0; bi < spots[b].length; bi++) { if (used[b][bi]) continue; const p = spots[b][bi], ex = vx == null ? last.x : last.x + vx * gap, ey = vy == null ? last.y : last.y + vy * gap, d = Math.hypot(p.x - ex, p.y - ey), lim = vx == null ? maxStep * gap : Math.max(3, 0.35 * Math.hypot(vx, vy) * gap + 2); if (d < lim && d < bd && Math.hypot(p.x - last.x, p.y - last.y) > 0.5 * gap) { bd = d; pick = bi; } }
          if (pick >= 0) { const p = spots[b][pick]; vx = (p.x - last.x) / gap; vy = (p.y - last.y) / gap; last = p; lf = b; ch.push([b, p]); idx.push([b, pick]); } }
        if (ch.length >= 3) { for (const [f, k2] of idx) used[f][k2] = 1; runs.push(ch); } }
      const fitL = pts => { const m = pts.length; let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0; for (const [i, p] of pts) { st += i; sx += p.x; sy += p.y; stt += i * i; stx += i * p.x; sty += i * p.y; } const d = m * stt - st * st; if (Math.abs(d) < 1e-9) return null; const bx = (m * stx - st * sx) / d, by = (m * sty - st * sy) / d; return [(sx - bx * st) / m, bx, (sy - by * st) / m, by]; };
      // the bounce: a stretch coming down and a later one whose pace up the picture is suddenly different, meeting at one place. Straight lines through the last points before and the first after; where they cross is the bounce, also when the ball itself was not seen there (over the white of a line it is hard to see).
      const halves = []; for (const ch of runs) { halves.push([ch, null]); for (let i = 2; i < ch.length - 2; i++) halves.push([ch.slice(0, i + 1), ch.slice(i)]); } let hit = null;
      const tryPair = (pre, post, joined) => { if (pre.length < 3 || post.length < 3) return; const A = fitL(pre.slice(-4)), B = fitL(post.slice(0, 4)); if (!A || !B) return; const sp = Math.hypot(A[1], A[3]), drop = A[3] - B[3]; if (sp < 4 * ppm * step || drop < Math.max(0.8, 0.25 * sp)) return; /* a ball comes down at several metres a second, and the ground changes its pace at once */ const f0 = pre[pre.length - 1][0], f1 = post[0][0], tc = (B[2] - A[2]) / (A[3] - B[3]); if (tc < f0 - 0.75 || tc > f1 + 0.75) return;
        const xa = A[0] + A[1] * tc, xb = B[0] + B[1] * tc, miss = Math.abs(xa - xb); if (miss > 2.5 + 0.15 * sp) return; const y = A[2] + A[3] * tc, x = (xa + xb) / 2, off = Math.hypot(x - w / 2, y - h / 2) / (w / 2), sc = Math.min(8, pre.length + post.length) + 4 * Math.min(1, drop / (sp || 1)) - 3 * off - miss / 3 - (joined ? 0 : 0.3 * (f1 - f0)); if (!hit || sc > hit.sc) hit = { sc, tc, x, y, A, B, pre, post, miss }; };
      for (const [a, b] of halves) if (b) tryPair(a, b, true); for (const r1 of runs) for (const r2 of runs) if (r1 !== r2 && r2[0][0] > r1[r1.length - 1][0] && r2[0][0] - r1[r1.length - 1][0] <= 8) tryPair(r1, r2, false);
      const chain = hit ? hit.pre.concat(hit.post.filter(q => q[0] > hit.pre[hit.pre.length - 1][0])) : (runs.sort((p, q) => q.length - p.length)[0] || []);
      if (!hit) { s.lcWhy = runs.length ? 'nobounce' : 'noball'; if (debug) debug(s, { fr, w, h, x0, y0, k, spots, chain, bgY, line, why: s.lcWhy }); continue; }
      const ti = hit.tc, A = hit.A, ib = hit.pre.length - 1;
      // the ball touches the ground one radius below its middle: the place on the ground under it, by the court drawing
      const cg = cam.ground((hit.x + x0) / k, (hit.y + y0) / k, BALL_R), cp = cg ? P([cg[0], cg[1], 0]) : null, contact = cp ? [cp[0] - x0, cp[1] - y0] : [hit.x, hit.y + rBall];
      // the paint: along the court drawing's line, look across it for the bright band in the usual picture and take its outer edge
      const [name, ax, lv, la, lb, inside] = line, G0 = cam.ground((contact[0] + x0) / k, (contact[1] + y0) / k), along = G0 ? G0[1 - ax] : s.land[1 - ax], pt = (u, off) => { const X = [0, 0, 0]; X[ax] = lv + off; X[1 - ax] = u; return P(X); };
      const near0 = Math.max(0, Math.min(n - 9, Math.round(ti) - 4)), pY = new Float32Array(w * h); { const b9 = new Int16Array(Math.min(9, n)); for (let q = 0; q < w * h; q++) { for (let i = 0; i < b9.length; i++) b9[i] = fr[near0 + i].Y[q]; pY[q] = medIn(b9); } } // the place as it looked around the bounce (a camera that is being turned moves the line)
      const edgePts = [], bandPts = []; for (let u = Math.max(la, along - 2.5); u <= Math.min(lb, along + 2.5); u += 0.1) { const pc = pt(u, 0), po = pt(u, -inside * 0.5), dx = po[0] - pc[0], dy = po[1] - pc[1], dn = Math.hypot(dx, dy) || 1, ux = dx / dn, uy = dy / dn, prof = []; // ux,uy: towards outside, across the line
        const R = Math.max(16, Math.min(60, 1.0 * dn / 0.5)); for (let q = -R; q <= R; q += 0.5) { const X = pc[0] + ux * q - x0, Yp = pc[1] + uy * q - y0; if (X < 1 || Yp < 1 || X >= w - 2 || Yp >= h - 2) { prof.push(-1); continue; } const xi = X | 0, yi = Yp | 0, fx = X - xi, fy = Yp - yi, o = yi * w + xi; prof.push(pY[o] * (1 - fx) * (1 - fy) + pY[o + 1] * fx * (1 - fy) + pY[o + w] * (1 - fx) * fy + pY[o + w + 1] * fx * fy); }
        const ok = prof.filter(v => v >= 0); if (ok.length < 0.6 * prof.length) continue; const lo = med(ok), hi = Math.max(...ok); if (hi - lo < 25) continue; const th = lo + 0.5 * (hi - lo), sub = (i, j2) => { const v0 = prof[i], v1 = prof[j2]; return v0 < 0 || v1 < 0 || v0 === v1 ? i : i + (j2 - i) * (th - v0) / (v1 - v0); }; // where the profile crosses half height, between two samples
        // every bright band on the way across; the one a line's width wide and nearest to where the drawing puts the line is the paint
        let bestB = null; for (let a = 0; a < prof.length; a++) { if (prof[a] < th) continue; let b = a; while (b + 1 < prof.length && prof[b + 1] >= th) b++; if (a > 0 && b < prof.length - 1 && prof[a - 1] >= 0 && prof[b + 1] >= 0) { const ei = sub(a - 1, a), eo = sub(b + 1, b), qi = -R + 0.5 * ei, qo = -R + 0.5 * eo, wd = (qo - qi) * 0.5 / dn; if (wd >= 0.025 && (wd <= 0.16 || qo - qi <= 6)) { const off = Math.abs((qi + qo) / 2); if (!bestB || off < bestB[2]) bestB = [qi, qo, off]; } } a = b; }
        if (!bestB) continue; const [qi, qo] = bestB; edgePts.push([pc[0] + ux * qo - x0, pc[1] + uy * qo - y0, ux, uy, qo, Math.max(0, qo - qi - (name === 'baseline' ? 0.1 : 0.05) * dn / 0.5) / 2]); bandPts.push([pc[0] + ux * qi - x0, pc[1] + uy * qi - y0]); }
      { const mo = med(edgePts.map(e => e[4])); for (let i = edgePts.length - 1; i >= 0; i--) if (Math.abs(edgePts[i][4] - mo) > 2.5) { edgePts.splice(i, 1); bandPts.splice(i, 1); } } // one line: all its edge points lie the same way off the drawing
      if (edgePts.length < 8) { s.lcWhy = 'nopaint'; if (debug) debug(s, { fr, w, h, x0, y0, k, spots, chain, bgY, line, contact, why: 'nopaint', edgePts }); continue; }
      // a straight line through the outer edge near the bounce (total least squares), and the ball's distance from it, positive towards the court
      const near = edgePts.map(p => [Math.hypot(p[0] - contact[0], p[1] - contact[1]), p]).sort((p, q) => p[0] - q[0]).slice(0, 24).map(p => p[1]); let mx = 0, my = 0; for (const p of near) { mx += p[0]; my += p[1]; } mx /= near.length; my /= near.length; let sxx = 0, sxy = 0, syy = 0; for (const p of near) { sxx += (p[0] - mx) ** 2; sxy += (p[0] - mx) * (p[1] - my); syy += (p[1] - my) ** 2; }
      const th2 = 0.5 * Math.atan2(2 * sxy, sxx - syy), dir = [Math.cos(th2), Math.sin(th2)]; let nx = -dir[1], ny = dir[0]; { let ox = 0, oy = 0; for (const p of near) { ox += p[2]; oy += p[3]; } if (nx * ox + ny * oy < 0) { nx = -nx; ny = -ny; } } // nx,ny: across the line, towards outside
      const resid = Math.sqrt(near.reduce((a, p) => a + ((p[0] - mx) * nx + (p[1] - my) * ny) ** 2, 0) / near.length), dPx = -((contact[0] - mx) * nx + (contact[1] - my) * ny); // > 0: the contact point is on the court side of the outer edge
      // picture elements to centimetres across the line at that spot, from the court drawing
      const gA = cam.ground((contact[0] + x0) / k, (contact[1] + y0) / k), gB = cam.ground((contact[0] + nx * 4 + x0) / k, (contact[1] + ny * 4 + y0) / k); if (!gA || !gB) { s.lcWhy = 'noscale'; continue; } const mPerPx = Math.abs(gB[ax] - gA[ax]) / 4; if (!(mPerPx > 0) || mPerPx > 1.5 * MAX_M_PER_PX) { s.lcWhy = 'noscale'; continue; }
      // The ball is in when any part of where it touches the ground touches the line: the mark is about a ball's radius wide.
      const margin = dPx * mPerPx + BALL_R, unc = Math.max(0.02, Math.hypot(1.0, resid, hit.miss / 2, med(near.map(e => e[5]))) * mPerPx), verdict = margin > unc ? 'in' : margin < -unc ? 'out' : 'close';
      const gx = P([gA[0] + BALL_R, gA[1], 0]), gy = P([gA[0], gA[1] + BALL_R, 0]), g0 = P([gA[0], gA[1], 0]), rx = Math.hypot(gx[0] - g0[0], gx[1] - g0[1]), ry = Math.hypot(gy[0] - g0[0], gy[1] - g0[1]);
      // everything a drawing of the call needs, in the analysis picture's own measure
      s.lc = { verdict, cm: Math.round(margin * 100), unc: Math.round(unc * 100), line: name, t: fr[0].t + ti * step, uv: [(contact[0] + x0) / k, (contact[1] + y0) / k], edge: [(mx + x0) / k, (my + y0) / k, dir[0], dir[1]], rpx: Math.max(rx, ry) / k, squash: Math.max(0.25, Math.min(1, Math.min(rx, ry) / (Math.max(rx, ry) || 1))), flat: ry > rx, n: chain.length, mPerPx: +mPerPx.toFixed(4), seen: hit.pre[hit.pre.length - 1][0] + 1 >= hit.post[0][0] };
      if (debug) debug(s, { fr, w, h, x0, y0, k, spots, chain, bgY, line, contact, edgePts: near, bandPts, ib, why: '' });
    } catch (e) { s.lcWhy = 'error'; if (debug) console.error(e); }
    finally { if (onProgress) onProgress((li + 1) / list.length); } }
}

// What a review changes: a ball called in or out with room to spare takes that call; one the picture cannot settle stays "too close to call".
// Only the line that was in doubt is judged, so the call is taken only when the flight fit is sure of the other lines.
export function applyReview(s) { const L = s.lc; if (!L || s.result === 'net') return false; if (s.result0 === undefined) { s.result0 = s.result; s.close0 = !!s.close; } s.result = s.result0; s.close = s.close0; if (L.verdict === 'close') { s.close = true; return false; }
  const far = !s.far, x = s.serve && s.target ? (s.target === 'left' ? -1 : 1) * s.land[0] : Math.abs(s.land[0]), y = far ? s.land[1] : C.LEN - s.land[1], sdx = Math.max(0.15, s.landSd ? s.landSd[0] : 0.3), sdy = Math.max(0.15, s.landSd ? s.landSd[1] : 0.5), ySv = C.LEN - C.SV; // y: depth measured as for a ball landing on the far side
  const others = s.serve ? [L.line !== 'service' ? (ySv - y) / sdy : 9, L.line !== 'side' ? (C.S - x) / sdx : 9, L.line !== 'centre' ? x / sdx : 9, (y - C.NET) / sdy] : [L.line !== 'baseline' ? (C.LEN - y) / sdy : 9, L.line !== 'side' ? (C.S - x) / sdx : 9, (y - C.NET) / sdy];
  if (L.verdict === 'in') { if (Math.min(...others) < 1.5) { s.close = true; return false; } s.result = 'in'; } else s.result = L.line === 'baseline' || L.line === 'service' ? 'long' : 'wide';
  s.close = false; s.reviewed = true; return true; }
