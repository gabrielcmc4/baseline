"""Tennis ball physics for synthetic test videos, written apart from js/engine.js on purpose:
the test must not grade the engine with its own model. Coordinates as in Baseline: x across the
court (singles +-4.115 m), y along it from the near baseline (0) to the far one (23.77), z up.

Flight: gravity, drag with a spin-dependent coefficient (Goodwill et al.), Magnus lift
CL = 1 / (2 + v / (r w)) (Watts & Ferrer), slow spin decay. Bounce: vertical restitution that
falls with impact speed, tangential friction with sliding/gripping (Brody / Cross). Net: a ball
whose bottom is below the tape height where it crosses is stopped there and falls."""
import math
import numpy as np

R = 0.0335          # ball radius, m
M = 0.0577          # ball mass, kg
RHO = 1.2           # air density
A = math.pi * R * R
G = 9.81
COURT = dict(S=4.115, D=5.485, SV=6.40, LEN=23.77, NET=11.885, POST=6.4, NET_C=0.914, NET_P=1.07)


def net_height(x):
    c = COURT
    return c['NET_C'] + (c['NET_P'] - c['NET_C']) * min(1.0, abs(x) / c['POST']) ** 2


def coeffs(v, w):
    """drag and lift coefficients for speed v (m/s) and spin rate w (rad/s)"""
    s = R * w / max(v, 1e-3)          # spin parameter
    cd = 0.55 + 1.0 / (22.5 + 4.2 * (1.0 / max(s, 1e-3)) ** 2.5) ** 0.4
    cl = 1.0 / (2.0 + 1.0 / max(s, 1e-4)) if w > 1 else 0.0
    return cd, cl


import os
CD_CONST = float(os.environ.get('SYNTH_CD', '0'))   # a fixed drag coefficient instead of the spin-dependent one (to tell model differences from tracking errors)


def _acc(px, py, pz, vx, vy, vz, wx, wy, wz, w):
    sp = math.sqrt(vx * vx + vy * vy + vz * vz)
    s = R * w / max(sp, 1e-3)
    cd = CD_CONST or 0.55 + 1.0 / (22.5 + 4.2 * (1.0 / max(s, 1e-3)) ** 2.5) ** 0.4
    k = 0.5 * RHO * A / M
    ax = -k * cd * sp * vx; ay = -k * cd * sp * vy; az = -G - k * cd * sp * vz
    if w > 1 and sp > 0.1:
        cl = 1.0 / (2.0 + 1.0 / max(s, 1e-4))
        lx = wy * vz - wz * vy; ly = wz * vx - wx * vz; lz = wx * vy - wy * vx
        n = math.sqrt(lx * lx + ly * ly + lz * lz)
        if n > 1e-9:
            f = k * cl * sp * sp / n
            ax += f * lx; ay += f * ly; az += f * lz
    return ax, ay, az


def deriv(p, v, wv):
    w = float(np.linalg.norm(wv))
    return np.array(_acc(*p, *v, *wv, w))


def bounce(v, wv, e0=0.78, mu=0.55):
    """v, wv just before contact -> just after. Hard court: e falls slightly with impact speed."""
    v = np.array(v, float); wv = np.array(wv, float)
    vz = v[2]
    e = max(0.6, e0 - 0.006 * abs(vz))
    vzn = -e * vz
    vt = np.array([v[0], v[1], 0.0])
    slip = vt + np.cross(wv, np.array([0.0, 0.0, -R]))
    slip[2] = 0
    s = np.linalg.norm(slip)
    jn = M * (1 + e) * abs(vz)
    j_roll = s * 2 * M / 5
    j = min(mu * jn, j_roll)
    if s > 1e-9:
        d = slip / s
        vt2 = vt - (j / M) * d
        I = 2.0 / 3.0 * M * R * R
        dw = np.cross(np.array([0.0, 0.0, -R]), -j * d) / I
        wv2 = wv + dw
    else:
        vt2, wv2 = vt, wv.copy()
    return np.array([vt2[0], vt2[1], vzn]), wv2


def fly(p0, v0, w0, t0=0.0, dt=1 / 400, t_max=6.0, bounces=2, stop=None):
    """integrate from a hit. Returns samples (t, p, v, w) and events ('bounce' | 'net' | 'cross', t, p)."""
    px, py, pz = map(float, p0); vx, vy, vz = map(float, v0); wx, wy, wz = map(float, w0)
    t = t0; out = [(t, np.array([px, py, pz]), np.array([vx, vy, vz]), np.array([wx, wy, wz]))]; ev = []; nb = 0; netted = False
    net_y = COURT['NET']; dec = math.exp(-dt / 25.0)
    while t < t0 + t_max:
        w = math.sqrt(wx * wx + wy * wy + wz * wz)
        a1 = _acc(px, py, pz, vx, vy, vz, wx, wy, wz, w)
        h = dt / 2
        a2 = _acc(px + h * vx, py + h * vy, pz + h * vz, vx + h * a1[0], vy + h * a1[1], vz + h * a1[2], wx, wy, wz, w)
        b2 = (vx + h * a1[0], vy + h * a1[1], vz + h * a1[2])
        a3 = _acc(px + h * b2[0], py + h * b2[1], pz + h * b2[2], vx + h * a2[0], vy + h * a2[1], vz + h * a2[2], wx, wy, wz, w)
        b3 = (vx + h * a2[0], vy + h * a2[1], vz + h * a2[2])
        b4 = (vx + dt * a3[0], vy + dt * a3[1], vz + dt * a3[2])
        a4 = _acc(px + dt * b3[0], py + dt * b3[1], pz + dt * b3[2], b4[0], b4[1], b4[2], wx, wy, wz, w)
        nx = px + dt / 6 * (vx + 2 * b2[0] + 2 * b3[0] + b4[0])
        ny = py + dt / 6 * (vy + 2 * b2[1] + 2 * b3[1] + b4[1])
        nz = pz + dt / 6 * (vz + 2 * b2[2] + 2 * b3[2] + b4[2])
        nvx = vx + dt / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0])
        nvy = vy + dt / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1])
        nvz = vz + dt / 6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2])
        wx *= dec; wy *= dec; wz *= dec
        tn = t + dt
        if not netted and (py - net_y) * (ny - net_y) < 0:
            f_ = (net_y - py) / (ny - py)
            cx, cz = px + f_ * (nx - px), pz + f_ * (nz - pz)
            if abs(cx) < COURT['POST'] and cz - R < net_height(cx):
                ev.append(('net', t + f_ * dt, np.array([cx, net_y, cz])))
                netted = True
                sg = 1 if vy > 0 else -1
                nx, ny, nz = cx, net_y - 0.05 * sg, cz
                nvx, nvy, nvz = vx * 0.1, -0.08 * vy, min(0.0, vz) * 0.2
                wx *= 0.1; wy *= 0.1; wz *= 0.1
            else:
                ev.append(('cross', t + f_ * dt, np.array([cx, net_y, cz])))
        if nz < R and nvz < 0:
            f_ = (pz - R) / max(pz - nz, 1e-9)
            tb = t + f_ * dt
            pb = np.array([px + f_ * (nx - px), py + f_ * (ny - py), R])
            vb = np.array([vx + f_ * (nvx - vx), vy + f_ * (nvy - vy), vz + f_ * (nvz - vz)])
            ev.append(('bounce', tb, pb.copy()))
            nb += 1
            vn, wv = bounce(vb, np.array([wx, wy, wz]))
            nvx, nvy, nvz = map(float, vn); wx, wy, wz = map(float, wv)
            nx, ny, nz = pb[0], pb[1], R + 1e-6
            if nb > bounces or abs(nvz) < 0.3:
                out.append((tn, np.array([nx, ny, nz]), np.array([nvx, nvy, nvz]), np.array([wx, wy, wz])))
                break
        px, py, pz, vx, vy, vz, t = nx, ny, nz, nvx, nvy, nvz, tn
        out.append((t, np.array([px, py, pz]), np.array([vx, vy, vz]), np.array([wx, wy, wz])))
        if stop and stop(t, np.array([px, py, pz]), np.array([vx, vy, vz])):
            break
    return out, ev


def spin_vector(v0, rpm, side_rpm=0.0):
    """topspin positive: axis horizontal, perpendicular to the flight, so that the ball dips"""
    d = np.array([v0[0], v0[1], 0.0]); d /= max(np.linalg.norm(d), 1e-9)
    axis = np.cross(d, np.array([0.0, 0.0, 1.0]))   # right-hand: (w x v) points down for topspin
    w = axis * (-rpm * 2 * math.pi / 60.0)
    # check sign: lift direction w x v must point down for topspin
    if rpm and np.cross(w, np.array(v0, float))[2] > 0:
        w = -w
    w = w + np.array([0, 0, 1.0]) * side_rpm * 2 * math.pi / 60.0
    return w


def aim(p0, target, speed_kmh, rpm, side_rpm=0.0, iters=26):
    """initial velocity of the given speed that lands at target (x, y): solve elevation and azimuth.
    Returns v0 or None when the speed cannot reach (e.g. too slow)."""
    sp = speed_kmh / 3.6
    p0 = np.array(p0, float)
    dx, dy = target[0] - p0[0], target[1] - p0[1]
    az = math.atan2(dy, dx)
    el = math.radians(5)

    def land(az, el):
        v = sp * np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])
        w = spin_vector(v, rpm, side_rpm)
        out, ev = fly(p0, v, w, bounces=0, t_max=4)
        b = [e for e in ev if e[0] == 'bounce']
        n = [e for e in ev if e[0] == 'net']
        if not b:
            return None, v, n
        return b[0][2], v, n
    lo, hi = math.radians(-25), math.radians(40)
    want = math.hypot(dx, dy)
    for _ in range(iters):
        el = 0.5 * (lo + hi)
        pb, v, n = land(az, el)
        if pb is None:
            hi = el; continue
        got = math.hypot(pb[0] - p0[0], pb[1] - p0[1])
        if n:  # hit the net: aim higher
            lo = el; continue
        if got < want:
            lo = el
        else:
            hi = el
        # azimuth correction for side spin / drift
        ang_err = math.atan2(target[1] - p0[1], target[0] - p0[0]) - math.atan2(pb[1] - p0[1], pb[0] - p0[0])
        az += 0.7 * ang_err
    pb, v, n = land(az, el)
    if pb is None:
        return None
    if math.hypot(pb[0] - target[0], pb[1] - target[1]) > 0.35:
        return None
    return v
