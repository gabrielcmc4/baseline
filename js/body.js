// Body movement around each of the player's own shots, for the technique notes (phase 2). A small pose model (MediaPipe Pose lite,
// vendor/pose, run in the browser) is shown the full-size picture cut around the player, a few times a second from just before the
// shot to just after, and gives 33 body points per picture, also in metres around the hips. From those come a handful of numbers
// coaches care about: how far the shoulders had turned by the bounce of the incoming ball (the "unit turn"), the deepest knee bend
// before the hit, and whether the racket hand finished above the shoulder. Tested on a lesson video: the player was found in every
// picture when the picture is cut around him (one in five on the whole picture).
const SH_L = 11, SH_R = 12, EL_R = 14, WR_L = 15, WR_R = 16, HIP_L = 23, HIP_R = 24, KN_L = 25, KN_R = 26, AN_L = 27, AN_R = 28, NOSE = 0;
let P = null;
export async function loadPose() { if (P) return P;
  if (!window.Pose) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('../vendor/pose/pose.js', import.meta.url).href; s.onload = res; s.onerror = () => rej(new Error('pose script')); document.head.appendChild(s); });
  const pose = new window.Pose({ locateFile: f => new URL('../vendor/pose/' + f, import.meta.url).href });
  pose.setOptions({ modelComplexity: 0, smoothLandmarks: false, enableSegmentation: false, minDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
  let cb = null; pose.onResults(r => { const c = cb; cb = null; if (c) c(r); }); await pose.initialize();
  P = { pose, send: img => new Promise((res, rej) => { cb = res; pose.send({ image: img }).catch(rej); }), reset: () => { try { pose.reset(); } catch (e) {} } }; return P; }

const ang3 = (a, b, c) => { const u = [a.x - b.x, a.y - b.y, a.z - b.z], v = [c.x - b.x, c.y - b.y, c.z - b.z], d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2], n = Math.hypot(...u) * Math.hypot(...v); return n > 0 ? Math.acos(Math.max(-1, Math.min(1, d / n))) * 180 / Math.PI : null; };
const vis = (L, ...i) => i.every(k => L[k] && (L[k].visibility == null || L[k].visibility > 0.5));
// one picture -> the numbers of that moment (null where the points were not seen)
function moment(r) { const W = r.poseWorldLandmarks, L = r.poseLandmarks; if (!W || !L) return null; const m = {};
  if (vis(W, SH_L, SH_R)) { const dx = W[SH_R].x - W[SH_L].x, dz = W[SH_R].z - W[SH_L].z; m.turn = Math.atan2(Math.abs(dz), Math.abs(dx)) * 180 / Math.PI; } // 0: shoulders square to the camera (seen from behind: square to the net), 90: fully side-on
  const kn = []; if (vis(W, HIP_L, KN_L, AN_L)) kn.push(ang3(W[HIP_L], W[KN_L], W[AN_L])); if (vis(W, HIP_R, KN_R, AN_R)) kn.push(ang3(W[HIP_R], W[KN_R], W[AN_R])); if (kn.length) m.knee = Math.min(...kn); // 180: straight leg
  if (vis(L, SH_L, SH_R, AN_L, AN_R)) { const sy = (L[SH_L].y + L[SH_R].y) / 2, len = (L[AN_L].y + L[AN_R].y) / 2 - sy; if (len > 0.05) { const w = [WR_R, WR_L].filter(k => vis(L, k)).map(k => (sy - L[k].y) / len); if (w.length) m.hand = Math.max(...w); // racket hand above the shoulders, in body lengths (positive: above)
      if (vis(L, NOSE, WR_R)) m.reach = (L[NOSE].y - L[WR_R].y) / len; } } // serve: how far the hitting hand is above the head
  if (vis(W, SH_R, EL_R, WR_R)) m.elbow = ang3(W[SH_R], W[EL_R], W[WR_R]);
  if (vis(L, SH_L, SH_R, HIP_L, HIP_R)) { const w = [WR_R, WR_L].filter(k => vis(L, k)); const sw = Math.abs(L[SH_R].x - L[SH_L].x) + 0.25 * Math.abs((L[HIP_L].y + L[HIP_R].y) / 2 - (L[SH_L].y + L[SH_R].y) / 2); if (w.length && sw > 0) m.side = (w.reduce((a, k) => a + L[k].x, 0) / w.length - (L[HIP_L].x + L[HIP_R].x) / 2) / sw; } // where the hands are, across the body (seen from behind: positive = the player's right)
  return m; }
// shots: the player's own shots (q.t on the player's clock, q.feet where he stood, q.tb the bounce of the ball he played, if known).
// cam: the analysis camera (work size wW x wH); rd: runReader on the full-size picture. Sets q.body = { n, turnB, turnMax, turnC, knee, fin, reach, elbow }.
export async function bodyMoves(shots, cam, rd, { wW, wH, onProgress, signal } = {}) { const p = await loadPose(), k = rd.W / wW, cv = document.createElement('canvas'), cx = cv.getContext('2d');
  for (let i = 0; i < shots.length; i++) { if (signal && signal.aborted) return; const q = shots[i]; if (onProgress) onProgress(i / shots.length);
    const fx = q.feet ? q.feet[0] : q.p0[0], fy = q.feet ? q.feet[1] : Math.min(q.p0[1], 0) - 0.5; let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const P3 of [[fx - 1.6, fy - 1, 0], [fx + 1.6, fy - 1, 0], [fx - 1.6, fy + 1, 0], [fx + 1.6, fy + 1, 0], [fx - 1.2, fy, 2.5], [fx + 1.2, fy, 2.5], [fx, fy, q.serve ? 3.2 : 2.4]]) { try { const z = cam.project(P3); u0 = Math.min(u0, z[0]); u1 = Math.max(u1, z[0]); v0 = Math.min(v0, z[1]); v1 = Math.max(v1, z[1]); } catch (e) {} }
    if (!(u1 > u0 && v1 > v0)) continue; const side = Math.max(u1 - u0, v1 - v0) * k, ccx = (u0 + u1) / 2 * k, ccy = (v0 + v1) / 2 * k, S2 = Math.min(Math.round(side), rd.W, rd.H), x = Math.round(Math.max(0, Math.min(rd.W - S2, ccx - S2 / 2))), y = Math.round(Math.max(0, Math.min(rd.H - S2, ccy - S2 / 2)));
    const t0 = q.t - (q.serve ? 1.1 : 0.8), t1 = q.t + 0.5; let fr; try { fr = await rd.run(t0, t1, { x, y, w: S2, h: S2 }); } catch (e) { continue; }
    const step = Math.max(1, Math.round(fr.length / (t1 - t0) / 15)); cv.width = S2; cv.height = S2; p.reset(); const M = [];
    for (let j = 0; j < fr.length; j += step) { if (signal && signal.aborted) return; cx.putImageData(new ImageData(new Uint8ClampedArray(fr[j].data.buffer, fr[j].data.byteOffset, fr[j].data.byteLength), S2, S2), 0, 0); let r; try { r = await p.send(cv); } catch (e) { r = null; } const m = r && moment(r); if (m) M.push({ dt: fr[j].t - q.t, ...m }); }
    const sel = (a, b, key) => M.filter(m => m.dt >= a && m.dt <= b && m[key] != null).map(m => m[key]), near = (tt, key) => { let b = null; for (const m of M) if (m[key] != null && (!b || Math.abs(m.dt - tt) < Math.abs(b.dt - tt))) b = m; return b && Math.abs(b.dt - tt) < 0.12 ? b[key] : null; };
    const tb = q.tb != null && q.tb - q.t > -0.9 && q.tb - q.t < -0.1 ? q.tb - q.t : -0.45, mx = a => a.length ? Math.max(...a) : null, mn = a => a.length ? Math.min(...a) : null, r1 = v => v == null ? null : Math.round(v * 100) / 100;
    q.body = { n: M.length, turnB: r1(near(tb, 'turn')), turnMax: r1(mx(sel(-0.8, -0.1, 'turn'))), turnC: r1(near(0, 'turn')), knee: r1(mn(sel(q.serve ? -1.1 : -0.8, 0, 'knee'))), fin: r1(mx(sel(0.25, 0.5, 'hand'))), reach: q.serve ? r1(near(0, 'reach')) : null, elbow: q.serve ? r1(near(0, 'elbow')) : null, side: r1((a => a.length ? a.reduce((p, v) => p + v, 0) / a.length : null)(sel(-0.12, 0.05, 'side'))) }; }
  if (onProgress) onProgress(1); }
