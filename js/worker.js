import { analyze, Camera, autoCourt, growCourt, calibrate, wantsTwoPasses } from './engine.js';
self.onmessage = async e => { const { frames, camP, W, H, mode, court, noFar, dbgT, clicks } = e.data; let last = 0;
  try {
    if (e.data.grow) { const g = e.data.grow, c0 = { raw: g.raw, lines: g.lines, cal: { cam: new Camera(g.camP, court.width, court.height), rms: g.rms, perLine: g.perLine } }, r = growCourt(court, c0); self.postMessage({ court: { raw: r.raw, lines: r.lines, camP: r.cal.cam.p, rms: r.cal.rms, perLine: r.cal.perLine, n: r.n, support: r.support } }); return; }
    if (court) { const r = autoCourt(court); self.postMessage({ court: r ? { raw: r.raw, lines: r.lines, camP: r.cal.cam.p, rms: r.cal.rms, perLine: r.cal.perLine, n: r.n } : null }); return; }
    const cam = new Camera(camP, W, H), base = { mode, noFar, dbgT, clicks };
    if (e.data.passOnly) { const r = analyze(frames, cam, { ...base, passOnly: e.data.passOnly }); self.postMessage({ pass: r ? { shots: [...r], meta: r.meta } : null }); return; } // second worker: one colour pass only
    const onProgress = p => { if (p - last > 0.02) { last = p; self.postMessage({ progress: p }); } }; let shots;
    // The second colour pass runs in its own worker, at the same time as the first here; if that worker cannot be made or fails, the second pass is done here afterwards, as before.
    const split = !e.data.noSplit && typeof Worker !== 'undefined' && wantsTwoPasses(frames);
    if (split) { const pb = new Promise(res => { let w; try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (err) { res(null); return; } w.onmessage = ev => { if ('pass' in ev.data || ev.data.error) { w.terminate(); res(ev.data.pass || null); } }; w.onerror = () => { w.terminate(); res(null); }; w.postMessage({ frames, camP, W, H, mode, noFar, dbgT, clicks, passOnly: 'b' }); });
      const a = analyze(frames, cam, { ...base, passOnly: 'a', onProgress: p => onProgress(0.9 * p) }), b = await pb; const back = r => { if (!r) return null; const x = r.shots; x.meta = r.meta; return x; };
      shots = analyze(frames, cam, { ...base, passA: a, passB: back(b), onProgress: p => onProgress(0.9 + 0.1 * p) }); }
    else shots = analyze(frames, cam, { ...base, onProgress }); if (shots.length && shots.meta && (shots.meta.dbgS || shots.meta.dbgF)) shots[0]._dbg = { S: shots.meta.dbgS, F: shots.meta.dbgF, cam: Array.from(camP) }; if (shots.length && shots.meta) shots[0]._m = { yOff: shots.meta.yOff, yOffB: shots.meta.yOffB, yOffNet: shots.meta.yOffNet, netRefs: shots.meta.netRefs, fall: shots.meta.netfall, pass: shots.meta.netpass, followed: shots.meta.followed, farBounce: shots.meta.farBounce, rej: shots.meta.rej }; self.postMessage({ shots, meta: shots.meta }); }
  catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };
