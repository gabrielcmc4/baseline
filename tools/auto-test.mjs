import { execFileSync } from 'node:child_process'; import { autoCourt, refineLine, calibrate } from '../js/engine.js';
for (const f of process.argv.slice(2)) { const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
  const img = { width: w, height: h, data: execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1e9 }) };
  const t0 = Date.now(), dbg = {}, r = autoCourt(img, dbg); if (!r) { console.log(f, 'NOT FOUND', Date.now() - t0, 'ms', JSON.stringify(dbg.tried), dbg.vp, dbg.across, dbg.best); continue; }
  const cal = r.cal;
  console.log(f.split('/').pop(), Date.now() - t0, 'ms', Object.keys(r.raw).join(','), 'n', r.n, cal ? `rms ${cal.rms.toFixed(1)} f ${cal.cam.f.toFixed(0)} C ${cal.cam.C.map(v => v.toFixed(1))}` : 'calib failed'); }
