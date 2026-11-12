/**
 * Ski Simulator — rendu Three.js, monde ouvert autour de la piste choisie.
 * Réel : relief (MNT AWS Terrain Tiles), tracés des pistes et remontées (OSM), bâtiments (OSM).
 * Généré (et signalé comme tel) : forêt, jalons/panneaux, filets, autres skieurs, sièges.
 */
import * as THREE from 'three';
import type { Difficulty, Lift, LngLat, Piste } from '@/lib/types';
import { DemSampler } from '@/lib/dem';
import { LocalProjection, bboxOf, resample, smooth } from '@/lib/geo';
import { DIFF_COLOR, LIFT_LABEL } from '@/lib/estimates';
import { Track, SpatialHash, rng, fbm, valueNoise, type Pt } from './track';
import { createSkier, emptyInput, respawnOnTrack, speedOf, step, type Env, type GameEvent, type Input, type Skier } from './physics';
import { buildBuildingMesh, distToPolygonEdge, fetchBuildings, modelBuilding, pointInPolygon, type BuildingModel } from './buildings';
import { boardable, buildLiftPath, LiftRide, type LiftPath } from './lifts';
import { bannerTexture, dangerSignTexture, liftSignTexture, makePoles, makeSign, pisteSignTexture } from './signage';
import { Minimap, type MiniLine } from './minimap';

export interface Hud {
  phase: 'loading' | 'countdown' | 'running' | 'finished' | 'free';
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
  currentPiste: { name: string; difficulty: Difficulty } | null;
  liftPrompt: string | null;
  riding: { name: string; kind: string; progress: number; remainingS: number } | null;
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
const SUN_DIR = new THREE.Vector3(-180, 220, 140).normalize();

interface LocalPiste {
  piste: Piste;
  /** Tronçons en coordonnées locales, orientés vers l'aval. */
  segs: Pt[][];
  half: number;
}

export class SkiGame {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.3, 14000);
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  private raf = 0;
  private last = 0;
  private disposed = false;
  private hudTimer = 0;
  private cleanup: (() => void)[] = [];

  private proj!: LocalProjection;
  private near!: Grid;
  private far!: Grid;
  private track!: Track;
  private env!: Env;
  private trees = new SpatialHash(12);
  private nets = new SpatialHash(6);
  private corridor = new SpatialHash(25);
  private corridorPiste: number[] = [];
  private pistes: LocalPiste[] = [];
  private buildings: BuildingModel[] = [];
  private buildingHash = new SpatialHash(40);
  private halfWidth = 15;
  approximate = false;
  buildingsStatus: 'ok' | 'indisponibles' = 'ok';

  input: Input = emptyInput();
  private keyInput: Input = emptyInput();
  private boardKey = false;
  private skier!: Skier;
  private skierMesh!: THREE.Group;
  private skierParts!: { body: THREE.Object3D; skis: THREE.Object3D; lean: THREE.Object3D };
  private bots: { mesh: THREE.Group; s: number; lat: number; speed: number; phase: number; x: number; z: number }[] = [];
  private liftPaths: LiftPath[] = [];
  private liftAnims: { cabins: THREE.InstancedMesh; loop: THREE.Vector3[]; cum: number[]; total: number; count: number; speed: number; ground: boolean }[] = [];
  private ride: LiftRide | null = null;
  private seat!: THREE.Group;
  private cabin!: THREE.Mesh;
  private snow!: THREE.Points;
  private spray!: THREE.Points;
  private sprayVel!: Float32Array;
  private sprayLife!: Float32Array;
  private sprayCursor = 0;
  private firstPerson = false;
  private minimap: Minimap | null = null;
  private skyMesh!: THREE.Mesh;

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

  // ================================================================== construction
  async init() {
    const o = this.o;
    o.onLoading('Préparation du tracé GPS…');
    const line = o.piste.line;
    const [w, s, e, n] = bboxOf(line);
    this.proj = new LocalProjection([(w + e) / 2, (s + n) / 2]);
    let pts = smooth(resample(line.map((p) => this.proj.toLocal(p)), 4), 3);

    // Monde : piste + 1,3 km autour (relief détaillé), panorama sur 5 km
    const latM = 1 / 111_000, lonM = 1 / (111_000 * Math.cos((s * Math.PI) / 180));
    const nearMargin = 1300, farMargin = 5500;
    const nearBox: [number, number, number, number] = [w - nearMargin * lonM, s - nearMargin * latM, e + nearMargin * lonM, n + nearMargin * latM];
    const farBox: [number, number, number, number] = [w - farMargin * lonM, s - farMargin * latM, e + farMargin * lonM, n + farMargin * latM];
    const spanM = Math.max((nearBox[2] - nearBox[0]) / lonM, (nearBox[3] - nearBox[1]) / latM);
    const demNear = new DemSampler(spanM < 6000 ? 14 : 13);
    const demFar = new DemSampler(11);
    o.onLoading('Téléchargement du relief réel et des bâtiments OSM…');
    const buildingsP = fetchBuildings(nearBox).catch(() => null);
    const [okNear, okFar] = await Promise.all([demNear.preload(nearBox), demFar.preload(farBox)]);
    if (this.disposed) return;

    const h0 = demNear.sample(this.proj.toLngLat(pts[0].x, pts[0].z));
    const h1 = demNear.sample(this.proj.toLngLat(pts[pts.length - 1].x, pts[pts.length - 1].z));
    if (h0 != null && h1 != null && h0 < h1) pts.reverse();
    this.track = new Track(pts);
    this.halfWidth = (o.piste.widthM ?? PISTE_WIDTH[o.piste.difficulty]) / 2;

    o.onLoading('Reconstruction du terrain 3D…');
    this.approximate = !okNear;
    this.near = this.buildGrid(nearBox, 560, 7, (p) => demNear.sample(p));
    this.far = this.buildGrid(farBox, 220, 50, (p) => demFar.sample(p) ?? demNear.sample(p));
    if (!okNear) this.synthesizeTerrain(this.near);
    if (!okFar || !okNear) {
      if (!okFar) this.synthesizeTerrain(this.far);
      for (let i = 0; i < this.far.h.length; i++) {
        const x = this.far.minX + (i % this.far.nx) * this.far.cx, z = this.far.minZ + Math.floor(i / this.far.nx) * this.far.cz;
        const hn = gridHeight(this.near, x, z);
        if (hn != null) this.far.h[i] = hn;
      }
    }
    const nb = { minX: this.near.minX, minZ: this.near.minZ, maxX: this.near.minX + (this.near.nx - 1) * this.near.cx, maxZ: this.near.minZ + (this.near.nz - 1) * this.near.cz };

    this.env = {
      height: (x, z) => gridHeight(this.near, x, z) ?? gridHeight(this.far, x, z) ?? 0,
      track: this.track,
      halfWidth: this.halfWidth,
      collide: (x, z, above) => this.collide(x, z, above),
      onPiste: (x, z) => this.corridor.query(x, z, 0, this.tmp).length > 0,
      bounds: nb,
    };

    this.preparePistes(nb);

    o.onLoading('Construction des chalets et des remontées…');
    const osmBuildings = await buildingsP;
    if (this.disposed) return;
    if (osmBuildings) {
      for (const b of osmBuildings) {
        const fp = b.ring.map((p) => this.proj.toLocal(p));
        const m = modelBuilding(b.id, fp, b.tags, this.env.height);
        if (!m) continue;
        const id = this.buildingHash.insert(m.cx, m.cz, m.radius);
        this.buildings[id] = m;
      }
    } else this.buildingsStatus = 'indisponibles';

    this.setupRenderer();
    this.buildSky();
    this.buildTerrainMeshes();
    this.buildBuildings();
    this.buildLifts(nb);
    await new Promise((r) => setTimeout(r, 0));
    o.onLoading('Plantation de la forêt…');
    this.buildForest();
    this.buildSignage();
    this.buildSkier();
    this.buildBots();
    this.buildParticles();
    this.buildMinimap(nb);
    this.bindKeys();
    this.reset();
    this.last = performance.now();
    this.loop();
  }

  private preparePistes(nb: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    const inside = (p: Pt) => p.x > nb.minX && p.x < nb.maxX && p.z > nb.minZ && p.z < nb.maxZ;
    const list = this.o.nearbyPistes.some((p) => p.id === this.o.piste.id) ? this.o.nearbyPistes : [this.o.piste, ...this.o.nearbyPistes];
    for (const p of list) {
      const segs: Pt[][] = [];
      for (const seg of p.segments) {
        let loc = seg.map((q) => this.proj.toLocal(q));
        if (!loc.some(inside)) continue;
        if (this.env.height(loc[0].x, loc[0].z) < this.env.height(loc[loc.length - 1].x, loc[loc.length - 1].z)) loc = loc.reverse();
        segs.push(loc);
      }
      if (!segs.length) continue;
      const half = (p.widthM ?? PISTE_WIDTH[p.difficulty]) / 2;
      const idx = this.pistes.length;
      this.pistes.push({ piste: p, segs, half });
      for (const sgm of segs)
        for (const q of resample(sgm, 8)) {
          const id = this.corridor.insert(q.x, q.z, half);
          this.corridorPiste[id] = idx;
        }
    }
    // le tracé principal (lissé) fait toujours partie des pistes
    for (let i = 0; i < this.track.n; i += 2) {
      const id = this.corridor.insert(this.track.xs[i], this.track.zs[i], this.halfWidth);
      this.corridorPiste[id] = Math.max(0, this.pistes.findIndex((lp) => lp.piste.id === this.o.piste.id));
    }
  }

  /** Reconstruction approximative (signalée) si le MNT est indisponible. */
  private synthesizeTerrain(g: Grid) {
    const grade = this.o.piste.difficulty === 'noire' ? 0.42 : this.o.piste.difficulty === 'rouge' ? 0.3 : this.o.piste.difficulty === 'verte' ? 0.12 : 0.2;
    for (let iz = 0; iz < g.nz; iz++)
      for (let ix = 0; ix < g.nx; ix++) {
        const x = g.minX + ix * g.cx, z = g.minZ + iz * g.cz;
        const pr = this.track.nearestGlobal(x, z);
        g.h[iz * g.nx + ix] = 2000 - pr.s * grade + Math.pow(Math.max(0, pr.dist - this.halfWidth), 1.25) * 0.35 + fbm(x / 140, z / 140) * 8;
      }
  }

  private buildGrid(box: [number, number, number, number], maxCells: number, targetCell: number, sample: (p: LngLat) => number | null): Grid {
    const a = this.proj.toLocal([box[0], box[3]]);
    const b = this.proj.toLocal([box[2], box[1]]);
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

  // ================================================================== rendu : base
  private setupRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.08;
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

    this.scene.add(new THREE.HemisphereLight(0xd2e6f7, 0x5c6b7a, 0.95));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 1;
    sc.far = 700;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.5;
    this.scene.add(this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xd3e2ee, 900, 8500);
  }

  private buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2a66ad) },
        mid: { value: new THREE.Color(0x8fbde3) },
        bottom: { value: new THREE.Color(0xe3ecf4) },
        sunDir: { value: SUN_DIR },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vP;
        void main(){
          float h = vP.y;
          vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.55)) : bottom;
          c = mix(bottom, c, smoothstep(-0.02, 0.14, h));
          float sd = max(dot(normalize(vP), sunDir), 0.0);
          c += vec3(1.0, 0.92, 0.75) * (pow(sd, 900.0) * 3.0 + pow(sd, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(11000, 32, 16), mat);
    this.skyMesh.renderOrder = -1;
    this.scene.add(this.skyMesh);
  }

  private snowNormalMap(): THREE.Texture {
    const S = 256;
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        // bruit périodique (tuile sans raccord)
        const u = x / S, v = y / S;
        let val = 0;
        for (const [f, a] of [[8, 0.5], [16, 0.3], [32, 0.2]] as [number, number][]) {
          const nx = Math.cos(u * Math.PI * 2) * f / 6.28 + 10, ny = Math.sin(u * Math.PI * 2) * f / 6.28 + 10;
          const nz = Math.cos(v * Math.PI * 2) * f / 6.28 + 20, nw = Math.sin(v * Math.PI * 2) * f / 6.28 + 20;
          val += a * valueNoise(nx * 3 + nz, ny * 3 + nw);
        }
        h[y * S + x] = val;
      }
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)];
        const dy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
        const n = new THREE.Vector3(-dx * 6, -dy * 6, 1).normalize();
        const i = (y * S + x) * 4;
        img.data[i] = (n.x * 0.5 + 0.5) * 255;
        img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
        img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.channel = 1;
    return t;
  }

  private gridGeometry(g: Grid, lowerBy: number, colorFn: (x: number, z: number, h: number, slope: number) => THREE.Color, detailUv = false) {
    const n = g.nx * g.nz;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const uv1 = detailUv ? new Float32Array(n * 2) : null;
    const col = new Float32Array(n * 3);
    for (let iz = 0; iz < g.nz; iz++)
      for (let ix = 0; ix < g.nx; ix++) {
        const i = iz * g.nx + ix;
        const x = g.minX + ix * g.cx, z = g.minZ + iz * g.cz;
        pos[i * 3] = x;
        pos[i * 3 + 1] = g.h[i] - lowerBy;
        pos[i * 3 + 2] = z;
        uv[i * 2] = ix / (g.nx - 1);
        uv[i * 2 + 1] = 1 - iz / (g.nz - 1);
        if (uv1) {
          uv1[i * 2] = x / 7;
          uv1[i * 2 + 1] = z / 7;
        }
        const hx = g.h[Math.min(g.nx - 1, ix + 1) + iz * g.nx] - g.h[Math.max(0, ix - 1) + iz * g.nx];
        const hz = g.h[ix + Math.min(g.nz - 1, iz + 1) * g.nx] - g.h[ix + Math.max(0, iz - 1) * g.nx];
        const c = colorFn(x, z, g.h[i], Math.hypot(hx / (2 * g.cx), hz / (2 * g.cz)));
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
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
    if (uv1) geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    return geo;
  }

  private terrainColor = (x: number, z: number, _h: number, slope: number) => {
    const c = new THREE.Color(0xf4f8fc);
    const rockT = THREE.MathUtils.smoothstep(slope, 0.95, 1.5);
    return c.lerp(new THREE.Color(0x6e737a), rockT * (0.6 + fbm(x / 90, z / 90) * 0.4));
  };

  private farColor = (x: number, z: number, h: number, slope: number) => {
    const c = this.terrainColor(x, z, h, slope);
    const below = THREE.MathUtils.smoothstep(TREELINE + 60 - h, 0, 160);
    if (slope < 1.2) c.lerp(new THREE.Color(0x4b5e55), below * THREE.MathUtils.smoothstep(fbm(x / 400, z / 400), 0.35, 0.6) * 0.75);
    // zones bâties lointaines : légèrement plus sombres en vallée
    return c;
  };

  private buildTerrainMeshes() {
    const maxTex = this.renderer.capabilities.maxTextureSize;
    const S = Math.min(maxTex, window.innerWidth > 900 ? 4096 : 2048);
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
    for (let i = 0; i < S * 12; i++) {
      ctx.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '150,170,195'},${0.04 + r() * 0.07})`;
      ctx.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3);
    }
    const pxPerM = S / W;
    const drawLine = (pts: Pt[], width: number, style: string) => {
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
    // toutes les pistes : bord légèrement bleuté puis neige damée
    for (const lp of this.pistes) for (const sg of lp.segs) drawLine(sg, lp.half * 2 + 3, 'rgba(110,145,185,0.28)');
    for (const lp of this.pistes) for (const sg of lp.segs) drawLine(sg, lp.half * 2, 'rgba(252,254,255,0.97)');
    const main: Pt[] = [];
    for (let i = 0; i < this.track.n; i++) main.push({ x: this.track.xs[i], z: this.track.zs[i] });
    drawLine(main, this.halfWidth * 2, '#fbfdff');
    // stries de damage sur toutes les pistes
    for (const lp of this.pistes)
      for (const sg of lp.segs) {
        const rs = resample(sg, 6);
        for (let k = -5; k <= 5; k += 1) {
          const off = (k / 5) * (lp.half - 2);
          const pts = rs.map((p, i) => {
            const q = rs[Math.min(rs.length - 1, i + 1)], o = rs[Math.max(0, i - 1)];
            const dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1;
            return { x: p.x + (dz / l) * off, z: p.z - (dx / l) * off };
          });
          drawLine(pts, 0.3, 'rgba(165,185,212,0.16)');
        }
      }
    // traces de skis sur la piste principale
    for (let k = 0; k < 18; k++) {
      const amp = 2 + r() * (this.halfWidth - 4), ph = r() * 10, freq = 0.02 + r() * 0.03;
      const pts = main.map((p, i) => {
        const a = this.track.at(this.track.s[i]);
        const off = Math.sin(this.track.s[i] * freq + ph) * amp;
        return { x: p.x + a.tz * off, z: p.z - a.tx * off };
      });
      drawLine(pts, 0.25, 'rgba(140,160,190,0.24)');
    }
    // emprises bâties : sol tassé autour des chalets
    for (const b of this.buildings) {
      if (!b) continue;
      ctx.beginPath();
      b.footprint.forEach((p, i) => {
        const [a, c] = toPx(p.x, p.z);
        if (i) ctx.lineTo(a, c);
        else ctx.moveTo(a, c);
      });
      ctx.closePath();
      ctx.lineWidth = Math.max(1, 5 * pxPerM);
      ctx.strokeStyle = 'rgba(160,165,175,0.35)';
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const nearMesh = new THREE.Mesh(
      this.gridGeometry(this.near, 0, this.terrainColor, true),
      new THREE.MeshStandardMaterial({ map: tex, normalMap: this.snowNormalMap(), normalScale: new THREE.Vector2(0.35, 0.35), vertexColors: true, roughness: 0.88, metalness: 0 }),
    );
    nearMesh.receiveShadow = true;
    this.scene.add(nearMesh);
    const farMesh = new THREE.Mesh(this.gridGeometry(this.far, 2, this.farColor), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    this.scene.add(farMesh);
  }

  // ================================================================== bâtiments
  private buildBuildings() {
    const models = this.buildings.filter(Boolean);
    if (!models.length) return;
    const m = buildBuildingMesh(models);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
    // couleurs définies en sRGB : conversion en linéaire pour le rendu
    const c = new THREE.Color();
    const lin = new Float32Array(m.colors.length);
    for (let i = 0; i < m.colors.length; i += 3) {
      c.setRGB(m.colors[i], m.colors[i + 1], m.colors[i + 2], THREE.SRGBColorSpace);
      lin[i] = c.r;
      lin[i + 1] = c.g;
      lin[i + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(lin, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private collide(x: number, z: number, above: number): string | null {
    if (above < 7) {
      for (const id of this.trees.query(x, z, 0.9, this.tmp)) {
        if (Math.hypot(this.trees.xs[id] - x, this.trees.zs[id] - z) < 0.9 + this.trees.rs[id]) return 'Arbre !';
      }
    }
    if (above < 1.5 && this.nets.query(x, z, 0.7, this.tmp).length) return 'Filet de sécurité';
    for (const id of this.buildingHash.query(x, z, 1, this.tmp)) {
      const b = this.buildings[id];
      if (!b || above > b.eaves + 1) continue;
      if (pointInPolygon(x, z, b.footprint) || distToPolygonEdge(x, z, b.footprint) < 0.7) return 'Chalet !';
    }
    if (above < 1.5) for (const b of this.bots) if (Math.hypot(b.x - x, b.z - z) < 1.1) return 'Collision avec un skieur';
    for (const t of this.liftPaths)
      for (const tw of t.towers) if (Math.hypot(tw.x - x, tw.z - z) < 0.9 && above < t.towerH) return 'Pylône !';
    return null;
  }

  // ================================================================== forêt
  private buildForest() {
    const g = this.near;
    const r = rng(1234);
    const W = (g.nx - 1) * g.cx, D = (g.nz - 1) * g.cz;
    const target = Math.min(16000, Math.round(((W * D) / 1e6) * 1300));
    const pos: { x: number; z: number; y: number; s: number }[] = [];
    const avoid = new SpatialHash(20);
    for (const t of this.liftPaths) for (const q of resample(t.towers, 8)) avoid.insert(q.x, q.z, 9);
    let tries = 0;
    while (pos.length < target && tries < target * 8) {
      tries++;
      const x = g.minX + r() * W, z = g.minZ + r() * D;
      const h = this.env.height(x, z);
      const tl = TREELINE + (fbm(x / 300, z / 300) - 0.5) * 160;
      if (h > tl) continue;
      if (r() > THREE.MathUtils.smoothstep(fbm(x / 160, z / 160), 0.32, 0.62)) continue;
      const sl = Math.hypot(this.env.height(x + 2, z) - this.env.height(x - 2, z), this.env.height(x, z + 2) - this.env.height(x, z - 2)) / 4;
      if (sl > 1.1) continue;
      if (this.corridor.query(x, z, 5, this.tmp).length) continue;
      if (avoid.query(x, z, 0, this.tmp).length) continue;
      if (this.buildingHash.query(x, z, 6, this.tmp).length) continue;
      const scale = 0.7 + r() * 0.8 * (1 - THREE.MathUtils.smoothstep(h, tl - 150, tl));
      pos.push({ x, z, y: h, s: Math.max(0.45, scale) });
    }
    // épicéa : trois étages de branches enneigées
    const layers = [
      { r: 2.6, h: 4.5, y: 3.6 },
      { r: 2.0, h: 4.0, y: 6.4 },
      { r: 1.3, h: 3.4, y: 9.0 },
    ];
    const mFol = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const mSnow = new THREE.MeshStandardMaterial({ color: 0xe8eff5, roughness: 0.75, flatShading: true });
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.38, 3, 5);
    trunkGeo.translate(0, 1.5, 0);
    const meshes: THREE.InstancedMesh[] = [];
    for (const L of layers) {
      const fol = new THREE.ConeGeometry(L.r, L.h, 8);
      fol.translate(0, L.y, 0);
      const cap = new THREE.ConeGeometry(L.r * 0.8, L.h * 0.45, 8);
      cap.translate(0, L.y + L.h * 0.3, 0);
      meshes.push(new THREE.InstancedMesh(fol, mFol, pos.length), new THREE.InstancedMesh(cap, mSnow, pos.length));
    }
    meshes.push(new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 1 }), pos.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    pos.forEach((p, i) => {
      q.setFromAxisAngle(up, r() * Math.PI * 2);
      sv.set(p.s, p.s * (0.9 + r() * 0.3), p.s);
      pv.set(p.x, p.y - 0.3, p.z);
      m.compose(pv, q, sv);
      tint.setHSL(0.37 + r() * 0.05, 0.3 + r() * 0.15, 0.13 + r() * 0.07);
      meshes.forEach((im, k) => {
        im.setMatrixAt(i, m);
        if (k % 2 === 0 && k < 6) im.setColorAt(i, tint);
      });
      this.trees.insert(p.x, p.z, 0.45 * p.s);
    });
    for (const im of meshes) {
      im.castShadow = true;
      this.scene.add(im);
    }
  }

  // ================================================================== signalisation
  private buildSignage() {
    const poles: { x: number; y: number; z: number; d: Difficulty; right: boolean }[] = [];
    for (const lp of this.pistes) {
      for (const sg of lp.segs) {
        const rs = resample(sg, 30);
        for (let i = 0; i < rs.length; i++) {
          const q = rs[Math.min(rs.length - 1, i + 1)], o = rs[Math.max(0, i - 1)];
          const dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1;
          for (const side of [-1, 1]) {
            // gauche du sens de descente : (dz,-dx)
            const x = rs[i].x + (dz / l) * side * (lp.half + 0.5), z = rs[i].z - (dx / l) * side * (lp.half + 0.5);
            poles.push({ x, y: this.env.height(x, z), z, d: lp.piste.difficulty, right: side < 0 });
          }
        }
      }
      // panneau au départ de chaque piste nommée (sur le plus haut des tronçons)
      if (!lp.piste.named) continue;
      let start: Pt | null = null, best = -Infinity, next: Pt | null = null;
      for (const sg of lp.segs) {
        const h = this.env.height(sg[0].x, sg[0].z);
        if (h > best) {
          best = h;
          start = sg[0];
          next = sg[Math.min(sg.length - 1, 3)];
        }
      }
      if (!start || !next) continue;
      const dx = next.x - start.x, dz = next.z - start.z, l = Math.hypot(dx, dz) || 1;
      const sx = start.x + (dz / l) * (lp.half + 3), sz = start.z - (dx / l) * (lp.half + 3);
      const sign = makeSign(pisteSignTexture(lp.piste.name, lp.piste.difficulty), 2.4, 1.2, 1.6);
      sign.position.set(sx, this.env.height(sx, sz), sz);
      sign.rotation.y = Math.atan2(-dx, -dz); // face aux skieurs qui arrivent d'en haut
      this.scene.add(sign);
    }
    this.scene.add(makePoles(poles));

    // filets + panneaux danger sur l'extérieur des virages pentus de la piste principale
    const netSegs: { p: THREE.Vector3; yaw: number }[] = [];
    let lastDanger = -1e9;
    const danger = dangerSignTexture('DANGER');
    for (let s = 20; s < this.track.total - 20; s += 2.5) {
      const turn = this.track.turnAngle(s, 22);
      if (Math.abs(turn) < 0.55) continue;
      const a = this.track.at(s);
      const h1 = this.env.height(a.x, a.z), h2 = this.env.height(a.x + a.tx * 10, a.z + a.tz * 10);
      if ((h1 - h2) / 10 < 0.12) continue;
      const side = turn > 0 ? -1 : 1;
      const x = a.x + a.tz * side * (this.halfWidth + 1.5), z = a.z - a.tx * side * (this.halfWidth + 1.5);
      netSegs.push({ p: new THREE.Vector3(x, this.env.height(x, z), z), yaw: Math.atan2(a.tx, a.tz) });
      this.nets.insert(x, z, 1.4);
      if (s - lastDanger > 150) {
        lastDanger = s;
        const b = this.track.at(Math.max(0, s - 45));
        const dx2 = b.x + b.tz * side * (this.halfWidth + 2), dz2 = b.z - b.tx * side * (this.halfWidth + 2);
        const sg = makeSign(danger, 1.1, 1.1, 1.4);
        sg.position.set(dx2, this.env.height(dx2, dz2), dz2);
        sg.rotation.y = Math.atan2(-b.tx, -b.tz);
        this.scene.add(sg);
      }
    }
    if (netSegs.length) {
      const netGeo = new THREE.BoxGeometry(0.05, 1.3, 2.8);
      netGeo.translate(0, 0.75, 0);
      const iNet = new THREE.InstancedMesh(netGeo, new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.7 }), netSegs.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      netSegs.forEach((n, i) => iNet.setMatrixAt(i, m.compose(n.p, q.setFromAxisAngle(up, n.yaw), one)));
      iNet.castShadow = true;
      this.scene.add(iNet);
    }

    // arches départ / arrivée
    const arch = (s: number, text: string, color: string) => {
      const a = this.track.at(s);
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.5, 0.5), mat);
        leg.position.set(side * this.halfWidth * 0.8, 2.75, 0);
        leg.castShadow = true;
        g.add(leg);
      }
      const banner = new THREE.Mesh(new THREE.BoxGeometry(this.halfWidth * 1.6 + 0.5, 1.3, 0.3), [mat, mat, mat, mat, new THREE.MeshStandardMaterial({ map: bannerTexture(text, color) }), new THREE.MeshStandardMaterial({ map: bannerTexture(text, color) })]);
      banner.position.y = 5.5;
      banner.castShadow = true;
      g.add(banner);
      g.position.set(a.x, this.env.height(a.x, a.z), a.z);
      g.rotation.y = Math.atan2(a.tx, a.tz);
      this.scene.add(g);
    };
    arch(6, 'DÉPART', '#1f6bff');
    arch(this.track.total - 3, 'ARRIVÉE', '#dc2626');
  }

  // ================================================================== remontées
  private buildLifts(nb: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    const inside = (p: Pt) => p.x > nb.minX + 40 && p.x < nb.maxX - 40 && p.z > nb.minZ + 40 && p.z < nb.maxZ - 40;
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
    const cableMat = new THREE.LineBasicMaterial({ color: 0x1d2127 });
    const stationMat = new THREE.MeshStandardMaterial({ color: 0x5b6470, roughness: 0.7 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xeef3f8, roughness: 0.8 });
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x1d2127, roughness: 0.5, metalness: 0.3 });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0xd52b1e, roughness: 0.4 });
    for (const l of this.o.nearbyLifts) {
      const loc = l.line.map((p) => this.proj.toLocal(p));
      if (!inside(loc[0]) || !inside(loc[loc.length - 1])) continue;
      const path = buildLiftPath(l.id, l.name, l.kind, loc, this.env.height);
      if (!path) continue;
      this.liftPaths.push(path);

      // pylônes
      if (!path.ground)
        path.towers.slice(1, -1).forEach((t) => {
          const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, path.towerH, 6), pylonMat);
          pylon.position.set(t.x, t.y + path.towerH / 2, t.z);
          pylon.castShadow = true;
          const arm = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.35, 0.35), pylonMat);
          arm.position.y = path.towerH / 2;
          arm.rotation.y = Math.atan2(path.dir.x, path.dir.z);
          pylon.add(arm);
          this.scene.add(pylon);
        });
      else
        path.towers.forEach((t) => {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 5, 5), pylonMat);
          p.position.set(t.x + path.dir.z * 1.5, t.y + 2.5, t.z - path.dir.x * 1.5);
          this.scene.add(p);
        });

      // gares aval / amont
      for (const [st, isBottom] of [[path.bottom, true], [path.top, false]] as const) {
        const g = new THREE.Group();
        const big = !path.ground;
        const body = new THREE.Mesh(new THREE.BoxGeometry(big ? 9 : 3, big ? 4.5 : 2.6, big ? 7 : 3), stationMat);
        body.position.y = big ? 2.25 : 1.3;
        body.castShadow = true;
        body.receiveShadow = true;
        const roof = new THREE.Mesh(new THREE.BoxGeometry(big ? 10.5 : 3.6, 0.5, big ? 8.5 : 3.6), roofMat);
        roof.position.y = big ? 4.75 : 2.85;
        roof.castShadow = true;
        g.add(body, roof);
        const yaw = Math.atan2(path.dir.x, path.dir.z);
        const back = isBottom ? -1 : 1;
        g.position.set(st.x + path.dir.x * back * (big ? 6 : 2.5), this.env.height(st.x, st.z) - 0.3, st.z + path.dir.z * back * (big ? 6 : 2.5));
        g.rotation.y = yaw;
        this.scene.add(g);
        if (isBottom) {
          const sign = makeSign(liftSignTexture(l.name, LIFT_LABEL[l.kind]), 2.6, 1.3, 1.5);
          const sx = st.x - path.dir.z * 6 - path.dir.x * 4, sz = st.z + path.dir.x * 6 - path.dir.z * 4;
          sign.position.set(sx, this.env.height(sx, sz), sz);
          sign.rotation.y = yaw + Math.PI;
          this.scene.add(sign);
        }
      }

      // câbles (montée + descente) et véhicules animés
      const side = new THREE.Vector3(path.dir.z, 0, -path.dir.x).multiplyScalar(path.ground ? 1.5 : 2.4);
      const upPts = path.pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const cableUp = upPts.map((p, i) => p.clone().add(new THREE.Vector3(0, path.ground ? 2.2 : this.hangOf(path, i), 0)));
      const downPts = upPts.map((p) => p.clone().add(side.clone().multiplyScalar(2)));
      if (!path.ground || path.kind === 'teleski') {
        this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(cableUp), cableMat));
        this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(downPts.map((p, i) => p.clone().add(new THREE.Vector3(0, path.ground ? 2.2 : this.hangOf(path, i), 0)))), cableMat));
      }
      if (path.kind === 'tapis') continue;
      const loop = [...upPts, ...downPts.slice().reverse()];
      const cum = [0];
      for (let i = 1; i < loop.length; i++) cum.push(cum[i - 1] + loop[i].distanceTo(loop[i - 1]));
      const total = cum[cum.length - 1];
      const spacing = path.kind === 'telecabine' || path.kind === 'telemix' ? 60 : path.ground ? 22 : 30;
      const count = Math.min(220, Math.floor(total / spacing));
      let geo: THREE.BufferGeometry;
      let mat: THREE.Material = chairMat;
      if (path.ground) {
        geo = new THREE.BoxGeometry(0.1, 2.2, 0.1);
        geo.translate(0, 1.1, 0);
      } else if (path.kind === 'telecabine' || path.kind === 'telepherique') {
        geo = new THREE.BoxGeometry(2, 2.3, 2);
        geo.translate(0, 0.6, 0);
        mat = cabinMat;
      } else {
        geo = new THREE.BoxGeometry(2.6, 0.25, 0.9);
        geo.translate(0, 0.2, 0);
      }
      const cabins = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      cabins.castShadow = true;
      this.scene.add(cabins);
      this.liftAnims.push({ cabins, loop, cum, total, count, speed: path.speed, ground: path.ground });
    }

    // siège / cabine du joueur pendant la montée
    this.seat = new THREE.Group();
    const seatBase = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 0.7), chairMat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.1), chairMat);
    back.position.set(0, 0.45, -0.35);
    const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 4), chairMat);
    hanger.position.set(0.75, 1.3, -0.3);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 4), chairMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.9, 0.35);
    this.seat.add(seatBase, back, hanger, bar);
    this.seat.visible = false;
    this.scene.add(this.seat);
    this.cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 2.2), new THREE.MeshStandardMaterial({ color: 0xd52b1e, transparent: true, opacity: 0.35, roughness: 0.2 }));
    this.cabin.visible = false;
    this.scene.add(this.cabin);
  }

  /** Hauteur du câble au-dessus de la position du passager (câble > siège). */
  private hangOf(path: LiftPath, _i: number) {
    return path.kind === 'telepherique' ? 5 : path.kind === 'telecabine' ? 3.2 : path.kind === 'telemix' ? 3 : 2.6;
  }

  // ================================================================== personnages
  private makeSkierModel(jacket: number, pants: number) {
    const g = new THREE.Group();
    const lean = new THREE.Group();
    g.add(lean);
    const body = new THREE.Group();
    lean.add(body);
    const mJ = new THREE.MeshStandardMaterial({ color: jacket, roughness: 0.55 });
    const mP = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });
    const mH = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.3, metalness: 0.2 });
    const mS = new THREE.MeshStandardMaterial({ color: 0xf2c9a0, roughness: 0.8 });
    const mG = new THREE.MeshStandardMaterial({ color: 0xffa31a, roughness: 0.1, metalness: 0.6, emissive: 0x331a00 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    for (const sx of [-0.13, 0.13]) {
      add(new THREE.CapsuleGeometry(0.085, 0.62, 4, 8), mP, sx, 0.52, 0.05, body, -0.35);
      add(new THREE.BoxGeometry(0.16, 0.18, 0.3), mH, sx, 0.12, 0.08, body); // chaussures
    }
    add(new THREE.CapsuleGeometry(0.2, 0.38, 4, 10), mJ, 0, 1.17, -0.02, body, 0.35);
    add(new THREE.SphereGeometry(0.13, 14, 12), mS, 0, 1.6, 0.1, body);
    add(new THREE.SphereGeometry(0.15, 14, 12, 0, Math.PI * 2, 0, Math.PI / 1.8), mH, 0, 1.62, 0.1, body);
    add(new THREE.BoxGeometry(0.25, 0.08, 0.06), mG, 0, 1.6, 0.23, body);
    for (const sx of [-0.28, 0.28]) {
      add(new THREE.CapsuleGeometry(0.06, 0.42, 4, 8), mJ, sx, 1.1, 0.12, body, -0.9);
      add(new THREE.CylinderGeometry(0.012, 0.012, 1.2, 4), mH, sx * 1.2, 0.7, 0.05, body, 0.5);
    }
    const skis = new THREE.Group();
    const mSki = new THREE.MeshStandardMaterial({ color: jacket, roughness: 0.25, metalness: 0.3 });
    for (const sx of [-0.13, 0.13]) {
      add(new THREE.BoxGeometry(0.09, 0.03, 1.7), mSki, sx, 0.03, 0.12, skis);
      add(new THREE.BoxGeometry(0.09, 0.03, 0.18), mSki, sx, 0.07, 0.98, skis, -0.5); // spatule
    }
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
    const colors = [0xef4444, 0xf59e0b, 0x22c55e, 0xa855f7, 0xffffff, 0x06b6d4, 0xfacc15, 0xec4899];
    const n = Math.min(10, Math.max(3, Math.floor(this.track.total / 300)));
    for (let i = 0; i < n; i++) {
      const m = this.makeSkierModel(colors[i % colors.length], 0x2a2f36);
      this.scene.add(m.g);
      this.bots.push({ mesh: m.g, s: 80 + (i / n) * (this.track.total - 120), lat: (r() - 0.5) * this.halfWidth, speed: 6 + r() * 7, phase: r() * 10, x: 0, z: 0 });
    }
  }

  private buildParticles() {
    const N = 2500;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 120;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.snow = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.85, depthWrite: false }));
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);
    const M = 600;
    const sp = new Float32Array(M * 3).fill(-99999);
    this.sprayVel = new Float32Array(M * 3);
    this.sprayLife = new Float32Array(M);
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.spray = new THREE.Points(g2, new THREE.PointsMaterial({ color: 0xf5f9ff, size: 0.2, transparent: true, opacity: 0.9, depthWrite: false }));
    this.spray.frustumCulled = false;
    this.scene.add(this.spray);
  }

  private buildMinimap(nb: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    const lines: MiniLine[] = [];
    for (const lp of this.pistes) for (const sg of lp.segs) lines.push({ pts: sg, color: Minimap.pisteColor(lp.piste.difficulty), width: 2.5 });
    const main: Pt[] = [];
    for (let i = 0; i < this.track.n; i += 3) main.push({ x: this.track.xs[i], z: this.track.zs[i] });
    lines.push({ pts: main, color: '#1f6bff', width: 4 });
    for (const p of this.liftPaths) lines.push({ pts: [p.bottom, p.top], color: '#0f172a', width: 1.5, dash: true });
    try {
      this.minimap = new Minimap(nb, this.env.height, lines);
      this.o.container.appendChild(this.minimap.canvas);
    } catch {
      this.minimap = null;
    }
  }

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
      if (e.code === 'KeyE') this.boardKey = true;
      if (e.code === 'KeyM' && this.minimap) this.minimap.canvas.style.display = this.minimap.canvas.style.display === 'none' ? 'block' : 'none';
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

  // ================================================================== commandes publiques
  toggleCamera() {
    this.firstPerson = !this.firstPerson;
  }

  /** Demande d'embarquement (bouton tactile). */
  board() {
    this.boardKey = true;
  }

  /** Passe en mode libre (exploration, remontées). */
  startFree() {
    this.phase = 'free';
    this.env.freeRoam = true;
    this.flash('Mode libre : explorez et prenez les remontées (E)', 3);
  }

  reset() {
    this.skier = createSkier(this.track, this.env.height);
    this.ride = null;
    this.env.freeRoam = false;
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

  unstuck() {
    if (this.ride) return;
    if (this.phase === 'free') {
      // retour au point de piste le plus proche
      const ids = this.corridor.query(this.skier.x, this.skier.z, 200, this.tmp);
      let bx = this.skier.x, bz = this.skier.z, bd = Infinity;
      for (const id of ids) {
        const d = Math.hypot(this.corridor.xs[id] - this.skier.x, this.corridor.zs[id] - this.skier.z);
        if (d < bd) {
          bd = d;
          bx = this.corridor.xs[id];
          bz = this.corridor.zs[id];
        }
      }
      Object.assign(this.skier, { x: bx, z: bz, y: this.env.height(bx, bz), vx: 0, vz: 0, vy: 0, grounded: true, crashTimer: 0 });
    } else respawnOnTrack(this.skier, this.env, this.skier.s);
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

  private currentPiste(): Hud['currentPiste'] {
    const ids = this.corridor.query(this.skier.x, this.skier.z, 0, this.tmp);
    if (!ids.length) return null;
    let best = ids[0], bd = Infinity;
    for (const id of ids) {
      const d = Math.hypot(this.corridor.xs[id] - this.skier.x, this.corridor.zs[id] - this.skier.z);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    const lp = this.pistes[this.corridorPiste[best]];
    return lp ? { name: lp.piste.named ? lp.piste.name : 'Piste sans nom', difficulty: lp.piste.difficulty } : null;
  }

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
    const wantBoard = this.boardKey;
    this.boardKey = false;
    let liftPrompt: string | null = null;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'running';
        this.flash('GO !', 1);
      }
    } else if (this.ride) {
      const boost = inp.jump ? 12 : 3;
      const done = this.ride.update(dt, boost);
      const p = this.ride.position();
      k.x = p.x;
      k.y = p.y;
      k.z = p.z;
      k.vx = k.vz = k.vy = 0;
      k.heading = Math.atan2(p.hx, p.hz);
      if (done) {
        const ex = this.ride.exit(this.env.height);
        Object.assign(k, { x: ex.x, z: ex.z, y: ex.y, heading: ex.heading, vx: Math.sin(ex.heading) * 2, vz: Math.cos(ex.heading) * 2, grounded: true, crashTimer: 0 });
        this.flash(`Arrivée ${this.ride.path.name} — bonne descente !`, 2.2);
        this.ride = null;
      }
    } else if (this.phase === 'running' || this.phase === 'free') {
      const sub = Math.ceil(dt / (1 / 120));
      const h = dt / sub;
      for (let i = 0; i < sub; i++) step(k, inp, this.env, h, this.events);
      if (this.phase === 'running') this.time += dt;
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
        } else if (e.type === 'bounds' && this.messageTimer <= 0) {
          this.flash('Limite de la zone chargée', 1);
        }
      }
      this.events.length = 0;
      if (k.offPiste && k.grounded && this.messageTimer <= 0) this.flash('Hors piste : neige profonde', 0.8);
      if (this.phase === 'running' && k.s >= this.track.total - 8) this.finish();

      // remontées : en mode libre uniquement
      if (this.phase === 'free' && k.grounded && k.crashTimer <= 0) {
        const lift = boardable(this.liftPaths, k.x, k.z);
        if (lift) {
          liftPrompt = `E : monter — ${LIFT_LABEL[lift.kind]} ${lift.name}`;
          if (wantBoard) {
            if (sp > 8) this.flash('Ralentissez pour embarquer', 1);
            else {
              this.ride = new LiftRide(lift);
              this.flash(`${LIFT_LABEL[lift.kind]} ${lift.name} — maintenez Espace pour accélérer`, 2.5);
            }
          }
        } else if (wantBoard) this.flash('Approchez-vous d’une gare de départ', 1.2);
      }
    }

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message = null;
    }

    this.updateSkierMesh(dt);
    this.updateBots(dt);
    this.updateLifts();
    this.updateParticles(dt);
    this.placeCamera(false, dt);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.08;
      this.minimap?.draw(k.x, k.z, k.heading, this.bots.map((b) => ({ x: b.x, z: b.z })), this.liftPaths.map((p) => ({ x: p.bottom.x, z: p.bottom.z, label: '🚡' })));
      this.o.onHud({
        phase: this.phase,
        countdown: Math.ceil(this.countdown),
        time: this.time,
        speedKmh: this.ride ? 0 : speedOf(k) * 3.6,
        dist: k.s,
        remaining: Math.max(0, this.track.total - k.s),
        score: Math.round(this.score),
        tricks: this.tricks,
        airborne: !k.grounded,
        offPiste: k.offPiste,
        message: this.message,
        altitude: k.y,
        currentPiste: this.ride ? null : this.currentPiste(),
        liftPrompt,
        riding: this.ride
          ? { name: this.ride.path.name, kind: LIFT_LABEL[this.ride.path.kind], progress: this.ride.progress, remainingS: this.ride.remainingS(inp.jump ? 12 : 3) }
          : null,
      });
    }
  }

  private finish() {
    this.phase = 'finished';
    const avg = this.track.total / Math.max(1, this.time);
    this.score += Math.round(avg * 60);
    this.skier.vx *= 0.2;
    this.skier.vz *= 0.2;
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
    const e = 1.2;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const riding = !!this.ride;
    const hF = this.env.height(k.x + fx * e, k.z + fz * e) - this.env.height(k.x - fx * e, k.z - fz * e);
    const pitch = k.grounded && !riding ? Math.atan2(-hF, 2 * e) : 0;
    g.rotation.set(0, 0, 0);
    g.rotateY(k.heading + (k.grounded || riding ? 0 : k.spin));
    g.rotateX(pitch);
    const speed = speedOf(k);
    const crash = k.crashTimer > 0;
    const seated = riding && !this.ride!.path.ground;
    const lerp = (a: number, b: number, t: number) => THREE.MathUtils.lerp(a, b, Math.min(1, dt * t));
    this.skierParts.lean.rotation.z = lerp(this.skierParts.lean.rotation.z, crash ? 1.3 : riding ? 0 : -k.turn * Math.min(0.6, 0.12 + speed / 40), 8);
    const tuck = (this.keyInput.tuck || this.input.tuck) && !riding;
    const brake = (this.keyInput.down || this.input.down) && !riding;
    this.skierParts.body.scale.y = lerp(this.skierParts.body.scale.y, seated ? 0.7 : tuck && k.grounded ? 0.72 : brake ? 0.88 : 0.95, 6);
    this.skierParts.body.rotation.x = lerp(this.skierParts.body.rotation.x, seated ? -0.35 : tuck ? 0.45 : 0.12, 6);
    this.skierParts.skis.position.y = seated ? 0.35 : 0;
    this.skierParts.skis.children.forEach((s, i) => {
      s.rotation.y = THREE.MathUtils.lerp(s.rotation.y, brake ? (i % 2 ? -0.25 : 0.25) : 0, Math.min(1, dt * 8));
    });
    g.visible = !this.firstPerson;

    // siège ou cabine
    const gondola = riding && (this.ride!.path.kind === 'telecabine' || this.ride!.path.kind === 'telepherique' || this.ride!.path.kind === 'telemix');
    this.seat.visible = seated && !gondola;
    this.cabin.visible = gondola;
    if (seated) {
      this.seat.position.set(k.x, k.y + 0.25, k.z);
      this.seat.rotation.set(0, k.heading, 0);
      this.cabin.position.set(k.x, k.y + 1.1, k.z);
      this.cabin.rotation.set(0, k.heading, 0);
    }

    if (k.grounded && !riding && speed > 5 && k.edgeLoss > 0.05) {
      const n = Math.ceil(k.edgeLoss * 10);
      for (let i = 0; i < n; i++) this.emitSpray(k.x, k.y + 0.1, k.z, -k.vx * 0.2 + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2.5, -k.vz * 0.2 + (Math.random() - 0.5) * 3);
    }
    this.sun.position.set(k.x + SUN_DIR.x * 300, k.y + SUN_DIR.y * 300, k.z + SUN_DIR.z * 300);
    this.sun.target.position.set(k.x, k.y, k.z);
    this.skyMesh.position.copy(this.camera.position);
  }

  private emitSpray(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const i = this.sprayCursor;
    this.sprayCursor = (i + 1) % this.sprayLife.length;
    const pos = this.spray.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(i, x, y, z);
    this.sprayVel[i * 3] = vx;
    this.sprayVel[i * 3 + 1] = vy;
    this.sprayVel[i * 3 + 2] = vz;
    this.sprayLife[i] = 0.8;
  }

  private updateBots(dt: number) {
    for (const b of this.bots) {
      b.s += b.speed * dt;
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

  private updateLifts() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const t = performance.now() / 1000;
    for (const l of this.liftAnims) {
      if (!l.count) continue;
      for (let i = 0; i < l.count; i++) {
        const d = (t * l.speed + (i * l.total) / l.count) % l.total;
        let lo = 0, hi = l.cum.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (l.cum[mid] <= d) lo = mid;
          else hi = mid;
        }
        const f = (d - l.cum[lo]) / Math.max(0.001, l.cum[hi] - l.cum[lo]);
        v.lerpVectors(l.loop[lo], l.loop[hi], f);
        const yaw = Math.atan2(l.loop[hi].x - l.loop[lo].x, l.loop[hi].z - l.loop[lo].z);
        l.cabins.setMatrixAt(i, m.compose(v, q.setFromAxisAngle(up, yaw), one));
      }
      l.cabins.instanceMatrix.needsUpdate = true;
    }
  }

  private updateParticles(dt: number) {
    const cam = this.camera.position;
    const p = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += 0.6 * dt;
      arr[i + 1] -= 1.4 * dt;
      arr[i] = cam.x + ((((arr[i] - cam.x + 60) % 120) + 120) % 120) - 60;
      arr[i + 1] = cam.y + ((((arr[i + 1] - cam.y + 30) % 60) + 60) % 60) - 30;
      arr[i + 2] = cam.z + ((((arr[i + 2] - cam.z + 60) % 120) + 120) % 120) - 60;
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
    if (!this.ride && speed > 3 && k.crashTimer <= 0) {
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
      look.set(k.x + dirX * 20, (this.ride ? k.y : this.env.height(k.x + dirX * 20, k.z + dirZ * 20)) + 1.2, k.z + dirZ * 20);
    } else if (this.ride) {
      // vue de trois-quarts arrière pendant la montée
      want.set(k.x - dirX * 8 + dirZ * 5, k.y + 3.5, k.z - dirZ * 8 - dirX * 5);
      look.set(k.x + dirX * 10, k.y + 1, k.z + dirZ * 10);
    } else {
      const back = 7.5 + Math.min(4, speed * 0.08);
      want.set(k.x - dirX * back, k.y + 3.2, k.z - dirZ * back);
      want.y = Math.max(want.y, this.env.height(want.x, want.z) + 2.2);
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

  get totalLength() {
    return this.track?.total ?? 0;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanup) c();
    this.minimap?.canvas.remove();
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

