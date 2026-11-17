import fs from 'node:fs'; import { analyze, Camera, simulateAt, COURT } from '../js/engine.js';
const cam = new Camera(JSON.parse(fs.readFileSync('/home/claude/cam_js.json')), 720, 1280); const frames = JSON.parse(fs.readFileSync('/home/claude/frames_js.json'));
const base = JSON.parse(fs.readFileSync('/home/claude/shots_js.json')); const only = base.filter(s => s.result === 'net' && s.n === s.nTotal).map(s => s.t).concat(base.filter((s,i)=>s.result!=='net'&&i%4===0).map(s=>s.t));
const med = a => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
for (const o of JSON.parse(process.argv[2])) { const sh = analyze(frames, cam, { ...o, only }); const ye = [], nets = base.filter(s => s.result === 'net' && s.n === s.nTotal).map(s => s.t);
  for (const s of sh) { if (!nets.some(q => Math.abs(q - s.t) < 0.3)) continue; const X = simulateAt([...s.p0, ...s.v0, s.cl], [(s.n - 1) / 30])[0]; ye.push(X[1]); }
  const oth = sh.filter(s => !nets.some(q => Math.abs(q - s.t) < 0.3));
  console.log(JSON.stringify(o), 'net y_end median', med(ye).toFixed(2), 'n', ye.length, '| others: land y med', med(oth.map(s => s.land[1])).toFixed(1), 'sdY', med(oth.map(s => s.landSd[1])).toFixed(2), 'speed', med(oth.map(s => s.speed)).toFixed(0), 'cl', med(oth.map(s => s.cl)).toFixed(3), 'z0', med(oth.map(s => s.p0[2])).toFixed(2), 'long', oth.filter(s => s.result === 'long').length, '/', oth.length); }
