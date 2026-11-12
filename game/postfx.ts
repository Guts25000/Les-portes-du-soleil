/**
 * Ciel physique (diffusion atmosphérique), éclairage d'environnement (IBL) et post-traitement :
 * bloom, anticrénelage MSAA, étalonnage des couleurs et vignettage.
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { QualitySettings } from './quality';

function configureSky(sky: Sky, sunDir: THREE.Vector3) {
  const u = sky.material.uniforms;
  u.turbidity.value = 2.2;
  u.rayleigh.value = 1.1;
  u.mieCoefficient.value = 0.0035;
  u.mieDirectionalG.value = 0.86;
  u.sunPosition.value.copy(sunDir);
}

/** Ajoute le ciel à la scène et calcule l'environnement lumineux à partir de lui. */
export function setupSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): Sky {
  const sky = new Sky();
  sky.scale.setScalar(10000);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  configureSky(sky, sunDir);
  scene.add(sky);

  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(10000);
  configureSky(envSky, sunDir);
  envScene.add(envSky);
  // sol neigeux diffus dans l'environnement (évite un bas d'horizon noir)
  const ground = new THREE.Mesh(new THREE.CircleGeometry(5000, 32), new THREE.MeshBasicMaterial({ color: 0x8a9db0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -20;
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.02);
  scene.environment = rt.texture;
  pmrem.dispose();
  return sky;
}

const GradingShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    saturation: { value: 1.12 },
    contrast: { value: 1.06 },
    vignette: { value: 0.32 },
    tint: { value: new THREE.Vector3(1.0, 1.0, 1.02) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float contrast;
    uniform float vignette;
    uniform vec3 tint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 col = mix(vec3(l), c.rgb, saturation);
      col = (col - 0.18) * contrast + 0.18;
      col *= tint;
      vec2 d = vUv - 0.5;
      col *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }`,
};

export interface PostFX {
  render: () => void;
  setSize: (w: number, h: number) => void;
  setSpeed: (kmh: number) => void;
  dispose: () => void;
}

export function setupPostFX(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, q: QualitySettings): PostFX {
  if (!q.postfx) {
    return {
      render: () => renderer.render(scene, camera),
      setSize: (w, h) => renderer.setSize(w, h),
      setSpeed: () => {},
      dispose: () => {},
    };
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.msaa });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  let bloom: UnrealBloomPass | null = null;
  if (q.bloom) {
    // seuil élevé : seuls le soleil, les reflets et les paillettes de neige brillent
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 1.45);
    composer.addPass(bloom);
  }
  const grading = new ShaderPass(GradingShader);
  composer.addPass(grading);
  composer.addPass(new OutputPass());
  return {
    render: () => composer.render(),
    setSize: (w, h) => {
      renderer.setSize(w, h);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    setSpeed: (kmh) => {
      // vignettage plus marqué à grande vitesse
      grading.uniforms.vignette.value = 0.32 + Math.min(0.35, Math.max(0, (kmh - 50) / 150));
    },
    dispose: () => {
      composer.dispose();
      target.dispose();
    },
  };
}
