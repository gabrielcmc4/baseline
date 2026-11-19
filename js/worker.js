import { analyze, Camera, autoCourt, growCourt, calibrate } from './engine.js';
self.onmessage = e => { const { frames, camP, W, H, mode, court } = e.data; let last = 0;
  try {
    if (e.data.grow) { const g = e.data.grow, c0 = { raw: g.raw, lines: g.lines, cal: { cam: new Camera(g.camP, court.width, court.height), rms: g.rms, perLine: g.perLine } }, r = growCourt(court, c0); self.postMessage({ court: { raw: r.raw, lines: r.lines, camP: r.cal.cam.p, rms: r.cal.rms, perLine: r.cal.perLine, n: r.n, support: r.support } }); return; }
    if (court) { const r = autoCourt(court); self.postMessage({ court: r ? { raw: r.raw, lines: r.lines, camP: r.cal.cam.p, rms: r.cal.rms, perLine: r.cal.perLine, n: r.n } : null }); return; }
    const shots = analyze(frames, new Camera(camP, W, H), { mode, onProgress: p => { if (p - last > 0.02) { last = p; self.postMessage({ progress: p }); } } }); self.postMessage({ shots, meta: shots.meta }); }
  catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };
