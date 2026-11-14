/**
 * Sol du secteur : carreaux de 640 m avec niveaux de détail (pas de 5 à 80 m selon la distance),
 * jupes anti-fissures, textures pré-calculées (couleur, ombres, occlusion) et détails procéduraux
 * de près (grain de la neige, stries de damage dans le sens de la pente, paillettes au soleil).
 */
import * as THREE from 'three';
import type { Grid, World } from './world';

const C = 128; // mailles par carreau

export interface TerrainUniforms {
  treeRange: { value: number };
}

function bitmapTexture(img: ImageBitmap, srgb: boolean, aniso: number): THREE.Texture {
  const t = new THREE.Texture(img as unknown as HTMLImageElement);
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Bruit périodique 256² : R,G relief fin ; B grain ; A paillettes. */
export function noiseTexture(): THREE.DataTexture {
  const S = 256;
  const d = new Uint8Array(S * S * 4);
  const lat = (f: number, seed: number) => {
    const g = new Float32Array(f * f);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return (x: number, y: number) => {
      const X = (x / S) * f, Y = (y / S) * f;
      const i = Math.floor(X), j = Math.floor(Y), fx = X - i, fy = Y - j;
      const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number) => g[(((b % f) + f) % f) * f + (((a % f) + f) % f)];
      return at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
    };
  };
  const n8 = lat(8, 1), n16 = lat(16, 2), n32 = lat(32, 3), n64 = lat(64, 4), m8 = lat(8, 5), m16 = lat(16, 6), m32 = lat(32, 7);
  let s = 99;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      d[i] = (n8(x, y) * 0.5 + n16(x, y) * 0.3 + n32(x, y) * 0.2) * 255;
      d[i + 1] = (m8(x, y) * 0.5 + m16(x, y) * 0.3 + m32(x, y) * 0.2) * 255;
      d[i + 2] = (n64(x, y) * 0.6 + n32(x, y) * 0.4) * 255;
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i + 3] = s >>> 24;
    }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const FRAG_HEAD = /* glsl */ `
varying vec3 vW;
uniform sampler2D tAlb;
uniform sampler2D tLight;
uniform sampler2D tNoise;
uniform vec4 uRect;
uniform float uTreeRange;
#ifndef FAR
uniform sampler2D tAux;
uniform sampler2D tDir;
uniform vec4 uAux;
#endif
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const FRAG_MAP = /* glsl */ `
vec2 uvT = (vW.xz - uRect.xy) / uRect.zw;
vec3 alb = texture2D(tAlb, uvT).rgb;
float dist = length(vW - cameraPosition);
vec4 nzA = texture2D(tNoise, vW.xz / 37.0);
vec4 nzB = texture2D(tNoise, vW.xz / 4.3);
vec4 nzC = texture2D(tNoise, vW.xz / 0.61);
float seamDark = 0.0;
float pist = 0.0;
#ifndef FAR
vec2 uvA = (vW.xz - uAux.xy) / uAux.zw;
vec3 aux = texture2D(tAux, uvA).rgb;
vec3 drc = texture2D(tDir, uvA).rgb;
pist = smoothstep(0.3, 0.75, aux.g);
// au-delà de la portée des sapins 3D : le couvert réel devient la couleur de la forêt
float farF = smoothstep(uTreeRange * 0.62, uTreeRange * 1.02, dist);
float can = clamp(aux.r * 1.25, 0.0, 1.0);
alb = mix(alb, vec3(0.021, 0.036, 0.029) * (0.8 + 0.4 * nzB.r), can * 0.93 * farF);
#endif
float near1 = 1.0 - smoothstep(25.0, 160.0, dist);
alb *= (0.965 + 0.07 * nzA.r) * mix(1.0, 0.95 + 0.09 * nzC.b, near1 * (1.0 - pist * 0.6));
diffuseColor.rgb *= alb;
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec2 dW = (vec2(nzB.r, nzB.g) - 0.5) * 0.55 * (1.0 - smoothstep(80.0, 500.0, dist));
  dW += (vec2(nzC.r, nzC.g) - 0.5) * 0.5 * (1.0 - smoothstep(6.0, 45.0, dist));
#ifndef FAR
  vec2 cs = drc.rg * 2.0 - 1.0;
  if (pist > 0.01 && dot(cs, cs) > 0.05) {
    float th = 0.5 * atan(cs.y, cs.x);
    vec2 perp = vec2(-sin(th), cos(th));
    float u = dot(vW.xz, perp);
    float fu = fwidth(u);
    float rid = sin(u * 6.2832 / 0.12);
    float fade = 1.0 - smoothstep(0.012, 0.035, fu);
    dW *= mix(1.0, 0.35, pist);
    dW += perp * rid * 0.16 * pist * fade;
    float sm = abs(fract(u / 5.4) - 0.5) * 2.0;
    seamDark = pist * smoothstep(0.92, 1.0, sm) * (1.0 - smoothstep(0.08, 0.25, fwidth(u / 5.4) * 6.0));
  }
#endif
  normal = normalize(normal + (viewMatrix * vec4(dW.x, 0.0, dW.y, 0.0)).xyz);
  diffuseColor.rgb *= 1.0 - 0.05 * seamDark;
}
`;

const FRAG_LIGHT = /* glsl */ `
{
  vec3 bl = texture2D(tLight, uvT).rgb;
  float sv = bl.r * bl.g;
  reflectedLight.directDiffuse *= sv;
  reflectedLight.indirectDiffuse *= 0.35 + 0.65 * bl.b;
  // paillettes : scintillent selon l'angle de vue, seulement au soleil et de près
  vec3 vd = normalize(vW - cameraPosition);
  float tw = h21(floor(vW.xz * 7.0) + floor(vd.xz * 40.0));
  float sp = step(0.9965, tw) * (1.0 - smoothstep(4.0, 38.0, dist)) * sv;
  reflectedLight.directDiffuse += vec3(sp * 2.2);
}
`;

export function terrainMaterial(o: { alb: THREE.Texture; light: THREE.Texture; rect: THREE.Vector4; noise: THREE.Texture; far: boolean; aux?: THREE.Texture; dir?: THREE.Texture; auxRect?: THREE.Vector4; shared: TerrainUniforms }): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tAlb = { value: o.alb };
    sh.uniforms.tLight = { value: o.light };
    sh.uniforms.tNoise = { value: o.noise };
    sh.uniforms.uRect = { value: o.rect };
    sh.uniforms.uTreeRange = o.shared.treeRange;
    if (!o.far) {
      sh.uniforms.tAux = { value: o.aux };
      sh.uniforms.tDir = { value: o.dir };
      sh.uniforms.uAux = { value: o.auxRect };
    }
    sh.vertexShader = 'varying vec3 vW;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader =
      (o.far ? '#define FAR\n' : '') +
      FRAG_HEAD +
      sh.fragmentShader
        .replace('#include <map_fragment>', FRAG_MAP)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + FRAG_LIGHT);
  };
  mat.customProgramCacheKey = () => (o.far ? 'pds-terrain-far' : 'pds-terrain');
  return mat;
}

interface Chunk {
  ci: number;
  cj: number;
  mesh: THREE.Mesh;
  lod: number;
  minY: number;
  maxY: number;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly uniforms: TerrainUniforms = { treeRange: { value: 1200 } };
  private chunks: Chunk[] = [];
  private indexCache = new Map<number, THREE.BufferAttribute>();
  private g: Grid;
  private lodDist: number;

  constructor(private world: World, opts: { lodDist: number; treeRange: number; aniso: number }) {
    this.g = world.grid;
    this.lodDist = opts.lodDist;
    this.uniforms.treeRange.value = opts.treeRange;
    const m = world.meta;
    const noise = noiseTexture();
    const W = 2 * m.halfW, D = 2 * m.halfD;
    const aux = bitmapTexture(world.images.aux, false, opts.aniso);
    const dir = bitmapTexture(world.images.dir, false, 1);
    dir.magFilter = THREE.LinearFilter;
    const auxRect = new THREE.Vector4(-m.halfW, -m.halfD, W, D);
    const mats = new Map<string, THREE.Material>();
    const tileM = m.tileSize * m.texM;
    for (const t of m.tiles) {
      const k = `${t.i}_${t.j}`;
      mats.set(
        k,
        terrainMaterial({
          alb: bitmapTexture(world.images.albedo.get(k)!, true, opts.aniso),
          light: bitmapTexture(world.images.light.get(k)!, false, opts.aniso),
          rect: new THREE.Vector4(-m.halfW + t.i * tileM, -m.halfD + t.j * tileM, t.w * m.texM, t.h * m.texM),
          noise,
          far: false,
          aux,
          dir,
          auxRect,
          shared: this.uniforms,
        }),
      );
    }
    const per = m.tileSize * m.texM / (C * m.cell); // carreaux par tuile de texture
    const cols = m.nx / C, rows = m.nz / C;
    for (let cj = 0; cj < rows; cj++)
      for (let ci = 0; ci < cols; ci++) {
        let minY = Infinity, maxY = -Infinity;
        for (let j = cj * C; j <= (cj + 1) * C; j += 4)
          for (let i = ci * C; i <= (ci + 1) * C; i += 4) {
            const h = this.g.h[j * this.g.nx + i];
            minY = Math.min(minY, h);
            maxY = Math.max(maxY, h);
          }
        const mat = mats.get(`${Math.floor(ci / per)}_${Math.floor(cj / per)}`)!;
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.cat = 'sol';
        this.group.add(mesh);
        this.chunks.push({ ci, cj, mesh, lod: -1, minY, maxY });
      }
    this.group.add(this.buildFar(noise, opts.aniso));
  }

  /** Index partagé d'un niveau de détail (grille + jupe). */
  private indices(lod: number): THREE.BufferAttribute {
    let a = this.indexCache.get(lod);
    if (a) return a;
    const n = C / (1 << lod) + 1;
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a0 = j * n + i;
        idx.push(a0, a0 + n, a0 + 1, a0 + 1, a0 + n, a0 + n + 1);
      }
    // jupe : anneau de bordure (dans l'ordre du pourtour) + copie abaissée
    const ring: number[] = [];
    for (let i = 0; i < n - 1; i++) ring.push(i);
    for (let j = 0; j < n - 1; j++) ring.push(j * n + n - 1);
    for (let i = n - 1; i > 0; i--) ring.push((n - 1) * n + i);
    for (let j = n - 1; j > 0; j--) ring.push(j * n);
    const base = n * n;
    for (let k = 0; k < ring.length; k++) {
      const a0 = ring[k], b0 = ring[(k + 1) % ring.length], a1 = base + k, b1 = base + ((k + 1) % ring.length);
      idx.push(a0, b0, a1, b0, b1, a1, a0, a1, b0, b0, a1, b1);
    }
    a = new THREE.BufferAttribute(n * n + ring.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
    this.indexCache.set(lod, a);
    return a;
  }

  private buildChunk(ch: Chunk, lod: number): THREE.BufferGeometry {
    const g = this.g;
    const s = 1 << lod;
    const n = C / s + 1;
    const ringLen = 4 * (n - 1);
    const pos = new Float32Array((n * n + ringLen) * 3);
    const nor = new Float32Array((n * n + ringLen) * 3);
    const i0 = ch.ci * C, j0 = ch.cj * C;
    const H = (i: number, j: number) => g.h[Math.min(g.nz - 1, Math.max(0, j)) * g.nx + Math.min(g.nx - 1, Math.max(0, i))];
    const e = Math.max(1, s >> 1);
    for (let b = 0; b < n; b++)
      for (let a = 0; a < n; a++) {
        const i = i0 + a * s, j = j0 + b * s, k = (b * n + a) * 3;
        pos[k] = g.minX + i * g.cx;
        pos[k + 1] = H(i, j);
        pos[k + 2] = g.minZ + j * g.cz;
        const nx = H(i - e, j) - H(i + e, j), nz = H(i, j - e) - H(i, j + e), ny = 2 * e * g.cx;
        const l = Math.hypot(nx, ny, nz);
        nor[k] = nx / l;
        nor[k + 1] = ny / l;
        nor[k + 2] = nz / l;
      }
    const ring: number[] = [];
    for (let i = 0; i < n - 1; i++) ring.push(i);
    for (let j = 0; j < n - 1; j++) ring.push(j * n + n - 1);
    for (let i = n - 1; i > 0; i--) ring.push((n - 1) * n + i);
    for (let j = n - 1; j > 0; j--) ring.push(j * n);
    const drop = 3 + s * 2.5;
    ring.forEach((src, k) => {
      const d = (n * n + k) * 3;
      pos[d] = pos[src * 3];
      pos[d + 1] = pos[src * 3 + 1] - drop;
      pos[d + 2] = pos[src * 3 + 2];
      nor[d] = nor[src * 3];
      nor[d + 1] = nor[src * 3 + 1];
      nor[d + 2] = nor[src * 3 + 2];
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(this.indices(lod));
    const x0 = g.minX + i0 * g.cx, z0 = g.minZ + j0 * g.cz, sz = C * g.cx;
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, ch.minY - drop - 5, z0), new THREE.Vector3(x0 + sz, ch.maxY + 5, z0 + sz));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    return geo;
  }

  private buildFar(noise: THREE.Texture, aniso: number): THREE.Mesh {
    const f = this.world.far, m = this.world.meta;
    const step = 2;
    const nx = Math.floor((f.nx - 1) / step) + 1, nz = Math.floor((f.nz - 1) / step) + 1;
    const pos = new Float32Array(nx * nz * 3), nor = new Float32Array(nx * nz * 3);
    const H = (i: number, j: number) => f.h[Math.min(f.nz - 1, Math.max(0, j)) * f.nx + Math.min(f.nx - 1, Math.max(0, i))];
    const cs = f.cx * step;
    for (let b = 0; b < nz; b++)
      for (let a = 0; a < nx; a++) {
        const i = a * step, j = b * step, k = (b * nx + a) * 3;
        const x = f.minX + i * f.cx, z = f.minZ + j * f.cz;
        const inside = Math.abs(x) < m.halfW && Math.abs(z) < m.halfD;
        pos[k] = x;
        pos[k + 1] = H(i, j) - (inside ? 8 : 0);
        pos[k + 2] = z;
        const gx = H(i - step, j) - H(i + step, j), gz = H(i, j - step) - H(i, j + step);
        const l = Math.hypot(gx, 2 * cs, gz);
        nor[k] = gx / l;
        nor[k + 1] = (2 * cs) / l;
        nor[k + 2] = gz / l;
      }
    const idx: number[] = [];
    const hole = (x: number, z: number) => Math.abs(x) < m.halfW - cs * 1.5 && Math.abs(z) < m.halfD - cs * 1.5;
    for (let b = 0; b < nz - 1; b++)
      for (let a = 0; a < nx - 1; a++) {
        const x0 = f.minX + a * cs, z0 = f.minZ + b * cs;
        if (hole(x0, z0) && hole(x0 + cs, z0 + cs)) continue;
        const a0 = b * nx + a;
        idx.push(a0, a0 + nx, a0 + 1, a0 + 1, a0 + nx, a0 + nx + 1);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = terrainMaterial({
      alb: bitmapTexture(this.world.images.farAlbedo, true, aniso),
      light: bitmapTexture(this.world.images.farLight, false, aniso),
      rect: new THREE.Vector4(-m.far.halfX, -m.far.halfZ, 2 * m.far.halfX, 2 * m.far.halfZ),
      noise,
      far: true,
      shared: this.uniforms,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.userData.cat = 'lointain';
    return mesh;
  }

  /** Choisit le niveau de détail de chaque carreau. */
  update(cam: THREE.Vector3, budget = 3) {
    const g = this.g;
    const sz = C * g.cx;
    let built = 0;
    for (const ch of this.chunks) {
      const x0 = g.minX + ch.ci * sz, z0 = g.minZ + ch.cj * sz;
      const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + sz)), dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + sz));
      const dy = Math.max(ch.minY - cam.y, 0, cam.y - ch.maxY);
      const d = Math.hypot(dx, dz, dy * 0.5);
      let lod = d < this.lodDist ? 0 : d < this.lodDist * 2 ? 1 : d < this.lodDist * 4 ? 2 : d < this.lodDist * 8 ? 3 : 4;
      // hystérésis : on ne repasse en moins détaillé qu'avec 12 % de marge
      if (ch.lod >= 0 && lod > ch.lod) {
        const lim = this.lodDist * (1 << ch.lod) * 1.12;
        if (d < lim) lod = ch.lod;
      }
      // quelques reconstructions par image au plus (pas d'à-coup), le carreau le plus proche d'abord
      if (lod !== ch.lod && (built < budget || ch.lod < 0 || lod < ch.lod - 1)) {
        built++;
        const old = ch.mesh.geometry;
        ch.mesh.geometry = this.buildChunk(ch, lod);
        old.setIndex(null); // index partagé entre carreaux : ne pas le libérer
        old.dispose();
        ch.lod = lod;
      }
    }
  }

  get triangles(): number {
    let t = 0;
    for (const ch of this.chunks) t += (ch.mesh.geometry.index?.count ?? 0) / 3;
    return t;
  }
}
