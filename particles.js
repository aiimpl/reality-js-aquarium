// Suspended particles: small specks drifting in the water, and a few blurred discs right in front of the lens.
import * as THREE from 'three';
import { water } from './world.js';

const vert = /* glsl */ `
precision highp float;
attribute vec4 aSeed;
uniform float uT, uPx;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
varying vec3 vW;
varying float vA, vBig;
void main() {
  // slow wandering and a slight sink
  vec3 p = position;
  float t = uT + aSeed.x * 50.;
  p += vec3(sin(t * 0.21 + aSeed.y * 6.) * 0.05, -0.012 * uT + sin(t * 0.17 + aSeed.z * 6.) * 0.03, cos(t * 0.19 + aSeed.w * 6.) * 0.05);
  vW = p;
  vec4 c = uViewProj * vec4(p, 1.);
  gl_Position = c;
  float d = length(p - uCamPos);
  // size in pixels: a speck is ~2 mm; close ones are out of focus and spread into a disc
  float focus = 6.;
  float blur = abs(1. / d - 1. / focus) * 55.;
  float sz = aSeed.w * 0.004 * uPx / d;
  gl_PointSize = max(sz, 1.2) + blur * uPx / 1080.;
  vBig = blur * uPx / 1080.;
  vA = min(1., 2.2 / max(gl_PointSize * gl_PointSize * 0.25, 1.));
}
`;
const frag = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;
varying vec3 vW;
varying float vA, vBig;
${water}
void main() {
  vec2 q = gl_PointCoord * 2. - 1.;
  float r = length(q);
  // specks are soft dots; blurred discs have a flat body and a slightly brighter rim
  float m = vBig > 6. ? smoothstep(1., 0.85, r) * (0.8 + 0.2 * smoothstep(0.6, 0.95, r)) : exp(-r * r * 3.);
  if (m < 0.01) discard;
  vec3 dir = vW - uCamPos;
  float d = length(dir);
  // a speck shows the light scattered around it in the water (bluish), plus a touch of lamp light
  vec3 c = uScat / SIG * exp(-KD * max(YS - vW.y, 0.)) * 2.2 + downLight(vW.y) * vec3(0.004, 0.012, 0.014);
  vec3 T;
  vec3 I = inscatter(uCamPos, dir / d, d, T);
  vec3 col = c * T;
  gl_FragColor = vec4(col, m * vA * (vBig > 6. ? 0.35 : 0.9));
}
`;

export function makeParticles(uniforms, R, heightPx) {
  const N = 1400;
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    // spread through the view frustum, denser near the camera
    const z = -(0.35 + Math.pow(R(), 1.6) * 16);
    const x = (R() * 2 - 1) * (-z) * 0.58, y = (R() * 2 - 1) * (-z) * 0.32 + 0.1;
    pos.set([x, Math.min(y, 2.4), z], i * 3);
    seed.set([R(), R(), R(), 0.4 + 1.6 * R() * R()], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const m = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag,
    uniforms: { ...uniforms, uPx: { value: heightPx } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 1000;   // after the fish (it does not write depth)
  return pts;
}
