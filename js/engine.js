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
  farService: [[-S, LEN - SV, 0], [S, LEN - SV, 0]], farBaseline: [[-D, LEN, 0], [D, LEN, 0]],
  tapeL: [[-COURT.POST, COURT.NET, COURT.NET_P], [0, COURT.NET, COURT.NET_C]], tapeR: [[0, COURT.NET, COURT.NET_C], [COURT.POST, COURT.NET, COURT.NET_P]] }; })(); // the top of the net: not on the ground, but a line at a known height that pins down the distance scale

function grayAt(img, x, y) { x = Math.round(x + (img.ox || 0)); y = Math.round(y + (img.oy || 0)); // ox, oy: how far this frame is displaced from the frame the court was first found in (a swaying camera)
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0; const i = (y * img.width + x) * 4, d = img.data; return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; }
// snap points along a tapped segment to the bright painted line nearby
export function refineLine(img, a, b, s = 1) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 5) return [a, b];
  const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], nrm = [-d[1], d[0]], R = Math.round(7 * s), wr = Math.max(4, Math.round(4 * s)), pts = [];
  const N = Math.max(8, Math.min(120, Math.round(L / 4)));
  for (let k = 0; k <= N; k++) {
    const px = a[0] + d[0] * L * k / N, py = a[1] + d[1] * L * k / N; let best = -1, bo = 0, lo = 255, rb = -1e9; const prof = []; // a painted line is a ridge (darker on both sides), not just the brightest spot: a sunlit patch next to it must not win
    for (let o = -R - wr; o <= R + wr; o++) prof.push(grayAt(img, px + nrm[0] * o, py + nrm[1] * o));
    for (let o = -R; o <= R; o++) { const g = prof[o + R + wr], rg = g - Math.max(prof[o + R], prof[o + R + 2 * wr]); if (rg > rb || (rg === rb && g > best)) { rb = rg; best = g; bo = o; } }
    lo = Math.max(prof[bo + R], prof[bo + R + 2 * wr]);
    if (best - lo > Math.max(10, 0.12 * best)) { // sub-pixel centroid around the peak
      let sw = 0, so = 0; for (let o = bo - 3; o <= bo + 3; o++) { const w = Math.max(0, grayAt(img, px + nrm[0] * o, py + nrm[1] * o) - lo - (best - lo) * 0.5); sw += w; so += w * o; }
      const oo = sw > 0 ? so / sw : bo; pts.push([px + nrm[0] * oo, py + nrm[1] * oo]);
    }
  }
  return pts.length >= 6 ? pts : [a, b];
}

// lines: {id: [[x,y],...points on that line]}  ->  {cam, rms, perLine}
export function calibrate(lines, W, H, init) {
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
  if (init) { const p0 = init.slice(); if (!useK) p0[1] = 0; best = lm(resid, p0, { lb: [0.15 * M, useK ? -0.4 : -1e-9, -9, -9, -9, -200, -200, -200], ub: [8 * M, useK ? 0.4 : 1e-9, 9, 9, 9, 200, 200, 200], nRobust: 1e9, fScale: 2, maxIter: 80 }); }
  else for (const [fr, cyw, czw] of [[0.5, -7, 1.5], [0.5, -3, 4], [0.75, -7, 1.5], [0.75, -7, 4], [1.1, -7, 4], [1.1, -3, 1.5], [1.6, -18, 8], [2.5, -30, 12]]) for (const cxw of [-7, 0, 7]) {
    const C = [cxw, cyw, czw], tgt = [0, 9, 0]; let z = tgt.map((v, i) => v - C[i]); let n = Math.hypot(...z); z = z.map(v => v / n);
    let x = [z[1], -z[0], 0]; n = Math.hypot(...x); x = x.map(v => v / n); // right = z cross up
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]; // down
    const R = [...x, ...y, ...z], t = [0, 1, 2].map(i => -(R[i * 3] * C[0] + R[i * 3 + 1] * C[1] + R[i * 3 + 2] * C[2]));
    const p0 = [fr * M, 0, ...rotToVec(R), ...t];
    const r = lm(resid, p0, { lb: [0.15 * M, useK ? -0.4 : -1e-9, -9, -9, -9, -200, -200, -200], ub: [8 * M, useK ? 0.4 : 1e-9, 9, 9, 9, 200, 200, 200], nRobust: 1e9, fScale: 2, maxIter: 80 });
    const cam = new Camera(r.x, W, H); if (cam.C[2] < 0.3 || cam.C[2] > 45) continue;
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
      let yb = H; const a = cam.project([-14, -3.5, 0]), b = cam.project([14, -3.5, 0]);
      if (Math.abs(b[0] - a[0]) > 1) yb = a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
      this.cut[x] = Math.max(0, Math.min(H - 2, Math.round(yb - 10 * this.s))); this.tape[x] = Math.round(cam.tapeY(x) + 20 * this.s);
    }
    this.bufs = []; this.mask = new Uint8Array(W * H); this.kind = new Uint8Array(W * H); this.mt = 15; this.n = 0; this.shift = [0, 0]; this.valid = true; this.maxShift = 0; this.busy = 0; this.dropped = 0;
    this.ref = refPts || []; this.refScore = null; this.cw = Math.ceil(W / 4); this.ch = Math.ceil(H / 4); this.coarse = new Uint16Array(this.cw * this.ch);
  }
  _gray(rgba) { const W = this.W, H = this.H, g = new Uint8Array(W * H), t = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) t[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    for (let y = 1; y < H - 1; y++) { let o = y * W + 1; for (let x = 1; x < W - 1; x++, o++) g[o] = (t[o - W - 1] + 2 * t[o - W] + t[o - W + 1] + 2 * t[o - 1] + 4 * t[o] + 2 * t[o + 1] + t[o + W - 1] + 2 * t[o + W] + t[o + W + 1]) >> 4; }
    return g; }
  // where the court lines are in this frame relative to the frame the court was marked in (a camera on a fence sways); mode 0: small step from the last position, 1: wider look around it, 2: anywhere within reach (start, after a cut, after losing it)
  _drift(g, mode) { if (this.ref.length < 20) return; const W = this.W, H = this.H, RM = Math.round(64 * this.s), ref = this.ref;
    const score = (dx, dy) => { let s = 0; for (const p of ref) { const x = (p[0] + dx) | 0, y = (p[1] + dy) | 0; if (x >= 0 && y >= 0 && x < W && y < H) s += g[y * W + x]; } return s; };
    const search = (cx, cy, r, st) => { let best = -1, bx = cx, by = cy; for (let dy = Math.max(-RM, cy - r); dy <= Math.min(RM, cy + r); dy += st) for (let dx = Math.max(-RM, cx - r); dx <= Math.min(RM, cx + r); dx += st) { const s = score(dx, dy); if (s > best) { best = s; bx = dx; by = dy; } } return [bx, by, best]; };
    const [cx0, cy0] = this.shift; let bx, by, best;
    let peak = 0; if (mode === 2) { [bx, by] = search(0, 0, RM, 3); [bx, by, best] = search(bx, by, 3, 1); const d = Math.round(9 * this.s), side = (score(bx + d, by) + score(bx - d, by) + score(bx, by + d) + score(bx, by - d)) / 4; peak = best / (side + 1); }
    else { [bx, by, best] = search(cx0, cy0, mode ? Math.round(8 * this.s) : 2, 1); const sc = score(cx0, cy0); if (best < 1.01 * sc) { bx = cx0; by = cy0; best = sc; } } // do not chase noise: move only for a clear gain
    if (this.refScore === null) { this.refScore = best; this.refScore0 = best; this.lostFor = 0; }
    this.valid = best > 0.8 * this.refScore && Math.abs(bx) < RM && Math.abs(by) < RM; this.shift = [bx, by];
    if (!this.valid && mode === 2 && peak > 1.25 && best > 0.45 * this.refScore0 && Math.abs(bx) < RM && Math.abs(by) < RM && ++this.lostFor > 4) { this.refScore = best; this.valid = true; } // the lines are clearly there, only fainter or brighter than at the start (sun, shade): take this as the new normal
    if (this.valid) { this.lostFor = 0; this.refScore = 0.98 * this.refScore + 0.02 * best; }
    if (Math.abs(bx) > this.maxShift) this.maxShift = Math.abs(bx); if (Math.abs(by) > this.maxShift) this.maxShift = Math.abs(by); }
  // push a frame; returns {t, c:[[x,y,area]], blobs:[[x0,y0,x1,y1]], valid} for the PREVIOUS frame (or null)
  push(rgba, t) {
    const g = this._gray(rgba);
    if (this.bufs.length) { const q = this.bufs[this.bufs.length - 1].g; let d = 0, m = 0; for (let i = 0; i < g.length; i += 97) { const e = g[i] - q[i]; d += e < 0 ? -e : e; m++; } if (d / m < 0.02) return null; } // repeated frame (re-encoded video): skip it
    // block averages of the picture: a big share of blocks changing at once means the video was edited here and another clip starts
    const bw = this.W >> 4, bh = this.H >> 4, blk = new Uint8Array(bw * bh); for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { let sum = 0; for (let dy = 2; dy < 16; dy += 4) { const o = (by * 16 + dy) * this.W + bx * 16; sum += g[o + 2] + g[o + 6] + g[o + 10] + g[o + 14]; } blk[by * bw + bx] = sum >> 4; }
    let cut = false; if (this.blk) { let c = 0; for (let i = 0; i < blk.length; i++) { const e = blk[i] - this.blk[i]; if (e > 12 || e < -12) c++; } cut = c / blk.length > 0.45; } this.blk = blk; // a swaying camera changes a good part of the picture too; only a change of scene counts
    this._drift(g, cut || this.n === 0 ? 2 : this.n % 15 === 0 ? 1 : 0); if (!this.valid && !cut) this._drift(g, 2); // lost the court: look further away, but not on every frame
    this.bufs.push({ rgba, g, t, shift: this.shift.slice(), valid: this.valid, cut }); this.n++;
    if (this.bufs.length < 3) return null;
    const [p, c, nx] = this.bufs, W = this.W, H = this.H, mask = this.mask, hits = [], d = c.rgba, coarse = this.coarse, cw = this.cw; coarse.fill(0);
    // compare each pixel with the same court spot in the neighbouring frames, allowing for the camera having moved a little in between
    const op = (p.shift[1] - c.shift[1]) * W + (p.shift[0] - c.shift[0]), on = (nx.shift[1] - c.shift[1]) * W + (nx.shift[0] - c.shift[0]), mg = 2 + Math.round(16 * this.s), MT = this.mt;
    for (let y = mg; y < H - mg; y++) { let o = y * W + mg;
      for (let x = mg; x < W - mg; x++, o++) { const a = c.g[o]; let d1 = a - p.g[o + op]; if (d1 < 0) d1 = -d1; if (d1 <= MT) continue; let d2 = a - nx.g[o + on]; if (d2 < 0) d2 = -d2; if (d2 <= MT) continue;
        coarse[(y >> 2) * cw + (x >> 2)]++;
        if (y > this.cut[x]) continue;
        const j = o * 4, r = d[j], gg = d[j + 1], b = d[j + 2], mx = r > gg ? (r > b ? r : b) : (gg > b ? gg : b), mn = r < gg ? (r < b ? r : b) : (gg < b ? gg : b), df = mx - mn; if (mx < 100 || df === 0) continue;
        let h; if (mx === r) h = 30 * (gg - b) / df; else if (mx === gg) h = 60 + 30 * (b - r) / df; else h = 120 + 30 * (r - gg) / df; if (h < 0) h += 180;
        const sat = 255 * df / mx;
        let ok = (h >= 20 && h <= 50 && sat >= 60) || (y < this.tape[x] && h >= 20 && h <= 80 && sat >= 30 && mx >= 185);
        let rel = false; if (!ok && d1 >= 30 && d2 >= 30) { const pd = p.rgba, nd = nx.rgba, jp = j + 4 * op, jn = j + 4 * on, yc = (r + gg) / 2 - b, yp = (pd[jp] + pd[jp + 1]) / 2 - pd[jp + 2], yn = (nd[jn] + nd[jn + 1]) / 2 - nd[jn + 2]; // more yellow-green than what was there before and after
          rel = yc - (yp > yn ? yp : yn) >= 22 && gg - (pd[jp + 1] > nd[jn + 1] ? pd[jp + 1] : nd[jn + 1]) >= 8 && gg >= r - 25; }
        if (!ok && !rel) continue;
        // a camera that moved a fraction of a pixel makes every sharp edge (leaves, court lines) look like movement: a real ball is still different when the neighbouring frames are allowed to slip by one pixel (only for a camera that has been seen to move: on a fixed one this would cost real, faint balls)
        if (this.maxShift >= 4) { const pg = p.g, ng = nx.g, o1 = o + op, o2 = o + on; let m1 = 255, m2 = 255; for (let dy = -W; dy <= W; dy += W) for (let dx = -1; dx <= 1; dx++) { let v = a - pg[o1 + dy + dx]; if (v < 0) v = -v; if (v < m1) m1 = v; v = a - ng[o2 + dy + dx]; if (v < 0) v = -v; if (v < m2) m2 = v; } if (m1 <= MT || m2 <= MT) continue; }
        if (ok) { hits.push(o); this.kind[o] = 1; } else hits.push(o); } }
    const out = { t: c.t, c: [], c2: [], blobs: [], valid: c.valid, cut: c.cut }; // c: blobs with clear ball colour; c2: also small blobs that only pass the weaker test
    if (!(c.valid && hits.length < 4000)) for (const o of hits) this.kind[o] = 0; if (hits.length >= 4000) this.busy++; // too much of the picture moving at once (wind in trees, camera knocked): the frame cannot be used
    if (c.valid && hits.length < 4000) {
      for (const o of hits) { mask[o - W - 1] = mask[o - W] = mask[o - W + 1] = mask[o - 1] = mask[o] = mask[o + 1] = mask[o + W - 1] = mask[o + W] = mask[o + W + 1] = 1; }
      const stack = [], mxs = 45 * this.s, amax = 500 * this.s * this.s;
      for (const o0 of hits) for (const st of [o0 - W - 1, o0]) { if (mask[st] !== 1) continue; let a = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; stack.push(st); mask[st] = 2;
        let strict = 0; while (stack.length) { const o = stack.pop(), x = o % W, y = (o / W) | 0; a++; sx += x; sy += y; strict += this.kind[o]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (const q of [o - 1, o + 1, o - W, o + W, o - W - 1, o - W + 1, o + W - 1, o + W + 1]) if (q >= 0 && q < mask.length && mask[q] === 1) { mask[q] = 2; stack.push(q); } }
        if (!strict && (x1 - x0 > 11 * this.s || y1 - y0 > 11 * this.s)) continue; // only a small blob may pass on the weaker colour test
        if (a >= 3 && a <= amax && x1 - x0 < mxs && y1 - y0 < mxs) { const q = [sx / a - c.shift[0], sy / a - c.shift[1], a]; out.c2.push(q); if (strict) out.c.push(q); } }
      for (const o of hits) { this.kind[o] = 0; mask[o - W - 1] = mask[o - W] = mask[o - W + 1] = mask[o - 1] = mask[o] = mask[o + 1] = mask[o + W - 1] = mask[o + W] = mask[o + W + 1] = 0; }
      // There is one ball. When many things light up at once (the camera shook, wind in the trees) they come in clumps; a ball is on its own. In such a frame keep only what stands alone.
      if (out.c2.length > 8) { const L = out.c2, R2 = (45 * this.s) ** 2, lone = q => { let n = 0; for (const r of L) { const dx = r[0] - q[0], dy = r[1] - q[1]; if (dx * dx + dy * dy < R2 && ++n > 2) return false; } return true; }; // n counts q itself too: at most one neighbour allowed
        const keep = new Set(L.filter(lone)); this.dropped += L.length - keep.size; out.c2 = L.filter(q => keep.has(q)); out.c = out.c.filter(q => keep.has(q)); }
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
    if (frames[i].cut) { for (const tr of active) done.push(tr); active = []; }
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
    if (!net && (q[1] - COURT.NET) * (p[1] - COURT.NET) <= 0 && q[1] !== p[1]) { const f = (COURT.NET - q[1]) / (p[1] - q[1]); net = q.map((a, i) => a + f * (p[i] - a)); }
    if (p[2] <= RB && v[2] < 0) { const f = (q[2] - RB) / (q[2] - p[2] + 1e-12); land = q.map((a, i) => a + f * (p[i] - a)); tLand = t - h + f * h; path.push(land); break; }
    if (Math.round(t / h) % 4 === 0) path.push(p.slice()); }
  return { land, tLand, net, clear: net ? net[2] - RB - netHeight(net[0]) : null, path }; }
export function spinFromCl(cl, speed) { const a = Math.min(Math.abs(cl), 0.45); if (a < 1e-4) return 0; return Math.sign(cl) * speed / (RB * (1 / a - 2)) * 60 / (2 * Math.PI); }

function fitFlight(cam, t, uv, prior, s, freeSpin, warm) {
  const n = t.length, d0 = cam.ray(uv[0][0], uv[0][1]); let best = null;
  const res = x => { const X = simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], t), out = [];
    for (let i = 0; i < n; i++) { const q = cam.project(X[i]); out.push((q[0] - uv[i][0]) / s, (q[1] - uv[i][1]) / s); }
    const w = Math.sqrt(n / 10); if (prior.y != null) out.push((x[1] - prior.y) / prior.ySd * w); out.push((x[2] - prior.z) / prior.zSd * w); if (freeSpin) out.push(x[6] / prior.clSd); if (prior.anchorNet) out.push((X[n - 1][1] - COURT.NET) / 0.1 * w); if (prior.ground) out.push((X[n - 1][0] - prior.ground[0]) / 0.3 * w, (X[n - 1][1] - prior.ground[1]) / 0.3 * w, (X[n - 1][2] - RB) / 0.08 * w);
    if (prior.groundAt) { const P = simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], [prior.groundAt.t])[0], g = prior.groundAt.g; out.push((P[0] - g[0]) / 0.3 * w, (P[1] - g[1]) / 0.4 * w, (P[2] - RB) / 0.08 * w); } // the bounce was seen a moment after the track was lost: the ball is on the ground there, then
    if (prior.rad) { // how fast the ball shrinks in the picture tells how fast it is going away (the measured blob is the ball plus a constant halo, which is left free)
      const pr = []; let m = 0; for (let i = 0; i < n; i++) { const dx = X[i][0] - cam.C[0], dy = X[i][1] - cam.C[1], dz = X[i][2] - cam.C[2], v = prior.rad[i] - cam.f * RB / Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz)); pr.push(v); m += v; } m /= n; for (let i = 0; i < n; i++) out.push((pr[i] - m) / (0.7 * s)); }
    return out; };
  const inc = prior.dir === -1, lb = inc ? [-12, COURT.NET - 3, 0.1, -30, -70, -15, -0.45] : [-12, -9, 0.1, -30, prior.serve ? 16 : 3, -15, -0.45], ub = inc ? [12, COURT.LEN + 8, 5, 30, -3, 30, 0.45] : [12, 11, 3.6, 30, 70, 30, 0.45];
  if (inc && !warm) { const e = uv[n - 1], gp = cam.ground(e[0], e[1]); // a ball coming toward the camera: start it somewhere on the far side, aim it at where it was last seen
    for (const y0 of [COURT.LEN - 1, COURT.LEN - 6, COURT.NET + 3]) { const sc = (y0 - cam.C[1]) / d0[1]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d0[i]); if (p0[2] < 0.1 || p0[2] > 5) continue;
      for (const T of [0.8, 1.4]) { const x0 = [...p0, (gp[0] - p0[0]) / T, Math.min(-3.5, (gp[1] - p0[1]) / T), (-p0[2] + 0.5 * G * T * T) / T, 0]; const r = lm(res, freeSpin ? x0 : x0.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 }); if (!best || r.cost < best.cost) best = r; } } }
  else
  if (warm) best = lm(res, freeSpin ? warm : warm.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 });
  else if (prior.serve) { for (const y0 of [-0.4, 0.5]) { const sc = (y0 - cam.C[1]) / d0[1]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d0[i]); if (p0[2] < 1.5 || p0[2] > 3.6) continue; // a serve: the ball starts above the server's head near the baseline
      for (const T of [0.45, 0.75]) { const x0 = [...p0, (0 - p0[0]) / T, (17.5 - p0[1]) / T, (-p0[2] + 0.5 * G * T * T) / T, 0]; const r = lm(res, freeSpin ? x0 : x0.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 }); if (!best || r.cost < best.cost) best = r; } } }
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
// The ball is found with two colour tests. The strict one is clean when the ball is big and well lit; the weaker one is needed when the ball is
// small or washed out (camera far away) but lets in more clutter. Both are analyzed and the one that yields more valid shots is kept.
// Places where "balls" keep turning up all through the video are not balls (leaves moving in the wind, a flag, a light): a real ball crosses any one spot only now and then.
function quiet(frames) { const G = 20, cnt = new Map(), key = q => ((q[1] / G) | 0) * 4096 + ((q[0] / G) | 0); let n = 0; for (const f of frames) { n++; const seen = new Set(); for (const q of f.c2 || f.c) { const k = key(q); if (!seen.has(k)) { seen.add(k); cnt.set(k, (cnt.get(k) || 0) + 1); } } }
  const lim = Math.max(60, 0.03 * n), bad = new Set(); for (const [k, v] of cnt) if (v > lim) bad.add(k);
  // frames with many "balls" at once (the camera shook, a gust in the trees): there is only one ball, so in those frames drop everything in the places that light up during such bursts
  const B = 12, bc = new Map(); let nb = 0; for (const f of frames) { const l = f.c2 || f.c; if (l.length <= B) continue; nb++; const seen = new Set(); for (const q of l) { const k = key(q); if (!seen.has(k)) { seen.add(k); bc.set(k, (bc.get(k) || 0) + 1); } } }
  const blim = Math.max(8, 0.01 * nb), bbad = new Set(); for (const [k, v] of bc) if (v > blim) bbad.add(k); if (!bad.size && !bbad.size) return { frames, cells: 0, removed: 0 };
  let removed = 0; return { frames: frames.map(f => { const burst = (f.c2 || f.c).length > B, keep = q => { const k = key(q); if (bad.has(k) || (burst && bbad.has(k))) { removed++; return false; } return true; }; return { ...f, c: f.c.filter(keep), c2: f.c2 && f.c2.filter(keep) }; }), cells: bad.size + bbad.size, removed }; }
export function analyze(frames0, cam, opts = {}) { const qz = quiet(frames0), frames = qz.frames, out = analyze2(frames, cam, opts); out.meta.noisy = [qz.cells, qz.removed]; return out; }
function analyze2(frames, cam, opts = {}) { const p = opts.onProgress, a = analyzeCore(frames, cam, { ...opts, onProgress: p && (v => p(v / 2)) });
  if (opts.only || !frames.some(f => f.c2 && f.c2.length > f.c.length)) { a.meta.colour = 'strict'; return a; }
  const b = analyzeCore(frames.map(f => ({ ...f, c: f.c2 || f.c })), cam, { ...opts, onProgress: p && (v => p(0.5 + v / 2)) });
  // near player's shots: whichever colour test gives clearly more; far-side shots (small, far ball): likewise, chosen separately
  const near = q => !q.far, far = q => q.far, na = a.filter(near).length, nb = b.filter(near).length, fa = a.length - na, fb = b.length - nb;
  const useB = nb > na * 1.15 + 1, farB = fb > fa, out = (useB ? b : a).filter(near).concat((farB ? b : a).filter(far)); out.sort((u, v) => u.t - v.t);
  out.meta = { ...(useB ? b : a).meta, colour: useB ? 'weak' : 'strict', other: useB ? na : nb, farColour: farB ? 'weak' : 'strict', incoming: (farB ? b : a).meta.incoming }; return out; }
function analyzeCore(frames, cam, { mode = 'coach', onProgress, yOff = 1.25, ySd = 1.0, clSd = 0.2, zSd = 0.7, only = null } = {}) {
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
  const meta = { yOff, netRefs: 0, candidates: cands.length, fps, segments: segs.length, rej: { nofit: 0, rms: 0, speed: 0, noland: 0, depth: 0 } };
  if (!only) { const refs = obs.filter(o => o.fg && o.t.length >= 8 && o.zNet > 0.05 && o.zNet < 1.12).slice(0, 40);
    const endY = off => { const ys = []; for (const o of refs) { const r = fitOne(o, off); if (!r || r.n < o.t.length || r.fit.rms > 3) continue; const y = simulateAt(r.fit.x, [r.t[r.n - 1]])[0][1]; if (Math.abs(y - COURT.NET) < 3.5) ys.push(y); } ys.sort((a, b) => a - b); return ys.length >= 4 ? [ys[ys.length >> 1], ys.length] : null; };
    if (refs.length >= 4) { const a = endY(yOff); if (a) { const b = endY(yOff + 0.8); let off = yOff; if (b && Math.abs(b[0] - a[0]) > 0.05) off = yOff + 0.8 * (COURT.NET - 0.1 - a[0]) / (b[0] - a[0]); meta.yOff = Math.max(0.6, Math.min(2.2, off)); meta.netRefs = a[1]; } } }
  const shots = [];
  obs.forEach((o, ci) => { if (onProgress) onProgress(ci / obs.length); if (only && !only.some(q => Math.abs(q - o.t0) < 0.3)) return;
    const r = fitOne(o, meta.yOff); if (!r) { meta.rej.nofit++; return; } let { fit, t, uv, n, prior } = r; const fg = o.fg, t0 = o.t0; let netHit = false;
    if (fg && n === o.t.length && o.zNet > 0.05 && o.zNet < 1.12 && fit.rms <= 3 && Math.abs(simulateAt(fit.x, [t[n - 1]])[0][1] - COURT.NET) < 2.5) { // died in the net: pin the last point to the net plane
      prior = { ...prior, anchorNet: true }; const f2 = fitFlight(cam, t, uv, prior, s, true, fit.x); if (f2 && f2.rms <= 3) { fit = f2; netHit = true; } }
    if (fit.rms > 3) { meta.rej.rms++; return; } const x = fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6; if (speed < 30 || speed > 230 || x[4] < 6) { meta.rej.speed++; return; }
    const sum = flightSummary(x); if (!sum.land) { meta.rej.noland++; return; }
    const flat = fitFlight(cam, t, uv, prior, s, false, x);
    const sd = covariance(fit, y => { const q = flightSummary(y); return [q.land ? q.land[0] : 0, q.land ? q.land[1] : 0, q.net ? q.net[2] : 0, y[6]]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9];
    if (sd[1] > 3) { meta.rej.depth++; return; }
    const C = COURT, [lx, ly] = sum.land, serve = x[2] > 2.0 && x[1] < 1.5; let result, target = null;
    if (mode === 'serve' && !serve) { meta.rej.notServe = (meta.rej.notServe || 0) + 1; return; } // serve practice: a ball bounced on the ground or rolled back is not a serve
    if (netHit || !sum.net || sum.clear < 0) result = 'net';
    else if (mode === 'serve' || (mode === 'match' && serve)) { const left = x[0] > 0; target = left ? 'left' : 'right';
      const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly <= C.LEN - C.SV) ? 'in' : (ly > C.LEN - C.SV ? 'long' : 'wide'); }
    else result = (Math.abs(lx) <= C.S && ly <= C.LEN) ? 'in' : (ly > C.LEN ? 'long' : 'wide');
    let close = false; if (result !== 'net') { const yLim = (mode === 'serve' || (mode === 'match' && serve)) ? C.LEN - C.SV : C.LEN, xs = target ? (target === 'left' ? [-C.S, 0] : [0, C.S]) : [-C.S, C.S];
      close = Math.abs(ly - yLim) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
    const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0);
    shots.push({ t: t0, who: 'me', far: false, n, nTotal: o.t.length, rms: fit.rms, rmsFlat: flat ? flat.rms : null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
      land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit, netZ: netHit ? o.zNet : null, serve, target, feetY: fg ? fg[1] : null,
      path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv });
  });
  // ---- serves hit from the near side. Seen from a camera a few metres up, the ball leaves the racket above the net tape in the picture and comes DOWN the picture while it flies away, so it never qualifies as an ordinary near-side shot.
  const usedS = new Set(); meta.nearServes = 0;
  if (mode !== 'coach' && !only) for (let a = 0; a < segs.length; a++) { if (usedS.has(a)) continue; const q = segs[a], x0 = q[0][1], y0 = q[0][2], e0 = q[q.length - 1];
    if (y0 > cam.tapeY(x0) - 5 * s || e0[2] < y0 + 20 * s) continue; const chain = [q], idx = [a];
    for (let b = a + 1; b < segs.length; b++) { if (usedS.has(b)) continue; const r = segs[b], last = chain[chain.length - 1], gap = r[0][0] - last[last.length - 1][0]; if (gap > 6 / fs) break; if (gap < -1) continue;
      const k = Math.min(last.length, 6), sg = last.slice(-k), f = sg.map(p => p[0] - r[0][0]), px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0);
      if (Math.hypot(px - r[0][1], py - r[0][2]) < (15 + 3 * gap) * s && r[r.length - 1][2] > r[0][2]) { chain.push(r); idx.push(b); } }
    const seenF = new Set(), pts = []; for (const sg of chain) for (const p of sg) if (!seenF.has(p[0])) { seenF.add(p[0]); pts.push(p); } pts.sort((u, v) => u[0] - v[0]); if (pts.length < 6) continue;
    // the toss often runs straight into the serve as one track: the hit is where the ball suddenly gets much faster in the picture
    { const st = []; for (let i = 1; i < pts.length; i++) st.push(Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) / Math.max(1, pts[i][0] - pts[i - 1][0])); let cut = 0;
      for (let i = 1; i < Math.min(st.length - 5, 30); i++) { const before = Math.max(st[i - 1], i > 1 ? st[i - 2] : 0, 1.5 * s * fs); if (st[i] > 2.5 * before && st[i + 1] > 0.5 * st[i]) cut = i; }
      if (cut) pts.splice(0, cut); if (pts.length < 6) continue; }
    const end = pts[pts.length - 1], gpe = cam.ground(end[1], end[2]); if (!gpe || gpe[1] < COURT.NET - 1 || gpe[1] > COURT.LEN + 12) continue; // last seen on the near side of the net: not a serve going away
    const d0 = cam.ray(pts[0][1], pts[0][2]), sc0 = (0 - cam.C[1]) / d0[1], zB = cam.C[2] + sc0 * d0[2]; if (!(sc0 > 0) || zB < 1.6 || zB > 3.6) continue; // over the baseline it must be at a height a racket can reach
    let ground = null, groundAt = null; for (const r of segs) { const g0 = r[0][0] - end[0]; if (g0 < 0 || g0 > 3 || r === chain[chain.length - 1]) continue; if (Math.hypot(r[0][1] - end[1], r[0][2] - end[2]) < 14 * s && r.length >= 4 && r[Math.min(3, r.length - 1)][2] < r[0][2] - 2 * s) { ground = gpe; break; } }
    if (!ground) { // the ball is often lost just before it lands (bright court, small ball) and found again coming up off the ground: where the two paths meet is the bounce
      const k = Math.min(5, pts.length), A = pts.slice(-k), tE = ts[end[0]], ax = polyfit(A.map(p => ts[p[0]] - tE), A.map(p => p[1]), 1), ay = polyfit(A.map(p => ts[p[0]] - tE), A.map(p => p[2]), 1);
      for (const r of segs) { if (r.length < 4 || r === chain[chain.length - 1]) continue; const gap = ts[r[0][0]] - tE; if (gap < 0.03 || gap > 0.6) continue; if (Math.abs(r[0][1] - end[1]) > 70 * s || Math.abs(r[0][2] - end[2]) > 70 * s) continue;
        const B = r.slice(0, Math.min(5, r.length)), by = polyfit(B.map(p => ts[p[0]] - tE), B.map(p => p[2]), 1), bx = polyfit(B.map(p => ts[p[0]] - tE), B.map(p => p[1]), 1); if (!(ay[1] > 0) || !(by[1] < -20 * s)) continue; // going down before, coming up after
        const tau = (by[0] - ay[0]) / (ay[1] - by[1]); if (!(tau > -0.02) || tau > gap + 0.02) continue; const yy = ay[0] + ay[1] * tau, xx = 0.5 * (ax[0] + ax[1] * tau + bx[0] + bx[1] * tau), g = cam.ground(xx, yy); if (!g || g[1] < COURT.NET - 2 || g[1] > COURT.LEN + 8) continue;
        groundAt = { t: tE - ts[pts[0][0]] + Math.max(0, tau), g }; break; } }
    meta.nearServes++; if (!ground && !groundAt) { meta.rej.noBounce = (meta.rej.noBounce || 0) + 1; continue; } // a ball flying straight away from the camera can be fast and deep or slow and short and draw nearly the same line in the picture: without the bounce the serve cannot be measured honestly
    const t0 = ts[pts[0][0]], t = pts.map(p => ts[p[0]] - t0), uv = pts.map(p => [p[1], p[2]]), prior = { serve: true, y: 0.2, ySd: 0.5, z: 2.7, zSd: 0.4, clSd, ground, groundAt, rad: pts.map(p => Math.sqrt(p[3] / Math.PI)) };
    const fit = fitFlight(cam, t, uv, prior, s, true); if (!fit || fit.rms > 3) { meta.rej.rms++; continue; } const x = fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6; if (speed < 50 || speed > 260) { meta.rej.speed++; continue; }
    const sum = flightSummary(x); if (!sum.land) { meta.rej.noland++; continue; }
    const sd = covariance(fit, y => { const w = flightSummary(y); return [w.land ? w.land[0] : 0, w.land ? w.land[1] : 0, w.net ? w.net[2] : 0, y[6]]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9]; if (sd[1] > (ground || groundAt ? 3 : 2.5)) { meta.rej.depth++; continue; }
    const C = COURT, [lx, ly] = sum.land, left = x[0] > 0, target = left ? 'left' : 'right'; let result;
    if (!sum.net || sum.clear < 0) result = 'net'; else { const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly <= C.LEN - C.SV) ? 'in' : (ly > C.LEN - C.SV ? 'long' : 'wide'); }
    let close = false; if (result !== 'net') { const xs = left ? [-C.S, 0] : [0, C.S]; close = Math.abs(ly - (C.LEN - C.SV)) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
    const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0); for (const i of idx) usedS.add(i);
    shots.push({ t: t0, who: 'me', far: false, bounce: !!(ground || groundAt), n: pts.length, nTotal: pts.length, rms: fit.rms, rmsFlat: null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
      land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit: false, netZ: null, serve: true, target, feetY: null,
      path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv }); }
  // ---- balls coming toward the camera: the opponent's shots in a match, or serves hit from the far side in serve practice
  if (mode !== 'coach' && !only) { const usedI = new Set(usedS); meta.incoming = 0;
    for (let a = 0; a < segs.length; a++) { if (usedI.has(a)) continue; const q = segs[a], x0 = q[0][1], y0 = q[0][2], e0 = q[q.length - 1];
      if (y0 > cam.tapeY(x0) + 12 * s || e0[2] < y0 + 40 * s) continue; // must start at or above the net tape and travel down the picture
      const chain = [q]; usedI.add(a);
      for (let b = a + 1; b < segs.length; b++) { if (usedI.has(b)) continue; const r = segs[b], last = chain[chain.length - 1], gap = r[0][0] - last[last.length - 1][0]; if (gap > 6 / fs) break; if (gap < -1) continue;
        const k = Math.min(last.length, 6), sg = last.slice(-k), f = sg.map(p => p[0] - r[0][0]), px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0);
        if (Math.hypot(px - r[0][1], py - r[0][2]) < (15 + 3 * gap) * s && r[r.length - 1][2] > r[0][2]) { chain.push(r); usedI.add(b); } }
      const seenF = new Set(), pts = []; for (const sg of chain) for (const p of sg) if (!seenF.has(p[0])) { seenF.add(p[0]); pts.push(p); } pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) continue;
      const end = pts[pts.length - 1]; if (end[2] < cam.tapeY(end[1]) + 15 * s) continue; // never came down past the net
      // did it bounce? a track that starts where this one ends and climbs is the ball coming up off the ground: that spot is the landing point
      let ground = null; for (const r of segs) { const g0 = r[0][0] - end[0]; if (g0 < 0 || g0 > 3 || r === chain[chain.length - 1]) continue; if (Math.hypot(r[0][1] - end[1], r[0][2] - end[2]) < 14 * s && r.length >= 4 && r[Math.min(3, r.length - 1)][2] < r[0][2] - 2 * s) { ground = cam.ground(end[1], end[2]); break; } }
      meta.incoming++; const t0 = ts[pts[0][0]], t = pts.map(p => ts[p[0]] - t0), uv = pts.map(p => [p[1], p[2]]), prior = { dir: -1, y: null, z: 1.4, zSd: 1.2, clSd, ground };
      const fit = fitFlight(cam, t, uv, prior, s, true); if (!fit || fit.rms > 3) continue; const x = fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6; if (speed < 25 || speed > 240) continue;
      const sum = flightSummary(x); if (!sum.land) continue;
      const sd = covariance(fit, y => { const w = flightSummary(y); return [w.land ? w.land[0] : 0, w.land ? w.land[1] : 0, w.net ? w.net[2] : 0, y[6]]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9]; if (sd[1] > (ground ? 3 : 1.5)) continue; // without a visible bounce the depth of an incoming ball is only trusted when the fit is tight
      const C = COURT, [lx, ly] = sum.land, serve = x[2] > 2.0 && x[1] > C.LEN - 2; let result, target = null;
      const past = x[1] < C.NET + 0.3; // first seen when it was already at the net: it did get over
      if (!past && (!sum.net || sum.clear < 0)) result = 'net';
      else if (mode === 'serve' || serve) { const left = x[0] > 0; target = left ? 'left' : 'right'; const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly >= C.SV) ? 'in' : (ly < C.SV ? 'long' : 'wide'); }
      else result = (Math.abs(lx) <= C.S && ly >= 0) ? 'in' : (ly < 0 ? 'long' : 'wide');
      let close = false; if (result !== 'net') { const yLim = target ? C.SV : 0, xs = target ? (target === 'left' ? [-C.S, 0] : [0, C.S]) : [-C.S, C.S]; close = Math.abs(ly - yLim) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
      const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0);
      shots.push({ t: t0, who: mode === 'serve' ? 'me' : 'opp', far: true, bounce: !!ground, n: pts.length, nTotal: pts.length, rms: fit.rms, rmsFlat: null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
        land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit: false, netZ: null, serve: mode === 'serve' || serve, target, feetY: null,
        path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv }); } }
  shots.sort((a, b) => a.t - b.t); shots.meta = meta; return shots;
}

// ---------- automatic court finder ----------
// Finds painted lines, groups them into "along the court" (meeting at a vanishing point) and "across the court",
// then tries every way of naming them and keeps the naming under which the whole court drawing best lands on paint.
// Assumes the camera looks down the court from behind one baseline. Returns {raw: {lineId: [[x,y],[x,y]]}, score} or null.
// Look for paint where the fitted camera says the not-yet-used lines should be, and refit with whatever is found.
function growLines(img, lines, raw, cal) { const W = img.width, H = img.height, s = Math.max(0.8, Math.sqrt(W * H / (720 * 1280))), segs = Object.entries(MODEL_LINES);
  const vis = (cam, A, B) => { let first = null, last = null; for (let k = 0; k <= 60; k++) { const P = [A[0] + (B[0] - A[0]) * k / 60, A[1] + (B[1] - A[1]) * k / 60, A[2] + (B[2] - A[2]) * k / 60]; if (cam.norm(P)[2] < 0.1) continue; const q = cam.project(P); if (q[0] < 6 || q[1] < 6 || q[0] > W - 6 || q[1] > H - 6) continue; if (!first) first = q; last = q; }
    if (!first) return null; const L = Math.hypot(first[0] - last[0], first[1] - last[1]); return L < 40 * s ? null : { first, last, want: Math.max(8, Math.min(120, Math.round(L / 4))) + 1 }; };
  const tryAdd = (ln, c, id, off = 0) => { const v = vis(c.cam, ...MODEL_LINES[id]); if (!v) return null; const a = [v.first[0], v.first[1] + off], b = [v.last[0], v.last[1] + off], got = refineLine(img, a, b, 2 * s); if (got.length < 0.6 * v.want) return null;
    const trial = { ...ln, [id]: got }, c2 = calibrate(trial, W, H, c.cam.p); return c2 && c2.rms <= Math.max(2.5 * s, 1.5 * c.rms) && c2.perLine[id] <= (id.startsWith('tape') ? 6 : 3) * s ? { lines: trial, cal: c2, raw: [a, b], my: got.reduce((u, q) => u + q[1], 0) / got.length } : null; }; // nets are not all exactly regulation height, so the tape gets more slack
  // With only the baseline and side lines the distance scale is loose, and one wrong cross line (the net tape taken for a court line) ruins it. So the service line is chosen among the candidates near where it should be as the one that makes the most OTHER things fall into place: the net tape at its real height, the centre line, the far baseline.
  if (!lines.service && cal.rms <= 3 * s) { let best = null; const cands = []; for (const k of [0, -1, 1, -2, 2, -3, 3, -4, 4]) { const t = tryAdd(lines, cal, 'service', k * 14 * s); if (!t) continue; let conf = 0; for (const id2 of ['tapeL', 'tapeR', 'center', 'farBaseline']) if (tryAdd(t.lines, t.cal, id2)) conf++; t.conf = conf; cands.push(t); if (!best || conf > best.conf || (conf === best.conf && t.cal.rms < best.cal.rms)) best = t; }
    const distinct = best && cands.every(t => Math.abs(t.my - best.my) < 8 * s); // only one painted line anywhere near: nothing to confuse it with
    if (best && (best.conf >= 1 || distinct)) { lines = best.lines; cal = best.cal; raw.service = best.raw; } }
  for (let round = 0; round < 3 && cal.rms <= 3 * s; round++) { let added = 0;
    for (const [id] of segs) { if (lines[id] || (id.startsWith('far') && (round === 0 || !lines.service)) || (id === 'center' && !lines.service)) continue; // without a second cross line the distance scale is open: adding more lengthwise lines only lets it drift if (id === 'service') { const t = tryAdd(lines, cal, id); if (t && (lines.tapeL || lines.tapeR || lines.center)) { lines = t.lines; cal = t.cal; raw[id] = t.raw; added++; } continue; }
      if (id.startsWith('far')) { const v = vis(cal.cam, ...MODEL_LINES[id]); if (!v) continue; const got = refineLine(img, v.first, v.last, 2 * s); let dd = 0; for (const q of got) dd += Math.abs(q[1] - cal.cam.tapeY(q[0])); if (!got.length || dd / got.length < 7 * s) continue; } // that is the net tape, not a line on the ground
      const t = tryAdd(lines, cal, id); if (t) { lines = t.lines; cal = t.cal; raw[id] = t.raw; added++; } }
    if (!added) break; }
  return { lines, cal }; }
// Use another frame of the same fixed camera to pick up lines that were hidden (by a player, by shade) in the frame the court was found in.
export function growCourt(img0, court) { const s = Math.max(0.8, Math.sqrt(img0.width * img0.height / (720 * 1280))), all = Object.values(court.lines).flat(), d = Math.round(6 * s);
  // the camera may have moved between the two frames (it hangs on a fence): find how far, and read this frame through that offset
  const sc = (dx, dy) => { const im = { width: img0.width, height: img0.height, data: img0.data, ox: dx, oy: dy }; let t = 0; for (let i = 0; i < all.length; i += 2) { const p = all[i]; t += 2 * grayAt(im, p[0], p[1]) - grayAt(im, p[0], p[1] - d) - grayAt(im, p[0], p[1] + d) + 2 * grayAt(im, p[0], p[1]) - grayAt(im, p[0] - d, p[1]) - grayAt(im, p[0] + d, p[1]); } return t; };
  let bx = 0, by = 0, bs = sc(0, 0); const R = Math.round(80 * s); for (let dy = -R; dy <= R; dy += 3) for (let dx = -R; dx <= R; dx += 3) { const v = sc(dx, dy); if (v > bs * 1.02 + 1) { bs = v; bx = dx; by = dy; } } for (let dy = by - 3; dy <= by + 3; dy++) for (let dx = bx - 3; dx <= bx + 3; dx++) { const v = sc(dx, dy); if (v > bs) { bs = v; bx = dx; by = dy; } }
  const img = { width: img0.width, height: img0.height, data: img0.data, ox: bx, oy: by };
  const raw = { ...court.raw }, r = growLines(img, { ...court.lines }, raw, court.cal); return { raw, lines: r.lines, cal: r.cal, n: Object.keys(r.lines).length }; }
export function autoCourt(img, dbg) { const M = Math.max(img.width, img.height); if (M <= 2000) return autoCourtCore(img, dbg);
  const k = Math.ceil(M / 960), w = Math.floor(img.width / k), h = Math.floor(img.height / k), small = new Uint8ClampedArray(w * h * 4), d = img.data; // box-average down, search there, then refit on the full frame
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let r = 0, g = 0, b = 0; for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const j = ((y * k + dy) * img.width + x * k + dx) * 4; r += d[j]; g += d[j + 1]; b += d[j + 2]; } const o = (y * w + x) * 4, n = k * k; small[o] = r / n; small[o + 1] = g / n; small[o + 2] = b / n; small[o + 3] = 255; }
  const r0 = autoCourtCore({ width: w, height: h, data: small }, dbg); if (!r0) return null; const s = Math.sqrt(img.width * img.height / (720 * 1280)), raw = {}, lines = {};
  for (const id in r0.raw) { raw[id] = r0.raw[id].map(q => [q[0] * k + k / 2, q[1] * k + k / 2]); lines[id] = refineLine(img, raw[id][0], raw[id][1], 1.5 * s); }
  const p0 = r0.cal.cam.p.slice(); p0[0] *= k; let cal = calibrate(lines, img.width, img.height, p0); if (!cal || cal.rms > 4 * s) cal = calibrate(lines, img.width, img.height); if (!cal || cal.rms > 4 * s) return null;
  return { raw, lines, cal, n: Object.keys(lines).length }; }
function autoCourtCore(img, dbg) {
  const W = img.width, H = img.height, d = img.data, s = Math.sqrt(W * H / (720 * 1280)), g = new Uint8Array(W * H), sat = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) { const r = d[j], gg = d[j + 1], b = d[j + 2]; g[i] = (r * 77 + gg * 150 + b * 29) >> 8; sat[i] = Math.max(r, gg, b) - Math.min(r, gg, b); }
  const hist = new Uint32Array(256); for (let i = 0; i < g.length; i += 7) hist[g[i]]++; let acc95 = 0, p95 = 255; const tot = Math.ceil(g.length / 7); for (let v = 255; v >= 0; v--) { acc95 += hist[v]; if (acc95 >= 0.05 * tot) { p95 = v; break; } }
  const CT = Math.max(7, Math.min(18, 18 * p95 / 200)), VMIN = Math.max(25, Math.min(70, 0.35 * p95)); // dark footage: paint is dimmer and stands out less
  const mask = new Uint8Array(W * H), ws = [Math.max(2, Math.round(3 * s)), Math.max(4, Math.round(8 * s))], pts = [];
  for (let y = 10; y < H - 10; y++) for (let x = 10; x < W - 10; x++) { const o = y * W + x, v = g[o]; if (v < VMIN) continue; let on = false; const st = sat[o];
    for (const w of ws) { if ((v - Math.max(g[o - w], g[o + w]) > CT && (st <= 70 || st < Math.min(sat[o - w], sat[o + w]) - 25)) || (v - Math.max(g[o - w * W], g[o + w * W]) > CT && (st <= 70 || st < Math.min(sat[o - w * W], sat[o + w * W]) - 25))) { on = true; break; } } if (on) { mask[o] = 1; pts.push(o); } }
  { // paint lines are thin: drop areas where the mask is dense (sunlit foliage, fences, crowds)
    const B = Math.max(16, Math.round(40 * s)), bw = Math.ceil(W / B), bh = Math.ceil(H / B), cnt = new Float32Array(bw * bh); for (const o of pts) cnt[((o / W / B) | 0) * bw + ((o % W) / B | 0)]++;
    const bad = new Uint8Array(bw * bh); for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { let sum = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = by + dy, xx = bx + dx; if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue; sum += cnt[yy * bw + xx]; n++; } if (!globalThis.NOD && (cnt[by * bw + bx] > 0.3 * B * B || sum > 0.12 * n * B * B)) bad[by * bw + bx] = 1; }
    let k = 0; for (const o of pts) { if (bad[((o / W / B) | 0) * bw + ((o % W) / B | 0)]) mask[o] = 0; else pts[k++] = o; } pts.length = k; }
  if (dbg) dbg.pts = pts.length;
  if (pts.length < 200 || pts.length > 0.2 * W * H) return null;
  // Hough transform
  const NT = 180, RS = 2, diag = Math.hypot(W, H), NR = Math.ceil(2 * diag / RS) + 1, acc = new Int32Array(NT * NR), cs = [], sn = [];
  for (let t = 0; t < NT; t++) { cs.push(Math.cos(t * Math.PI / NT)); sn.push(Math.sin(t * Math.PI / NT)); }
  for (const o of pts) { const x = o % W, y = (o / W) | 0; for (let t = 0; t < NT; t++) acc[t * NR + Math.round((x * cs[t] + y * sn[t] + diag) / RS)]++; }
  const peaks = []; const thr = 55 * s;
  for (let k = 0; k < 18; k++) { let best = 0, bi = -1; for (let i = 0; i < acc.length; i++) if (acc[i] > best) { best = acc[i]; bi = i; } if (best < thr) break; const t = (bi / NR) | 0, r = bi % NR; peaks.push([t, r, best]);
    for (let dt = -5; dt <= 5; dt++) { let tt = t + dt, rr0 = r; if (tt < 0) { tt += NT; rr0 = NR - 1 - r; } else if (tt >= NT) { tt -= NT; rr0 = NR - 1 - r; } for (let dr = -9; dr <= 9; dr++) { const rr = rr0 + dr; if (rr >= 0 && rr < NR) acc[tt * NR + rr] = 0; } } }
  // refine each peak to a line a*x+b*y+c=0 from nearby paint pixels
  const lines = [];
  for (const [t, r, votes] of peaks) { let a = cs[t], b = sn[t], c = -(r * RS - diag);
    for (let it = 0; it < 2; it++) { let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0; for (const o of pts) { const x = o % W, y = (o / W) | 0; if (Math.abs(a * x + b * y + c) > 4 * s) continue; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
      if (n < 20) break; const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cxy = sxy / n - mx * my, cyy = syy / n - my * my, th = 0.5 * Math.atan2(2 * cxy, cxx - cyy); a = -Math.sin(th); b = Math.cos(th); c = -(a * mx + b * my); }
    if (!lines.some(l => Math.abs(l[0] * a + l[1] * b) > 0.998 && Math.abs(Math.abs(l[2]) - Math.abs(c)) < 6 * s)) lines.push([a, b, c, votes]); }
  if (dbg) { dbg.L = lines; dbg.P = pts; dbg.peaks = peaks.length; dbg.lines = lines.map(l => [Math.round(Math.atan2(-l[0], l[1]) * 180 / Math.PI), Math.round(-(l[0] * W / 2 + l[2]) / (l[1] || 1e-9))]); }
  if (lines.length < 4) return null;
  const X = (l, m) => { const z = l[0] * m[1] - l[1] * m[0]; if (Math.abs(z) < 1e-9) return null; return [(l[1] * m[2] - l[2] * m[1]) / z, (l[2] * m[0] - l[0] * m[2]) / z]; };
  // candidate vanishing points for the lines that run along the court
  const vps = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) { const p = X(lines[i], lines[j]); if (!p || p[0] < -0.6 * W || p[0] > 1.6 * W || p[1] < -1.2 * H || p[1] > 0.72 * H) continue;
    const grp = lines.filter(l => Math.abs(l[0] * p[0] + l[1] * p[1] + l[2]) < 24 * s), an = grp.map(l => Math.atan2(-l[0], l[1])); let spread = 0; for (const u of an) for (const v of an) { let dd = Math.abs(u - v); if (dd > Math.PI / 2) dd = Math.PI - dd; if (dd > spread) spread = dd; }
    if (spread < 0.4) continue; vps.push({ p, grp, wt: grp.reduce((q, l) => q + l[3], 0) }); }
  vps.sort((u, v) => v.wt - u.wt); const vpList = []; for (const v of vps) { if (vpList.length >= 6) break; if (!vpList.some(u => Math.hypot(u.p[0] - v.p[0], u.p[1] - v.p[1]) < 40 * s)) vpList.push(v); }
  if (dbg) dbg.vp = vpList.map(v => [v.p.map(Math.round), v.grp.length]);
  if (!vpList.length) return null;
  const dil = new Uint8Array(W * H), R = Math.max(2, Math.round(2.5 * s)); for (const o of pts) { const x = o % W, y = (o / W) | 0; for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) dil[yy * W + xx] = 1; } }
  const C = COURT, AX = [-C.D, -C.S, 0, C.S, C.D], AID = ['doublesL', 'singlesL', 'center', 'singlesR', 'doublesR'], CY = [0, C.SV, C.LEN - C.SV, C.LEN], CID = ['baseline', 'service', 'farService', 'farBaseline'];
  const homog = (w, im) => { const A = [], b = []; for (let k = 0; k < 4; k++) { const [x, y] = w[k], [u, v] = im[k]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); } return solve(A, b); };
  const pr = (h, x, y) => { const z = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z, z]; };
  const NS = 40, segs = Object.entries(MODEL_LINES).filter(([id]) => !id.startsWith('tape')), tops = []; let best = null;
  for (const bestVp of vpList) {
  const yRef = Math.min(H - 1, Math.max(bestVp.p[1] + 0.25 * H, 0.7 * H)), xAt = l => Math.abs(l[0]) < 1e-6 ? 1e9 : -(l[1] * yRef + l[2]) / l[0];
  const along = bestVp.grp.slice().sort((p, q) => xAt(p) - xAt(q)).slice(0, 7);
  const yAt = l => -(l[0] * W / 2 + l[2]) / l[1];
  const across = lines.filter(l => !bestVp.grp.includes(l) && Math.abs(l[1]) > 0.75 && yAt(l) > bestVp.p[1]).sort((p, q) => yAt(q) - yAt(p)).slice(0, 6); // bottom of the image first
  if (across.length < 2) continue;
  for (let i = 0; i < along.length; i++) for (let j = i + 1; j < along.length; j++) for (let p = 0; p < across.length; p++) for (let q = p + 1; q < across.length; q++) {
    const im = [X(along[i], across[p]), X(along[j], across[p]), X(along[i], across[q]), X(along[j], across[q])]; if (im.some(v => !v)) continue;
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) for (let c = 0; c < 4; c++) for (let e = c + 1; e < 4; e++) {
      const h = homog([[AX[a], CY[c]], [AX[b], CY[c]], [AX[a], CY[e]], [AX[b], CY[e]]], im); if (!h) continue;
      let plaus = false;
      { // the camera this naming implies must be a believable one (skipped for long lenses, where this quick estimate is unreliable)
        const u1 = [h[0] - W / 2 * h[6], h[3] - H / 2 * h[6], h[6]], u2 = [h[1] - W / 2 * h[7], h[4] - H / 2 * h[7], h[7]], u3 = [h[2] - W / 2, h[5] - H / 2, 1], den = u1[2] * u2[2], M = Math.max(W, H);
        const f2 = Math.abs(den) < 1e-14 ? Infinity : -(u1[0] * u2[0] + u1[1] * u2[1]) / den;
        if (f2 > 0 && f2 < (0.35 * M) ** 2) continue;
        if (f2 > 0 && f2 < (2.2 * M) ** 2) { const f = Math.sqrt(f2), k = v => [v[0] / f, v[1] / f, v[2]];
          const r1 = k(u1), r2 = k(u2), t = k(u3), n1 = Math.hypot(...r1), n2 = Math.hypot(...r2); if (n1 / n2 < 0.75 || n1 / n2 > 1.33) continue; const lam = (n1 + n2) / 2;
          const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]].map(v => v / (n1 * n2)), dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
          const Cx = -dot(r1, t) / (n1 * lam), Cy = -dot(r2, t) / (n2 * lam), Cz = Math.abs(dot(r3, t) / lam); if (Cz < 0.8 || Cz > 40 || Cy > 2 || Cy < -120 || Math.abs(Cx) > 30) continue; plaus = Math.abs(Cx) < 12; } }
      let score = 0, vis = 0, usedL = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; const per = {};
      for (const [id, [A, B]] of segs) { let hit = 0, n = 0, first = null, last = null; for (let k = 0; k <= NS; k++) { const P = pr(h, A[0] + (B[0] - A[0]) * k / NS, A[1] + (B[1] - A[1]) * k / NS); if (P[2] <= 0) continue; const x = Math.round(P[0]), y = Math.round(P[1]); if (x < 4 || y < 4 || x >= W - 4 || y >= H - 4) continue; n++; if (!first) first = P; last = P; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (dil[y * W + x]) hit++; }
        vis += n; score += hit - 0.7 * (n - hit); per[id] = { hit, n, first, last };
        if (n >= 6 && hit / n >= 0.5) { const dx = last[0] - first[0], dy = last[1] - first[1], L = Math.hypot(dx, dy); if (L > 20 * s) { const mx = (first[0] + last[0]) / 2, my = (first[1] + last[1]) / 2;
          for (let q = 0; q < lines.length; q++) { const l = lines[q]; if (usedL & (1 << q)) continue; if (Math.abs(l[0] * dx + l[1] * dy) / L < 0.05 && Math.abs(l[0] * mx + l[1] * my + l[2]) < 5 * s) { usedL |= 1 << q; score += 1000; per[id].m = true; break; } } } } }
      if (vis < 3 * NS || x1 - x0 < 0.3 * W || y1 - y0 < 0.12 * H) continue; // too little of the court in view to trust
      if (plaus) score += 1500; // a quick camera estimate that makes sense counts for more than one extra matched line
      if (!best || score > best.score) best = { score, per, vis }; if (score > 4000) { tops.push({ score, per, vis }); if (tops.length > 400) { tops.sort((u, v) => v.score - u.score); tops.length = 40; } } } }
  }
  if (dbg) dbg.best = best && [best.score, best.vis];
  if (!best || best.score < 4000) return null;
  // check the most promising namings with the full camera fit and keep the one that explains the most lines well
  tops.sort((u, v) => v.score - u.score); let pick = null; const seen = new Set();
  for (const hyp of tops) { if (seen.size >= 14 || (pick && pick.n >= 6)) break; const raw = {};
    for (const id in hyp.per) { const q = hyp.per[id]; if (q.m && !id.startsWith('far') && q.n >= 6 && q.hit / q.n >= 0.5 && Math.hypot(q.first[0] - q.last[0], q.first[1] - q.last[1]) > 30 * s) raw[id] = [[q.first[0], q.first[1]], [q.last[0], q.last[1]]]; }
    const key = Object.keys(raw).map(id => id + Math.round(raw[id][0][1] / 20)).join(); if (seen.has(key) || Object.keys(raw).length < 4) continue; seen.add(key);
    let lines = {}; for (const id in raw) lines[id] = refineLine(img, raw[id][0], raw[id][1], s); let cal = calibrate(lines, W, H); if (!cal) continue;
    const bad = Object.keys(cal.perLine).filter(id => cal.perLine[id] > 4 * Math.max(s, 0.8)); if (bad.length && Object.keys(lines).length - bad.length >= 4) { for (const id of bad) { delete lines[id]; delete raw[id]; } cal = calibrate(lines, W, H); if (!cal) continue; }
    ({ lines, cal } = growLines(img, lines, raw, cal));
    const n = Object.keys(lines).length, C = cal.cam.C; if (dbg) (dbg.tried = dbg.tried || []).push([Object.keys(lines).join('+'), +cal.rms.toFixed(1), C.map(v => +v.toFixed(1)), +hyp.score.toFixed(0)]); if (cal.rms > 3 * Math.max(s, 0.8) || C[2] < 0.8 || C[2] > 40 || C[1] > 2 || !Object.keys(lines).some(id => MODEL_LINES[id][0][0] === MODEL_LINES[id][1][0]) || !Object.keys(lines).some(id => MODEL_LINES[id][0][1] === MODEL_LINES[id][1][1])) continue;
    if (n < 5) continue;
    if (!pick || n > pick.n || (n === pick.n && cal.rms < pick.cal.rms)) pick = { raw, lines, cal, n }; }
  return pick;
}
