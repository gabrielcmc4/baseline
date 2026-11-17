import fs from 'node:fs'; import { analyze, Camera } from '../js/engine.js';
const cam = new Camera(JSON.parse(fs.readFileSync('/home/claude/cam_js.json')), 720, 1280);
const frames = JSON.parse(fs.readFileSync('/home/claude/frames_js.json'));
const t0 = Date.now(); const shots = analyze(frames, cam, { mode: process.argv[2] || 'coach' });
console.log(shots.meta, 'shots', shots.length, 'in', ((Date.now() - t0) / 1000).toFixed(1), 's');
fs.writeFileSync('/home/claude/shots_js.json', JSON.stringify(shots));
const cnt = {}; shots.forEach(s => cnt[s.result] = (cnt[s.result] || 0) + 1); console.log(cnt, 'close', shots.filter(s=>s.close).length, 'netHit', shots.filter(s=>s.netHit).length, 'in&sure', shots.filter(s=>s.result==='in'&&!s.close).length, 'long&sure', shots.filter(s=>s.result==='long'&&!s.close).length);
const med = a => { a = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return a[a.length >> 1]; };
console.log('median speed', med(shots.map(s => s.speed)).toFixed(0), 'clear', med(shots.filter(s => s.result !== 'net').map(s => s.clear)).toFixed(2), 'landSdY', med(shots.map(s => s.landSd[1])).toFixed(2), 'cl', med(shots.map(s => s.cl)).toFixed(3), 'clSd', med(shots.map(s => s.clSd)).toFixed(3), 'rpm', med(shots.map(s => s.rpm)).toFixed(0), 'rpmSd', med(shots.map(s => s.rpmSd)).toFixed(0), 'feet', shots.filter(s => s.feetY != null).length);
