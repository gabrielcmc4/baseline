// Hot loops of the ball search, compiled to WebAssembly with SIMD (see build.sh). Each one gives exactly the same numbers as the JavaScript it replaces in js/engine.js; the JavaScript stays as the fallback.
typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32;

// grey picture, lightly blurred (1-2-1 across, then 1-2-1 down); border pixels are 0
void gray_blur(const u8 *restrict rgba, u8 *restrict g, u8 *restrict t, u16 *restrict h, int W, int H) {
  int N = W * H;
  for (int i = 0; i < N; i++) t[i] = (u8)((rgba[4 * i] * 77 + rgba[4 * i + 1] * 150 + rgba[4 * i + 2] * 29) >> 8);
  h[0] = 0; h[N - 1] = 0;
  for (int o = 1; o < N - 1; o++) h[o] = (u16)(t[o - 1] + 2 * t[o] + t[o + 1]);
  for (int i = 0; i < N; i++) g[i] = 0;
  for (int y = 1; y < H - 1; y++) { const u16 *a = h + (y - 1) * W, *b = h + y * W, *c = h + (y + 1) * W; u8 *o = g + y * W;
    for (int x = 1; x < W - 1; x++) o[x] = (u8)((a[x] + 2 * b[x] + c[x]) >> 4); }
}

// pixels of rows ya..yb that differ by more than MT from the same spot in both neighbouring pictures (shifted by op / on pixels); writes their indices in row order, returns how many
int motion(const u8 *restrict c, const u8 *restrict p, const u8 *restrict n, int op, int on, int MT, int W, int H, int mg, u32 *restrict idx, u8 *restrict row, int ya, int yb) {
  int N = W * H, cnt = 0; if (ya < mg) ya = mg; if (yb > H - mg) yb = H - mg;
  for (int y = ya; y < yb; y++) { int o0 = y * W;
    // part of the row where both shifted reads stay inside the picture
    int lo = mg, hi = W - mg; { int a = -(o0 + op), b = -(o0 + on); if (a > lo) lo = a; if (b > lo) lo = b; int e1 = N - (o0 + op), e2 = N - (o0 + on); if (e1 < hi) hi = e1; if (e2 < hi) hi = e2; if (lo > W - mg) lo = W - mg; if (hi < lo) hi = lo; }
    // a read outside the picture counts as "different" for that neighbour, as it does in the JavaScript
    for (int k = 0; k < 2; k++) { int xa = k ? hi : mg, xb = k ? W - mg : lo; for (int x = xa; x < xb; x++) { int o = o0 + x, a = c[o], t1 = 1, t2 = 1; if (o + op >= 0 && o + op < N) { int d = a - p[o + op]; if (d < 0) d = -d; t1 = d > MT; } if (o + on >= 0 && o + on < N) { int d = a - n[o + on]; if (d < 0) d = -d; t2 = d > MT; } row[x] = (u8)(t1 & t2); } }
    const u8 *cc = c + o0, *pp = p + o0 + op, *nn = n + o0 + on;
    for (int x = lo; x < hi; x++) { int a = cc[x], d1 = a - pp[x], d2 = a - nn[x]; if (d1 < 0) d1 = -d1; if (d2 < 0) d2 = -d2; row[x] = (u8)((d1 > MT) & (d2 > MT)); }
    { int x = mg, xe = W - mg; for (; x + 8 <= xe; x += 8) { unsigned long long w; __builtin_memcpy(&w, row + x, 8); if (!w) continue; for (int k = 0; k < 8; k++) if (row[x + k]) idx[cnt++] = (u32)(o0 + x + k); } for (; x < xe; x++) if (row[x]) idx[cnt++] = (u32)(o0 + x); }
  }
  return cnt;
}

// Far-side second look: compare the strip between horizon and net tape with its slowly updated background (three colour planes R, G, B of the strip, in court coordinates), mark spots clearly more yellow-green than the background in fm, move the background one step towards the picture. rgba is the whole frame; (sx, sy) is where the court sits in this frame. Returns the number of marked strip indices written to idx (row order).
int far_look(const u8 *restrict rgba, u8 *restrict R, u8 *restrict G, u8 *restrict B, u8 *restrict fm, const int *restrict lim, u32 *restrict idx, u8 *restrict row, int W, int H, int y0, int y1, int sx, int sy, int init) {
  int cnt = 0, xa = 1 - sx > 1 ? 1 - sx : 1, xb = W - 1 - sx < W - 1 ? W - 1 - sx : W - 1; if (xb < xa) return 0;
  for (int yr = y0; yr < y1; yr++) { int y = yr + sy; if (y < 1 || y >= H - 1) continue; int i0 = (yr - y0) * W; const u8 *d = rgba + 4 * (y * W + sx);
    u8 *r_ = R + i0, *g_ = G + i0, *b_ = B + i0;
    if (init) { for (int x = xa; x < xb; x++) { r_[x] = d[4 * x]; g_[x] = d[4 * x + 1]; b_[x] = d[4 * x + 2]; } continue; }
    for (int x = xa; x < xb; x++) { int r = d[4 * x], g = d[4 * x + 1], b = d[4 * x + 2], dr = r - r_[x], dg = g - g_[x], db = b - b_[x];
      row[x] = (u8)((dg > 20) & (dr > -10) & (db < dg - 4) & (yr < lim[x]));
      r_[x] = (u8)(r_[x] + (dr > 0) - (dr < 0)); g_[x] = (u8)(g_[x] + (dg > 0) - (dg < 0)); b_[x] = (u8)(b_[x] + (db > 0) - (db < 0)); }
    for (int x = xa; x < xb; x++) if (row[x]) { fm[i0 + x] = 1; idx[cnt++] = (u32)(i0 + x); }
  }
  return cnt;
}
