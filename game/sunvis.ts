/**
 * Ombres pré-calculées appliquées aux objets (chalets, remontées, panneaux, skieurs) :
 * le shader de chaque matériau lit l'ensoleillement du sol sous lui, si bien qu'un skieur
 * qui entre dans l'ombre d'une crête ou d'une forêt s'assombrit comme le terrain.
 */
import * as THREE from 'three';
import type { World } from './world';

export interface SunVis {
  texture: THREE.DataTexture;
  rect: THREE.Vector4;
  patch: (m: THREE.Material) => void;
  patchScene: (root: THREE.Object3D) => void;
}

export function createSunVis(world: World): SunVis {
  const tex = new THREE.DataTexture(world.sunVis as Uint8Array<ArrayBuffer>, world.sunW, world.sunH, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  const rect = new THREE.Vector4(-world.meta.halfW, -world.meta.halfD, 2 * world.meta.halfW, 2 * world.meta.halfD);
  const done = new WeakSet<THREE.Material>();
  const patch = (m: THREE.Material) => {
    if (done.has(m) || m.userData.noSunVis) return;
    if (!(m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshPhongMaterial)) return;
    if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return; // déjà personnalisé (sol, sapins)
    done.add(m);
    m.onBeforeCompile = (sh) => {
      sh.uniforms.tSunVis = { value: tex };
      sh.uniforms.uSunRect = { value: rect };
      sh.vertexShader =
        'varying vec3 vSunW;\n' +
        sh.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
#ifdef USE_INSTANCING
  vSunW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vSunW = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
        );
      sh.fragmentShader =
        'varying vec3 vSunW;\nuniform sampler2D tSunVis;\nuniform vec4 uSunRect;\n' +
        sh.fragmentShader.replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
{
  float sv = texture2D(tSunVis, (vSunW.xz - uSunRect.xy) / uSunRect.zw).r;
  reflectedLight.directDiffuse *= sv;
  reflectedLight.directSpecular *= sv;
}`,
        );
    };
    m.customProgramCacheKey = () => 'pds-sunvis-' + m.type;
    m.needsUpdate = true;
  };
  return {
    texture: tex,
    rect,
    patch,
    patchScene: (root) =>
      root.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        if (!mm) return;
        if (Array.isArray(mm)) mm.forEach(patch);
        else patch(mm);
      }),
  };
}
