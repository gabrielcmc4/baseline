// Reads every frame of a video file in the browser. WebCodecs + mp4box when possible, <video> playback otherwise.
const MAX_SIDE = 1600;
function loadVideo(file) { return new Promise((res, rej) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
  v.onloadedmetadata = () => res(v); v.onerror = () => rej(new Error('unsupported')); }); }
export async function probe(file) { const v = await loadVideo(file); const sc = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
  return { video: v, W: Math.round(v.videoWidth * sc / 2) * 2, H: Math.round(v.videoHeight * sc / 2) * 2, duration: v.duration }; }
export async function grabFrame(info, t) { const v = info.video; await new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = Math.min(Math.max(0, t), Math.max(0, info.duration - 0.05)); setTimeout(done, 4000); });
  const c = document.createElement('canvas'); c.width = info.W; c.height = info.H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 0, info.W, info.H); return x.getImageData(0, 0, info.W, info.H); }

function description(mp4, track) { const trak = mp4.getTrackById(track.id);
  for (const e of trak.mdia.minf.stbl.stsd.entries) { const box = e.avcC || e.hvcC || e.vpcC || e.av1C; if (box) { const st = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(st); return new Uint8Array(st.buffer, 8); } } return undefined; }

async function decodeWebCodecs(file, info, onFrame, onProgress, signal) {
  const { W, H } = info, canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const mp4 = MP4Box.createFile(); let track = null, ready = false, failed = null, pending = 0, count = 0, stride = 1, total = 0, rot = 0; const queue = [];
  const dec = new VideoDecoder({ error: e => { failed = e; }, output: fr => { try {
      if (count % stride === 0) { ctx.save();
        if (rot === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(fr, 0, 0, H, W); } else if (rot === 270) { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); ctx.drawImage(fr, 0, 0, H, W); }
        else if (rot === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); ctx.drawImage(fr, 0, 0, W, H); } else ctx.drawImage(fr, 0, 0, W, H);
        ctx.restore(); onFrame(ctx.getImageData(0, 0, W, H), fr.timestamp / 1e6); }
      count++; if (total) onProgress(count / total); } catch (e) { failed = e; } finally { fr.close(); pending--; } } });
  let cfgPromise = null;
  mp4.onError = e => { failed = new Error(e); };
  mp4.onReady = inf => { track = inf.videoTracks[0]; if (!track) { failed = new Error('no video track'); return; } total = track.nb_samples;
    const fps = track.nb_samples / (track.movie_duration / track.movie_timescale || info.duration); stride = fps > 75 ? Math.round(fps / 60) : 1; info.fps = fps / stride;
    const m = track.matrix; let ang = m ? Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI) : 0; ang = ((ang % 360) + 360) % 360;
    const turned = (track.video.width > track.video.height) !== (W > H) && W !== H; rot = turned ? (ang === 270 ? 270 : 90) : (ang === 180 ? 180 : 0);
    const cfg = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description: description(mp4, track) };
    cfgPromise = VideoDecoder.isConfigSupported(cfg).then(s => { if (!s.supported) throw new Error('codec'); dec.configure(cfg); mp4.setExtractionOptions(track.id, null, { nbSamples: 30 }); mp4.start(); ready = true; }); };
  let lastNo = -1; mp4.onSamples = (id, user, samples) => { for (const s of samples) { if (s.number <= lastNo) continue; lastNo = s.number; queue.push(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: s.data })); } mp4.releaseUsedSamples(id, samples[samples.length - 1].number); };
  const CH = 2 * 1024 * 1024; let pos = 0, jumped = false;
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
export async function decodeAll(file, info, onFrame, onProgress, signal) {
  if (typeof VideoDecoder !== 'undefined' && typeof MP4Box !== 'undefined') { let got = 0; const wrap = (im, t) => { got++; onFrame(im, t); };
    try { return { frames: await decodeWebCodecs(file, info, wrap, onProgress, signal), fast: true }; } catch (e) { if (e.message === 'aborted' || got > 0) throw e; console.warn('WebCodecs path failed, using playback', e); } }
  return { frames: await decodePlayback(file, info, onFrame, onProgress, signal), fast: false };
}
