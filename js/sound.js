// Racket hits heard in the sound track. A racket meeting the ball makes a short, sharp click, well above the hum of wind, traffic
// and voices: the sound is filtered above 1.5 kHz, its level taken every 5 ms, and a click is a sudden jump far above the level of
// the second around it. The clicks only say WHEN something was struck (the near player, the opponent, a ball on the ground, the
// next court); the picture says what it was. Used by the engine to rescue shots whose first pictures were lost (near the camera the
// ball leaves the racket blurred, behind the player or out of the picture), see `clicks` in analyze().
import { parseMp4 } from './decode.js';

const HOP_S = 0.005;
// A level meter over a stream of mono samples: two second-order high-pass sections (Butterworth, 1.5 kHz) and the RMS of every 5 ms.
export function meter(rate) { const w = Math.tan(Math.PI * 1500 / rate), q = Math.SQRT1_2, n = 1 / (1 + w / q + w * w), b0 = n, b1 = -2 * n, b2 = n, a1 = 2 * (w * w - 1) * n, a2 = (1 - w / q + w * w) * n;
  const st = new Float64Array(4), hop = Math.round(rate * HOP_S); let acc = 0, k = 0; const out = [];
  return { hop, out, push(x, len) { let z0 = st[0], z1 = st[1], y0 = st[2], y1 = st[3];
    for (let i = 0; i < len; i++) { const a = x[i], u = b0 * a + z0; z0 = b1 * a - a1 * u + z1; z1 = b2 * a - a2 * u; const v = b0 * u + y0; y0 = b1 * u - a1 * v + y1; y1 = b2 * u - a2 * v; // two sections, transposed direct form
      acc += v * v; if (++k === hop) { out.push(10 * Math.log10(acc / hop + 1e-14)); acc = 0; k = 0; } }
    st[0] = z0; st[1] = z1; st[2] = y0; st[3] = y1; } }; }
// Clicks from the levels: above the running median of the surrounding second by 14 dB, and a jump of at least 8 dB over 10-20 ms before; at most one every quarter second.
export function clicksFromLevels(db, t0 = 0) { const n = db.length, bg = new Float32Array(n), W = 100; let cur = -100;
  for (let i = 0; i < n; i++) { if (i % 20 === 0) { const a = db.slice(Math.max(0, i - W), Math.min(n, i + W + 1)).sort((p, q) => p - q); cur = a[a.length >> 1]; } bg[i] = cur; }
  const c = []; for (let i = 4; i < n; i++) { const rise = db[i] - Math.max(db[i - 2], db[i - 3], db[i - 4]), sc = Math.min(db[i] - bg[i], rise + 6); if (sc >= 14) c.push([i, sc]); }
  c.sort((a, b) => b[1] - a[1]); const taken = [], gap = Math.round(0.25 / HOP_S); for (const [i, sc] of c) if (!taken.some(q => Math.abs(q[0] - i) < gap)) taken.push([i, sc]);
  return taken.sort((a, b) => a[0] - b[0]).map(([i, sc]) => ({ t: +(t0 + i * HOP_S).toFixed(3), s: +sc.toFixed(1), db: +db[i].toFixed(1) })); }

// Plain (uncompressed) sound, as phones store it in .MOV files: read chunk by chunk, all channels mixed.
async function pcmLevels(a, file, signal) { const m = meter(a.rate), fb = a.uni, bps = a.bits / 8, ch = a.ch, nc = a.chunk.length; let mono = new Float32Array(0);
  for (let c = 0; c < nc; ) { if (signal && signal.aborted) throw new Error('aborted'); let c2 = c, bytes = 0; while (c2 < nc && bytes < 8e6 && (c2 === c || a.chunk[c2] === a.chunk[c2 - 1] + (a.first[c2] - a.first[c2 - 1]) * fb)) { bytes += (a.first[c2 + 1] - a.first[c2]) * fb; c2++; }
    const buf = await file.slice(a.chunk[c], a.chunk[c] + bytes).arrayBuffer(), v = new DataView(buf), ns = Math.floor(bytes / fb), le = !a.big; if (mono.length < ns) mono = new Float32Array(ns);
    for (let i = 0; i < ns; i++) { let s = 0; for (let k = 0; k < ch; k++) { const o = i * fb + k * bps; s += a.flt ? (bps === 8 ? v.getFloat64(o, le) : v.getFloat32(o, le)) : bps === 2 ? v.getInt16(o, le) / 32768 : bps === 3 ? (le ? (v.getInt8(o + 2) << 16 | v.getUint8(o + 1) << 8 | v.getUint8(o)) : (v.getInt8(o) << 16 | v.getUint8(o + 1) << 8 | v.getUint8(o + 2))) / 8388608 : bps === 4 ? v.getInt32(o, le) / 2147483648 : (v.getUint8(o) - 128) / 128; } mono[i] = s / ch; }
    m.push(mono, ns); c = c2; await new Promise(r => setTimeout(r, 0)); }
  return { db: m.out, t0: 0 }; }
// AAC (most .MP4 files): the decoder setup is the AudioSpecificConfig inside the esds box of the sound description.
function aacConfig(raw) { for (let i = 0; i + 8 < raw.length; i++) if (raw[i] === 101 && raw[i + 1] === 115 && raw[i + 2] === 100 && raw[i + 3] === 115) { // 'esds'
    let p = i + 8; const len = () => { let l = 0; for (let k = 0; k < 4; k++) { const b = raw[p++]; l = l << 7 | b & 127; if (!(b & 128)) break; } return l; };
    if (raw[p++] !== 3) return null; len(); p += 2; const fl = raw[p++]; if (fl & 128) p += 2; if (fl & 64) p += 1 + raw[p]; if (fl & 32) p += 2;
    if (raw[p++] !== 4) return null; len(); const ot = raw[p]; p += 13; if (raw[p++] !== 5) return null; const l = len(), asc = raw.slice(p, p + l); if (!asc.length) return null;
    const aot = asc[0] >> 3, fi = (asc[0] & 7) << 1 | asc[1] >> 7, chc = asc[1] >> 3 & 15, rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (ot !== 0x40 || fi > 12) return null; return { codec: 'mp4a.40.' + aot, sampleRate: rates[fi], numberOfChannels: Math.max(1, chc), description: asc }; } return null; }
async function aacLevels(a, file, signal) { if (typeof AudioDecoder === 'undefined') return null; const cfg = aacConfig(a.stsdRaw); if (!cfg) return null; try { if (!(await AudioDecoder.isConfigSupported(cfg)).supported) return null; } catch (e) { return null; }
  const m = meter(cfg.sampleRate); let mono = new Float32Array(0), firstT = null, err = null, tmp = new Float32Array(0);
  const dec = new AudioDecoder({ output: d => { try { const n = d.numberOfFrames, ch = d.numberOfChannels; if (firstT == null) firstT = d.timestamp / 1e6; if (mono.length < n) { mono = new Float32Array(n); tmp = new Float32Array(n); } mono.fill(0, 0, n);
      for (let k = 0; k < ch; k++) { d.copyTo(tmp, { planeIndex: k, format: 'f32-planar', frameCount: n }); for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch; } m.push(mono, n); } catch (e) { err = e; } finally { d.close(); } }, error: e => { err = e; } });
  dec.configure(cfg); const ts = a.timescale;
  for (let i = 0; i < a.n; ) { if (signal && signal.aborted) { dec.close(); throw new Error('aborted'); } if (err) break; let j = i; const lo = a.offset[i]; let hi = lo; while (j < a.n && a.offset[j] + a.size[j] - lo < 4e6 && a.offset[j] >= lo) { hi = Math.max(hi, a.offset[j] + a.size[j]); j++; } if (j === i) { hi = a.offset[i] + a.size[i]; j = i + 1; }
    const buf = new Uint8Array(await file.slice(lo, hi).arrayBuffer()); for (let k = i; k < j; k++) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(a.dts[k] / ts * 1e6), duration: Math.round((a.dts[k + 1] - a.dts[k]) / ts * 1e6), data: buf.subarray(a.offset[k] - lo, a.offset[k] - lo + a.size[k]) }));
    i = j; if (dec.decodeQueueSize > 200) await dec.flush(); }
  if (!err) await dec.flush(); try { dec.close(); } catch (e) {} if (err && !m.out.length) return null; return { db: m.out, t0: firstT || 0 }; }
// Returns [{t (seconds on the picture clock), s (how sharp, dB), db (level)}], or null when the file has no sound that can be read here.
export async function findClicks(file, { signal } = {}) { const mp = await parseMp4(file), a = mp.audio; if (!a) return null;
  const L = a.pcm ? (a.bits === 8 || a.bits === 16 || a.bits === 24 || a.bits === 32 || a.flt ? await pcmLevels(a, file, signal) : null) : await aacLevels(a, file, signal); if (!L || L.db.length < 400) return null;
  const cl = clicksFromLevels(L.db, a.edits ? L.t0 : L.t0 - (a.skip || 0) / a.timescale); if (!a.edits) return cl;
  return toPicture(cl, a.edits, mp.zero || 0); }
// Sound media time to the picture clock: through the sound's edit list to the movie's time, then to the pictures' 0. A click in no stretch that is played (cut away by the file's own edits) is dropped.
export function toPicture(clicks, edits, zero) { const ed = edits.filter(e => e[2] >= 0), out = []; for (const c of clicks) { const e = ed.find(x => c.t >= x[2] - 1e-6 && c.t < x[2] + x[1] + 1e-6); if (!e) continue; out.push({ ...c, t: +(e[0] + c.t - e[2] - zero).toFixed(3) }); } return out; }
