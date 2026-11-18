// Worker: reads the video file, decodes every frame and looks for the ball, so the page itself stays responsive even on hour-long videos.
import { Detector, Camera } from './engine.js'; import { decodeDirect } from './decode.js';
globalThis.__crumb = m => self.postMessage({ crumb: m });
let info = null;
self.onmessage = async e => { if (e.data.ping) { self.postMessage({ pong: info && info.state ? info.state() : 'starting' }); return; } const { file, W, H, duration, camP, refPts } = e.data; info = { W, H, duration }; const det = new Detector(W, H, new Camera(camP, W, H), refPts), frames = []; let k = 0, last = 0, lastP = 0, lastPv = 0;
  try { const count = await decodeDirect(file, info, (im, tm) => { const t0 = performance.now(), f = det.push(im.data, tm); if (f) frames.push(f); k++;
      if (k % 600 === 1) globalThis.__crumb('detect ' + k + ' took ' + Math.round(performance.now() - t0) + 'ms cands ' + (f ? f.c2.length : -1) + ' valid ' + (f ? f.valid : '') + ' shift ' + det.shift + ' busy ' + det.busy);
      const now = performance.now(); if (now - lastPv > 700) { lastPv = now; const copy = im.data.slice().buffer; self.postMessage({ preview: copy, balls: f ? f.c : [] }, [copy]); } },
    p => { if (p - lastP > 0.002 || p >= 1) { lastP = p; self.postMessage({ progress: p, frames: frames.length }); } });
    self.postMessage({ done: true, frames, count, fps: info.fps, maxShift: det.maxShift, busy: det.busy }); }
  catch (err) { self.postMessage({ error: String(err && err.message || err), got: k }); } };
