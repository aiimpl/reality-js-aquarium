// Reef construction on the CPU.
// The rockwork is a set of primitives (rock lumps that melt together, and coral colonies: domes, branching
// bushes, elkhorn-like blades, tube sponges, sea fans, table plates). They are placed on the rock surface
// here, then written into two float textures together with a uniform grid, so the shader only has to look
// at the few primitives listed in the cell it is in.
import * as THREE from 'three';

// ---- deterministic random ----
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- value noise shared with the shader (same data, same trilinear lookup) ----
const NN = 128, NL = 32;
export function makeNoiseData() {
  const S = NN / NL;
  const lat = new Float32Array(NL * NL * NL);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const at = (x, y, z) => lat[((z % NL) * NL + (y % NL)) * NL + (x % NL)];
  const data = new Float32Array(NN * NN * NN);
  let k = 0;
  for (let z = 0; z < NN; z++) for (let y = 0; y < NN; y++) for (let x = 0; x < NN; x++) {
    const fx = x / S, fy = y / S, fz = z / S;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const u = fade(fx - ix), v = fade(fy - iy), w = fade(fz - iz);
    const c = (dx, dy, dz) => at(ix + dx, iy + dy, iz + dz);
    const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u, x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
    const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u, x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    data[k++] = y0 + (y1 - y0) * w;
  }
  return data;
}
export function noiseTexture(data) {
  const h = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) h[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.Data3DTexture(h, NN, NN, NN);
  tex.format = THREE.RedFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
function makeN3(data) {
  const m = (i) => ((i % NN) + NN) % NN;
  return (x, y, z) => {
    // texture(uNoise, p / 32) with linear filtering: texel coordinate = p * 4 - 0.5
    const fx = x * 4 - 0.5, fy = y * 4 - 0.5, fz = z * 4 - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const u = fx - ix, v = fy - iy, w = fz - iz;
    const g = (a, b, c) => data[(m(iz + c) * NN + m(iy + b)) * NN + m(ix + a)];
    const x00 = g(0, 0, 0) + (g(1, 0, 0) - g(0, 0, 0)) * u, x10 = g(0, 1, 0) + (g(1, 1, 0) - g(0, 1, 0)) * u;
    const x01 = g(0, 0, 1) + (g(1, 0, 1) - g(0, 0, 1)) * u, x11 = g(0, 1, 1) + (g(1, 1, 1) - g(0, 1, 1)) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return (y0 + (y1 - y0) * w) * 2 - 1;
  };
}

// ---- primitive types (must match the shader) ----
export const P_LUMP = 1, P_CAPS = 2, P_BLADE = 3, P_DOME = 4, P_TUBE = 5, P_FAN = 6, P_TABLE = 7;

// grid over the reef
export const GRID_MIN = [-6.5, -5.4, -17.0];
export const GRID_CELL = 0.15;
export const GRID_N = [88, 48, 82];
const MARGIN_LUMP = 0.55;     // lumps are pushed around by noise and melt together, so list them widely
const MARGIN_COL = 0.06;
const MAX_LIST = 128;

// the rock piles, as lumps: [x, y, z, rx, ry, rz, blend]
// seen from the camera: left pile around z -7.5, middle reef z -12.5, right pile z -9.5
const PILES = [
  // left pile: tall mound, top plateau at y ~ 0, flank bulging to x ~ -2
  [
    [-3.25, -1.9, -7.6, 1.2, 1.8, 1.1, 0.250], [-2.85, -0.42, -7.75, 0.7, 0.4, 0.6, 0.200], [-4.15, -0.95, -7.5, 0.85, 1.1, 0.9, 0.250],
    [-2.55, -1.75, -7.2, 0.45, 0.7, 0.5, 0.175], [-3.8, -0.25, -7.95, 0.45, 0.32, 0.42, 0.150], [-2.5, -0.4, -7.55, 0.3, 0.26, 0.3, 0.100],
    [-3.3, -0.55, -7.2, 0.45, 0.35, 0.4, 0.150], [-2.6, -2.9, -7.1, 0.6, 0.9, 0.6, 0.200], [-4.7, -2.3, -7.3, 0.9, 1.2, 0.8, 0.250],
    [-2.45, -1.0, -7.35, 0.3, 0.35, 0.3, 0.125],
  ],
  // middle reef: long low ridge in front of the wall
  [
    [-2.850, -2.508, -14.136, 1.368, 2.280, 1.254, 0.600], [-1.254, -2.223, -14.478, 1.197, 2.052, 1.254, 0.600], [0.057, -2.337, -14.706, 0.969, 2.052, 1.083, 0.600],
    [-3.933, -3.192, -13.794, 0.912, 1.824, 1.140, 0.500], [1.083, -3.420, -14.136, 0.855, 1.368, 1.026, 0.500], [-1.824, -3.990, -12.768, 2.964, 0.912, 1.368, 0.600],
    [-2.052, -0.399, -14.364, 0.570, 0.399, 0.570, 0.350], [-0.456, -0.342, -14.706, 0.513, 0.399, 0.513, 0.350], [0.570, -0.627, -14.592, 0.456, 0.342, 0.456, 0.300],
    [-3.306, -0.798, -14.022, 0.513, 0.456, 0.570, 0.350],
  ],
  // right pile: rounded boulder with a small peak at x ~ 3.4
  [
    [2.85, -1.8, -9.6, 1.0, 1.35, 0.9, 0.5], [3.5, -0.78, -9.8, 0.3, 0.62, 0.35, 0.3], [1.8, -2.3, -9.3, 0.8, 1.2, 0.9, 0.5],
    [2.4, -0.95, -9.9, 0.65, 0.45, 0.55, 0.45], [4.3, -3.3, -9.8, 0.8, 0.8, 0.8, 0.5], [1.6, -1.3, -9.4, 0.35, 0.3, 0.35, 0.3],
    [3.1, -3.2, -9.2, 1.0, 0.9, 0.9, 0.5],
  ],
];

export function buildReef(noiseData) {
  const n3 = makeN3(noiseData);
  const fbm = (x, y, z, oct) => {
    let s = 0, a = 0.5;
    for (let i = 0; i < oct; i++) {
      s += a * n3(x, y, z);
      x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; z = z * 2.03 + 3.1;
      a *= 0.5;
    }
    return s;
  };
  const ell = (px, py, pz, l) => {
    const dx = px - l[0], dy = py - l[1], dz = pz - l[2];
    const k0 = Math.hypot(dx / l[3], dy / l[4], dz / l[5]);
    const k1 = Math.hypot(dx / (l[3] * l[3]), dy / (l[4] * l[4]), dz / (l[5] * l[5]));
    return k0 * (k0 - 1) / k1;
  };
  const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  const lumps = PILES.flat();
  // the same coarse rock the shader builds before its fine detail
  const rock = (x, y, z) => {
    let d = 1e9;
    for (const l of lumps) d = smin(d, ell(x, y, z, l), l[6]);
    d += 0.3 * fbm(x * 0.8 + 3.1, y * 0.8 + 3.1, z * 0.8 + 3.1, 3);
    const ss = (e0, e1, v) => { const t = Math.min(Math.max((v - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };
    return d + 0.16 * ss(0.1, 0, Math.abs(n3(x * 1.25 + 4.2, y * 1.25 + 0.7, z * 1.25 + 9.1)));
  };
  const grad = (x, y, z) => {
    const e = 0.01;
    const gx = rock(x + e, y, z) - rock(x - e, y, z), gy = rock(x, y + e, z) - rock(x, y - e, z), gz = rock(x, y, z + e) - rock(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  };

  const prims = [];
  const add = (type, a, b, r, n, p2, col, seed) => prims.push({ type, a, b, r, n, p2, col, seed });
  for (const l of lumps) add(P_LUMP, [l[0], l[1], l[2]], [l[3], l[4], l[5]], 0, [0, 1, 0], l[6], [0, 0, 0], 0);

  // ---- scatter colonies on the rock surface ----
  const R = rng(20261001);
  const palette = [
    [0.46, 0.44, 0.36], [0.40, 0.36, 0.26], [0.30, 0.20, 0.30], [0.22, 0.36, 0.24], [0.46, 0.42, 0.22],
    [0.34, 0.28, 0.20], [0.50, 0.48, 0.44], [0.26, 0.30, 0.34],
  ];
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const jitterCol = (c) => c.map((v) => v * (0.8 + 0.4 * R()));
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const addv = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const randUnit = () => { const z = R() * 2 - 1, a = R() * 6.2832, s = Math.sqrt(1 - z * z); return [s * Math.cos(a), z, s * Math.sin(a)]; };

  // where a point lands in the 1920x1080 frame (the camera sits at the origin looking down -z)
  const F = 540 / Math.tan((32.65 / 2) * Math.PI / 180);
  const scr = (p) => [960 + p[0] / -p[2] * F, 540 - p[1] / -p[2] * F];
  const inBox = (q, x0, y0, x1, y1) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
  // screen regions with their own planting
  const leftPlates = (q) => inBox(q, 60, 680, 380, 1100) && q[1] > 1040 - (q[0] - 60) * 0.8;
  const leftBare = (q) => inBox(q, 0, 470, 450, 820);
  const rightPlates = (q) => inBox(q, 1480, 760, 1640, 880);

  // Poisson-ish spacing on a hash grid
  const taken = new Map();
  const key = (x, y, z, s) => `${Math.floor(x / s)},${Math.floor(y / s)},${Math.floor(z / s)}`;
  const free = (p, s) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const q = taken.get(key(p[0] + i * s, p[1] + j * s, p[2] + k * s, s));
      if (q && q.some((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) < s)) return false;
    }
    return true;
  };
  const take = (p, s) => { const k = key(p[0], p[1], p[2], s); if (!taken.has(k)) taken.set(k, []); taken.get(k).push(p); };

  const boxes = [
    [[-5.4, -4.2, -9.0], [-1.6, 0.6, -6.3]],
    [[-5.0, -4.6, -16.0], [2.2, 0.3, -12.0]],
    [[1.0, -4.2, -11.2], [5.3, 0.1, -8.4]],
  ];
  const SP = 0.16;
  let tries = 0;
  // colonies per pile; the back reef has fewer, much larger colonies (heads 50 - 80 px across on screen)
  const cap = [1500, 420, 900];
  const count = [0, 0, 0];
  let placed = 0;
  while (count.some((c, z) => c < cap[z]) && tries < 400000) {
    tries++;
    const bx = boxes[Math.floor(R() * boxes.length)];
    let p = [0, 1, 2].map((i) => bx[0][i] + (bx[1][i] - bx[0][i]) * R());
    // pull the point onto the surface
    let ok = false;
    for (let it = 0; it < 8; it++) {
      const d = rock(...p);
      if (Math.abs(d) < 0.004) { ok = true; break; }
      if (Math.abs(d) > 0.9) break;
      const g = grad(...p);
      p = addv(p, g, -d);
    }
    if (!ok) continue;
    // skip what the camera never sees well: deep bottoms, and the far side of the piles
    if (p[1] < -3.9) continue;
    const n = grad(...p);
    if (n[2] < -0.55 && p[2] < -8) continue;
    const zone = p[2] > -9.2 && p[0] < 0 ? 0 : p[2] < -11.2 ? 1 : 2;
    if (count[zone] >= cap[zone]) continue;
    const s = SP * (zone === 1 ? 2.6 : 1.35) * (0.8 + 0.5 * R());
    if (!free(p, s)) continue;
    take(p, s);
    placed++;
    count[zone]++;
    const up = n[1];
    const u = R();
    const seed = R() * 100;
    const base = addv(p, n, -0.02);      // embed the root a little
    if (zone === 0) {
      // left pile: big boulders, elkhorn blades on the right flank, sparse twigs on top, much bare rock
      const q = scr(p);
      if (leftPlates(q)) {
        if (up > -0.6 && u < 0.8) blades(base, n, s * (1.6 + 1.3 * R()), seed, false);
        else if (u < 0.9) dome(base, n, s * 0.5, seed);
      } else if (leftBare(q)) {
        // mostly bare boulders: a few knobs and small twigs
        if (up > 0.5 && u < 0.12) bush(base, n, s * (0.6 + 0.4 * R()), seed);
        else if (u < 0.1) dome(base, n, s * (0.4 + 0.5 * R()), seed);
      } else if (up > 0.45) {
        if (u < 0.3) dome(base, n, s * (0.6 + 0.8 * R()), seed);
        else if (u < 0.45) bush(base, n, s * (0.8 + 0.6 * R()), seed);
        else if (u < 0.55) fingers(base, n, s * (0.6 + 0.5 * R()), seed);
      } else if (up > -0.3) {
        if (u < 0.35) dome(base, n, s * (0.5 + 0.7 * R()), seed);
        else if (u < 0.5) blades(base, n, s * (1.4 + 1.0 * R()), seed, false);
      } else if (u < 0.3) dome(base, n, s * (0.3 + 0.3 * R()), seed);
    } else if (zone === 2) {
      // right pile: dark knobby rock, a few domes, blades sticking out on its right side
      const q = scr(p);
      if (rightPlates(q) && up > -0.5 && u < 0.6) blades(base, n, s * (2.0 + 1.4 * R()), seed, false);
      else if (u < 0.35) dome(base, n, s * (0.35 + 0.6 * R()), seed);
      else if (up > 0.4 && u < 0.5) bush(base, n, s * (0.7 + 0.5 * R()), seed);

    } else {
      // back reef: big rounded heads and plates on top, fans and domes on the sides
      if (up > 0.4) {
        if (u < 0.4) dome(base, n, s * (0.45 + 0.4 * R()), seed);
        else if (u < 0.6) blades(base, n, s * (0.9 + 0.6 * R()), seed, true);
        else if (u < 0.78) bush(base, n, s * (0.6 + 0.4 * R()), seed);
        else if (u < 0.9) fingers(base, n, s * (0.5 + 0.4 * R()), seed);
      } else if (up > -0.3) {
        if (u < 0.45) dome(base, n, s * (0.35 + 0.35 * R()), seed);
        else if (u < 0.65) blades(base, n, s * (0.9 + 0.6 * R()), seed, false);
        else if (u < 0.75) fan(base, n, s * (0.8 + 0.5 * R()), seed);
      } else if (u < 0.4) dome(base, n, s * (0.3 + 0.3 * R()), seed);
    }
  }

  function dome(c, n, r0, seed) {
    const r = r0 * 0.75;
    // boulder / brain coral: an ellipsoid squashed along the normal
    const col = jitterCol(pick([[0.3, 0.28, 0.23], [0.26, 0.26, 0.22], palette[1], palette[5], [0.22, 0.3, 0.22]]));
    // flattened and half sunk, so it reads as a mound growing over the rock
    add(P_DOME, addv(c, n, -r * 0.15), [0.35 + 0.3 * R(), 0, 0], r, n, R() < 0.3 ? 1 : 0, col, seed);
  }
  function bush(c, n, h, seed) {
    // branching coral: a few main branches from the root, each forking twice
    const col = jitterCol(pick([palette[0], palette[2], palette[4], palette[6], palette[7]]));
    const up = norm(addv([0, 1, 0], n, 0.6));
    const nb = 3 + Math.floor(R() * 3);
    const r0 = h * (0.045 + 0.03 * R());
    const grow = (a, dir, len, r, depth) => {
      const b = addv(a, dir, len);
      add(P_CAPS, a, b, r, [0, 0, 0], r * 0.75, col, seed);
      if (depth === 0) return;
      const k = depth === 2 ? 2 : 1;
      for (let i = 0; i < k; i++) {
        const d2 = norm(addv(addv(dir, randUnit(), 0.55), up, 0.25));
        grow(b, d2, len * (0.6 + 0.2 * R()), r * 0.75, depth - 1);
      }
    };
    for (let i = 0; i < nb; i++) {
      const dir = norm(addv(up, randUnit(), 0.7));
      grow(c, dir, h * (0.35 + 0.2 * R()), r0, 2);
    }
  }
  function fingers(c, n, h, seed) {
    // pillar / finger coral: short thick upright lobes
    const col = jitterCol(pick([palette[1], palette[4], palette[0]]));
    const k = 3 + Math.floor(R() * 4);
    for (let i = 0; i < k; i++) {
      const o = addv(c, randUnit(), h * 0.25);
      const dir = norm(addv([0, 1, 0], randUnit(), 0.25));
      add(P_CAPS, o, addv(o, dir, h * (0.5 + 0.6 * R())), h * 0.09, [0, 0, 0], h * 0.08, col, seed);
    }
  }
  function blades(c, n, len, seed, top) {
    // elkhorn / fire coral: flat blades that fork like antlers, held roughly level and pointing outward
    const col = jitterCol(pick([[0.5, 0.47, 0.32], [0.46, 0.42, 0.28], [0.52, 0.5, 0.38], palette[4]]));
    let out = [n[0], top ? 0.5 : 0.15 + 0.2 * R(), n[2]];
    if (Math.hypot(out[0], out[2]) < 0.2) out = [R() - 0.5, 0.4, R() - 0.5];
    out = norm(out);
    // raise the blade and roll it about its axis so its face shows to the camera
    out = norm(addv(out, [0, 1, 0], 0.08 + 0.25 * R()));
    let side = norm(cross(out, [0, 1, 0]));
    let pn = norm(cross(side, out));
    const roll = (R() - 0.5) * 0.6;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    [side, pn] = [norm(addv(side.map((v) => v * cr), pn, sr)), norm(addv(pn.map((v) => v * cr), side, -sr))];
    const th = 0.007 + 0.005 * R();
    const fork = (a, dir, l, w, depth) => {
      const b = addv(a, dir, l);
      add(P_BLADE, a, b, w, pn, th, col, seed);
      if (depth === 0) return;
      const spread = 0.5 + 0.35 * R();
      for (const sgn of [-1, 1]) {
        if (R() < 0.15) continue;
        const d2 = norm(addv(dir, side, sgn * spread));
        fork(b, d2, l * (0.55 + 0.25 * R()), w * 0.7, depth - 1);
      }
    };
    fork(c, out, len * 0.4, len * 0.3, 2);
  }
  function fan(c, n, r, seed) {
    const col = jitterCol(pick([palette[2], palette[5], palette[1]]));
    const fn = norm([n[0], 0, n[2]]);
    // the fan faces outward from the rock
    add(P_FAN, addv(c, [0, 1, 0], r * 0.2), [0, 0, 0], r, fn, 0.006, col, seed);
  }

  // ---- hand placed features ----
  // tube sponges on the left top
  const tube = (x, y, z, h, r, lx, lz, col) => add(P_TUBE, [x, y, z], [x + lx, y + h, z + lz], r, [0, 1, 0], 0.62, col, R() * 100);
  tube(-3.08, -0.3, -7.72, 0.86, 0.05, 0.03, 0, [0.56, 0.56, 0.34]);
  tube(-2.98, -0.3, -7.66, 0.62, 0.045, 0.05, 0.02, [0.52, 0.54, 0.32]);
  tube(-3.55, -0.26, -7.8, 0.62, 0.038, -0.03, 0, [0.5, 0.5, 0.32]);
  tube(-3.62, -0.2, -7.7, 0.34, 0.03, -0.08, 0.02, [0.48, 0.48, 0.3]);
  tube(-2.62, -0.25, -7.6, 0.25, 0.03, 0.02, 0, [0.46, 0.46, 0.3]);
  // a few sea fans
  add(P_FAN, [-2.25, -0.3, -7.45], [0, 0, 0], 0.26, norm([0.9, 0, 0.4]), 0.006, [0.36, 0.30, 0.22], 2);
  add(P_FAN, [1.72, -0.85, -9.25], [0, 0, 0], 0.3, norm([0.3, 0, 1]), 0.006, [0.40, 0.33, 0.22], 13);
  add(P_FAN, [-0.29, -0.06, -14.76], [0, 0, 0], 0.4, norm([0.1, 0, 1]), 0.007, [0.32, 0.22, 0.30], 9);
  add(P_FAN, [-2.96, -0.46, -14.08], [0, 0, 0], 0.32, norm([-0.3, 0, 1]), 0.007, [0.30, 0.24, 0.30], 11);
  // the shelf of plate coral on the right flank of the left pile, and a smaller one on the right pile
  const onRock = (from, dir) => {
    // march from a point outside the rock toward it and stop on the surface
    let p = from.slice();
    for (let i = 0; i < 200; i++) {
      const d = rock(...p);
      if (d < 0.003) return p;
      p = addv(p, dir, Math.max(d * 0.8, 0.005));
    }
    return null;
  };
  const shelf = (x0, z0, y0, y1, nlev, out, lmin, lmax) => {
    for (let k = 0; k < nlev; k++) {
      const y = y0 + (y1 - y0) * (k + 0.5 * R()) / nlev;
      for (let j = 0; j < 2; j++) {
        const zz = z0 + (R() - 0.5) * 0.5;
        const p = onRock([x0, y, zz], norm([-out[0], 0, -out[2]]));
        if (!p) continue;
        const n = norm(addv(grad(...p), out, 1.5));
        blades(addv(p, n, -0.03), n, lmin + (lmax - lmin) * R(), R() * 100, false);
      }
    }
  };
  shelf(-1.2, -7.2, -0.75, -2.2, 11, [1, 0, 0.45], 0.6, 1.05);
  // features placed by where they should appear on screen
  const fromScreen = (x, y) => {
    const d = norm([(x - 960) / F, (540 - y) / F, -1]);
    let t = 3;
    for (let i = 0; i < 400; i++) {
      const p = d.map((v) => v * t);
      const dd = rock(...p);
      if (dd < 0.004) return p;
      t += Math.max(dd * 0.8, 0.01);
      if (t > 25) break;
    }
    return null;
  };
  const at = (x, y, fn) => { const p = fromScreen(x, y); if (p) fn(p, grad(...p)); };
  // the left pile's top: a big rounded coral head at the far left and knobs on the right shoulder
  at(85, 525, (p, n) => add(P_DOME, addv(p, n, -0.05), [0.85, 0, 0], 0.26, norm(addv(n, [0, 1, 0.3], 0.8)), 0, [0.3, 0.3, 0.26], 31));
  at(395, 545, (p, n) => { for (let k = 0; k < 4; k++) dome(addv(p, randUnit(), 0.1), n, 0.1 + 0.05 * R(), R() * 100); });
  // brain coral on the right pile, and a knobby coral head on its peak
  at(1520, 800, (p, n) => add(P_DOME, addv(p, n, -0.02), [0.8, 0, 0], 0.11, n, 1, [0.5, 0.48, 0.4], 3));
  at(1640, 585, (p, n) => { for (let k = 0; k < 6; k++) dome(addv(p, randUnit(), 0.12), n, 0.09 + 0.05 * R(), R() * 100); });
  at(1460, 625, (p, n) => add(P_FAN, addv(p, [0, 1, 0], 0.12), [0, 0, 0], 0.22, norm([0.2, 0, 1]), 0.006, [0.42, 0.34, 0.22], 21));
  // pale blue plates in the middle reef
  for (const [x, y] of [[840, 790], [880, 800], [740, 765], [990, 700], [620, 820]]) {
    at(x, y, (p, n) => {
      const c0 = [0.48, 0.55, 0.66];
      const out = norm(addv([n[0], 0.3, n[2]], [0, 0, 1], 0.6));
      add(P_BLADE, p, addv(p, out, 0.18), 0.07, norm(addv([0, 1, 0], out, -0.3)), 0.008, c0, R() * 100);
      add(P_BLADE, p, addv(p, norm(addv(out, [1, 0.2, 0], 0.6)), 0.14), 0.06, norm(addv([0, 1, 0], out, -0.3)), 0.008, c0, R() * 100);
    });
  }
  // green table coral
  add(P_TABLE, [-2.5, -0.2, -7.2], [0, 0, 0], 0.3, norm([0.05, 1, 0.3]), 0.018, [0.26, 0.6, 0.38], 7);

  // ---- grid ----
  const [NX, NY, NZ] = GRID_N;
  const cells = Array.from({ length: NX * NY * NZ }, () => []);
  prims.forEach((q, i) => {
    let lo, hi;
    if (q.type === P_LUMP) {
      const m = MARGIN_LUMP + q.p2;
      lo = [0, 1, 2].map((k) => q.a[k] - q.b[k] - m);
      hi = [0, 1, 2].map((k) => q.a[k] + q.b[k] + m);
    } else {
      let ext = q.r;
      if (q.type === P_DOME) ext = q.r * 1.1;
      if (q.type === P_FAN) ext = q.r * 1.3;
      if (q.type === P_TABLE) ext = q.r * 1.2;
      const b = q.type === P_DOME || q.type === P_FAN || q.type === P_TABLE ? q.a : q.b;
      const m = MARGIN_COL + ext;
      lo = [0, 1, 2].map((k) => Math.min(q.a[k], b[k]) - m);
      hi = [0, 1, 2].map((k) => Math.max(q.a[k], b[k]) + m);
    }
    const c0 = lo.map((v, k) => Math.max(0, Math.floor((v - GRID_MIN[k]) / GRID_CELL)));
    const c1 = hi.map((v, k) => Math.min(GRID_N[k] - 1, Math.floor((v - GRID_MIN[k]) / GRID_CELL)));
    for (let z = c0[2]; z <= c1[2]; z++) for (let y = c0[1]; y <= c1[1]; y++) for (let x = c0[0]; x <= c1[0]; x++) {
      cells[(z * NY + y) * NX + x].push(i);
    }
  });
  // lumps first in every list, so the shader can melt them before the colonies
  let maxList = 0;
  const idx = [];
  const cellData = new Float32Array(NX * NY * NZ * 4);
  cells.forEach((list, c) => {
    list.sort((a, b) => (prims[a].type === P_LUMP ? 0 : 1) - (prims[b].type === P_LUMP ? 0 : 1) || prims[b].r - prims[a].r);
    if (list.length > MAX_LIST) list.length = MAX_LIST;
    const nl = list.filter((i) => prims[i].type === P_LUMP).length;
    cellData[c * 4] = idx.length;
    cellData[c * 4 + 1] = list.length;
    cellData[c * 4 + 2] = nl;
    for (const i of list) idx.push(i);
    maxList = Math.max(maxList, list.length);
  });

  const TW = 2048;
  const primTex = (() => {
    const n = prims.length * 4;
    const h = Math.ceil(n / TW);
    const d = new Float32Array(TW * h * 4);
    prims.forEach((q, i) => {
      const o = i * 16;
      d.set([...q.a, q.type, ...q.b, q.r, ...q.n, q.p2, ...q.col, q.seed], o);
    });
    const t = new THREE.DataTexture(d, TW, h, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  })();
  const idxTex = (() => {
    const h = Math.ceil(idx.length / TW);
    const d = new Float32Array(TW * h);
    d.set(idx);
    const t = new THREE.DataTexture(d, TW, h, THREE.RedFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  })();
  const cellTex = (() => {
    const n = NX * NY * NZ;
    const h = Math.ceil(n / TW);
    const d = new Float32Array(TW * h * 4);
    d.set(cellData);
    const t = new THREE.DataTexture(d, TW, h, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  })();
  return { primTex, idxTex, cellTex, count: prims.length, placed, maxList, indices: idx.length };
}
