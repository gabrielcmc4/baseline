// Worker: reads (its share of) the video file, decodes the frames and looks for the ball, so the page itself stays responsive even on hour-long videos.
import { Detector, Camera, initFast } from './engine.js'; import { decodeDirect } from './decode.js';
let info = null, part = 0;
globalThis.__crumb = m => { if (part === 0 || /error|stalled|failed/.test(m)) self.postMessage({ crumb: (part ? 'part ' + part + ': ' : '') + m }); };
self.onmessage = async e => { if (e.data.ping) { self.postMessage({ pong: info && info.state ? info.state() : 'starting' }); return; } const { file, W, H, duration, camP, refPts, range, skipIdle } = e.data; part = range ? range.part : 0; info = { W, H, duration };
  const fast = e.data.noFast ? false : await initFast(new URL('../wasm/fast.wasm', import.meta.url)); globalThis.__crumb('fast loops ' + (fast ? 'on' : 'off'));
  const det = new Detector(W, H, new Camera(camP, W, H), refPts), frames = [], s = Math.max(0.8, Math.sqrt(W * H / (720 * 1280))); let k = 0, lastP = 0, lastPv = 0;
  // Dead time (picking up balls, talking, changing ends): while nothing ball-like is moving only every 4th frame is looked at; as soon as something moves steadily through three looks, every frame is used again until 2.5 s after the last such movement.
  let idle = false, lastMove = -1e9, prev1 = null, prev2 = null, skipped = 0, n = 0, wake = false;
  const moving = c => { if (!prev1 || !prev2 || c.length > 10 || prev1.length > 10 || prev2.length > 10) return false; for (const q of c) for (const r of prev1) { const dx = q[0] - r[0], dy = q[1] - r[1], d = Math.hypot(dx, dy); if (d < 2.5 * s || d > 400 * s) continue; for (const u of prev2) { const ex = r[0] - u[0], ey = r[1] - u[1], e2 = Math.hypot(ex, ey); if (e2 < 2.5 * s) continue; if (Math.abs(d - e2) < 0.5 * Math.max(d, e2) && dx * ex + dy * ey > 0.8 * d * e2) return true; } } return false; };
  try { const count = await decodeDirect(file, info, (im, tm) => { n++; if (skipIdle && idle && n % 4 !== 0) { skipped++; return; } const t0 = performance.now(), f = det.push(im.data, tm); k++;
      if (f) { if (wake) { f.cut = true; wake = false; } frames.push(f); if (f.valid && moving(f.c2)) lastMove = f.t; prev2 = prev1; prev1 = f.valid ? f.c2 : null; const was = idle; idle = f.t - lastMove > 2.5 && frames.length > 30; if (was && !idle) wake = true; }
      if (k % 600 === 1) globalThis.__crumb('detect ' + k + ' took ' + Math.round(performance.now() - t0) + 'ms cands ' + (f ? f.c2.length : -1) + ' valid ' + (f ? f.valid : '') + ' shift ' + det.shift + ' skipped ' + skipped + ' idle ' + idle);
      const now = performance.now(); if (now - lastPv > 700) { lastPv = now; const copy = im.data.slice().buffer; self.postMessage({ preview: copy, balls: f ? f.c : [], part }, [copy]); } },
    p => { if (p - lastP > 0.002 || p >= 1) { lastP = p; self.postMessage({ progress: p, part }); } }, null, range);
    if (range && range.part > 0 && frames.length) frames[0].cut = true; // a ball track must not run on from the previous share
    self.postMessage({ done: true, part, frames, count, skipped, fps: info.fps, maxShift: det.maxShift, busy: det.busy }); }
  catch (err) { self.postMessage({ error: String(err && err.message || err), got: k, part }); } };
