import { t, setLang, apply, getLang, num } from './i18n.js';
import { calibrate, refineLine, Detector, MODEL_LINES, COURT, Camera } from './engine.js';
import { probe, grabFrame, decodeAll } from './decode.js';
import { topView, sideView, fmtTime, resLabel, spinKind } from './report.js';
import { cloudConfigured, initCloud, currentUser, signIn, signOut, listSessions, saveSession, removeSession, removeAll } from './cloud.js';
import { sessionStats, pack, unpack, thumb, renderSessions, renderProgress } from './history.js';
import { trimVideo } from './trim.js';
const $ = id => document.getElementById(id);
const S = { file: null, info: null, img: null, lines: {}, raw: {}, pending: [], active: 'baseline', cal: null, shots: [], sel: null, mode: 'coach', abort: null, url: null };
const ORDER = Object.keys(MODEL_LINES).filter(id => !id.startsWith('tape')); // the net tape is found automatically, never asked for
function step(n) { $('s5').hidden = true; for (let i = 1; i <= 4; i++) { $('s' + i).hidden = i !== n; document.querySelector(`.steps li[data-step="${i}"]`).classList.toggle('on', i === n); } document.body.classList.toggle('working', n > 1); window.scrollTo(0, 0); }
document.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => { setLang(b.dataset.lang); refreshDynamic(); });
function refreshDynamic() { drawMini(); if (S.shots.length && !$('s4').hidden) renderReport(); if (!$('s5').hidden) showHistory(); updateAcct(); }

// ---- step 1
$('pick').onclick = () => $('file').click(); $('file').onchange = e => e.target.files[0] && openFile(e.target.files[0]);
const drop = $('drop'); ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); })); ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files[0] && openFile(e.dataTransfer.files[0]));
// breadcrumbs kept in this browser only, so that after a tab crash it is possible to see how far the app got
try { const c = localStorage.getItem('baseline.crumbs'); if (c) localStorage.setItem('baseline.crumbsPrev', c); localStorage.removeItem('baseline.crumbs'); } catch (e) {}
function crumb(m) { try { const a = JSON.parse(localStorage.getItem('baseline.crumbs') || '[]'); a.push(new Date().toISOString().slice(11, 19) + ' ' + m + (performance.memory ? ' mem ' + Math.round(performance.memory.usedJSHeapSize / 1e6) : '')); localStorage.setItem('baseline.crumbs', JSON.stringify(a.slice(-60))); } catch (e) {} }
window.__crumb = crumb;
async function openFile(file) { S.frames = null; S.farMe = false; crumb('open size ' + file.size + ' type ' + file.type); $('err1').hidden = true; S.mode = document.querySelector('input[name=mode]:checked').value;
  S.autoToken = null; if (S.info && S.info.video) { const old = S.info.video, u = old.src; try { old.pause(); old.removeAttribute('src'); old.load(); URL.revokeObjectURL(u); } catch (e) {} S.info = null; S.img = null; } // let go of the previous video: two multi-gigabyte files at once can exhaust the tab's memory
  try { S.info = await probe(file); crumb('probe ' + S.info.video.videoWidth + 'x' + S.info.video.videoHeight + ' -> ' + S.info.W + 'x' + S.info.H + ' dur ' + Math.round(S.info.duration)); S.file = file; S.lines = {}; S.raw = {}; S.pending = []; S.cal = null; S.active = 'baseline'; $('go').disabled = true; $('calMsg').textContent = ''; step(2); await loadFrame(); crumb('first frame shown'); autoFind(); }
  catch (e) { console.error(e); $('err1').textContent = t('errVideo'); $('err1').hidden = false; } }

// ---- step 2: the app proposes the court, the user confirms or corrects
function courtWorker(img, grow) { return new Promise(res => { const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); const done = v => { w.terminate(); res(v); }; w.onmessage = e => done(e.data.court || null); w.onerror = () => done(null); setTimeout(() => done(null), 45000); w.postMessage({ court: { width: img.width, height: img.height, data: img.data }, grow }); }); }
async function autoFind() { const token = S.autoToken = {}, msg = $('calMsg'); msg.className = 'msg'; msg.textContent = t('autoLooking'); let best = null;
  const seen = [];
  for (const pos of [80, 300, 550, 800]) { let img; crumb('grab ' + pos); try { img = await grabFrame(S.info, S.info.duration * pos / 1000); } catch (e) { crumb('grab failed'); continue; } seen.push(img); crumb('court search'); const r = await courtWorker(img); crumb('court ' + (r ? r.n : 'none')); if (S.autoToken !== token) return;
    if (r && (!best || r.n > best.r.n)) best = { r, img, pos }; if (best && best.r.n >= 6) break; }
  if (best) { for (const pos of [80, 300, 550, 800].slice(seen.length)) { try { seen.push(await grabFrame(S.info, S.info.duration * pos / 1000)); } catch (e) {} } // lines hidden in one frame are often visible in another
    let other = 0, off = 0; for (const img of seen) { if (img === best.img) continue; const r = await courtWorker(img, best.r); if (S.autoToken !== token) return; if (r) { other++; if (r.support < 0.75) off++; } if (r && r.n > best.r.n) best.r = { ...r, support: undefined }; }
    best.moved = other >= 2 && off >= 2; crumb('court seen elsewhere ' + (other - off) + '/' + other); } // the court must be in the same place at other moments of the video; if it is not, the camera moves or the video joins different views
  if (S.autoToken !== token) return; crumb('auto done'); S.autoToken = null; window.__baselineAuto = best ? best.r.n : 0;
  if (!best) { msg.textContent = t('autoNone'); msg.classList.add('bad'); $('manual').open = true; S.img = await grabFrame(S.info, S.info.duration * $('seek').value / 1000); drawFrame(); return; }
  S.img = best.img; $('seek').value = best.pos; S.raw = best.r.raw; S.lines = best.r.lines; S.pending = []; S.active = null; S.cal = { cam: new Camera(best.r.camP, S.info.W, S.info.H), rms: best.r.rms, perLine: best.r.perLine };
  msg.textContent = t('autoFound', { n: best.r.n }) + ' ' + t('camInfo', { h: num(S.cal.cam.C[2], 1), d: num(-S.cal.cam.C[1], 1) }); msg.classList.add('good'); if (best.moved) { msg.textContent += ' ' + t('autoMoved'); msg.className = 'msg bad'; } window.__baselineMoved = !!best.moved; $('manual').open = false; $('go').disabled = false; drawFrame(); drawMini(); }
// ---- step 2: court marking
const cv = $('frame'), cx = cv.getContext('2d');
async function loadFrame() { S.img = await grabFrame(S.info, S.info.duration * $('seek').value / 1000); cv.width = S.info.W; cv.height = S.info.H; for (const id in S.raw) S.lines[id] = refineLine(S.img, S.raw[id][0], S.raw[id][1], 1.6 * scale()); drawFrame(); drawMini(); }
const scale = () => Math.sqrt(S.info.W * S.info.H / (720 * 1280));
$('seek').onchange = () => { S.autoToken = null; loadFrame(); };
function drawFrame() { cx.putImageData(S.img, 0, 0); const s = scale(); cx.lineWidth = 3 * s;
  if (S.cal) { cx.strokeStyle = '#cbe33a'; cx.lineWidth = 2.5 * s; const cam = S.cal.cam; const seg = (A, B) => { cx.beginPath(); let on = false; for (let i = 0; i <= 40; i++) { const P = A.map((a, k) => a + (B[k] - a) * i / 40); if (cam.norm(P)[2] < 0.1) { on = false; continue; } const q = cam.project(P); on ? cx.lineTo(q[0], q[1]) : cx.moveTo(q[0], q[1]); on = true; } cx.stroke(); };
    for (const id in MODEL_LINES) seg(...MODEL_LINES[id]); for (let i = 0; i < 16; i++) { const a = -6.4 + i * 0.8, h = x => COURT.NET_C + (COURT.NET_P - COURT.NET_C) * (Math.abs(x) / 6.4) ** 2; seg([a, COURT.NET, h(a)], [a + 0.8, COURT.NET, h(a + 0.8)]); } }
  for (const id in S.raw) { const [a, b] = S.raw[id]; cx.strokeStyle = id === S.active ? '#fff' : 'rgba(255,255,255,.55)'; cx.lineWidth = 2 * s; cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.stroke(); for (const p of [a, b]) dot(p, '#2b1d15'); }
  for (const p of S.pending) dot(p, '#cbe33a'); }
function dot(p, c) { const s = scale(); cx.beginPath(); cx.arc(p[0], p[1], 6 * s, 0, 7); cx.fillStyle = c; cx.fill(); cx.lineWidth = 2 * s; cx.strokeStyle = '#fff'; cx.stroke(); }
cv.addEventListener('pointerdown', e => { if (!S.active) return; if (S.autoToken) { S.autoToken = null; $('calMsg').textContent = ''; } const r = cv.getBoundingClientRect(); const p = [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; S.pending.push(p);
  if (S.pending.length === 2) { S.raw[S.active] = S.pending; S.lines[S.active] = refineLine(S.img, S.pending[0], S.pending[1], 1.6 * scale()); S.pending = []; S.cal = null; $('go').disabled = true; nextLine(); }
  drawFrame(); drawMini(); });
function nextLine() { const i = ORDER.indexOf(S.active); for (let k = 1; k <= ORDER.length; k++) { const id = ORDER[(i + k) % ORDER.length]; if (!S.raw[id]) { S.active = id; return; } } S.active = null; }
$('skip').onclick = () => { S.pending = []; const i = ORDER.indexOf(S.active); S.active = ORDER[(i + 1) % ORDER.length]; drawFrame(); drawMini(); };
$('redo').onclick = () => { if (!S.active) return; delete S.raw[S.active]; delete S.lines[S.active]; S.pending = []; S.cal = null; $('go').disabled = true; drawFrame(); drawMini(); };
$('clear').onclick = () => { S.raw = {}; S.lines = {}; S.pending = []; S.cal = null; S.active = 'baseline'; $('go').disabled = true; $('calMsg').textContent = ''; drawFrame(); drawMini(); };
$('back2').onclick = () => step(1);
function drawMini() { const m = $('mini'); m.innerHTML = ''; const NS = 'http://www.w3.org/2000/svg', Y = y => COURT.LEN - y + 1;
  const mk = (id, cls) => { const [A, B] = MODEL_LINES[id], l = document.createElementNS(NS, 'line'); l.setAttribute('x1', A[0]); l.setAttribute('y1', Y(A[1])); l.setAttribute('x2', B[0]); l.setAttribute('y2', Y(B[1])); l.setAttribute('class', cls); l.onclick = () => { S.active = id; S.pending = []; drawFrame(); drawMini(); }; m.appendChild(l); };
  for (const id of ORDER) mk(id, (S.raw[id] ? 'done ' : '') + (id === S.active ? 'act' : '')); for (const id of ORDER) mk(id, 'hit');
  const n = document.createElementNS(NS, 'line'); n.setAttribute('x1', -6.4); n.setAttribute('x2', 6.4); n.setAttribute('y1', Y(COURT.NET)); n.setAttribute('y2', Y(COURT.NET)); n.setAttribute('style', 'stroke-dasharray:.3 .3;pointer-events:none'); m.appendChild(n);
  const tx = document.createElementNS(NS, 'text'); tx.setAttribute('x', 0); tx.setAttribute('y', Y(-1.1)); tx.textContent = t('yourSide'); m.appendChild(tx);
  $('activeName').textContent = S.active ? t('L_' + S.active) : ''; }
$('check').onclick = () => { const msg = $('calMsg'); msg.className = 'msg'; const ids = Object.keys(S.lines); const dirs = new Set(ids.map(id => MODEL_LINES[id][0][0] === MODEL_LINES[id][1][0] ? 'v' : 'h'));
  if (ids.length < 4 || dirs.size < 2) { msg.textContent = t('needLines'); msg.classList.add('bad'); return; }
  const cal = calibrate(S.lines, S.info.W, S.info.H); if (!cal) { msg.textContent = t('calFail'); msg.classList.add('bad'); return; }
  S.cal = cal; const ok = cal.rms < 4 * Math.max(0.8, scale()); msg.textContent = (ok ? t('calOk') : t('calPoor')) + ' ' + t('camInfo', { h: num(cal.cam.C[2], 1), d: num(-cal.cam.C[1], 1) }); msg.classList.add(ok ? 'good' : 'bad'); $('go').disabled = !ok; drawFrame(); };

// ---- step 3: analysis
$('go').onclick = run; $('cancel').onclick = () => { S.abort?.abort(); step(2); };
// the flight fitting on its own: reused when the viewer changes the kind of session after the video has been read
// The calculation code is fetched when the worker starts. After a long read the browser may ask the network for it again, and a moment without connection would then throw away everything read so far: try a few times before giving up.
async function fit(bar) { for (let k = 0; ; k++) { try { return await fitOnce(bar); } catch (e) { if (e.message !== 'load' || k >= 5) throw e.message === 'load' ? new Error(t('errLoad')) : e; crumb('fit worker did not load, try ' + (k + 1)); await new Promise(r => setTimeout(r, 2000 + 2000 * k)); if (S.abort?.signal.aborted) throw new Error('aborted'); } } }
function fitOnce(bar) { const cam = S.cal.cam, { W, H } = S.info; return new Promise((res, rej) => { const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); w.onmessage = e => { if (e.data.progress != null && bar) bar.style.width = (90 + e.data.progress * 10).toFixed(1) + '%'; if (e.data.shots) { w.terminate(); S.meta = e.data.meta; res(e.data.shots); } if (e.data.error) { w.terminate(); rej(new Error(e.data.error)); } }; w.onerror = e => { w.terminate(); rej(new Error(e.message || 'load')); }; if (S.abort) S.abort.signal.addEventListener('abort', () => { w.terminate(); rej(new Error('aborted')); });
    w.postMessage({ frames: S.frames, camP: cam.p, W, H, mode: S.farMe && S.mode === 'coach' ? 'match' : S.mode, noFar: !!window.__baselineNoFar, dbgT: window.__baselineDbgT }); }).then(shots => { if (S.farMe && S.mode !== 'serve') for (const q of shots) q.who = q.who === 'opp' ? 'me' : 'opp'; return shots; }); } // the player filmed from behind is not always the user: with "I'm on the far side" the two roles are swapped
async function changeMode(m, force) { if (!S.frames || (m === S.mode && !force)) return; const sel = $('modeSel'); sel.disabled = true; $('modeMsg').textContent = t('fitting'); const old = S.mode; S.mode = m;
  try { S.shots = await fit(null); crumb('mode ' + m + ' shots ' + S.shots.length); S.sel = null; S.view = 'me'; S.saved = false; window.__baseline = { ...(window.__baseline || {}), shots: S.shots, meta: S.meta }; renderReport(); if (currentUser() && !window.__baselineNoSave) save(); } catch (e) { console.error(e); S.mode = old; sel.value = old; }
  sel.disabled = false; $('modeMsg').textContent = ''; }
async function run() { crumb('run mode ' + S.mode); step(3); $('bar').style.width = '0%'; $('eta').textContent = ''; const { W, H } = S.info, cam = S.cal.cam, pv = $('preview'), px = pv.getContext('2d'); pv.width = W; pv.height = H;
  S.abort = new AbortController(); $('stage').textContent = t('reading'); $('eta').textContent = ''; const bar = $('bar'), start = performance.now(); let k = 0, lastP = 0;
  S.info.video.pause(); S.slow = !(window.VideoDecoder && /\.(mp4|mov|m4v)$/i.test(S.file.name));
  crumb('decode start');
  const onP = p => { if (Math.floor(p * 20) > Math.floor(lastP * 20)) crumb('decode ' + Math.round(p * 100) + '%'); if (p - lastP > 0.002 || p >= 1) { lastP = p; bar.style.width = (p * 90).toFixed(1) + '%'; const el = (performance.now() - start) / 1000; if (p > 0.02) $('eta').textContent = '~' + fmtTime(el / p * (1 - p)) + ' min'; if (S.slow) $('eta').textContent = t('slowPath') + ' ' + $('eta').textContent; } };
  const ring = (data, balls) => { px.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0); px.strokeStyle = '#cbe33a'; px.lineWidth = 3; for (const c of balls) { px.beginPath(); px.arc(c[0], c[1], 14, 0, 7); px.stroke(); } };
  try { let r = null, frames = null; const key = Array.from(cam.p).join();
    if (S.frames && S.framesKey === key) { frames = S.frames; r = { fast: true }; bar.style.width = '90%'; crumb('frames kept from the last read'); } // same video, same court: the reading is not repeated (after a failed calculation, or a second click)
    if (!r && !S.slow && !window.__baselineNoScanWorker) try { // normal path: everything heavy happens in a worker
      let unlock = null; if (navigator.locks) navigator.locks.request('baseline-analysis-' + Math.random(), () => new Promise(r => { unlock = r; })).catch(() => {}); // holding a lock tells the browser this tab is working, so it is not frozen while in the background
      try {
      // the video is split into shares at key frames and each share is read by its own worker: on a machine with several cores this is the biggest saving of all
      const parts = S.info.duration < 90 || window.__baselineParts === 1 ? 1 : Math.max(1, Math.min(4, window.__baselineParts || Math.floor((navigator.hardwareConcurrency || 2) / 3))); crumb('scan workers ' + parts);
      r = await new Promise((res, rej) => { const ws = [], prog = new Array(parts).fill(0), outp = new Array(parts).fill(null); let left = parts, dead = false; const killAll = () => { dead = true; for (const w of ws) w.terminate(); };
        S.abort.signal.addEventListener('abort', () => { killAll(); rej(new Error('aborted')); });
        let seenP = -1; const ping = setInterval(() => { if (lastP === seenP && ws[0]) ws[0].postMessage({ ping: 1 }); seenP = lastP; }, 20000), end = () => clearInterval(ping); S.abort.signal.addEventListener('abort', end); // no progress for 20 s: ask a worker where it is
        for (let pt = 0; pt < parts; pt++) { const w = new Worker(new URL('./scan.js', import.meta.url), { type: 'module' }); ws.push(w);
          w.onmessage = e => { const d = e.data; if (dead) return; if (d.pong) { crumb('no progress: ' + d.pong); return; } if (d.crumb) { crumb(d.crumb); if (/^fast loops/.test(d.crumb)) document.documentElement.dataset.fast = d.crumb.slice(11); } else if (d.preview) { if (d.part === 0 || prog[0] >= 1) ring(d.preview, d.balls); } else if (d.progress != null) { prog[d.part] = d.progress; onP(prog.reduce((a, b) => a + b, 0) / parts); }
            else if (d.done) { outp[d.part] = d; w.terminate(); if (--left === 0) { end(); const fr = []; for (const o of outp) for (const f of o.frames) fr.push(f); res({ frames: fr, fps: outp[0].fps, maxShift: Math.max(...outp.map(o => o.maxShift)), busy: outp.reduce((a, o) => a + o.busy, 0), skipped: outp.reduce((a, o) => a + o.skipped, 0) }); } }
            else if (d.error) { end(); killAll(); const er = new Error(d.error); er.got = d.got + prog.reduce((a, b) => a + b, 0); rej(er); } };
          w.onerror = e => { end(); killAll(); const er = new Error(e.message || 'worker'); er.got = 0; rej(er); };
          w.postMessage({ file: S.file, W, H, duration: S.info.duration, camP: Array.from(cam.p), refPts: Object.values(S.lines).flat(), range: { part: pt, parts }, skipIdle: !window.__baselineNoSkip, noFast: !!window.__baselineNoFast, twoStep: !!window.__baselineTwoStep }); } });
      } finally { if (unlock) unlock(); }
      frames = r.frames; S.info.fps = r.fps; r.fast = true; crumb('scan done frames ' + frames.length + ' moved ' + r.maxShift + 'px busy ' + r.busy + ' idle frames skipped ' + r.skipped + ' in ' + Math.round((performance.now() - start) / 1000) + 's');
    } catch (e) { if (e.message === 'aborted' || e.got > 0) throw e; crumb('scan worker failed: ' + e.message); r = null; }
    if (!r) { const det = new Detector(W, H, cam, Object.values(S.lines).flat()); frames = []; lastP = 0; // fallback on the page itself (other containers, browsers without WebCodecs)
      r = await decodeAll(S.file, S.info, (im, tm) => { const f = det.push(im.data, tm); if (f) frames.push(f); if (++k % 20 === 0) ring(im.data, f ? f.c : []); }, onP, S.abort.signal); }
    crumb('fitting, fast ' + r.fast + ' frames ' + frames.length); $('stage').textContent = t('fitting'); $('eta').textContent = '';
    S.frames = frames; S.framesKey = key; S.shots = await fit(bar);
    window.__baseline = { shots: S.shots, meta: S.meta, frames: frames.length, seconds: (performance.now() - start) / 1000, fast: r.fast };
    crumb('shots ' + S.shots.length); S.sel = null; S.view = 'me'; S.saved = false; S.fromHistory = false; S.sid = sessionId(S.file); $('sdate').value = fileDate(S.file); step(4); renderReport(); if (currentUser() && !window.__baselineNoSave) save();
  } catch (e) { if (e.message === 'aborted') return; console.error(e); crumb('error ' + e.message); step(2); const m = $('calMsg'); m.className = 'msg bad'; m.textContent = t('errAnalyze', { e: e.message || '?' }); }
}

// ---- step 4: report
const med = a => { a = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
// in a match the report shows one player at a time: the near player ("me") or the opponent on the far side
const two = () => S.mode === 'match' || (S.mode === 'coach' && (S.farMe || (S.shots || []).some(q => q.who === 'opp'))); // sessions with two players' shots to tell apart
const vis = () => two() ? S.shots.filter(q => (q.who || 'me') === (S.view || 'me')) : S.shots;
function renderMode() { const row = $('modeRow'), sel = $('modeSel'); row.hidden = !S.frames || S.fromHistory; if (row.hidden) return; sel.innerHTML = ''; for (const m of ['coach', 'serve', 'match']) { const o = document.createElement('option'); o.value = m; o.textContent = t(m); sel.appendChild(o); } sel.value = S.mode; sel.onchange = () => changeMode(sel.value); const fm = $('farMe'); fm.checked = !!S.farMe; fm.onchange = () => { S.farMe = fm.checked; changeMode(S.mode, true); }; }
function renderWho() { const box = $('who2'), has = two() && S.shots.some(q => q.who === 'opp'); box.hidden = !has; if (!has) { S.view = 'me'; return; } box.innerHTML = '';
  for (const k of ['me', 'opp']) { const b = document.createElement('button'); b.className = 'btn' + ((S.view || 'me') === k ? ' primary' : ''); b.textContent = t(k === 'me' ? 'viewMe' : S.mode === 'coach' ? 'viewCoach' : 'viewOpp') + ' (' + S.shots.filter(q => (q.who || 'me') === k).length + ')'; b.onclick = () => { S.view = k; S.sel = null; renderReport(); }; box.appendChild(b); } }
// "Video with the shots only": a copy of the original without the stretches between the shots on screen (no re-encoding, see trim.js)
function renderTrim() { const boxEl = $('trimBox'); boxEl.hidden = !S.file || !S.frames || S.fromHistory; if (S.trimUrl) { URL.revokeObjectURL(S.trimUrl); S.trimUrl = null; } $('trimDl').hidden = true; $('trimMsg').textContent = ''; $('trimMsg').className = 'msg'; }
$('trimGo').onclick = async () => { const msg = $('trimMsg'), dl = $('trimDl'), sh = picked(); msg.className = 'msg'; dl.hidden = true; if (!sh.length) { msg.textContent = t('trimNone'); msg.classList.add('bad'); return; } $('trimGo').disabled = true; msg.textContent = t('trimWork');
  try { const r = await trimVideo(S.file, sh.map(q => ({ t: q.t, tLand: q.tLand })), { before: Math.max(0, Math.min(10, +$('trimB').value || 0)), after: Math.max(0, Math.min(10, +$('trimA').value || 0)) }); if (S.trimUrl) URL.revokeObjectURL(S.trimUrl); S.trimUrl = URL.createObjectURL(r.blob);
    dl.href = S.trimUrl; dl.download = (S.file.name || 'video').replace(/\.[^.]+$/, '') + ' - baseline.mp4'; dl.textContent = t('trimDone', { mb: num(r.blob.size / 1e6, 0), dur: fmtTime(r.seconds) }); dl.hidden = false; msg.textContent = t('trimInfo', { n: r.segments }); msg.classList.add('good'); crumb('trim ' + r.segments + ' clips ' + Math.round(r.seconds) + 's ' + Math.round(r.blob.size / 1e6) + 'MB'); window.__baselineTrim = r; }
  catch (e) { console.error(e); crumb('trim failed ' + e.message); msg.textContent = t('trimFail'); msg.classList.add('bad'); }
  $('trimGo').disabled = false; };
function renderReport() { renderMode(); renderWho(); renderTrim(); const sh = vis(), stats = $('stats'); stats.innerHTML = ''; updateSavebar();
  if (!sh.length) { stats.innerHTML = `<div><span>${t('noShots')}</span></div>`; $('top').innerHTML = $('side').innerHTML = $('tbl').innerHTML = $('sel').innerHTML = $('legend').innerHTML = ''; return; }
  const nIn = sh.filter(s => s.result === 'in').length, over = sh.filter(s => s.result !== 'net');
  const tile = (v, u, l) => { const d = document.createElement('div'); d.innerHTML = `<b>${v}<small>${u}</small></b><span>${l}</span>`; stats.appendChild(d); };
  tile(sh.length, '', t(S.mode === 'serve' ? 'serves' : 'shots')); tile(num(100 * nIn / sh.length), '%', t('inPct')); tile(num(med(sh.map(s => s.speed))), ' km/h', t('medSpeed')); tile(num(med(over.map(s => s.clear)) ?? 0, 2), ' m', t('medClear')); if (sh.some(s => !s.far)) tile(num(Math.round((med(sh.filter(s => !s.far).map(s => s.rpm)) || 0) / 50) * 50), ' rpm', t('medSpin'));
  const c = k => sh.filter(s => s.result === k).length; $('legend').innerHTML = `<span><i style="background:var(--in)"></i>${t('in')}: ${nIn}</span><span><i class="x" style="background:var(--out)"></i>${t('net')}: ${c('net')}</span><span><i class="x" style="background:var(--out)"></i>${t('long')}: ${c('long')}</span><span><i class="x" style="background:var(--out)"></i>${t('wide')}: ${c('wide')}</span><span>${t('closeLegend')}: ${sh.filter(s => s.close).length}</span>`;
  $('acc').textContent = t('acc', { d: num(med(sh.map(s => s.landSd[1])), 1), w: num(med(sh.map(s => s.landSd[0])), 1), c: num(med(sh.map(s => s.clearSd)), 2) }); $('acc').textContent += ' ' + (S.meta && S.meta.netRefs ? t('depthCal', { n: S.meta.netRefs }) : t('depthDefault')); $('accSpin').textContent = sh.some(s => !s.far) ? t('accSpin', { s: num(Math.round(med(sh.filter(s => !s.far).map(s => s.rpmSd)) / 50) * 50) }) : t('farNote');
  const tb = $('tbl'), canTrim = !$('trimBox').hidden; tb.innerHTML = `<thead><tr>${canTrim ? `<th class="pick noprint"><input type="checkbox" id="pickAll" title="${t('pickAll')}" aria-label="${t('pickAll')}"></th>` : ''}<th>${t('time')}</th><th>${t('type')}</th><th>${t('result')}</th><th>${t('speed')}</th><th>${t('clearance')}</th><th>${t('spin')}</th><th>${t('depth')}</th></tr></thead>`; const body = document.createElement('tbody'); tb.appendChild(body);
  sh.forEach((s, i) => { const tr = document.createElement('tr'); tr.dataset.i = i; const kind = spinKind(s);
    tr.innerHTML = `${canTrim ? `<td class="pick noprint"><input type="checkbox" ${s.pick === false ? '' : 'checked'} aria-label="${t('pickOne')}"></td>` : ''}<td>${fmtTime(s.t)}</td><td>${t(s.serve ? 'serveT' : 'stroke')}${s.far && S.mode !== 'match' ? ' · ' + t('farSide') : ''}</td><td><span class="pill ${s.result === 'in' ? '' : 'o'}">${resLabel(s)}</span></td><td>${num(s.speed)}${s.approx && s.speedSd ? ' ±' + num(s.speedSd) : ''} km/h</td><td>${s.net ? num(s.clear, 2) + ' m' : '–'}</td><td>${s.far ? '–' : (kind === 'flat' ? t('flat') : t(kind) + ' ' + num(Math.round(Math.abs(s.rpm) / 50) * 50)) + ' <small>±' + num(Math.round(s.rpmSd / 50) * 50) + '</small>'}</td><td>${s.result === 'net' ? '–' : num(s.land[1], 1) + ' m'}</td>`;
    tr.onclick = () => select(i, true); body.appendChild(tr);
    const cb = tr.querySelector('td.pick input'); if (cb) { cb.parentElement.onclick = e => e.stopPropagation(); cb.onchange = () => { s.pick = cb.checked; syncPick(); }; } });
  const all = $('pickAll'); if (all) all.onchange = () => { for (const q of vis()) q.pick = all.checked; body.querySelectorAll('td.pick input').forEach(c => { c.checked = all.checked; }); syncPick(); };
  syncPick(); draw(); renderSel(false); }
// which shots go into the trimmed video: every one unless its box in the list is unticked
const picked = () => vis().filter(q => q.pick !== false);
function syncPick() { const sh = vis(), n = picked().length, all = $('pickAll'); if (all) { all.checked = n === sh.length && n > 0; all.indeterminate = n > 0 && n < sh.length; } $('trimCount').textContent = sh.length ? t('trimCount', { n, of: sh.length }) : '';
  if (!$('trimDl').hidden) { $('trimDl').hidden = true; $('trimMsg').textContent = ''; $('trimMsg').className = 'msg'; } } // a video already made no longer matches the ticks
function draw() { const sh = vis(); topView($('top'), sh, S.sel, i => select(i, true), S.mode); sideView($('side'), sh, S.sel); document.querySelectorAll('#tbl tbody tr').forEach(tr => tr.classList.toggle('on', +tr.dataset.i === S.sel)); }
function select(i, play) { S.sel = i; draw(); renderSel(play); }
function renderSel(play) { const box = $('sel'); if (S.sel == null) { box.innerHTML = `<p class="help">${t('selHint')}</p>`; return; } const s = vis()[S.sel], kind = spinKind(s);
  const a = s.flatPath[s.flatPath.length - 1][1], b = s.path[s.path.length - 1][1], d = Math.abs(a - b);
  const expl = kind === 'flat' ? t('spinWeak', { d: num(d, 1) }) : t('spinExplain', { a: num(a, 1), b: num(b, 1), d: num(d, 1), k: t(kind), r: num(Math.round(Math.abs(s.rpm) / 50) * 50), s: num(Math.round(s.rpmSd / 50) * 50) });
  box.innerHTML = `<h3>${t('selTitle', { t: fmtTime(s.t) })}</h3><dl><div><dt>${t('result')}</dt><dd>${resLabel(s)}</dd></div><div><dt>${t('speed')}</dt><dd>${num(s.speed)}${s.approx && s.speedSd ? ' ±' + num(s.speedSd) : ''} km/h</dd></div><div><dt>${t('clearance')}</dt><dd>${s.net ? num(s.clear, 2) + ' m' : '–'}</dd></div><div><dt>${t('depth')}</dt><dd>${num(s.land[1], 1)} m <small>±${num(s.landSd[1], 1)}</small></dd></div></dl><p>${s.result === 'net' || s.far ? '' : expl}</p>`;
  if (S.fromHistory || !S.file) return;
  if (!S.url) S.url = URL.createObjectURL(S.file); const v = document.createElement('video'); v.src = S.url; v.controls = true; v.muted = true; v.playsInline = true; box.appendChild(v); const st = Math.max(0, s.t - 2), en = s.t + 2; let loop = true, own = false; // replay from 2 s before to 2 s after the hit until the viewer scrubs
  const jump = () => { own = true; v.currentTime = st; };
  v.addEventListener('loadedmetadata', () => { jump(); if (play) v.play().catch(() => {}); });
  v.addEventListener('seeking', () => { if (own) own = false; else loop = false; }); // a seek the viewer made on the bar: hand over control
  v.addEventListener('timeupdate', () => { if (loop && !v.seeking && (v.currentTime >= en || v.ended)) { jump(); if (v.paused && play) v.play().catch(() => {}); } });
  v.addEventListener('ended', () => { if (loop) { jump(); v.play().catch(() => {}); } }); }
$('csv').onclick = () => { const rows = [['time_s', 'player', 'side', 'type', 'result', 'speed_kmh', 'net_clearance_m', 'spin_rpm', 'spin_sd_rpm', 'land_x_m', 'land_y_m', 'land_y_sd_m', 'hit_x_m', 'hit_y_m', 'hit_z_m']];
  for (const s of S.shots) rows.push([s.t.toFixed(2), s.who || 'me', s.far ? 'far' : 'near', s.serve ? 'serve' : 'stroke', s.result, s.speed.toFixed(1), s.net ? s.clear.toFixed(2) : '', s.rpm.toFixed(0), s.rpmSd.toFixed(0), s.land[0].toFixed(2), s.land[1].toFixed(2), s.landSd[1].toFixed(2), ...s.p0.map(v => v.toFixed(2))]);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' })); a.download = 'baseline-shots.csv'; a.click(); };
$('print').onclick = () => window.print(); $('again').onclick = () => { if (S.url) URL.revokeObjectURL(S.url); S.url = null; S.shots = []; S.fromHistory = false; $('file').value = ''; step(1); };
// ---- accounts, saving and history
const fileDate = f => { const d = new Date(f.lastModified || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sessionId = f => { let h = 2166136261; for (const ch of `${f.name}|${f.size}|${f.lastModified}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return 'v' + (h >>> 0).toString(36) + f.size.toString(36); };
function updateAcct() { const on = S.cloud, u = currentUser(); $('acct').hidden = !on; if (!on) return; $('signIn').hidden = !!u; $('signOut').hidden = !u; $('histBtn').hidden = !u; $('who').hidden = !u; $('who').textContent = u ? u.name : ''; }
function updateSavebar() { const bar = $('savebar'), u = currentUser(), msg = $('saveMsg'); bar.hidden = !S.cloud || S.fromHistory && !u || !S.shots.length; if (bar.hidden) return; $('sdate').disabled = !!S.fromHistory;
  if (S.fromHistory) { msg.textContent = t('fromHistory'); $('saveBtn').hidden = true; } else if (!u) { msg.textContent = t('signToSave'); $('saveBtn').hidden = true; } else if (S.saved) { msg.textContent = t('saved'); $('saveBtn').hidden = true; } else { msg.textContent = S.saveErr || ''; $('saveBtn').hidden = false; } }
async function save() { if (!currentUser() || !S.shots.length || S.fromHistory) return; $('saveMsg').textContent = t('saving'); $('saveBtn').hidden = true;
  try { const date = /^\d{4}-\d{2}-\d{2}$/.test($('sdate').value) ? $('sdate').value : fileDate(S.file);
    await saveSession(S.sid, { v: 1, date, savedAt: new Date().toISOString(), mode: S.mode, name: String(S.file.name).slice(0, 200), duration: Math.round(S.info.duration || 0), stats: sessionStats(S.shots.filter(q => (q.who || 'me') === 'me')), meta: { netRefs: S.meta ? S.meta.netRefs : 0, yOff: S.meta ? +S.meta.yOff.toFixed(2) : 0 }, shots: pack(S.shots), thumb: S.img ? thumb(S.img) : '' });
    S.saved = true; S.saveErr = ''; } catch (e) { console.error(e); S.saved = false; S.saveErr = t('saveFail', { e: e.code || e.message }); }
  updateSavebar(); }
$('saveBtn').onclick = save; $('sdate').onchange = () => { if (!S.fromHistory && currentUser()) { S.saved = false; save(); } };
$('signIn').onclick = async () => { try { await signIn(); } catch (e) { console.error(e); if (!$('savebar').hidden) $('saveMsg').textContent = t('signFail', { e: e.code || e.message }); } };
$('signOut').onclick = async () => { await signOut(); if (!$('s5').hidden) step(1); };
async function showHistory() { for (let i = 1; i <= 4; i++) { $('s' + i).hidden = true; document.querySelector(`.steps li[data-step="${i}"]`).classList.remove('on'); } $('s5').hidden = false; document.body.classList.add('working'); window.scrollTo(0, 0);
  let list = []; try { list = await listSessions(); } catch (e) { console.error(e); } S.sessions = list; $('histEmpty').hidden = list.length > 0; $('dangerBox').hidden = !list.length; $('progress').hidden = !list.length;
  if (list.length) renderProgress($('progress'), $('progText'), $('trend'), list);
  renderSessions($('sessions'), list, s => { S.shots = unpack(s.shots); S.meta = s.meta || null; S.mode = ['coach', 'serve', 'match'].includes(s.mode) ? s.mode : 'coach'; S.fromHistory = true; S.sel = null; S.view = 'me'; $('sdate').value = /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : ''; step(4); renderReport(); },
    async s => { try { await removeSession(s.id); } catch (e) { console.error(e); } showHistory(); }); }
$('histBtn').onclick = showHistory; $('newFromHist').onclick = () => step(1);
$('delAll').onclick = () => { $('delAll').hidden = true; $('delAllYes').hidden = $('delAllNo').hidden = false; };
$('delAllNo').onclick = () => { $('delAll').hidden = false; $('delAllYes').hidden = $('delAllNo').hidden = true; };
$('delAllYes').onclick = async () => { try { await removeAll(); } catch (e) { console.error(e); } $('delAllNo').onclick(); showHistory(); };
S.cloud = cloudConfigured();
if (S.cloud) initCloud(u => { updateAcct(); if (!$('s4').hidden) { updateSavebar(); if (u && S.shots.length && !S.fromHistory && !S.saved) save(); } if (!u && !$('s5').hidden) step(1); }).catch(e => { console.error(e); S.cloud = false; updateAcct(); });
// test hook: lets an automated check supply court lines without tapping
window.__baselineSetLines = raw => { S.autoToken = null; S.raw = raw; S.lines = {}; for (const id in raw) S.lines[id] = refineLine(S.img, raw[id][0], raw[id][1], 1.6 * scale()); S.active = null; drawFrame(); drawMini(); };
if (window.self !== window.top) { $('csv').hidden = true; $('print').hidden = true; } // embedded previews block downloads and printing
setLang(getLang()); step(1); drawMini(); updateAcct();
