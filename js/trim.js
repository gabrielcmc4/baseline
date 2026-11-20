// Cut a video down to its shots without re-encoding: the output keeps the original pictures bit for bit, only the stretches between shots are left out.
// Works on whole groups of pictures (from one key frame to the next), so a cut can start up to about a second earlier than asked. Picture only, no sound.
import { parseMp4 } from './decode.js';
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const u64 = n => { const b = new Uint8Array(8), d = new DataView(b.buffer); d.setUint32(0, Math.floor(n / 4294967296)); d.setUint32(4, n >>> 0); return b; };
const cat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const box = (type, ...parts) => { const body = cat(parts), o = new Uint8Array(8 + body.length); new DataView(o.buffer).setUint32(0, o.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i); o.set(body, 8); return o; };
const full = (type, ver, flags, ...parts) => box(type, new Uint8Array([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
// shots: [{t, tLand}] in seconds on the analysis clock (0 = first picture). Returns { blob, segments, seconds, pictures }.
export async function trimVideo(file, shots, { before = 2, after = 2 } = {}) {
  const m = await parseMp4(file), ts = m.timescale, ptime = new Float64Array(m.n); { let last = 0; for (let i = 0; i < m.n; i++) { if (m.pres[i] >= 0) last = m.pres[i]; ptime[i] = last; } } const sec = i => ptime[i]; // the player's clock (the shots are timed on it); a picture the file hides takes the time of the shown one before it
  const want = shots.map(q => [q.t - before, (q.t + Math.max(0.3, Math.min(6, q.tLand || 1))) + after]).sort((a, b) => a[0] - b[0]), merged = [];
  for (const w of want) { const l = merged[merged.length - 1]; if (l && w[0] <= l[1] + 0.5) l[1] = Math.max(l[1], w[1]); else merged.push(w.slice()); }
  const keys = []; for (let i = 0; i < m.n; i++) if (m.sync[i]) keys.push(i); if (!keys.length) throw new Error('no key frames');
  const segs = []; for (const [a, b] of merged) { let k0 = 0; while (k0 + 1 < keys.length && (m.edits || m.dts[keys[k0 + 1]] / ts <= Math.max(0, a) + (m.cts[0] - m.dts[0] - m.cmin) / ts + 1e-6) && sec(keys[k0 + 1]) <= Math.max(0, a)) k0++;
    let k1 = k0 + 1; while (k1 < keys.length && sec(keys[k1]) < b) k1++; const i0 = keys[k0], i1 = k1 < keys.length ? keys[k1] : m.n; const l = segs[segs.length - 1]; if (l && i0 <= l[1]) l[1] = Math.max(l[1], i1); else segs.push([i0, i1]); }
  if (!segs.length) throw new Error('nothing to keep');
  // picture data: one slice of the original file per kept stretch (whatever lies between its pictures, such as sound, simply rides along unused)
  const parts = [], sizes = [], offs = [], durs = [], ctso = [], syncs = [], vis = []; let pos = 0, minC = Infinity; const HEAD = 8 + 24 + 16; // ftyp (32 bytes) + mdat header (16)
  const blobs = []; for (const [i0, i1] of segs) { let lo = Infinity, hi = 0; for (let i = i0; i < i1; i++) { if (m.offset[i] < lo) lo = m.offset[i]; if (m.offset[i] + m.size[i] > hi) hi = m.offset[i] + m.size[i]; }
    blobs.push(file.slice(lo, hi)); for (let i = i0; i < i1; i++) { sizes.push(m.size[i]); offs.push(HEAD + pos + m.offset[i] - lo); durs.push(i + 1 < m.n ? Math.max(1, m.dts[i + 1] - m.dts[i]) : Math.max(1, Math.round(ts / 60))); const c = m.cts[i] - m.dts[i]; ctso.push(c); if (c < minC) minC = c; syncs.push(m.sync[i]); vis.push(m.pres[i] >= 0); } pos += hi - lo; }
  const n = sizes.length, total = durs.reduce((a, b) => a + b, 0); let mv = 1000, dur = Math.round(total * mv / ts), edts = null;
  // The source hides some stored pictures (edit list). They must travel along (later pictures are built on them) but stay hidden: the output gets an edit list of its own naming the stretches to show.
  if (vis.some(x => !x)) { const order = [], oc = new Float64Array(n); let d = 0; for (let i = 0; i < n; i++) { oc[i] = d + ctso[i] - minC; d += durs[i]; order.push(i); } order.sort((p, q) => oc[p] - oc[q]);
    const step = Math.max(1, Math.round(ts / 60)), runs = []; let run = null; for (let k = 0; k < n; k++) { const i = order[k]; if (!vis[i]) { run = null; continue; } const end = k + 1 < n ? Math.min(oc[order[k + 1]], oc[i] + 4 * step) : oc[i] + step; if (run) run[1] = end; else runs.push(run = [oc[i], end]); }
    mv = ts; dur = runs.reduce((a, r) => a + Math.round(r[1] - r[0]), 0); const rows = []; for (const r of runs) rows.push(u32(Math.round(r[1] - r[0])), u32(Math.round(r[0])), u32(0x10000)); edts = box('edts', full('elst', 0, 0, u32(runs.length), cat(rows))); }
  const rle = arr => { const out = []; let k = 0; while (k < arr.length) { let j = k; while (j < arr.length && arr[j] === arr[k]) j++; out.push(u32(j - k), u32(arr[k])); k = j; } return cat([u32(out.length / 2), cat(out)]); }; // no argument spreading: a phone video with uneven frame gaps gives tens of thousands of entries
  const stts = full('stts', 0, 0, rle(durs)), ctts = full('ctts', 0, 0, rle(ctso.map(c => c - minC)));
  const ss = []; for (let i = 0; i < n; i++) if (syncs[i]) ss.push(u32(i + 1)); const stss = full('stss', 0, 0, u32(ss.length), cat(ss));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)), stsz = full('stsz', 0, 0, u32(0), u32(n), cat(sizes.map(u32))), co64 = full('co64', 0, 0, u32(n), cat(offs.map(u64)));
  const stbl = box('stbl', m.stsdRaw, stts, ctts, stss, stsc, stsz, co64);
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), minf = box('minf', full('vmhd', 0, 1, new Uint8Array(8)), dinf, stbl);
  const hdlr = full('hdlr', 0, 0, u32(0), new Uint8Array([118, 105, 100, 101]), new Uint8Array(12), new Uint8Array([86, 105, 100, 101, 111, 0]));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(total), new Uint8Array([0x55, 0xc4, 0, 0])), mdia = box('mdia', mdhd, hdlr, minf);
  const ident = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(dur), new Uint8Array(8), new Uint8Array(8), m.matrix || ident, m.tkwh || cat([u32(m.width << 16), u32(m.height << 16)]));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(mv), u32(dur), u32(0x10000), new Uint8Array([1, 0, 0, 0]), new Uint8Array(8), ident, new Uint8Array(24), u32(2));
  const moov = edts ? box('moov', mvhd, box('trak', tkhd, edts, mdia)) : box('moov', mvhd, box('trak', tkhd, mdia));
  const ftyp = box('ftyp', new Uint8Array([105, 115, 111, 109]), u32(512), new Uint8Array([105, 115, 111, 109, 105, 115, 111, 50, 109, 112, 52, 49])); // isom, 512, isom iso2 mp41 -> 8+4+4+12 = 28 ... padded below to 32
  const pad = box('free'); const head = cat([ftyp, pad.subarray(0, 0)]); // keep sizes explicit
  const ftypLen = ftyp.length, mdatHead = cat([u32(1), new Uint8Array([109, 100, 97, 116]), u64(16 + pos)]);
  const shift = ftypLen + 16 - HEAD; if (shift) { const dv = new DataView(co64.buffer, co64.byteOffset); for (let i = 0; i < n; i++) { const o = offs[i] + shift; dv.setUint32(16 + 8 * i, Math.floor(o / 4294967296)); dv.setUint32(20 + 8 * i, o >>> 0); } }
  const moov2 = shift ? box('moov', mvhd, box('trak', tkhd, ...(edts ? [edts] : []), box('mdia', mdhd, hdlr, box('minf', full('vmhd', 0, 1, new Uint8Array(8)), dinf, box('stbl', m.stsdRaw, stts, ctts, stss, stsc, stsz, co64))))) : moov;
  return { blob: new Blob([head, mdatHead, ...blobs, moov2], { type: 'video/mp4' }), segments: segs.length, seconds: edts ? dur / mv : total / ts, pictures: n }; }
