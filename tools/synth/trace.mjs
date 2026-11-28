// Writes a copy of js/engine.js with trace points (why each track was dropped) next to it, for run.mjs --trace.
// The app's engine is not touched.
import { readFileSync, writeFileSync } from 'node:fs';
const src = new URL('../../js/engine.js', import.meta.url), out = new URL('../../js/engine.trace.mjs', import.meta.url);
let e = readFileSync(src, 'utf8');
const rep = (a, b) => { if (!e.includes(a)) throw new Error('trace: missing ' + a.slice(0, 70)); e = e.split(a).join(b); };
e = "const TR = (w, t) => { if (globalThis.__TR) globalThis.__TR.push([w, +(+t).toFixed(3)]); };\n" + e;
rep("  segs.sort((a, b) => a[0][0] - b[0][0]);", "  segs.sort((a, b) => a[0][0] - b[0][0]); if (globalThis.__SEGS) for (const q of segs) globalThis.__SEGS.push([+ts[q[0][0]].toFixed(3), q.length, Math.round(q[0][1]), Math.round(q[0][2]), Math.round(q[q.length - 1][1]), Math.round(q[q.length - 1][2]), Math.round(Math.min(...q.map(p => p[2])))]); if (globalThis.__TRK) for (const tr of tracks) globalThis.__TRK.push([+ts[tr[0][0]].toFixed(3), tr.length, Math.round(tr[0][1]), Math.round(tr[0][2]), Math.round(tr[tr.length - 1][1]), Math.round(tr[tr.length - 1][2])]);");
rep("function quiet(frames) { const G = 20,", "function quiet(frames) { if (globalThis.__NOQUIET) return { frames, cells: 0, removed: 0 }; const G = 20,");
rep("const lim = Math.max(60, 0.03 * n), bad = new Set(); for (const [k, v] of cnt) if (v > lim) bad.add(k);", "const lim = Math.max(60, 0.03 * n), bad = new Set(); for (const [k, v] of cnt) if (v > lim) bad.add(k); if (globalThis.__QUIET) globalThis.__QUIET.push(...[...bad].map(k => [(k % 4096) * G, ((k / 4096) | 0) * G, cnt.get(k)]));");
rep("        const ok = opts.filter(o => o.f.rms <= (o.cut ? 6 : 3)).sort((p, q) => p.a0 - q.a0", "        TR('f:try' + opts.map(o => o.a0 + (o.cut ? 'c' : '') + ':' + o.f.rms.toFixed(0)).join(','), t0); const ok = opts.filter(o => o.f.rms <= (o.cut ? 6 : 3)).sort((p, q) => p.a0 - q.a0");
rep("if (v > cam.tapeY(u) + 25 * s) { back = nearAt(q[0][0] - d, u, v, -8); if (back) break; } } }", "if (v > cam.tapeY(u) + 25 * s) { back = nearAt(q[0][0] - d, u, v, -8); if (back) break; } } TR('n:back' + Math.round(B[1]) + '[' + Math.round(polyval(A, -4)) + ',' + Math.round(polyval(B, -4)) + ' tape' + Math.round(cam.tapeY(x0)) + ' blobs' + JSON.stringify((frames[Math.max(0, q[0][0] - 4)].blobs || []).map(b => b.map(Math.round))) + ']' + (back ? 'OK' : ''), ts[q[0][0]]); }");
// far pass
rep("pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) continue;\n      const end = pts[pts.length - 1]; if (end[2] < cam.tapeY(end[1]) + 15 * s) continue;", "pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) { TR('f:few', ts[pts[0][0]]); continue; }\n      const end = pts[pts.length - 1]; if (end[2] < cam.tapeY(end[1]) + 15 * s) { TR('f:notPast', ts[pts[0][0]]); continue; }");
rep("if (!fit || fit.rms > (cut ? 6 : 3)) continue;", "if (!fit || fit.rms > (cut ? 6 : 3)) { TR('f:rms' + (fit ? Math.round(fit.rms) : 'X') + (cut ? 'cut' : ''), t0); continue; }");
rep("if (speed < 25 || speed > 240) continue; // speed off", "if (speed < 25 || speed > 240) { TR('f:speed', t0); continue; } // speed off");
rep("const sum = flightSummary(x); if (!sum.land) continue;\n      const sd = covariance", "const sum = flightSummary(x); if (!sum.land) { TR('f:noland', t0); continue; }\n      const sd = covariance");
rep("|| [9, 9, 9, 9]; if (sd[1] > (ground ? 3 : 1.5)) continue;", "|| [9, 9, 9, 9]; if (sd[1] > (ground ? 3 : 1.5)) { TR('f:sd' + sd[1].toFixed(1) + (ground ? 'g' : ''), t0); continue; }");
rep("    shots.push({ extra: (o.back || o.fb) || undefined, t: tHit,", "    TR('n:ok', t0); shots.push({ extra: (o.back || o.fb) || undefined, t: tHit,");
// near candidates
rep("pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) continue;\n    const k = Math.min(5", "pts.sort((u, v) => u[0] - v[0]); if (pts.length < 7) { TR('n:few', ts[pts[0][0]]); continue; }\n    const k = Math.min(5");
rep("if (fit.rms > 3) { meta.rej.rms++; return; }", "if (fit.rms > 3) { TR('n:rms' + fit.rms.toFixed(0) + '/' + o.t.length + (o.net ? 'net' : ''), t0); meta.rej.rms++; return; }");
// near rejections (inside the per-candidate function, t0 is the candidate start)
e = e.replace(/meta\.rej\.(\w+)\+\+; return;/g, (m, k) => `{ try { TR('n:' + '${k}', t0); } catch (er) {} meta.rej.${k}++; return; }`);
e = e.replace(/meta\.rej\.(\w+) = \(meta\.rej\.\1 \|\| 0\) \+ 1; return;/g, (m, k) => `{ try { TR('n:' + '${k}', t0); } catch (er) {} meta.rej.${k} = (meta.rej.${k} || 0) + 1; return; }`);
if (process.env.KDCAP) e = e.replace('Math.min(Math.abs(cl), 0.22)', 'Math.min(Math.abs(cl), ' + process.env.KDCAP + ')');
if (process.env.CDCONST) e = e.replace('const kdOf = cl => {', 'const kdOf = cl => KD; const kdOld = cl => {');
writeFileSync(out, e); console.log('written', out.pathname);
