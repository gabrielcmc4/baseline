// Forehand or backhand? Decided from the picture at the moment of the hit: on which side of the hitter's body the ball is.
// No body model: the hitter is cut out by comparing the picture with the same spot at other moments (a median of pictures
// taken before and after, in which the player stands elsewhere), the trunk is the dense middle of that cut-out, and the
// ball's place at the hit comes from the fitted flight run backwards to the hitter. Only the player near the camera is
// big enough in the picture for this; shots from the far side are left undecided.
//
// grab(t) -> Promise<{data, width, height}>: the whole picture at time t (seconds on the player's clock), any size.
// cam: Camera of the analysis (working size W x H). Returns nothing; sets shot.side = 'R' | 'L' | '' (the ball right or
// left of the body as the camera sees it) and shot.sideM (metres between ball and trunk, signed).
const G = 9.81;
const planes = im => { const n = im.width * im.height, d = im.data, a = new Uint8Array(n), b = new Uint8Array(n), c = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const r = d[j], g = d[j + 1], bl = d[j + 2]; a[i] = (r + 2 * g + bl) >> 2; b[i] = ((r - bl) >> 1) + 128; c[i] = ((2 * g - r - bl) >> 2) + 128; } return { a, b, c, w: im.width, h: im.height }; };
const median = (arr, n) => { for (let i = 1; i < n; i++) { const v = arr[i]; let j = i - 1; while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j--; } arr[j + 1] = v; } return arr[n >> 1]; };

// a camera on a fence or a light tripod sways: before two pictures are compared, find by how many pixels one has slid against the other
const slide = (cur, ref, R = 8) => { const w = cur.w, h = cur.h, A = cur.a, B = ref.a; let best = Infinity, bx = 0, by = 0;
  const cost = (dx, dy, st) => { let c = 0; for (let y = R + 2; y < h - R - 2; y += st) { const o = y * w, q = (y + dy) * w + dx; for (let x = R + 2; x < w - R - 2; x += st) { const d = A[o + x] - B[q + x]; c += d < 0 ? -d : d; } } return c; };
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { const c = cost(dx, dy, 9); if (c < best) { best = c; bx = dx; by = dy; } }
  const cx = bx, cy = by; best = Infinity; for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) { if (Math.abs(dx) > R || Math.abs(dy) > R) continue; const c = cost(dx, dy, 5); if (c < best) { best = c; bx = dx; by = dy; } }
  return [bx, by]; };
// where the ball was `tau` seconds after the start of its track (negative: before), gravity only: over a few tenths of a second drag and spin move it by centimetres
const at = (s, tau) => [s.p0[0] + s.v0[0] * tau, s.p0[1] + s.v0[1] * tau, s.p0[2] + s.v0[2] * tau - 0.5 * G * tau * tau];

export function hitMoment(s, yOff = 1.25) { // time of the hit relative to the start of the track, and where the ball and the hitter were
  const dir = s.v0[1] >= 0 ? 1 : -1, vy = Math.max(3, Math.abs(s.v0[1]));
  const feet = s.feetY != null && isFinite(s.feetY) && Math.abs(s.p0[1] - s.feetY) < 4 ? s.feetY : s.p0[1] - dir * yOff; // the hitter's feet along the court
  let tau = (feet + dir * 0.4 - s.p0[1]) / (dir * vy); tau = Math.max(-0.4, Math.min(0, tau)); // the ball is met about 0.4 m in front of the feet
  const ball = at(s, tau); return { tau, ball, feet: [ball[0], feet] }; }

export async function strokeSides(shots, cam, grab, { duration = Infinity, step = 15, yOff = 1.25, onProgress, signal, debug } = {}) {
  const bank = new Map(), list = shots.filter(s => !s.far && !s.serve && s.p0 && s.v0).sort((a, b) => a.t - b.t); let done = 0;
  const frame = async t => { const key = Math.round(t * 1000); if (bank.has(key)) return bank.get(key); const im = await grab(t); const p = im ? planes(im) : null; bank.set(key, p); return p; };
  for (const s of list) { if (signal && signal.aborted) return; s.side = ''; s.sideM = null;
    try { const hm = hitMoment(s, yOff), tc = Math.max(0, s.t + hm.tau);
      // pictures of the same place at other moments: every `step` seconds around the shot, none closer than 4 s
      const g0 = Math.round(tc / step) * step, times = []; for (let j = -5; j <= 5; j++) { const g = g0 + j * step; if (g >= 0.5 && g <= duration - 0.5 && Math.abs(g - tc) >= 4) times.push(g); }
      for (const k of [...bank.keys()]) if (k / 1000 < g0 - 6 * step) bank.delete(k); // shots come in time order: older pictures are not needed again
      const cur = planes(await grab(tc)), refs = (await Promise.all(times.map(frame))).filter(p => p && p.w === cur.w && p.h === cur.h); if (refs.length < 4) { done++; continue; }
      const k = cur.w / cam.W, P = X => { const q = cam.project(X); return [q[0] * k, q[1] * k]; };
      const fx = hm.feet[0], fy = hm.feet[1], ppm = Math.abs(P([fx + 0.5, fy, 1])[0] - P([fx - 0.5, fy, 1])[0]); if (!(ppm > 12)) { done++; continue; } // too small in the picture to tell trunk from arm
      const top = P([fx, fy, 2.5]), bot = P([fx, fy, -0.2]), x0 = Math.max(0, Math.floor(top[0] - 2.4 * ppm)), x1 = Math.min(cur.w, Math.ceil(top[0] + 2.4 * ppm)), y0 = Math.max(0, Math.floor(Math.min(top[1], bot[1]))), y1 = Math.min(cur.h, Math.ceil(Math.max(top[1], bot[1])));
      const w = x1 - x0, h = y1 - y0; if (w < 20 || h < 20) { done++; continue; }
      // cut-out: pixels that differ from the median of the other moments, in brightness or in colour
      const m = new Uint8Array(w * h), buf = new Uint8Array(refs.length), n = refs.length, sl = refs.map(r => slide(cur, r)), off = sl.map(q => q[1] * cur.w + q[0]), bg = new Uint8Array(w * h), dif = new Float32Array(w * h), N = cur.w * cur.h;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y + y0) * cur.w + x + x0; let dmax = 0;
        for (const pl of ['a', 'b', 'c']) { for (let i = 0; i < n; i++) { const q = o + off[i]; buf[i] = refs[i][pl][q < 0 ? 0 : q >= N ? N - 1 : q]; } const md = median(buf, n); if (pl === 'a') bg[y * w + x] = md; const d = Math.abs(cur[pl][o] - md) * (pl === 'a' ? 1 : 2.5); if (d > dmax) dmax = d; }
        dif[y * w + x] = dmax; }
      // next to a sharp edge of the background (a court line) half a pixel of sway already makes a difference: ask for more there
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x, gr = Math.max(Math.abs(bg[o + 1] - bg[o - 1]), Math.abs(bg[o + w] - bg[o - w])); if (dif[o] > 24 + 0.6 * gr) m[o] = 1; }
      // close one-pixel gaps, then connected pieces
      const m2 = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x; if (m[o]) { m2[o] = 1; continue; } let c = 0; if (m[o - 1]) c++; if (m[o + 1]) c++; if (m[o - w]) c++; if (m[o + w]) c++; if (c >= 2) m2[o] = 1; }
      { const er = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x; if (m2[o] && m2[o - 1] && m2[o + 1] && m2[o - w] && m2[o + w]) er[o] = 1; }
        m2.fill(0); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x; if (er[o] || er[o - 1] || er[o + 1] || er[o - w] || er[o + w]) m2[o] = 1; } } // thin leftovers (line edges, net cords) go; a body stays
      const lab = new Int32Array(w * h), comps = [], stack = [];
      for (let i = 0; i < w * h; i++) { if (!m2[i] || lab[i]) continue; const id = comps.length + 1, c = { id, n: 0, x0: w, x1: 0, y0: h, y1: 0 }; lab[i] = id; stack.push(i);
        while (stack.length) { const o = stack.pop(), x = o % w, y = (o / w) | 0; c.n++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const q = yy * w + xx; if (m2[q] && !lab[q]) { lab[q] = id; stack.push(q); } } }
        comps.push(c); }
      // the hitter: a piece about as tall as a person, close to where the flight says the hit was
      const ex = P([fx, fy, 1])[0] - x0; let best = null;
      for (const c of comps) { const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1; if (ch < 0.45 * ppm || ch > 2.9 * ppm || c.n < 0.04 * ppm * ppm || cw > 1.6 * ch || c.n < 0.18 * cw * ch) continue; const dist = Math.max(0, c.x0 - ex, ex - c.x1) / ppm; if (dist > 1.6) continue; const score = c.n / (1 + dist); if (!best || score > best.score) best = { ...c, score }; }
      if (!best) { done++; if (debug) debug(s, { cur, x0, y0, w, h, m: m2, ppm, hm, k, none: true, comps: comps.filter(c => c.n > 30).map(c => ({ n: c.n, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1, x0: c.x0, x1: c.x1 })), ex }); continue; }
      // trunk: the densest part of the band from the shoulders to the hips (an arm and a racket add little there)
      const pm = Math.min(ppm, (best.y1 - best.y0 + 1) / 1.6); // metres in the picture at the hitter: the flight's depth can be well off, a person's height is not
      const hp = Math.min(best.y1 - best.y0 + 1, 1.9 * ppm), r0 = Math.round(best.y0 + 0.28 * hp), r1 = Math.round(best.y0 + 0.62 * hp), hist = new Float64Array(w); let tot = 0;
      for (let y = r0; y <= r1 && y < h; y++) for (let x = best.x0; x <= best.x1; x++) if (lab[y * w + x] === best.id) { hist[x]++; tot++; }
      if (tot < 0.03 * pm * pm) { done++; continue; }
      const wmed = (a, b) => { let t2 = 0; for (let x = a; x <= b; x++) t2 += hist[x]; let acc = 0; for (let x = a; x <= b; x++) { acc += hist[x]; if (acc >= t2 / 2) return x; } return (a + b) >> 1; };
      let tx = wmed(best.x0, best.x1); tx = wmed(Math.max(best.x0, Math.round(tx - 0.35 * pm)), Math.min(best.x1, Math.round(tx + 0.35 * pm)));
      const bu = P(hm.ball)[0] - x0, dI = (bu - tx) / pm;
      // A camera straight behind the hitter sees "beside the body" as left and right in the picture. A camera at a corner looks across the court: there a ball met in front of the body (as every stroke is, by about half a metre) also shows to one side. Take that share out and scale back to metres across the court.
      const vx = fx - cam.C[0], vy = fy - cam.C[1], vn = Math.hypot(vx, vy) || 1, sin = vx / vn, cos = vy / vn, dM = cos > 0.5 ? (dI + 0.5 * sin) / cos : 0;
      s.sideM = +dM.toFixed(2); s.side = Math.abs(dM) >= 0.22 && Math.abs(dM) < 2.2 ? (dM > 0 ? 'R' : 'L') : '';
      if (debug) debug(s, { cur, x0, y0, w, h, m: m2, lab, best, tx, bu, bv: P(hm.ball)[1] - y0, ppm, hm, k, r0, r1 });
    } catch (e) { if (debug) console.error(e); }
    done++; if (onProgress) onProgress(done / list.length); }
}
// forehand or backhand from the side of the body, for a player seen from behind: a right-hander's forehand is on the right
export const strokeName = (s, leftHanded) => s.serve ? 'serve' : !s.side ? '' : ((s.side === 'R') !== !!leftHanded ? 'fh' : 'bh');
