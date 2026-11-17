import { analyze, Camera, autoCourt } from './engine.js';
self.onmessage = e => { const { frames, camP, W, H, mode, court } = e.data; let last = 0;
  try {
    if (court) { const r = autoCourt(court); self.postMessage({ court: r ? { raw: r.raw, lines: r.lines, camP: r.cal.cam.p, rms: r.cal.rms, perLine: r.cal.perLine, n: r.n } : null }); return; }
    const shots = analyze(frames, new Camera(camP, W, H), { mode, onProgress: p => { if (p - last > 0.02) { last = p; self.postMessage({ progress: p }); } } }); self.postMessage({ shots, meta: shots.meta }); }
  catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };
