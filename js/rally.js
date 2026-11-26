// Rallies: which shots belong together, and which balls were only sent back between points.
// The rule (Gabriel's): in a rally the ball bounces at most once between one player's hit and the other's. Each shot's
// fitted flight says when it came down and how fast; after the bounce the ball rises and falls again, and the time to the
// second bounce follows from that (vertical speed kept by the bounce, gravity). A hit by the other player after that moment
// means the ball bounced twice: the rally was already over, and that hit starts something new.
// In a match a new rally starts with a serve; a ball that starts nothing (not a serve, and nobody plays it back after one
// bounce) was hit between points: sending the ball back, or knocking it to the side.
const G = 9.81, E_BOUNCE = 0.78, MARGIN = 0.2; // vertical speed kept by a hard court bounce; slack for the fitted bounce time and the hit time
const hitTime = s => s.far ? (s.tHit != null ? s.tHit : s.t - 0.5) : s.t;
const side = s => s.far ? 'far' : 'near'; // who hit it: the player at the far end (ball towards the camera) or the near one
// when the ball came down, and when it would come down a second time
export function bounces(s) { if (!s.tLand || !s.path || s.path.length < 3) return null; const n = s.path.length, a = s.path[n - 3], b = s.path[n - 2], vz = (b[2] - a[2]) * 60; // flight path points are 1/60 s apart, the last one is the landing itself
  const t1 = s.t + s.tLand, up = E_BOUNCE * Math.max(1, -vz); return { t1, t2: t1 + 2 * up / G }; }
// shots: as analyze() returns them. mode: 'match' (rallies start with a serve), otherwise rallies may start with any hit (lessons, drills).
export function findRallies(shots, mode = 'match') {
  const hs = shots.filter(s => s.result !== undefined).map(s => ({ s, t: hitTime(s), who: side(s), b: bounces(s) })).sort((p, q) => p.t - q.t);
  const groups = []; let cur = null;
  for (const h of hs) { const p = cur && cur[cur.length - 1];
    let keep = false;
    if (p && !h.s.serve) {
      if (p.who !== h.who) keep = h.t - p.t > 0.3 && (p.s.result === 'in' || p.s.result === undefined) && (!p.b || h.t <= p.b.t2 + MARGIN); // the other player hit it back before a second bounce
      else keep = h.t - p.t < 3.6 && p.b && h.t > p.b.t1; // the same player twice: the other's hit in between was missed (not seen), if it came in time
    }
    if (keep) cur.push(h); else { cur = [h]; groups.push(cur); } }
  const out = []; for (const g of groups) { const first = g[0].s, solo = g.length === 1;
    const between = mode === 'match' && solo && !first.serve && first.far; // a lone ball from the far end that is not a serve: sent back between points (a lone ball of the near player is kept: his own serve may not have been recognised)
    for (const h of g) { h.s.rally = between ? null : out.length; h.s.between = between; }
    if (between) continue;
    let missed = 0; for (let i = 1; i < g.length; i++) if (g[i].who === g[i - 1].who) missed++;
    const last = g[g.length - 1];
    out.push({ n: out.length, start: g[0].t, end: (last.b ? last.b.t1 : last.t + 1), shots: g.length + missed, seen: g.length, missed, serve: !!first.serve,
      endedBy: last.s.result === 'in' ? 'in' : last.s.result, lastBy: last.who, fastest: Math.max(...g.map(h => h.s.speed || 0)), mean: g.reduce((a, h) => a + (h.s.speed || 0), 0) / g.length, idx: g.map(h => shots.indexOf(h.s)) }); }
  return out; }
