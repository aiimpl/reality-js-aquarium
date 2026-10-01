// Aquarium tank shaders.
// The static tank (rockwork, coral, back wall, windows, pipes) is ray marched once as a signed distance
// field and baked: colour with water already applied, the part lit from above (so moving caustics can be
// multiplied in later), and the world position. Two views are baked: the camera view, and the view in the
// mirror of the water surface (total internal reflection). Every frame only the composite runs: caustics,
// the wavy mirror, and the fish and particles drawn on top.

// Scene layout (metres, camera at the origin looking down -z):
//   water surface   y = YS
//   back wall       a plane through (0.258, *, -19) turned 26 deg, so the right window is closer (16.6 m)
//   left rock       z ~ -7.5, middle reef z ~ -12.5, right rock z ~ -9.5, floor y = -4.2
export const water = /* glsl */ `
#define YS 2.52
// extinction per metre (red goes first), downwelling attenuation
const vec3 SIG = vec3(0.27, 0.105, 0.078);
const vec3 KD  = vec3(0.30, 0.070, 0.045);
uniform vec3 uScat;
uniform vec3 uLight;

// the lamps' light fades with depth faster than the haze (it is a narrow beam from above)
const vec3 KL = vec3(0.4, 0.22, 0.19);
vec3 downLight(float y) { return uLight * exp(-KL * max(YS - y, 0.)); }
// strongly forward scattering water under lamps: looking up toward the light is much brighter (1 when level)
float phaseUp(vec3 d) { return exp(2.4 * d.y); }

// in-scattered light along a segment from o in direction d of length L, and its transmittance
// (closed form: the source term falls off with depth like the downwelling light)
vec3 inscatter(vec3 o, vec3 d, float L, out vec3 T) {
  T = exp(-SIG * L);
  vec3 a = SIG - KD * d.y;
  // (1 - exp(-aL)) / a, safe when a is near zero
  vec3 f = mix(L * (1. - 0.5 * a * L), (1. - exp(-a * L)) / a, step(1e-3, abs(a)));
  return uScat * phaseUp(d) * exp(-KD * max(YS - o.y, 0.)) * f;
}
// radiance of open water seen from depth y in direction d (no surface in the way)
vec3 waterRadiance(float y, vec3 d) {
  // looking up, the water ends at the surface: integrate only that far
  float L = d.y > 1e-3 ? min((YS - y) / d.y, 95.) : 95.;
  vec3 T;
  return inscatter(vec3(0., y, 0.), d, L, T);
}
`;

export const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }
`;

const common = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
${water}

float n3(vec3 p) { return texture(uNoise, p * (1. / 32.)).r * 2. - 1.; }
float fbm(vec3 p, int oct) {
  float s = 0., a = 0.5;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    s += a * n3(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
`;

const sdf = /* glsl */ `
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r), k1 = length(p / (r * r));
  return k0 * (k0 - 1.) / k1;
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h) - r;
}
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.) / k;
  return min(a, b) - h * h * k * 0.25;
}
vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }

// ---- back wall frame of reference ----
const vec3 WA = vec3(0.258, 0., -19.);
const vec3 WT = vec3(0.8998, 0., 0.4364);          // along the wall (to the right)
const vec3 WN = vec3(-0.4364, 0., 0.8998);         // out of the wall, toward the camera
vec3 wallUVW(vec3 p) { vec3 q = p - WA; return vec3(dot(q, WT), p.y, dot(q, WN)); }

// windows: centre (u, v) and half size of the lit frame; rail offset
const vec4 WINA = vec4(0.0, 0.345, 1.40, 1.12);
const vec4 WINB = vec4(7.25, 0.34, 1.70, 1.22);
const vec4 WINC = vec4(-11.9, 0.35, 1.25, 1.10);

float frameSD(vec3 q, vec4 win, float grow, float r) {
  float d2 = sdRoundRect(q.xy - win.xy, win.zw + grow, 0.12 + grow);
  return length(vec2(abs(d2), q.z - r)) - r;
}
float railSD(vec3 q, vec4 win, float off) {
  vec2 c = q.xy - win.xy;
  float d = frameSD(q, win, off, 0.022);
  vec2 a = abs(c);
  vec2 h = win.zw + off;
  float bx = length(vec2(abs(a.x - (h.x - 0.36)), q.z - 0.02)) - 0.018;
  bx = max(bx, (h.y - 0.24) - a.y);
  float by = length(vec2(abs(a.y - (h.y - 0.24)), q.z - 0.02)) - 0.018;
  by = max(by, (h.x - 0.36) - a.x);
  float corner = max(min(bx, by), max(a.x - h.x, a.y - h.y));
  return min(d, corner);
}

// ---- rockwork ----
#define M_ROCK 1.
#define M_WALL 3.
#define M_LED 4.
#define M_RAIL 5.
#define M_PIPE 6.
#define M_PIPEL 7.
#define M_SAND 8.

// ---- reef: primitives placed on the CPU (reef.js), found through a uniform grid ----
uniform sampler2D uPrim, uIdx, uCell;
uniform vec3 uGridMin;
uniform ivec3 uGridN;
uniform float uGridCell;
#define P_LUMP 1
#define P_CAPS 2
#define P_BLADE 3
#define P_DOME 4
#define P_TUBE 5
#define P_FAN 6
#define P_TABLE 7
#define MARGIN_COL 0.06
vec4 fetchT(sampler2D s, int i) { return texelFetch(s, ivec2(i % 2048, i / 2048), 0); }

// rough reef rock: large lumps, then crusty detail and holes
float rockSurf(vec3 p, float base) {
  float d = base + 0.3 * fbm(p * 0.8 + 3.1, 3);
  if (d > 0.45) return d;
  // deep cracks that split the pile into separate chunks
  d += 0.16 * smoothstep(0.1, 0., abs(n3(p * 1.25 + vec3(4.2, 0.7, 9.1)))) + 0.07 * smoothstep(0.1, 0., abs(n3(p * 2.7 + 6.3)));
  // ledges and knobs
  d += 0.1 * fbm(p * 2.2 + 7.7, 3);
  d -= 0.05 * max(n3(p * 4.1 + 1.9), 0.);
  // crust, dents and fine grain
  d += 0.035 * fbm(p * 6.5 + 4.4, 2);
  d += 0.03 * smoothstep(0.25, 0.6, n3(p * 5.3 + 2.));
  d += (0.012 * n3(p * 19.) + 0.006 * n3(p * 41.));
  // holes: carve where a mid-frequency noise is high
  float h = n3(p * 2.2 + 13.1);
  d = max(d, -(0.08 - 0.35 * max(h - 0.25, 0.)));
  return d;
}

void frameOf(vec3 n, out vec3 t, out vec3 b) {
  t = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  b = cross(n, t);
}

float primSD(int i, vec3 p) {
  vec4 t0 = fetchT(uPrim, i * 4), t1 = fetchT(uPrim, i * 4 + 1), t2 = fetchT(uPrim, i * 4 + 2);
  int type = int(t0.w + 0.5);
  vec3 a = t0.xyz, b = t1.xyz, n = t2.xyz;
  float r = t1.w, p2 = t2.w;
  if (type == P_CAPS) {
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
    return (length(pa - ba * h) - mix(r, p2, h)) * 0.9;
  }
  if (type == P_BLADE) {
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
    vec3 q = pa - ba * h;
    // the blade ripples gently out of its plane
    float dn = dot(q, n) - 0.025 * n3(p * 6. + t2.w);
    float ds = length(q - n * dot(q, n));
    float w = r * (1. - 0.25 * h) * (1. + 0.22 * n3(p * 23.) + 0.08 * n3(p * 61.));
    float e = ds - w;
    float th = p2 * (1. - 0.5 * smoothstep(-0.6 * w, 0., e));
    float f = abs(dn) - th;
    return (length(max(vec2(e, f), 0.)) + min(max(e, f), 0.)) * 0.8;
  }
  if (type == P_DOME) {
    vec3 tt, bb; frameOf(n, tt, bb);
    vec3 pa = p - a;
    vec3 q = vec3(dot(pa, tt), dot(pa, n), dot(pa, bb));
    float d = sdEllipsoid(q, vec3(r, r * b.x, r));
    if (d < 0.05) {
      // surface relief: brain coral grooves, or knobby polyps and lumps (catches the light in fine edges)
      if (p2 > 0.5) d += 0.012 * (1. - smoothstep(0., 0.22, abs(n3(p * 21. + t2.w))));
      else d -= 0.014 * max(n3(p * 26. + t2.w), 0.) + 0.006 * n3(p * 61.) + 0.02 * n3(p * 9. + t2.w);
    }
    return d * 0.85;
  }
  if (type == P_TUBE) {
    vec3 pa = p - a, ba = b - a;
    float L = length(ba);
    vec3 ax = ba / L;
    float y = dot(pa, ax);
    float s = clamp(y / L, 0., 1.);
    float lat = length(pa - ax * y);
    float ang = atan(pa.z, pa.x);
    float rr = r * (1. + 0.15 * s) * (1. + 0.08 * n3(p * 11.) + 0.05 * n3(p * 31.) + 0.06 * sin(ang * 9. + n3(p * 4.) * 3.));
    float d = max(lat - rr, max(-y, y - L));
    d = max(d, -max(lat - rr * p2, L - 0.1 - y));
    return d * 0.85;
  }
  if (type == P_FAN) {
    vec3 q = p - a;
    float pl = dot(q, n);
    vec3 t1v = normalize(cross(n, vec3(0., 1., 0.)));
    vec2 uv = vec2(dot(q, t1v), q.y);
    float rr = r * (1. + 0.2 * n3(vec3(atan(uv.y, uv.x) * 2., t2.w, 0.)));
    float dr = length(uv * vec2(1., 0.85)) - rr;
    dr = max(dr, -uv.y - 0.05);
    // net of meandering branches: zero crossings of two noises
    float na = abs(n3(vec3(uv * 9., r * 9.))), nb = abs(n3(vec3(uv * 16., r * 9. + 4.)));
    float net = min(na / 9. - 0.004, nb / 16. - 0.002) * 1.2;
    return max(abs(pl + 0.03 * n3(vec3(uv * 3., r * 9.))) - p2, max(dr, net)) * 0.8;
  }
  if (type == P_TABLE) {
    vec3 tt, bb; frameOf(n, tt, bb);
    vec3 q0 = p - a;
    vec3 q = vec3(dot(q0, tt), dot(q0, n), dot(q0, bb));   // y along the plate's normal
    float ang = atan(q.z, q.x);
    float rad = length(q.xz);
    float rr = r * (1. + 0.12 * n3(vec3(ang * 1.4, 7., 0.)) + 0.06 * n3(vec3(ang * 6., 7., 3.)));
    float dy = abs(q.y - 0.05 * rad * rad / r - 0.008 * n3(vec3(q.xz * 30., 7.)) - 0.006 * smoothstep(0.3, 0.7, n3(vec3(q.xz * 70., 3.)))) - p2;
    float d = max(dy, rad - rr);
    d = min(d, sdCapsule(p, a - n * 0.2, a, 0.04));
    return d * 0.8;
  }
  return 1e9;
}

vec2 reef(vec3 p) {
  vec3 g = (p - uGridMin) / uGridCell;
  vec3 N = vec3(uGridN);
  if (any(lessThan(g, vec3(0.))) || any(greaterThanEqual(g, N))) {
    vec3 c = uGridMin + 0.5 * N * uGridCell;
    vec3 q = abs(p - c) - 0.5 * N * uGridCell;
    return vec2(max(length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.), 0.02), M_ROCK);
  }
  ivec3 c = ivec3(floor(g));
  vec4 cd = fetchT(uCell, (c.z * uGridN.y + c.y) * uGridN.x + c.x);
  int start = int(cd.x + 0.5), cnt = int(cd.y + 0.5), nl = int(cd.z + 0.5);
  float dl = 1e9;
  for (int k = 0; k < 16; k++) {
    if (k >= nl) break;
    int i = int(fetchT(uIdx, start + k).r + 0.5);
    vec4 t0 = fetchT(uPrim, i * 4), t1 = fetchT(uPrim, i * 4 + 1), t2 = fetchT(uPrim, i * 4 + 2);
    dl = smin(dl, sdEllipsoid(p - t0.xyz, t1.xyz), t2.w);
  }
  vec2 r = vec2(nl > 0 ? rockSurf(p, dl) : 0.25, M_ROCK);
  r.x = min(r.x, 0.25);
  float dc = MARGIN_COL, dd = MARGIN_COL;
  float mc = 0., md = 0.;
  for (int k = 0; k < 128; k++) {
    if (nl + k >= cnt) break;
    int i = int(fetchT(uIdx, start + nl + k).r + 0.5);
    float d = primSD(i, p);
    if (int(fetchT(uPrim, i * 4).w + 0.5) == P_DOME) { if (d < dd) { dd = d; md = float(100 + i); } }
    else if (d < dc) { dc = d; mc = float(100 + i); }
  }
  // domes grow out of the rock: blend them in
  float rk = smin(r.x, dd, 0.08);
  if (dd < r.x + 0.02 && md > 0.) r.y = md;
  r.x = rk;
  if (dc < r.x) r = vec2(dc, mc > 0. ? mc : M_ROCK);
  return r;
}

vec2 structure(vec3 p) {
  vec3 q = wallUVW(p);
  float wall = q.z + (q.x < -4.3 ? 1. : 0.) + 0.004 * n3(p * 3.);
  // pilasters between the windows
  wall = min(wall, length(max(abs(q - vec3(3.17, 0., 0.15)) - vec3(0.18, 6., 0.15), 0.)));
  wall = min(wall, length(max(abs(q - vec3(-4.3, 0., -0.6)) - vec3(0.2, 6., 0.5), 0.)));
  vec2 r = vec2(wall, M_WALL);
  float led = min(frameSD(q, WINA, 0., 0.045), frameSD(q, WINB, 0., 0.05));
  r = opU(r, vec2(led, M_LED));
  float rail = min(railSD(q, WINA, 0.2), railSD(q, WINB, 0.16));
  r = opU(r, vec2(rail, M_RAIL));
  vec3 qc = q; qc.z -= -1.;
  r = opU(r, vec2(frameSD(qc, WINC, 0., 0.04), M_RAIL));
  float pipe = length(q.yz - vec2(-1.36, 0.55)) - 0.38;
  pipe = max(pipe, max(0.75 - q.x, q.x - 8.6));
  r = opU(r, vec2(pipe, M_PIPE));
  float pipeL = length(q.yz - vec2(-1.55, 1.05)) - 0.4;
  pipeL = max(pipeL, 9.0 - q.x);
  r = opU(r, vec2(pipeL, M_PIPEL));
  float br = min(length(max(abs(q - vec3(3.35, -1.55, 0.4)) - vec3(0.06, 0.5, 0.4), 0.)),
                 length(max(abs(q - vec3(8.1, -1.6, 0.6)) - vec3(0.07, 0.55, 0.6), 0.)));
  r = opU(r, vec2(br, M_PIPE));
  float fl = p.y + 4.2 + 0.25 * fbm(p * 0.35, 2);
  r = opU(r, vec2(fl, M_SAND));
  return r;
}

vec2 map(vec3 p) { return opU(structure(p), reef(p)); }
`;

export const bakeFrag = /* glsl */ `
${common}
${sdf}
uniform vec3 uCamPos;
uniform mat4 uCamWorld;
uniform mat4 uProjInv;
uniform vec2 uJit;       // sub-pixel offset in uv
uniform float uMirror;   // 1: bake the view in the mirror of the surface
uniform float uSeed;
uniform float uW;
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;

vec3 calcNormal(vec3 p, float eps) {
  const vec2 k = vec2(1, -1);
  return normalize(k.xyy * map(p + k.xyy * eps).x + k.yyx * map(p + k.yyx * eps).x +
                   k.yxy * map(p + k.yxy * eps).x + k.xxx * map(p + k.xxx * eps).x);
}
vec2 march(vec3 ro, vec3 rd, float tmax) {
  float t = 0.02, m = 0.;
  for (int i = 0; i < 600; i++) {
    vec2 h = map(ro + rd * t);
    if (h.x < 0.0002 * t) { m = h.y; break; }
    t += h.x * 0.6;
    if (t > tmax) break;
  }
  return vec2(t, m);
}
float softShadow(vec3 ro, vec3 rd, float tmax) {
  float res = 1., t = 0.02;
  for (int i = 0; i < 64; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, 18. * h / t);
    if (res < 0.01) break;
    t += clamp(h * 0.7, 0.01, 0.3);
    if (t > tmax) break;
  }
  return clamp(res, 0., 1.);
}
float occl(vec3 ro, vec3 rd, float tmax) {
  float t = 0.015;
  for (int i = 0; i < 24; i++) {
    float h = map(ro + rd * t).x;
    if (h < 0.002) return 0.;
    t += clamp(h * 0.8, 0.01, 0.25);
    if (t > tmax) return 1.;
  }
  return 1.;
}
vec3 cosDir(vec3 n, vec2 u) {
  float a = 6.2831853 * u.x, b = sqrt(u.y);
  vec3 t = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0)));
  vec3 bt = cross(n, t);
  return normalize(t * cos(a) * b + bt * sin(a) * b + n * sqrt(1. - u.y));
}

vec3 interior(vec3 q, vec3 dq, vec4 win, float lit) {
  // the viewing hall behind the glass: dim when seen nearly level (as from the camera), but its lit floor
  // fills the window when seen from above (as in the mirror of the surface)
  float steep = smoothstep(0.08, 0.16, -dq.y);
  vec2 g = (q.xy - win.xy) / win.zw;
  vec3 dim = vec3(0.01, 0.04, 0.065) * (0.8 + 0.2 * smoothstep(-1., 1., g.y));
  // lit part of the hall as the mirror sees it: the left of window A stays dark, window B only lights
  // toward its upper right (where its hall opens)
  float open_ = win.x > 5. ? smoothstep(0.1, 0.9, g.x * 0.7 + g.y * 0.5) : smoothstep(-0.55, -0.15, g.x);
  vec3 hall = vec3(0.3, 2.0, 1.4) * open_ * (0.85 + 0.15 * g.y);
  return mix(dim, hall, steep) * lit;
}

vec3 speckle(vec3 c, vec3 p) {
  c *= mix(1., 0.6, smoothstep(0.5, 0.8, n3(p * 38. + 5.)));         // pits and shadowed pores
  c = mix(c, vec3(0.46, 0.5, 0.4), 0.55 * smoothstep(0.62, 0.86, n3(p * 57. + 3.)));   // pale polyps
  return c;
}
vec3 albedo0(float m, vec3 p, vec3 n);
vec3 albedo(float m, vec3 p, vec3 n) {
  vec3 c = albedo0(m, p, n);
  if (m == M_ROCK || m >= 100.) c = speckle(c, p);
  return c;
}
vec3 albedo0(float m, vec3 p, vec3 n) {
  float v = n3(p * 4.3 + 17.);
  if (m >= 100.) {
    int i = int(m - 100. + 0.5);
    vec4 t3 = fetchT(uPrim, i * 4 + 3);
    vec3 c = t3.rgb * (0.85 + 0.3 * n3(p * 9. + t3.w));
    // pale growing tips and polyp specks
    c *= 1. + 0.35 * smoothstep(0.55, 0.9, n3(p * 37. + t3.w));
    c *= 1. + 0.25 * smoothstep(0.3, 0.9, n.y);   // living tissue on the lit top is paler
    // blades are pale along their growing edges
    vec4 t0 = fetchT(uPrim, i * 4);
    if (int(t0.w + 0.5) == P_BLADE) {
      vec4 t1 = fetchT(uPrim, i * 4 + 1);
      vec3 pa = p - t0.xyz, ba = t1.xyz - t0.xyz;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
      vec3 nn = fetchT(uPrim, i * 4 + 2).xyz;
      vec3 q = pa - ba * h;
      float e = length(q - nn * dot(q, nn)) - t1.w * (1. - 0.25 * h);
      c *= 1. + 0.25 * smoothstep(-0.05, 0., e) + 0.15 * h;
    }
    return c;
  }
  if (m == M_ROCK) {
    float a = fbm(p * 1.7 + 11., 3);
    vec3 c = mix(vec3(0.30, 0.28, 0.23), vec3(0.18, 0.2, 0.19), 0.5 + 0.5 * a);
    c = mix(c, vec3(0.14, 0.30, 0.16), smoothstep(0.1, 0.5, n3(p * 1.3 + 5.)) * 0.7);
    c = mix(c, vec3(0.30, 0.17, 0.27), smoothstep(0.35, 0.7, n3(p * 1.9 + 21.)) * 0.6);
    c = mix(c, vec3(0.48, 0.45, 0.36), smoothstep(0.3, 0.8, n3(p * 7.5 + 2.)) * 0.45);
    c *= 0.75 + 0.35 * smoothstep(-0.5, 0.5, n3(p * 3.3 + 8.));
    return c;
  }
  if (m == M_WALL) {
    vec3 q = wallUVW(p);
    // big cladding panels of slightly different tone, with dark joints and streaks
    vec2 pid = floor(vec2(q.x / 2.4, q.y / 1.9));
    float tone = 0.7 + 0.6 * fract(sin(dot(pid, vec2(12.9, 78.2))) * 43758.5);
    return vec3(0.09, 0.10, 0.11) * tone * (0.85 + 0.3 * fbm(p * 0.8, 2)) * (0.8 + 0.2 * n3(vec3(q.x * 6., q.y * 0.4, 1.)));
  }
  if (m == M_PIPE) return vec3(0.06, 0.08, 0.10);
  if (m == M_PIPEL) return vec3(0.3, 0.8, 1.1);
  if (m == M_RAIL) return vec3(0.35, 0.45, 0.55);
  if (m == M_SAND) return vec3(0.35, 0.33, 0.28);
  return vec3(0.3);
}

// lighting at a hit point: returns the part lit straight from above (B) and everything else (A)
float gUp = 0.;
void light(vec3 p, vec3 rd, float m, float t, out vec3 A, out vec3 B) {
  vec3 q = wallUVW(p);
  B = vec3(0.);
  if (m == M_LED) { A = vec3(0.04, 1.3, 1.9); return; }
  vec3 n = calcNormal(p, max(0.0006, 0.0004 * t));
  if (m == M_ROCK || m >= 100.) {
    // fine relief below what the distance field resolves
    const float e = 0.004;
    vec3 q = p * 24.;
    float b0 = n3(q);
    vec3 gb = vec3(n3(q + vec3(e * 24., 0, 0)), n3(q + vec3(0, e * 24., 0)), n3(q + vec3(0, 0, e * 24.))) - b0;
    n = normalize(n - 0.22 * (gb / (e * 24.) - dot(gb / (e * 24.), n) * n));
  }
  gUp = smoothstep(0.1, 0.7, n.y);
  vec3 a = albedo(m, p, n);
  vec3 po = p + n * 0.004;
  bool cheap = m == M_WALL || m == M_PIPE || m == M_PIPEL || m == M_RAIL || m == M_SAND;
  // direct: lamps above the surface, a soft cone around straight up
  float vis = 0., occ = 0.;
  vec3 ambL = vec3(0.);
  const int NS = 6, NA = 10;
  // thin colonies (blades, fans, table plates) let light through from the far side
  float thin = 0.;
  if (m >= 100.) {
    int ty = int(fetchT(uPrim, int(m - 100. + 0.5) * 4).w + 0.5);
    thin = ty == P_BLADE || ty == P_FAN || ty == P_TABLE ? 1. : 0.;
  }
  for (int i = 0; i < NS; i++) {
    vec2 u = hash22(vUv * 4096. + float(i) * 7.3 + uSeed);
    float ang = 6.2831853 * u.x, rad = 0.22 * sqrt(u.y);   // narrow lamps: hard light from above
    vec3 ld = normalize(vec3(cos(ang) * rad + 0.1, 1., sin(ang) * rad + 0.2));
    float c = max(dot(n, ld), 0.) + thin * 0.45 * max(-dot(n, ld), 0.);
    // thin plates stick out past the ones above them and light scatters around their edges: softer shadow
    if (c > 0.) vis += c * (cheap ? 1. : mix(1., 0.6, thin) * softShadow(po, ld, 4.) + 0.25 * thin);
  }
  vis /= float(NS);
  // a second, weaker lamp above the viewing side lights the faces turned toward the camera
  vec3 ld2 = normalize(vec3(0.25, 0.75, 0.62));
  float c2 = max(dot(n, ld2), 0.) + thin * 0.45 * max(-dot(n, ld2), 0.);
  c2 *= mix(smoothstep(-1.6, -0.3, p.y), 1., thin);   // aimed at the tops of the rockwork, and the front of the plates
  if (c2 > 0.) vis += (0.4 + 0.5 * thin) * c2 * (cheap ? 1. : mix(1., 0.6, thin) * softShadow(po, ld2, 4.) + 0.25 * thin);
  // ambient: water light from every side, occluded by nearby rock
  for (int i = 0; i < NA; i++) {
    vec2 u = hash22(vUv * 3111. + float(i) * 3.7 + uSeed + 11.);
    vec3 d = cosDir(n, u);
    float o = cheap ? 1. : occl(po, d, 1.2);
    // ambient fill: water light from all round (milder toward the lamps than the haze a camera sees),
    // and nearby rock only partly blocks it because the water around it scatters light back in
    vec3 wr = waterRadiance(p.y, d) * exp(-1.2 * d.y);
    ambL += mix(0.3, 1., o) * wr;
  }
  ambL *= 3.14159 / float(NA);
  vec3 L = downLight(p.y);
  A = a * ambL * vec3(0.86, 0.9, 1.05);
  B = a * L * vis * 0.55;
  if (!cheap) {
    // the reef is lit hard from above: tops and the upper faces of plates glow pale cyan-green, sides and
    // undersides fall into deep blue (the fill light from the water is much weaker than the lamps)
    float topF = smoothstep(-0.2, 0.85, n.y);
    A *= mix(0.42, 1.0, topF);
    B *= mix(0.6, 1.5, smoothstep(0.35, 0.95, n.y));
    // the lit tops take on a pale, slightly greener tint (living tissue and algae under white light)
    B *= mix(vec3(1.), vec3(1.25, 1.12, 0.78), smoothstep(0.45, 0.95, n.y) * 0.8 + 0.2);
    // the lamps light the rockwork in pools: some faces catch a bright pool, others stay in the dim between
    float pool = smoothstep(-0.35, 0.45, n3(vec3(p.x * 0.7, p.y * 0.5, p.z * 0.7) + 21.)) ;
    B *= 0.4 + 1.35 * pool;
    // the lamps are aimed at the top of the rockwork: deeper down the light falls off fast and turns blue
    float deep = smoothstep(-0.5, -2.6, p.y);
    B *= mix(vec3(1.), vec3(0.3, 0.42, 0.55), deep);
    A *= mix(vec3(1.), vec3(0.75, 0.82, 0.95), deep);
  }
  // light spill from the lit frames onto the wall and pipes
  if (cheap) {
    float dA = sdRoundRect(q.xy - WINA.xy, WINA.zw, 0.12);
    float dB = sdRoundRect(q.xy - WINB.xy, WINB.zw, 0.12);
    A += vec3(0.01, 0.1, 0.28) * (exp(-abs(dA) * 4.) + exp(-abs(dB) * 4.)) * a * 1.6;
    if (m == M_PIPEL) A += vec3(0.01, 0.2, 0.36);   // the light pipe is lit from the window next to it
  }
  if (m == M_WALL) {
    vec3 dq = vec3(dot(rd, WT), rd.y, dot(rd, WN));
    for (int k = 0; k < 3; k++) {
      vec4 win = k == 0 ? WINA : k == 1 ? WINB : WINC;
      vec3 qq = q; if (k == 2) qq.z -= -1.;
      if (all(lessThan(abs(qq.xy - win.xy), win.zw - 0.04))) {
        A = interior(vec3(qq.xy, 0.), dq, win, k == 2 ? 0.5 : k == 1 ? 0.8 : 0.85) + A * 0.2;
        B *= 0.1;
      }
    }
    A *= 1. - 0.3 * smoothstep(0.015, 0., abs(fract(q.x / 2.4 + 0.5) - 0.5) * 2.4);
  }
}

void bakeMain() {
  vec4 ndc = vec4((vUv + uJit) * 2. - 1., 1., 1.);
  vec4 v = uProjInv * ndc; v /= v.w;
  vec3 rd = normalize((uCamWorld * vec4(v.xyz, 0.)).xyz);
  vec3 ro = uCamPos;
  vec3 T;
  if (uMirror > 0.5) {
    // the mirrored ray starts where the camera ray meets the surface and heads down
    if (rd.y < -0.04) { o0 = vec4(0.); o1 = vec4(0.); o2 = vec4(0.); return; }
    rd.y = max(rd.y, 0.002);
    ro = ro + rd * (YS - ro.y) / rd.y;
    rd.y = -rd.y;
    ro.y -= 0.001;
  }
  float tsurf = rd.y > 0. ? (YS - ro.y) / rd.y : 1e9;
  vec2 h = march(ro, rd, min(tsurf, 95.));
  if (h.x < tsurf && h.y > 0.) {
    vec3 p = ro + rd * h.x;
    vec3 A, B;
    light(p, rd, h.y, h.x, A, B);
    vec3 I = inscatter(ro, rd, h.x, T);
    o0 = vec4(A * T + I, 1.);
    o1 = vec4(B * T, gUp);
    o2 = vec4(p, 1.);
    return;
  }
  if (tsurf > 1e8 || uMirror > 0.5) {
    // open water (no hit)
    vec3 I = inscatter(ro, rd, 95., T);
    o0 = vec4(I, 1.); o1 = vec4(0.); o2 = vec4(ro + rd * 95., 0.);
    return;
  }
  // the camera ray reaches the surface: store the water up to it; the mirror is added per frame
  vec3 I = inscatter(ro, rd, tsurf, T);
  o0 = vec4(I, 1.);
  o1 = vec4(T, 1.);
  o2 = vec4(ro + rd * tsurf, 2.);
}
void main() { bakeMain(); o0 *= uW; o1 *= uW; o2 *= uW; }
`;

// per frame: caustics, the wavy mirror, depth for the meshes drawn on top
export const compFrag = /* glsl */ `
${common}
uniform sampler2D uS0, uS1, uP, uM0, uM1, uMP, uFM;
uniform float uT;
uniform mat4 uCamWorld;
uniform mat4 uProjInv;
uniform mat4 uViewProj;
uniform mat4 uBakeViewProj;
uniform vec3 uCamPos;
uniform float uWave;
uniform float uBlurPx;
uniform vec2 uBakeTexel;
in vec2 vUv;
layout(location = 0) out vec4 o0;

float caustic(vec3 p) {
  // light net focused by the rippling surface. Cells about 5 - 10 cm across,
  // re-forming within about 4 frames (a fast shimmer), so two fine nets drifting quickly in opposite ways.
  // The net is projected along the light (tilted toward the camera) so it also falls on steep faces.
  vec2 x = p.xz + vec2(0.1, 0.45) * (p.y - YS);
  float t = uT * 6.8;
  float a = abs(n3(vec3(x * 11., t) + vec3(0., 0., 3.)));
  float b = abs(n3(vec3(x * 17. + vec2(t * 0.35, -t * 0.2), t * 1.3) + vec3(4., 1., 7.)));
  float c = pow(max(1. - min(a, b) * 2.2, 0.), 4.);
  // and a coarser, slower swell of brightness from the bigger surface waves
  float big = 0.5 + 0.5 * n3(vec3(x * 1.6, uT * 0.9) + 11.);
  return (0.72 + 0.95 * c) * (0.82 + 0.36 * big);
}
float surfH(vec2 x, float t) {
  // small wind and pump ripples: the mirror image shifts by ~7 px and
  // re-forms within ~5 frames
  float h = 0.;
  h += 0.0045 * sin(dot(x, vec2(0.10, 0.99)) * 2.9 + t * 4.6);
  h += 0.0032 * sin(dot(x, vec2(-0.35, 0.94)) * 4.2 - t * 5.5 + 1.2);
  h += 0.0022 * sin(dot(x, vec2(0.55, 0.83)) * 6.4 + t * 6.8 + 2.1);
  h += 0.0040 * n3(vec3(x * vec2(0.8, 1.8), t * 1.3));
  h += 0.0016 * n3(vec3(x * vec2(2.3, 4.6), t * 2.4) + 5.);
  return h * uWave;
}
vec3 surfNormal(vec2 x, float t) {
  const float e = 0.03;
  float h = surfH(x, t);
  return normalize(vec3(-(surfH(x + vec2(e, 0.), t) - h) / e, 1., -(surfH(x + vec2(0., e), t) - h) / e));
}
vec2 toBake(vec3 d) {
  vec4 c = uBakeViewProj * vec4(uCamPos + d, 1.);
  return c.xy / c.w * 0.5 + 0.5;
}
void main() {
  vec4 ndc = vec4(vUv * 2. - 1., 1., 1.);
  vec4 v = uProjInv * ndc; v /= v.w;
  vec3 rd = normalize((uCamWorld * vec4(v.xyz, 0.)).xyz);
  vec2 uv = toBake(rd);
  vec4 P = texture(uP, uv);
  // forward scattering in the water softens distant things: blur the baked view more with distance
  float dist = length(P.xyz - uCamPos);
  float rad = clamp((dist - 8.) * 0.12, 0., 2.2) * uBlurPx;
  vec4 s0 = texture(uS0, uv), s1 = texture(uS1, uv);
  if (rad > 0.05 && P.w < 1.5) {
    const vec2 k[8] = vec2[](vec2(0.71, 0.26), vec2(-0.3, 0.84), vec2(-0.86, -0.13), vec2(0.18, -0.9),
                             vec2(0.45, 0.62), vec2(-0.58, 0.35), vec2(-0.25, -0.5), vec2(0.62, -0.42));
    for (int i = 0; i < 8; i++) {
      vec2 o = k[i] * rad * uBakeTexel;
      s0 += texture(uS0, uv + o); s1 += texture(uS1, uv + o);
    }
    s0 /= 9.; s1 /= 9.;
  }
  vec3 col;
  vec3 pos = P.xyz;
  if (P.w < 1.5) {
    col = s0.rgb + s1.rgb * (P.w > 0.5 ? mix(0.9, caustic(P.xyz), 0.35 + 0.65 * s1.w) : 1.);
  } else {
    vec3 ps = P.xyz;
    vec3 n = surfNormal(ps.xz, uT * 1.3);
    vec3 r = reflect(rd, -n);
    r.y = min(r.y, -0.002);
    vec2 um = toBake(vec3(r.x, -r.y, r.z));
    vec4 m0 = texture(uM0, um), m1 = texture(uM1, um), mp = texture(uMP, um);
    vec3 m = m0.rgb + m1.rgb * (mp.w > 0.5 ? mix(0.85, caustic(mp.xyz), m1.w) : 1.);
    vec4 fm = texture(uFM, um);
    m = m * (1. - fm.a) + fm.rgb;
    col = s0.rgb + s1.rgb * m * 0.97;
  }
  if (any(isnan(col))) col = vec3(0.02, 0.1, 0.3);
  o0 = vec4(col, 1.);
  vec4 clip = uViewProj * vec4(pos, 1.);
  gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0., 1.);
}
`;

export const postFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uT;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 c = vec3(0.);
  c += texture2D(uTex, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25 * uExposure;
  // veiling glare of the thick acrylic panel and the phone lens: a little of the frame's average light
  // over everything, which lifts the shadows and flattens the contrast of the rockwork
  c = mix(c, vec3(0.016, 0.12, 0.34), 0.22);
  c = c / (1. + 0.25 * c);
  vec3 s = toSRGB(clamp(c, 0., 1.));
  s += (hash(vUv * 1931. + fract(uT * 7.3)) - 0.5) * 0.014;
  gl_FragColor = vec4(s, 1.);
}
`;
