// Forehand or backhand? Decided from the picture at the moment of the hit: on which side of the hitter's body the ball is.
// No body model: the hitter is cut out by comparing the picture with the same spot at other moments (a median of pictures
// in which he stands elsewhere), the trunk is the dense middle of that cut-out, and the ball's place at the hit comes from
// the fitted flight run backwards to the hitter. Only the player near the camera is big enough in the picture for this;
// shots from the far side are left undecided, and so is every stroke where the picture is not clear.
//
// grab(t) -> Promise<{data, width, height}>: the whole picture at time t (seconds on the player's clock), any size.
// cam: Camera of the analysis (working size W x H). Sets shot.side = 'R' | 'L' | '' (the ball right or left of the body
// as seen from behind the hitter) and shot.sideM (metres between ball and trunk across the court, signed).
const G = 9.81;
const planes = im => { const n = im.width * im.height, d = im.data, a = new Uint8Array(n), b = new Uint8Array(n), c = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const r = d[j], g = d[j + 1], bl = d[j + 2]; const sm = r + g + bl + 30; a[i] = (r + 2 * g + bl) >> 2; b[i] = 128 + 96 * (r - bl) / sm; c[i] = 128 + 96 * (2 * g - r - bl) / sm; } /* a: brightness; b, c: colour with the brightness divided out, so that the same ground in sun and in shade has the same colour */ return { a, b, c, w: im.width, h: im.height }; };
const median = (arr, n) => { for (let i = 1; i < n; i++) { const v = arr[i]; let j = i - 1; while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j--; } arr[j + 1] = v; } return arr[n >> 1]; };
// a camera on a fence or a light tripod sways: before two pictures are compared, find by how many pixels one has slid against the other
const slide = (cur, ref, R = 8) => { const w = cur.w, h = cur.h, A = cur.a, B = ref.a; let best = Infinity, bx = 0, by = 0;
  const cost = (dx, dy, st) => { let c = 0; for (let y = R + 2; y < h - R - 2; y += st) { const o = y * w, q = (y + dy) * w + dx; for (let x = R + 2; x < w - R - 2; x += st) { const d = A[o + x] - B[q + x]; c += d < 0 ? -d : d; } } return c; };
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { const c = cost(dx, dy, 9); if (c < best) { best = c; bx = dx; by = dy; } }
  const cx = bx, cy = by; best = Infinity; for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) { if (Math.abs(dx) > R || Math.abs(dy) > R) continue; const c = cost(dx, dy, 5); if (c < best) { best = c; bx = dx; by = dy; } }
  return [bx, by]; };
// where the ball was `tau` seconds after the start of its track (negative: before), gravity only: over a few tenths of a second drag and spin move it by centimetres
const at = (s, tau) => [s.p0[0] + s.v0[0] * tau, s.p0[1] + s.v0[1] * tau, s.p0[2] + s.v0[2] * tau - 0.5 * G * tau * tau];

// Time of the hit relative to the start of the track, where the ball was then and where the hitter stood.
// The track starts a tenth or two of a second after the hit (the blurred ball next to the racket is not found), and how deep in the court it starts is the one thing a single camera measures badly. What the picture does show well is height: seen from above and behind, a ball flying away climbs the picture fast. So the fitted flight is run backwards until the ball is back down at hitting height (between knee and waist) at the place where the hitter stands.
export function hitMoment(s, cam, yOff = 1.25) { const dir = s.v0[1] >= 0 ? 1 : -1, REACH = 0.5, HIT = 0.7;
  const hasFeet = s.feetY != null && isFinite(s.feetY) && Math.abs(s.p0[1] - s.feetY) < 6, feet = hasFeet ? s.feetY : s.p0[1] - dir * yOff, yHit = feet + dir * REACH;
  let tau = 0; for (let k = 0; k <= 70; k++) { const tt = -k * 0.005, b = at(s, tt), v = cam.project(b)[1], vc = cam.project([b[0], yHit, HIT])[1]; tau = tt; if (v >= vc) break; }
  // Checked on film strips of real strokes: the height rule lands on the hit or up to a tenth of a second after it. Both ends of that span are kept (ball, ballEarly); the picture is taken in between.
  const early = Math.max(-0.45, tau - 0.08), ball = at(s, tau); return { tau, early, look: (tau + early) / 2, ball, ballEarly: at(s, early), feet: [ball[0], feet] }; }

export async function strokeSides(shots, cam, grab, { duration = Infinity, step = 15, yOff = 1.25, onProgress, signal, debug } = {}) {
  if (isFinite(duration)) step = Math.max(2, Math.min(step, duration / 10)); // a short clip: take the other moments closer together
  const list = shots.filter(s => !s.far && !s.serve && s.p0 && s.v0).sort((a, b) => a.t - b.t); if (!list.length) return;
  // pictures already taken, newest kept: the same ones serve several strokes
  const bank = new Map(), KEEP = 60, frame = async t => { const key = Math.round(t * 1000); let p = bank.get(key); if (p !== undefined) { bank.delete(key); bank.set(key, p); return p; } const im = await grab(t); p = im ? planes(im) : null; bank.set(key, p); if (bank.size > KEEP) bank.delete(bank.keys().next().value); return p; };
  // where each stroke's hitter is expected in the picture (working-size pixels): the flight run back to the hit
  const info = list.map(s => { const hm = hitMoment(s, cam, yOff), fx = hm.feet[0], fy = hm.feet[1], c = cam.project([fx, fy, 1]), ppm = Math.abs(cam.project([fx + 0.5, fy, 1])[0] - cam.project([fx - 0.5, fy, 1])[0]); return { hm, tc: Math.max(0, s.t + hm.look), u: c[0], v: c[1], ppm }; });
  for (let i = 0; i < list.length; i++) { const s = list[i], I = info[i], hm = I.hm, tc = I.tc; if (signal && signal.aborted) return; s.side = ''; s.sideM = null;
    try {
      // The same place at other moments. Best are the pictures of other strokes hit from somewhere else: there the hitter is known not to stand here. A player waits at the same spot between points, so pictures taken at fixed times alone can all show him there and the comparison finds nothing.
      const others = []; for (let j = 0; j < list.length; j++) { if (j === i) continue; const J = info[j], dt = Math.abs(J.tc - tc); if (dt < 1 || dt > 240) continue; /* not long before or after: sunlight and shadows creep across the court */ if (Math.abs(J.u - I.u) < 1.6 * (I.ppm + J.ppm) && Math.abs(J.v - I.v) < 1.6 * (I.ppm + J.ppm)) continue; others.push([dt, J.tc]); }
      others.sort((a, b) => a[0] - b[0]); const times = others.filter(q => q[0] <= 90).slice(0, 5).map(q => q[1]); /* close in time: sunlight and shadows creep across the court */
      const g0 = Math.round(tc / step) * step, far = Math.min(4, 1.5 * step), grid = []; for (let j = -6; j <= 6; j++) { const g = g0 + j * step; if (g >= 0.5 && g <= duration - 0.5 && Math.abs(g - tc) >= far) grid.push(g); }
      grid.sort((a, b) => Math.abs(a - tc) - Math.abs(b - tc)); for (const g of grid.slice(0, times.length >= 4 ? 6 : 10)) times.push(g);
      const cur = await frame(tc); if (!cur) continue; let refs = []; const refT = []; for (const tm of times) { const p = await frame(tm); if (p && p.w === cur.w && p.h === cur.h) { refs.push(p); refT.push(Math.abs(tm - tc)); } } if (refs.length < 4) { s.sideWhy = 'refs'; continue; }
      const k = cur.w / cam.W, P = X => { const q = cam.project(X); return [q[0] * k, q[1] * k]; };
      const fx = hm.feet[0], fy = hm.feet[1], ppm = I.ppm * k; if (!(ppm > 22 && I.ppm >= 40)) { s.sideWhy = 'small'; continue; } // too small in the picture to tell trunk from arm
      const top = P([fx, fy, 2.5]), bot = P([fx, fy, -0.2]), x0 = Math.max(0, Math.floor(top[0] - 2.4 * ppm)), x1 = Math.min(cur.w, Math.ceil(top[0] + 2.4 * ppm)), y0 = Math.max(0, Math.floor(Math.min(top[1], bot[1]))), y1 = Math.min(cur.h, Math.ceil(Math.max(top[1], bot[1])));
      const w = x1 - x0, h = y1 - y0; if (w < 20 || h < 20) continue;
      // cut-out: pixels that differ from the median of the other moments, in brightness or in colour
      let n = refs.length, lab, m2, comps, best = null, gain; const ex = P([fx, fy, 1])[0] - x0;
      // Second try when nobody is found: the pictures at fixed times may all show him waiting on this very spot (then the "usual" picture contains him and nothing stands out). Use only moments of other strokes hit from elsewhere, even if further away in time.
      for (let pass = 0; pass < 2 && !best; pass++) { if (pass) { const clean = []; for (const q of others.slice(0, 7)) { const p = await frame(q[1]); if (p && p.w === cur.w && p.h === cur.h) clean.push(p); } if (clean.length < 3) break; refs = clean; n = refs.length; }
      const buf = new Uint8Array(n), off = refs.map(r => { const q = slide(cur, r); return q[1] * cur.w + q[0]; }), N = cur.w * cur.h, bg = new Uint8Array(w * h), dif = new Float32Array(w * h), m = new Uint8Array(w * h);
      // a phone camera keeps adjusting exposure and colour balance: bring every other picture to this one's level over the patch before comparing (the usual difference per plane, which the hitter, a small part of the patch, hardly moves)
      // exposure first: brightness is multiplied
      gain = refs.map((r, ri) => { const hst = new Int32Array(257); let cnt = 0; for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) { const o = (y + y0) * cur.w + x + x0, q = o + off[ri], rv = r.a[q < 0 ? 0 : q >= N ? N - 1 : q]; if (rv < 24 || cur.a[o] < 24) continue; const g = Math.round(64 * cur.a[o] / rv); hst[g > 256 ? 256 : g]++; cnt++; } if (cnt < 50) return 1; let acc = 0; for (let v = 0; v < 257; v++) { acc += hst[v]; if (acc >= cnt / 2) return Math.max(0.5, Math.min(2, v / 64)); } return 1; });
      const adj = (r, ri, pi, q) => { const raw = r['abc'[pi]][q < 0 ? 0 : q >= N ? N - 1 : q]; return pi ? raw : raw * gain[ri]; };
      const lev = refs.map((r, ri) => [0, 1, 2].map(pi => { const pl = 'abc'[pi]; const hst = new Int32Array(511); let cnt = 0; for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) { const o = (y + y0) * cur.w + x + x0, q = o + off[ri]; const dv = Math.round(cur[pl][o] - adj(r, ri, pi, q)); hst[(dv < -255 ? -255 : dv > 255 ? 255 : dv) + 255]++; cnt++; } let acc = 0; for (let v = 0; v < 511; v++) { acc += hst[v]; if (acc >= cnt / 2) return v - 255; } return 0; }));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y + y0) * cur.w + x + x0, q0 = y * w + x; let dY = 0, dC = 0;
        for (let pi = 0; pi < 3; pi++) { const pl = 'abc'[pi]; for (let r = 0; r < n; r++) { const v = adj(refs[r], r, pi, o + off[r]) + lev[r][pi]; buf[r] = v < 0 ? 0 : v > 255 ? 255 : v; } const md = median(buf, n), d = cur[pl][o] - md; if (pl === 'a') { bg[q0] = md; dY = d; } else if (Math.abs(d) > dC) dC = Math.abs(d); }
        // light and shadow change how bright the ground is, not its colour: the hitter's own shadow, tree shadows and sun patches that have moved since are not the hitter
        const light = dC < 7 && cur.a[o] > 0.4 * bg[q0] && cur.a[o] < 2.2 * bg[q0] + 8; dif[q0] = light ? 0 : Math.max(Math.abs(dY), 2.5 * dC); }
      // next to a sharp edge of the background (a court line) half a pixel of sway already makes a difference: ask for more there
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x, gr = Math.max(Math.abs(bg[o + 1] - bg[o - 1]), Math.abs(bg[o + w] - bg[o - w])); if (dif[o] > 24 + 0.6 * gr) m[o] = 1; }
      // close one-pixel gaps, drop thin leftovers (line edges, net cords), then connected pieces
      m2 = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x; if (m[o]) { m2[o] = 1; continue; } let c = 0; if (m[o - 1]) c++; if (m[o + 1]) c++; if (m[o - w]) c++; if (m[o + w]) c++; if (c >= 2) m2[o] = 1; }
      { const er = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x; if (m2[o] && m2[o - 1] && m2[o + 1] && m2[o - w] && m2[o + w]) er[o] = 1; }
        m2.fill(0); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const o = y * w + x; if (er[o] || er[o - 1] || er[o + 1] || er[o - w] || er[o + w]) m2[o] = 1; } }
      lab = new Int32Array(w * h); comps = []; const stack = [];
      for (let q = 0; q < w * h; q++) { if (!m2[q] || lab[q]) continue; const id = comps.length + 1, c = { id, n: 0, x0: w, x1: 0, y0: h, y1: 0 }; lab[q] = id; stack.push(q);
        while (stack.length) { const o = stack.pop(), x = o % w, y = (o / w) | 0; c.n++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const r = yy * w + xx; if (m2[r] && !lab[r]) { lab[r] = id; stack.push(r); } } }
        comps.push(c); }
      // the hitter: a piece the size and shape of a person, close to where the flight says the hit was, and whole (not cut by the edge of the picture at the sides or the top)
      for (const c of comps) { const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1, cutBottom = c.y1 + y0 >= cur.h - 3; if (ch < (cutBottom ? 0.45 : 0.8) * ppm || ch > 2.9 * ppm || cw > 2.4 * ppm || cw > 1.6 * ch || c.n < 0.08 * ppm * ppm || c.n > 1.7 * ppm * ppm || c.n < 0.18 * cw * ch) continue;
        if (c.y0 + y0 <= 2) continue; const dist = Math.max(0, c.x0 - ex, ex - c.x1) / ppm; if (dist > 1.6) continue; const score = c.n / (1 + dist); if (!best || score > best.score) best = { ...c, score }; } }
      if (!best) { s.sideWhy = 'nobody'; if (debug) { let fill = 0; for (let q = 0; q < w * h; q++) fill += m2[q]; debug(s, { cur, x0, y0, w, h, m: m2, lab, ppm, hm, k, none: true, refs: n, hits: others.length, comps: comps.map(c => { const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1; return { n: c.n, cw, ch, x0: c.x0, y0: c.y0, rel: [+(ch / ppm).toFixed(2), +(cw / ppm).toFixed(2), +(c.n / (ppm * ppm)).toFixed(2), +(c.n / (cw * ch)).toFixed(2), +(Math.max(0, c.x0 - ex, ex - c.x1) / ppm).toFixed(2)] }; }).sort((a, b) => b.n - a.n).slice(0, 4), fill: fill / (w * h), gain, ex }); } continue; }
      // trunk: the densest part of the band from the shoulders to the hips (an arm and a racket add little there)
      const pm = Math.min(ppm, (best.y1 - best.y0 + 1) / 1.6); // metres in the picture at the hitter: the flight's depth can be well off, a person's height is not
      const hp = Math.min(best.y1 - best.y0 + 1, 1.9 * ppm), r0 = Math.round(best.y0 + 0.28 * hp), r1 = Math.round(best.y0 + 0.62 * hp), hist = new Float64Array(w); let tot = 0;
      for (let y = r0; y <= r1 && y < h; y++) for (let x = best.x0; x <= best.x1; x++) if (lab[y * w + x] === best.id) { hist[x]++; tot++; }
      if (tot < 0.03 * pm * pm) { s.sideWhy = 'thin'; continue; }
      const wmed = (a, b) => { let t2 = 0; for (let x = a; x <= b; x++) t2 += hist[x]; let acc = 0; for (let x = a; x <= b; x++) { acc += hist[x]; if (acc >= t2 / 2) return x; } return (a + b) >> 1; };
      let tx = wmed(best.x0, best.x1); tx = wmed(Math.max(best.x0, Math.round(tx - 0.35 * pm)), Math.min(best.x1, Math.round(tx + 0.35 * pm)));
      const cutL = tx + x0 - 0.3 * pm <= 2, cutR = tx + x0 + 0.3 * pm >= cur.w - 3; // the trunk runs out of the picture on that side: its true middle is further out than what is seen
      // A camera straight behind the hitter sees "beside the body" as left and right in the picture. A camera at a corner looks across the court: there a ball met in front of the body (as every stroke is, by about half a metre) also shows to one side. Take that share out and scale back to metres across the court.
      const vx = fx - cam.C[0], vy = fy - cam.C[1], vn = Math.hypot(vx, vy) || 1, sin = vx / vn, cos = vy / vn, across = b3 => cos > 0.5 ? ((P(b3)[0] - x0 - tx) / pm + 0.5 * sin) / cos : 0;
      // Where was the ball when it was hit? Not a question of time (the track starts a tenth or two of a second late and the hit's moment is not known that well) but of place: the ball's path in the picture, run backwards, is followed down to the rows of the hitter's own body, between shoulder and knee, where a stroke is met. Three rows are read: the middle one decides, and neither of the others may put the ball clearly on the opposite side.
      const cutBottom = best.y1 + y0 >= cur.h - 3, bodyH = cutBottom ? 1.75 * ppm : hp, rowAt = f => { const vr = best.y0 + f * bodyH; let b3 = at(s, 0); for (let q = 0; q <= 90; q++) { b3 = at(s, -q * 0.005); if (P(b3)[1] - y0 >= vr) break; } return b3; };
      const bHi = rowAt(0.30), bMid = rowAt(0.50), bLo = rowAt(0.70), dHi = across(bHi), dM = across(bMid), dLo = across(bLo), sg = dM > 0 ? 1 : -1, bu = P(bMid)[0] - x0, against = Math.min(sg * dHi, sg * dLo);
      s.sideM = +dM.toFixed(2); s.sideD = [+dHi.toFixed(2), +dM.toFixed(2), +dLo.toFixed(2)];
      s.side = Math.abs(dM) >= 0.22 && Math.abs(dM) < 3.5 && against > -0.25 ? (dM > 0 ? 'R' : 'L') : ''; if (!s.side) s.sideWhy = Math.abs(dM) < 0.22 ? 'close' : Math.abs(dM) >= 3.5 ? 'far' : 'crosses';
      if (s.side && ((cutL && s.side === 'L') || (cutR && s.side === 'R'))) { s.side = ''; s.sideWhy = 'edge'; } // cut off on the side the ball seems to be on: cannot tell. On the other side the answer only gets safer.
      if (debug) debug(s, { cur, x0, y0, w, h, m: m2, lab, best, tx, bu, bv: P(bMid)[1] - y0, ppm, pm, hm, k, r0, r1, refs: n, hits: others.length });
    } catch (e) { if (debug) console.error(e); }
    finally { if (onProgress) onProgress((i + 1) / list.length); } }
}
// forehand or backhand from the side of the body, for a player seen from behind: a right-hander's forehand is on the right
export const strokeName = (s, leftHanded) => s.serve ? 'serve' : !s.side ? '' : ((s.side === 'R') !== !!leftHanded ? 'fh' : 'bh');
