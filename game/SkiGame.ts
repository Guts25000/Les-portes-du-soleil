/**
 * Ski Simulator — rendu Three.js.
 * Le parcours = tracé GPS OSM de la piste ; le relief = MNT réel (AWS Terrain Tiles).
 * Éléments générés (et signalés comme tels) : forêt, balisage, filets, autres skieurs.
 */
import * as THREE from 'three';
import type { Difficulty, Lift, LngLat, Piste } from '@/lib/types';
import { DemSampler } from '@/lib/dem';
import { LocalProjection, bboxOf, resample, smooth } from '@/lib/geo';
import { DIFF_COLOR } from '@/lib/estimates';
import { Track, SpatialHash, rng, fbm } from './track';
import { createSkier, emptyInput, respawnOnTrack, speedOf, step, type Env, type GameEvent, type Input, type Skier } from './physics';

export interface Hud {
  phase: 'loading' | 'countdown' | 'running' | 'finished';
  countdown: number;
  time: number;
  speedKmh: number;
  dist: number;
  remaining: number;
  score: number;
  tricks: number;
  airborne: boolean;
  offPiste: boolean;
  message: string | null;
  altitude: number;
}

export interface GameResult {
  timeS: number;
  maxKmh: number;
  avgKmh: number;
  score: number;
  tricks: number;
  crashes: number;
  distanceM: number;
  approximate: boolean;
}

export interface GameOptions {
  container: HTMLElement;
  piste: Piste;
  nearbyPistes: Piste[];
  nearbyLifts: Lift[];
  onHud: (h: Hud) => void;
  onFinish: (r: GameResult) => void;
  onLoading: (msg: string) => void;
}

interface Grid {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  cx: number;
  cz: number;
  h: Float32Array;
}

function gridHeight(g: Grid, x: number, z: number): number | null {
  const fx = (x - g.minX) / g.cx, fz = (z - g.minZ) / g.cz;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return null;
  const ix = Math.min(g.nx - 2, Math.floor(fx)), iz = Math.min(g.nz - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const i = iz * g.nx + ix;
  const a = g.h[i], b = g.h[i + 1], c = g.h[i + g.nx], d = g.h[i + g.nx + 1];
  return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
}

const PISTE_WIDTH: Record<Difficulty, number> = { verte: 30, bleue: 34, rouge: 30, noire: 26, freeride: 22, inconnue: 30 };
const TREELINE = 1950;

export class SkiGame {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.3, 12000);
  private sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  private raf = 0;
  private last = 0;
  private disposed = false;
  private hudTimer = 0;

  private proj!: LocalProjection;
  private near!: Grid;
  private far!: Grid;
  private track!: Track;
  private env!: Env;
  private trees = new SpatialHash(12);
  private nets = new SpatialHash(6);
  private halfWidth = 15;
  approximate = false;

  input: Input = emptyInput();
  private keyInput: Input = emptyInput();
  private skier!: Skier;
  private skierMesh!: THREE.Group;
  private skierParts!: { body: THREE.Object3D; skis: THREE.Object3D; lean: THREE.Object3D };
  private bots: { mesh: THREE.Group; s: number; lat: number; speed: number; phase: number; x: number; z: number }[] = [];
  private lifts: { cabins: THREE.InstancedMesh; path: THREE.Vector3[]; lengths: number[]; total: number; count: number; speed: number }[] = [];
  private snow!: THREE.Points;
  private spray!: THREE.Points;
  private sprayVel!: Float32Array;
  private sprayLife!: Float32Array;
  private sprayCursor = 0;
  private firstPerson = false;

  private phase: Hud['phase'] = 'loading';
  private countdown = 3;
  private time = 0;
  private score = 0;
  private tricks = 0;
  private crashes = 0;
  private maxSpeed = 0;
  private message: string | null = null;
  private messageTimer = 0;
  private events: GameEvent[] = [];
  private tmp: number[] = [];

  constructor(private o: GameOptions) {}

  // ------------------------------------------------------------------ construction
  async init() {
    const o = this.o;
    o.onLoading('Préparation du tracé GPS…');
    const line = o.piste.line;
    const [w, s, e, n] = bboxOf(line);
    this.proj = new LocalProjection([(w + e) / 2, (s + n) / 2]);
    let pts = line.map((p) => this.proj.toLocal(p));
    pts = smooth(resample(pts, 4), 3);

    // --- MNT proche (haute résolution) et lointain (panorama)
    const latM = 1 / 111_000, lonM = 1 / (111_000 * Math.cos((s * Math.PI) / 180));
    const nearMargin = 450, farMargin = 4500;
    const nearBox: [number, number, number, number] = [w - nearMargin * lonM, s - nearMargin * latM, e + nearMargin * lonM, n + nearMargin * latM];
    const farBox: [number, number, number, number] = [w - farMargin * lonM, s - farMargin * latM, e + farMargin * lonM, n + farMargin * latM];
    const spanM = Math.max((e - w) / lonM, (n - s) / latM);
    const demNear = new DemSampler(spanM < 4000 ? 14 : 13);
    const demFar = new DemSampler(11);
    o.onLoading('Téléchargement du relief réel (MNT)…');
    const [okNear, okFar] = await Promise.all([demNear.preload(nearBox), demFar.preload(farBox)]);
    if (this.disposed) return;

    // orientation : on descend
    const h0 = demNear.sample(this.proj.toLngLat(pts[0].x, pts[0].z));
    const h1 = demNear.sample(this.proj.toLngLat(pts[pts.length - 1].x, pts[pts.length - 1].z));
    if (h0 != null && h1 != null && h0 < h1) pts.reverse();
    this.track = new Track(pts);

    o.onLoading('Reconstruction du terrain 3D…');
    this.halfWidth = (o.piste.widthM ?? PISTE_WIDTH[o.piste.difficulty]) / 2;
    this.approximate = !okNear;
    this.near = this.buildGrid(nearBox, 520, 7, (p) => demNear.sample(p));
    this.far = this.buildGrid(farBox, 220, 45, (p) => demFar.sample(p) ?? demNear.sample(p));
    if (!okNear) this.synthesizeTerrain(this.near);
    if (!okFar) this.synthesizeTerrain(this.far);
    if (!okNear) {
      // le relief lointain doit rester cohérent avec la reconstruction
      for (let i = 0; i < this.far.h.length; i++) {
        const x = this.far.minX + (i % this.far.nx) * this.far.cx, z = this.far.minZ + Math.floor(i / this.far.nx) * this.far.cz;
        const hn = gridHeight(this.near, x, z);
        if (hn != null) this.far.h[i] = hn;
      }
    }

    this.env = {
      height: (x, z) => gridHeight(this.near, x, z) ?? gridHeight(this.far, x, z) ?? 0,
      track: this.track,
      halfWidth: this.halfWidth,
      collide: (x, z, above) => this.collide(x, z, above),
    };

    this.setupRenderer();
    this.buildSky();
    this.buildTerrainMeshes();
    o.onLoading('Plantation de la forêt…');
    await new Promise((r) => setTimeout(r, 0));
    this.buildForest();
    this.buildMarkers();
    this.buildLifts();
    this.buildSkier();
    this.buildBots();
    this.buildParticles();
    this.bindKeys();
    this.reset();
    this.last = performance.now();
    this.loop();
  }

  /** Reconstruction approximative (signalée) si le MNT est indisponible : pente régulière le long du tracé. */
  private synthesizeTerrain(g: Grid) {
    const grade = this.o.piste.difficulty === 'noire' ? 0.42 : this.o.piste.difficulty === 'rouge' ? 0.3 : this.o.piste.difficulty === 'verte' ? 0.12 : 0.2;
    const top = 2000;
    for (let iz = 0; iz < g.nz; iz++)
      for (let ix = 0; ix < g.nx; ix++) {
        const x = g.minX + ix * g.cx, z = g.minZ + iz * g.cz;
        const pr = this.track.nearestGlobal(x, z);
        const lat = pr.dist;
        g.h[iz * g.nx + ix] = top - pr.s * grade + Math.pow(Math.max(0, lat - this.halfWidth), 1.25) * 0.35 + fbm(x / 140, z / 140) * 8;
      }
  }

  private buildGrid(box: [number, number, number, number], maxCells: number, targetCell: number, sample: (p: LngLat) => number | null): Grid {
    const a = this.proj.toLocal([box[0], box[3]]); // nord-ouest
    const b = this.proj.toLocal([box[2], box[1]]); // sud-est
    const W = b.x - a.x, D = b.z - a.z;
    const nx = Math.min(maxCells, Math.max(32, Math.ceil(W / targetCell))) + 1;
    const nz = Math.min(maxCells, Math.max(32, Math.ceil(D / targetCell))) + 1;
    const g: Grid = { minX: a.x, minZ: a.z, nx, nz, cx: W / (nx - 1), cz: D / (nz - 1), h: new Float32Array(nx * nz) };
    let lastValid = 1500;
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++) {
        const v = sample(this.proj.toLngLat(g.minX + ix * g.cx, g.minZ + iz * g.cz));
        if (v != null) lastValid = v;
        g.h[iz * nx + ix] = v ?? lastValid;
      }
    return g;
  }

  private setupRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.o.container.appendChild(r.domElement);
    r.domElement.style.display = 'block';
    this.renderer = r;
    const resize = () => {
      const w = this.o.container.clientWidth, h = this.o.container.clientHeight;
      r.setSize(w, h);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    this.cleanup.push(() => window.removeEventListener('resize', resize));

    this.scene.add(new THREE.HemisphereLight(0xcfe3f5, 0x5c6b7a, 0.9));
    // soleil d'hiver, sud-ouest, ~28° de hauteur
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 1;
    sc.far = 600;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.4;
    this.scene.add(this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xcfdfec, 600, 7000);
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(10000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(0x2f6fb5) }, mid: { value: new THREE.Color(0x8fbde3) }, bottom: { value: new THREE.Color(0xdfe9f2) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : bottom; c = mix(bottom, c, smoothstep(-0.02, 0.12, h)); gl_FragColor = vec4(c,1.0); }',
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -1;
    this.skyMesh = sky;
    this.scene.add(sky);
  }
  private skyMesh!: THREE.Mesh;

  private gridGeometry(g: Grid, lowerBy = 0, colorFn?: (x: number, z: number, h: number, slope: number) => THREE.Color) {
    const n = g.nx * g.nz;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const col = new Float32Array(n * 3);
    for (let iz = 0; iz < g.nz; iz++)
      for (let ix = 0; ix < g.nx; ix++) {
        const i = iz * g.nx + ix;
        const x = g.minX + ix * g.cx, z = g.minZ + iz * g.cz;
        const h = g.h[i] - lowerBy;
        pos.set([x, h, z], i * 3);
        uv.set([ix / (g.nx - 1), 1 - iz / (g.nz - 1)], i * 2);
        if (colorFn) {
          const hx = g.h[Math.min(g.nx - 1, ix + 1) + iz * g.nx] - g.h[Math.max(0, ix - 1) + iz * g.nx];
          const hz = g.h[ix + Math.min(g.nz - 1, iz + 1) * g.nx] - g.h[ix + Math.max(0, iz - 1) * g.nx];
          const slope = Math.hypot(hx / (2 * g.cx), hz / (2 * g.cz));
          const c = colorFn(x, z, g.h[i], slope);
          col.set([c.r, c.g, c.b], i * 3);
        }
      }
    const idx = new Uint32Array((g.nx - 1) * (g.nz - 1) * 6);
    let k = 0;
    for (let iz = 0; iz < g.nz - 1; iz++)
      for (let ix = 0; ix < g.nx - 1; ix++) {
        const a = iz * g.nx + ix, b = a + 1, c = a + g.nx, d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (colorFn) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    return geo;
  }

  private terrainColor = (x: number, z: number, _h: number, slope: number) => {
    const c = new THREE.Color(0xf4f8fc);
    const rock = new THREE.Color(0x6e737a);
    const n = fbm(x / 90, z / 90);
    // les parois très raides ne retiennent pas la neige
    const rockT = THREE.MathUtils.smoothstep(slope, 0.95, 1.5);
    return c.lerp(rock, rockT * (0.6 + n * 0.4));
  };

  private farColor = (x: number, z: number, h: number, slope: number) => {
    const c = this.terrainColor(x, z, h, slope);
    const forest = new THREE.Color(0x4b5e55);
    const below = THREE.MathUtils.smoothstep(TREELINE + 60 - h, 0, 160);
    const dens = fbm(x / 400, z / 400);
    if (slope < 1.2) c.lerp(forest, below * THREE.MathUtils.smoothstep(dens, 0.35, 0.6) * 0.75);
    return c;
  };

  private buildTerrainMeshes() {
    // texture de la zone proche : neige + pistes damées peintes d'après les tracés OSM
    const S = 2048;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const ctx = cv.getContext('2d')!;
    const g = this.near;
    const W = (g.nx - 1) * g.cx, D = (g.nz - 1) * g.cz;
    const toPx = (x: number, z: number): [number, number] => [((x - g.minX) / W) * S, ((z - g.minZ) / D) * S];
    ctx.fillStyle = '#e8eef4';
    ctx.fillRect(0, 0, S, S);
    const r = rng(7);
    for (let i = 0; i < 26000; i++) {
      ctx.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '150,170,195'},${0.05 + r() * 0.08})`;
      ctx.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3);
    }
    const pxPerM = S / W;
    const drawLine = (pts: { x: number; z: number }[], width: number, style: string) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [a, b] = toPx(p.x, p.z);
        if (i) ctx.lineTo(a, b);
        else ctx.moveTo(a, b);
      });
      ctx.lineWidth = Math.max(1, width * pxPerM);
      ctx.strokeStyle = style;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    };
    // pistes voisines (réelles)
    for (const p of this.o.nearbyPistes) {
      if (p.id === this.o.piste.id) continue;
      for (const seg of p.segments) {
        const loc = seg.map((q) => this.proj.toLocal(q));
        drawLine(loc, (p.widthM ?? PISTE_WIDTH[p.difficulty]) + 2, 'rgba(120,150,185,0.22)');
        drawLine(loc, p.widthM ?? PISTE_WIDTH[p.difficulty], 'rgba(252,254,255,0.95)');
      }
    }
    const main: { x: number; z: number }[] = [];
    for (let i = 0; i < this.track.n; i++) main.push({ x: this.track.xs[i], z: this.track.zs[i] });
    drawLine(main, this.halfWidth * 2 + 3, 'rgba(90,130,175,0.35)');
    drawLine(main, this.halfWidth * 2, '#fbfdff');
    // stries de damage + traces de skis
    for (let k = -6; k <= 6; k++) {
      const off = (k / 6) * (this.halfWidth - 2);
      const pts = main.map((p, i) => {
        const a = this.track.at(this.track.s[i]);
        return { x: p.x + a.tz * off, z: p.z - a.tx * off };
      });
      drawLine(pts, 0.35, 'rgba(170,190,215,0.18)');
    }
    for (let k = 0; k < 14; k++) {
      const amp = 2 + r() * (this.halfWidth - 4), ph = r() * 10, freq = 0.02 + r() * 0.03;
      const pts = main.map((p, i) => {
        const a = this.track.at(this.track.s[i]);
        const off = Math.sin(this.track.s[i] * freq + ph) * amp;
        return { x: p.x + a.tz * off, z: p.z - a.tx * off };
      });
      drawLine(pts, 0.25, 'rgba(140,160,190,0.22)');
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const nearGeo = this.gridGeometry(this.near, 0, this.terrainColor);
    const nearMesh = new THREE.Mesh(nearGeo, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.92, metalness: 0 }));
    nearMesh.receiveShadow = true;
    this.scene.add(nearMesh);

    const farGeo = this.gridGeometry(this.far, 2, this.farColor);
    const farMesh = new THREE.Mesh(farGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    this.scene.add(farMesh);
  }

  private collide(x: number, z: number, above: number): string | null {
    if (above < 6) {
      for (const id of this.trees.query(x, z, 0.9, this.tmp)) {
        if (Math.hypot(this.trees.xs[id] - x, this.trees.zs[id] - z) < 0.9 + this.trees.rs[id]) return 'Arbre !';
      }
    }
    if (above < 1.5 && this.nets.query(x, z, 0.7, this.tmp).length) return 'Filet de sécurité';
    for (const b of this.bots) if (Math.hypot(b.x - x, b.z - z) < 1.1 && above < 1.5) return 'Collision avec un skieur';
    return null;
  }

  private buildForest() {
    const g = this.near;
    const r = rng(1234);
    const W = (g.nx - 1) * g.cx, D = (g.nz - 1) * g.cz;
    const target = Math.min(9000, Math.round(((W * D) / 1e6) * 1400));
    const pos: { x: number; z: number; y: number; s: number }[] = [];
    // index des corridors de toutes les pistes (aucun arbre sur une piste réelle)
    const corridor = new SpatialHash(20);
    for (let i = 0; i < this.track.n; i += 2) corridor.insert(this.track.xs[i], this.track.zs[i], this.halfWidth + 5);
    for (const p of this.o.nearbyPistes)
      for (const seg of p.segments) {
        const loc = resample(seg.map((q) => this.proj.toLocal(q)), 8);
        for (const q of loc) corridor.insert(q.x, q.z, (p.widthM ?? PISTE_WIDTH[p.difficulty]) / 2 + 4);
      }
    for (const l of this.o.nearbyLifts) {
      const loc = resample(l.line.map((q) => this.proj.toLocal(q)), 8);
      for (const q of loc) corridor.insert(q.x, q.z, 9);
    }
    let tries = 0;
    while (pos.length < target && tries < target * 8) {
      tries++;
      const x = g.minX + r() * W, z = g.minZ + r() * D;
      const h = this.env.height(x, z);
      const tl = TREELINE + (fbm(x / 300, z / 300) - 0.5) * 160;
      if (h > tl) continue;
      const dens = fbm(x / 160, z / 160);
      if (r() > THREE.MathUtils.smoothstep(dens, 0.32, 0.62)) continue;
      const sl = Math.hypot(this.env.height(x + 2, z) - this.env.height(x - 2, z), this.env.height(x, z + 2) - this.env.height(x, z - 2)) / 4;
      if (sl > 1.1) continue;
      if (corridor.query(x, z, 30, this.tmp).length) continue;
      const scale = 0.7 + r() * 0.8 * (1 - THREE.MathUtils.smoothstep(h, tl - 150, tl));
      pos.push({ x, z, y: h, s: Math.max(0.45, scale) });
    }
    const foliageGeo = new THREE.ConeGeometry(2.4, 8, 7);
    foliageGeo.translate(0, 6, 0);
    const foliage2 = new THREE.ConeGeometry(1.7, 5.5, 7);
    foliage2.translate(0, 9.5, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.38, 2.6, 5);
    trunkGeo.translate(0, 1.3, 0);
    const mFol = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }); // teinte par instance
    const mSnowy = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.8, flatShading: true });
    const mTrunk = new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 1 });
    const iFol = new THREE.InstancedMesh(foliageGeo, mFol, pos.length);
    const iFol2 = new THREE.InstancedMesh(foliage2, mSnowy, pos.length);
    const iTr = new THREE.InstancedMesh(trunkGeo, mTrunk, pos.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
    const tint = new THREE.Color();
    pos.forEach((p, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
      sv.set(p.s, p.s * (0.9 + r() * 0.3), p.s);
      pv.set(p.x, p.y - 0.3, p.z);
      m.compose(pv, q, sv);
      iFol.setMatrixAt(i, m);
      iFol2.setMatrixAt(i, m);
      iTr.setMatrixAt(i, m);
      iFol.setColorAt(i, tint.setHSL(0.38 + r() * 0.05, 0.3 + r() * 0.15, 0.15 + r() * 0.08));
      this.trees.insert(p.x, p.z, 0.45 * p.s);
    });
    for (const im of [iFol, iFol2, iTr]) {
      im.castShadow = true;
      im.receiveShadow = false;
      this.scene.add(im);
    }
  }

  private buildMarkers() {
    const color = new THREE.Color(DIFF_COLOR[this.o.piste.difficulty] === '#111827' ? '#1a1a1a' : DIFF_COLOR[this.o.piste.difficulty]);
    const poles: THREE.Vector3[] = [];
    const netSegs: { p: THREE.Vector3; yaw: number }[] = [];
    for (let s = 10; s < this.track.total - 5; s += 32) {
      const a = this.track.at(s);
      for (const side of [-1, 1]) {
        const x = a.x + a.tz * side * (this.halfWidth + 0.5);
        const z = a.z - a.tx * side * (this.halfWidth + 0.5);
        poles.push(new THREE.Vector3(x, this.env.height(x, z), z));
      }
    }
    // filets sur l'extérieur des virages prononcés en pente
    for (let s = 20; s < this.track.total - 20; s += 2.5) {
      const turn = this.track.turnAngle(s, 22);
      if (Math.abs(turn) < 0.55) continue;
      const a = this.track.at(s);
      const h1 = this.env.height(a.x, a.z), h2 = this.env.height(a.x + a.tx * 10, a.z + a.tz * 10);
      if ((h1 - h2) / 10 < 0.12) continue;
      const side = turn > 0 ? -1 : 1; // virage à gauche → filet à droite
      const x = a.x + a.tz * side * (this.halfWidth + 1.5);
      const z = a.z - a.tx * side * (this.halfWidth + 1.5);
      netSegs.push({ p: new THREE.Vector3(x, this.env.height(x, z), z), yaw: Math.atan2(a.tx, a.tz) });
      this.nets.insert(x, z, 1.4);
    }
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.8, 5);
    poleGeo.translate(0, 0.9, 0);
    const iPole = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }), poles.length);
    const m = new THREE.Matrix4();
    poles.forEach((p, i) => iPole.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    iPole.castShadow = true;
    this.scene.add(iPole);
    if (netSegs.length) {
      const netGeo = new THREE.BoxGeometry(0.05, 1.3, 2.8);
      netGeo.translate(0, 0.75, 0);
      const iNet = new THREE.InstancedMesh(netGeo, new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.7, transparent: true, opacity: 0.9 }), netSegs.length);
      const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
      netSegs.forEach((n, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), n.yaw);
        iNet.setMatrixAt(i, m.compose(n.p, q, one));
      });
      iNet.castShadow = true;
      this.scene.add(iNet);
    }
    // arche d'arrivée
    const end = this.track.at(this.track.total - 3);
    const arch = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f6bff, emissive: 0x0a2a80, roughness: 0.4 });
    const legGeo = new THREE.BoxGeometry(0.5, 5, 0.5);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.set(side * (this.halfWidth * 0.8), 2.5, 0);
      arch.add(leg);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(this.halfWidth * 1.6 + 0.5, 1.1, 0.5), mat);
    top.position.y = 5;
    arch.add(top);
    arch.position.set(end.x, this.env.height(end.x, end.z), end.z);
    arch.rotation.y = Math.atan2(end.tx, end.tz);
    this.scene.add(arch);
  }

  private buildLifts() {
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
    const cableMat = new THREE.LineBasicMaterial({ color: 0x1d2127 });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0xd52b1e, roughness: 0.5 });
    for (const l of this.o.nearbyLifts) {
      const loc = l.line.map((p) => this.proj.toLocal(p));
      if (!loc.some((p) => gridHeight(this.far, p.x, p.z) != null)) continue;
      const rs = resample(loc, 110);
      const towerH = l.kind === 'teleski' ? 6 : l.kind === 'telecabine' || l.kind === 'telepherique' ? 16 : 11;
      const tops: THREE.Vector3[] = [];
      for (const p of rs) {
        const h = this.env.height(p.x, p.z);
        tops.push(new THREE.Vector3(p.x, h + towerH, p.z));
        const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, towerH, 6), pylonMat);
        pylon.position.set(p.x, h + towerH / 2, p.z);
        pylon.castShadow = true;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 0.35), pylonMat);
        arm.position.y = towerH / 2;
        const dir = rs.length > 1 ? Math.atan2(rs[rs.length - 1].x - rs[0].x, rs[rs.length - 1].z - rs[0].z) : 0;
        arm.rotation.y = dir;
        pylon.add(arm);
        this.scene.add(pylon);
      }
      if (tops.length < 2) continue;
      const dir = new THREE.Vector3().subVectors(tops[tops.length - 1], tops[0]).setY(0).normalize();
      const side = new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(2.2);
      const up = tops.map((t) => t.clone().add(side));
      const down = tops.map((t) => t.clone().sub(side));
      for (const c of [up, down]) this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(c), cableMat));
      // cabines / sièges animés (boucle : montée puis descente)
      const path = [...up, ...down.slice().reverse()];
      const lengths = [0];
      for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + path[i].distanceTo(path[i - 1]));
      const total = lengths[lengths.length - 1];
      const spacing = l.kind === 'telecabine' ? 70 : l.kind === 'teleski' ? 25 : 35;
      const count = Math.min(200, Math.floor(total / spacing));
      const geo = l.kind === 'teleski' ? new THREE.BoxGeometry(0.2, 1.2, 0.2) : l.kind === 'telecabine' || l.kind === 'telepherique' ? new THREE.BoxGeometry(1.8, 2, 1.8) : new THREE.BoxGeometry(2.4, 0.4, 0.8);
      geo.translate(0, l.kind === 'teleski' ? -0.6 : -1.6, 0);
      const cabins = new THREE.InstancedMesh(geo, cabinMat, Math.max(1, count));
      cabins.castShadow = true;
      this.scene.add(cabins);
      this.lifts.push({ cabins, path, lengths, total, count, speed: l.kind === 'telecabine' ? 5.5 : l.kind === 'teleski' ? 3 : 4.5 });
    }
  }

  private makeSkierModel(jacket: number, pants: number): { g: THREE.Group; body: THREE.Object3D; skis: THREE.Object3D; lean: THREE.Object3D } {
    const g = new THREE.Group();
    const lean = new THREE.Group();
    g.add(lean);
    const body = new THREE.Group();
    lean.add(body);
    const mJ = new THREE.MeshStandardMaterial({ color: jacket, roughness: 0.6 });
    const mP = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });
    const mH = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.3, metalness: 0.2 });
    const mS = new THREE.MeshStandardMaterial({ color: 0xf2c9a0, roughness: 0.8 });
    const mG = new THREE.MeshStandardMaterial({ color: 0xffa31a, roughness: 0.1, metalness: 0.6 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    for (const sx of [-0.13, 0.13]) add(new THREE.BoxGeometry(0.16, 0.8, 0.2), mP, sx, 0.5, 0.05, body, -0.35);
    add(new THREE.BoxGeometry(0.46, 0.6, 0.3), mJ, 0, 1.15, -0.02, body, 0.35);
    add(new THREE.SphereGeometry(0.14, 12, 10), mS, 0, 1.58, 0.1, body);
    add(new THREE.SphereGeometry(0.155, 12, 10, 0, Math.PI * 2, 0, Math.PI / 1.8), mH, 0, 1.6, 0.1, body);
    add(new THREE.BoxGeometry(0.24, 0.07, 0.05), mG, 0, 1.6, 0.24, body);
    for (const sx of [-0.3, 0.3]) {
      add(new THREE.BoxGeometry(0.11, 0.5, 0.12), mJ, sx, 1.1, 0.12, body, -0.9);
      add(new THREE.CylinderGeometry(0.012, 0.012, 1.2, 4), mH, sx * 1.15, 0.7, 0.05, body, 0.5);
    }
    const skis = new THREE.Group();
    const mSki = new THREE.MeshStandardMaterial({ color: jacket, roughness: 0.3, metalness: 0.3 });
    for (const sx of [-0.13, 0.13]) add(new THREE.BoxGeometry(0.09, 0.03, 1.75), mSki, sx, 0.03, 0.15, skis);
    lean.add(skis);
    return { g, body, skis, lean };
  }

  private buildSkier() {
    const m = this.makeSkierModel(0x1f6bff, 0x1d2127);
    this.skierMesh = m.g;
    this.skierParts = { body: m.body, skis: m.skis, lean: m.lean };
    this.scene.add(m.g);
  }

  private buildBots() {
    const r = rng(99);
    const colors = [0xef4444, 0xf59e0b, 0x22c55e, 0xa855f7, 0xffffff, 0x06b6d4];
    const n = Math.min(8, Math.max(3, Math.floor(this.track.total / 350)));
    for (let i = 0; i < n; i++) {
      const m = this.makeSkierModel(colors[i % colors.length], 0x2a2f36);
      this.scene.add(m.g);
      this.bots.push({
        mesh: m.g,
        s: 80 + (i / n) * (this.track.total - 120),
        lat: (r() - 0.5) * this.halfWidth,
        speed: 6 + r() * 6,
        phase: r() * 10,
        x: 0,
        z: 0,
      });
    }
  }

  private buildParticles() {
    const N = 2500;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 120;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.snow = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.85, depthWrite: false }));
    this.scene.add(this.snow);

    const M = 500;
    const sp = new Float32Array(M * 3).fill(-99999);
    this.sprayVel = new Float32Array(M * 3);
    this.sprayLife = new Float32Array(M);
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.spray = new THREE.Points(g2, new THREE.PointsMaterial({ color: 0xf5f9ff, size: 0.18, transparent: true, opacity: 0.9, depthWrite: false }));
    this.spray.frustumCulled = false;
    this.scene.add(this.spray);
  }

  private cleanup: (() => void)[] = [];

  private bindKeys() {
    const map: Record<string, keyof Input> = {
      ArrowLeft: 'left', KeyA: 'left', KeyQ: 'left',
      ArrowRight: 'right', KeyD: 'right',
      ArrowUp: 'up', KeyW: 'up', KeyZ: 'up',
      ArrowDown: 'down', KeyS: 'down',
      Space: 'jump',
      ShiftLeft: 'tuck', ShiftRight: 'tuck',
    };
    const down = (e: KeyboardEvent) => {
      const k = map[e.code];
      if (k) {
        this.keyInput[k] = true;
        e.preventDefault();
      }
      if (e.code === 'KeyC') this.firstPerson = !this.firstPerson;
      if (e.code === 'KeyR') this.reset();
    };
    const up = (e: KeyboardEvent) => {
      const k = map[e.code];
      if (k) this.keyInput[k] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    });
  }

  toggleCamera() {
    this.firstPerson = !this.firstPerson;
  }

  // ------------------------------------------------------------------ cycle de jeu
  reset() {
    this.skier = createSkier(this.track, this.env.height);
    this.phase = 'countdown';
    this.countdown = 3.2;
    this.time = 0;
    this.score = 0;
    this.tricks = 0;
    this.crashes = 0;
    this.maxSpeed = 0;
    this.message = null;
    this.events.length = 0;
    this.placeCamera(true);
  }

  private flash(msg: string, t = 1.6) {
    this.message = msg;
    this.messageTimer = t;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number) {
    const inp: Input = {
      left: this.keyInput.left || this.input.left,
      right: this.keyInput.right || this.input.right,
      up: this.keyInput.up || this.input.up,
      down: this.keyInput.down || this.input.down,
      jump: this.keyInput.jump || this.input.jump,
      tuck: this.keyInput.tuck || this.input.tuck,
    };
    const k = this.skier;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'running';
        this.flash('GO !', 1);
      }
    } else if (this.phase === 'running') {
      const sub = Math.ceil(dt / (1 / 120));
      const h = dt / sub;
      for (let i = 0; i < sub; i++) step(k, inp, this.env, h, this.events);
      this.time += dt;
      const sp = speedOf(k);
      this.maxSpeed = Math.max(this.maxSpeed, sp);
      if (k.grounded && !k.offPiste && k.crashTimer <= 0) this.score += sp * dt * 0.5;
      for (const e of this.events) {
        if (e.type === 'trick') {
          this.score += e.points;
          this.tricks++;
          this.flash(`${e.name}  +${e.points}`);
        } else if (e.type === 'crash') {
          this.score = Math.max(0, this.score - 250);
          this.crashes++;
          this.flash(`💥 ${e.reason}`);
        } else if (e.type === 'respawn') {
          this.score = Math.max(0, this.score - 200);
          this.flash('Retour sur la piste');
        }
      }
      this.events.length = 0;
      if (k.offPiste && k.grounded && this.messageTimer <= 0) this.flash('Hors piste : neige profonde', 0.8);
      if (k.s >= this.track.total - 8) this.finish();
    }

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message = null;
    }

    this.updateSkierMesh(dt);
    this.updateBots(dt);
    this.updateLifts(dt);
    this.updateParticles(dt);
    this.placeCamera(false, dt);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.08;
      this.o.onHud({
        phase: this.phase,
        countdown: Math.ceil(this.countdown),
        time: this.time,
        speedKmh: speedOf(k) * 3.6,
        dist: k.s,
        remaining: Math.max(0, this.track.total - k.s),
        score: Math.round(this.score),
        tricks: this.tricks,
        airborne: !k.grounded,
        offPiste: k.offPiste,
        message: this.message,
        altitude: k.y,
      });
    }
  }

  private finish() {
    this.phase = 'finished';
    const avg = this.track.total / Math.max(1, this.time);
    const timeBonus = Math.round((this.track.total / Math.max(1, this.time)) * 60);
    this.score += timeBonus;
    this.o.onFinish({
      timeS: this.time,
      maxKmh: this.maxSpeed * 3.6,
      avgKmh: avg * 3.6,
      score: Math.round(this.score),
      tricks: this.tricks,
      crashes: this.crashes,
      distanceM: this.track.total,
      approximate: this.approximate,
    });
  }

  private updateSkierMesh(dt: number) {
    const k = this.skier;
    const g = this.skierMesh;
    g.position.set(k.x, k.y, k.z);
    // orientation : cap + inclinaison selon la pente
    const e = 1.2;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const hF = this.env.height(k.x + fx * e, k.z + fz * e) - this.env.height(k.x - fx * e, k.z - fz * e);
    const pitch = k.grounded ? Math.atan2(-hF, 2 * e) : 0;
    g.rotation.set(0, 0, 0);
    g.rotateY(k.heading + (k.grounded ? 0 : k.spin));
    g.rotateX(pitch);
    const speed = speedOf(k);
    const crash = k.crashTimer > 0;
    this.skierParts.lean.rotation.z = THREE.MathUtils.lerp(this.skierParts.lean.rotation.z, crash ? 1.3 : -k.turn * Math.min(0.6, 0.12 + speed / 40), Math.min(1, dt * 8));
    const tuck = this.keyInput.tuck || this.input.tuck;
    const targetScale = tuck && k.grounded ? 0.72 : this.keyInput.down || this.input.down ? 0.88 : 0.95;
    this.skierParts.body.scale.y = THREE.MathUtils.lerp(this.skierParts.body.scale.y, targetScale, Math.min(1, dt * 6));
    this.skierParts.body.rotation.x = THREE.MathUtils.lerp(this.skierParts.body.rotation.x, tuck ? 0.45 : 0.12, Math.min(1, dt * 6));
    // chasse-neige : skis en V
    this.skierParts.skis.children.forEach((s, i) => {
      s.rotation.y = THREE.MathUtils.lerp(s.rotation.y, this.keyInput.down || this.input.down ? (i ? -0.25 : 0.25) : 0, Math.min(1, dt * 8));
    });
    g.visible = !this.firstPerson;

    // gerbe de neige dans les virages appuyés / freinages
    if (k.grounded && speed > 5 && k.edgeLoss > 0.05) {
      const n = Math.ceil(k.edgeLoss * 10);
      for (let i = 0; i < n; i++) this.emitSpray(k.x, k.y + 0.1, k.z, -k.vx * 0.2 + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2.5, -k.vz * 0.2 + (Math.random() - 0.5) * 3);
    }
    this.sun.position.set(k.x - 180, k.y + 220, k.z + 140);
    this.sun.target.position.set(k.x, k.y, k.z);
    this.skyMesh.position.set(this.camera.position.x, 0, this.camera.position.z);
  }

  private emitSpray(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const i = this.sprayCursor;
    this.sprayCursor = (i + 1) % this.sprayLife.length;
    const pos = this.spray.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(i, x, y, z);
    this.sprayVel.set([vx, vy, vz], i * 3);
    this.sprayLife[i] = 0.8;
  }

  private updateBots(dt: number) {
    for (const b of this.bots) {
      if (this.phase === 'running' || this.phase === 'finished') b.s += b.speed * dt;
      if (b.s > this.track.total - 10) b.s = 20;
      b.phase += dt;
      const a = this.track.at(b.s);
      const lat = b.lat + Math.sin(b.phase * 1.3) * Math.min(6, this.halfWidth * 0.4);
      b.x = a.x + a.tz * lat;
      b.z = a.z - a.tx * lat;
      b.mesh.position.set(b.x, this.env.height(b.x, b.z), b.z);
      b.mesh.rotation.set(0, Math.atan2(a.tx, a.tz) + Math.cos(b.phase * 1.3) * 0.5, 0);
      b.mesh.children[0].rotation.z = -Math.cos(b.phase * 1.3) * 0.3;
    }
  }

  private updateLifts(dt: number) {
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const l of this.lifts) {
      if (!l.count) continue;
      const base = (performance.now() / 1000) * l.speed;
      let seg = 0;
      for (let i = 0; i < l.count; i++) {
        const d = (base + (i * l.total) / l.count) % l.total;
        seg = 0;
        while (seg < l.lengths.length - 2 && l.lengths[seg + 1] < d) seg++;
        const t = (d - l.lengths[seg]) / Math.max(0.001, l.lengths[seg + 1] - l.lengths[seg]);
        v.lerpVectors(l.path[seg], l.path[seg + 1], t);
        l.cabins.setMatrixAt(i, m.makeTranslation(v.x, v.y, v.z));
      }
      l.cabins.instanceMatrix.needsUpdate = true;
    }
    void dt;
  }

  private updateParticles(dt: number) {
    const cam = this.camera.position;
    const p = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += 0.6 * dt;
      arr[i + 1] -= 1.4 * dt;
      // recyclage autour de la caméra
      if (arr[i + 1] < cam.y - 30) arr[i + 1] += 60;
      if (arr[i] - cam.x > 60) arr[i] -= 120;
      if (arr[i] - cam.x < -60) arr[i] += 120;
      if (arr[i + 2] - cam.z > 60) arr[i + 2] -= 120;
      if (arr[i + 2] - cam.z < -60) arr[i + 2] += 120;
      if (arr[i + 1] - cam.y > 30) arr[i + 1] -= 60;
    }
    p.needsUpdate = true;
    const sp = this.spray.geometry.getAttribute('position') as THREE.BufferAttribute;
    const sa = sp.array as Float32Array;
    for (let i = 0; i < this.sprayLife.length; i++) {
      if (this.sprayLife[i] <= 0) continue;
      this.sprayLife[i] -= dt;
      this.sprayVel[i * 3 + 1] -= 9.81 * dt * 0.6;
      sa[i * 3] += this.sprayVel[i * 3] * dt;
      sa[i * 3 + 1] += this.sprayVel[i * 3 + 1] * dt;
      sa[i * 3 + 2] += this.sprayVel[i * 3 + 2] * dt;
      if (this.sprayLife[i] <= 0) sa[i * 3 + 1] = -99999;
    }
    sp.needsUpdate = true;
  }

  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  private placeCamera(snap: boolean, dt = 0.016) {
    const k = this.skier;
    const speed = speedOf(k);
    let dirX = Math.sin(k.heading), dirZ = Math.cos(k.heading);
    if (speed > 3 && k.crashTimer <= 0) {
      // suit la trajectoire plutôt que les skis (plus confortable)
      dirX = THREE.MathUtils.lerp(dirX, k.vx / speed, 0.5);
      dirZ = THREE.MathUtils.lerp(dirZ, k.vz / speed, 0.5);
      const l = Math.hypot(dirX, dirZ);
      dirX /= l;
      dirZ /= l;
    }
    const want = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (this.firstPerson) {
      want.set(k.x + dirX * 0.3, k.y + 1.6, k.z + dirZ * 0.3);
      look.set(k.x + dirX * 20, this.env.height(k.x + dirX * 20, k.z + dirZ * 20) + 1.2, k.z + dirZ * 20);
    } else {
      const back = 7.5 + Math.min(4, speed * 0.08);
      want.set(k.x - dirX * back, k.y + 3.2, k.z - dirZ * back);
      const ground = this.env.height(want.x, want.z);
      want.y = Math.max(want.y, ground + 2.2);
      look.set(k.x + dirX * 6, k.y + 0.8, k.z + dirZ * 6);
    }
    const a = snap ? 1 : 1 - Math.exp(-dt * (this.firstPerson ? 18 : 6));
    if (snap) {
      this.camPos.copy(want);
      this.camLook.copy(look);
    } else {
      this.camPos.lerp(want, a);
      this.camLook.lerp(look, a);
    }
    const minY = this.env.height(this.camPos.x, this.camPos.z) + 1.2;
    if (this.camPos.y < minY) this.camPos.y = minY;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    const fov = 68 + Math.min(16, Math.max(0, speed * 3.6 - 40) * 0.25);
    if (Math.abs(this.camera.fov - fov) > 0.1) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 0.1);
      this.camera.updateProjectionMatrix();
    }
  }

  /** Remet le skieur sur la piste (bouton « je suis bloqué »). */
  unstuck() {
    respawnOnTrack(this.skier, this.env, this.skier.s);
  }

  get totalLength() {
    return this.track?.total ?? 0;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanup) c();
    if (this.renderer) {
      this.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}
