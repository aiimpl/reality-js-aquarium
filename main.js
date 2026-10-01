import * as THREE from 'three';
import { quadVert, bakeFrag, compFrag, postFrag } from './world.js';
import { makeNoiseData, noiseTexture, buildReef, GRID_MIN, GRID_N, GRID_CELL, rng } from './reef.js';
import { makeSchool, updateSchool } from './fish.js';
import { makeParticles } from './particles.js';

// ---- settings ----
const params = new URLSearchParams(location.search);
const OFFLINE = params.has('render');            // export mode (high quality, time is passed in from outside)
const W = OFFLINE ? 1920 : Math.min(innerWidth * devicePixelRatio, 1920);
const H = OFFLINE ? 1080 : Math.round(W * 9 / 16);
const SS = OFFLINE ? Number(params.get('ss') || 2) : 1;   // render at SS x and downsample
const SUB = OFFLINE ? Number(params.get('sub') || 2) : 1; // sub-frames averaged per frame
const NJ = OFFLINE ? Number(params.get('nj') || 4) : 1;   // jittered samples per pixel in the bake
const SHUTTER = 1 / 60;
const VFOV = 32.65;                               // phone main camera behind a flat acrylic panel
const MARGIN = 1.04;                              // the bake covers a little more than the frame
const LOOP = 18.27;

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(VFOV, W / H, 0.05, 200);
camera.rotation.order = 'YXZ';
const bakeCam = new THREE.PerspectiveCamera(2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(VFOV / 2)) * MARGIN)), W / H, 0.05, 200);
bakeCam.updateMatrixWorld();
const bakeViewProj = new THREE.Matrix4().multiplyMatrices(bakeCam.projectionMatrix, bakeCam.matrixWorldInverse);

const noiseData = makeNoiseData();
const tr0 = performance.now();
const reefData = buildReef(noiseData);
window.reefInfo = { ...reefData, primTex: undefined, idxTex: undefined, cellTex: undefined, seconds: (performance.now() - tr0) / 1000 };
console.log('reef', JSON.stringify(window.reefInfo));
const shared = {
  uNoise: { value: noiseTexture(noiseData) },
  uScat: { value: new THREE.Vector3(0.0085, 0.0143, 0.0372) },
  uLight: { value: new THREE.Vector3(6.6, 9.2, 9.0) },
};

const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadScene = new THREE.Scene();
const quad = new THREE.Mesh(quadGeo);
quad.frustumCulled = false;
quadScene.add(quad);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ---- bake: the static tank, seen directly and in the mirror of the surface ----
const BW = Math.round(W * SS * MARGIN), BH = Math.round(H * SS * MARGIN);
const mkBakeRT = () => {
  const rt = new THREE.WebGLMultipleRenderTargets(BW, BH, 3, { type: THREE.FloatType, depthBuffer: false });
  for (const t of rt.texture) { t.minFilter = t.magFilter = THREE.LinearFilter; }
  return rt;
};
const bakeMain = mkBakeRT(), bakeMirror = mkBakeRT();
const bakeMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: quadVert, fragmentShader: bakeFrag,
  uniforms: {
    ...shared,
    uPrim: { value: reefData.primTex }, uIdx: { value: reefData.idxTex }, uCell: { value: reefData.cellTex },
    uGridMin: { value: new THREE.Vector3(...GRID_MIN) }, uGridN: { value: new Int32Array(GRID_N) }, uGridCell: { value: GRID_CELL },
    uCamPos: { value: bakeCam.position }, uCamWorld: { value: bakeCam.matrixWorld }, uProjInv: { value: bakeCam.projectionMatrixInverse },
    uJit: { value: new THREE.Vector2() }, uMirror: { value: 0 }, uSeed: { value: 0 }, uW: { value: 1 / NJ },
  },
  depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
});

async function bake(onProgress) {
  const TILE = Number(params.get('tile') || 96);
  const tiles = [];
  for (let y = 0; y < BH; y += TILE) for (let x = 0; x < BW; x += TILE) tiles.push([x, y]);
  const views = [[bakeMain, 0], [bakeMirror, 1]];
  const total = views.length * NJ * tiles.length;
  let done = 0;
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  quad.material = bakeMat;
  for (const [rt, mirror] of views) {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    for (let j = 0; j < NJ; j++) {
      // stratified jitter inside the pixel
      const jx = NJ > 1 ? ((j % 2) + 0.25 + 0.5 * Math.random()) / 2 - 0.5 : 0;
      const jy = NJ > 1 ? ((Math.floor(j / 2) % 2) + 0.25 + 0.5 * Math.random()) / 2 - 0.5 : 0;
      bakeMat.uniforms.uJit.value.set(jx / BW, jy / BH);
      bakeMat.uniforms.uMirror.value = mirror;
      bakeMat.uniforms.uSeed.value = j * 17.31 + mirror * 5.1;
      for (const [x, y] of tiles) {
        rt.scissor.set(x, y, Math.min(TILE, BW - x), Math.min(TILE, BH - y));
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(quadScene, ortho);
        // wait for the tile (keeps each GPU submission short)
        renderer.setRenderTarget(null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        done++;
        if (done % 8 === 0) { onProgress?.(done / total); await new Promise((r) => setTimeout(r, 0)); }
      }
    }
    rt.scissorTest = false;
  }
}

// ---- per frame ----
const compUniforms = {
  ...shared,
  uS0: { value: bakeMain.texture[0] }, uS1: { value: bakeMain.texture[1] }, uP: { value: bakeMain.texture[2] },
  uM0: { value: bakeMirror.texture[0] }, uM1: { value: bakeMirror.texture[1] }, uMP: { value: bakeMirror.texture[2] },
  uT: { value: 0 },
  uCamPos: { value: camera.position }, uCamWorld: { value: camera.matrixWorld }, uProjInv: { value: camera.projectionMatrixInverse },
  uViewProj: { value: new THREE.Matrix4() }, uBakeViewProj: { value: bakeViewProj },
  uWave: { value: 0.45 },
  uBlurPx: { value: SS * H / 1080 }, uBakeTexel: { value: new THREE.Vector2(1 / BW, 1 / BH) },
};
const compMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: quadVert, fragmentShader: compFrag, uniforms: compUniforms,
  depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth,
});
const compScene = new THREE.Scene();
const compQuad = new THREE.Mesh(quadGeo, compMat);
compQuad.frustumCulled = false;
compScene.add(compQuad);

const scene = new THREE.Scene();   // fish and particles, drawn over the tank
const mirrorScene = new THREE.Scene();   // the same fish seen in the mirror of the surface
const rtFishMirror = new THREE.WebGLRenderTarget(BW, BH, { type: THREE.HalfFloatType, depthBuffer: true });
compUniforms.uFM = { value: rtFishMirror.texture };
const school = makeSchool({ ...shared, uT: compUniforms.uT, uCamPos: compUniforms.uCamPos, uViewProj: compUniforms.uViewProj }, { value: bakeViewProj }, rng(7));
for (const f of school) { scene.add(f.group); mirrorScene.add(f.mirrorGroup); }
scene.add(makeParticles({ ...shared, uT: compUniforms.uT, uCamPos: compUniforms.uCamPos, uViewProj: compUniforms.uViewProj }, rng(11), H * SS));
// ?fishtest=i[,yaw]: park fish i in front of the camera to look at it closely
if (params.has('fishtest')) {
  const [fi, yw] = params.get('fishtest').split(',').map(Number);
  school.forEach((f, i) => { if (i !== fi) f.keys = [[-5, 0, -50, 0], [30, 0, -50, 0.01]]; });
  const f = school[fi];
  const d = 1.4 * f.len + 0.6, a = yw || 0;
  const cx = Math.cos(a) * f.len * 0.5, cz = -Math.sin(a) * f.len * 0.5;
  f.keys = [[-5, cx - Math.cos(a) * 0.02 * 5, 0.2, -d + cz + Math.sin(a) * 0.02 * 5], [30, cx + Math.cos(a) * 0.02 * 30, 0.2, -d + cz - Math.sin(a) * 0.02 * 30]];
}

const rtScene = new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.HalfFloatType, depthBuffer: true });
const rtAcc = new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.FloatType, depthBuffer: false });
const accMat = new THREE.ShaderMaterial({
  vertexShader: quadVert,
  fragmentShader: 'uniform sampler2D uTex; uniform float uW; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(uTex, vUv).rgb * uW, 1.); }',
  uniforms: { uTex: { value: rtScene.texture }, uW: { value: 1 / SUB } },
  blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
});
const postMat = new THREE.ShaderMaterial({
  vertexShader: quadVert, fragmentShader: postFrag,
  uniforms: { uTex: { value: rtAcc.texture }, uTexel: { value: new THREE.Vector2(1 / (W * SS), 1 / (H * SS)) }, uExposure: { value: 1 }, uT: compUniforms.uT },
  depthTest: false, depthWrite: false,
});

// the camera sits still; over the clip the view sinks by ~5 px (a slow tilt up) with a faint tremor
function setCamera(t) {
  camera.position.set(0, 0, 0);
  camera.rotation.x = 0.00275 * (t / LOOP) + 0.00004 * Math.sin(t * 5.1) + 0.00003 * Math.sin(t * 8.7 + 1.);
  camera.rotation.y = -0.0001 * Math.sin(t * 0.7) + 0.00003 * Math.sin(t * 6.3 + 2.);
  camera.rotation.z = 0;
  camera.updateMatrixWorld();
  compUniforms.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

function renderAt(t) {
  renderer.setRenderTarget(rtAcc);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  for (let s = 0; s < SUB; s++) {
    const ts = t + (SUB > 1 ? (s / (SUB - 1) - 0.5) * SHUTTER : 0);
    compUniforms.uT.value = ts;
    setCamera(ts);
    updateSchool(school, ts);
    renderer.setRenderTarget(rtFishMirror);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(mirrorScene, camera);
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(rtScene);
    renderer.clear();
    renderer.render(compScene, camera);
    renderer.render(scene, camera);
    renderer.setRenderTarget(rtAcc);
    quad.material = accMat;
    renderer.render(quadScene, ortho);
  }
  compUniforms.uT.value = t;
  renderer.setRenderTarget(null);
  quad.material = postMat;
  renderer.render(quadScene, ortho);
}

window.renderAt = (t) => {
  renderAt(t);
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait until rendering finishes
  return true;
};
window.shared = shared;
window.compUniforms = compUniforms;

const bar = document.getElementById('progress');
const t0b = performance.now();
await bake((f) => { if (bar) bar.textContent = `baking the tank ${Math.round(f * 100)}%`; });
window.bakeSeconds = (performance.now() - t0b) / 1000;
if (bar) bar.remove();
window.ready = true;

if (!OFFLINE) {
  const t0 = performance.now();
  const start = Number(params.get('t') || 0);
  const loop = () => {
    renderAt((start + (performance.now() - t0) / 1000) % LOOP);
    requestAnimationFrame(loop);
  };
  loop();
}
