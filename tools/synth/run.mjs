// Runs Baseline's own pipeline (js/engine.js: court finding, ball detector, flight fitting) on a video
globalThis.__crumb = globalThis.__crumb || (() => {});
// outside the browser, with ffmpeg decoding the pictures, and compares the shots with the answer key
// written by render.py. Usage: node run.mjs video.mp4 [mode] [--json out.json]
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const TRACE = process.argv.includes('--trace') || process.argv.includes('--segs'); if (TRACE) { globalThis.__TR = []; globalThis.__SEGS = []; globalThis.__TRK = []; globalThis.__QUIET = []; globalThis.__NOQUIET = !!process.env.NOQUIET; execFileSync('node', [new URL('./trace.mjs', import.meta.url).pathname]); }
const { autoCourt, growCourt, Camera, Detector, analyze, COURT, initFast, buildTracks } = await import(TRACE ? '../../js/engine.trace.mjs' : process.env.ENGINE || '../../js/engine.js');
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
let court = null; await frames((d, t, k) => { if (t < 0.5 || Math.round(t * fps) % Math.round(fps * 0.5)) return t < 3.0; let c = autoCourt({ width: W, height: H, data: d }); if (c) { try { const g = growCourt({ width: W, height: H, data: d }, c); if (g && g.cal) c = g; } catch (e) {} } if (c && (!court || c.cal.rms < court.cal.rms)) court = c; return t < 3.0; }); // the best of six pictures, as a person would pick the one where nobody stands on the lines
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
      got: q ? { dt: +(hitT(q) - s.t).toFixed(3), speed: +q.speed.toFixed(1), result: q.result, land: q.land && q.land.map(v => +v.toFixed(2)), clear: q.clear != null ? +q.clear.toFixed(2) : null, rpm: q.rpm != null ? Math.round(q.rpm) : null, volley: !!q.volley, serve: !!q.serve } : null }); }
  const extra = shots.map((q, i) => used.has(i) ? null : { t: +hitT(q).toFixed(2), far: !!q.far, speed: +q.speed.toFixed(0), result: q.result, land: q.land && q.land.map(v => +v.toFixed(1)) }).filter(Boolean);
  const m = rows.filter(r => r.got), sp = m.map(r => r.got.speed / r.truth.speed - 1), ld = m.filter(r => r.truth.land && r.got.land).map(r => Math.hypot(r.truth.land[0] - r.got.land[0], r.truth.land[1] - r.got.land[1]));
  const res = m.filter(r => r.truth.result !== 'none'), resOk = res.filter(r => r.got.result === r.truth.result || (r.truth.result !== 'in' && r.truth.result !== 'net' && ['long', 'wide'].includes(r.got.result)));
  const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
  out.score = { truth: T.shots.length, matched: m.length, missed: T.shots.length - m.length, extra: extra.length, speedErrMedPct: sp.length ? +(100 * med(sp.map(Math.abs))).toFixed(1) : null, speedBiasPct: sp.length ? +(100 * sp.reduce((a, b) => a + b, 0) / sp.length).toFixed(1) : null, landErrMedM: ld.length ? +med(ld).toFixed(2) : null, resultOk: `${resOk.length}/${res.length}` };
  // how much of each flight the ball detector saw: frames with a candidate within 8 px of the true ball
  if (T.scene && existsSync(T.scene)) { const Sc = JSON.parse(readFileSync(T.scene)), B = Sc.ball.filter(Boolean), sx = W / T.W;
    const bAt = t => { let lo = 0, hi = B.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (B[m][0] < t) lo = m + 1; else hi = m; } return Math.abs(B[lo][0] - t) < 0.004 ? B[lo] : null; };
    const fi = t => { let lo = 0, hi = F.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (F[m].t < t) lo = m + 1; else hi = m; } return lo; };
    T.shots.forEach((sh, k) => { const end = Math.min(k + 1 < T.shots.length ? T.shots[k + 1].t : sh.t + 2, sh.t + (sh.tLand || 1.5) + 0.3); let look = 0, seen = 0, run = 0, best = 0, inPic = 0;
      for (let i = fi(sh.t + 0.02); i < F.length && F[i].t < end; i++) { const b = bAt(F[i].t); if (!b) continue; let u; try { u = cam.project([b[1], b[2], b[3]]); } catch (e) { continue; } look++;
        if (!u || u[0] < 0 || u[0] >= W || u[1] < 0 || u[1] >= H) { run = 0; continue; } inPic++;
        const hit = (F[i].c2 || F[i].c || []).some(c => Math.hypot(c[0] - u[0], c[1] - u[1]) < 8 * W / 1280); if (hit) { seen++; run++; best = Math.max(best, run); } else run = 0; }
      rows[k].cov = { look, inPic, seen, run: best }; }); }
  if (globalThis.__TR) rows.forEach(r => { const ev = globalThis.__TR.filter(([w, t]) => t > r.t - 0.6 && t < r.t + (r.far ? 1.3 : 0.9)); r.trace = [...new Set(ev.filter(([w]) => w[0] === (r.far ? 'f' : 'n') && !/climb|f:start/.test(w)).map(([w, t]) => w + '@' + (t - r.t).toFixed(2)))].slice(0, 24).join(' '); });
  out.rows = rows; out.extra = extra; }
if (args.includes('--segs')) { const T0 = +args[args.indexOf('--segs') + 1], T1 = T0 + 1.4; const TT = JSON.parse(readFileSync(truthPath)), Sc = JSON.parse(readFileSync(TT.scene)), B = Sc.ball.filter(Boolean);
  for (let t = T0; t < T1; t += 0.1) { const b = B.reduce((a, c) => Math.abs(c[0] - t) < Math.abs(a[0] - t) ? c : a); console.log('truth', t.toFixed(2), cam.project([b[1], b[2], b[3]]).map(Math.round).join(',')); }
  for (const f of F) { if (f.t < T0 || f.t > T1) continue; const b = B.reduce((a, c) => Math.abs(c[0] - f.t) < Math.abs(a[0] - f.t) ? c : a), u = cam.project([b[1], b[2], b[3]]); const md = L => L && L.length ? Math.round(Math.min(...L.map(c => Math.hypot(c[0] - u[0], c[1] - u[1])))) : -1; console.log('cand', f.t.toFixed(3), u.map(Math.round).join(','), 'c', md(f.c), (f.c || []).length, 'c2', md(f.c2), (f.c2 || []).length, f.valid ? '' : 'INVALID', f.cut ? 'CUT' : ''); }
  { const s1 = Math.sqrt(W * H / (720 * 1280)); const i0 = F.findIndex(f => f.t > T0 - 0.5), i1 = F.findIndex(f => f.t > T1); const sub = F.slice(i0, i1); for (const tr of buildTracks(sub, s1)) { console.log('BT', sub[tr[0][0]].t.toFixed(3), tr.length, tr[0].slice(1, 3).map(Math.round).join(','), tr[tr.length - 1].slice(1, 3).map(Math.round).join(',')); if (tr.length > 60) console.log('  pts', tr.filter((p, i) => i % 3 === 0).map(p => sub[p[0]].t.toFixed(2) + ':' + Math.round(p[1]) + ',' + Math.round(p[2])).join(' ')); } }
  for (const g of globalThis.__TRK) if (g[0] > T0 - 0.3 && g[0] < T1) console.log('track', JSON.stringify(g));
  for (const g of globalThis.__SEGS) if (g[0] > T0 - 0.3 && g[0] < T1) console.log('seg', JSON.stringify(g)); }
if (globalThis.__QUIET && globalThis.__QUIET.length) console.log('quiet cells', JSON.stringify(globalThis.__QUIET.slice(0, 40)));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, rows: undefined, extra: undefined }, null, 1));
if (out.rows) for (const r of out.rows) console.log(r.t.toFixed(2), r.far ? 'F' : 'N', r.volley ? 'V' : ' ', r.cov ? `cov ${r.cov.seen}/${r.cov.inPic}/${r.cov.look} run ${r.cov.run}` : '', 'truth', r.truth.speed, r.truth.result, JSON.stringify(r.truth.land), 'clr', r.truth.clear, ' | got', r.got ? `${r.got.speed} ${r.got.result} ${JSON.stringify(r.got.land)} clr ${r.got.clear} dt ${r.got.dt}` : 'MISSED', r.got ? '' : (r.trace || ''));
if (out.extra && out.extra.length) console.log('extra', JSON.stringify(out.extra));
