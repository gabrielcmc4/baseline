// Baseline analysis engine. Pure JavaScript, no DOM: runs in the browser and in Node.
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
let FASTMOD = null; // compiled wasm/fast.wasm, if initFast() was called and the browser has WebAssembly SIMD
export async function initFast(src) { if (FASTMOD) return true; try { const bytes = src instanceof ArrayBuffer || ArrayBuffer.isView(src) ? src : await (await fetch(src)).arrayBuffer(); FASTMOD = await WebAssembly.compile(bytes); return true; } catch (e) { FASTMOD = null; return false; } }
export const fastOn = () => !!FASTMOD;
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
    this.oneStep = !!globalThis.__oneStep; this.cut = new Int32Array(W); this.tape = new Int32Array(W);
    const apron = cam.norm([-14, -3.5, 0])[2] > 0.5 && cam.norm([14, -3.5, 0])[2] > 0.5; // only for a camera well behind the baseline: from a corner that line runs behind the camera and would blank the whole picture
    for (let x = 0; x < W; x++) { // ignore the apron in front of the near baseline (shadows, feet)
      let yb = H; const a = cam.project([-14, -3.5, 0]), b = cam.project([14, -3.5, 0]);
      if (apron && Math.abs(b[0] - a[0]) > 1) yb = a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
      this.cut[x] = Math.max(0, Math.min(H - 2, Math.round(yb - 10 * this.s))); this.tape[x] = Math.round(cam.tapeY(x) + 20 * this.s);
    }
    this.bufs = []; this.mask = new Uint8Array(W * H); this.kind = new Uint8Array(W * H); this.mt = 15; this.n = 0; this.shift = [0, 0]; this.valid = true; this.maxShift = 0; this.busy = 0; this.dropped = 0;
    this.ref = refPts || []; this.refScore = null; this.cw = Math.ceil(W / 4); this.ch = Math.ceil(H / 4); this.coarse = new Uint16Array(this.cw * this.ch);
  }
  // grey picture, lightly blurred (1-2-1 across, then 1-2-1 down: the same result as 3x3 weights in one go, at a third of the work)
  _gray(rgba) { const W = this.W, H = this.H, N = W * H; if (this.fx === undefined) this._fast();
    if (this.fx) { const F = this.fx; F.rgba.set(rgba); F.slot = (F.slot + 1) % F.g.length; F.x.gray_blur(F.pRgba, F.pG[F.slot], F.pT, F.pH, W, H); return F.g[F.slot]; }
    const g = new Uint8Array(N), t = this._gt || (this._gt = new Uint8Array(N)), h = this._gh || (this._gh = new Uint16Array(N));
    if (rgba.byteOffset % 4 === 0 && LITTLE) { const u = new Uint32Array(rgba.buffer, rgba.byteOffset, N); for (let i = 0; i < N; i++) { const v = u[i]; t[i] = ((v & 255) * 77 + ((v >>> 8) & 255) * 150 + ((v >>> 16) & 255) * 29) >> 8; } }
    else for (let i = 0, j = 0; i < N; i++, j += 4) t[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    for (let o = 1; o < N - 1; o++) h[o] = t[o - 1] + 2 * t[o] + t[o + 1];
    for (let y = 1; y < H - 1; y++) { let o = y * W + 1; for (let x = 1; x < W - 1; x++, o++) g[o] = (h[o - W] + 2 * h[o] + h[o + W]) >> 4; }
    return g; }
  // The two heaviest loops (grey picture, "which pixels moved") also exist compiled to WebAssembly with SIMD (wasm/fast.c), two to three times faster and giving the same numbers. Each detector gets its own instance and memory; grey pictures live in a ring inside that memory (one more than the detector keeps).
  _fast() { this.fx = null; if (!FASTMOD) return; try { const x = new WebAssembly.Instance(FASTMOD, {}).exports, W = this.W, H = this.H, N = W * H, RING = 7; let q = (x.__heap_base.value + 63) & ~63; const take = n => { const a = q; q = (q + n + 63) & ~63; return a; };
      if (!this.fy) this._band(); const nb = W * (this.fy - this.fy0), pRgba = take(4 * N), pT = take(N), pH = take(2 * N), pRow = take(W), pIdx = take(4 * N), pR = take(nb), pGb = take(nb), pB = take(nb), pFm = take(nb), pLim = take(4 * W), pFidx = take(4 * nb), pG = []; for (let i = 0; i < RING; i++) pG.push(take(N)); const need = q - x.memory.buffer.byteLength; if (need > 0) x.memory.grow(Math.ceil(need / 65536)); const buf = x.memory.buffer;
      this.fx = { x, pRgba, pT, pH, pRow, pIdx, pG, pR, pGb, pB, pFm, pLim, pFidx, slot: 0, rgba: new Uint8Array(buf, pRgba, 4 * N), idx: new Uint32Array(buf, pIdx, N), fidx: new Uint32Array(buf, pFidx, nb), g: pG.map(a => new Uint8Array(buf, a, N)) };
      this.bgR = new Uint8Array(buf, pR, nb); this.bgG = new Uint8Array(buf, pGb, nb); this.bgB = new Uint8Array(buf, pB, nb); this.fm = new Uint8Array(buf, pFm, nb); const lim = new Int32Array(buf, pLim, W), off = Math.round(26 * this.s); for (let i = 0; i < W; i++) lim[i] = this.tape[i] - off; } catch (e) { this.fx = null; } }
  // where the court lines are in this frame relative to the frame the court was marked in (a camera on a fence sways); mode 0: small step from the last position, 1: wider look around it, 2: anywhere within reach (start, after a cut, after losing it)
  _drift(g, mode) { if (this.ref.length < 20) return; const W = this.W, H = this.H, RM = Math.round(100 * this.s), ref = this.ref;
    const score = (dx, dy) => { let s = 0; for (const p of ref) { const x = (p[0] + dx) | 0, y = (p[1] + dy) | 0; if (x >= 0 && y >= 0 && x < W && y < H) s += g[y * W + x]; } return s; };
    const search = (cx, cy, r, st) => { let best = -1, bx = cx, by = cy; for (let dy = Math.max(-RM, cy - r); dy <= Math.min(RM, cy + r); dy += st) for (let dx = Math.max(-RM, cx - r); dx <= Math.min(RM, cx + r); dx += st) { const s = score(dx, dy); if (s > best) { best = s; bx = dx; by = dy; } } return [bx, by, best]; };
    const [cx0, cy0] = this.shift; let bx, by, best;
    let peak = 0; if (mode === 2) { [bx, by] = search(0, 0, RM, 3); [bx, by, best] = search(bx, by, 3, 1); const d = Math.round(9 * this.s), side = (score(bx + d, by) + score(bx - d, by) + score(bx, by + d) + score(bx, by - d)) / 4; peak = best / (side + 1); }
    else { [bx, by, best] = search(cx0, cy0, mode ? Math.round(8 * this.s) : 2, 1); const sc = score(cx0, cy0); if (best < 1.01 * sc) { bx = cx0; by = cy0; best = sc; } } // do not chase noise: move only for a clear gain
    if (this.refScore === null) { this.refScore = best; this.refScore0 = best; this.lostFor = 0; }
    this.valid = best > 0.8 * this.refScore && Math.abs(bx) < RM && Math.abs(by) < RM; this.shift = [bx, by];
    if (!this.valid && !this.strict && mode === 2 && peak > 1.25 && best > 0.45 * this.refScore0 && Math.abs(bx) < RM && Math.abs(by) < RM && ++this.lostFor > 4) { this.refScore = best; this.valid = true; } // the lines are clearly there, only fainter or brighter than at the start (sun, shade): take this as the new normal
    if (this.valid) { this.lostFor = 0; this.refScore = 0.98 * this.refScore + 0.02 * best; }
    if (Math.abs(bx) > this.maxShift) this.maxShift = Math.abs(bx); if (Math.abs(by) > this.maxShift) this.maxShift = Math.abs(by); }
  // Second look at the far side. Beyond the net a ball is two or three pixels wide and near the top of its path it hardly moves in the picture, so the movement test above loses it half-way. Here the strip between the horizon and the net tape is compared with a slowly updated picture of what is normally there (each pixel creeps one step towards the current picture per frame, which settles on the usual value and ignores things passing by). A small spot that is clearly more yellow-green than that background is kept in `fb`; only the fitter's guided search uses it, to follow a shot it already has down to its bounce.
  _band() { const W = this.W, H = this.H, s = this.s, hz = this.cam.project([0, 1e5, this.cam.C[2]])[1]; let y1 = 0; for (let x = 0; x < W; x++) if (this.tape[x] > y1) y1 = this.tape[x]; this.fy0 = Math.max(2, Math.round(Math.min(hz - 20 * s, this.cam.project([0, COURT.LEN, 3.5])[1]))); this.fy = Math.max(this.fy0 + 4, Math.min(H - 2, y1)); this.bgN = 0; this.gw = (W >> 2) + 1; const gn = this.gw * (((this.fy - this.fy0) >> 2) + 1); this.fFirst = new Float64Array(gn).fill(-9); this.fLast = new Float64Array(gn).fill(-9); }
  _far(c, out) { const W = this.W, H = this.H, s = this.s;
    if (!this.fy) this._band(); if (!this.bgR) { const n = W * (this.fy - this.fy0); this.bgR = new Uint8Array(n); this.bgG = new Uint8Array(n); this.bgB = new Uint8Array(n); this.fm = new Uint8Array(n); }
    if (c.cut) this.bgN = 0; const d = c.rgba, sx = c.shift[0], sy = c.shift[1], y0 = this.fy0, y1 = this.fy, R = this.bgR, G = this.bgG, B = this.bgB, fm = this.fm, init = this.bgN === 0, lim = this.tape, off = Math.round(26 * s), F = this.fx; let hits;
    if (F && F.pR) { const ya = Math.max(1, y0 + sy), yb = Math.min(H - 1, y1 + sy); if (yb > ya) F.rgba.set(d.subarray(ya * W * 4, yb * W * 4), ya * W * 4); hits = F.fidx.subarray(0, F.x.far_look(F.pRgba, F.pR, F.pGb, F.pB, F.pFm, F.pLim, F.pFidx, F.pRow, W, H, y0, y1, sx, sy, init ? 1 : 0)); }
    else { hits = []; for (let yr = y0; yr < y1; yr++) { const y = yr + sy; if (y < 1 || y >= H - 1) continue; let i = (yr - y0) * W, xa = Math.max(1, 1 - sx), xb = Math.min(W - 1, W - 1 - sx); i += xa;
      for (let xr = xa; xr < xb; xr++, i++) { const j = ((y * W) + xr + sx) * 4, r = d[j], g = d[j + 1], b = d[j + 2]; if (init) { R[i] = r; G[i] = g; B[i] = b; continue; }
        const dr = r - R[i], dg = g - G[i], db = b - B[i]; if (dg > 20 && dr > -10 && db < dg - 4 && yr < lim[xr] - off) { fm[i] = 1; hits.push(i); }
        if (dr > 0) R[i]++; else if (dr < 0) R[i]--; if (dg > 0) G[i]++; else if (dg < 0) G[i]--; if (db > 0) B[i]++; else if (db < 0) B[i]--; } } }
    this.bgN++; if (this.bgN < 20 || hits.length > 3000) { for (const i of hits) fm[i] = 0; out.fb = null; return; } // the background needs a moment to settle; a flood of spots is the camera shaking
    const stack = [], amax = 70 * s * s, n = fm.length, gw = this.gw; for (const i0 of hits) { if (fm[i0] !== 1) continue; let a = 0, mx = 0, my = 0; stack.push(i0); fm[i0] = 2; while (stack.length) { const i = stack.pop(); a++; mx += i % W; my += (i / W) | 0; for (const q of [i - 1, i + 1, i - W, i + W, i - W - 1, i - W + 1, i + W - 1, i + W + 1]) if (q >= 0 && q < n && fm[q] === 1) { fm[q] = 2; stack.push(q); } }
      if (a >= 2 && a <= amax) { const ux = mx / a, uy = my / a, ci = (uy >> 2) * gw + (ux >> 2); // something that stays in the same spot for more than half a second is a lamp, a sign or a leaf, not a ball
        if (c.t - this.fLast[ci] > 0.5 || c.t < this.fLast[ci]) this.fFirst[ci] = c.t; this.fLast[ci] = c.t; if (c.t - this.fFirst[ci] <= 0.6) out.fb.push([ux, uy + y0]); } }
    for (const i of hits) fm[i] = 0; if (out.fb.length > 3) { const L = out.fb, R2 = (40 * s) ** 2; out.fb = L.filter(q => { let k = 0; for (const r of L) { const dx = r[0] - q[0], dy = r[1] - q[1]; if (dx * dx + dy * dy < R2 && ++k > 2) return false; } return true; }); } // leaves and people come in clumps, a ball is on its own
    if (out.fb.length > 40) out.fb = []; const P = new Int16Array(out.fb.length * 2); out.fb.forEach((q, i) => { P[2 * i] = Math.round(q[0] * 8); P[2 * i + 1] = Math.round(q[1] * 8); }); out.fb = P; } // packed (x, y in eighths of a pixel): an hour of video is a couple of hundred thousand frames
  // push a frame; returns {t, c:[[x,y,area]], blobs:[[x0,y0,x1,y1]], valid} for the PREVIOUS frame (or null)
  push(rgba, t) {
    const g = this._gray(rgba); let rc = false;
    if (this.bufs.length) { const q = this.bufs[this.bufs.length - 1].g; let d = 0, m = 0, k = 0; for (let i = 0; i < g.length; i += 97) { const e = g[i] - q[i], a = e < 0 ? -e : e; d += a; if (a > 12) k++; m++; }
      // Repeated frame: broadcast "60 fps" is often 50 pictures a second with every sixth shown twice (25 in 30 likewise), and after re-encoding the copy is not bit-identical. A bit-identical copy is skipped here. A near copy changes almost no pixels while the pictures around it change many; but so does a calm moment after a shaky one in a phone video, so a near copy is only marked here (rc) and dropped later if the marks come at a steady rhythm (see dropRepeats).
      const hk = this.hk || (this.hk = []), med = hk.length >= 6 ? hk.slice().sort((a, b) => a - b)[hk.length >> 1] : 0;
      if (d / m < 0.02) { if (this.fx) this.fx.slot = (this.fx.slot + this.fx.g.length - 1) % this.fx.g.length; this.rep = (this.rep || 0) + 1; const L = this.rcT || (this.rcT = []); L.push(t); if (L.length > 4) L.shift(); return null; }
      rc = med >= 8 && k <= 0.08 * med; hk.push(k); if (hk.length > 12) hk.shift();
      if (rc) { const L = this.rcT || (this.rcT = []), n = L.length, P = n >= 2 ? L[n - 1] - L[n - 2] : 0, on = n >= 3 && P > 0.025 && P < 0.25 && Math.abs(L[n - 2] - L[n - 3] - P) < 0.004 && Math.abs(t - L[n - 1] - P) < 0.004; L.push(t); if (L.length > 4) L.shift(); // once near copies have come three times at the same rhythm, skip the next one on that rhythm right here, so the ball finder compares real neighbours
        if (on) { if (this.fx) this.fx.slot = (this.fx.slot + this.fx.g.length - 1) % this.fx.g.length; this.rep = (this.rep || 0) + 1; return null; } } }
    // block averages of the picture: a big share of blocks changing at once means the video was edited here and another clip starts
    const bw = this.W >> 4, bh = this.H >> 4, blk = new Uint8Array(bw * bh); for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { let sum = 0; for (let dy = 2; dy < 16; dy += 4) { const o = (by * 16 + dy) * this.W + bx * 16; sum += g[o + 2] + g[o + 6] + g[o + 10] + g[o + 14]; } blk[by * bw + bx] = sum >> 4; }
    let cut = false; if (this.blk) { let c = 0; for (let i = 0; i < blk.length; i++) { const e = blk[i] - this.blk[i]; if (e > 12 || e < -12) c++; } cut = c / blk.length > 0.45; } this.blk = blk; // a swaying camera changes a good part of the picture too; only a change of scene counts
    this._drift(g, cut || this.n === 0 ? 2 : this.n % 15 === 0 ? 1 : 0); if (!this.valid && !cut) this._drift(g, 2); // lost the court: look further away, but not on every frame
    this.bufs.push({ rgba, g, t, shift: this.shift.slice(), valid: this.valid, cut, rep: this.rep || 0, rc }); this.n++; this.rep = 0;
    // At 50-60 pictures a second a ball flying away from the camera moves only two or three pixels from one picture to the next and overlaps itself, so it would not count as moving: compare with the pictures two steps away instead (decided picture by picture: phone video does not keep a steady rhythm). This also doubles the false candidates (leaves, shadows); `oneStep` is a test switch to compare.
    if (this.bufs.length < 5) return null; const B = this.bufs, c = B[2], p = this.oneStep || c.t - B[1].t >= 0.028 ? B[1] : B[0], nx = this.oneStep || B[3].t - c.t >= 0.028 ? B[3] : B[4], pA = B[1], nA = B[3], W = this.W, H = this.H, mask = this.mask, hits = [], d = c.rgba, coarse = this.coarse, cw = this.cw; coarse.fill(0);
    // compare each pixel with the same court spot in the neighbouring frames, allowing for the camera having moved a little in between
    const op = (p.shift[1] - c.shift[1]) * W + (p.shift[0] - c.shift[0]), on = (nx.shift[1] - c.shift[1]) * W + (nx.shift[0] - c.shift[0]), mg = 2 + Math.round(16 * this.s), MT = this.mt;
    // Above the strip where far balls are looked for (sky, trees, buildings) nothing needs the two-step comparison, and that is where most of its extra false candidates come from: there the direct neighbours are used. ySplit is that row in this frame; 0 when both comparisons are the same.
    if (!this.fy) this._band(); const split = (p !== pA || nx !== nA) && !this.wideStep ? Math.max(0, Math.min(H, this.fy0 + c.shift[1])) : 0, opA = (pA.shift[1] - c.shift[1]) * W + (pA.shift[0] - c.shift[0]), onA = (nA.shift[1] - c.shift[1]) * W + (nA.shift[0] - c.shift[0]);
    let nh = 0, idx; const F = this.fx;
    if (F && c.g.buffer === F.x.memory.buffer && p.g.buffer === c.g.buffer && nx.g.buffer === c.g.buffer && pA.g.buffer === c.g.buffer && nA.g.buffer === c.g.buffer) { if (split) nh = F.x.motion(c.g.byteOffset, pA.g.byteOffset, nA.g.byteOffset, opA, onA, MT, W, H, mg, F.pIdx, F.pRow, 0, split); nh += F.x.motion(c.g.byteOffset, p.g.byteOffset, nx.g.byteOffset, op, on, MT, W, H, mg, F.pIdx + 4 * nh, F.pRow, split, H); idx = F.idx; }
    else { idx = this._idx || (this._idx = new Uint32Array(W * H)); for (let y = mg; y < H - mg; y++) { let o = y * W + mg; const up = y < split, P = up ? pA.g : p.g, Nx = up ? nA.g : nx.g, o1 = up ? opA : op, o2 = up ? onA : on; for (let x = mg; x < W - mg; x++, o++) { const a = c.g[o]; let d1 = a - P[o + o1]; if (d1 < 0) d1 = -d1; if (d1 <= MT) continue; let d2 = a - Nx[o + o2]; if (d2 < 0) d2 = -d2; if (d2 <= MT) continue; idx[nh++] = o; } } }
    const p2 = p, nx2 = nx, op2 = op, on2 = on; { for (let k = 0; k < nh; k++) { const o = idx[k], y = (o / W) | 0, x = o - y * W, a = c.g[o], up = y < split, p = up ? pA : p2, nx = up ? nA : nx2, op = up ? opA : op2, on = up ? onA : on2; let d1 = a - p.g[o + op]; if (d1 < 0) d1 = -d1; let d2 = a - nx.g[o + on]; if (d2 < 0) d2 = -d2;
        coarse[(y >> 2) * cw + (x >> 2)]++;
        if (y > this.cut[x]) continue;
        const j = o * 4, r = d[j], gg = d[j + 1], b = d[j + 2], mx = r > gg ? (r > b ? r : b) : (gg > b ? gg : b), mn = r < gg ? (r < b ? r : b) : (gg < b ? gg : b), df = mx - mn; if (mx < 100 || df === 0) continue;
        let h; if (mx === r) h = 30 * (gg - b) / df; else if (mx === gg) h = 60 + 30 * (b - r) / df; else h = 120 + 30 * (r - gg) / df; if (h < 0) h += 180;
        const sat = 255 * df / mx;
        let ok = (h >= 20 && h <= 50 && sat >= 60) || (y < this.tape[x] && h >= 20 && h <= 80 && sat >= 30 && mx >= 185);
        let rel = false; if (!ok && d1 >= 30 && d2 >= 30) { const pd = p.rgba, nd = nx.rgba, jp = j + 4 * op, jn = j + 4 * on, yc = (r + gg) / 2 - b, yp = (pd[jp] + pd[jp + 1]) / 2 - pd[jp + 2], yn = (nd[jn] + nd[jn + 1]) / 2 - nd[jn + 2]; // more yellow-green than what was there before and after
          rel = yc - (yp > yn ? yp : yn) >= 22 && gg - (pd[jp + 1] > nd[jn + 1] ? pd[jp + 1] : nd[jn + 1]) >= 8 && gg >= r - 25 && b <= (pd[jp + 2] < nd[jn + 2] ? pd[jp + 2] : nd[jn + 2]) + 14; } // a yellow ball adds red and green but no blue; a patch of sun or a white line coming into view adds all three
        if (!ok && !rel) continue;
        // a camera that moved a fraction of a pixel makes every sharp edge (leaves, court lines) look like movement: a real ball is still different when the neighbouring frames are allowed to slip by one pixel (only for a camera that has been seen to move: on a fixed one this would cost real, faint balls)
        if (this.maxShift >= 4) { const pg = p.g, ng = nx.g, o1 = o + op, o2 = o + on; let m1 = 255, m2 = 255; for (let dy = -W; dy <= W; dy += W) for (let dx = -1; dx <= 1; dx++) { let v = a - pg[o1 + dy + dx]; if (v < 0) v = -v; if (v < m1) m1 = v; v = a - ng[o2 + dy + dx]; if (v < 0) v = -v; if (v < m2) m2 = v; } if (m1 <= MT || m2 <= MT) continue; }
        if (ok) { hits.push(o); this.kind[o] = 1; } else hits.push(o); } }
    const out = { t: c.t, c: [], c2: [], fb: [], blobs: [], valid: c.valid, cut: c.cut }; if (c.rep) out.rep = c.rep; if (c.shift[0] || c.shift[1]) out.sh = c.shift; /* how far the picture had slipped from the calibration picture (the spots below are already given without it) */ if (c.rc) out.rc = 1; if (c.valid) this._far(c, out); else out.fb = null; // c: blobs with clear ball colour; c2: also small blobs that only pass the weaker test
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
function smoothRms(q) { if (q.length > 20) { let s = 0, k = 0; for (let a = 0; a < q.length; a += 10) { const b = Math.min(q.length, a + 20), a2 = Math.max(0, b - 20); s += smoothRms(q.slice(a2, b)) ** 2; k++; if (b === q.length) break; } return Math.sqrt(s / k); } // a long track (a second or more, from near the camera to far away) is not one parabola in the picture, but every part of it is smooth
  const f = q.map(p => p[0] - q[0][0]), dg = q.length >= 5 ? 2 : 1; let s = 0; for (const c of [1, 2]) { const co = polyfit(f, q.map(p => p[c]), dg); q.forEach((p, i) => s += (p[c] - polyval(co, f[i])) ** 2); } return Math.sqrt(s / (2 * q.length)); }

// ---------- flight physics ----------
function acc(v, cl, cs = 0) { const sp = Math.hypot(v[0], v[1], v[2]); const a = [-KD * sp * v[0], -KD * sp * v[1], -G - KD * sp * v[2]];
  if (cl !== 0 && sp > 1e-6) { const ez = v[2] / sp, p = [ez * v[0] / sp, ez * v[1] / sp, -1 + ez * ez], n = Math.hypot(...p); if (n > 1e-9) { const k = KM * cl * sp * sp / n; a[0] += k * p[0]; a[1] += k * p[1]; a[2] += k * p[2]; } }
  if (cs) { const hv = Math.hypot(v[0], v[1]); if (hv > 1e-6) { const k = KM * cs * sp * sp / hv; a[0] -= k * v[1]; a[1] += k * v[0]; } } return a; } // cs: sidespin (slice serves curve sideways), lift across the flight, positive to the left of the direction of play
function rk4(p, v, cl, h, cs = 0) { const a1 = acc(v, cl, cs), v2 = v.map((q, i) => q + 0.5 * h * a1[i]), a2 = acc(v2, cl, cs), v3 = v.map((q, i) => q + 0.5 * h * a2[i]), a3 = acc(v3, cl, cs), v4 = v.map((q, i) => q + h * a3[i]), a4 = acc(v4, cl, cs);
  for (let i = 0; i < 3; i++) { p[i] += h / 6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]); v[i] += h / 6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]); } }
// The same flight step as rk4 above, written out on plain numbers: this runs millions of times inside the fit, and building small arrays for every step was most of the fitting time. Same arithmetic in the same order (lengths by a plain square root, which differs from Math.hypot only in the last digit).
export function simulateAt(x, times) { let p0 = x[0], p1 = x[1], p2 = x[2], v0 = x[3], v1 = x[4], v2 = x[5]; const cl = x[6] || 0, cs = x[7] || 0, out = []; let t = 0, a0 = 0, a1 = 0, a2 = 0;
  const A = (w0, w1, w2) => { const sp = Math.sqrt(w0 * w0 + w1 * w1 + w2 * w2); a0 = -KD * sp * w0; a1 = -KD * sp * w1; a2 = -G - KD * sp * w2;
    if (cl !== 0 && sp > 1e-6) { const ez = w2 / sp, q0 = ez * w0 / sp, q1 = ez * w1 / sp, q2 = -1 + ez * ez, n = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2); if (n > 1e-9) { const k = KM * cl * sp * sp / n; a0 += k * q0; a1 += k * q1; a2 += k * q2; } }
    if (cs) { const hv = Math.sqrt(w0 * w0 + w1 * w1); if (hv > 1e-6) { const k = KM * cs * sp * sp / hv; a0 -= k * w1; a1 += k * w0; } } };
  for (const tq of times) { let rem = tq - t; const n = Math.max(1, Math.ceil(rem * 50 - 1e-9)); /* steps of at most 20 ms: for a ball in flight a fourth-order step that long is exact to a fraction of a millimetre */ for (let k = 0; k < n && rem > 1e-9; k++) { const h = rem / (n - k) > 0 ? (tq - t) / (n - k) : 0;
      A(v0, v1, v2); const b0 = a0, b1 = a1, b2 = a2, x0 = v0 + 0.5 * h * b0, x1 = v1 + 0.5 * h * b1, x2 = v2 + 0.5 * h * b2; A(x0, x1, x2); const c0 = a0, c1 = a1, c2 = a2, y0 = v0 + 0.5 * h * c0, y1 = v1 + 0.5 * h * c1, y2 = v2 + 0.5 * h * c2; A(y0, y1, y2); const d0 = a0, d1 = a1, d2 = a2, z0 = v0 + h * d0, z1 = v1 + h * d1, z2 = v2 + h * d2; A(z0, z1, z2);
      p0 += h / 6 * (v0 + 2 * x0 + 2 * y0 + z0); p1 += h / 6 * (v1 + 2 * x1 + 2 * y1 + z1); p2 += h / 6 * (v2 + 2 * x2 + 2 * y2 + z2); v0 += h / 6 * (b0 + 2 * c0 + 2 * d0 + a0); v1 += h / 6 * (b1 + 2 * c1 + 2 * d1 + a1); v2 += h / 6 * (b2 + 2 * c2 + 2 * d2 + a2); t += (tq - t) / (n - k); } t = tq; out.push([p0, p1, p2]); } return out; }
// The flight run backwards in time (same model as simulateAt) until the ball is at depth yT; returns [position, velocity, time (negative)] there, or null.
export function backTo(x, yT, tMax = 1.5) { let p = [x[0], x[1], x[2]], v = [x[3], x[4], x[5]]; const cl = x[6] || 0, h = -0.01;
  const acc = w => { const sp = Math.hypot(w[0], w[1], w[2]); const a = [-KD * sp * w[0], -KD * sp * w[1], -G - KD * sp * w[2]]; if (cl !== 0 && sp > 1e-6) { const ez = w[2] / sp, q = [ez * w[0] / sp, ez * w[1] / sp, -1 + ez * ez], n = Math.hypot(q[0], q[1], q[2]); if (n > 1e-9) { const k = KM * cl * sp * sp / n; a[0] += k * q[0]; a[1] += k * q[1]; a[2] += k * q[2]; } } return a; };
  const dir = Math.sign(yT - x[1]); if (!dir || Math.sign(-x[4]) !== dir) return null; // going back must bring the ball towards yT
  for (let t = 0; t > -tMax; t += h) { const k1 = acc(v), v2 = v.map((z, i) => z + h / 2 * k1[i]), k2 = acc(v2), v3 = v.map((z, i) => z + h / 2 * k2[i]), k3 = acc(v3), v4 = v.map((z, i) => z + h * k3[i]), k4 = acc(v4);
    const pn = p.map((z, i) => z + h / 6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i])), vn = v.map((z, i) => z + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    if ((pn[1] - yT) * dir >= 0) { const f = (yT - p[1]) / (pn[1] - p[1]); return [p.map((z, i) => z + f * (pn[i] - z)), v.map((z, i) => z + f * (vn[i] - z)), t + f * h]; } p = pn; v = vn; }
  return null; }
export function flightSummary(x, tMax = 4) { const p = x.slice(0, 3), v = x.slice(3, 6), cl = x[6] || 0, cs = x[7] || 0, h = 1 / 240, path = [p.slice()]; let t = 0, land = null, tLand = null, net = null;
  while (t < tMax) { const q = p.slice(); rk4(p, v, cl, h, cs); t += h;
    if (!net && (q[1] - COURT.NET) * (p[1] - COURT.NET) <= 0 && q[1] !== p[1]) { const f = (COURT.NET - q[1]) / (p[1] - q[1]); net = q.map((a, i) => a + f * (p[i] - a)); }
    if (p[2] <= RB && v[2] < 0) { const f = (q[2] - RB) / (q[2] - p[2] + 1e-12); land = q.map((a, i) => a + f * (p[i] - a)); tLand = t - h + f * h; path.push(land); break; }
    if (Math.round(t / h) % 4 === 0) path.push(p.slice()); }
  return { land, tLand, net, clear: net ? net[2] - RB - netHeight(net[0]) : null, path }; }
export function spinFromCl(cl, speed) { const a = Math.min(Math.abs(cl), 0.45); if (a < 1e-4) return 0; return Math.sign(cl) * speed / (RB * (1 / a - 2)) * 60 / (2 * Math.PI); }

function fitFlight(cam, t, uv, prior, s, freeSpin, warm) {
  const n = t.length, d0 = cam.ray(uv[0][0], uv[0][1]), side = !!(prior.side && freeSpin); let best = null; if (side && warm && warm.length < 8) warm = [...warm.slice(0, 7), 0];
  const res = x => { const X = simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], t), out = [];
    const ps = s * (prior.pxSd || 1); for (let i = 0; i < n; i++) { const q = cam.project(X[i]); out.push((q[0] - uv[i][0]) / ps, (q[1] - uv[i][1]) / ps); }
    const w = Math.sqrt(n / 10);
    if (prior.contact) { // The track starts some way after the hit (seen from the side the serve is already metres into the court). The toss shows where the hit was in the picture: run the flight backwards (gravity only), find where it passes closest to that spot, and ask for a serve's height and place there instead of at the first tracked point.
      let bd = 1e9, bp = null; for (let tau = 0; tau >= -0.7; tau -= 0.02) { const P = [x[0] + x[3] * tau, x[1] + x[4] * tau, x[2] + x[5] * tau - 0.5 * G * tau * tau], q = cam.project(P), d = Math.hypot(q[0] - prior.contact[0], q[1] - prior.contact[1]); if (d < bd) { bd = d; bp = P; } }
      out.push(bd / (8 * s) * w, (bp[1] - prior.y) / 0.7 * w, (bp[2] - prior.z) / prior.zSd * w); }
    else { if (prior.y != null) out.push((x[1] - prior.y) / prior.ySd * w); out.push((x[2] - prior.z) / prior.zSd * w); if (prior.xh != null) out.push((x[0] - prior.xh) / prior.xSd * w); } if (prior.farHit) { const B = backTo(freeSpin ? x : [...x.slice(0, 6), 0], prior.farHit.y); out.push(B ? (B[0][2] - prior.farHit.z) / prior.farHit.zSd * w : 5 * w); } // the opponent's hit: about waist high, a little behind the far baseline
    if (freeSpin) out.push(x[6] / prior.clSd); if (side) out.push(x[7] / 0.12); if (prior.anchorNet) out.push((X[n - 1][1] - COURT.NET) / 0.1 * w); if (prior.ground) out.push((X[n - 1][0] - prior.ground[0]) / 0.3 * w, (X[n - 1][1] - prior.ground[1]) / 0.3 * w, (X[n - 1][2] - RB) / 0.08 * w);
    if (prior.groundAt) { const P = simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], [prior.groundAt.t])[0], g = prior.groundAt.g; out.push((P[0] - g[0]) / 0.3 * w, (P[1] - g[1]) / 0.4 * w, (P[2] - RB) / 0.08 * w); } // the bounce was seen a moment after the track was lost: the ball is on the ground there, then
    if (prior.groundT != null) out.push((simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], [prior.groundT])[0][2] - RB) / (prior.groundSd || 0.1) * w); // the moment of the bounce was seen (the path turned back up) but not well enough where: the ball is on the ground then
    if (prior.contactPx) { const q = cam.project(x.slice(0, 3)); out.push((q[0] - prior.contactPx[0]) / (3 * s) * w, (q[1] - prior.contactPx[1]) / (3 * s) * w); } // the hit was seen: where the incoming ball met the racket, at time 0
    if (prior.bounce) { const P = simulateAt(freeSpin ? x : [...x.slice(0, 6), 0], [prior.bounce.t])[0], q = cam.project(P); out.push((q[0] - prior.bounce.uv[0]) / (2.5 * s) * w, (q[1] - prior.bounce.uv[1]) / (2.5 * s) * w, (P[2] - RB) / 0.03 * w); } // the bounce was seen: the ball is on the court there, then
    if (prior.floor) for (let i = 0; i < n; i++) out.push(Math.min(0, X[i][2] - RB + 0.03) / 0.02); // never below the court while it is still being watched in the air (shots hit from the near side: a fit that lands before the track ends is wrong)
    if (prior.rad) { // how fast the ball shrinks in the picture tells how fast it is going away (the measured blob is the ball plus a constant halo, which is left free)
      const pr = []; let m = 0; for (let i = 0; i < n; i++) { const dx = X[i][0] - cam.C[0], dy = X[i][1] - cam.C[1], dz = X[i][2] - cam.C[2], v = prior.rad[i] - cam.f * RB / Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz)); pr.push(v); m += v; } m /= n; for (let i = 0; i < n; i++) out.push((pr[i] - m) / (0.7 * s)); }
    return out; };
  const inc = prior.dir === -1, lb = inc ? [-12, COURT.NET - 3, 0.1, -30, -70, -15, -0.45] : [-12, -9, 0.1, -30, prior.serve ? 16 : 3, -15, -0.45], ub = inc ? [12, COURT.LEN + 8, 5, 30, -3, 30, 0.45] : [12, 11, 3.6, 30, 70, 30, 0.45]; if (side) { lb.push(-0.3); ub.push(0.3); }
  if (inc && !warm) { const e = uv[n - 1], gp = cam.ground(e[0], e[1]); // a ball coming toward the camera: start it somewhere on the far side, aim it at where it was last seen
    for (const y0 of [COURT.LEN - 1, COURT.LEN - 6, COURT.NET + 3]) { const sc = (y0 - cam.C[1]) / d0[1]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d0[i]); if (p0[2] < 0.1 || p0[2] > 5) continue;
      for (const T of [0.8, 1.4]) { const x0 = [...p0, (gp[0] - p0[0]) / T, Math.min(-3.5, (gp[1] - p0[1]) / T), (-p0[2] + 0.5 * G * T * T) / T, 0]; const r = lm(res, freeSpin ? (side ? [...x0, 0] : x0) : x0.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 }); if (!best || r.cost < best.cost) best = r; } } }
  else
  if (warm) best = lm(res, freeSpin ? warm : warm.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 });
  else if (prior.serve) { for (const y0 of prior.contact ? [0.5, 2.5, 5] : [-0.4, 0.5]) { const sc = (y0 - cam.C[1]) / d0[1]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d0[i]); if (p0[2] < (prior.contact ? 0.8 : 1.5) || p0[2] > 3.6) continue; // a serve: the ball starts above the server's head near the baseline
      for (const T of [0.45, 0.75]) { const x0 = [...p0, (0 - p0[0]) / T, (17.5 - p0[1]) / T, (-p0[2] + 0.5 * G * T * T) / T, 0]; const r = lm(res, freeSpin ? (side ? [...x0, 0] : x0) : x0.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 }); if (!best || r.cost < best.cost) best = r; } } }
  else for (const z0 of [0.6, 1.2, 2.2]) { const sc = (z0 - cam.C[2]) / d0[2]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d0[i]);
    for (const T of [0.7, 1.2]) { const v0 = [(0 - p0[0]) / T, (17 - p0[1]) / T, (-z0 + 0.5 * G * T * T) / T];
      const x0 = [...p0, ...v0, 0]; const r = lm(res, freeSpin ? (side ? [...x0, 0] : x0) : x0.slice(0, 6), { lb: freeSpin ? lb : lb.slice(0, 6), ub: freeSpin ? ub : ub.slice(0, 6), nRobust: 2 * n, fScale: 2, maxIter: 40 });
      if (!best || r.cost < best.cost) best = r; } }
  if (!best) return null; const x = freeSpin ? best.x : [...best.x, 0]; const X = simulateAt(x, t), err = X.map((P, i) => { const q = cam.project(P); return Math.hypot(q[0] - uv[i][0], q[1] - uv[i][1]) / s; });
  return { x, err, rms: Math.sqrt(err.reduce((a, b) => a + b * b, 0) / n), res, cost: res(freeSpin ? x : x.slice(0, 6)).reduce((a, v, i) => a + (i < 2 * n ? 8 * (Math.sqrt(1 + v * v / 4) - 1) : v * v), 0) }; // the same robust cost the solver minimised
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
// A video put together from several views (a highlights reel, a zoom between clips, the phone moved to another spot): each stretch has its own camera, found by the Scanner below, and is fitted on its own.
// Capture times. Where repeated pictures were dropped while reading, the pictures left still carry the time they were shown at, up to 13 ms away from the time they were taken (the ball near the camera moves 10-20 px in that time). The camera took them at an even rhythm: within each stretch of steady reading give them evenly spaced times again, at the rate the camera really ran.
// Near copies marked while reading are dropped only when they come at a steady rhythm (every 6th picture for 50 in 60 or 25 in 30, every 5th for 24 in 30, every 2nd for 30 in 60): that is a frame-rate conversion. Marks that come in bunches are calm moments in a shaky phone video, and those pictures are real.
export function dropRepeats(fr) { const sl = [], ev = []; let k = 0; fr.forEach((f, i) => { for (let j = (f.rep || 0); j >= 1; j--) ev.push(k + (f.rep || 0) - j); k += f.rep || 0; sl.push(k); if (f.rc) ev.push(k); k++; }); // positions counted in pictures as shown, copies already skipped while reading included
  if (ev.length < Math.max(5, 0.05 * k)) return fr; const gh = new Map(); for (let j = 1; j < ev.length; j++) { const d = ev[j] - ev[j - 1]; gh.set(d, (gh.get(d) || 0) + 1); } let P = 0, c = 0; for (const [d, n] of gh) if (n > c) { c = n; P = d; } if (P < 2 || P > 7 || c < 0.6 * (ev.length - 1)) return fr;
  const out = []; let carry = 0, last = -1e9; for (let i = 0; i < fr.length; i++) { const f = fr[i]; if (f.rep) last = sl[i] - 1; if (f.rc && sl[i] - last >= P - 1 && i > 0) { carry += 1 + (f.rep || 0); last = sl[i]; continue; } if (carry) { out.push({ ...f, rep: (f.rep || 0) + carry }); carry = 0; } else out.push(f); } return out; }
export function retime(fr) { fr = dropRepeats(fr); let nr = 0; for (const f of fr) if (f.rep) nr++; if (fr.length < 20 || nr < 0.05 * fr.length) return fr;
  const g = []; for (let i = 1; i < fr.length; i++) { const d = (fr[i].t - fr[i - 1].t) / (1 + (fr[i].rep || 0)); if (d > 0) g.push(d); } g.sort((a, b) => a - b); const dn = g[g.length >> 1]; // the interval the pictures were shown at
  const runs = []; let a = 0; for (let i = 1; i <= fr.length; i++) { const f = fr[i]; if (i < fr.length && !f.cut && (f.seg || 0) === (fr[i - 1].seg || 0) && Math.abs(f.t - fr[i - 1].t - (1 + (f.rep || 0)) * dn) < 0.3 * dn) continue; if (i - a >= 8) runs.push([a, i]); a = i; }
  let S = 0, U = 0; for (const [a, b] of runs) for (let i = a + 1; i < b; i++) { S += 1 + (fr[i].rep || 0); U++; } if (!U) return fr;
  let fps = 1 / (dn * S / U); for (const r of [24, 25, 30, 48, 50, 60, 100, 120]) if (Math.abs(fps / r - 1) < 0.02) fps = r; const dc = 1 / fps; // 50.0 rather than 49.97
  const out = fr.map(f => ({ ...f })); for (const [a, b] of runs) { let m = 0; for (let i = a; i < b; i++) m += fr[i].t - (i - a) * dc; m /= b - a; for (let i = a; i < b; i++) out[i].t = m + (i - a) * dc; }
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 1e-4; out.capFps = fps; return out; }
export function analyze(frames0, cam, opts = {}) { frames0 = retime(frames0); if (opts.cams && frames0.some(f => f.seg)) { const groups = new Map(); for (const f of frames0) { const k = f.seg || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    const all = []; let meta = null, done = 0; for (const [sg, fr] of groups) { done += fr.length; if (fr.length < 20 || !opts.cams[sg]) continue; const r = analyzeOne(fr, new Camera(opts.cams[sg], cam.W, cam.H), { ...opts, cams: null, onProgress: null }); for (const q of r) { q.seg = sg; all.push(q); } if (!meta || r.length > meta.n) meta = { ...r.meta, n: r.length }; if (opts.onProgress) opts.onProgress(done / frames0.length); }
    all.sort((a, b) => a.t - b.t); all.meta = { ...(meta || { rej: {} }), views: groups.size }; return all; }
  return analyzeOne(frames0, cam, opts); }
function analyzeOne(frames0, cam, opts = {}) { const qz = quiet(frames0), frames = qz.frames, out = analyze2(frames, cam, opts); if (opts.passOnly) return out; out.meta.noisy = [qz.cells, qz.removed];
  for (const q of out) { const tq = q.t + (q.tLand || 0); let lo = 0, hi = frames.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t < tq) lo = mid + 1; else hi = mid; } const f = frames[lo]; if (f && f.sh) q.sh = [f.sh[0], f.sh[1]]; } /* where the picture was, against the calibration picture, when the ball came down: for anything that goes back to the video itself */
  return out; }
// The two colour passes are independent: the worker can run pass b in a second worker at the same time (opts.passOnly 'a' / 'b' each return one pass; opts.passA / passB hand finished passes back for the merge). Coach lesson, 51 min: fit 440 s one after the other.
export function wantsTwoPasses(frames) { return frames.some(f => f.c2 && f.c2.length > f.c.length); }
function analyze2(frames, cam, opts = {}) { const p = opts.onProgress, two = !opts.only && wantsTwoPasses(frames);
  if (opts.passOnly === 'b') return two ? analyzeCore(frames.map(f => ({ ...f, c: f.c2 || f.c })), cam, { ...opts, onProgress: null }) : null;
  const a = opts.passA || analyzeCore(frames, cam, { ...opts, onProgress: p && (opts.passOnly === 'a' ? p : v => p(v / 2)) }); if (opts.passOnly === 'a') return a;
  if (!two) { a.meta.colour = 'strict'; return a; }
  const b = opts.passB || analyzeCore(frames.map(f => ({ ...f, c: f.c2 || f.c })), cam, { ...opts, onProgress: p && (v => p(0.5 + v / 2)) });
  // near player's shots: whichever colour test gives clearly more; far-side shots (small, far ball): likewise, chosen separately
  const near = q => !q.far, far = q => q.far, na = a.filter(near).length, nb = b.filter(near).length, fa = a.length - na, fb = b.length - nb;
  const useB = nb > na * 1.15 + 1, farB = fb > fa, out = (useB ? b : a).filter(near).concat((farB ? b : a).filter(far));
  // A shot whose hit and bounce were both seen is a real shot whichever colour test found it: add those the chosen pass missed, and let them replace a version of the same shot fitted without the hit.
  for (const q of (useB ? a : b).filter(near)) { if (!q.hit || !q.bounce) continue; const j = out.findIndex(r => !r.far && Math.abs(r.t - q.t) < 0.5); if (j < 0) out.push(q); else if (!out[j].hit) out[j] = q; }
  out.sort((u, v) => u.t - v.t);
  out.meta = { ...(useB ? b : a).meta, colour: useB ? 'weak' : 'strict', other: useB ? na : nb, farColour: farB ? 'weak' : 'strict', incoming: (farB ? b : a).meta.incoming }; out.meta.rej = { ...out.meta.rej }; capHeard(out, out.meta); return out; }
// Serves timed by the click but never seen bouncing read on average 15-20 % faster than the serves of the same session whose bounce was seen (serve practice video: median 1.19 over 11 pairs, whatever the assumed contact point or sound delay; not yet understood). Until it is, one faster than every seen-bounce serve of the session (by 10 %) is not shown. Applied again after the two colour passes are merged, since the seen-bounce serves may come from the other pass.
function capHeard(shots, meta) { const sb = shots.filter(q => !q.far && q.serve && q.bounce).map(q => q.speed); if (sb.length < 5) return; const cap = 1.1 * Math.max(...sb); for (let i = shots.length - 1; i >= 0; i--) { const q = shots[i]; if (!q.far && q.serve && q.heard && !q.bounce && q.speed > cap) { shots.splice(i, 1); meta.rej.capped = (meta.rej.capped || 0) + 1; } } }
function analyzeCore(frames, cam, { mode = 'coach', onProgress, yOff = 1.25, ySd = 1.0, clSd = 0.2, zSd = 0.7, only = null, noFar = false, dbgT = null, clicks = null } = {}) {
  const s = Math.sqrt(cam.W * cam.H / (720 * 1280)), H = cam.H, ts = frames.map(f => f.t);
  const dts = []; for (let i = 1; i < ts.length; i += Math.max(1, ts.length >> 12)) if (ts[i] > ts[i - 1]) dts.push(ts[i] - ts[i - 1]); dts.sort((a, b) => a - b); // the usual gap between frames (not the average: stretches of dead time are read only every 4th frame)
  const fps = dts.length ? 1 / dts[dts.length >> 1] : 30, fs = 30 / fps; // pixel-per-frame thresholds were tuned at 30 fps
  const T0 = Date.now(), ms = {}; const tracks = buildTracks(frames, s * Math.max(1, fs)); let segs = []; ms.tracks = Date.now() - T0;
  for (const tr of tracks) for (let q of splitKinks(tr, 6 * s * fs)) { if (q.length >= 6 && smoothRms(q) >= 2.5 * s) for (const c of [q.slice(1), q.slice(0, -1), q.slice(1, -1), q.slice(2), q.slice(0, -2)]) if (c.length >= 5 && smoothRms(c) < 2.5 * s) { q = c; break; } // a spot or two at either end may not be in free flight yet (the ball still in the tossing hand, or on the racket)
    if (q.length >= 5 && smoothRms(q) < 2.5 * s) segs.push(q); }
  segs.sort((a, b) => a[0][0] - b[0][0]);
  const used = new Set(), cands = [];
  for (let a = 0; a < segs.length; a++) { if (used.has(a)) continue; const q = segs[a], x0 = q[0][1], y0 = q[0][2];
    if (y0 < cam.tapeY(x0) + 25 * s) continue; if (q[q.length - 1][2] > y0 - 30 * s) continue;
    const chain = [q]; used.add(a);
    for (let b = a + 1; b < segs.length; b++) { if (used.has(b)) continue; const r = segs[b], last = chain[chain.length - 1], gap = r[0][0] - last[last.length - 1][0]; if (gap > 6 / fs) break; if (gap < -1) continue;
      const k = Math.min(last.length, 6), sg = last.slice(-k), f = sg.map(p => p[0] - r[0][0]); const px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0);
      if (Math.hypot(px - r[0][1], py - r[0][2]) < (15 + 3 * gap) * s && smoothRms([...last.slice(-5), ...r.slice(0, 5)]) < 3 * s) { chain.push(r); used.add(b); } } // and the join itself must be smooth: a racket or arm moving up next to the hit is not the start of the flight
    const seen = new Set(), pts = []; for (const sg of chain) for (const p of sg) if (!seen.has(p[0])) { seen.add(p[0]); pts.push(p); }
    pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) continue;
    const k = Math.min(5, pts.length), vy = polyfit(pts.slice(0, k).map(p => ts[p[0]]), pts.slice(0, k).map(p => p[2]), 1)[1];
    if (vy > -0.2 * H) continue; cands.push(pts); }
  // per candidate: observations and where the hitter stands (lowest edge of the moving blob next to the first ball position)
  const obs = cands.map(pts => { const t0 = ts[pts[0][0]], t = pts.map(p => ts[p[0]] - t0), uv = pts.map(p => [p[1], p[2]]); let feet = null; const i0 = pts[0][0];
    for (let i = Math.max(0, i0 - 8); i <= Math.min(frames.length - 1, i0 + 2); i++) for (const b of frames[i].blobs) { const w = b[2] - b[0], h = b[3] - b[1]; if (h < 0.08 * H || h > 0.7 * H) continue;
      if (uv[0][0] < b[0] - 1.2 * w || uv[0][0] > b[2] + 1.2 * w || uv[0][1] < b[1] - 0.5 * h || uv[0][1] > b[3]) continue; if (!feet || b[3] > feet[1]) feet = [(b[0] + b[2]) / 2, b[3]]; }
    const e = uv[uv.length - 1], d = cam.ray(e[0], e[1]), kk = (COURT.NET - cam.C[1]) / d[1], zNet = cam.C[2] + kk * d[2];
    return { t0, t, uv, fg: feet ? cam.ground(feet[0], feet[1]) : null, zNet, i1: pts[pts.length - 1][0] }; });
  let ySdU = ySd; const fitOne = (o, off) => { const prior = { z: 1.3, zSd, y: o.fg ? o.fg[1] + off : null, ySd: ySdU, clSd, floor: true }; let t = o.t, uv = o.uv, n = t.length, fit = fitFlight(cam, t, uv, prior, s, true);
    while (fit && n > 8 && fit.rms < 9) { const e = fit.err.slice(-3).reduce((a, b) => a + b, 0) / 3; if (e <= 3.5) break; n -= Math.max(2, Math.round(0.12 * n)); t = t.slice(0, n); uv = uv.slice(0, n); fit = fitFlight(cam, t, uv, prior, s, true); } // a track that fits nowhere near a flight is not worth trimming point by point (this loop used to be most of the waiting after the video was read)
    return fit ? { fit, t, uv, n, prior } : null; };
  // Depth self-calibration. A ball that dies in the net was exactly at the net when it was last seen, which tells how far in front of the
  // hitter's feet the tracked flight really starts. Without enough net balls the default offset is used.
  const meta = { yOff, netRefs: 0, candidates: cands.length, fps, segments: segs.length, chk: 1, rej: { nofit: 0, rms: 0, speed: 0, noland: 0, depth: 0 } }; // chk: hit and bounce were looked for (shots carry hit/bounce)
  // The break itself: a ball that hits the net stops flying its curve, and the last point or two of the track drop away from where the smooth path was heading.
  const endBreak = o => { const m = o.t.length; if (m < 9) return false; for (const cut of [1, 2]) { const a = m - cut - 7, b = m - cut, tt = o.t.slice(a, b), t0 = tt[0], tq = tt.map(v => v - t0), cu = polyfit(tq, o.uv.slice(a, b).map(p => p[0]), 2), cv = polyfit(tq, o.uv.slice(a, b).map(p => p[1]), 2); let ok = true, fitE = 0; for (let i = a; i < b; i++) fitE = Math.max(fitE, Math.hypot(polyval(cu, o.t[i] - t0) - o.uv[i][0], polyval(cv, o.t[i] - t0) - o.uv[i][1]));
      for (let i = b; i < m; i++) { const dv = o.uv[i][1] - polyval(cv, o.t[i] - t0), du = o.uv[i][0] - polyval(cu, o.t[i] - t0); if (!(dv > Math.max(4 * s, 3 * fitE) && Math.hypot(du, dv) > 5 * s)) ok = false; } if (ok) return true; } return false; };
  // What the ball did right after the last point of a track. A ball stopped by the net breaks its path: it drops nearly straight down ('fall'). A ball that got over carries on along its path, or comes back within a second because somebody hit it ('pass'). Often neither is seen.
  const afterEnd = o => { const m = o.t.length, e = o.uv[m - 1], tE = ts[o.i1], k = Math.min(5, m - 1), ux = e[0] - o.uv[m - 1 - k][0], uy = e[1] - o.uv[m - 1 - k][1], un = Math.hypot(ux, uy) || 1, vIn = un / Math.max(0.01, o.t[m - 1] - o.t[m - 1 - k]);
    for (const r of segs) { const a = r[0], b = r[r.length - 1], dt = ts[a[0]] - tE; if (dt < 0.005 || r.length < 4) continue; if (dt > 1) { if (dt > 2) break; continue; } const du = b[1] - a[1], dv = b[2] - a[2], dur = Math.max(0.01, ts[b[0]] - ts[a[0]]), sp = Math.hypot(du, dv) / dur;
      if (r.length >= 6 && dt > 0.03 && a[2] < cam.tapeY(a[1]) + 10 * s && dv >= 40 * s && Math.abs(a[1] - e[0]) < 250 * s) return 'pass'; // a ball coming back from the far side
      if (dt <= 0.25 && Math.hypot(a[1] - e[0], a[2] - e[1]) <= (25 + 0.6 * vIn * dt / s) * s && sp >= 0.5 * vIn && (du * ux + dv * uy) / (un * Math.hypot(du, dv) || 1) > 0.8) return 'pass'; }
    const col = []; for (let i = o.i1 + 1; i < frames.length && ts[i] - tE <= 0.5; i++) { const f = frames[i]; let best = null; for (const L of [f.c, f.c2]) if (L) for (const q of L) if (Math.abs(q[0] - e[0]) <= 12 * s && q[1] > e[1] + 1 && q[1] < e[1] + 60 * s && (!best || q[1] < best)) best = q[1]; if (best != null) col.push(best); }
    if (col.length >= 3) { let upN = 0; for (let i = 1; i < col.length; i++) if (col[i] >= col[i - 1] - 1) upN++; if (col[col.length - 1] - col[0] >= 5 * s && upN >= 0.7 * (col.length - 1)) return 'fall'; }
    return null; };
  if (!only) { const refs = obs.filter(o => o.fg && o.t.length >= 8 && o.zNet > 0.05 && o.zNet < 1.12 && afterEnd(o) !== 'pass').slice(0, 40); // balls that came back did not die in the net and must not set the depth scale
    const endY = off => { const ys = []; for (const o of refs) { const r = fitOne(o, off); if (!r || r.n < o.t.length || r.fit.rms > 3) continue; const y = simulateAt(r.fit.x, [r.t[r.n - 1]])[0][1]; if (Math.abs(y - COURT.NET) < 3.5) ys.push(y); } ys.sort((a, b) => a - b); return ys.length >= 4 ? [ys[ys.length >> 1], ys.length] : null; };
    if (refs.length >= 4) { const a = endY(yOff); if (a) { const b = endY(yOff + 0.8); let off = yOff; if (b && Math.abs(b[0] - a[0]) > 0.05) off = yOff + 0.8 * (COURT.NET - 0.1 - a[0]) / (b[0] - a[0]); meta.yOff = Math.max(0.6, Math.min(2.2, off)); meta.yOffNet = off; meta.netRefs = a[1]; } } }
  const shots = [];
  // a toss: a slow, nearly vertical track ending where and when the serve starts (often only its last bit, falling into the hit, is seen)
  const hasToss = (tS, u0, v0, skip, vImg = 0) => { for (const r of segs) { const e = r[r.length - 1], dt = tS - ts[e[0]]; if (dt < -0.05 || dt > 0.6 || r === skip) continue; if (Math.hypot(e[1] - u0, e[2] - v0) > 100 * s + 1.3 * vImg * Math.max(0, dt)) continue; let dx = Math.abs(e[1] - r[0][1]), dy = Math.abs(e[2] - r[0][2]); const dur = ts[e[0]] - ts[r[0][0]]; if (!(dy > 25 * s && dx < 0.6 * dy)) { let u0 = 1e9, u1 = -1e9, w0 = 1e9, w1 = -1e9; for (const p of r) { u0 = Math.min(u0, p[1]); u1 = Math.max(u1, p[1]); w0 = Math.min(w0, p[2]); w1 = Math.max(w1, p[2]); } dx = u1 - u0; dy = w1 - w0; } /* a whole toss, up and back down, ends near where it started: judge it by how far it went up */ if (dy > 25 * s && dx < 0.6 * dy && dur >= 0.12) return [ts[e[0]], e[1], e[2]]; } return null; };
  // Follow a shot beyond the point where the movement test lost it, using the far-side second look (`fb`): step from frame to frame along the path the ball was on, taking the spot nearest to where it should be. If the path then turns back up the picture, the turning point is the bounce, and a bounce pins down how deep the shot landed.
  const hasFb = !noFar && frames.some(f => f.fb && f.fb.length);
  const followFar = o => { const m = o.t.length, e = o.uv[m - 1]; if (m < 6 || e[1] > cam.tapeY(e[0]) + 5 * s) return null; const tr = o.t.map((t, i) => [t, o.uv[i][0], o.uv[i][1]]), ext = [], up = []; let tl = o.t[m - 1];
    for (let i = o.i1 + 1; i < frames.length; i++) { const f = frames[i], t = ts[i] - o.t0, dt = t - tl; if (f.cut || dt > 0.3 || t - o.t[m - 1] > 2.2) break; if (!f.valid || dt <= 0) continue;
      const k = Math.min(6, tr.length), q = tr.slice(-k), tq = q.map(p => p[0] - tl), cu = polyfit(tq, q.map(p => p[1]), 1), cv = polyfit(tq, q.map(p => p[2]), 1), gate = Math.min(14, 5 + 40 * dt) * s;
      const near = (pu, pv) => { let best = null, bd = gate; if (f.c2) for (const c of f.c2) { const d = Math.hypot(c[0] - pu, c[1] - pv); if (d < bd) { bd = d; best = c; } } const F = f.fb; if (F) for (let j = 0; j + 1 < F.length; j += 2) { const d = Math.hypot(F[j] / 8 - pu, F[j + 1] / 8 - pv); if (d < bd) { bd = d; best = [F[j] / 8, F[j + 1] / 8]; } } return best && [best, bd]; };
      const a = near(cu[0] + cu[1] * dt, cv[0] + cv[1] * dt), b = cv[1] > 30 * s && ext.length >= 3 ? near(cu[0] + cu[1] * dt, cv[0] - 0.7 * cv[1] * dt) : null; // b: where the ball would be had it just bounced
      if (b && (!a || b[1] < a[1] - 1.5 * s)) { up.push([t, b[0][0], b[0][1]]); if (up.length >= 2) break; continue; } if (up.length) break;
      if (!a) continue; tr.push([t, a[0][0], a[0][1]]); ext.push([t, a[0][0], a[0][1]]); tl = t; }
    if (ext.length < 4) return null; const last = ext[ext.length - 1]; let g = null; if (up.length >= 2) { g = cam.ground(last[1], last[2]); if (!g || g[1] < COURT.NET + 0.5 || g[1] > COURT.LEN + 7) g = null; }
    return { t: ext.map(p => p[0]), uv: ext.map(p => [p[1], p[2]]), g, tb: last[0] + 0.5 / fps, all: ext.length, up: up.length }; };
  // ---- The hit and the bounce, as seen in the picture. One camera cannot tell a fast flat flight from a slower loopy one that draws nearly the same track; what tells them apart is when and where the flight starts (the racket meets the incoming ball, about waist high) and when and where it ends (the bounce). Both are usually in the video even when the tracker lost the ball for a moment around them.
  const dtF = 1 / fps, P3 = (q, i) => [ts[q[i][0]], q[i][1], q[i][2]];
  const line = P => { const t0 = P[0][0], tq = P.map(p => p[0] - t0), cu = polyfit(tq, P.map(p => p[1]), 1), cv = polyfit(tq, P.map(p => p[2]), 1); return Object.assign(t => [cu[0] + cu[1] * (t - t0), cv[0] + cv[1] * (t - t0)], { du: cu[1], dv: cv[1] }); };
  const meet = (A, B, ta, tb) => { let best = null; for (let t = ta; t <= tb + 1e-9; t += dtF / 8) { const a = A(t), b = B(t), d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (!best || d < best.d) best = { t, d, uv: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; } return best; };
  const idxAt = t => { let lo = 0, hi = ts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t - 1e-6) lo = m + 1; else hi = m; } return lo; };
  const spotsAt = i => { const f = frames[i], L = []; for (const c of f.c2 || f.c) L.push([c[0], c[1]]); const F = f.fb; if (F) for (let j = 0; j + 1 < F.length; j += 2) L.push([F[j] / 8, F[j + 1] / 8]); return L; };
  // The hit: the incoming ball comes down the picture (towards the camera) and its track ends where the outgoing one starts, a little lower in the picture. Its last spot that still follows its own path is the frame of the hit.
  const contactOf = o => { const tS = o.t0, [uS, vS] = o.uv[0], k = Math.min(5, o.t.length - 1), vOut = Math.abs(o.uv[k][1] - vS) / Math.max(dtF, o.t[k]); let best = null;
    for (const r of segs) { let m = r.length; const tE0 = ts[r[m - 1][0]]; if (tE0 > tS + 2 * dtF || tE0 < tS - 0.45 || m < 6) continue;
      while (m >= 6) { const q = P3(r, m - 1), L = line(Array.from({ length: 4 }, (_, j) => P3(r, m - 5 + j))), a = L(q[0]); let e = Math.hypot(a[0] - q[1], a[1] - q[2]); // the last spots may already be the ball leaving the racket: keep the last one that still follows the path before it (straight, or curving like a falling toss)
        if (m >= 7) { const Q = Array.from({ length: 6 }, (_, j) => P3(r, m - 7 + j)), t0 = Q[0][0], tq = Q.map(p => p[0] - t0), cu = polyfit(tq, Q.map(p => p[1]), 2), cv = polyfit(tq, Q.map(p => p[2]), 2); e = Math.min(e, Math.hypot(polyval(cu, q[0] - t0) - q[1], polyval(cv, q[0] - t0) - q[2])); }
        if (e <= 4 * s && q[0] < tS - 0.5 * dtF) break; m--; } if (m < 6) continue;
      const Q = Array.from({ length: 4 }, (_, j) => P3(r, m - 4 + j)), A = line(Q), e = Q[3], gapV = e[2] - vS, gapT = tS - e[0]; // direction just before the hit
      if (A.dv < 25 * s || gapV < -4 * s || Math.abs(e[1] - uS) > 50 * s + 0.6 * Math.max(0, gapV) || gapV > 3 * vOut * gapT + 40 * s) continue;
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; for (let j = 0; j < m; j++) { u0 = Math.min(u0, r[j][1]); u1 = Math.max(u1, r[j][1]); v0 = Math.min(v0, r[j][2]); v1 = Math.max(v1, r[j][2]); }
      // a serve: the "incoming" ball is the toss, going up and falling back nearly straight above the hit, and it is met high. The tracker may have kept only part of it: a turn at the top with little sideways drift, or a fall that follows a rise of its own nearby.
      let ja = 0; for (let j = 1; j < m; j++) if (r[j][2] < r[ja][2]) ja = j; const dur = ts[r[m - 1][0]] - ts[r[0][0]], rise = r[0][2] - v0, fall = r[m - 1][2] - v0;
      const rose = () => segs.some(r2 => { if (r2 === r) return false; const e2 = r2[r2.length - 1], t2 = ts[e2[0]]; if (t2 > ts[r[0][0]] + dtF || t2 < ts[r[0][0]] - 0.8) return false; const up = r2[0][2] - e2[2], sx = Math.abs(e2[1] - r2[0][1]); return up > 20 * s && sx < 0.6 * up && Math.abs(e2[1] - r[0][1]) < 60 * s + 0.5 * up; });
      const toss = (v1 - v0 > 25 * s && u1 - u0 < 0.6 * (v1 - v0) && dur >= 0.12 && v0 < r[0][2] - 5 * s) || (rise > 15 * s && fall > 15 * s && u1 - u0 < 150 * s * dur && Math.abs(r[ja][1] - r[m - 1][1]) < 60 * s + 0.5 * fall) || (fall > 20 * s && u1 - u0 < 0.6 * fall && rose());
      if (!best || e[0] > best.t) best = { t: e[0], uv: [e[1], e[2]], A, toss }; }
    return best; };
  // The bounce: the ball's path in the picture suddenly turns up (seen from behind, a ball flying away hardly moves in the picture before the bounce and climbs fast after it). Spots after the end of the track (both looks, the far one included) are searched for a straight climb that starts where the track ended.
  const bounceOf = (T, UV) => { const n = T.length; if (n < 6) return null; let P = []; for (let i = 0; i < n; i++) if (T[i] >= T[n - 1] - 0.12 - 1e-9 || i >= n - 4) P.push([T[i], UV[i][0], UV[i][1]]); let A = line(P); // the path just before: the last tenth of a second (in the picture it slows down as the ball goes away)
    for (let i = idxAt(P[P.length - 1][0]) + 1; i < frames.length && ts[i] - P[P.length - 1][0] <= 2.5 * dtF; i++) { if (frames[i].cut) break; const a = A(ts[i]); let best = null, bd = 2 * s; for (const q of spotsAt(i)) { const d = Math.hypot(q[0] - a[0], q[1] - a[1]); if (d < bd) { bd = d; best = q; } } // the tracker often lets go a few frames before the bounce: carry on along the same path with the spots of either look
      if (best) { P.push([ts[i], best[0], best[1]]); const tl = ts[i]; P = P.filter((p, j) => p[0] >= tl - 0.12 - 1e-9 || j >= P.length - 4); A = line(P); } }
    const tE = P[P.length - 1][0], uE = P[P.length - 1][1], vE = P[P.length - 1][2], S = [];
    for (let i = idxAt(tE) + 1; i < frames.length && ts[i] - tE <= 0.3; i++) { if (frames[i].cut) break; if (!frames[i].valid) continue; const dt = ts[i] - tE; for (const q of spotsAt(i)) { const up = vE - q[1]; if (up < -3 * s || up > 8 * s + 900 * s * dt) continue; if (Math.abs(q[0] - (uE + A.du * dt)) > 6 * s + 0.3 * Math.max(0, up)) continue; S.push([ts[i], q[0], q[1], i]); } }
    if (!S.length) return null; const t1 = S[0][0], win = Math.max(0.14, 3.6 * dtF), need = dtF > 0.025 ? 3 : 4; let best = null; // only the first part of the climb: further on it slows down in the picture and a straight line through it points back to the wrong moment
    for (const a of S) { if (a[0] > t1 + 2.5 * dtF) break; for (const b of S) { if (b[3] - a[3] < 2 || b[0] > a[0] + win - dtF) continue; const du = (b[1] - a[1]) / (b[0] - a[0]), dv = (b[2] - a[2]) / (b[0] - a[0]); if (dv > -60 * s || dv > A.dv - 150 * s) continue;
      const inl = new Map(); for (const q of S) { if (q[0] > t1 + win) break; const pu = a[1] + du * (q[0] - a[0]), pv = a[2] + dv * (q[0] - a[0]), d = Math.hypot(q[1] - pu, q[2] - pv); if (d < 3 * s && (!inl.has(q[3]) || d < inl.get(q[3])[4])) inl.set(q[3], [...q.slice(0, 3), q[3], d]); }
      if (inl.size >= need && (!best || inl.size > best.size || (inl.size === best.size && [...inl.values()][0][0] < [...best.values()][0][0]))) best = inl; } }
    if (!best) return null; const Q = [...best.values()].sort((a, b) => a[0] - b[0]).slice(0, 6), B = line(Q); if (B.dv > A.dv - 150 * s) return null;
    const m = meet(A, B, tE - 2 * dtF, Q[0][0]); if (!m || m.d > 5 * s || m.t < tE - 2 * dtF || m.t > Q[0][0]) return null; return { t: m.t, uv: m.uv, post: Q.length }; };
  // Refit with what was seen of the hit and the bounce. Moving the hit along its line of sight (higher and nearer the camera, or lower and further) changes the track in the picture by only a pixel or so, which is the size of the calibration error itself: the picture is given 2 px of slack and the height of the hit (a groundstroke is met at 1.0 m, give or take 25 cm) decides. Tested on broadcast rallies against bounce timing: within 4% instead of 27-34% off. With the hit seen the flight is fitted from the moment of the hit (and its speed is the speed off the racket); the time of the hit is tried a quarter frame either way and the best fit kept.
  // How far on the ground two picture elements are at the landing spot. Seen at a grazing angle (the far service box from a camera at the corner of the court) a metre of court is two or three picture elements, and the court drawing itself is only good to about two: the landing spot cannot be known better than that, however clean the flight. Added to the landing's uncertainty so that such calls show as "on the limit" instead of a firm in or out.
  const geoSd = (lx, ly) => { try { const p = cam.project([lx, ly, 0]), e = 2 * s; let dx = 0, dy = 0; for (const [du, dv] of [[e, 0], [-e, 0], [0, e], [0, -e]]) { const g = cam.ground(p[0] + du, p[1] + dv); if (!g || !isFinite(g[0]) || !isFinite(g[1])) return [3, 3]; dx = Math.max(dx, Math.abs(g[0] - lx)); dy = Math.max(dy, Math.abs(g[1] - ly)); } return [Math.min(3, dx), Math.min(3, dy)]; } catch (e) { return [0, 0]; } };
  const anchored = (o, t, uv, fit, prior, netHit) => { const C = contactOf(o), Tabs = t.map(v => v + o.t0); let B = netHit ? null : bounceOf(Tabs, uv); if (!C && !B) return null;
    let m = t.length; if (B) while (m > 6 && Tabs[m - 1] > B.t - 0.25 * dtF) m--; const tt0 = Tabs.slice(0, m), uv0 = uv.slice(0, m); let best = null;
    const keep = (f, tc, pr, tt) => { if (f && (!best || f.cost < best.fit.cost)) best = { fit: f, tc, prior: pr, t: tt, uv: uv0 }; };
    if (C) for (const dq of [-0.5, -0.25, 0, 0.25, 0.5]) { const tc = C.t + dq * dtF; if (tc >= tt0[0] - 0.25 * dtF) continue; const cpx = C.A(tc), tt = tt0.map(v => v - tc);
      const zc = C.toss ? 2.7 : 1.0, pr = { z: zc, zSd: 0.25, pxSd: 2, side: true, serve: C.toss || undefined, y: null, ySd: prior.ySd, clSd: prior.clSd, floor: true, contactPx: cpx, bounce: B ? { t: B.t - tc, uv: B.uv } : null, anchorNet: prior.anchorNet };
      const d = cam.ray(cpx[0], cpx[1]), sc = (zc - cam.C[2]) / d[2]; if (!(sc > 0)) continue; const p0 = cam.C.map((c, i) => c + sc * d[i]), warms = [];
      if (B) { const db = cam.ray(B.uv[0], B.uv[1]), sb = (RB - cam.C[2]) / db[2], g = cam.C.map((c, i) => c + sb * db[i]), T = B.t - tc; if (T > 0.15) { const vh = [(g[0] - p0[0]) / T, (g[1] - p0[1]) / T], kd = 1 + KD * Math.hypot(...vh) * T / 2; warms.push([...p0, vh[0] * kd, vh[1] * kd, (RB - p0[2] + 0.5 * G * T * T) / T, 0]); } }
      const sp = Math.hypot(fit.x[3], fit.x[4], fit.x[5]), dir = fit.x.slice(3, 6).map(v => v / sp); for (const f of [1, 0.8, 1.25, 1.5]) warms.push([...p0, ...dir.map(v => v * sp * f), fit.x[6] || 0]); // the plain fit may have settled on the wrong one of the two readings (fast and flat, slow and loopy): start from both sides
      for (const w0 of warms) keep(fitFlight(cam, tt, uv0, pr, s, true, w0), tc, pr, tt); }
    if (!best && B) { const tt = tt0.map(v => v - o.t0), pr = { ...prior, bounce: { t: B.t - o.t0, uv: B.uv } }; keep(fitFlight(cam, tt, uv0, pr, s, true, fit.x), o.t0, pr, tt); keep(fitFlight(cam, tt, uv0, pr, s, true), o.t0, pr, tt); }
    if (!best || best.fit.rms > Math.max(2.5, 1.5 * fit.rms + 0.5)) return null; // the hit or the bounce found does not belong to this flight
    return { ...best, C: best.tc !== o.t0 ? C : null, B }; };
  // First the shots that can be followed to a bounce. A seen bounce fixes the flight without any assumption about where the track starts, so these shots also show how far in front of the hitter's feet tracks really begin in this video (at 60 pictures a second the blurred ball near the camera is often missed and tracks start metres late). That offset then replaces the default for the shots without a bounce.
  const pre = new Map(), first = new Map(); if (hasFb && mode !== 'serve') { const offs = []; obs.forEach((o, ci) => { if (onProgress) onProgress(0.4 * ci / obs.length); if (only && !only.some(q => Math.abs(q - o.t0) < 0.3)) return; const r = fitOne(o, meta.yOff); first.set(o, r); if (!r || r.n !== o.t.length || r.fit.rms > 3 || (o.zNet > 0.05 && o.zNet < 1.12)) return; const ex = followFar(o); if (!ex) return;
      const t2 = o.t.concat(ex.t), uv2 = o.uv.concat(ex.uv), firm = ex.up >= 2, pr2 = ex.up ? { ...r.prior, y: firm ? null : r.prior.y, groundT: ex.tb, groundSd: firm ? 0.1 : 0.4 } : r.prior; /* one spot on the way back up may be something else, two in a row are a bounce */ let f2 = fitFlight(cam, t2, uv2, pr2, s, true, r.fit.x); const f3 = fitFlight(cam, t2, uv2, pr2, s, true); if (f3 && (!f2 || f3.rms < f2.rms)) f2 = f3;
      if (f2 && f2.rms <= 2.5) { pre.set(o, { fit: f2, t: t2, uv: uv2, prior: pr2, bounce: firm }); if (firm && o.fg && f2.x[4] > 6) offs.push(f2.x[1] - o.fg[1]); } });
    if (offs.length >= 6) { offs.sort((a, b) => a - b); const md = offs[offs.length >> 1], dev = offs.map(v => Math.abs(v - md)).sort((a, b) => a - b)[offs.length >> 1]; meta.yOffB = [md, 1.48 * dev, offs.length]; const nu = Math.max(0.6, Math.min(4.5, md)); if (Math.abs(nu - meta.yOff) > 0.15) { meta.yOff = nu; first.clear(); } ySdU = Math.max(ySd, Math.min(2.5, 1.48 * dev)); if (ySdU !== ySd) first.clear(); }
    if (!first.size) for (const [o, pf] of pre) { if (pf.bounce) continue; const pr = { ...pf.prior, y: o.fg ? o.fg[1] + meta.yOff : null, ySd: ySdU }; let f2 = fitFlight(cam, pf.t, pf.uv, pr, s, true, pf.fit.x); const f3 = fitFlight(cam, pf.t, pf.uv, pr, s, true); if (f3 && (!f2 || f3.rms < f2.rms)) f2 = f3; if (f2 && f2.rms <= 2.5) { pf.fit = f2; pf.prior = pr; } else pre.delete(o); } } // the followed shots without a firm bounce were fitted with the old start offset: redo them with the calibrated one
  obs.forEach((o, ci) => { if (onProgress) onProgress((pre.size || first.size ? 0.4 : 0) + (pre.size || first.size ? 0.6 : 1) * ci / obs.length); if (only && !only.some(q => Math.abs(q - o.t0) < 0.3)) return;
    if (mode === 'serve') { const d0 = cam.ray(o.uv[0][0], o.uv[0][1]), sc = (0 - cam.C[1]) / d0[1]; if (!(sc > 0) || cam.C[2] + sc * d0[2] < 1.5) { meta.rej.notServe = (meta.rej.notServe || 0) + 1; return; } } // serve practice: a ball that starts low over the baseline is not a serve, no need to fit it
    const r = first.get(o) || fitOne(o, meta.yOff); if (!r) { meta.rej.nofit++; return; }
    let { fit, t, uv, n, prior } = r; const fg = o.fg, t0 = o.t0; let netHit = false;
    const brk = n === o.t.length ? afterEnd(o) : null; if (brk) meta['net' + brk] = (meta['net' + brk] || 0) + 1;
    const endY = simulateAt(fit.x, [t[n - 1]])[0][1];
    // From behind, depth is the weak direction, so a track ending low on the net's line of sight within 2.5 m of the net is taken as a net ball. Seen from the side depth is measured directly: there the end must be at the net (1.2 m), unless the break itself was seen.
    const kink = n === o.t.length && endBreak(o), netTol = kink || brk === 'fall' ? 2.5 : Math.abs(cam.C[0]) > COURT.D + 1 ? 1.2 : 2.5; if (kink) meta.netkink = (meta.netkink || 0) + 1;
    if (fg && n === o.t.length && brk !== 'pass' && o.zNet > 0.05 && o.zNet < 1.12 && fit.rms <= 3 && Math.abs(endY - COURT.NET) < netTol) { // died in the net: pin the last point to the net plane
      prior = { ...prior, anchorNet: true }; const f2 = fitFlight(cam, t, uv, prior, s, true, fit.x); if (f2 && f2.rms <= 3) { fit = f2; netHit = true; } }
    const whole = n === o.t.length; let bounce = false;
    const pf = pre.get(o); if (pf && whole && !netHit) { fit = pf.fit; t = pf.t; uv = pf.uv; n = t.length; prior = pf.prior; bounce = pf.bounce; meta.followed = (meta.followed || 0) + 1; if (bounce) meta.farBounce = (meta.farBounce || 0) + 1; }
    let tHit = t0, hitSeen = false; let an = anchored(o, t, uv, fit, prior, netHit);
    if (an && !netHit && !an.B && !flightSummary(an.fit.x).net) { const pr = { ...an.prior, anchorNet: true }, f2 = (brk === 'fall' || kink) && o.zNet > 0.05 && o.zNet < 1.12 ? fitFlight(cam, an.t, an.uv, pr, s, true, an.fit.x) : null; // fitted from the hit, the flight comes down short of the net: if the ball was seen to stop at the net it died there, otherwise this reading is wrong and the plain fit stays
      if (f2 && f2.rms <= Math.min(3, Math.max(2.5, 1.5 * an.fit.rms + 0.5))) { an = { ...an, fit: f2, prior: pr }; netHit = true; } else an = null; }
    if (an) { fit = an.fit; t = an.t; uv = an.uv; n = t.length; prior = an.prior; tHit = an.tc; hitSeen = !!an.C; if (an.B) bounce = true; meta.hitSeen = (meta.hitSeen || 0) + (hitSeen ? 1 : 0); meta.bounceSeen = (meta.bounceSeen || 0) + (an.B ? 1 : 0); }
    // A poor fit of a long, clean track usually has one of two plain causes, both seen on a lesson filmed from the corner (a third of the player's strokes were being thrown away there): the track starts one or two pictures early, on the ball still coming in before the hit; or it runs on through the bounce, which a camera at the side sees directly. Try again without those ends before giving up.
    if (fit.rms > 3 && !netHit && whole && n >= 14) { let tt = t, uu = uv, im = 0, cut = 0; { let ia = 0; for (let i = 1; i < uu.length; i++) if (uu[i][1] < uu[ia][1]) ia = i; im = ia; for (let i = ia + 1; i < uu.length; i++) if (uu[i][1] > uu[im][1]) im = i; } // the top of the arc in the picture, then the lowest point after it
      if (im >= 9 && im <= uu.length - 3 && uu[uu.length - 1][1] < uu[im][1] - 6 * s) { let up = true; for (let i = im + 1; i < uu.length; i++) if (uu[i][1] > uu[i - 1][1] + 1.5 * s) up = false; if (up) { const gap = tt[im] - tt[im - 1] > 0.08; if (gap) im--; tt = tt.slice(0, im + 1); uu = uu.slice(0, im + 1); cut = gap ? 1 : 2; } } // lowest point of the path in the picture, rising after it: the bounce
      for (const d of cut ? [0, 1, 2] : [1, 2]) { if (tt.length - d < 12) break; const t2 = tt.slice(d), u2 = uu.slice(d), pr = cut === 2 ? { ...prior, groundT: t2[t2.length - 1], groundSd: 0.15 } : prior, /* the ball was lost for a moment around the bounce: then the last point before the gap is still in the air and nothing is said about the ground */ f2 = fitFlight(cam, t2, u2, pr, s, true, fit.x);
        if (f2 && f2.rms <= 2.5) { fit = f2; t = t2; uv = u2; n = t2.length; prior = pr; if (cut) bounce = true; meta.rescued = (meta.rescued || 0) + 1; break; } } }
    if (fit.rms > 3) { meta.rej.rms++; return; } const x = fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6; if (speed < 30 || speed > 230 || x[4] < 6) { meta.rej.speed++; return; }
    if (!hitSeen && x[1] > 5) { meta.rej.late = (meta.rej.late || 0) + 1; return; } // first seen well inside the court with no sign of the hit: the start of the flight is missing, and so is the speed off the racket (a ball already in the air when the video starts, or something else moving)
    const sum = flightSummary(x); if (!sum.land) { meta.rej.noland++; return; }
    const flat = fitFlight(cam, t, uv, prior, s, false, x);
    const sd = covariance(fit, y => { const q = flightSummary(y); return [q.land ? q.land[0] : 0, q.land ? q.land[1] : 0, q.net ? q.net[2] : 0, y[6], 3.6 * Math.hypot(y[3], y[4], y[5])]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3, 1e-3].slice(0, fit.x.length)) || [9, 9, 9, 9, 99];
    // The ball is often lost near the top of its path (far away it is two pixels wide and nearly still in the picture). Speed, direction and height over the net are then well measured but how deep it lands is not: a clean, long enough track is kept and marked as an estimate rather than thrown away.
    const approx = sd[1] > 3; if (approx) meta.approx = (meta.approx || 0) + 1; if (approx && !(mode !== 'serve' && sd[1] <= 5 && fit.rms <= 1.5 && n >= 12 && whole && sd[2] <= 0.5 && sd[4] <= 0.25 * speed && speed <= 150 && sum.net && sum.clear > 0)) { meta.rej.depth++; return; } // depth and speed go together: an estimate that is also very fast or very loose is not worth showing if (approx) meta.approx = (meta.approx || 0) + 1;
    const C = COURT, [lx, ly] = sum.land, serve = x[2] > 2.0 && x[1] < 1.5 && (mode === 'serve' || (x[2] > 2.2 && x[5] < 2.5 && !approx && hasToss(t0, o.uv[0][0], o.uv[0][1], null))); let result, target = null; // outside serve practice a serve is a high, flat start that follows a toss; anything else is a rally ball
    if (mode === 'serve' && !serve) { meta.rej.notServe = (meta.rej.notServe || 0) + 1; return; } // serve practice: a ball bounced on the ground or rolled back is not a serve
    if (!netHit && !sum.net) { meta.rej.short = (meta.rej.short || 0) + 1; return; } // a flight that comes down on the hitter's own side with no sign of the net is nearly always something else that moved (a ball bounced at the feet, a ball rolling)
    if (netHit || (sum.clear < 0 && brk !== 'pass')) result = 'net';
    else if (mode === 'serve' || serve) { const left = x[0] > 0; target = left ? 'left' : 'right';
      const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly <= C.LEN - C.SV) ? 'in' : (ly > C.LEN - C.SV ? 'long' : 'wide'); }
    else result = (Math.abs(lx) <= C.S && ly <= C.LEN) ? 'in' : (ly > C.LEN ? 'long' : 'wide');
    { const g = geoSd(lx, ly); sd[0] = Math.hypot(sd[0], g[0]); sd[1] = Math.hypot(sd[1], g[1]); }
    let close = false; if (result !== 'net') { const yLim = (mode === 'serve' || serve) ? C.LEN - C.SV : C.LEN, xs = target ? (target === 'left' ? [-C.S, 0] : [0, C.S]) : [-C.S, C.S];
      close = Math.abs(ly - yLim) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
    const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0);
    shots.push({ t: tHit, hit: hitSeen, who: 'me', far: false, approx, bounce, netSeen: result === 'net' && (brk === 'fall' || kink), brk: brk || (kink ? 'kink' : null), endY, zNetEnd: o.zNet, speedSd: sd[4], n, nTotal: o.t.length, rms: fit.rms, rmsFlat: flat ? flat.rms : null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], sideCl: x[7] || 0, clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
      land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit, netZ: netHit ? o.zNet : null, serve, target, feetY: fg ? fg[1] : null,
      path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv });
  });
  ms.near = Date.now() - T0;
  // ---- serves hit from the near side. Seen from a camera a few metres up, the ball leaves the racket above the net tape in the picture and comes DOWN the picture while it flies away, so it never qualifies as an ordinary near-side shot.
  const usedS = new Set(), noPre = new Set(); meta.nearServes = 0;
  if (!only) for (let a = 0; a < segs.length; a++) { if (usedS.has(a)) continue; const q = segs[a], x0 = q[0][1], y0 = q[0][2], e0 = q[q.length - 1];
    if (dbgT != null && ts[q[0][0]] >= dbgT && q.length >= 10 && (y0 > cam.tapeY(x0) - 5 * s || e0[2] < y0 + 20 * s)) { const dur = ts[e0[0]] - ts[q[0][0]], sp = Math.hypot(e0[1] - x0, e0[2] - y0) / Math.max(0.01, dur); if (sp > 250 * s && (meta.dbgF = meta.dbgF || []).length < 160) meta.dbgF.push([+ts[q[0][0]].toFixed(2), q.length, Math.round(x0), Math.round(y0), Math.round(e0[1]), Math.round(e0[2]), Math.round(cam.tapeY(x0)), Math.round(sp)]); }
    if (y0 > cam.tapeY(x0) - 5 * s || e0[2] < y0 + 20 * s) continue; const chain = [q], idx = [a]; const dd = { t: +ts[q[0][0]].toFixed(2), st: 'chain' }; if (dbgT != null && dd.t >= dbgT && (meta.dbgS = meta.dbgS || []).length < 160) meta.dbgS.push(dd);
    for (let b = a + 1; b < segs.length; b++) { if (usedS.has(b)) continue; const r = segs[b], last = chain[chain.length - 1], gap = r[0][0] - last[last.length - 1][0]; if (gap > 6 / fs) break; if (gap < -1) continue;
      const k = Math.min(last.length, 6), sg = last.slice(-k), f = sg.map(p => p[0] - r[0][0]), px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0);
      if (Math.hypot(px - r[0][1], py - r[0][2]) < (15 + 3 * gap) * s && r[r.length - 1][2] > r[0][2]) { chain.push(r); idx.push(b); } }
    // Seen from behind, the first tenth of a second or so of a serve runs ACROSS the picture, not down it, so it is a track of its own that never qualifies as a start. Joined here (same direction, meeting where this one begins), the track begins at the hit. Serve practice video: the ball was found only 0.1-0.15 s after the racket met it, and the flight read up to 20 % fast from there. If the longer track then fails a test the shorter one passes, the serve is tried again without it.
    let nPre = 0; if (!noPre.has(a)) for (let b = a - 1; b >= 0 && nPre < 4; b--) { if (usedS.has(b)) continue; const r = segs[b], first = chain[0], gap = first[0][0] - r[r.length - 1][0]; if (first[0][0] - r[0][0] > 120 / fs) break; if (gap > 6 / fs || gap < -1 || r.length < 3) continue;
      const k = Math.min(r.length, 6), sg = r.slice(-k), f = sg.map(p => p[0] - first[0][0]), px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0), df = Math.max(1, sg[k - 1][0] - sg[0][0]), ux = (sg[k - 1][1] - sg[0][1]) / df, uy = (sg[k - 1][2] - sg[0][2]) / df;
      const m = Math.min(first.length, 6), dm = Math.max(1, first[m - 1][0] - first[0][0]), wx = (first[m - 1][1] - first[0][1]) / dm, wy = (first[m - 1][2] - first[0][2]) / dm, cosA = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1);
      if (Math.hypot(ux, uy) > 4 * s / fs && cosA > 0.7 && Math.hypot(px - first[0][1], py - first[0][2]) < (15 + 3 * Math.max(0, gap)) * s) { chain.unshift(r); idx.unshift(b); nPre++; } }
    if (nPre) meta.prepended = (meta.prepended || 0) + 1; const again = () => { if (!nPre) return false; noPre.add(a); a--; meta.nearServes--; return true; };
    const seenF = new Set(), pts = []; for (const sg of chain) for (const p of sg) if (!seenF.has(p[0])) { seenF.add(p[0]); pts.push(p); } pts.sort((u, v) => u[0] - v[0]); if (pts.length < 6) continue;
    // the toss often runs straight into the serve as one track: the hit is where the ball suddenly gets much faster in the picture
    { const st = []; for (let i = 1; i < pts.length; i++) st.push(Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) / Math.max(1, pts[i][0] - pts[i - 1][0])); let cut = 0;
      for (let i = 1; i < Math.min(st.length - 5, 30); i++) { const before = Math.max(st[i - 1], i > 1 ? st[i - 2] : 0, 1.5 * s * fs); if (st[i] > 2.5 * before && st[i + 1] > 0.5 * st[i]) cut = i; }
      if (cut) pts.splice(0, cut); if (pts.length < 6) continue; }
    dd.st = 'gpe'; dd.n = pts.length; dd.a = pts[0].slice(1, 3).map(Math.round); dd.e = pts[pts.length - 1].slice(1, 3).map(Math.round);
    const end = pts[pts.length - 1], gpe = cam.ground(end[1], end[2]); if (!gpe || gpe[1] < COURT.NET - 1 || gpe[1] > COURT.LEN + 12) continue; // last seen on the near side of the net: not a serve going away
    dd.st = 'zB'; dd.g = gpe.map(v => +v.toFixed(1));
    const d0 = cam.ray(pts[0][1], pts[0][2]), sc0 = (0 - cam.C[1]) / d0[1], zB = cam.C[2] + sc0 * d0[2]; dd.zB = +zB.toFixed(1); dd.xB = +(cam.C[0] + sc0 * d0[0]).toFixed(1); if (!(sc0 > 0) || zB < 1.6 || zB > 3.6) continue; dd.st = 'bounce'; // over the baseline it must be at a height a racket can reach
    let ground = null, groundAt = null; for (const r of segs) { const g0 = r[0][0] - end[0]; if (g0 < 0 || g0 > 3 || r === chain[chain.length - 1]) continue; if (Math.hypot(r[0][1] - end[1], r[0][2] - end[2]) < 14 * s && r.length >= 4 && r[Math.min(3, r.length - 1)][2] < r[0][2] - 2 * s) { ground = gpe; break; } }
    if (!ground) { // the ball is often lost just before it lands (bright court, small ball) and found again coming up off the ground: where the two paths meet is the bounce
      const k = Math.min(5, pts.length), A = pts.slice(-k), tE = ts[end[0]], ax = polyfit(A.map(p => ts[p[0]] - tE), A.map(p => p[1]), 1), ay = polyfit(A.map(p => ts[p[0]] - tE), A.map(p => p[2]), 1);
      for (const r of segs) { if (r.length < 4 || r === chain[chain.length - 1]) continue; const gap = ts[r[0][0]] - tE; if (gap < 0.03 || gap > 0.6) continue; if (Math.abs(r[0][1] - end[1]) > 70 * s || Math.abs(r[0][2] - end[2]) > 70 * s) continue;
        const B = r.slice(0, Math.min(5, r.length)), by = polyfit(B.map(p => ts[p[0]] - tE), B.map(p => p[2]), 1), bx = polyfit(B.map(p => ts[p[0]] - tE), B.map(p => p[1]), 1); if (!(ay[1] > 0) || !(by[1] < -20 * s)) continue; // going down before, coming up after
        const tau = (by[0] - ay[0]) / (ay[1] - by[1]); if (!(tau > -0.02) || tau > gap + 0.02) continue; const yy = ay[0] + ay[1] * tau, xx = 0.5 * (ax[0] + ax[1] * tau + bx[0] + bx[1] * tau), g = cam.ground(xx, yy); if (!g || g[1] < COURT.NET - 2 || g[1] > COURT.LEN + 8) continue;
        groundAt = { t: tE - ts[pts[0][0]] + Math.max(0, tau), g }; break; } }
    // in a match or a lesson most balls first seen high and coming down are ordinary shots caught late; a serve is the one that follows a toss: a slow, nearly vertical track ending where this one starts (often only the last bit of the toss, falling into the hit, is seen)
    const kq = Math.min(5, pts.length - 1), vImg = Math.hypot(pts[kq][1] - pts[0][1], pts[kq][2] - pts[0][2]) / Math.max(0.01, ts[pts[kq][0]] - ts[pts[0][0]]), toss = hasToss(ts[pts[0][0]], pts[0][1], pts[0][2], chain[0], vImg);
    if (mode !== 'serve' && !toss) { meta.rej.noToss = (meta.rej.noToss || 0) + 1; continue; } dd.toss = toss && toss.map(Math.round);
    dd.st = 'fit'; dd.b = ground ? 'g' : groundAt ? 'gAt' : '-';
    // The racket's click, when the sound has one just before the first point of the track: the moment of the hit. From behind, a serve flying straight away can be fast and deep or slow and short along nearly the same line in the picture; the time it left the racket tells which, as a seen bounce would.
    let tcS = null; const tcCand = []; if (clicks && clicks.length) { const tS = ts[pts[0][0]]; for (const c of clicks) { const d = tS - c.t; if (d >= 0 && d <= 0.4) tcCand.push(c.t); } if (tcCand.length) tcS = tcCand[tcCand.length - 1]; } // every click up to 0.4 s before the first point is a candidate; the fit chooses
    meta.nearServes++; const blind = !ground && !groundAt; if (blind && mode === 'serve' && tcS == null) { meta.rej.noBounce = (meta.rej.noBounce || 0) + 1; continue; } // a ball flying straight away from the camera can be fast and deep or slow and short and draw nearly the same line in the picture: without the bounce the serve cannot be measured honestly
    const t0 = ts[pts[0][0]], t = pts.map(p => ts[p[0]] - t0), uv = pts.map(p => [p[1], p[2]]), prior = { serve: true, y: 0.2, ySd: 0.5, z: 2.7, zSd: 0.4, clSd, ground, groundAt, rad: pts.map(p => Math.sqrt(p[3] / Math.PI)), contact: toss && Math.abs(cam.C[0]) > COURT.D + 1 && Math.hypot(toss[1] - pts[0][1], toss[2] - pts[0][2]) > 40 * s ? [toss[1], toss[2]] : null }; // only from the side: from behind the track starts at the hit and the old assumption is the better one (serve practice video: 22 serves with it, 13 without)
    let fit = fitFlight(cam, t, uv, prior, s, true), tHitS = t0;
    if (tcCand.length && fit) { let bestA = null; const sp0 = 3.6 * Math.hypot(fit.x[3], fit.x[4], fit.x[5]);
      for (const tc of tcCand) { const dt0 = t0 - tc, p = fit.x.slice(0, 3), v = fit.x.slice(3, 6), n = Math.max(1, Math.ceil(dt0 * 240)); for (let k = 0; k < n; k++) rk4(p, v, fit.x[6] || 0, -dt0 / n); const prA = { ...prior, y: 0.2, ySd: 0.4, z: 2.6, zSd: 0.3, contact: null }, tA = t.map(v => v + dt0); for (const w0 of [[...p, ...v, fit.x[6] || 0], null]) { const fA = fitFlight(cam, tA, uv, prA, s, true, w0 || undefined); if (fA && fA.rms <= 3 && (!bestA || fA.cost < bestA.f.cost)) bestA = { f: fA, tA, tc }; } }
      if (bestA && !blind && (meta.dbgServe = meta.dbgServe || []).length < 80) meta.dbgServe.push([+t0.toFixed(2), Math.round(sp0), Math.round(3.6 * Math.hypot(bestA.f.x[3], bestA.f.x[4], bestA.f.x[5])), +(t0 - bestA.tc).toFixed(3), tcCand.length]); // bounce seen: the anchored reading against the one the bounce settles
      // Only a click close to the start of the track is trusted to time the hit: with the track joined back to the hit, the serves of the practice video whose bounce was also seen read the same both ways (0-10 %) when the click came at most 0.06 s before the first point, and anywhere from 38 % slow to 24 % fast when it came 0.09-0.37 s before (a sound from elsewhere, or a hit the picture lost).
      if (bestA && blind && t0 - bestA.tc <= 0.08) { fit = bestA.f; t.splice(0, t.length, ...bestA.tA); tHitS = bestA.tc; meta.serveHeard = (meta.serveHeard || 0) + 1; } } // fitted again from the click (the one the track agrees with best), the hit pinned over the baseline; only needed when the bounce was not seen
    if (fit) { dd.rms = +fit.rms.toFixed(1); dd.x = fit.x.map(v => +v.toFixed(1)); dd.st = 'rms'; } if (!fit || fit.rms > 3) { if (again()) continue; meta.rej.rms++; continue; } const x = fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6; dd.st = 'speed'; if (speed < 50 || speed > 260 || (mode !== 'serve' && (speed > 215 || pts.length < 10))) { meta.rej.speed++; continue; } // in a match a handful of points at a record-breaking speed is something else that was moving
    // Outside serve practice a ball fed by the coach that bounces up in front of the player looks like a toss, and the stroke that follows like a serve. A serve is met above the head: run the fitted flight back to the baseline (gravity only, it is a fraction of a second) and ask for a height no groundstroke has. Checked on a corner-view lesson: four strokes labelled serve came back at 1.3 to 2.3 m, the sixteen real serves at 2.5 to 3.0 m.
    if (mode !== 'serve') { const tb = x[4] > 1 ? Math.max(-0.6, Math.min(0, -x[1] / x[4])) : 0, zb = x[2] + x[5] * tb - 0.5 * 9.81 * tb * tb; if (zb < 2.35) { meta.rej.lowServe = (meta.rej.lowServe || 0) + 1; continue; } }
    const sum = flightSummary(x); if (!sum.land) { if (again()) continue; meta.rej.noland++; continue; }
    if (!sum.net || Math.abs(x[0]) > COURT.D + 0.3) { if (again()) continue; meta.rej.short = (meta.rej.short || 0) + 1; continue; } // a serve is hit from between the sidelines and reaches the net; a fit that says otherwise has latched on to something else (a ball on the far side seen low over the net)
    // From a low camera the far service box lies behind the net band, so the bounce of a serve is hidden. After a seen toss, a clean track followed until just before the landing still fixes the serve well enough; it is marked as an estimate.
    const sd = covariance(fit, y => { const w = flightSummary(y); return [w.land ? w.land[0] : 0, w.land ? w.land[1] : 0, w.net ? w.net[2] : 0, y[6]]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9]; if (sd[1] > (ground || groundAt ? 3 : 2.5)) { if (again()) continue; meta.rej.depth++; continue; }
    if (blind && !(tHitS !== t0 ? sd[1] <= 2 : (fit.rms <= 1.5 && pts.length >= 15 && sd[1] <= 1.5 && sum.tLand - t[t.length - 1] < 0.25))) { meta.rej.noBounce = (meta.rej.noBounce || 0) + 1; continue; } if (blind) meta.approx = (meta.approx || 0) + 1;
    dd.st = 'ok'; dd.land = sum.land.map(v => +v.toFixed(1));
    const C = COURT, [lx, ly] = sum.land, left = x[0] > 0, target = left ? 'left' : 'right'; let result;
    { const g = geoSd(lx, ly); sd[0] = Math.hypot(sd[0], g[0]); sd[1] = Math.hypot(sd[1], g[1]); }
    // A serve whose bounce was not seen and whose fitted flight passes the tape by less than the fit can vouch for: seen from the side the track always ends as the ball's picture reaches the net, so "just over" and "into the tape" look the same up to there. Gabriel's check of a corner-view lesson: both such serves (0.27 and 0.33 m over by the fit) had gone into the net. Called net, and marked as on the limit.
    const netDoubt = blind && Math.abs(cam.C[0]) > COURT.D + 1 && sum.net && sum.clear >= 0 && sum.clear < Math.max(0.4, 1.2 * sd[2]); if (netDoubt) meta.netDoubt = (meta.netDoubt || 0) + 1;
    // From the side, a serve whose bounce was not seen cannot be placed: on the corner-view lesson such serves came out 2-4 m long or 3-4 m outside the doubles line at 100-130 km/h, and the one Gabriel checked (60:06, into the net) read 'wide'. Only the 'net, on the limit' call above is kept for them (both he checked were right); the rest are not shown.
    if (blind && !netDoubt && Math.abs(cam.C[0]) > COURT.D + 1) { if (again()) continue; meta.rej.sideBlind = (meta.rej.sideBlind || 0) + 1; continue; }
    if (!sum.net || sum.clear < 0 || netDoubt) result = 'net'; else { const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly <= C.LEN - C.SV) ? 'in' : (ly > C.LEN - C.SV ? 'long' : 'wide'); }
    let close = netDoubt; if (result !== 'net') { const xs = left ? [-C.S, 0] : [0, C.S]; close = Math.abs(ly - (C.LEN - C.SV)) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
    const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0); for (const i of idx) usedS.add(i);
    shots.push({ t: tHitS, heard: tHitS !== t0 || undefined, who: 'me', far: false, viaToss: true, approx: blind, bounce: !!(ground || groundAt), n: pts.length, nTotal: pts.length, rms: fit.rms, rmsFlat: null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
      land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit: false, netZ: null, serve: true, target, feetY: null,
      path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv }); }
  capHeard(shots, meta);
  ms.serve = Date.now() - T0;
  // ---- balls coming toward the camera: the opponent's shots in a match, or serves hit from the far side in serve practice
  const kinkAt = P => { const n = P.length, T = P.map(p => ts[p[0]]); const sse = (a, b) => { let e = 0; for (const j of [1, 2]) { const c = polyfit(T.slice(a, b).map(x => x - T[a]), P.slice(a, b).map(p => p[j]), 2); for (let i = a; i < b; i++) e += (polyval(c, T[i] - T[a]) - P[i][j]) ** 2; } return e; };
    const all = sse(0, n); let best = null; for (let k = 7; k <= n - 4; k++) { const e = sse(0, k) + sse(k, n); if (!best || e < best.e) best = { e, k }; }
    if (!best || best.e > 0.15 * all) return null; /* two arcs must explain the track far better than one (the pace down the picture may rise or fall at the bounce, so its sign is not tested) */ const k = best.k, tq = T.slice(0, k).map(x => x - T[0]), cu = polyfit(tq, P.slice(0, k).map(p => p[1]), 2), cv = polyfit(tq, P.slice(0, k).map(p => p[2]), 2);
    const tb = (T[k - 1] + T[k]) / 2 - T[0]; return { i: k, u: polyval(cu, tb), v: polyval(cv, tb) }; };
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
      meta.incoming++; const t0 = ts[pts[0][0]]; let t = pts.map(p => ts[p[0]] - t0), uv = pts.map(p => [p[1], p[2]]), prior = { dir: -1, y: null, z: 1.4, zSd: 3, clSd, ground, farHit: mode === 'serve' ? { y: COURT.LEN + 0.3, z: 2.6, zSd: 0.4 } : { y: COURT.LEN + 0.8, z: 1.0, zSd: 0.45 } }; // the track is first seen well after the opponent's hit: its height there is loose, the hit itself (waist high, just behind the far baseline) is not
      let fit = fitFlight(cam, t, uv, prior, s, true), cut = false;
      // Seen from a low camera behind the baseline (below 5 m; from higher up the bounce turns the path back up and is found as before), a ball that bounces on the camera's side keeps coming down the picture after the bounce, only at another pace: the tracker joins both parts into one track that no flight fits. Cut it where its pace changes; that spot is the bounce.
      if ((!fit || fit.rms > 3) && !ground && pts.length >= 12 && cam.C[2] < 5) { const k = kinkAt(pts); if (k) { const g = cam.ground(k.u, k.v); if (g && g[1] > -4 && g[1] < COURT.NET && Math.abs(g[0]) < 8) { ground = g; const P2 = pts.slice(0, k.i); t = P2.map(p => ts[p[0]] - t0); uv = P2.map(p => [p[1], p[2]]); prior = { ...prior, ground }; fit = fitFlight(cam, t, uv, prior, s, true); cut = true; meta.kinkCut = (meta.kinkCut || 0) + 1; } } }
      if (!fit || fit.rms > (cut ? 6 : 3)) continue; // near the camera the ball crosses tens of pixels a frame: a cut track gets twice the usual slack
      const x = fit.x, vSeen = Math.hypot(x[3], x[4], x[5]), Bh = backTo(x, prior.farHit.y), v0 = Bh ? Math.hypot(...Bh[1]) : vSeen, speed = v0 * 3.6; if (speed < 25 || speed > 240) continue; // speed off the opponent's racket, not where the ball was first seen
      const sum = flightSummary(x); if (!sum.land) continue;
      const sd = covariance(fit, y => { const w = flightSummary(y); return [w.land ? w.land[0] : 0, w.land ? w.land[1] : 0, w.net ? w.net[2] : 0, y[6]]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9]; if (sd[1] > (ground ? 3 : 1.5)) continue; // without a visible bounce the depth of an incoming ball is only trusted when the fit is tight
      const C = COURT, [lx, ly] = sum.land, serve = x[2] > 2.0 && x[1] > C.LEN - 2; let result, target = null;
      // Serve practice: a ball coming toward the camera counts as a serve only if it was first seen beyond the net, its flight run back reaches the far baseline at a serving height inside the doubles lines, and a toss was seen before it. Gabriel's serve practice: 13 such 'serves' at 63-178 km/h with nobody on the far court (balls from elsewhere, or rolling back); 12 go, one is left.
      if (mode === 'serve' && !(Bh && Bh[0][2] >= 2.0 && Bh[0][2] <= 3.5 && Math.abs(Bh[0][0]) <= C.D + 0.5 && x[1] > C.NET && hasToss(t0, uv[0][0], uv[0][1], null))) { meta.rej.farNotServe = (meta.rej.farNotServe || 0) + 1; continue; }
      const past = x[1] < C.NET + 0.3 || (ground && ground[1] < C.NET - 0.3); // first seen when it was already at the net, or seen bouncing on the camera's side: it did get over
      if (!past && (!sum.net || sum.clear < 0)) result = 'net';
      else if (mode === 'serve' || serve) { const left = x[0] > 0; target = left ? 'left' : 'right'; const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly >= C.SV) ? 'in' : (ly < C.SV ? 'long' : 'wide'); }
      else result = (Math.abs(lx) <= C.S && ly >= 0) ? 'in' : (ly < 0 ? 'long' : 'wide');
      let close = false; if (result !== 'net') { const yLim = target ? C.SV : 0, xs = target ? (target === 'left' ? [-C.S, 0] : [0, C.S]) : [-C.S, C.S]; close = Math.abs(ly - yLim) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
      const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0);
      // Was it played back? After its bounce the ball either bounces again, or the near player sends it back: a ball going up the picture from the near side to the net. That shows even when his shot itself could not be measured (too close to the camera, at the edge of the picture), and it is what tells a rally from a ball sent back between points.
      let returned = false; { const P = sum.path, n = P.length, vx = n >= 3 ? (P[n - 2][0] - P[n - 3][0]) * 60 : 0, vy = n >= 3 ? (P[n - 2][1] - P[n - 3][1]) * 60 : -15, vz = n >= 3 ? (P[n - 2][2] - P[n - 3][2]) * 60 : -5, b1 = t0 + sum.tLand, up = 0.78 * Math.max(1, -vz), b2 = b1 + 2 * up / G;
        const after = tt => { const d = Math.max(0, tt - b1); return [lx + 0.7 * vx * d, ly + 0.7 * vy * d, RB + up * d - 0.5 * G * d * d]; }; // the ball after its bounce, roughly
        for (const r of segs) { const ta = ts[r[0][0]]; if (ta < b1 - 0.4 || ta > b2 + 0.3 || r.length < 5) continue; const a0 = r[0], e = r[r.length - 1]; if (!(a0[2] > cam.tapeY(a0[1]) + 20 * s && a0[2] - e[2] > 40 * s)) continue;
          const q = cam.project(after(ta)); if (Math.hypot(q[0] - a0[1], q[1] - a0[2]) < 140 * s) { returned = true; break; } } } // it must start where this ball is at that moment: a ball bounced or tossed elsewhere (before a serve) is not a return
      shots.push({ t: t0, who: mode === 'serve' ? 'me' : 'opp', far: true, returned, tHit: Bh ? t0 + Bh[2] : null, speedSeen: vSeen * 3.6, kinkCut: cut, bounce: !!ground, n: pts.length, nTotal: pts.length, rms: fit.rms, rmsFlat: null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
        land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit: false, netZ: null, serve: mode === 'serve' || serve, target, feetY: null,
        path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv }); } }
  // ---- shots heard but not seen leaving the racket. Near the camera the ball leaves the racket blurred, behind the player or out of the picture, and is found only later, high or deep (a lob first seen above the net, a drive first seen past the service line): with no hit and no sensible start such a track is thrown away. The sound track still has the click of the racket. The click says when the flight started, and the player was where he stands: a flight that must leave his racket, about waist high, at that moment and pass through the late track is pinned down almost as well as one seen from the start. A click with no ball going away right after it (the opponent's hit, a bounce, the next court) adds nothing.
  if (clicks && clicks.length && !only) { const sm = meta.sound = { clicks: clicks.length, off: 0, open: 0, tried: 0, kept: 0, log: [] };
    { const d = []; for (const q of shots) if (!q.far && q.hit) { let b = null; for (const c of clicks) if (Math.abs(q.t - c.t) < 0.3 && (b == null || Math.abs(q.t - c.t) < Math.abs(b))) b = q.t - c.t; if (b != null) d.push(b); } // the picture's clock against the sound's: the hits seen in both
      if (d.length >= 5) { d.sort((a, b) => a - b); sm.off = Math.max(-0.2, Math.min(0.2, d[d.length >> 1])); } sm.pairs = d.length; }
    // A "serve" found from a track that starts high (see the near-serve pass above) with no click at its start but a click 0.3 to 1.3 s before is a ball caught late after an ordinary stroke (checked on the match: a forehand at 0:49 read as a 123 km/h serve at 0:50, and serves at 180-207 km/h): it goes, and the click before it gets its turn below.
    const lateOk = new Set(); if (sm.pairs >= 5 && mode !== 'serve') for (let i = shots.length - 1; i >= 0; i--) { const q = shots[i]; if (!q.viaToss) continue; if (!clicks.some(c => Math.abs(c.t + sm.off - q.t) < 4)) { shots.splice(i, 1); sm.silent = (sm.silent || 0) + 1; continue; } /* a serve makes the loudest click of all: a "serve" with no click at all within 4 s is something else (match: 2:31 and 2:50, a man walking, read as serves at 144 and 192 km/h) */ const at = clicks.some(c => c.t + sm.off > q.t - 0.3 && c.t + sm.off < q.t + 0.05), early = clicks.some(c => c.t + sm.off > q.t - 1.3 && c.t + sm.off <= q.t - 0.3); if (!at && early) { shots.splice(i, 1); sm.unserved = (sm.unserved || 0) + 1; for (const c of clicks) if (c.t + sm.off > q.t - 1.3 && c.t + sm.off <= q.t - 0.3) lateOk.add(c); } } // its track may then start up to 1.3 s after that click
    const near0 = shots.filter(q => !q.far), farH = shots.filter(q => q.far && q.tHit != null).map(q => q.tHit), usedR = new Set();
    const backBy = (x, dt) => { const p = x.slice(0, 3), v = x.slice(3, 6), steps = Math.max(1, Math.ceil(dt * 240)), h = -dt / steps; for (let k = 0; k < steps; k++) rk4(p, v, x[6] || 0, h); return [...p, ...v, x[6] || 0]; };
    for (const c of clicks) { const tc = c.t + sm.off; if (near0.some(q => q.t > tc - 0.35 && q.t < tc + 0.6) || farH.some(t => Math.abs(t - tc) < 0.2)) continue; sm.open++;
      // the first track that starts within 0.45 s after the click and goes up the picture (away from the camera)
      let pts = null, ia = -1; for (let a = 0; a < segs.length; a++) { if (usedR.has(a)) continue; const q = segs[a], ta = ts[q[0][0]]; if (ta > tc + (lateOk.has(c) ? 1.3 : 0.45)) break; if (ta < tc + 0.3 * dtF) continue;
        const chain = [q], idx = [a]; for (let b = a + 1; b < segs.length; b++) { if (usedR.has(b)) continue; const r = segs[b], last = chain[chain.length - 1], gap = r[0][0] - last[last.length - 1][0]; if (gap > 6 / fs) break; if (gap < -1) continue;
          const k = Math.min(last.length, 6), sg = last.slice(-k), f = sg.map(p => p[0] - r[0][0]), px = polyval(polyfit(f, sg.map(p => p[1]), 1), 0), py = polyval(polyfit(f, sg.map(p => p[2]), k >= 4 ? 2 : 1), 0);
          if (Math.hypot(px - r[0][1], py - r[0][2]) < (15 + 3 * gap) * s && smoothRms([...last.slice(-5), ...r.slice(0, 5)]) < 3 * s) { chain.push(r); idx.push(b); } }
        const seen = new Set(), P = []; for (const sg of chain) for (const p of sg) if (!seen.has(p[0])) { seen.add(p[0]); P.push(p); } P.sort((u, v) => u[0] - v[0]); if (P.length < 7) continue;
        const k = Math.min(5, P.length), vy = polyfit(P.slice(0, k).map(p => ts[p[0]]), P.slice(0, k).map(p => p[2]), 1)[1], eP = P[P.length - 1]; if (vy > -0.15 * H && !(P[0][2] < cam.tapeY(P[0][1]) && eP[2] < cam.tapeY(eP[1]) + 10 * s)) continue; // going up the picture, or (found late, already coming down towards the far court) staying beyond the net
        pts = P; ia = idx; break; }
      if (!pts) { if (sm.log.length < 300) sm.log.push([+tc.toFixed(2), 'notrack']); continue; } sm.tried++;
      // where the hitter stands: the lowest edge of the biggest moving blob at the moment of the click
      let feet = null; { const i0 = idxAt(tc); for (let i = Math.max(0, i0 - 2); i <= Math.min(frames.length - 1, i0 + 2); i++) for (const b of frames[i].blobs) { const hb = b[3] - b[1]; if (hb < 0.1 * H || hb > 0.8 * H) continue; if (!feet || hb > feet[2]) feet = [(b[0] + b[2]) / 2, b[3], hb]; } }
      const fg = feet ? cam.ground(feet[0], feet[1]) : null, fgOk = fg && fg[1] > -9 && fg[1] < COURT.NET - 2;
      // Better still, the ball he struck: the opponent's shot that came before, carried on past its bounce to the moment of the click, is where the racket met it.
      let meetP = null; { let fq = null; for (const q of shots) if (q.far && q.t < tc - 0.2 && q.tLand && tc - (q.t + q.tLand) < 1.6 && (!fq || q.t > fq.t)) fq = q;
        if (fq) { const P = fq.path, m = P.length, b1 = fq.t + fq.tLand; if (tc < b1) meetP = simulateAt([...fq.p0, ...fq.v0, fq.cl || 0], [tc - fq.t])[0]; else if (m >= 3) { const vx = (P[m - 2][0] - P[m - 3][0]) * 60, vy = (P[m - 2][1] - P[m - 3][1]) * 60, vz = (P[m - 2][2] - P[m - 3][2]) * 60, up = 0.78 * Math.max(1, -vz), d = tc - b1; meetP = [fq.land[0] + 0.7 * vx * d, fq.land[1] + 0.7 * vy * d, RB + up * d - 0.5 * G * d * d]; }
          if (meetP && !(meetP[1] > -8 && meetP[1] < COURT.NET - 1 && meetP[2] > 0.1 && meetP[2] < 3)) meetP = null; } }
      const t = pts.map(p => ts[p[0]] - tc), uv = pts.map(p => [p[1], p[2]]), t1 = t[0], tq = t.map(v => v - t1);
      const free = fitFlight(cam, tq, uv, { z: 1.3, zSd: 3, y: null, clSd, floor: true }, s, true);
      const tossBefore = segs.some(r => { const e = r[r.length - 1], dt = tc - ts[e[0]]; if (dt < -0.05 || dt > 0.6) return false; let u0 = 1e9, u1 = -1e9, w0 = 1e9, w1 = -1e9; for (const p of r) { u0 = Math.min(u0, p[1]); u1 = Math.max(u1, p[1]); w0 = Math.min(w0, p[2]); w1 = Math.max(w1, p[2]); } return w1 - w0 > 25 * s && u1 - u0 < 0.6 * (w1 - w0) && ts[e[0]] - ts[r[0][0]] >= 0.12; });
      const quiet = !shots.some(q => q.far && q.t < tc && q.t > tc - 2.5); // nothing came from the other side just before: the start of a point, a serve is possible
      let best = null; for (const sv of mode === 'serve' ? [true] : tossBefore || quiet ? [false, true] : [false]) { const pr = !sv && meetP ? { z: 1.0, zSd: 0.35, y: meetP[1], ySd: 1.5, xh: meetP[0], xSd: 1.0, clSd, floor: true, met: true } : sv ? { z: 2.6, zSd: 0.3, y: 0.2, ySd: 0.5, clSd, floor: true, serve: true } /* a serve is struck over the baseline */ : { z: 1.0, zSd: 0.35, y: fgOk ? fg[1] + 0.5 : -0.5, ySd: fgOk ? 1.0 : 1.5, clSd, floor: true };
        const warms = []; if (free) warms.push(backBy(free.x, t1)); { const d = cam.ray(uv[0][0], uv[0][1]); for (const dist of [8, 14, 20]) { const P1 = cam.C.map((c0, i) => c0 + dist * d[i]), P0 = [pr.xh != null ? pr.xh : P1[0] * 0.5, pr.y, pr.z]; warms.push([...P0, (P1[0] - P0[0]) / t1, Math.max(4, (P1[1] - P0[1]) / t1), (P1[2] - P0[2] + 0.5 * G * t1 * t1) / t1, 0]); } }
        let b2 = null; for (const w0 of warms) { const f = fitFlight(cam, t, uv, pr, s, true, w0); if (f && (!b2 || f.cost < b2.fit.cost)) b2 = { fit: f, prior: pr, serve: sv }; }
        if (b2 && (!best || b2.fit.cost < best.fit.cost || (sv && b2.fit.rms <= 3 && Math.abs(b2.fit.x[2] - 2.6) < 0.6 && best.fit.x[1] > 2))) best = b2; } // at the start of a point a ball struck from well inside the court is less likely than a serve that fits
      if (!best || best.fit.rms > 3) { (sm.why = sm.why || {}).rms = (sm.why.rms || 0) + 1; if (sm.log.length < 300) sm.log.push([+tc.toFixed(2), 'rms', best ? +best.fit.rms.toFixed(1) : null, pts.length, +t1.toFixed(2)]); continue; } const x = best.fit.x, v0 = Math.hypot(x[3], x[4], x[5]), speed = v0 * 3.6;
      const capS = (sb => sb.length >= 5 ? 1.1 * Math.max(...sb) : 230)(shots.filter(q => q.viaToss && q.bounce).map(q => q.speed)); // the same cap as for serves timed by the click in the serve pass
      if (speed < (best.serve ? 50 : 40) || speed > (best.serve ? capS : 200) || x[4] < 3 || Math.abs(x[2] - best.prior.z) > (best.serve ? 0.6 : 0.7) || Math.abs(x[1] - best.prior.y) > 2.5 * best.prior.ySd || x[1] > 4) { /* slower than 40 km/h: a ball pushed back between points */ (sm.why = sm.why || {}).speed = (sm.why.speed || 0) + 1; if (sm.log.length < 300) sm.log.push([+tc.toFixed(2), 'speed', Math.round(speed), +x[2].toFixed(2), +x[4].toFixed(1)]); continue; }
      const sum = flightSummary(x); if (!sum.land || !sum.net) { (sm.why = sm.why || {}).short = (sm.why.short || 0) + 1; if (sm.log.length < 300) sm.log.push([+tc.toFixed(2), 'short', Math.round(speed)]); continue; } // must reach the net
      const sd = covariance(best.fit, y => { const q = flightSummary(y); return [q.land ? q.land[0] : 0, q.land ? q.land[1] : 0, q.net ? q.net[2] : 0, y[6], 3.6 * Math.hypot(y[3], y[4], y[5])]; }, [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-3]) || [9, 9, 9, 9, 99];
      if (sd[1] > 2.5 || sd[4] > 0.15 * speed) { (sm.why = sm.why || {}).depth = (sm.why.depth || 0) + 1; if (sm.log.length < 300) sm.log.push([+tc.toFixed(2), 'depth', +sd[1].toFixed(1), Math.round(sd[4])]); continue; }
      const C = COURT, [lx, ly] = sum.land, serve = best.serve && x[2] > 2.2; let result, target = null;
      if (Math.abs(lx) > C.D + 2 || ly > C.LEN + 4) { (sm.why = sm.why || {}).wild = (sm.why.wild || 0) + 1; continue; } // a flight placed by its click alone that comes down more than 2 m outside the doubles line or 4 m long has latched on to something else (match 0:07 and serve practice 13:31: serves 'landing' 3.5 m outside the doubles line, the path in the picture running along the tree line)
      if (serve && Math.abs(cam.C[0]) > C.D + 1) { (sm.why = sm.why || {}).sideServe = (sm.why.sideServe || 0) + 1; continue; } // a serve placed only by its click, seen from the side: no bounce to place it (see the serve pass); corner-view lesson: 7 such, 2-4 m long or wide, the one checked wrong
      if (sum.clear < 0) result = 'net'; else if (serve) { const left = x[0] > 0; target = left ? 'left' : 'right'; const inX = left ? (lx >= -C.S && lx <= 0) : (lx >= 0 && lx <= C.S); result = (inX && ly <= C.LEN - C.SV) ? 'in' : (ly > C.LEN - C.SV ? 'long' : 'wide'); }
      else result = (Math.abs(lx) <= C.S && ly <= C.LEN) ? 'in' : (ly > C.LEN ? 'long' : 'wide');
      { const g = geoSd(lx, ly); sd[0] = Math.hypot(sd[0], g[0]); sd[1] = Math.hypot(sd[1], g[1]); }
      let close = false; if (result !== 'net') { const yLim = serve ? C.LEN - C.SV : C.LEN, xs = target ? (target === 'left' ? [-C.S, 0] : [0, C.S]) : [-C.S, C.S]; close = Math.abs(ly - yLim) < sd[1] || xs.some(b => Math.abs(lx - b) < sd[0]); }
      const rpm = spinFromCl(x[6], v0), rpmHi = spinFromCl(x[6] + sd[3], v0), rpmLo = spinFromCl(x[6] - sd[3], v0); for (const i of ia) usedR.add(i); sm.kept++;
      const shot = { t: tc, hit: false, heard: true, met: !!best.prior.met, clickS: c.s, who: 'me', far: false, approx: sd[1] > 1.5 || (!best.prior.met && !fgOk), /* nothing showed where he stood: the depth leans on the usual place of the hit */ bounce: false, n: pts.length, nTotal: pts.length, late: +t1.toFixed(3), rms: best.fit.rms, rmsFlat: null, p0: x.slice(0, 3), v0: x.slice(3, 6), speed, speedSd: sd[4], cl: x[6], clSd: sd[3], rpm, rpmSd: Math.abs(rpmHi - rpmLo) / 2,
        land: [lx, ly], landSd: [sd[0], sd[1]], net: sum.net, clear: sum.clear, clearSd: sd[2], tLand: sum.tLand, result, close, netHit: false, netZ: null, serve, target, feetY: fgOk ? fg[1] : null, path: sum.path, flatPath: flightSummary([...x.slice(0, 6), 0]).path, px: uv };
      shots.push(shot); near0.push(shot); } }
  // ---- for the technique notes (technique.js): where the near player stood at each of his shots and 1.2 s later (the biggest moving blob, by its lowest edge), and for a serve the top of the toss: the highest point of the slow, nearly vertical track that ends just before the hit, taken on the plane of the hit.
  { const playerAt = tt => { const i0 = idxAt(tt); let best = null; for (let i = Math.max(0, i0 - 2); i <= Math.min(frames.length - 1, i0 + 2); i++) for (const b of frames[i].blobs) { const hb = b[3] - b[1]; if (hb < 0.1 * H || hb > 0.8 * H) continue; if (!best || hb > best[2]) best = [(b[0] + b[2]) / 2, b[3], hb]; } if (!best) return null; const g = cam.ground(best[0], best[1]); return g && g[1] > -10 && g[1] < COURT.NET - 1 && Math.abs(g[0]) < 10 ? [+g[0].toFixed(2), +g[1].toFixed(2)] : null; };
    for (const q of shots) { if (q.far) continue; const a = playerAt(q.t), b = playerAt(q.t + 1.2); if (a) q.feet = a; if (b) q.rec = b; if (!q.serve) continue;
      let cp; try { cp = cam.project(q.p0); } catch (e) { continue; } let best = null;
      for (const r of segs) { const e = r[r.length - 1], dt = q.t - ts[e[0]]; if (dt < -0.05 || dt > 0.8 || r.length < 4) continue; let ia = 0, u0 = 1e9, u1 = -1e9, v1 = -1e9; for (let j = 0; j < r.length; j++) { if (r[j][2] < r[ia][2]) ia = j; u0 = Math.min(u0, r[j][1]); u1 = Math.max(u1, r[j][1]); v1 = Math.max(v1, r[j][2]); }
        const A = r[ia], span = v1 - A[2]; if (span < 20 * s || u1 - u0 > 0.6 * span || Math.abs(A[1] - cp[0]) > 150 * s || A[2] > cp[1] + 10 * s) continue; if (!best || ts[A[0]] > best.t) best = { t: ts[A[0]], u: A[1], v: A[2], top: ia > 0 && ia < r.length - 1 }; }
      if (best) { const d = cam.ray(best.u, best.v), k = (q.p0[1] - cam.C[1]) / d[1]; if (k > 0) { const z = cam.C[2] + k * d[2], x = cam.C[0] + k * d[0]; if (z > q.p0[2] - 0.3 && z < 7) q.toss = { z: +z.toFixed(2), x: +x.toFixed(2), dt: +(q.t - best.t).toFixed(3), top: best.top }; } } } }
  // Serve practice reports serves only, and a serve is neither a lob nor a record: whatever comes out slower than 50 or faster than 215 km/h is a fit gone wrong, not a serve.
  if (mode === 'serve') for (let i = shots.length - 1; i >= 0; i--) if (!(shots[i].speed >= 50 && shots[i].speed <= 215)) { shots.splice(i, 1); meta.rej.speed++; }
  // Spin is the most fragile number (doc: compare medians, not single shots). When the fitted lift runs into its limit the spin it implies is beyond anything a racket gives (coach session: 33,771 rpm): shown at the edge of the plausible, 4,500 rpm, with a wide margin, and marked.
  for (const q of shots) if (Math.abs(q.rpm) > 4500) { q.rpmRaw = Math.round(q.rpm); q.rpm = Math.sign(q.rpm) * 4500; q.rpmSd = Math.max(q.rpmSd || 0, 1500); q.spinLoose = true; meta.spinLoose = (meta.spinLoose || 0) + 1; }
  ms.all = Date.now() - T0; meta.ms = ms; shots.sort((a, b) => a.t - b.t); shots.meta = meta; return shots;
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
  // how much of the court drawing lies on something line-like in this frame: on a fixed camera nearly all of it, after a pan or a change of scene very little
  let on = 0; for (const p of all) { const g = 2 * grayAt(img, p[0], p[1]); if (g - grayAt(img, p[0], p[1] - d) - grayAt(img, p[0], p[1] + d) > 14 || g - grayAt(img, p[0] - d, p[1]) - grayAt(img, p[0] + d, p[1]) > 14) on++; } const support = all.length ? on / all.length : 0;
  if (support < 0.75) return { raw: court.raw, lines: court.lines, cal: court.cal, n: Object.keys(court.lines).length, support, shift: [bx, by] }; // not the same view: take nothing from it
  const raw = { ...court.raw }, r = growLines(img, { ...court.lines }, raw, court.cal); return { raw, lines: r.lines, cal: r.cal, n: Object.keys(r.lines).length, support, shift: [bx, by] }; }
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
    const bad = new Uint8Array(bw * bh); for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { let sum = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = by + dy, xx = bx + dx; if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue; sum += cnt[yy * bw + xx]; n++; } if (cnt[by * bw + bx] > 0.3 * B * B || sum > 0.12 * n * B * B) bad[by * bw + bx] = 1; }
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

// Follows the court through a whole video. As long as the lines of the current view are found (allowing for a swaying camera) frames go to one Detector. When they are lost for a moment, or the picture changes abruptly, the court is searched for again in the new picture: a new view gets its own camera and its own stretch of frames.
export class Scanner { constructor(W, H, camP, refPts) { this.W = W; this.H = H; this.cams = [Array.from(camP)]; this.seg = 0; this.lost = 0; this.lastTry = -1e9; this.recal = 0; this.failed = 0; this.maxShift = 0; this.busy = 0; this.dropped = 0; this._new(camP, refPts); }
  _new(camP, refPts) { if (this.det) { this.maxShift = Math.max(this.maxShift, this.det.maxShift); this.busy += this.det.busy; this.dropped += this.det.dropped; } this.det = new Detector(this.W, this.H, new Camera(camP, this.W, this.H), refPts); this.det.strict = true; this.fresh = true; }
  get shift() { return this.det.shift; }
  push(rgba, t) { const f = this.det.push(rgba, t); const bad = !this.det.valid; this.lost = bad ? this.lost + 1 : 0;
    if ((this.lost >= 6 || (f && f.cut)) && t - this.lastTry > (this.wait || 0.7)) { this.lastTry = t; const img = { width: this.W, height: this.H, data: rgba }; let c = null; try { c = autoCourt(img); if (c) { const g = growCourt(img, c); if (g.n > c.n) c = g; } } catch (e) { c = null; }
      if (c && (c.lines.service || c.lines.tapeL || c.lines.tapeR || c.lines.farBaseline)) { this.cams.push(Array.from(c.cal.cam.p)); this.seg = this.cams.length - 1; this.recal++; this.lost = 0; this.wait = 0.7; this._new(c.cal.cam.p, Object.values(c.lines).flat()); return null; } this.failed++; this.wait = Math.min(6, (this.wait || 0.7) * 2); } // no court in sight (close-up, camera being moved): look again less and less often
    if (!f) return null; f.seg = this.seg; if (this.fresh) { f.cut = true; this.fresh = false; } return f; }
  totals() { return { maxShift: Math.max(this.maxShift, this.det.maxShift), busy: this.busy + this.det.busy, dropped: this.dropped + this.det.dropped, recal: this.recal, failed: this.failed }; } }
