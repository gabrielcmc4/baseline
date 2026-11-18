// Reads every frame of a video file in the browser. WebCodecs + mp4box when possible, <video> playback otherwise.
const MAX_SIDE = 1600;
function loadVideo(file) { return new Promise((res, rej) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = URL.createObjectURL(file);
  v.onloadedmetadata = () => res(v); v.onerror = () => rej(new Error('unsupported')); }); }
export async function probe(file) { const v = await loadVideo(file); const sc = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
  return { video: v, W: Math.round(v.videoWidth * sc / 2) * 2, H: Math.round(v.videoHeight * sc / 2) * 2, duration: v.duration }; }
export async function grabFrame(info, t) { const v = info.video; await new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = Math.min(Math.max(0, t), Math.max(0, info.duration - 0.05)); setTimeout(done, 4000); });
  const c = document.createElement('canvas'); c.width = info.W; c.height = info.H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 0, info.W, info.H); return x.getImageData(0, 0, info.W, info.H); }

function description(mp4, track) { const trak = mp4.getTrackById(track.id);
  for (const e of trak.mdia.minf.stbl.stsd.entries) { const box = e.avcC || e.hvcC || e.vpcC || e.av1C; if (box) { const st = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(st); return new Uint8Array(st.buffer, 8); } } return undefined; }

async function decodeWebCodecs(file, info, onFrame, onProgress, signal) {
  const { W, H } = info, canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const mp4 = MP4Box.createFile(); let pos = 0, track = null, ready = false, failed = null, pending = 0, count = 0, stride = 1, total = 0, rot = 0; const queue = [];
  const dec = new VideoDecoder({ error: e => { failed = e; globalThis.__crumb?.('decoder error ' + e.message); }, output: fr => { try {
      if (count % stride === 0) { ctx.save();
        if (rot === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(fr, 0, 0, H, W); } else if (rot === 270) { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); ctx.drawImage(fr, 0, 0, H, W); }
        else if (rot === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); ctx.drawImage(fr, 0, 0, W, H); } else ctx.drawImage(fr, 0, 0, W, H);
        ctx.restore(); onFrame(ctx.getImageData(0, 0, W, H), fr.timestamp / 1e6); }
      if (count === 0 || count % 120 === 0) globalThis.__crumb?.('frame ' + count + ' ' + fr.codedWidth + 'x' + fr.codedHeight + ' ' + fr.format + ' pending ' + pending + ' queue ' + queue.length + ' pos ' + Math.round(pos / 1e6) + 'MB');
      count++; if (total) onProgress(count / total); } catch (e) { failed = e; } finally { fr.close(); pending--; } } });
  let cfgPromise = null;
  mp4.onError = e => { failed = new Error(e); globalThis.__crumb?.('mp4 error ' + e); };
  mp4.onReady = inf => { track = inf.videoTracks[0]; if (!track) { failed = new Error('no video track'); return; } total = track.nb_samples;
    const fps = track.nb_samples / (track.movie_duration / track.movie_timescale || info.duration); stride = fps > 75 ? Math.round(fps / 60) : 1; info.fps = fps / stride;
    const m = track.matrix; let ang = m ? Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI) : 0; ang = ((ang % 360) + 360) % 360;
    const turned = (track.video.width > track.video.height) !== (W > H) && W !== H; rot = turned ? (ang === 270 ? 270 : 90) : (ang === 180 ? 180 : 0);
    const cfg = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description: description(mp4, track) };
    globalThis.__crumb?.('tracks ' + inf.tracks.map(t => t.codec).join(',') + ' video ' + track.video.width + 'x' + track.video.height + ' samples ' + total + ' fps ' + fps.toFixed(1) + ' rot ' + rot + ' brands ' + (inf.brands || []).join('/'));
    cfgPromise = VideoDecoder.isConfigSupported(cfg).then(s => { globalThis.__crumb?.('codec supported ' + s.supported); if (!s.supported) throw new Error('codec'); dec.configure(cfg); mp4.setExtractionOptions(track.id, null, { nbSamples: 30 }); mp4.start(); ready = true; }); };
  let lastNo = -1; mp4.onSamples = (id, user, samples) => { for (const s of samples) { if (s.number <= lastNo) continue; lastNo = s.number; queue.push(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: s.data })); } mp4.releaseUsedSamples(id, samples[samples.length - 1].number); };
  const CH = 2 * 1024 * 1024; let jumped = false;
  while (pos < file.size) { if (signal?.aborted) throw new Error('aborted'); if (failed) throw failed;
    const buf = await file.slice(pos, pos + CH).arrayBuffer(); buf.fileStart = pos; const next = mp4.appendBuffer(buf);
    if (cfgPromise) await cfgPromise;
    if (ready && !jumped) { jumped = true; pos = mp4.seek(0, true).offset; } else if (ready) pos += buf.byteLength; else pos = (next && next > pos) ? next : pos + buf.byteLength;
    while (queue.length) { if (failed) throw failed; const ch = queue.shift(); pending++; dec.decode(ch); if (pending > 12 || dec.decodeQueueSize > 12) await new Promise(r => setTimeout(r, 0)); while (pending > 24) await new Promise(r => setTimeout(r, 4)); } }
  if (!ready) throw failed || new Error('not mp4'); mp4.flush();
  while (queue.length) { const ch = queue.shift(); pending++; dec.decode(ch); }
  await dec.flush(); dec.close(); if (failed) throw failed; return count;
}
async function decodePlayback(file, info, onFrame, onProgress, signal) {
  const v = info.video; if (!v.requestVideoFrameCallback) throw new Error('browser');
  const c = document.createElement('canvas'); c.width = info.W; c.height = info.H; const x = c.getContext('2d', { willReadFrequently: true }); let n = 0, last = -1;
  v.currentTime = 0; v.playbackRate = 0.5; // half speed so no frame is skipped while it is being analyzed
  await new Promise((res, rej) => { const step = (now, meta) => { if (signal?.aborted) { v.pause(); return rej(new Error('aborted')); }
      if (meta.mediaTime > last) { last = meta.mediaTime; x.drawImage(v, 0, 0, info.W, info.H); try { onFrame(x.getImageData(0, 0, info.W, info.H), meta.mediaTime); } catch (e) { v.pause(); return rej(e); } n++; onProgress(meta.mediaTime / info.duration); }
      if (!v.ended) v.requestVideoFrameCallback(step); };
    v.onended = () => res(); v.requestVideoFrameCallback(step); v.play().catch(rej); });
  info.fps = n / info.duration; return n;
}

// ---- own reader for MP4/MOV files: finds the video track and its sample table without loading the file (some phone exports made the general-purpose library hang)
export async function parseMp4(file) {
  const rd = async (a, n) => new DataView(await file.slice(a, a + n).arrayBuffer()); let pos = 0, moov = null;
  while (pos + 8 <= file.size) { const h = await rd(pos, 16); if (h.byteLength < 8) break; let size = h.getUint32(0), hdr = 8; const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1 && h.byteLength >= 16) { size = h.getUint32(8) * 4294967296 + h.getUint32(12); hdr = 16; } else if (size === 0) size = file.size - pos; if (size < hdr) break;
    if (type === 'moov') { if (size > 3e8) throw new Error('moov too large'); moov = await rd(pos + hdr, size - hdr); break; } pos += size; }
  if (!moov) throw new Error('no moov');
  const kids = (v, a, b) => { const out = []; while (a + 8 <= b) { let size = v.getUint32(a), hdr = 8; const type = String.fromCharCode(v.getUint8(a + 4), v.getUint8(a + 5), v.getUint8(a + 6), v.getUint8(a + 7)); if (size === 1) { size = v.getUint32(a + 8) * 4294967296 + v.getUint32(a + 12); hdr = 16; } else if (size === 0) size = b - a; if (size < hdr || a + size > b) break; out.push({ type, a: a + hdr, b: a + size }); a += size; } return out; };
  const find = (list, t) => list.find(x => x.type === t), v = moov, summary = [];
  for (const trak of kids(v, 0, v.byteLength).filter(x => x.type === 'trak')) { const tk = kids(v, trak.a, trak.b), mdia = find(tk, 'mdia'); if (!mdia) continue; const mk = kids(v, mdia.a, mdia.b), hdlr = find(mk, 'hdlr'), mdhd = find(mk, 'mdhd'), minf = find(mk, 'minf'); if (!hdlr || !mdhd || !minf) continue;
    const handler = String.fromCharCode(v.getUint8(hdlr.a + 8), v.getUint8(hdlr.a + 9), v.getUint8(hdlr.a + 10), v.getUint8(hdlr.a + 11)); const stbl = find(kids(v, minf.a, minf.b), 'stbl'); if (!stbl) continue; const sk = kids(v, stbl.a, stbl.b), stsd = find(sk, 'stsd'); if (!stsd) continue;
    const ent = kids(v, stsd.a + 8, stsd.b)[0]; summary.push(handler + ':' + (ent ? ent.type : '?')); if (handler !== 'vide' || !ent) continue;
    const width = v.getUint16(ent.a + 24), height = v.getUint16(ent.a + 26), cfgs = kids(v, ent.a + 78, ent.b), cb = find(cfgs, 'hvcC') || find(cfgs, 'avcC'); if (!cb) continue;
    const description = new Uint8Array(v.buffer.slice(v.byteOffset + cb.a, v.byteOffset + cb.b)), hx = n => n.toString(16).padStart(2, '0'); let codec;
    if (cb.type === 'avcC') codec = 'avc1.' + hx(description[1]) + hx(description[2]) + hx(description[3]);
    else { const b1 = description[1], space = ['', 'A', 'B', 'C'][b1 >> 6], tier = (b1 >> 5) & 1, prof = b1 & 31; let compat = (description[2] << 24 | description[3] << 16 | description[4] << 8 | description[5]) >>> 0, rev = 0; for (let i = 0; i < 32; i++) { rev = (rev << 1 | (compat & 1)) >>> 0; compat >>>= 1; }
      const cons = Array.from(description.slice(6, 12)); while (cons.length && cons[cons.length - 1] === 0) cons.pop();
      codec = (ent.type === 'hev1' || ent.type === 'dvhe' ? 'hev1' : 'hvc1') + '.' + space + prof + '.' + rev.toString(16) + '.' + (tier ? 'H' : 'L') + description[12] + cons.map(c => '.' + c.toString(16)).join(''); }
    const timescale = v.getUint32(mdhd.a + (v.getUint8(mdhd.a) === 1 ? 20 : 12)); const tkhd = find(tk, 'tkhd'); let ang = 0; if (tkhd) { const mo = tkhd.a + (v.getUint8(tkhd.a) === 1 ? 52 : 40); ang = Math.round(Math.atan2(v.getInt32(mo + 4), v.getInt32(mo)) * 180 / Math.PI); ang = ((ang % 360) + 360) % 360; }
    const stsz = find(sk, 'stsz'), stco = find(sk, 'stco'), co64 = find(sk, 'co64'), stsc = find(sk, 'stsc'), stts = find(sk, 'stts'), ctts = find(sk, 'ctts'), stss = find(sk, 'stss'); if (!stsz || !(stco || co64) || !stsc || !stts) continue;
    const uni = v.getUint32(stsz.a + 4), n = v.getUint32(stsz.a + 8); if (!n || n > 5e6) continue; const size = new Uint32Array(n); for (let i = 0; i < n; i++) size[i] = uni || v.getUint32(stsz.a + 12 + 4 * i);
    const co = stco || co64, nc = v.getUint32(co.a + 4), chunk = new Float64Array(nc); for (let i = 0; i < nc; i++) chunk[i] = stco ? v.getUint32(co.a + 8 + 4 * i) : v.getUint32(co.a + 8 + 8 * i) * 4294967296 + v.getUint32(co.a + 12 + 8 * i);
    const offset = new Float64Array(n), ne = v.getUint32(stsc.a + 4); let si = 0;
    for (let e = 0; e < ne && si < n; e++) { const first = v.getUint32(stsc.a + 8 + 12 * e), per = v.getUint32(stsc.a + 12 + 12 * e), next = e + 1 < ne ? v.getUint32(stsc.a + 8 + 12 * (e + 1)) : nc + 1; if (!per || first < 1) break;
      for (let c = first; c < next && c <= nc && si < n; c++) { let o = chunk[c - 1]; for (let k = 0; k < per && si < n; k++) { offset[si] = o; o += size[si]; si++; } } }
    if (si < n) continue;
    const dts = new Float64Array(n), cts = new Float64Array(n), nt = v.getUint32(stts.a + 4); let ti = 0, tt = 0; for (let e = 0; e < nt && ti < n; e++) { const cnt = v.getUint32(stts.a + 8 + 8 * e), d = v.getUint32(stts.a + 12 + 8 * e); for (let k = 0; k < cnt && ti < n; k++) { dts[ti++] = tt; tt += d; } } for (; ti < n; ti++) dts[ti] = tt;
    cts.set(dts); if (ctts) { const nn = v.getUint32(ctts.a + 4); let ci = 0; for (let e = 0; e < nn && ci < n; e++) { const cnt = v.getUint32(ctts.a + 8 + 8 * e), d = v.getInt32(ctts.a + 12 + 8 * e); for (let k = 0; k < cnt && ci < n; k++) cts[ci++] += d; } }
    const sync = new Uint8Array(n); if (stss) { const ns = v.getUint32(stss.a + 4); for (let i = 0; i < ns; i++) { const k = v.getUint32(stss.a + 8 + 4 * i); if (k >= 1 && k <= n) sync[k - 1] = 1; } } else sync.fill(1);
    let cmin = Infinity; for (let i = 0; i < Math.min(n, 64); i++) if (cts[i] < cmin) cmin = cts[i];
    return { codec, description, width, height, ang, timescale, n, size, offset, dts, cts, sync, cmin, duration: tt / timescale, summary }; }
  throw new Error('no usable video track (' + summary.join(',') + ')');
}
export async function decodeDirect(file, info, onFrame, onProgress, signal) {
  const m = await parseMp4(file), { W, H } = info, fps = m.n / (m.duration || info.duration), stride = fps > 75 ? Math.round(fps / 60) : 1; info.fps = fps / stride;
  const turned = (m.width > m.height) !== (W > H) && W !== H, rot = turned ? (m.ang === 270 ? 270 : 90) : (m.ang === 180 ? 180 : 0);
  globalThis.__crumb?.('direct ' + m.summary.join(',') + ' ' + m.codec + ' ' + m.width + 'x' + m.height + ' samples ' + m.n + ' fps ' + fps.toFixed(1) + ' rot ' + rot);
  const cfg = { codec: m.codec, codedWidth: m.width, codedHeight: m.height, description: m.description }, sup = await VideoDecoder.isConfigSupported(cfg); globalThis.__crumb?.('codec supported ' + sup.supported); if (!sup.supported) throw new Error('codec');
  // two ways to get the pixels of a frame: a canvas kept in memory, or one on the graphics card read back afterwards. Which is faster depends on the machine and the video (10-bit phone video decoded by the graphics card is very slow the first way), so both are timed on the first frames.
  const mk = soft => { const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }); return c.getContext('2d', soft ? { willReadFrequently: true } : {}); };
  const ctxs = [mk(true), mk(false)], cost = [0, 0], tried = [0, 0]; let pick = -1, ctx = ctxs[0];
  let failed = null, pending = 0, count = 0, wake = null;
  const dec = new VideoDecoder({ error: e => { failed = e; globalThis.__crumb?.('decoder error ' + e.message); if (wake) { const w = wake; wake = null; w(); } }, output: fr => { try {
      const which = pick >= 0 ? pick : (count >> 1) % 2, tr = performance.now(); ctx = ctxs[which];
      if (count % stride === 0) { ctx.save();
        if (rot === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(fr, 0, 0, H, W); } else if (rot === 270) { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); ctx.drawImage(fr, 0, 0, H, W); }
        else if (rot === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); ctx.drawImage(fr, 0, 0, W, H); } else ctx.drawImage(fr, 0, 0, W, H);
        ctx.restore(); const im = ctx.getImageData(0, 0, W, H);
        if (pick < 0 && count >= 4) { cost[which] += performance.now() - tr; tried[which]++; if (tried[0] >= 6 && tried[1] >= 6) { pick = cost[1] / tried[1] < 0.8 * cost[0] / tried[0] ? 1 : 0; globalThis.__crumb?.('pixels: memory canvas ' + (cost[0] / tried[0]).toFixed(1) + 'ms, graphics canvas ' + (cost[1] / tried[1]).toFixed(1) + 'ms per frame, using ' + (pick ? 'graphics' : 'memory')); } }
        onFrame(im, fr.timestamp / 1e6); }
      if (count === 0 || count % 300 === 0) globalThis.__crumb?.('frame ' + count + ' ' + fr.format + ' pending ' + pending);
      count++; onProgress(count / m.n); } catch (e) { failed = e; } finally { fr.close(); pending--; if (wake) { const w = wake; wake = null; w(); } } } });
  dec.configure(cfg);
  let lastOut = performance.now(), lastCount = 0, phase = '', stalled = false; const dog = setInterval(() => { if (count !== lastCount) { lastCount = count; lastOut = performance.now(); } else if (performance.now() - lastOut > 15000) { globalThis.__crumb?.('stalled at sample ' + i + '/' + m.n + ' frames out ' + count + ' pending ' + pending + ' queue ' + dec.decodeQueueSize + ' state ' + dec.state + ' phase ' + phase); lastOut = performance.now(); stalled = true; } }, 5000);
  let win = null, w0 = 0, i = 0; info.state = () => 'sample ' + i + '/' + m.n + ' out ' + count + ' pending ' + pending + ' queue ' + dec.decodeQueueSize + ' ' + dec.state + ' ' + phase + (failed ? ' failed ' + failed.message : ''); while (i < m.n && !m.sync[i]) i++; // decoding has to start on a key frame
  for (; i < m.n; i++) { if (signal?.aborted) { try { dec.close(); } catch (e) {} throw new Error('aborted'); } if (failed) throw failed; const o = m.offset[i], sz = m.size[i]; if (!sz) continue;
    if (!win || o < w0 || o + sz > w0 + win.byteLength) { phase = 'read ' + o; w0 = o; win = new Uint8Array(await file.slice(o, o + Math.max(sz, 4 * 1024 * 1024)).arrayBuffer()); if (win.byteLength < sz) break; }
    phase = 'decode'; pending++; dec.decode(new EncodedVideoChunk({ type: m.sync[i] ? 'key' : 'delta', timestamp: Math.round((m.cts[i] - m.cmin) * 1e6 / m.timescale), data: win.subarray(o - w0, o - w0 + sz) }));
    // wait for the decoder without timers: browsers slow timers down to one per minute in a tab left in the background, which would stall a long analysis
    phase = 'wait'; let limit = 24; while (pending > limit && !failed) { const before = count; await new Promise(r => { wake = r; setTimeout(r, 3000); }); if (count === before && dec.decodeQueueSize === 0 && limit < 96) limit += 8; } // nothing came out although the decoder is idle: it wants more input first
  }
  phase = 'flush'; await dec.flush(); clearInterval(dog); dec.close(); if (failed) throw failed; return count;
}
export async function decodeAll(file, info, onFrame, onProgress, signal) {
  if (typeof VideoDecoder !== 'undefined' && typeof MP4Box !== 'undefined') { let got = 0; const wrap = (im, t) => { got++; onFrame(im, t); };
    let direct = true; try { return { frames: await decodeDirect(file, info, wrap, onProgress, signal), fast: true }; } catch (e) { if (e.message === 'aborted' || got > 0) throw e; globalThis.__crumb?.('direct failed: ' + e.message); console.warn('direct reader failed', e); if (e.message === 'codec') direct = false; }
    if (direct && file.size < 6e8) try { return { frames: await decodeWebCodecs(file, info, wrap, onProgress, signal), fast: true }; } catch (e) { if (e.message === 'aborted' || got > 0) throw e; console.warn('WebCodecs path failed, using playback', e); } }
  return { frames: await decodePlayback(file, info, onFrame, onProgress, signal), fast: false };
}
