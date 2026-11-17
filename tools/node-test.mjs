// Offline validation: node tools/node-test.mjs <video> <refFrame.jpg> [maxSeconds]
import { spawn, execFileSync } from 'node:child_process'; import fs from 'node:fs';
import { calibrate, refineLine, Detector, analyze, Camera } from '../js/engine.js';
const [video, ref, maxS] = process.argv.slice(2); const W = 720, H = 1280;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', ref, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1e9 });
const img = { width: W, height: H, data: raw };
const seeds = { baseline: [[0, 786], [719, 701]], singlesL: [[0, 731], [169, 584]], doublesL: [[0, 651], [260, 479]], service: [[140, 612], [720, 535]], center: [[418, 467], [429, 575]], singlesR: [[539, 437], [719, 519]], doublesR: [[582, 430], [719, 472]] };
const lines = {}; for (const k in seeds) lines[k] = refineLine(img, ...seeds[k]);
let t0 = Date.now(); const cal = calibrate(lines, W, H); const cam = cal.cam;
console.log('calib ms', Date.now() - t0, 'f', cam.f.toFixed(0), 'k1', cam.k1.toFixed(3), 'C', cam.C.map(v => v.toFixed(2)), 'rms', cal.rms.toFixed(2), cal.perLine);
fs.writeFileSync('/home/claude/cam_js.json', JSON.stringify(cam.p));
if (process.argv.includes('--calib-only')) process.exit(0);
const ts = [0, ...fs.readFileSync('/home/claude/cands.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l).t)];
const det = new Detector(W, H, cam, Object.values(lines).flat()); const frames = []; const fsz = W * H * 4;
const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, ...(maxS ? ['-t', maxS] : []), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
let buf = Buffer.alloc(0), k = 0; t0 = Date.now();
ff.stdout.on('data', d => { buf = buf.length ? Buffer.concat([buf, d]) : d; while (buf.length >= fsz) { const fr = new Uint8Array(buf.subarray(0, fsz)); buf = buf.subarray(fsz); const r = det.push(fr, ts[k] ?? k / 30); k++; if (r) frames.push(r); if (k % 3000 === 0) console.log(k, ((Date.now() - t0) / 1000).toFixed(0) + 's'); } });
ff.on('close', () => { console.log('frames', k, 'detect s', (Date.now() - t0) / 1000, 'invalid', frames.filter(f => !f.valid).length);
  fs.writeFileSync('/home/claude/frames_js.json', JSON.stringify(frames)); });
