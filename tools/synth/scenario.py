"""Builds a timeline of rallies with an answer key.

A scene is a list of points; each point is a list of shots. Every shot is simulated by sim.py from
the hitter's contact point to the next contact (or until the ball dies). The answer key keeps, per
shot: hit time, side, contact point, speed (km/h, at the racket), spin (rpm), landing point and
time, net clearance, result (in / long / wide / net), volley.

Players move between keyframes (ready position -> contact spot -> recovery)."""
import json, math, random
import numpy as np
import sim

C = sim.COURT


def result_of(land, far_hitter, server_x=None):
    """land: bounce point of a ball hit by the near player (far_hitter False) or the far one.
    server_x: for a serve, where the server stood across the court (the ball must land in the box diagonal to him)."""
    x, y = land[0], land[1]
    if server_x is not None:
        ok_y = (C['NET'] - C['SV'] <= y <= C['NET']) if far_hitter else (C['NET'] <= y <= C['NET'] + C['SV'])
        if not ok_y:
            return 'long'
        return 'in' if (x * server_x <= 0 and abs(x) <= C['S']) else 'wide'
    if abs(x) > C['S']:
        over = (y - C['LEN']) if not far_hitter else -y
        return 'long' if over > 0 and over > abs(x) - C['S'] else 'wide'
    if not far_hitter and y > C['LEN']:
        return 'long'
    if far_hitter and y < 0:
        return 'long'
    if (not far_hitter and y < C['NET']) or (far_hitter and y > C['NET']):
        return 'short?'
    return 'in'


class Scene:
    def __init__(self, seed=1, fps=60):
        self.rng = random.Random(seed)
        self.fps = fps
        self.ball = []          # list of (t, x, y, z) samples, None separators between dead balls
        self.shots = []         # answer key
        self.players = {'near': [], 'far': []}   # keyframes (t, x, y, swing) swing: None or (t_hit, hand, kind)
        self.t = 2.0
        self.extra_balls = []   # (t0, t1, samples) balls from elsewhere (other court)

    # --- player keyframes
    def move(self, who, t, x, y):
        self.players[who].append(dict(t=t, x=x, y=y))

    def swing(self, who, t, kind):
        self.players[who].append(dict(t=t, swing=kind))

    # --- one flight
    def flight(self, p0, v0, rpm, t0, until=None, bounces=2, side_rpm=0.0):
        w = sim.spin_vector(v0, rpm, side_rpm)
        out, ev = sim.fly(p0, v0, w, t0=t0, bounces=bounces, t_max=5)
        if until is not None:
            out = [s for s in out if s[0] <= until + 1e-9]
            ev = [e for e in ev if e[1] <= until + 1e-9]
        return out, ev

    def add_samples(self, out):
        for t, p, v, w in out:
            self.ball.append((round(t, 4), float(p[0]), float(p[1]), float(p[2])))

    def gap(self, dt):
        self.ball.append(None)
        self.t += dt

    # --- a point
    def point(self, shots):
        """shots: list of dicts {who, speed, rpm, target:(x,y), serve:+-1|None, volley_at: y or None, side_rpm}
        The first shot starts from the hitter's spot; later shots start where the ball is met.
        Stops early when a ball is not playable (net, out, unreachable)."""
        rng = self.rng
        t = self.t
        ball_p = None
        for i, s in enumerate(shots):
            who = s['who']; far = who == 'far'
            if i == 0:
                if s.get('serve'):
                    sx = s['serve'] * rng.uniform(0.3, 0.9) * (-1 if far else 1)
                    p0 = np.array([sx, C['LEN'] + 0.3 if far else -0.3, rng.uniform(2.55, 2.8)])
                    feet = (sx, p0[1])
                else:
                    p0 = np.array([rng.uniform(-1.5, 1.5), (C['LEN'] + rng.uniform(0.5, 1.5)) if far else -rng.uniform(0.5, 1.5), rng.uniform(0.8, 1.1)])
                    feet = (p0[0] + (0.6 if not far else -0.6), p0[1])
                t_hit = t
            else:
                p0, t_hit, feet = ball_p
            v0 = sim.aim(p0, s['target'], s['speed'], s.get('rpm', 0), s.get('side_rpm', 0.0))
            if v0 is None:
                # unreachable target at that speed: try other speeds, then a shorter target
                tries = [(sp, s['target']) for sp in list(np.arange(s['speed'] - 5, 40, -5)) + list(np.arange(s['speed'] + 5, 170, 5))]
                tx, ty = s['target']
                for dy in (2, 4):
                    tries += [(sp, (tx, ty - dy if not far else ty + dy)) for sp in np.arange(s['speed'], 40, -10)]
                for sp, tg in tries:
                    v0 = sim.aim(p0, tg, sp, s.get('rpm', 0), s.get('side_rpm', 0.0))
                    if v0 is not None:
                        s['speed'] = float(sp); s['target'] = tg; break
            if v0 is None:
                self.t = t_hit + 1.0
                if self.ball and self.ball[-1] is not None:
                    self.t = self.ball[-1][0] + 0.5
                return
            if s.get('into_net'):
                # lower the elevation until it catches the tape (net-cord / net ball)
                sp = np.linalg.norm(v0)
                for k in range(80):
                    el = math.asin(v0[2] / sp) - math.radians(0.15)
                    hz = math.hypot(v0[0], v0[1])
                    v0 = np.array([v0[0] / hz * sp * math.cos(el), v0[1] / hz * sp * math.cos(el), sp * math.sin(el)])
                    out, ev = self.flight(p0, v0, s.get('rpm', 0), t_hit, bounces=0)
                    if any(e[0] == 'net' for e in ev):
                        break
            if s.get('skim') is not None:
                # lower the elevation until the ball just clears the tape by about s['skim'] metres (net-cord balls that go over)
                sp = np.linalg.norm(v0); best = v0
                for k in range(120):
                    el = math.asin(v0[2] / sp) - math.radians(0.08)
                    hz = math.hypot(v0[0], v0[1])
                    v1 = np.array([v0[0] / hz * sp * math.cos(el), v0[1] / hz * sp * math.cos(el), sp * math.sin(el)])
                    o1, e1 = self.flight(p0, v1, s.get('rpm', 0), t_hit, bounces=0)
                    if any(e[0] == 'net' for e in e1):
                        break
                    v0 = v1; cr1 = [e for e in e1 if e[0] == 'cross']
                    if cr1 and cr1[0][2][2] - sim.R - sim.net_height(cr1[0][2][0]) < s['skim']:
                        break
            if s.get('serve') and i == 0:
                # the toss: from the free hand (1.5 m, a little forward) up about 0.5 m above the contact and back down to it
                top = p0[2] + 0.5; up = math.sqrt(2 * 9.81 * (top - 1.5)); down = math.sqrt(2 * 9.81 * (top - p0[2])); T = (up + down) / 9.81
                hand = np.array([p0[0] - 0.15, p0[1] + (-0.2 if far else 0.2), 1.5]); ts0 = t_hit - T
                self.ball.append(None)
                for k in range(int(T * 240) + 1):
                    tt = k / 240; z = 1.5 + up * tt - 4.905 * tt * tt; f = tt / T
                    self.ball.append((round(ts0 + tt, 4), float(hand[0] + (p0[0] - hand[0]) * f), float(hand[1] + (p0[1] - hand[1]) * f), float(z)))
            out, ev = self.flight(p0, v0, s.get('rpm', 0), t_hit, bounces=2, side_rpm=s.get('side_rpm', 0.0))
            bnc = [e for e in ev if e[0] == 'bounce']; net = [e for e in ev if e[0] == 'net']; cr = [e for e in ev if e[0] == 'cross']
            key = dict(t=round(t_hit, 3), who=who, far=far, p0=[round(float(v), 3) for v in p0], feet=[round(float(feet[0]), 2), round(float(feet[1]), 2)],
                       speed=round(float(np.linalg.norm(v0)) * 3.6, 1), rpm=s.get('rpm', 0), serve=bool(s.get('serve')),
                       volley=bool(s.get('volley')))
            if cr:
                key['clear'] = round(float(cr[0][2][2] - sim.R - sim.net_height(cr[0][2][0])), 3)
            if net:
                key['result'] = 'net'; key['land'] = None
            elif bnc:
                L = bnc[0][2]; key['land'] = [round(float(L[0]), 3), round(float(L[1]), 3)]; key['tLand'] = round(bnc[0][1] - t_hit, 3)
                key['result'] = result_of(L, far, float(p0[0]) if s.get('serve') else None)
            else:
                key['result'] = 'none'
            self.shots.append(key)
            # the hitter's movement and swing
            self.move(who, t_hit - 0.6, feet[0] + (0.3 if far else -0.3), feet[1])
            self.move(who, t_hit, feet[0], feet[1])
            self.swing(who, t_hit, 'serve' if s.get('serve') else ('volley' if s.get('volley') else 'ground'))
            # next contact: the other player meets it
            nxt = shots[i + 1] if i + 1 < len(shots) else None
            if nxt is None or key['result'] != 'in':
                end = (bnc[1][1] + 0.6) if len(bnc) > 1 else (out[-1][0])
                self.add_samples([o for o in out if o[0] <= end])
                self.t = out[-1][0] + 0.5
                return
            other_far = nxt['who'] == 'far'
            meet = None
            if nxt.get('volley_at') is not None:
                yv = nxt['volley_at']
                for o in out:
                    if (o[1][1] - yv) * (1 if other_far else -1) >= 0 and o[0] < bnc[0][1]:
                        meet = o; break
                nxt['volley'] = True
            else:
                past = [o for o in out if o[0] > bnc[0][1] + 0.05]
                zc = rng.uniform(0.85, 1.1); lim = rng.uniform(1.0, 2.2)   # players do not drift further back than ~2 m behind the baseline: deep balls are taken earlier, at the top or on the rise
                for k in range(1, len(past)):
                    py = past[k][1][1]; behind = (py > C['LEN'] + lim) if other_far else (py < -lim)
                    if (past[k][2][2] < 0 and past[k][1][2] <= zc) or (behind and past[k][1][2] > 0.5):
                        meet = past[k]; break
            if meet is None:
                self.add_samples(out); self.t = out[-1][0] + 0.5; return
            self.add_samples([o for o in out if o[0] < meet[0]])
            mp = meet[1].copy()
            ff = (mp[0] + (-0.7 if other_far else 0.7), mp[1] + (0.3 if other_far else -0.3))
            ball_p = (mp, meet[0], ff)
            # the receiver walks to the contact spot from his ready position
            ry = (C['LEN'] + 1.0) if other_far else -1.0
            if nxt.get('volley_at') is not None:
                ry = nxt['volley_at'] + (0.0)
            self.move(nxt['who'], t_hit + 0.2, ff[0] * 0.4, ry if nxt.get('volley_at') is None else ff[1] - (-1.5 if other_far else 1.5))
        self.t = self.ball[-1][0] + 0.5 if self.ball and self.ball[-1] else self.t

    def ready(self, t):
        self.move('near', t, 0.3, -1.0)
        self.move('far', t, -0.3, C['LEN'] + 1.0)

    def dump(self, path, meta):
        json.dump(dict(meta=meta, fps=self.fps, ball=self.ball, shots=self.shots, players=self.players, extra=self.extra_balls), open(path, 'w'))


def rally_scene(seed=1, n_points=6):
    """baseline rallies with a few nets and outs: the bread and butter case"""
    sc = Scene(seed)
    rng = sc.rng
    sc.ready(0)
    for k in range(n_points):
        sc.ready(sc.t - 0.4)
        n = rng.randint(2, 6)
        shots = []
        first_far = rng.random() < 0.5
        for i in range(n):
            who = 'far' if (i % 2 == 0) == first_far else 'near'
            far = who == 'far'
            depth = rng.uniform(17.5, 22.5)
            ty = depth if not far else C['LEN'] - depth
            tx = rng.uniform(-3.6, 3.6)
            last = i == n - 1
            sh = dict(who=who, speed=rng.uniform(75, 125), rpm=rng.uniform(800, 2600), target=(tx, ty))
            if last:
                kind = rng.choice(['long', 'wide', 'net', 'in'])
                if kind == 'long':
                    sh['target'] = (tx, (C['LEN'] + rng.uniform(0.15, 1.5)) if not far else -rng.uniform(0.15, 1.5))
                elif kind == 'wide':
                    sh['target'] = (math.copysign(C['S'] + rng.uniform(0.1, 1.2), tx), ty)
                elif kind == 'net':
                    sh['into_net'] = True
            shots.append(sh)
        sc.point(shots)
        sc.gap(rng.uniform(2.0, 3.5))
    return sc


def volley_scene(seed=2, n_points=6):
    """the near player comes in and volleys (the corner camera case of 27/11)"""
    sc = Scene(seed)
    rng = sc.rng
    sc.ready(0)
    for k in range(n_points):
        sc.ready(sc.t - 0.4)
        shots = [dict(who='far', speed=rng.uniform(70, 95), rpm=rng.uniform(800, 1800), target=(rng.uniform(-2.5, 2.5), rng.uniform(4.0, 7.5))),
                 dict(who='near', speed=rng.uniform(75, 100), rpm=rng.uniform(800, 1800), target=(rng.uniform(-3, 3), rng.uniform(17, 21))),
                 dict(who='far', speed=rng.uniform(70, 100), rpm=rng.uniform(600, 1600), target=(rng.uniform(-3, 3), rng.uniform(3.5, 8.0))),
                 dict(who='near', speed=rng.uniform(55, 90), rpm=rng.uniform(0, 600), target=(rng.uniform(-3.8, 3.8), rng.uniform(15, 21)), volley_at=rng.uniform(8.0, 10.0))]
        sc.point(shots)
        sc.gap(rng.uniform(2.0, 3.0))
    return sc


def serve_scene(seed=3, n_points=12):
    """serves from both ends, both sides, with faults (long, wide, net) and some returns"""
    sc = Scene(seed); rng = sc.rng; sc.ready(0)
    for k in range(n_points):
        sc.ready(sc.t - 0.4)
        far = (k // 4) % 2 == 1; who = 'far' if far else 'near'; side = 1 if k % 2 == 0 else -1
        sx_sign = side * (-1 if far else 1)          # where the server stands across the court
        tx = -sx_sign * rng.uniform(0.4, 3.8)
        depth = rng.uniform(2.5, 6.1)
        ty = (C['NET'] - depth) if far else (C['NET'] + depth)
        kind = rng.random(); sh = dict(who=who, speed=rng.uniform(115, 185), rpm=rng.uniform(400, 2500), target=(tx, ty), serve=side)
        if kind < 0.15:
            sh['target'] = (tx, (C['NET'] - C['SV'] - rng.uniform(0.15, 1.0)) if far else (C['NET'] + C['SV'] + rng.uniform(0.15, 1.0)))
        elif kind < 0.25:
            sh['target'] = (-sx_sign * (C['S'] + rng.uniform(0.1, 0.8)), ty)
        elif kind < 0.35:
            sh['into_net'] = True
        shots = [sh]
        if kind >= 0.35 and rng.random() < 0.6:
            shots.append(dict(who='near' if far else 'far', speed=rng.uniform(70, 110), rpm=rng.uniform(600, 2000), target=(rng.uniform(-3, 3), (rng.uniform(17, 22)) if far else rng.uniform(2, 7))))
        sc.point(shots)
        sc.gap(rng.uniform(2.5, 4.0))
    return sc


def netcord_scene(seed=4, n_points=10):
    """rallies whose last ball is a net cord: into the tape, or just over it"""
    sc = Scene(seed); rng = sc.rng; sc.ready(0)
    for k in range(n_points):
        sc.ready(sc.t - 0.4)
        first_far = rng.random() < 0.5; n = rng.randint(2, 4); shots = []
        for i in range(n):
            who = 'far' if (i % 2 == 0) == first_far else 'near'; far = who == 'far'
            depth = rng.uniform(17.5, 22); sh = dict(who=who, speed=rng.uniform(80, 120), rpm=rng.uniform(800, 2400), target=(rng.uniform(-3.4, 3.4), depth if not far else C['LEN'] - depth))
            if i == n - 1:
                if rng.random() < 0.5: sh['into_net'] = True
                else: sh['skim'] = rng.uniform(0.02, 0.12)
            shots.append(sh)
        sc.point(shots); sc.gap(rng.uniform(2.0, 3.0))
    return sc


def lines_scene(seed=5, n_points=10):
    """balls aimed at the lines: within 20 cm in or out of the baseline or a sideline"""
    sc = Scene(seed); rng = sc.rng; sc.ready(0)
    for k in range(n_points):
        sc.ready(sc.t - 0.4)
        first_far = rng.random() < 0.5; n = rng.randint(2, 4); shots = []
        for i in range(n):
            who = 'far' if (i % 2 == 0) == first_far else 'near'; far = who == 'far'
            depth = rng.uniform(17.5, 21.5); tx = rng.uniform(-3.2, 3.2); ty = depth if not far else C['LEN'] - depth
            if i == n - 1 or rng.random() < 0.3:
                if rng.random() < 0.5: tx = math.copysign(C['S'] + rng.uniform(-0.2, 0.2), tx)
                else: ty = (C['LEN'] + rng.uniform(-0.2, 0.2)) if not far else rng.uniform(-0.2, 0.2)
            shots.append(dict(who=who, speed=rng.uniform(80, 120), rpm=rng.uniform(800, 2400), target=(tx, ty)))
        sc.point(shots); sc.gap(rng.uniform(2.0, 3.0))
    return sc


def add_neighbor(sc, seed=9, ox=2 * C['D'] + 3.6):
    """a rally on the court beside this one, its balls only (no answer key: they must not be reported)"""
    nb = rally_scene(seed, n_points=12)
    segs, cur = [], []
    for b in nb.ball:
        if b is None:
            if cur: segs.append(cur); cur = []
        else:
            cur.append([b[0], b[1] + ox, b[2], b[3]])
    if cur: segs.append(cur)
    sc.extra_balls = [g for g in segs if g[0][0] < sc.t]
    return sc


if __name__ == '__main__':
    import sys
    kind = sys.argv[1] if len(sys.argv) > 1 else 'rally'
    sc = {'rally': rally_scene, 'volley': volley_scene, 'serve': serve_scene, 'netcord': netcord_scene, 'lines': lines_scene}[kind]()
    if '--neighbor' in sys.argv: add_neighbor(sc)
    sys.argv = [a for a in sys.argv if a != '--neighbor']
    sc.dump(sys.argv[2] if len(sys.argv) > 2 else f'/tmp/synth_{kind}.json', dict(kind=kind, mode='match'))
    for s in sc.shots:
        print(s['t'], s['who'], s['speed'], s['result'], s.get('land'), s.get('clear'), 'V' if s['volley'] else '')
    print('duration', round(sc.t, 1))
