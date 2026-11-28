"""Renders a scenario timeline (scenario.py JSON) into an MP4 a phone could have filmed, with
its answer key next to it.

Plain pinhole camera (OpenCV), nothing taken from js/engine.js: Baseline has to find the court
and the camera by itself. What is drawn: sky and trees, fence, green surround, blue court with
5 cm white lines, net (mesh, white tape, posts), two players (legs, body, arms, racket that
swings to the ball), the ball with its shadow and a short exposure blur, sensor noise, H.264.

Options for the hard cases: corner camera, a second court beside this one with its own rally,
balls lying on the court, camera shake."""
import argparse, json, math, subprocess, sys
import numpy as np
import cv2
import sim

C = sim.COURT
BALL = (60, 225, 215)       # BGR yellow-green
SHIRT = {'near': (60, 140, 40), 'far': (30, 30, 30)}
SHORTS = {'near': (40, 40, 40), 'far': (50, 50, 50)}
SKIN = (120, 150, 200)


class Cam:
    def __init__(self, C0, look, W=1920, H=1080, hfov=68.0, roll=0.0):
        self.W, self.H = W, H
        self.f = (W / 2) / math.tan(math.radians(hfov) / 2)
        self.K = np.array([[self.f, 0, W / 2], [0, self.f, H / 2], [0, 0, 1]], float)
        self.set(np.array(C0, float), np.array(look, float), roll)
        self.dist = np.array([0.04, -0.02, 0, 0, 0], float)   # a little barrel, as phone lenses after their own correction

    def set(self, C0, look, roll=0.0):
        self.C = C0
        z = look - C0; z /= np.linalg.norm(z)
        x = np.cross(z, [0, 0, 1.0]); x /= np.linalg.norm(x)
        y = np.cross(z, x)
        Rm = np.stack([x, y, z])
        if roll:
            c, s = math.cos(roll), math.sin(roll)
            Rm = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]) @ Rm
        self.R = Rm
        self.rvec, _ = cv2.Rodrigues(Rm)
        self.t = -Rm @ C0

    def depth(self, P):
        P = np.atleast_2d(np.asarray(P, float))
        return (self.R @ (P - self.C).T)[2]

    def proj(self, P):
        P = np.atleast_2d(np.asarray(P, float))
        uv, _ = cv2.projectPoints(P, self.rvec, self.t, self.K, self.dist)
        return uv.reshape(-1, 2)


def poly(img, cam, pts3, color, ss=4):
    """fill a ground polygon (anti-aliased through sub-pixel shift)"""
    uv = cam.proj(pts3)
    cv2.fillPoly(img, [np.round(uv * (1 << ss)).astype(np.int32)], color, lineType=cv2.LINE_AA, shift=ss)


def seg_poly(a, b, w):
    a, b = np.array(a, float), np.array(b, float)
    d = b - a; d /= np.linalg.norm(d); n = np.array([-d[1], d[0]]) * w / 2
    return [(*(a[:2] + n), 0.0), (*(b[:2] + n), 0.0), (*(b[:2] - n), 0.0), (*(a[:2] - n), 0.0)]


def subdiv(pts, n=12):
    """subdivide polygon edges so the lens distortion bends long lines as it should"""
    out = []
    for i in range(len(pts)):
        a, b = np.array(pts[i], float), np.array(pts[(i + 1) % len(pts)], float)
        for k in range(n):
            out.append(a + (b - a) * k / n)
    return out


def court_layer(img, cam, ox=0.0, colour=(150, 95, 40), seed=0):
    S, D, SV, L, N = C['S'], C['D'], C['SV'], C['LEN'], C['NET']
    poly(img, cam, subdiv([(ox - D - 0.05, -0.05, 0), (ox + D + 0.05, -0.05, 0), (ox + D + 0.05, L + 0.05, 0), (ox - D - 0.05, L + 0.05, 0)]), colour)
    w = 0.05
    lines = [((-D, 0), (D, 0)), ((-D, L), (D, L)), ((-D, 0), (-D, L)), ((D, 0), (D, L)), ((-S, 0), (-S, L)), ((S, 0), (S, L)),
             ((-S, N - SV), (S, N - SV)), ((-S, N + SV), (S, N + SV)), ((0, N - SV), (0, N + SV)), ((0, 0), (0, 0.10)), ((0, L - 0.10), (0, L))]
    for a, b in lines:
        a2, b2 = (a[0] + ox, a[1]), (b[0] + ox, b[1])
        # extend along the line by half a width so corners close
        d = np.array(b2) - np.array(a2); d = d / np.linalg.norm(d) * w / 2
        poly(img, cam, subdiv(seg_poly(np.array(a2) - d, np.array(b2) + d, w), 16), (235, 235, 235))


def net_layer(cam, ox=0.0):
    """RGBA overlay of the net, drawn after things beyond it"""
    W, H = cam.W, cam.H
    over = np.zeros((H, W, 3), np.uint8); alpha = np.zeros((H, W), np.uint8)
    P, N = C['POST'], C['NET']
    xs = np.linspace(-P, P, 120)
    top = [(ox + x, N, sim.net_height(x)) for x in xs]
    bot = [(ox + x, N, 0.0) for x in xs[::-1]]
    uv = cam.proj(top + bot)
    pts = np.round(uv * 16).astype(np.int32)
    cv2.fillPoly(over, [pts], (25, 30, 25), lineType=cv2.LINE_AA, shift=4)
    cv2.fillPoly(alpha, [pts], 120, lineType=cv2.LINE_AA, shift=4)
    # mesh lines
    for z in np.arange(0.045, 1.07, 0.045):
        seg = [(ox + x, N, min(z, sim.net_height(x))) for x in xs]
        uv = np.round(cam.proj(seg) * 16).astype(np.int32)
        cv2.polylines(over, [uv], False, (20, 20, 20), 1, cv2.LINE_AA, shift=4); cv2.polylines(alpha, [uv], False, 170, 1, cv2.LINE_AA, shift=4)
    for x in np.arange(-P, P, 0.045 * 3):
        uv = np.round(cam.proj([(ox + x, N, 0), (ox + x, N, sim.net_height(x))]) * 16).astype(np.int32)
        cv2.polylines(over, [uv], False, (20, 20, 20), 1, cv2.LINE_AA, shift=4); cv2.polylines(alpha, [uv], False, 150, 1, cv2.LINE_AA, shift=4)
    # white tape 5 cm
    tt = [(ox + x, N, sim.net_height(x)) for x in xs] + [(ox + x, N, sim.net_height(x) - 0.06) for x in xs[::-1]]
    uv = np.round(cam.proj(tt) * 16).astype(np.int32)
    cv2.fillPoly(over, [uv], (240, 240, 240), lineType=cv2.LINE_AA, shift=4); cv2.fillPoly(alpha, [uv], 255, lineType=cv2.LINE_AA, shift=4)
    # posts
    for sx in (-1, 1):
        a, b = cam.proj([(ox + sx * (P + 0.05), N, 0), (ox + sx * (P + 0.05), N, C['NET_P'] + 0.03)])
        th = max(2, int(round(cam.f * 0.08 / max(cam.depth([(ox + sx * P, N, 0.5)])[0], 1))))
        cv2.line(over, tuple(np.round(a).astype(int)), tuple(np.round(b).astype(int)), (40, 60, 30), th, cv2.LINE_AA)
        cv2.line(alpha, tuple(np.round(a).astype(int)), tuple(np.round(b).astype(int)), 255, th, cv2.LINE_AA)
    return over, alpha


def background(cam, rng, second_court=False):
    """per pixel: the ray from the camera meets the ground, a windbreak wall, or goes on to trees and sky"""
    W, H = cam.W, cam.H
    if not hasattr(cam, '_rays'):
        g = np.stack(np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32)), -1).reshape(-1, 1, 2)
        n = cv2.undistortPoints(g, cam.K, cam.dist).reshape(-1, 2)
        dc = np.concatenate([n, np.ones((n.shape[0], 1), np.float32)], 1)
        cam._rays = (dc @ cam.R.astype(np.float32))      # R^T d for each row
    d = cam._rays; Cc = cam.C.astype(np.float32)
    far_y = C['LEN'] + 6.4
    xl, xr = -C['D'] - 5.0, C['D'] + 5.0 + (2 * C['D'] + 3.6 if second_court else 0)
    near_y = min(-6.4, Cc[1] - 3)
    big = np.float32(1e9)
    with np.errstate(divide='ignore', invalid='ignore'):
        sg = np.where(d[:, 2] < -1e-6, -Cc[2] / d[:, 2], big)
        walls = []
        for plane, val, lim in (('y', far_y, None), ('x', xl, None), ('x', xr, None), ('y', near_y, None)):
            k = 1 if plane == 'y' else 0
            s_ = (val - Cc[k]) / d[:, k]
            s_ = np.where(s_ > 0, s_, big)
            P = Cc[None, :] + s_[:, None] * d
            ok = (P[:, 2] >= 0) & (P[:, 2] <= 3.6) & (P[:, 0] >= xl - 0.01) & (P[:, 0] <= xr + 0.01) & (P[:, 1] >= near_y - 0.01) & (P[:, 1] <= far_y + 0.01)
            walls.append(np.where(ok, s_, big))
        sw = np.minimum.reduce(walls)
    tex = cv2.resize((rng.random((H // 6 + 1, W // 6 + 1)) * 255).astype(np.uint8), (W, H), interpolation=cv2.INTER_CUBIC).reshape(-1).astype(np.float32) / 255.0
    img = np.zeros((W * H, 3), np.float32)
    sky = (d[:, 2] > 0.18)
    img[:] = np.array([60, 110, 55], np.float32)[None, :] * (0.6 + 0.8 * tex[:, None])          # trees
    img[sky] = np.array([225, 215, 190], np.float32)
    ground = sg < sw
    img[ground] = np.array([95, 150, 80], np.float32)[None, :] * (0.93 + 0.1 * tex[ground, None])
    wall = (sw < sg) & (sw < big)
    img[wall] = np.array([150, 140, 70], np.float32)[None, :] * (0.95 + 0.08 * tex[wall, None])
    img = img.reshape(H, W, 3).clip(0, 255).astype(np.uint8)
    court_layer(img, cam)
    if second_court:
        court_layer(img, cam, ox=2 * C['D'] + 3.6)
    return img


def player_pose(kf, t):
    """position from keyframes (linear), and the swing in progress"""
    pos = [k for k in kf if 'x' in k]
    pos.sort(key=lambda k: k['t'])
    if not pos:
        return None
    if t <= pos[0]['t']:
        x, y = pos[0]['x'], pos[0]['y']
    elif t >= pos[-1]['t']:
        x, y = pos[-1]['x'], pos[-1]['y']
    else:
        for a, b in zip(pos, pos[1:]):
            if a['t'] <= t <= b['t']:
                f = (t - a['t']) / max(b['t'] - a['t'], 1e-6)
                x, y = a['x'] + f * (b['x'] - a['x']), a['y'] + f * (b['y'] - a['y'])
                break
    sw = None
    for k in kf:
        if 'swing' in k and -0.45 <= t - k['t'] <= 0.35:
            sw = (t - k['t'], k['swing'], k['t'])
    # walking phase from speed
    return x, y, sw


def draw_player(img, cam, who, x, y, sw, contact, t):
    far = who == 'far'
    face = -1.0 if far else 1.0          # facing the other end
    d = cam.depth([(x, y, 1.0)])[0]
    if d < 0.5:
        return
    px = lambda m: max(1, int(round(cam.f * m / d)))
    phase = math.sin(t * 9.0 + (1.7 if far else 0))
    fl = (x - 0.18 + 0.08 * phase, y + 0.12 * phase * face, 0)
    fr = (x + 0.18 - 0.08 * phase, y - 0.12 * phase * face, 0)
    hip = (x, y, 0.95); sh = (x, y + 0.03 * face, 1.45); head = (x, y, 1.66)
    side = 1.0 if not far else -1.0     # right-handed: racket side to the right of a near player seen from behind
    shoulder_r = (x + 0.2 * side, y, 1.42); shoulder_l = (x - 0.2 * side, y, 1.42)
    if sw is not None:
        dt, kind, th = sw
        cpt = np.array(contact) if contact is not None else np.array([x + 0.7 * side, y + 0.3 * face, 1.0])
        # racket path: behind at -0.45 s, at the contact point at 0, follow through over the other shoulder
        if kind == 'serve':
            back = np.array([x + 0.3 * side, y - 0.4 * face, 2.2]); fwd = np.array([x - 0.3 * side, y + 0.6 * face, 0.9])
        else:
            back = np.array([cpt[0] + 0.2 * side, cpt[1] - 0.9 * face, cpt[2] + 0.2]); fwd = np.array([x - 0.5 * side, y + 0.4 * face, 1.6])
        if dt < 0:
            f = (dt + 0.45) / 0.45; f = f * f
            rk = back + (cpt - back) * f
        else:
            f = min(1.0, dt / 0.35)
            rk = cpt + (fwd - cpt) * f
    else:
        rk = np.array([x + 0.45 * side, y + 0.35 * face, 0.95])
    hand = np.array(shoulder_r) + (rk - np.array(shoulder_r)) * 0.62
    racket_head = rk
    P = cam.proj([fl, fr, hip, sh, head, shoulder_r, shoulder_l, tuple(hand), tuple(racket_head), (x - 0.35 * side, y + 0.2 * face, 1.0)])
    P = np.round(P).astype(int)
    tt = lambda i: tuple(P[i])
    cv2.line(img, tt(0), tt(2), SHORTS[who], px(0.14), cv2.LINE_AA); cv2.line(img, tt(1), tt(2), SHORTS[who], px(0.14), cv2.LINE_AA)
    cv2.line(img, tt(0), (P[0][0], P[0][1] - px(0.4)), SKIN, px(0.1), cv2.LINE_AA); cv2.line(img, tt(1), (P[1][0], P[1][1] - px(0.4)), SKIN, px(0.1), cv2.LINE_AA)
    cv2.line(img, tt(2), tt(3), SHIRT[who], px(0.36), cv2.LINE_AA)
    cv2.circle(img, tt(4), px(0.11), (40, 60, 90), -1, cv2.LINE_AA)
    cv2.line(img, tt(6), tt(9), SKIN, px(0.08), cv2.LINE_AA)
    cv2.line(img, tt(5), tt(7), SKIN, px(0.08), cv2.LINE_AA)
    cv2.line(img, tt(7), tt(8), (30, 30, 30), px(0.03), cv2.LINE_AA)
    cv2.ellipse(img, tt(8), (px(0.15), px(0.12)), 0, 0, 360, (30, 30, 30), px(0.025), cv2.LINE_AA)


def ball_at(samples, t):
    """position at time t from the sample list (None separates dead balls)"""
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene'); ap.add_argument('out')
    ap.add_argument('--cam', default='behind'); ap.add_argument('--fps', type=int, default=60)
    ap.add_argument('--width', type=int, default=1920); ap.add_argument('--height', type=int, default=1080)
    ap.add_argument('--second', action='store_true'); ap.add_argument('--shake', type=float, default=0.0)
    ap.add_argument('--crf', type=int, default=23); ap.add_argument('--seconds', type=float, default=0)
    ap.add_argument('--exposure', type=float, default=1 / 500); ap.add_argument('--loose', type=int, default=4); ap.add_argument('--dist', type=float, default=0.04)
    a = ap.parse_args()
    sc = json.load(open(a.scene))
    rng = np.random.default_rng(7)
    if a.cam == 'behind':
        cam = Cam((0.0, -6.2, 2.9), (0.0, 8.0, 0.0), a.width, a.height, hfov=70)
    elif a.cam == 'corner':
        cam = Cam((-9.0, -6.2, 2.6), (2.0, 9.0, 0.0), a.width, a.height, hfov=68)
    else:
        raise SystemExit('cam?')
    cam.dist = np.array([a.dist, -a.dist / 2, 0, 0, 0], float)
    C0, R0 = cam.C.copy(), cam.R.copy()
    look0 = C0 + R0[2] * 15
    bg = background(cam, rng, a.second)
    # balls lying around on the court (the detector has to ignore what does not move)
    for _ in range(a.loose):
        p = (rng.uniform(-6, 6), rng.uniform(0.5, 23), sim.R)
        if cam.depth([p])[0] > 1:
            u = cam.proj([p])[0]; cv2.circle(bg, tuple(np.round(u).astype(int)), max(1, int(cam.f * sim.R / cam.depth([p])[0])), BALL, -1, cv2.LINE_AA)
    net_rgb, net_a = net_layer(cam)
    if a.second:
        n2, a2 = net_layer(cam, ox=2 * C['D'] + 3.6)
        m = a2 > net_a; net_rgb[m] = n2[m]; net_a = np.maximum(net_a, a2)
    na = (net_a.astype(np.float32) / 255.0)[:, :, None]
    noise = [rng.normal(0, 2.2, (a.height, a.width, 1)).astype(np.float32) for _ in range(6)]
    # ball samples -> arrays per live segment
    segs, cur = [], []
    for s in sc['ball']:
        if s is None:
            if cur: segs.append(np.array(cur)); cur = []
        else:
            cur.append(s)
    if cur: segs.append(np.array(cur))
    extra = [np.array(e) for e in sc.get('extra', [])]
    contacts = {}
    for s in sc['shots']:
        contacts.setdefault(s['who'], []).append((s['t'], s['p0']))
    dur = max(s[-1, 0] for s in segs) + 1.0
    if a.seconds: dur = min(dur, a.seconds)
    n = int(dur * a.fps)
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{a.width}x{a.height}', '-r', str(a.fps), '-i', '-',
                           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(a.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out], stdin=subprocess.PIPE)
    sub = 4
    for i in range(n):
        t = i / a.fps
        if a.shake:
            j = a.shake * np.array([math.sin(t * 1.3) + 0.5 * math.sin(t * 4.1), math.cos(t * 1.1) * 0.6, 0]) * 0.01
            cam.set(C0, look0 + j * 15)
            frame_bg = background(cam, np.random.default_rng(7), a.second) if i % 1 == 0 else bg
            nr, nal = net_layer(cam); na_ = (nal.astype(np.float32) / 255.0)[:, :, None]
        else:
            frame_bg, nr, na_ = bg, net_rgb, na
        img = frame_bg.copy()
        near_layer, far_layer = [], []
        # ball positions over the exposure
        bpos = []
        for S in segs + extra:
            if S[0, 0] - 1e-6 <= t <= S[-1, 0] + 1e-6:
                for k in range(sub):
                    tt = t + (k / (sub - 1) - 0.5) * a.exposure
                    j = np.searchsorted(S[:, 0], tt)
                    j = min(max(j, 1), len(S) - 1)
                    f = (tt - S[j - 1, 0]) / max(S[j, 0] - S[j - 1, 0], 1e-9); f = min(max(f, 0), 1)
                    bpos.append(S[j - 1, 1:] + f * (S[j, 1:] - S[j - 1, 1:]))
        # players
        def draw_people(layer_far):
            for who in ('near', 'far'):
                pp = player_pose(sc['players'][who], t)
                if pp is None: continue
                x, y, sw = pp
                beyond = (y > C['NET']) == (cam.C[1] < C['NET'])
                if beyond != layer_far: continue
                cpt = None
                if sw is not None:
                    for tc, p0 in contacts.get(who, []):
                        if abs(tc - sw[2]) < 1e-3: cpt = p0
                try: draw_player(img, cam, who, x, y, sw, cpt, t)
                except (cv2.error, ValueError, OverflowError): pass
        def draw_balls(layer_far):
            if not bpos: return
            groups = [bpos[k:k + sub] for k in range(0, len(bpos), sub)]
            for g in groups:
                beyond = (g[0][1] > C['NET']) == (cam.C[1] < C['NET'])
                if beyond != layer_far: continue
                over = np.zeros_like(img); acc = np.zeros(img.shape[:2], np.float32)
                for p in g:
                    d = cam.depth([p])[0]
                    if d < 0.3: continue
                    r = cam.f * sim.R / d
                    # shadow
                    if p[2] < 4:
                        s_uv = cam.proj([(p[0], p[1], 0.0)])[0]
                        if np.all(np.isfinite(s_uv)) and np.abs(s_uv).max() < 20000: cv2.ellipse(img, tuple(np.round(s_uv).astype(int)), (max(1, int(r * 1.1)), max(1, int(r * 0.45))), 0, 0, 360, (60, 70, 50), -1, cv2.LINE_AA)
                    u = cam.proj([p])[0]
                    if not np.all(np.isfinite(u)) or np.abs(u).max() > 20000: continue
                    m = np.zeros(img.shape[:2], np.uint8)
                    cv2.circle(m, tuple(np.round(u * 16).astype(int)), max(8, int(r * 16)), 255, -1, cv2.LINE_AA, shift=4)
                    acc += m.astype(np.float32) / 255.0 / len(g)
                al = np.clip(acc * 1.0, 0, 1)[:, :, None]
                ys, xs = np.nonzero(acc > 0)
                if len(ys) == 0: continue
                y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
                img[y0:y1, x0:x1] = (img[y0:y1, x0:x1] * (1 - al[y0:y1, x0:x1]) + np.array(BALL) * al[y0:y1, x0:x1]).astype(np.uint8)
        draw_people(True); draw_balls(True)
        img = (img * (1 - na_) + nr * na_).astype(np.uint8)
        draw_people(False); draw_balls(False)
        out = np.clip(img.astype(np.float32) + noise[i % len(noise)], 0, 255).astype(np.uint8)
        ff.stdin.write(out.tobytes())
        if i % 600 == 0:
            print('frame', i, '/', n, file=sys.stderr)
    ff.stdin.close(); ff.wait()
    json.dump(dict(scene=a.scene, cam=a.cam, dist=a.dist, C=list(map(float, C0)), fps=a.fps, W=a.width, H=a.height, shots=sc['shots'], duration=dur), open(a.out.rsplit('.', 1)[0] + '.truth.json', 'w'))


if __name__ == '__main__':
    main()
