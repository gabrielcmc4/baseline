import { analyze, Camera } from './engine.js';
self.onmessage = e => { const { frames, camP, W, H, mode } = e.data; let last = 0;
  try { const shots = analyze(frames, new Camera(camP, W, H), { mode, onProgress: p => { if (p - last > 0.02) { last = p; self.postMessage({ progress: p }); } } }); self.postMessage({ shots, meta: shots.meta }); }
  catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };
