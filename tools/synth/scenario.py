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


def result_of(land, far_hitter, serve=None):
    """land: bounce point of a ball hit by the near player (far_hitter False) or the far one."""
    x, y = land[0], land[1]
    if serve:  # service box diagonal to the server; serve = +1 (deuce: server right of centre) or -1
        if far_hitter:
            ok_y = C['NET'] - C['SV'] <= y <= C['NET']
            ok_x = (0 <= -x * serve * -1 <= C['S']) if False else (0 <= x * serve <= C['S'])
        else:
            ok_y = C['NET'] <= y <= C['NET'] + C['SV']
            ok_x = 0 <= -x * serve <= C['S']
        if not ok_y:
            return 'long'
        return 'in' if ok_x else 'wide'
    if abs(x) > C['S']:
        long_ = (y > C['LEN']) if not far_hitter else (y < 0)
        return 'long' if long_ and abs(x) - C['S'] < (y - C['LEN'] if not far_hitter else -y) else 'wide'
    if not far_hitter and (y > C['LEN'] or y < C['NET']):
        return 'long' if y > C['LEN'] else 'short?'
    if far_hitter and (y < 0 or y > C['NET']):
        return 'long' if y < 0 else 'short?'
    return 'in'


class Scene:
    def __init__(self, seed=1, fps=60):
        self.rng = random.Random(seed)
        self.fps = fps
        self.ball = []          # list of (t, x, y, z) samples, None separators between dead balls
        self.shots = []         # answer key
        self.players = {'near': [], 'far': []}   # keyframes (t, x, y, swing) swing: None or (t_hit, hand, kind)
        self.t = 1.0
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
                key['result'] = result_of(L, far, s.get('serve') and (s['serve'] if not far else s['serve']))
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


if __name__ == '__main__':
    import sys
    kind = sys.argv[1] if len(sys.argv) > 1 else 'rally'
    sc = {'rally': rally_scene, 'volley': volley_scene}[kind]()
    sc.dump(sys.argv[2] if len(sys.argv) > 2 else f'/tmp/synth_{kind}.json', dict(kind=kind))
    for s in sc.shots:
        print(s['t'], s['who'], s['speed'], s['result'], s.get('land'), s.get('clear'), 'V' if s['volley'] else '')
    print('duration', round(sc.t, 1))
