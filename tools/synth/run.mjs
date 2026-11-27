// Runs Baseline's own pipeline (js/engine.js: court finding, ball detector, flight fitting) on a video
globalThis.__crumb = globalThis.__crumb || (() => {});
// outside the browser, with ffmpeg decoding the pictures, and compares the shots with the answer key
// written by render.py. Usage: node run.mjs video.mp4 [mode] [--json out.json]
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { autoCourt, growCourt, Camera, Detector, analyze, COURT, initFast } from '../../js/engine.js';
const fast = await initFast(readFileSync(new URL('../../wasm/fast.wasm', import.meta.url)));

const args = process.argv.slice(2), video = args[0], mode = args[1] && !args[1].startsWith('--') ? args[1] : 'match';
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', video]).toString()).streams[0];
const [fn, fd] = probe.r_frame_rate.split('/').map(Number), fps = fn / fd;
const sc = Math.min(1, 1600 / Math.max(probe.width, probe.height)), W = Math.round(probe.width * sc / 2) * 2, H = Math.round(probe.height * sc / 2) * 2;

function frames(cb) { // every picture as RGBA at W x H
  return new Promise((res, rej) => { const p = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const size = W * H * 4; let fr = new Uint8ClampedArray(size), fill = 0, k = 0, stop = false;
    p.stdout.on('data', d => { if (stop) return; let o = 0; while (o < d.length) { const n = Math.min(size - fill, d.length - o); fr.set(d.subarray(o, o + n), fill); fill += n; o += n; if (fill === size) { fill = 0; const cur = fr; fr = new Uint8ClampedArray(size); if (cb(cur, k / fps, k++) === false) { stop = true; p.kill(); return; } } } });
    p.on('close', () => res(k)); p.on('error', rej); }); }

const t0 = Date.now();
// 1. the court, from a picture one second in (as the app does from an early frame)
let court = null; await frames((d, t) => { if (t < 1.0) return true; court = autoCourt({ width: W, height: H, data: d }); if (court) { try { const g = growCourt({ width: W, height: H, data: d }, court); if (g && g.cal) court = g; } catch (e) {} } return false; });
if (!court) { console.log(JSON.stringify({ error: 'court not found' })); process.exit(2); }
const cam = court.cal.cam, refPts = Object.values(court.lines).flat();
// 2. the ball in every picture
const det = new Detector(W, H, cam, refPts), F = [];
await frames((d, t) => { const f = det.push(d, t); if (f) F.push(f); return true; });
const tRead = Date.now();
// 3. the flights
const shots = analyze(F, cam, { mode, clicks: [] }); const tFit = Date.now();

// 4. against the answer key

const truthPath = video.replace(/\.[^.]+$/, '.truth.json'); const out = { W, H, fps, cam: { C: Array.from(cam.C).map(v => +v.toFixed(2)), rms: +court.cal.rms.toFixed(2) }, frames: F.length, fast, readS: (tRead - t0) / 1000, fitS: (tFit - tRead) / 1000, found: shots.length, meta: { rej: shots.meta && shots.meta.rej, netPlays: shots.meta && shots.meta.netPlays } };
if (existsSync(truthPath)) { const T = JSON.parse(readFileSync(truthPath)); out.camTrue = T.C;
  const hitT = q => q.far ? (q.tHit != null ? q.tHit : q.t) : q.t, used = new Set(), rows = [];
  T.shots = T.shots.filter(s => s.t < T.duration - 0.6);
  for (const s of T.shots) { let best = null, bd = 0.35; shots.forEach((q, i) => { if (used.has(i) || !!q.far !== s.far) return; const d = Math.abs(hitT(q) - s.t); if (d < bd) { bd = d; best = i; } });
    const q = best != null ? shots[best] : null; if (best != null) used.add(best);
    rows.push({ t: s.t, far: s.far, volley: s.volley, truth: { speed: s.speed, result: s.result, land: s.land, clear: s.clear, rpm: Math.round(s.rpm) },
      got: q ? { dt: +(hitT(q) - s.t).toFixed(3), speed: +q.speed.toFixed(1), result: q.result, land: q.land && q.land.map(v => +v.toFixed(2)), clear: q.clear != null ? +q.clear.toFixed(2) : null, rpm: q.spin != null ? Math.round(q.spin) : null, volley: !!q.volley, serve: !!q.serve } : null }); }
  const extra = shots.map((q, i) => used.has(i) ? null : { t: +hitT(q).toFixed(2), far: !!q.far, speed: +q.speed.toFixed(0), result: q.result, land: q.land && q.land.map(v => +v.toFixed(1)) }).filter(Boolean);
  const m = rows.filter(r => r.got), sp = m.map(r => r.got.speed / r.truth.speed - 1), ld = m.filter(r => r.truth.land && r.got.land).map(r => Math.hypot(r.truth.land[0] - r.got.land[0], r.truth.land[1] - r.got.land[1]));
  const res = m.filter(r => r.truth.result !== 'none'), resOk = res.filter(r => r.got.result === r.truth.result || (r.truth.result !== 'in' && r.truth.result !== 'net' && ['long', 'wide'].includes(r.got.result)));
  const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
  out.score = { truth: T.shots.length, matched: m.length, missed: T.shots.length - m.length, extra: extra.length, speedErrMedPct: sp.length ? +(100 * med(sp.map(Math.abs))).toFixed(1) : null, speedBiasPct: sp.length ? +(100 * sp.reduce((a, b) => a + b, 0) / sp.length).toFixed(1) : null, landErrMedM: ld.length ? +med(ld).toFixed(2) : null, resultOk: `${resOk.length}/${res.length}` };
  out.rows = rows; out.extra = extra; }
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, rows: undefined, extra: undefined }, null, 1));
if (out.rows) for (const r of out.rows) console.log(r.t.toFixed(2), r.far ? 'F' : 'N', r.volley ? 'V' : ' ', 'truth', r.truth.speed, r.truth.result, JSON.stringify(r.truth.land), 'clr', r.truth.clear, ' | got', r.got ? `${r.got.speed} ${r.got.result} ${JSON.stringify(r.got.land)} clr ${r.got.clear} dt ${r.got.dt}` : 'MISSED');
if (out.extra && out.extra.length) console.log('extra', JSON.stringify(out.extra));
