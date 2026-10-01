// Fish: procedural bodies and fins, swimming by a travelling wave in the vertex shader, silver skin that
// mirrors the water around it, drawn with the same water model as the baked tank. Each fish is drawn twice:
// once for the camera, and once into the mirror of the surface (the reflection is composited with the
// same wavy lookup as the baked mirror).
import * as THREE from 'three';
import { water } from './world.js';

// ---- species ----
// profile keys along the body, s = 0 at the snout to 1 at the end of the caudal peduncle:
// [s, half height, half width, centre offset], all in units of body length
const SPECIES = {
  tarpon: {
    // tarpon: the back runs almost straight from the snout to the tail; the belly carries the depth;
    // the lower jaw juts up at the front, so the mouth sits at the top of the snout
    profile: [[0, 0.0115, 0.006, 0.0235], [0.03, 0.0300, 0.016, 0.0200], [0.08, 0.0525, 0.028, 0.0175], [0.15, 0.0750, 0.04, 0.0150], [0.25, 0.0950, 0.05, 0.0100], [0.4, 0.1075, 0.056, 0.0075],
      [0.55, 0.1065, 0.052, 0.0085], [0.66, 0.0940, 0.042, 0.0140], [0.76, 0.0650, 0.03, 0.0200], [0.85, 0.0465, 0.018, 0.0215], [0.92, 0.0340, 0.01, 0.0220], [1, 0.0260, 0.005, 0.0240]],
    caudal: { len: 0.22, h: 0.17, fork: 0.62 }, dorsal: [0.4, 0.52, 0.13, 1], anal: [0.64, 0.78, 0.11],
    pect: [0.21, 0.15], pelv: [0.46, 0.08],
    back: [0.02, 0.04, 0.055], silver: 0.85, backTo: 0.55, sheen: 0.05, finSilver: 1.3, scale: 0.016, fin: [0.07, 0.08, 0.085], finA: 0.95, eye: 0.042, paired: [0.2, 0.2, 0.15], rim: 0.17, tilt: 0.45, dash: 0.9,
  },
  jack: {
    // deep body with a steep forehead and a low mouth
    profile: [[0, 0.03, 0.012, -0.03], [0.03, 0.085, 0.026, -0.018], [0.08, 0.145, 0.044, -0.006], [0.15, 0.1925, 0.0605, 0.004], [0.25, 0.2236, 0.0682, 0.01],
      [0.38, 0.2297, 0.0682, 0.01], [0.5, 0.215, 0.0616, 0.006], [0.62, 0.19, 0.0495, 0.002], [0.75, 0.14, 0.036, 0], [0.86, 0.085, 0.022, 0],
      [0.94, 0.045, 0.012, 0], [1, 0.03, 0.009, 0]],
    caudal: { len: 0.25, h: 0.19, fork: 0.72 }, dorsal: [0.42, 0.62, 0.08, 0], anal: [0.56, 0.78, 0.07],
    pect: [0.24, 0.14], pelv: [0.3, 0.04],
    back: [0.015, 0.03, 0.05], silver: 0.7, rim: 0.1, backTo: 0.4, sheen: 0.14, finSilver: 0.4, scale: 0.012, fin: [0.16, 0.16, 0.14], finA: 0.95, eye: 0.075, tilt: 0.08,
  },
  reef: {
    profile: [[0, 0.02, 0.012, -0.01], [0.05, 0.1, 0.05, 0], [0.2, 0.2, 0.08, 0.01], [0.45, 0.21, 0.08, 0.01], [0.7, 0.13, 0.05, 0], [0.9, 0.07, 0.025, 0], [1, 0.05, 0.016, 0]],
    caudal: { len: 0.22, h: 0.16, fork: 0.1 }, dorsal: [0.2, 0.85, 0.1, 0], anal: [0.55, 0.85, 0.08],
    pect: [0.25, 0.12], pelv: [0.3, 0.05],
    back: [0.25, 0.22, 0.05], silver: 0.15, backTo: 0.3, sheen: 0.05, finSilver: 0.3, rim: 0.2, tilt: 0.05, scale: 0.03, fin: [0.5, 0.45, 0.1], finA: 0.8, eye: 0.08,
  },
};

function interpProfile(pr, s) {
  // Catmull-Rom through the keys (a smoothstep per span would leave flat spots at every key)
  let i = 0;
  while (i < pr.length - 2 && pr[i + 1][0] < s) i++;
  const k0 = pr[Math.max(i - 1, 0)], k1 = pr[i], k2 = pr[i + 1], k3 = pr[Math.min(i + 2, pr.length - 1)];
  const t = Math.min(Math.max((s - k1[0]) / (k2[0] - k1[0]), 0), 1);
  const out = [];
  for (let c = 1; c <= 3; c++) {
    const m1 = (k2[c] - k0[c]) / Math.max(k2[0] - k0[0], 1e-6) * (k2[0] - k1[0]);
    const m2 = (k3[c] - k1[c]) / Math.max(k3[0] - k1[0], 1e-6) * (k2[0] - k1[0]);
    const t2 = t * t, t3 = t2 * t;
    out.push((2 * t3 - 3 * t2 + 1) * k1[c] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * k2[c] + (t3 - t2) * m2);
  }
  return [Math.max(out[0], 0.0005), Math.max(out[1], 0.0005), out[2]];
}

// body: local x forward (snout at x = 0, tail toward -x), y up, z to the fish's left; unit length
function bodyGeometry(sp, nS = 90, nA = 36) {
  const pos = [], attr = [];
  for (let i = 0; i < nS; i++) {
    const s = Math.pow(i / (nS - 1), 1.35);
    const [hh, hw, yo] = interpProfile(sp.profile, s);
    for (let j = 0; j < nA; j++) {
      const a = (j / nA) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // compressed body with a slightly sharper back and belly
      const y = yo + hh * sa;
      const z = hw * ca;
      pos.push(-s, y, z);
      attr.push(s, sa, ca, 0);   // sin and cos rather than the angle, so nothing jumps at the seam
    }
  }
  // closing point at the end of the peduncle
  const [, , yoE] = interpProfile(sp.profile, 1);
  pos.push(-1.004, yoE, 0);
  attr.push(1, 0, 1, 0);
  const idx = [];
  for (let i = 0; i < nS - 1; i++) for (let j = 0; j < nA; j++) {
    const a = i * nA + j, b = i * nA + ((j + 1) % nA), c = a + nA, d = b + nA;
    idx.push(a, c, b, b, c, d);
  }
  const tip = nS * nA;
  for (let j = 0; j < nA; j++) idx.push((nS - 1) * nA + j, tip, (nS - 1) * nA + ((j + 1) % nA));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFish', new THREE.Float32BufferAttribute(attr, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// fins: flat grids whose outline is cut in the fragment shader; aFish = (s, u, v, kind)
// kinds: 1 caudal, 2 dorsal, 3 anal, 4 pectoral, 5 pelvic
function finGeometry(sp, keep = () => true) {
  const pos = [], attr = [], idx = [];
  const grid = (nu, nv, place, kind) => {
    if (!keep(kind)) return;
    const base = pos.length / 3;
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const u = i / nu, v = j / nv;
      const [x, y, z, s] = place(u, v);
      pos.push(x, y, z);
      attr.push(s, u, v, kind);
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = base + i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  };
  const c = sp.caudal;
  // caudal fin: from the peduncle backward, v across the fin from -1 (bottom) to 1 (top)
  // rooted on the peduncle's centre line; at the root it is as tall as the peduncle
  const [hhE, , yoE0] = interpProfile(sp.profile, 0.95);
  grid(16, 20, (u, v) => {
    const s = 0.95 + u * (c.len + 0.02);
    // stays as tall as the peduncle until past the end of the body, then opens
    const uo = Math.max(u - 0.25, 0) / 0.75;
    const half = hhE * 0.92 + (c.h - hhE * 0.92) * Math.pow(uo, 0.8);
    return [-s, yoE0 + (v * 2 - 1) * half, 0, s];
  }, 1);
  const [d0, d1, dh] = sp.dorsal;
  grid(14, 8, (u, v) => {
    const s = d0 + (d1 - d0) * u + v * dh * (sp.dorsal[3] ? 0.5 + 3.2 * Math.pow(u, 6) * v : 0.5);
    const [hh, , yo] = interpProfile(sp.profile, d0 + (d1 - d0) * u);
    return [-s, yo + hh * 0.96 + v * dh * (sp.dorsal[3] ? 1 - 0.55 * Math.pow(u, 6) * v : 1), 0, s];
  }, 2);
  const [a0, a1, ah] = sp.anal;
  grid(12, 6, (u, v) => {
    const s = a0 + (a1 - a0) * u + v * ah * 0.4;
    const [hh, , yo] = interpProfile(sp.profile, a0 + (a1 - a0) * u);
    return [-s, yo - hh * 0.96 - v * ah, 0, s];
  }, 3);
  for (const side of [-1, 1]) {
    const [ps, pl] = sp.pect;
    grid(8, 5, (u, v) => {
      const [hh, hw, yo] = interpProfile(sp.profile, ps);
      const s = ps + u * pl;
      return [-s, yo - hh * 0.72 - u * pl * 0.45 + v * pl * 0.28, side * (hw * 0.75 + u * pl * 0.3), s];
    }, 4);
    const [vs, vl] = sp.pelv;
    grid(6, 4, (u, v) => {
      const [hh, hw, yo] = interpProfile(sp.profile, vs);
      const s = vs + u * vl;
      return [-s, yo - hh * 0.9 - u * vl * 0.3, side * (hw * 0.4 + u * vl * 0.3 + v * vl * 0.15), s];
    }, 5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFish', new THREE.Float32BufferAttribute(attr, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const fishVert = /* glsl */ `
precision highp float;
attribute vec4 aFish;
uniform float uT, uLen, uPhase, uCycle, uAmp, uBend, uWaveK, uEyeV;
uniform mat4 uFishMat;      // fish frame to world (rotation and translation, no scale)
uniform mat4 uViewProjX;    // camera, or the mirror view
uniform float uMirror;
uniform float uYS;
varying vec3 vW, vN;
varying vec4 vF;
varying vec3 vL;

// sideways displacement of the spine at s (fraction of body length)
float wave(float s) {
  float env = 0.06 + 0.94 * s * s;
  return uAmp * env * sin(6.2831853 * (s * uWaveK - uCycle) + uPhase) + 0.5 * uBend * s * s;
}
void main() {
  vec3 p = position;
  vec3 n = normal;
  float s = aFish.x;
  float kind = aFish.w;
  // fins of the body kind 0 use the body s; all parts follow the spine wave
  float z0 = wave(s), z1 = wave(s + 0.01);
  float slope = (z1 - z0) / 0.01;          // dz/ds; x = -s, so dz/dx = -slope
  p.z += z0;
  // rotate the local normal with the bending spine
  float ang = atan(-slope);
  float ca = cos(ang), sa = sin(ang);
  n = vec3(n.x * ca - n.z * sa, n.y, n.x * sa + n.z * ca);
  // the caudal fin flexes further than the spine, its lobes lagging: seen from an angle it opens and closes
  if (kind > 0.5 && kind < 1.5) {
    float uu = aFish.y, vv = abs(aFish.z * 2. - 1.);
    p.z += uAmp * (0.9 * uu + 0.6 * vv * uu) * sin(6.2831853 * (1.1 * uWaveK - uCycle) + uPhase - 0.9 - 0.6 * vv);
  }
  // pectoral fins paddle a little
  if (kind > 3.5 && kind < 4.5) p.y += 0.012 * sin(uT * 5. + uPhase) * aFish.y;
  // breathing: the rear of the gill cover lifts off the body, the lower jaw drops a little
  float breathe = 0.5 + 0.5 * sin(6.2831853 * uT / 2.2 + uPhase);
  if (kind < 0.5) {
    float up = aFish.y;
    float edge = uEyeV * 3.4 + 0.03 * (1. - up * up);
    p.z += sign(position.z) * 0.004 * breathe * smoothstep(edge - 0.07, edge, s) * step(s, edge) * step(abs(up), 0.85);
    p.y -= 0.006 * breathe * smoothstep(uEyeV * 1.6, 0., s) * smoothstep(0., -0.6, up);
  }
  vL = p;
  vec4 w = uFishMat * vec4(p * uLen, 1.);
  vW = w.xyz;
  vN = normalize(mat3(uFishMat) * n);
  vF = aFish;
  vec4 wp = w;
  if (uMirror > 0.5) wp.y = 2. * uYS - wp.y;
  gl_Position = uViewProjX * wp;
}
`;

const fishFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform vec3 uCamPos;
uniform float uT, uMirror, uLen, uSeed, uPhase;
uniform vec3 uBack, uFin;
uniform vec3 uEyePos;
uniform vec3 uPaired;
uniform mat4 uFishMat;
uniform float uDorsalFil;
uniform float uDash;
uniform float uSilver, uScale, uFinA, uEye, uFork, uRim, uTilt, uBackTo, uSheen, uFinSilver;
varying vec3 vW, vN;
varying vec4 vF;
varying vec3 vL;
${water}
float n3(vec3 p) { return texture(uNoise, p * (1. / 32.)).r * 2. - 1.; }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float caustic(vec3 p) {
  vec2 x = p.xz + vec2(0.1, 0.45) * (p.y - YS);
  float t = uT * 6.8;
  float a = abs(n3(vec3(x * 11., t) + vec3(0., 0., 3.)));
  float b = abs(n3(vec3(x * 17. + vec2(t * 0.35, -t * 0.2), t * 1.3) + vec3(4., 1., 7.)));
  float c = pow(max(1. - min(a, b) * 2.2, 0.), 4.);
  return 0.62 + 1.25 * c;
}
// light reaching the fish from direction r (for its mirror-like skin)
vec3 envLight(vec3 p, vec3 r) {
  vec3 w = waterRadiance(p.y, r);
  // the lamps above: a broad bright lobe
  float lobe = pow(max(r.y, 0.), 1.5) * 0.14 + pow(max(dot(r, normalize(vec3(0.1, 1., 0.2))), 0.), 30.) * 0.3 + pow(max(r.y, 0.), 14.) * 0.45;
  // the reef and floor below reflect a little
  // below: the lit reef and floor send back about as much light as the water around
  w = mix(w, waterRadiance(p.y, normalize(vec3(r.x, 0., r.z) + 1e-4)) * 1.15, smoothstep(0., -0.5, r.y));
  // the lamps are white; seen straight up through little water they stay whiter than the haze
  vec3 lamp = uLight * vec3(2.1, 0.85, 0.95) * exp(-KL * 0.45 * max(YS - p.y, 0.));
  return w + lamp * lobe * caustic(p);
}
void main() {
  float kind = vF.w;
  vec3 V;
  vec3 eye;
  if (uMirror > 0.5) {
    // seen via the surface: the ray comes down from the surface point above the fish's mirror image
    vec3 pm = vec3(vW.x, 2. * YS - vW.y, vW.z);
    vec3 d = normalize(pm - uCamPos);
    float ts = (YS - uCamPos.y) / max(d.y, 1e-3);
    eye = uCamPos + d * ts;
    V = normalize(eye - vW);
  } else {
    eye = uCamPos;
    V = normalize(uCamPos - vW);
  }
  vec3 n = normalize(vN);
  if (dot(n, V) < 0.) n = -n;
  float dist = length(vW - eye);
  vec3 col;
  float alpha = 1.;
  if (kind < 0.5) {
    float s = vF.x;
    float up = vF.y / max(length(vF.yz), 1e-4);
    float a = atan(vF.y, vF.z);
    float dors = smoothstep(uBackTo, uBackTo + 0.35, up), vent = smoothstep(0.2, 0.9, -up);
    // overlapping round scales, as on a real tarpon: rows offset by half a scale, each scale's
    // exposed rear part lies over the front of the next, so the flank shows a net of dark curved rims.
    // Laid out on the side view of the body (s along, local height across), in body lengths.
    float P = uScale * 1.9;                   // scale pitch along the body (about 33 along the lateral line)
    vec2 q = vec2(s, vL.y);
    float j0 = floor(q.y / (0.62 * P));
    float bestS = 1e9, edge = 1.;
    vec2 id = vec2(0.), df = vec2(0.);
    for (int dj = -1; dj <= 1; dj++) {
      float j = j0 + float(dj);
      float off = 0.5 * mod(j, 2.);
      float i0 = floor(q.x / P - off);
      for (int di = -1; di <= 1; di++) {
        float i = i0 + float(di);
        vec2 c = vec2((i + off + 0.5) * P, (j + 0.5) * 0.62 * P) + (hash22(vec2(i, j) + uSeed) - 0.5) * P * 0.12;
        vec2 dv = (q - c) / P;
        float d = length(dv * vec2(1., 0.95));
        // the most anterior covering scale is the visible one
        if (d < 0.66 && c.x < bestS) { bestS = c.x; edge = 0.66 - d; id = vec2(i, j); df = dv; }
      }
    }
    float h = hash12(id + uSeed);
    vec3 T = normalize(cross(n, vec3(0., 1., 0.)) + 1e-4);
    vec3 B = cross(n, T);
    // each scale is a slightly domed mirror with its own tilt, a little coherent with its neighbours
    vec2 tiltS = 0.1 * (vec2(h, hash12(id + 5.3)) - 0.5) + 0.22 * vec2(n3(vec3(s * 12., vL.y * 12., uSeed)), n3(vec3(s * 12., vL.y * 12., uSeed + 7.)));
    float far = smoothstep(4., 9., dist);
    tiltS *= 1. - 0.4 * far;
    float upperFlank = smoothstep(0.05, 0.45, up) * (1. - smoothstep(0.7, 0.9, up));
    float row = id.y;
    vec3 ns = normalize(n - B * (-0.3 + 0.9 * upperFlank + 1.3 * tiltS.y + 0.25 * df.y) * uTilt + T * (1.3 * tiltS.x + 0.25 * df.x) * uTilt);   // -B is up the flank
    // the head has no scales: smooth bony plates
    float head = smoothstep(uEye * 3.6, uEye * 2.8, s);
    ns = normalize(mix(ns, normalize(n + vec3(0., 0.1, 0.)), head));
    vec3 r = reflect(-V, ns);
    // the rim of each scale is darker (a thin pigmented margin), strongest on its rear arc
    float rim = smoothstep(0.07, 0.0, edge) * (0.5 + 0.5 * smoothstep(-0.2, 0.4, df.x)) * (0.6 + 0.4 * hash12(id + 2.2)) * (1. - 0.5 * far);
    float vEdge = rim;
    float mott = 0.85 + 0.3 * smoothstep(-0.5, 0.5, n3(vec3(s * 5., up * 2.5, uSeed + 11.)));
    float R = uSilver * mix(1., 0.12, dors) * mix(1., 0.85, vent) * (1. - uRim * rim * (1. - head)) * mott * (0.94 + 0.12 * h * (1. - head));
    vec3 base = mix(vec3(0.16, 0.2, 0.22), uBack, dors);
    // a darker lateral line and a faint stripe along the back
    base *= 1. - 0.12 * smoothstep(0.015, 0., abs(up - 0.12 - 0.25 * max(0.2 - s, 0.)));
    vec3 L = downLight(vW.y);
    vec3 amb = uScat / SIG * exp(-KD * max(YS - vW.y, 0.)) * (0.6 + 0.4 * n.y);
    // silver skin: guanine platelets are not one flat mirror; they also send the lamp light sideways,
    // so the flanks stay bright from any side, strongest on the upper flank
    vec3 sheen = L * uSheen * (0.5 + 0.5 * smoothstep(-0.6, 0.5, up)) * max(n.y + 0.8, 0.) / 1.8;
    col = base * (L * max(n.y, 0.) * mix(0.45, 0.15, dors) * caustic(vW) + amb * mix(1., 0.6, dors)) + R * (envLight(vW, r) + sheen);
    // short bright dashes: in the lit band, one scale in two flashes as a thin line
    // one glossy band runs along the upper flank; inside it the scale edges flash as short slanted strokes
    float band = smoothstep(0.16, 0.0, abs(up - 0.42 - 0.04 * n3(vec3(s * 4., 0., uSeed))));
    float stroke = vEdge * smoothstep(0.35, 0.65, hash12(id + 8.1) + 0.3 * n3(vec3(s * 25., row, uSeed + 5.)));
    vec3 lampR = envLight(vW, reflect(-V, normalize(n + vec3(0., 0.6, 0.)))) * uSilver;
    col += uDash * band * (1. - head) * lampR * (0.2 + 1.6 * stroke);
    col += uDash * 0.35 * (1. - band) * upperFlank * (1. - head) * lampR * stroke;
    // the upper flank is tinted blue-green under the silver
    col *= mix(vec3(1.), vec3(0.8, 0.95, 1.), smoothstep(0.05, 0.4, up));
    // eye
    float ez = abs(vF.z) > 0.3 ? 1. : 0.;
    // a round eye: measured on the body itself (local units, body length 1), not in (s, girth) which stretches it
    vec2 eo = vec2(vL.x + uEyePos.x, vL.y - uEyePos.y) / uEyePos.z;
    float ed = length(eo);
    // the eye is a glossy ball sitting in a bony socket: a lit rim round it, a dark lens that still shows
    // some depth (lighter low at the back, where light passes through it), and a sharp catch light on its
    // bulging front-top that comes from the lamps above
    if (ez > 0.5 && ed < 1.35 && ed >= 1.) {
      col = mix(col, col * 1.1, smoothstep(1.35, 1.1, ed) * smoothstep(-0.2, 0.6, eo.y));
      col *= 1. - 0.35 * smoothstep(1.2, 1., ed) * smoothstep(0.4, -0.4, eo.y);
    }
    if (ez > 0.5 && ed < 1.) {
      // sphere normal of the eyeball (eo: x toward the snout, y up, in eye radii)
      vec3 fwd = normalize(mat3(uFishMat) * vec3(1., 0., 0.)), upv = normalize(mat3(uFishMat) * vec3(0., 1., 0.));
      vec3 ne = normalize(n * sqrt(max(1. - ed * ed, 0.)) * 1.2 + fwd * eo.x * 0.8 + upv * eo.y * 0.8);
      vec3 re = reflect(-V, ne);
      // thin silver iris ring
      vec3 iris = (0.55 * envLight(vW, reflect(-V, normalize(n + vec3(0., 0.3, 0.)))) * uSilver + vec3(0.02, 0.02, 0.0)) * vec3(1.0, 0.96, 0.8);
      col = mix(col, iris, smoothstep(1., 0.88, ed));
      // dark lens with depth
      vec3 lens = vec3(0.01, 0.018, 0.026) + vec3(0.03, 0.07, 0.09) * smoothstep(0.1, 0.9, length(eo - vec2(0.15, 0.45))) * smoothstep(0.85, 0.3, ed);
      col = mix(col, lens, smoothstep(0.6, 0.5, ed));
      // reflections on the cornea: a soft sheen from the water and a sharp catch light from the lamps
      float spec = pow(max(dot(re, normalize(vec3(0.1, 1., 0.25))), 0.), 60.);
      col += (0.25 * envLight(vW, re) * 0.15 + uLight * vec3(0.5, 0.75, 0.8) * spec * 0.25) * smoothstep(1., 0.8, ed);
      col += vec3(0.35, 0.55, 0.6) * smoothstep(0.24, 0.05, length(eo - vec2(0.28, 0.38)));
    }
    // gill cover: a curved rear edge, bowed back in the middle; when the fish breathes it lifts and a dark gap opens
    float breathe = 0.5 + 0.5 * sin(6.2831853 * uT / 2.2 + uPhase);
    float se = uEye * 3.4 + 0.03 * (1. - up * up) + 0.006 * breathe;
    float dGill = s - se;
    float inHead = step(abs(up), 0.85);
    col *= 1. - (0.3 + 0.3 * breathe) * smoothstep(0.005, 0., abs(dGill)) * inHead;
    col *= 1. - 0.35 * breathe * smoothstep(0.014, 0., dGill) * step(0., dGill) * step(abs(up), 0.7);
    // the edge of the cheek plate in front of it
    col *= 1. - 0.2 * smoothstep(0.004, 0., abs(s - uEye * 2.3 - 0.015 * (1. - up * up))) * step(abs(up), 0.6);
    // mouth (side view, local units): the cleft runs from the snout tip back and down, ending under the eye;
    // above it the long upper jaw bone shows as a slightly lighter plate, below it the deep lower jaw
    {
      float L = uEye * 2.5, x = -vL.x / L;
      float tipY = uEyePos.y - 0.028, endY = uEyePos.y - 0.062;
      float my = mix(tipY, endY, pow(clamp(x, 0., 1.), 0.85)) - 0.002 * breathe * x;
      float dm = vL.y - my;
      float onJaw = step(x, 1.) * smoothstep(-0.02, 0.05, x) * ez;
      col *= 1. - 0.5 * onJaw * smoothstep(0.0035, 0.0005, abs(dm));
      col *= 1. + 0.12 * onJaw * smoothstep(0.0, 0.004, dm) * smoothstep(0.016, 0.006, dm);
    }
    col *= 1. - 0.12 * smoothstep(0.03, 0.0, s);
    float facing = abs(dot(normalize(vN), V));
    alpha = mix(smoothstep(0.0, 0.08 + 0.12 * smoothstep(5., 15., dist), facing), 1., smoothstep(0.8, 0.95, s)) * (1. - smoothstep(0.965, 1., s));
  } else {
    float u = vF.y, v = vF.z;
    // fin outlines as signed margins, so the edge can be anti-aliased (soft, like a thin membrane)
    float m, w;
    if (kind < 1.5) {
      // forked tail: two long narrow lobes; the fork reaches in to 1 - uFork of the length
      float vv = abs(v * 2. - 1.);
      float outer = 0.95 + 0.05 * u;
      float inner = u < 1. - uFork ? -1. : 0.93 * pow((u - (1. - uFork)) / uFork, 0.75);
      m = min(outer - vv, vv - inner);
      m = min(m, (1. - u) * 3.);
      w = fwidth(vv);
    } else if (kind < 2.5) {
      // dorsal (tarpon): a triangle with a concave rear edge, and its last ray drawn out into a long thin
      // filament trailing back (the grid rakes back with height, so a strip near the rear runs backward)
      float tri = min(min(0.85 - u * 0.5 - v, u * 3.), (1. - u) * 1.1 - v * 0.75 + 0.08 * sin(u * 3.1416));
      // the filament runs back almost level from the rear of the fin
      float fil = 0.03 * (1. - v) + 0.006 - abs(u - 0.93 - 0.1 * v);
      m = uDorsalFil > 0.5 ? max(tri, fil * 6.) : min(min(1. - u * 0.6 - v, u * 3.), (1. - u) * 1.6 - v * 0.8);
      w = fwidth(v) + fwidth(u);
    } else if (kind < 3.5) {
      // anal: a sickle, tall at the front
      m = min(pow(max(1. - u, 0.), 0.6) - v, 1. - 0.5 * v * v - u);
      w = fwidth(v) + fwidth(u);
    } else {
      m = min(1. - u * 0.7 - v, 1. - abs(v - 0.5) * 0.8 - u);
      w = fwidth(v) + fwidth(u);
    }
    // fin edges are thin and translucent: they fade over a few percent of the fin, not a hard cut
    float cover = smoothstep(-0.5 * w, 0.09 + 2.5 * w, m);
    if (cover < 0.01) discard;
    // fins: a membrane stretched over bony rays. Each ray is a ridge: it shades the membrane beside it and
    // its crest catches the lamps, so the fin reads as fine glossy streaks running out from the root
    float nRays = kind < 1.5 ? 38. : 18.;
    // caudal rays fan out from the root toward each lobe tip; on the other fins they run back along u
    float across = kind < 1.5 ? (v - 0.5) / (0.3 + 0.7 * u) * 0.5 + 0.5 : u;
    float rp = fract(across * nRays + 0.15 * n3(vec3(u * 3., v * 3., uSeed)));
    float ridge = rp - 0.5;
    float crest = 1. - smoothstep(0.06, 0.22, abs(ridge));
    // segment joints along each ray
    float joint = smoothstep(0.04, 0., abs(fract((kind < 1.5 ? u : v) * 9. + 3. * hash12(vec2(floor(across * nRays), uSeed))) - 0.5) - 0.44);
    vec3 fT = normalize(cross(n, vec3(0., 0., 1.)) + 1e-4);
    // rays twist a little along their length, so their glints come and go in dashes
    vec3 nf = normalize(n + fT * ridge * 0.9 + vec3(0., 0.5 * n3(vec3(across * nRays * 0.5, u * 7., uSeed + 4.)), 0.));
    float rays = 0.86 + 0.2 * crest - 0.08 * joint;
    vec3 L = downLight(vW.y);
    vec3 amb = uScat / SIG * exp(-KD * max(YS - vW.y, 0.));
    vec3 r = reflect(-V, nf);
    // the thick leading rays at the outer edge of each lobe are the glossiest
    float lead = kind < 1.5 ? smoothstep(0.75, 0.97, abs(v * 2. - 1.)) : 0.;
    float gloss = uSilver * mix(0.55, uFinSilver, kind < 1.5 ? 1. : 0.3) * (kind < 1.5 ? 0.55 + 0.45 * smoothstep(0., 0.5, u) * (1. - 0.6 * smoothstep(0.6, 1., u)) : 1. - 0.5 * u) * (0.08 + 0.7 * crest + 0.5 * lead) * (kind < 1.5 ? 0.55 : 1.);
    col = uFin * rays * (amb * 1.2 + L * 0.22 * (0.5 + 0.5 * abs(nf.y))) + envLight(vW, r) * gloss;
    // paired fins (pectoral, pelvic) and the anal fin are darker and yellowish, with little silver
    if (kind > 2.5 && kind < 3.5) {
      // anal fin: dark like the tail
      col = uFin * rays * (amb * 1.2 + L * 0.2) + envLight(vW, r) * uSilver * 0.25 * (0.3 + crest) * (1. - 0.5 * u);
    } else if (kind > 3.5) {
      col = uPaired * rays * (amb * 1.3 + L * 0.25 * (0.5 + 0.5 * abs(nf.y))) + envLight(vW, r) * uSilver * 0.18 * (0.4 + crest);
    }
    // darker trailing margins
    col *= 1. - 0.45 * smoothstep(0.55, 1., kind < 1.5 ? u : v);
    // the caudal fin's root is scaled and silver like the peduncle; it turns into translucent rays outward
    if (kind < 1.5) {
      float root = 1. - smoothstep(0.12, 0.4, u);
      vec3 nr = normalize(n * sign(dot(n, V)) + vec3(0., 0.35, 0.));
      vec3 rc = envLight(vW, reflect(-V, nr)) * uSilver + uBack * downLight(vW.y) * 0.3;
      float vu = v;   // 0 at the bottom of the fin, 1 at the top
      rc *= vec3(0.62, 0.85, 1.) * 0.5 * mix(0.3, 2.0, vu * vu * vu);
      // the scale lattice carries on onto the fin root
      vec2 sg = fract(vec2(vF.x / 0.016 + vu * 6., vF.x / 0.016 - vu * 6.) * 0.7071) - 0.5;
      rc *= 0.85 + 0.3 * hash12(floor(vec2(vF.x / 0.016 + vu * 6., vF.x / 0.016 - vu * 6.) * 0.7071) + uSeed);   // lit from above like the body: bright back, dark belly
      col = mix(col, rc, root);
      alpha = mix(uFinA, 1., root) * cover;
    } else alpha = uFinA * cover;
  }
  vec3 dir = normalize(vW - eye);
  vec3 T;
  vec3 I = inscatter(eye, dir, dist, T);
  gl_FragColor = vec4(col * T + I, alpha);
}
`;

// eye centre (distance back from the snout, height) and radius, in body lengths
function eyePos(sp) {
  const s = sp.eye * 1.25;
  const [hh, , yo] = interpProfile(sp.profile, s);
  return new THREE.Vector3(s, yo + hh * 0.34, sp.eye * 0.45);
}

export class Fish {
  constructor(species, len, seed, uniforms, mirrorVP) {
    const sp = SPECIES[species];
    this.sp = sp;
    this.len = len;
    this.group = new THREE.Group();
    this.mirrorGroup = new THREE.Group();
    this.u = {
      uT: uniforms.uT, uNoise: uniforms.uNoise, uScat: uniforms.uScat, uLight: uniforms.uLight, uCamPos: uniforms.uCamPos,
      uLen: { value: len }, uPhase: { value: seed * 6.283 }, uCycle: { value: 0 }, uAmp: { value: 0.05 }, uBend: { value: 0 }, uWaveK: { value: 0.9 },
      uFishMat: { value: new THREE.Matrix4() }, uYS: { value: 2.52 }, uSeed: { value: seed * 100 },
      uBack: { value: new THREE.Vector3(...sp.back) }, uFin: { value: new THREE.Vector3(...sp.fin) },
      uSilver: { value: sp.silver }, uScale: { value: sp.scale }, uFinA: { value: sp.finA }, uEye: { value: sp.eye }, uEyeV: { value: sp.eye }, uEyePos: { value: eyePos(sp) }, uPaired: { value: new THREE.Vector3(...(sp.paired || sp.fin)) }, uDash: { value: sp.dash || 0 }, uDorsalFil: { value: sp.dorsal[3] }, uFork: { value: sp.caudal.fork }, uRim: { value: sp.rim }, uTilt: { value: sp.tilt }, uBackTo: { value: sp.backTo }, uSheen: { value: sp.sheen }, uFinSilver: { value: sp.finSilver },
    };
    const mk = (geo, mirror, fin) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: fishVert, fragmentShader: fishFrag,
        uniforms: { ...this.u, uMirror: { value: mirror ? 1 : 0 }, uViewProjX: mirror ? mirrorVP : uniforms.uViewProj },
        side: THREE.DoubleSide, transparent: true, depthWrite: !fin,
      });
      if (mirror) {
        m.blending = THREE.CustomBlending;
        m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
        m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      }
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = fin ? 1 : 2;   // fins first: the body fades into the tail root over them
      return mesh;
    };
    // caudal and dorsal fins are drawn before the body (the body fades into the tail root over them);
    // the paired fins and the anal fin hang in front of the flank and are drawn after it
    const body = bodyGeometry(sp), fins = finGeometry(sp, (k) => k <= 2), fins2 = finGeometry(sp, (k) => k > 2);
    this.group.add(mk(body, false, false), mk(fins, false, true), mk(fins2, false, true));
    this.mirrorGroup.add(mk(body, true, false), mk(fins, true, true), mk(fins2, true, true));
  }
  // position of the snout, heading (yaw about y, 0 = +x), pitch, roll
  set(pos, yaw, pitch, roll, cycle, amp, bend) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(roll, yaw, pitch, 'YZX'));
    m.setPosition(pos[0], pos[1], pos[2]);
    this.u.uFishMat.value.copy(m);
    this.u.uCycle.value = cycle;
    this.u.uAmp.value = amp;
    this.u.uBend.value = bend;
  }
}

// ---- choreography ----
// Tracks: [time, x, y, z] of the snout. Heading comes from the motion unless given.
function catmull(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] < t) i++;
  const k0 = keys[Math.max(i - 1, 0)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(i + 2, keys.length - 1)];
  const u = Math.min(Math.max((t - k1[0]) / (k2[0] - k1[0]), 0), 1);
  const out = [];
  for (let c = 1; c < k1.length; c++) {
    const p0 = k0[c], p1 = k1[c], p2 = k2[c], p3 = k3[c];
    out.push(0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u));
  }
  return out;
}

export function makeSchool(uniforms, mirrorVP, R) {
  const fish = [];
  const add = (species, len, keys, opt = {}) => {
    const f = new Fish(species, len, R(), uniforms, mirrorVP);
    f.keys = keys;
    f.opt = { freq: 1, amp: 0.05, ...opt };
    fish.push(f);
    return f;
  };
  // Tracks are given as the snout's place on the 1920x1080 frame
  // at a chosen distance d, turned back into a 3D point. [t, x px, y px, d m]
  const FPX = 540 / Math.tan((32.65 / 2) * Math.PI / 180);
  const S = (keys) => keys.map(([t, x, y, d]) => [t, (x - 960) / FPX * d, (540 - y) / FPX * d, -d]);
  // tarpon A, close on the right: only its back half is in frame; it drifts right and its tail leaves at 8.3 s
  // (keys are the tail tip + 706 px: body 598 px and caudal lobe 108 px at 5.1 m)
  add('tarpon', 1.95, S([[-2, 2115, 472, 5.1], [0, 2208, 463, 5.1], [1.2, 2272, 448, 5.1], [2.4, 2304, 433, 5.1], [3.6, 2334, 423, 5.1], [4.8, 2377, 420, 5.1], [6, 2381, 417, 5.1], [8.0, 2382, 416, 5.1], [8.4, 2387, 417, 5.1], [9.0, 2575, 419, 5.1], [10, 2975, 422, 5.1]]), { freq: 0.55, amp: 0.11, pitch: -0.05, yaw: 0.45, noPitch: true });
  // tarpon B, far: in front of the right wall, swimming right and away into the back
  add('tarpon', 0.94, S([[-2, 1395, 344, 12.41], [0, 1430, 342, 12.75], [4, 1499, 339, 13.01], [8.4, 1538, 331, 13.52], [12, 1572, 323, 14.28],
    [16.8, 1583, 313, 15.47], [20, 1585, 310, 16.32]]), { freq: 0.55, amp: 0.08 });
  // tarpon C: its head comes in at the right edge at 8.8 s, it hangs there, then glides left from 11.6 s
  add('tarpon', 1.55, S([[-2, 3000, 318, 7.4], [7.5, 2150, 318, 7.4], [8.8, 1720, 318, 7.4], [10, 1712, 316, 7.4], [11.6, 1705, 314, 7.4], [12.8, 1665, 313, 7.4],
    [14, 1619, 313, 7.4], [15.2, 1575, 313, 7.4], [16, 1556, 313, 7.4], [17, 1522, 314, 7.4], [18, 1499, 314, 7.4], [20, 1450, 316, 7.4]]),
    { freq: 0.55, amp: 0.085, noPitch: true, pitch: -0.03, yaw: Math.PI });
  // jacks in front of the right window, heading out right and down (0 - 5 s)
  const jk = (len, keys, opt = {}) => add('jack', len, S(keys), { freq: 1.7 + 0.5 * R(), amp: 0.06, ...opt });
  jk(0.62, [[-1, 1640, 452, 8.6], [0.3, 1702, 457, 8.6], [1.1, 1772, 463, 8.6], [1.9, 1848, 472, 8.6], [3.1, 1990, 488, 8.6], [5, 2200, 500, 8.6]]);
  jk(0.6, [[-1, 1520, 530, 11], [0, 1569, 535, 11], [0.8, 1630, 544, 11], [1.6, 1753, 598, 11], [2.4, 1884, 638, 11], [3.2, 1990, 668, 11], [5, 2150, 700, 11]]);
  jk(0.6, [[-1, 1540, 576, 11.5], [1, 1572, 580, 11.5], [1.8, 1638, 599, 11.5], [2.6, 1696, 631, 11.5], [3.4, 1764, 671, 11.5], [4.2, 1875, 709, 11.5], [5, 1990, 734, 11.5], [7, 2200, 760, 11.5]]);
  jk(0.6, [[-1, 1660, 565, 12], [1.9, 1704, 574, 12], [2.7, 1747, 588, 12], [3.5, 1820, 620, 12], [4.3, 1910, 651, 12], [5.5, 2050, 680, 12]]);
  jk(0.65, [[-1, 1750, 640, 8.4], [0.8, 1900, 655, 8.4], [1.6, 2000, 660, 8.4], [3, 2200, 670, 8.4]]);
  // the upper group by the window frame (read off the 0 - 1 s frames)
  jk(0.6, [[-1, 1590, 350, 11.5], [0, 1615, 352, 11.5], [1, 1700, 356, 11.5], [2.5, 1850, 362, 11.5], [4, 2000, 370, 11.5]]);
  jk(0.6, [[-1, 1680, 356, 11.8], [0, 1702, 358, 11.8], [1, 1775, 360, 11.8], [2.5, 1920, 368, 11.8], [4, 2050, 372, 11.8]]);
  jk(0.6, [[-1, 1760, 345, 12], [0, 1785, 347, 12], [1, 1850, 350, 12], [2.5, 1990, 356, 12], [4, 2100, 360, 12]]);
  jk(0.62, [[-1, 1650, 470, 10.2], [0, 1675, 474, 10.2], [1.2, 1760, 486, 10.2], [2.6, 1900, 500, 10.2], [4, 2050, 510, 10.2]]);
  // jack G: hangs beside the right window frame from 8 s while tarpon C comes in
  jk(0.6, [[6, 1580, 380, 9.6], [8, 1690, 374, 9.6], [9.5, 1735, 372, 9.6], [11, 1740, 370, 9.6], [12.5, 1760, 372, 9.6], [14, 1830, 378, 9.6], [16, 1990, 390, 9.6], [18, 2150, 400, 9.6]], { freq: 1.2, yaw: 0 });
  // two jacks high on the left swimming out to the left (0 - 1.6 s)
  jk(0.58, [[-1, 560, 270, 9.3], [0, 360, 234, 9.3], [0.4, 276, 219, 9.3], [0.8, 188, 203, 9.3], [1.2, 102, 187, 9.3], [1.6, 10, 165, 9.3], [3, -300, 120, 9.3]], { freq: 2.4, amp: 0.07 });
  jk(0.55, [[-1, 290, 205, 11], [0, 128, 183, 11], [0.4, 60, 171, 11], [0.8, 0, 162, 11], [2, -200, 140, 11]], { freq: 2.4, amp: 0.07 });
  // jack D: comes in from the left at 7.6 s and swims right and away toward the back of the tank
  jk(0.6, [[6.5, -150, 450, 7.6], [7.6, 40, 432, 7.8], [8.4, 172, 420, 8.0], [9.2, 300, 405, 8.4], [10, 427, 395, 9.0], [10.8, 541, 385, 9.6],
    [11.6, 636, 375, 10.3], [12.4, 723, 368, 11.0], [13.2, 798, 364, 11.8], [14, 860, 360, 12.6], [14.8, 915, 357, 13.4], [15.6, 960, 355, 14.2],
    [16.4, 998, 354, 14.9], [17.2, 1030, 353, 15.5], [18, 1050, 352, 16], [20, 1090, 350, 16.6]], { freq: 1.5, amp: 0.05 });
  // small reef fish flitting near the rocks
  const small = [[-2.4, -0.4, -6.8], [-2.9, -0.6, -6.9], [-2.0, -1.3, -6.6], [1.15, -1.1, -9.0], [-0.6, -0.9, -11.8], [0.3, -1.4, -11.5]];
  small.forEach(([x, y, z]) => {
    const keys = [];
    for (let t = -2; t <= 21; t += 1.5 + R()) keys.push([t, x + (R() - 0.5) * 0.5, y + (R() - 0.5) * 0.25, z + (R() - 0.5) * 0.3]);
    add('reef', 0.09 + 0.05 * R(), keys, { freq: 3.5, amp: 0.08 });
  });
  return fish;
}

function motion(f, t) {
  const p = catmull(f.keys, t), q = catmull(f.keys, t + 0.25), q0 = catmull(f.keys, t - 0.25);
  const speed = Math.hypot(q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]) / 0.5;
  return { p, q, q0, speed, freq: f.opt.freq * (0.6 + 0.8 * Math.min(speed / (f.len * 0.6), 1.5)) };
}
function sortSchool(fish) {
  const d = fish.map((f) => { const e = f.u.uFishMat.value.elements; return Math.hypot(e[12], e[13], e[14]); });
  const idx = fish.map((_, i) => i).sort((a, b) => d[b] - d[a]);
  idx.forEach((i, k) => {
    const [body, fins, fins2] = fish[i].group.children;
    fins.renderOrder = 10 + 3 * k;
    body.renderOrder = 11 + 3 * k;
    fins2.renderOrder = 12 + 3 * k;
  });
}
export function updateSchool(fish, t) {
  for (const f of fish) {
    // tail beat phase: integrate the beat frequency from a fixed start, so any frame can be drawn on its own
    let cycle = 0;
    const DT = 0.05;
    for (let x = -3; x < t; x += DT) cycle += motion(f, Math.min(x + DT * 0.5, t)).freq * Math.min(DT, t - x);
    const p = catmull(f.keys, t);
    const q = catmull(f.keys, t + 0.25);
    const q0 = catmull(f.keys, t - 0.25);
    const vx = q[0] - p[0], vz = q[2] - p[2];
    const speed = Math.hypot(q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]) / 0.5;
    // heading from the motion; three.js yaw: rotation about y, local +x forward
    // fish that hover keep the heading they are given (a heading taken from a near-zero motion flips)
    const yaw = f.opt.yaw !== undefined ? f.opt.yaw : Math.atan2(-vz, vx);
    const yaw0 = f.opt.yaw !== undefined ? f.opt.yaw : Math.atan2(-(p[2] - q0[2]), p[0] - q0[0]);
    let dy = yaw - yaw0;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    const pitch = (f.opt.pitch || 0) + (f.opt.noPitch ? 0 : Math.atan2(q[1] - p[1], Math.hypot(vx, vz) + 1e-4) * 0.7);
    // bend into turns
    f.set(p, yaw, pitch, 0, cycle, f.opt.amp * (0.7 + 0.3 * Math.min(speed / (f.len * 0.5), 1.5)), -dy * 1.5);
  }
  sortSchool(fish);
}
