// Baseline analysis engine. Pure JavaScript, no DOM: runs in the browser and in Node.
export const COURT = { S: 4.115, D: 5.485, SV: 6.40, LEN: 23.77, NET: 11.885, POST: 6.4, NET_C: 0.914, NET_P: 1.07 };
COURT.SV = 5.485; // service line distance from baseline
const G = 9.81, KD = 0.0204, KM = 0.0371, RB = 0.0335;
export const netHeight = x => COURT.NET_C + (COURT.NET_P - COURT.NET_C) * Math.min(1, Math.abs(x) / COURT.POST) ** 2;

// ---------- small linear algebra ----------
function rodrigues(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [r[0] / th, r[1] / th, r[2] / th], c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
function rotToVec(R) {
  const tr = R[0] + R[4] + R[8], th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (th < 1e-9) return [0, 0, 0];
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}
function solve(A, b) { // Gaussian elimination, A n x n (array of rows)
  const n = b.length; A = A.map(r => r.slice()); b = b.slice();
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-14) return null;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; if (!f) continue; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}
function invert(A) { const n = A.length, out = []; for (let i = 0; i < n; i++) { const e = new Array(n).fill(0); e[i] = 1; const c = solve(A, e); if (!c) return null; out.push(c); } return out[0].map((_, r) => out.map(c => c[r])); }
function polyfit(x, y, deg) {
  const n = deg + 1, A = [], b = [];
  for (let i = 0; i < n; i++) { A.push(new Array(n).fill(0)); b.push(0); }
  for (let k = 0; k < x.length; k++) { const p = [1]; for (let i = 1; i < 2 * n; i++) p.push(p[i - 1] * x[k]); for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i][j] += p[i + j]; b[i] += p[i] * y[k]; } }
  return solve(A, b) || new Array(n).fill(0); // ascending coefficients
}
const polyval = (c, x) => c.reduce((s, v, i) => s + v * x ** i, 0);

// Levenberg-Marquardt with box bounds and soft-L1 loss on the first nRobust residuals
export function lm(fn, x0, { lb, ub, nRobust = 0, fScale = 2, maxIter = 60, steps } = {}) {
  const n = x0.length; let x = x0.slice();
  const clamp = v => v.map((a, i) => Math.min(ub ? ub[i] : Infinity, Math.max(lb ? lb[i] : -Infinity, a)));
  const wres = r => r.map((v, i) => { if (i >= nRobust) return v; const z = (v / fScale) ** 2; return fScale * Math.sqrt(2 * (Math.sqrt(1 + z) - 1)) * Math.sign(v); });
  const cost = r => r.reduce((s, v) => s + v * v, 0);
  x = clamp(x); let r = wres(fn(x)), c = cost(r), lam = 1e-2;
  for (let it = 0; it < maxIter; it++) {
    const J = [];
    for (let k = 0; k < n; k++) {
      const h = steps ? steps[k] : 1e-4 * Math.max(1, Math.abs(x[k])); const xp = x.slice();
      const dir = (ub && x[k] + h > ub[k]) ? -1 : 1; xp[k] += dir * h;
      const rp = wres(fn(xp)); J.push(rp.map((v, i) => (v - r[i]) / (dir * h)));
    }
    const A = [], g = [];
    for (let i = 0; i < n; i++) { A.push(new Array(n)); let s = 0; for (let m = 0; m < r.length; m++) s += J[i][m] * r[m]; g.push(-s); for (let j = 0; j <= i; j++) { let t = 0; for (let m = 0; m < r.length; m++) t += J[i][m] * J[j][m]; A[i][j] = t; A[j][i] = t; } }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, i) => row.map((v, j) => i === j ? v * (1 + lam) + 1e-12 : v));
      const d = solve(M, g); if (!d) { lam *= 10; continue; }
      const xn = clamp(x.map((v, i) => v + d[i])), rn = wres(fn(xn)), cn = cost(rn);
      if (cn < c) { const rel = (c - cn) / Math.max(c, 1e-12); x = xn; r = rn; c = cn; lam = Math.max(lam / 5, 1e-9); improved = true; if (rel < 1e-7) it = maxIter; break; }
      lam *= 6;
    }
    if (!improved) break;
  }
  return { x, cost: c };
}

// ---------- camera ----------
export class Camera {
  constructor(p, W, H) { this.p = p.slice(); this.W = W; this.H = H; this.f = p[0]; this.k1 = p[1]; this.R = rodrigues(p.slice(2, 5)); this.t = p.slice(5, 8); this.cx = W / 2; this.cy = H / 2;
    const R = this.R, t = this.t; this.C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])]; }
  norm(X) { const R = this.R, t = this.t; const a = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0], b = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1], c = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2]; return [a / c, b / c, c]; }
  project(X) { const [x, y] = this.norm(X), d = 1 + this.k1 * (x * x + y * y); return [x * d * this.f + this.cx, y * d * this.f + this.cy]; }
  undist(u, v) { const x = (u - this.cx) / this.f, y = (v - this.cy) / this.f; let a = x, b = y; for (let i = 0; i < 8; i++) { const d = 1 + this.k1 * (a * a + b * b); a = x / d; b = y / d; } return [a, b]; }
  ray(u, v) { const [a, b] = this.undist(u, v), R = this.R; const d = [R[0] * a + R[3] * b + R[6], R[1] * a + R[4] * b + R[7], R[2] * a + R[5] * b + R[8]]; const n = Math.hypot(...d); return d.map(q => q / n); }
  ground(u, v, z = 0) { const d = this.ray(u, v), s = (z - this.C[2]) / d[2]; return [this.C[0] + s * d[0], this.C[1] + s * d[1], z]; }
  tapeY(u) { if (!this._tape) { this._tape = []; for (let i = 0; i <= 80; i++) { const x = -8 + i * 0.2; this._tape.push(this.project([x, COURT.NET, netHeight(x)])); } }
    const T = this._tape; if (u <= T[0][0]) return T[0][1]; for (let i = 1; i < T.length; i++) if (u <= T[i][0]) { const f = (u - T[i - 1][0]) / (T[i][0] - T[i - 1][0] || 1); return T[i - 1][1] + f * (T[i][1] - T[i - 1][1]); } return T[T.length - 1][1]; }
}

// court lines a user can mark (ground lines), as 3D segments
export const MODEL_LINES = (() => { const { S, D, SV, LEN } = COURT; return {
  baseline: [[-D, 0, 0], [D, 0, 0]], service: [[-S, SV, 0], [S, SV, 0]], center: [[0, SV, 0], [0, LEN - SV, 0]],
  singlesL: [[-S, 0, 0], [-S, LEN, 0]], singlesR: [[S, 0, 0], [S, LEN, 0]], doublesL: [[-D, 0, 0], [-D, LEN, 0]], doublesR: [[D, 0, 0], [D, LEN, 0]],
  farService: [[-S, LEN - SV, 0], [S, LEN - SV, 0]], farBaseline: [[-D, LEN, 0], [D, LEN, 0]] }; })();

function grayAt(img, x, y) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0; const i = (y * img.width + x) * 4, d = img.data; return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; }
// snap points along a tapped segment to the bright painted line nearby
export function refineLine(img, a, b, s = 1) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 5) return [a, b];
  const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], nrm = [-d[1], d[0]], R = Math.round(7 * s), pts = [];
  const N = Math.max(8, Math.min(120, Math.round(L / 4)));
  for (let k = 0; k <= N; k++) {
    const px = a[0] + d[0] * L * k / N, py = a[1] + d[1] * L * k / N; let best = -1, bo = 0, lo = 255;
    for (let o = -R; o <= R; o++) { const g = grayAt(img, px + nrm[0] * o, py + nrm[1] * o); if (g > best) { best = g; bo = o; } if (g < lo) lo = g; }
    if (best - lo > 25) { // sub-pixel centroid around the peak
      let sw = 0, so = 0; for (let o = bo - 3; o <= bo + 3; o++) { const w = Math.max(0, grayAt(img, px + nrm[0] * o, py + nrm[1] * o) - lo - (best - lo) * 0.5); sw += w; so += w * o; }
      const oo = sw > 0 ? so / sw : bo; pts.push([px + nrm[0] * oo, py + nrm[1] * oo]);
    }
  }
  return pts.length >= 6 ? pts : [a, b];
}

// lines: {id: [[x,y],...points on that line]}  ->  {cam, rms, perLine}
export function calibrate(lines, W, H) {
  const ids = Object.keys(lines).filter(k => MODEL_LINES[k] && lines[k].length >= 2);
  if (ids.length < 4) return null;
  const cx = W / 2, cy = H / 2, useK = ids.length >= 6;
  const resid = p => { const cam = new Camera(p, W, H), out = [];
    for (const id of ids) { const [A, B] = MODEL_LINES[id], a = cam.norm(A), b = cam.norm(B);
      if (a[2] < 0.05 && b[2] < 0.05) { for (const _ of lines[id]) out.push(500); continue; }
      let l = [a[1] - b[1], b[0] - a[0], a[0] * b[1] - b[0] * a[1]]; const n = Math.hypot(l[0], l[1]) || 1;
      for (const q of lines[id]) { const u = cam.undist(q[0], q[1]); out.push(p[0] * (u[0] * l[0] + u[1] * l[1] + l[2]) / n); } }
    return out; };
  const M = Math.max(W, H); let best = null;
  for (const fr of [0.5, 0.75, 1.1]) for (const cxw of [-7, 0, 7]) for (const cyw of [-7, -3]) for (const czw of [1.5, 4]) {
    const C = [cxw, cyw, czw], tgt = [0, 9, 0]; let z = tgt.map((v, i) => v - C[i]); let n = Math.hypot(...z); z = z.map(v => v / n);
    let x = [z[1], -z[0], 0]; n = Math.hypot(...x); x = x.map(v => v / n); // right = z cross up
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]; // down
    const R = [...x, ...y, ...z], t = [0, 1, 2].map(i => -(R[i * 3] * C[0] + R[i * 3 + 1] * C[1] + R[i * 3 + 2] * C[2]));
    const p0 = [fr * M, 0, ...rotToVec(R), ...t];
    const r = lm(resid, p0, { lb: [0.15 * M, useK ? -0.4 : -1e-9, -9, -9, -9, -80, -80, -80], ub: [5 * M, useK ? 0.4 : 1e-9, 9, 9, 9, 80, 80, 80], nRobust: 1e9, fScale: 2, maxIter: 80 });
    const cam = new Camera(r.x, W, H); if (cam.C[2] < 0.3 || cam.C[2] > 25) continue;
    if (!best || r.cost < best.cost) best = r;
  }
  if (!best) return null;
  const res = resid(best.x), perLine = {}; let i = 0, ss = 0;
  for (const id of ids) { let s = 0; for (const _ of lines[id]) { s += res[i] ** 2; i++; } ss += s; perLine[id] = Math.sqrt(s / lines[id].length); }
  return { cam: new Camera(best.x, W, H), rms: Math.sqrt(ss / res.length), perLine };
}

// ---------- ball candidate detector (streaming) ----------
export class Detector {
  constructor(W, H, cam, refPts) {
    this.W = W; this.H = H; this.cam = cam; this.s = Math.sqrt(W * H / (720 * 1280));
    this.cut = new Int32Array(W); this.tape = new Int32Array(W);
    for (let x = 0; x < W; x++) { // ignore the apron in front of the near baseline (shadows, feet)
      let yb = H; const a = cam.project([-12, 0, 0]), b = cam.project([12, 0, 0]);
      if (Math.abs(b[0] - a[0]) > 1) yb = a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
      this.cut[x] = Math.max(0, Math.min(H - 2, Math.round(yb - 10 * this.s))); this.tape[x] = Math.round(cam.tapeY(x) + 20 * this.s);
    }
    this.bufs = []; this.mask = new Uint8Array(W * H); this.n = 0; this.shift = [0, 0]; this.valid = true;
    this.ref = refPts || []; this.refScore = null; this.cw = Math.ceil(W / 4); this.ch = Math.ceil(H / 4); this.coarse = new Uint16Array(this.cw * this.ch);
  }
  _gray(rgba) { const W = this.W, H = this.H, g = new Uint8Array(W * H), t = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) t[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    for (let y = 1; y < H - 1; y++) { let o = y * W + 1; for (let x = 1; x < W - 1; x++, o++) g[o] = (t[o - W - 1] + 2 * t[o - W] + t[o - W + 1] + 2 * t[o - 1] + 4 * t[o] + 2 * t[o + 1] + t[o + W - 1] + 2 * t[o + W] + t[o + W + 1]) >> 4; }
    return g; }
  _drift(g) { if (this.ref.length < 20) return; const W = this.W, H = this.H, R = Math.round(8 * this.s); let best = -1, bx = 0, by = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { let s = 0; for (const p of this.ref) { const x = (p[0] + dx) | 0, y = (p[1] + dy) | 0; if (x >= 0 && y >= 0 && x < W && y < H) s += g[y * W + x]; } if (s > best) { best = s; bx = dx; by = dy; } }
    let s0 = 0; for (const p of this.ref) { const x = p[0] | 0, y = p[1] | 0; if (x >= 0 && y >= 0 && x < W && y < H) s0 += g[y * W + x]; }
    if (this.refScore === null) this.refScore = best;
    this.valid = best > 0.8 * this.refScore && Math.abs(bx) < R && Math.abs(by) < R; this.shift = [bx, by]; if (this.valid) this.refScore = 0.98 * this.refScore + 0.02 * best; }
  // push a frame; returns {t, c:[[x,y,area]], blobs:[[x0,y0,x1,y1]], valid} for the PREVIOUS frame (or null)
  push(rgba, t) {
    const g = this._gray(rgba);
    if (this.bufs.length) { const q = this.bufs[this.bufs.length - 1].g; let d = 0, m = 0; for (let i = 0; i < g.length; i += 97) { const e = g[i] - q[i]; d += e < 0 ? -e : e; m++; } if (d / m < 0.02) return null; } // repeated frame (re-encoded video): skip it
    if (this.n % 15 === 0) this._drift(g);
    this.bufs.push({ rgba, g, t, shift: this.shift.slice(), valid: this.valid }); this.n++;
    if (this.bufs.length < 3) return null;
    const [p, c, nx] = this.bufs, W = this.W, H = this.H, mask = this.mask, hits = [], d = c.rgba, coarse = this.coarse, cw = this.cw; coarse.fill(0);
    for (let y = 1; y < H - 1; y++) { let o = y * W + 1;
      for (let x = 1; x < W - 1; x++, o++) { const a = c.g[o]; let d1 = a - p.g[o]; if (d1 < 0) d1 = -d1; if (d1 <= 15) continue; let d2 = a - nx.g[o]; if (d2 < 0) d2 = -d2; if (d2 <= 15) continue;
        coarse[(y >> 2) * cw + (x >> 2)]++;
        if (y > this.cut[x]) continue;
        const j = o * 4, r = d[j], gg = d[j + 1], b = d[j + 2], mx = r > gg ? (r > b ? r : b) : (gg > b ? gg : b), mn = r < gg ? (r < b ? r : b) : (gg < b ? gg : b), df = mx - mn; if (mx < 100 || df === 0) continue;
        let h; if (mx === r) h = 30 * (gg - b) / df; else if (mx === gg) h = 60 + 30 * (b - r) / df; else h = 120 + 30 * (r - gg) / df; if (h < 0) h += 180;
        const sat = 255 * df / mx;
        if ((h >= 20 && h <= 50 && sat >= 60) || (y < this.tape[x] && h >= 20 && h <= 80 && sat >= 30 && mx >= 185)) hits.push(o); } }
    const out = { t: c.t, c: [], blobs: [], valid: c.valid };
    if (c.valid && hits.length < 4000) {
      for (const o of hits) { mask[o - W - 1] = mask[o - W] = mask[o - W + 1] = mask[o - 1] = mask[o] = mask[o + 1] = mask[o + W - 1] = mask[o + W] = mask[o + W + 1] = 1; }
      const stack = [], mxs = 45 * this.s, amax = 500 * this.s * this.s;
      for (const o0 of hits) for (const st of [o0 - W - 1, o0]) { if (mask[st] !== 1) continue; let a = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; stack.push(st); mask[st] = 2;
        while (stack.length) { const o = stack.pop(), x = o % W, y = (o / W) | 0; a++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (const q of [o - 1, o + 1, o - W, o + W, o - W - 1, o - W + 1, o + W - 1, o + W + 1]) if (q >= 0 && q < mask.length && mask[q] === 1) { mask[q] = 2; stack.push(q); } }
        if (a >= 3 && a <= amax && x1 - x0 < mxs && y1 - y0 < mxs) out.c.push([sx / a - c.shift[0], sy / a - c.shift[1], a]); }
      for (const o of hits) { mask[o - W - 1] = mask[o - W] = mask[o - W + 1] = mask[o - 1] = mask[o] = mask[o + 1] = mask[o + W - 1] = mask[o + W] = mask[o + W + 1] = 0; }
      // large moving blobs (players) on the coarse grid
      const ch = this.ch, seen = coarse; const minCells = 25;
      for (let i = 0; i < seen.length; i++) { if (seen[i] < 3 || seen[i] === 65535) continue; let a = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; stack.push(i); seen[i] = 65535;
        while (stack.length) { const o = stack.pop(), x = o % cw, y = (o / cw) | 0; a++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) { if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue; const q = yy * cw + xx; if (seen[q] >= 3 && seen[q] !== 65535) { seen[q] = 65535; stack.push(q); } } }
        if (a >= minCells) out.blobs.push([x0 * 4 - c.shift[0], y0 * 4 - c.shift[1], x1 * 4 + 4 - c.shift[0], y1 * 4 + 4 - c.shift[1]]); }
    }
    this.bufs.shift(); return out;
  }
}

// ---------- tracking ----------
export function buildTracks(frames, s = 1, maxMiss = 3) {
  let active = [], done = [];
  for (let i = 0; i < frames.length; i++) {
    const C = frames[i].c, used = new Uint8Array(C.length);
    active.sort((a, b) => b.length - a.length);
    for (const tr of active) {
      if (!C.length) break; const n = tr.length, last = tr[n - 1], dt = i - last[0]; let px, py, gate;
      if (n >= 3) { const k = Math.min(n, 6), seg = tr.slice(n - k), f = seg.map(q => q[0] - last[0]), dg = k >= 4 ? 2 : 1;
        const A = polyfit(f, seg.map(q => q[1]), dg), B = polyfit(f, seg.map(q => q[2]), dg); px = polyval(A, dt); py = polyval(B, dt); gate = 8 * s + 0.6 * Math.hypot(A[1], B[1]) * dt; }
      else if (n === 2) { const a = tr[0], vx = (last[1] - a[1]) / (last[0] - a[0]), vy = (last[2] - a[2]) / (last[0] - a[0]); px = last[1] + vx * dt; py = last[2] + vy * dt; gate = 10 * s + 0.6 * Math.hypot(vx, vy) * dt; }
      else { px = last[1]; py = last[2]; gate = 45 * s * dt; }
      let bj = -1, bd = 1e9; for (let j = 0; j < C.length; j++) { if (used[j]) continue; const d = Math.hypot(C[j][0] - px, C[j][1] - py); if (d < bd) { bd = d; bj = j; } }
      if (bj >= 0 && bd < gate) { tr.push([i, C[bj][0], C[bj][1], C[bj][2]]); used[bj] = 1; }
    }
    const still = []; for (const tr of active) (i - tr[tr.length - 1][0] > maxMiss ? done : still).push(tr); active = still;
    for (let j = 0; j < C.length; j++) if (!used[j]) active.push([[i, C[j][0], C[j][1], C[j][2]]]);
  }
  return done.concat(active).filter(tr => { if (tr.length < 5) return false; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of tr) { x0 = Math.min(x0, p[1]); x1 = Math.max(x1, p[1]); y0 = Math.min(y0, p[2]); y1 = Math.max(y1, p[2]); } return Math.hypot(x1 - x0, y1 - y0) >= 25 * s; });
}
function splitKinks(p, thr, w = 4) {
  const n = p.length; if (n < 2 * w + 1) return [p]; const bad = new Float64Array(n), sl = (a, b, c) => polyfit(p.slice(a, b).map(q => q[0]), p.slice(a, b).map(q => q[c]), 1)[1];
  for (let k = w; k < n - w; k++) bad[k] = Math.hypot(sl(k - w, k + 1, 1) - sl(k, k + w + 1, 1), sl(k - w, k + 1, 2) - sl(k, k + w + 1, 2));
  const cuts = []; let k = w; while (k < n - w) { if (bad[k] > thr) { let j = k; for (let q = k; q < Math.min(n - w, k + w); q++) if (bad[q] > bad[j]) j = q; cuts.push(j); k = j + w; } else k++; }
  const segs = []; let st = 0; for (const c of cuts) { segs.push(p.slice(st, c + 1)); st = c; } segs.push(p.slice(st)); return segs.filter(q => q.length >= 4);
}
function smoothRms(q) { const f = q.map(p => p[0] - q[0][0]), dg = q.length >= 5 ? 2 : 1; let s = 0; for (const c of [1, 2]) { const co = polyfit(f, q.map(p => p[c]), dg); q.forEach((p, i) => s += (p[c] - polyval(co, f[i])) ** 2); } return Math.sqrt(s / (2 * q.length)); }

// ---------- flight physics ----------
function acc(v, cl) { const sp = Math.hypot(v[0], v[1], v[2]); const a = [-KD * sp * v[0], -KD * sp * v[1], -G - KD * sp * v[2]];
  if (cl !== 0 && sp > 1e-6) { const ez = v[2] / sp, p = [ez * v[0] / sp, ez * v[1] / sp, -1 + ez * ez], n = Math.hypot(...p); if (n > 1e-9) { const k = KM * cl * sp * sp / n; a[0] += k * p[0]; a[1] += k * p[1]; a[2] += k * p[2]; } } return a; }
function rk4(p, v, cl, h) { const a1 = acc(v, cl), v2 = v.map((q, i) => q + 0.5 * h * a1[i]), a2 = acc(v2, cl), v3 = v.map((q, i) => q + 0.5 * h * a2[i]), a3 = acc(v3, cl), v4 = v.map((q, i) => q + h * a3[i]), a4 = acc(v4, cl);
  for (let i = 0; i < 3; i++) { p[i] += h / 6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]); v[i] += h / 6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]); } }
export function simulateAt(x, times) { const p = x.slice(0, 3), v = x.slice(3, 6), cl = x[6] || 0, out = []; let t = 0;
  for (const tq of times) { let rem = tq - t; const n = Math.max(1, Math.ceil(rem * 100)); for (let k = 0; k < n && rem > 1e-9; k++) rk4(p, v, cl, rem / (n - k) > 0 ? (tq - t) / (n - k) : 0), t += (tq - t) / (n - k); t = tq; out.push(p.slice()); } return out; }
export function flightSummary(x, tMax = 4) { const p = x.slice(0, 3), v = x.slice(3, 6), cl = x[6] || 0, h = 1 / 240, path = [p.slice()]; let t = 0, land = null, tLand = null, net = null;
  while (t < tMax) { const q = p.slice(); rk4(p, v, cl, h); t += h;
    if (!net && q[1] < COURT.NET && p[1] >= COURT.NET) { const f = (COURT.NET - q[1]) / (p[1] - q[1]); net = q.map((a, i) => a + f * (p[i] - a)); }
    if (p[2] <= RB && v[2] < 0) { const f = (q[2] - RB) / (q[2] - p[2] + 1e-12); land = q.map((a, i) => a + f * (p[i] - a)); tLand = t - h + f * h; path.push(land); break; }
    if (Math.round(t / h) % 4 === 0) path.push(p.slice()); }
  return { land, tLand, net, clear: net ? net[2] - RB - netHeight(net[0]) : null, path }; }
export function spinFromCl(cl, speed) { const a = Math.min(Math.abs(cl), 0.45); if (a < 1e-4) return 0; return Math.sign(cl) * speed / (RB * (1 / a - 2)) * 60 / (2 * Math.PI); }

function fitFlight(cam, t, uv, prior, s, freeSpin, warm) {
  const n = t.length, d0 = cam.ray(uv[0][0], uv[0][1]); let best = null;
  const res = x => { const X = simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], t), out = [];
    for (let i = 0; i < n; i++) { const q = cam.project(X[i]); out.push((q[0] - uv[i][0]) / s, (q[1] - uv[i][1]) / s); }
    const w = Math.sqrt(n / 10); if (prior.y != null) out.push((x[1] - prior.y) / prior.ySd * w); out.push((x[2] - prior.z) / prior.zSd * w); if (freeSpin) out.push(x[6] / prior.clSd); if (prior.anchorNet) out.push((X[n - 1][1] - COURT.NET) / 0.1 * w); return out; };
  const lb = [-12, -9, 0.1, -30, 3, -15, -0.45], ub = [12, 11, 3.6, 30, 70, 30, 0.45];
  if (warm) best = lm(res, freeSpin ? warm : warm.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 });
  else for (const z0 of [0.6, 1.2, 2.2]) { const sc = (z0 - cam.C[2]) / d0[2]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d0[i]);
    for (const T of [0.7, 1.2]) { const v0 = [(0 - p0[0]) / T, (17 - p0[1]) / T, (-z0 + 0.5 * G * T * T) / T];
      const x0 = [...p0, ...v0, 0]; const r = lm(res, freeSpin ? x0 : x0.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 });
      if (!best || r.cost < best.cost) best = r; } }
  if (!best) return null; const x = freeSpin ? best.x : [...best.x, 0]; const X = simulateAt(x, t), err = X.map((P, i) => { const q = cam.project(P); return Math.hypot(q[0] - uv[i][0], q[1] - uv[i][1]) / s; });
  return { x, err, rms: Math.sqrt(err.reduce((a, b) => a + b * b, 0) / n), res };
}
function covariance(fit, fnOut, h) { // propagate fit covariance to derived quantities
  const x = fit.x, r0 = fit.res(x), n = x.length, J = [];
  for (let k = 0; k < n; k++) { const a = x.slice(), b = x.slice(); a[k] += h[k]; b[k] -= h[k]; const ra = fit.res(a), rb = fit.res(b); J.push(ra.map((v, i) => (v - rb[i]) / (2 * h[k]))); }
  const A = []; for (let i = 0; i < n; i++) { A.push([]); for (let j = 0; j < n; j++) { let s = 0; for (let m = 0; m < r0.length; m++) s += J[i][m] * J[j][m]; A[i].push(s + (i === j ? 1e-9 : 0)); } }
  const C = invert(A); if (!C) return null; const s2 = Math.max(fit.rms, 1) ** 2, g0 = fnOut(x), Jg = [];
  for (let k = 0; k < n; k++) { const a = x.slice(), b = x.slice(); a[k] += 5 * h[k]; b[k] -= 5 * h[k]; const ga = fnOut(a), gb = fnOut(b); Jg.push(ga.map((v, i) => (v - gb[i]) / (10 * h[k]))); }
  return g0.map((_, o) => { let s = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += Jg[i][o] * C[i][j] * Jg[j][o]; return Math.sqrt(Math.max(0, s * s2)); });
}

// ---------- full analysis ----------
// frames: [{t, c, blobs, valid}], mode: 'coach' | 'serve' | 'match'
export function analyze(frames, cam, { mode = 'coach', onProgress, yOff = 1.25, ySd = 1.0, clSd = 0.2, zSd = 0.7, only = null } = {}) {
  const s = Math.sqrt(cam.W * cam.H / (720 * 1280)), H = cam.H, ts = frames.map(f => f.t);
  const fps = (frames.length - 1) / Math.max(1e-6, ts[ts.length - 1] - ts[0]), fs = 30 / fps; // pixel-per-frame thresholds were tuned at 30 fps
  const tracks = buildTracks(frames, s * Math.max(1, fs)); let segs = [];
  for (const tr of tracks) for (const q of splitKinks(tr, 6 * s * fs)) if (q.length >= 5 && smoothRms(q) < 2.5 * s) segs.push(q);
  segs.sort((a, b) => a[0][0] - b[0][0]);
  const used = new Set(), cands = [];
  for (let a = 0; a < segs.length; a++) { if (used.has(a)) continue; const q = segs[a], x0 = q[0][1], y0 = q[0][2];
    if (y0 < cam.tapeY(x0) + 25 * s) continue; if (q[q.length - 1][2] > y0 - 30 * s) continue;
    const chain = [q]; used.add(a);
    for (let b = a + 1; b < segs.length; b++) { if (used.has(b)) continue; const r = segs[b], last = chain[chain.length - 1], gap = r[0][0] - last[last.length - 1][0]; if (gap > 6 / fs) break; if (gap < -1) continue;
      const k = Math.min(last.length, 6), sg = last.slice(-k), f = sg.map(p => p[0] - r[0][0]); const px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0);
      if (Math.hypot(px - r[0][1], py - r[0][2]) < (15 + 3 * gap) * s) { chain.push(r); used.add(b); } }
    const seen = new Set(), pts = []; for (const sg of chain) for (const p of sg) if (!seen.has(p[0])) { seen.add(p[0]); pts.push(p); }
    pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) continue;
    const k = Math.min(5, pts.length), vy = polyfit(pts.slice(0, k).map(p => ts[p[0]]), pts.slice(0, k).map(p => p[2]), 1)[1];
    if (vy > -0.2 * H) continue; cands.push(pts); }
  // per candidate: observations and where the hitter stands (lowest edge of the moving blob next to the first ball position)
  const obs = cands.map(pts => { const t0 = ts[pts[0][0]], t = pts.map(p => ts[p[0]] - t0), uv = pts.map(p => [p[1], p[2]]); let feet = null; const i0 = pts[0][0];
    for (let i = Math.max(0, i0 - 8); i <= Math.min(frames.length - 1, i0 + 2); i++) for (const b of frames[i].blobs) { const w = b[2] - b[0], h = b[3] - b[1]; if (h < 0.08 * H || h > 0.7 * H) continue;
      if (uv[0][0] < b[0] - 1.2 * w || uv[0][0] > b[2] + 1.2 * w || uv[0][1] < b[1] - 0.5 * h || uv[0][1] > b[3]) continue; if (!feet || b[3] > feet[1]) feet = [(b[0] + b[2]) / 2, b[3]]; }
    const e = uv[uv.length - 1], d = cam.ray(e[0], e[1]), kk = (COURT.NET - cam.C[1]) / d[1], zNet = cam.C[2] + kk * d[2];
    return { t0, t, uv, fg: feet ? cam.ground(feet[0], feet[1]) : null, zNet }; });
  const fitOne = (o, off) => { const prior = { z: 1.3, zSd, y: o.fg ? o.fg[1] + off : null, ySd, clSd }; let t = o.t, uv = o.uv, n = t.length, fit = fitFlight(cam, t, uv, prior, s, true);
    while (fit && n > 8) { const e = fit.err.slice(-3).reduce((a, b) => a + b, 0) / 3; if (e <= 3.5) break; n -= 2; t = t.slice(0, n); uv = uv.slice(0, n); fit = fitFlight(cam, t, uv, prior, s, true); }
    return fit ? { fit, t, uv, n, prior } : null; };
  // Depth self-calibration. A ball that dies in the net was exactly at the net when it was last seen, which tells how far in front of the
  // hitter's feet the tracked flight really starts. Without enough net balls the default offset is used.
  const meta = { yOff, netRefs: 0, candidates: cands.length, fps };
  if (!only) { const refs = obs.filter(o => o.fg && o.t.length >= 8 && o.zNet > 0.05 && o.zNet < 1.12).slice(0, 40);
    const endY = off => { const ys = []; for (const o of refs) { const r = fitOne(o, off); if (!r || r.n < o.t.length || r.fit.rms > 3) continue; const y = simulateAt(r.fit.x, [r.t[r.n - 1]])[0][1]; if (Math.abs(y - COURT.NET) < 3.5) ys.push(y); } ys.sort((a, b) => a - b); return ys.length >= 4 ? [ys[ys.length >> 1], ys.length] : null; };
    if (refs.length >= 4) { const a = endY(yOff); if (a) { const b = endY(yOff + 0.8); let off = yOff; if (b && Math.abs(b[0] - a[0]) > 0.05) off = yOff + 0.8 * (COURT.NET - 0.1 - a[0]) / (b[0] - a[0]); meta.yOff = Math.max(0, Math.min(3, off)); meta.netRefs = a[1]; } } }
  const shots = [];
  obs.forEach((o, ci) => { if (onProgress) onProgress(ci / obs.length); if (only && !only.some(q => Math.abs(q - o.t0) < 0.3)) return;
    const r = fitOne(o, meta.yOff); if (!r) return; let { fit, t, uv, n, prior } = r; const fg = o.fg, t0 = o.t0; let netHit = false;
    if (fg && n === o.t.length && o.zNet > 0.05 && o.zNet < 1.12 && fit.rms <= 3 && Math.abs(simulateAt(fit.x, [t[n - 1]])[0][1] - COURT.NET) < 2.5) { // died in the net: pin the last point to the net plane
      prior = { ...prior, anchorNet: true }; const f2 = fitFlight(cam, t, uv, prior, s, true, fit.x); if (f2 && f2.rms <= 3) { fit = f2; netHit = true; } }
    if (fit.rms > 3) return; const x = fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6; if (speed < 30 || speed > 230 || x[4] < 6) return;
    const sum = flightSummary(x); if (!sum.land) return;
    const flat = fitFlight(cam, t, uv, prior, s, false, x);
    const sd = covariance(fit, y => { const q = flightSummary(y); return [q.land ? q.land[0] : 0, q.land ? q.land[1] : 0, q.net ? q.net[2] : 0, y[6]]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9];
    if (sd[1] > 3) return;
    const C = COURT, [lx, ly] = sum.land, serve = x[2] > 2.0 && x[1] < 1.5; let result, target = null;
    if (netHit || !sum.net || sum.clear < 0) result = 'net';
    else if (mode === 'serve' || (mode === 'match' && serve)) { const left = x[0] > 0; target = left ? 'left' : 'right';
      const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly <= C.LEN - C.SV) ? 'in' : (ly > C.LEN - C.SV ? 'long' : 'wide'); }
    else result = (Math.abs(lx) <= C.S && ly <= C.LEN) ? 'in' : (ly > C.LEN ? 'long' : 'wide');
    let close = false; if (result !== 'net') { const yLim = (mode === 'serve' || (mode === 'match' && serve)) ? C.LEN - C.SV : C.LEN, xs = target ? (target === 'left' ? [-C.S, 0] : [0, C.S]) : [-C.S, C.S];
      close = Math.abs(ly - yLim) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
    const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0);
    shots.push({ t: t0, n, nTotal: o.t.length, rms: fit.rms, rmsFlat: flat ? flat.rms : null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
      land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit, netZ: netHit ? o.zNet : null, serve, target, feetY: fg ? fg[1] : null,
      path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv });
  });
  shots.sort((a, b) => a.t - b.t); shots.meta = meta; return shots;
}
