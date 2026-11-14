/**
 * Ski Simulator — rendu Three.js, monde ouvert autour de la piste choisie.
 * Réel : relief (MNT AWS Terrain Tiles), tracés des pistes et remontées (OSM), bâtiments (OSM).
 * Généré (et signalé comme tel) : forêt, jalons/panneaux, filets, autres skieurs, sièges.
 */
import * as THREE from 'three';
import type { Difficulty, Lift, LngLat, Piste } from '@/lib/types';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadWorld, gridHeight, maskAt, insideWorld, type Grid, type World } from './world';
import { Terrain } from './terrain';
import { TreeField } from './trees';
import { createSunVis, type SunVis } from './sunvis';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { batchStatic } from './batch';
import { buildRunLine } from './runline';
import { SkierRig, type PoseParams } from './skierModel';
import { LocalProjection, resample, smooth } from '@/lib/geo';
import { DIFF_COLOR, LIFT_LABEL } from '@/lib/estimates';
import { Track, SpatialHash, rng, type Pt } from './track';
import { G, createSkier, emptyInput, respawnOnTrack, speedOf, step, type Env, type GameEvent, type Input, type Skier } from './physics';
import { buildBuildingMesh, distToPolygonEdge, modelBuilding, pointInPolygon, type BuildingModel } from './buildings';
import { Features, placeAlongTrack, placePark } from './features';
import { Combo, type Quality } from './tricks';
import { GhostPlayer, GhostRecorder, RewindBuffer, ghostKey } from './ghost';
import { SkiAudio } from './audio';
import { qualitySettings, type QualityLevel, type QualitySettings } from './quality';
import { setupPostFX, setupSky, type PostFX } from './postfx';
import { boardable, buildLiftPath, LiftRide, type LiftPath } from './lifts';
import { bannerSlot, bannerTexture, dangerSignTexture, liftSignTexture, makePoles, makeSign } from './signage';
import { resetAtlas, slot, slotPlane } from './atlas';
import { directionPost, liftStation, restaurant, snowGuns } from './infra';
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
  combo: { names: string[]; total: number; mult: number; window: number } | null;
  lastTrick: { id: number; name: string; points: number; quality: Quality } | null;
  charge: number;
  switchStance: boolean;
  grinding: boolean;
  rewinds: number;
  ghost: boolean;
  fps: number;
  renderScale: number;
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
  rewinds: number;
  /** Trajectoire sérialisée (fantôme) de cette descente. */
  ghost: string;
}

export interface GameOptions {
  container: HTMLElement;
  piste: Piste;
  nearbyPistes?: Piste[];
  nearbyLifts?: Lift[];
  onHud: (h: Hud) => void;
  onFinish: (r: GameResult) => void;
  onLoading: (msg: string, progress?: number) => void;
  /** Emplacements réels des snowparks (OSM). */
  parks?: LngLat[];
  quality?: QualityLevel;
  /** Restaurants et bars d'altitude (OSM) : enseigne au vrai nom + terrasse. */
  restaurants?: { name: string; coord: LngLat }[];
}

const PISTE_WIDTH: Record<Difficulty, number> = { verte: 30, bleue: 34, rouge: 30, noire: 26, freeride: 22, inconnue: 30 };

interface LocalPiste {
  piste: Piste;
  /** Tronçons en coordonnées locales, orientés vers l'aval. */
  segs: Pt[][];
  half: number;
}

/** Cabine de télécabine : coque rouge arrondie, bandeau vitré, toit, suspente et pince. */
function gondolaGeometry(scale: number): THREE.BufferGeometry {
  const col = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex);
    const g2 = g.index ? g.toNonIndexed() : g;
    const n = g2.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) (a[i * 3] = c.r), (a[i * 3 + 1] = c.g), (a[i * 3 + 2] = c.b);
    g2.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g2.deleteAttribute('uv');
    return g2;
  };
  const body = new RoundedBoxGeometry(1.9, 2.0, 1.9, 3, 0.38);
  body.translate(0, 0.2, 0);
  const glass = new RoundedBoxGeometry(1.96, 0.72, 1.96, 2, 0.3);
  glass.translate(0, 0.62, 0);
  const roof = new THREE.CylinderGeometry(0.75, 0.95, 0.22, 12);
  roof.translate(0, 1.28, 0);
  const hanger = new THREE.BoxGeometry(0.12, 1.5, 0.12);
  hanger.translate(0, 2.05, 0);
  const grip = new THREE.BoxGeometry(0.28, 0.25, 0.5);
  grip.translate(0, 2.8, 0);
  const g = mergeGeometries([col(body, 0xc8231b), col(glass, 0x1a2430), col(roof, 0xdfe5ea), col(hanger, 0x8e979f), col(grip, 0x2b3036)])!;
  g.scale(scale, scale, scale);
  g.translate(0, (scale > 1 ? 5 : 3.2) - 2.8 * scale, 0); // la pince sur le câble
  return g;
}

export class SkiGame {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.6, 40000);
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
  private world!: World;
  private terrain!: Terrain;
  private treeField!: TreeField;
  private sunVis!: SunVis;
  private sunDir = new THREE.Vector3(0.37, 0.5, 0.78).normalize();
  private nets = new SpatialHash(6);
  private corridor = new SpatialHash(25);
  private corridorPiste: number[] = [];
  private pistes: LocalPiste[] = [];
  private buildings: BuildingModel[] = [];
  private buildingHash = new SpatialHash(40);
  private halfWidth = 15;
  approximate = false;
  buildingsStatus: 'ok' | 'indisponibles' = 'ok';
  private q!: QualitySettings;
  private post!: PostFX;
  private features = new Features();
  private pylons: Pt[] = [];
  demSource = 'IGN RGE ALTI';
  private combo = new Combo();
  private lastTrick: Hud['lastTrick'] = null;
  private trickId = 0;
  private ghostRec = new GhostRecorder();
  private ghostPlayer: GhostPlayer | null = null;
  private ghostMesh: THREE.Group | null = null;
  private rewindBuf = new RewindBuffer<{ skier: Skier; score: number }>(8, 0.1);
  private rewindKey = false;
  private rewinds = 0;
  private audio = new SkiAudio();
  private timeScale = 1;
  private slowTimer = 0;
  private shake = 0;
  private prevJump = false;
  private grind: { id: number; t: number; dir: 1 | -1; v: number } | null = null;
  private sparkles: THREE.Points | null = null;
  private sparkleCol: Float32Array | null = null;
  private fpsEma = 60;
  private resTimer = 0;
  private pixelRatio = 1;

  input: Input = emptyInput();
  private keyInput: Input = emptyInput();
  private boardKey = false;
  private skier!: Skier;
  private skierMesh!: THREE.Group;
  private rig!: SkierRig;
  private pose: PoseParams = { crouch: 0.3, lean: 0, tuck: 0, grab: 0, brake: 0, sit: 0, plantL: 0, plantR: 0, armSwing: 0 };
  private plantTimer = 0;
  private plantSide = 0;
  private lastTurnSign = 0;
  private bots: { mesh: THREE.Group; rig: SkierRig; s: number; lat: number; speed: number; phase: number; x: number; z: number }[] = [];
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
  private camMode: 'poursuite' | 'proche' | 'cote' | 'subjective' = 'poursuite';
  private get firstPerson() {
    return this.camMode === 'subjective';
  }
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
    this.q = qualitySettings(o.quality ?? 'haute');
    resetAtlas();
    const world = await loadWorld((f, label) => o.onLoading(label, f));
    if (this.disposed) return;
    this.world = world;
    this.proj = world.proj;
    this.near = world.grid;
    this.far = world.far;
    this.sunDir.set(world.meta.sun.x, world.meta.sun.y, world.meta.sun.z).normalize();
    o.onLoading('Préparation de la descente…', 1);
    await new Promise((r) => setTimeout(r, 0));

    const line = o.piste.line;
    const hAt = (x: number, z: number) => gridHeight(this.near, x, z) ?? gridHeight(this.far, x, z) ?? 0;
    const wp = world.pistes.find((p) => p.id === o.piste.id) ?? world.pistes.find((p) => p.name === o.piste.name && p.difficulty === o.piste.difficulty && !!p.name);
    // plus longue descente continue à travers les tronçons (pas d'aller-retour)
    let run = buildRunLine((wp ?? o.piste).segments.map((sg) => sg.map((p) => this.proj.toLocal(p))), hAt);
    if (run.length < 2) run = line.map((p) => this.proj.toLocal(p));
    const pts = smooth(resample(run, 4), 3);
    if (hAt(pts[0].x, pts[0].z) < hAt(pts[pts.length - 1].x, pts[pts.length - 1].z)) pts.reverse();
    this.track = new Track(pts);
    this.halfWidth = Math.max(9, ((wp?.widthM ?? o.piste.widthM ?? PISTE_WIDTH[o.piste.difficulty]) / 2) * 0.9);
    this.approximate = !insideWorld(world, line[0]) || !insideWorld(world, line[line.length - 1]);
    const nb = { minX: this.near.minX, minZ: this.near.minZ, maxX: this.near.minX + (this.near.nx - 1) * this.near.cx, maxZ: this.near.minZ + (this.near.nz - 1) * this.near.cz };

    this.env = {
      height: (x, z) => hAt(x, z) + this.features.offset(x, z),
      track: this.track,
      halfWidth: this.halfWidth,
      collide: (x, z, above) => this.collide(x, z, above),
      onPiste: (x, z) => (maskAt(world, x, z) & 1) !== 0 || this.features.offset(x, z) > 0 || this.corridor.query(x, z, 0, this.tmp).some((id) => this.corridorPiste[id] === -1),
      bounds: { minX: nb.minX + 30, minZ: nb.minZ + 30, maxX: nb.maxX - 30, maxZ: nb.maxZ - 30 },
    };
    this.preparePistes(nb);

    // chalets réels (terrain déjà terrassé au pré-calcul)
    for (const b of world.buildings) {
      const fp = b.ring.map((p) => this.proj.toLocal(p));
      const m = modelBuilding(b.id, fp, b.tags, hAt);
      if (!m) continue;
      const id = this.buildingHash.insert(m.cx, m.cz, m.radius);
      this.buildings[id] = m;
    }
    this.pylons = world.pylons.map((p) => this.proj.toLocal(p));

    // modules freestyle : le long de la piste + snowparks réels
    const rand = rng(4242);
    placeAlongTrack(this.features, this.track, this.env.height, this.halfWidth, o.piste.difficulty, rand);
    for (const poi of world.pois.filter((p) => p.kind === 'snowpark')) {
      const l = this.proj.toLocal(poi.coord);
      if (l.x < nb.minX + 300 || l.x > nb.maxX - 300 || l.z < nb.minZ + 300 || l.z > nb.maxZ - 300) continue;
      const park = placePark(this.features, l.x, l.z, this.env.height, rand);
      this.parkStarts.push(park);
      for (let d = -10; d < 330; d += 8) {
        const id = this.corridor.insert(l.x + park.dx * d, l.z + park.dz * d, 14);
        this.corridorPiste[id] = -1;
      }
    }

    this.setupRenderer();
    this.buildSky();
    o.onLoading('Construction du relief et de la forêt…', 1);
    await new Promise((r) => setTimeout(r, 0));
    const lvl = this.q.level;
    this.terrain = new Terrain(world, {
      lodDist: lvl === 'ultra' ? 900 : lvl === 'haute' ? 650 : 420,
      treeRange: lvl === 'ultra' ? 1600 : lvl === 'haute' ? 1000 : 600,
      aniso: Math.min(lvl === 'basse' ? 2 : 8, this.renderer.capabilities.getMaxAnisotropy()),
    });
    this.scene.add(this.terrain.group);
    this.treeField = new TreeField(world, {
      highDist: lvl === 'ultra' ? 260 : lvl === 'haute' ? 170 : 100,
      lowDist: lvl === 'ultra' ? 1600 : lvl === 'haute' ? 1000 : 600,
      highCap: lvl === 'ultra' ? 30000 : lvl === 'haute' ? 16000 : 6000,
      lowCap: lvl === 'ultra' ? 160000 : lvl === 'haute' ? 90000 : 30000,
    });
    this.scene.add(this.treeField.group);
    this.sunVis = createSunVis(world);

    const before = new Set(this.scene.children);
    o.onLoading('Chalets, gares et remontées mécaniques…', 1);
    await new Promise((r) => setTimeout(r, 0));
    this.buildBuildings();
    this.buildRestaurants(nb);
    this.buildLifts(nb);
    this.buildFeatures();
    this.buildSignage();
    const statics = this.scene.children.filter((c) => !before.has(c));
    const b = batchStatic(this.scene, statics);
    this.buildSkier();
    this.buildBots();
    this.buildParticles();
    this.buildMinimap(nb);
    this.buildGhost();
    this.buildSparkles();
    this.sunVis.patchScene(this.scene);
    this.bindKeys();
    this.reset();
    this.terrain.update(this.camera.position, 1000);
    this.treeField.update(this.camera, 0, true);
    console.info('[pds3d] monde', world.meta.generated, '| pistes', this.pistes.length, '| bâtiments', this.buildings.filter(Boolean).length, '| remontées jouables', this.liftPaths.length, '| décor fusionné', b.before, '→', b.after, 'objets');
    this.last = performance.now();
    this.loop();
  }

  private parkStarts: { x: number; z: number; dx: number; dz: number }[] = [];

  private preparePistes(nb: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    const inside = (p: Pt) => p.x > nb.minX && p.x < nb.maxX && p.z > nb.minZ && p.z < nb.maxZ;
    const wl = this.world.pistes;
    const list = wl.some((p) => p.id === this.o.piste.id) ? wl : [this.o.piste, ...wl];
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

  // ================================================================== rendu : base
  private setupRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: !this.q.postfx, powerPreference: 'high-performance', stencil: false });
    r.setPixelRatio(this.q.pixelRatio);
    this.pixelRatio = this.q.pixelRatio;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.8;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.o.container.appendChild(r.domElement);
    r.domElement.style.display = 'block';
    this.renderer = r;
    r.setSize(this.o.container.clientWidth, this.o.container.clientHeight);
    this.post = setupPostFX(r, this.scene, this.camera, this.q);
    const resize = () => {
      const w = this.o.container.clientWidth, h = this.o.container.clientHeight;
      this.post.setSize(w, h);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    this.cleanup.push(() => window.removeEventListener('resize', resize));

    this.scene.add(new THREE.HemisphereLight(0xb9d3f2, 0x8e9db0, 1.25));
    this.sun.intensity = 3.1;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadowMap, this.q.shadowMap);
    const sc = this.sun.shadow.camera;
    const R = this.q.shadowRange;
    sc.left = -R;
    sc.right = R;
    sc.top = R;
    sc.bottom = -R;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.5;
    this.scene.add(this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xc4d6e8, 3500, 34000);
  }

  private buildSky() {
    this.skyMesh = setupSky(this.scene, this.renderer, this.sunDir);
    this.scene.environmentIntensity = 0.35;
  }

  // ================================================================== bâtiments
  private buildBuildings() {
    const cells = new Map<string, BuildingModel[]>();
    for (const m of this.buildings) {
      if (!m) continue;
      const k = `${Math.floor(m.cx / 1280)}:${Math.floor(m.cz / 1280)}`;
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(m);
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    const c = new THREE.Color();
    for (const models of cells.values()) {
      const m = buildBuildingMesh(models);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
      // couleurs définies en sRGB : conversion en linéaire pour le rendu
      const lin = new Float32Array(m.colors.length);
      for (let i = 0; i < m.colors.length; i += 3) {
        c.setRGB(m.colors[i], m.colors[i + 1], m.colors[i + 2], THREE.SRGBColorSpace);
        lin[i] = c.r;
        lin[i + 1] = c.g;
        lin[i + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(lin, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.dynamic = true; // déjà regroupé
      mesh.userData.cat = 'chalets';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
    }
  }

  private buildRestaurants(nb: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    for (const r of this.world.pois.filter((p) => (p.kind === 'restaurant' || p.kind === 'bar' || p.kind === 'hut') && p.name)) {
      const l = this.proj.toLocal(r.coord);
      if (l.x < nb.minX + 50 || l.x > nb.maxX - 50 || l.z < nb.minZ + 50 || l.z > nb.maxZ - 50) continue;
      // restaurants d'altitude uniquement (pas ceux des rues du village)
      if (this.buildingHash.query(l.x, l.z, 70, this.tmp).length > 6) continue;
      // direction de la montée (pour orienter l'enseigne vers les skieurs qui arrivent d'en haut)
      const e = 6;
      const gx = this.env.height(l.x + e, l.z) - this.env.height(l.x - e, l.z), gz = this.env.height(l.x, l.z + e) - this.env.height(l.x, l.z - e);
      const gl = Math.hypot(gx, gz) || 1;
      const ux = gx / gl, uz = gz / gl; // vers l'amont
      let cx = l.x, cz = l.z, rad = 0;
      for (const id of this.buildingHash.query(l.x, l.z, 30, this.tmp)) {
        const b = this.buildings[id];
        if (b) {
          cx = b.cx;
          cz = b.cz;
          rad = b.radius;
          break;
        }
      }
      // terrasse côté aval du bâtiment
      const tx = cx - ux * (rad + 4), tz = cz - uz * (rad + 4);
      if (this.corridor.query(tx, tz, 0, this.tmp).length) continue;
      this.scene.add(restaurant(r.name, tx, tz, Math.atan2(ux, uz), this.env.height));
      this.buildingHash.insert(tx, tz, 7); // pas d'arbres sur la terrasse
    }
  }

  private collide(x: number, z: number, above: number): string | null {
    if (above < 7 && this.treeField.hit(x, z, 0.45)) return 'Arbre !';
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

  // ================================================================== signalisation
  private buildSignage() {
    const poles: { x: number; y: number; z: number; d: Difficulty; right: boolean }[] = [];
    const starts: { p: Pt; next: Pt; lp: LocalPiste }[] = [];
    for (const lp of this.pistes) {
      for (const sg of lp.segs) {
        const rs = resample(sg, 30);
        for (let i = 0; i < rs.length; i++) {
          const q = rs[Math.min(rs.length - 1, i + 1)], o = rs[Math.max(0, i - 1)];
          const dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1;
          for (const side of [-1, 1]) {
            // gauche du sens de descente : (dz,-dx) ; le jalon se pose au bord réel de la piste damée
            let d = 4;
            while (d < 40 && maskAt(this.world, rs[i].x + (dz / l) * side * d, rs[i].z - (dx / l) * side * d) & 1) d += 1.5;
            if (d >= 40) d = lp.half;
            const x = rs[i].x + (dz / l) * side * (d + 0.3), z = rs[i].z - (dx / l) * side * (d + 0.3);
            if (this.treeField.hit(x, z, 0.6)) continue;
            poles.push({ x, y: this.env.height(x, z), z, d: lp.piste.difficulty, right: side < 0 });
          }
        }
      }
      // départ de la piste (point le plus haut de ses tronçons)
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
      if (start && next) starts.push({ p: start, next, lp });
    }
    // panneaux directionnels : un poteau par carrefour, une lame par piste qui part de là
    const used = new Set<number>();
    starts.forEach((a, i) => {
      if (used.has(i)) return;
      const group = starts.filter((b, j) => !used.has(j) && Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z) < 55);
      group.forEach((b) => used.add(starts.indexOf(b)));
      const names = new Map<string, Difficulty>();
      for (const b of group) names.set(b.lp.piste.name, b.lp.piste.difficulty);
      const dx = a.next.x - a.p.x, dz = a.next.z - a.p.z, l = Math.hypot(dx, dz) || 1;
      const sx = a.p.x + (dz / l) * (a.lp.half + 3), sz = a.p.z - (dx / l) * (a.lp.half + 3);
      const list = [...names].map(([name, d]) => ({ name, d }));
      this.scene.add(directionPost(list, sx, sz, Math.atan2(-dx, -dz), this.env.height));
    });

    // enneigeurs le long des pistes de basse et moyenne altitude (réseau de neige de culture)
    const guns: { x: number; y: number; z: number; yaw: number }[] = [];
    for (const lp of this.pistes)
      for (const sg of lp.segs) {
        const rs = resample(sg, 85);
        rs.forEach((p, i) => {
          if (this.env.height(p.x, p.z) > 1750) return;
          const q = rs[Math.min(rs.length - 1, i + 1)], o = rs[Math.max(0, i - 1)];
          const dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz) || 1;
          const side = i % 2 ? 1 : -1;
          const x = p.x + (dz / l) * side * (lp.half + 2.5), z = p.z - (dx / l) * side * (lp.half + 2.5);
          guns.push({ x, y: this.env.height(x, z), z, yaw: Math.atan2(-(dz / l) * side, (dx / l) * side) });
        });
      }
    this.scene.add(snowGuns(guns));
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
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.4, 0.35), mat);
        leg.position.set(side * this.halfWidth * 0.55, 2.2, 0);
        leg.castShadow = true;
        g.add(leg);
      }
      const banner = new THREE.Mesh(new THREE.BoxGeometry(this.halfWidth * 1.1 + 0.4, 0.8, 0.2), [mat, mat, mat, mat, new THREE.MeshStandardMaterial({ map: bannerTexture(text, color) }), new THREE.MeshStandardMaterial({ map: bannerTexture(text, color) })]);
      banner.position.y = 4.4;
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
    const gondolaMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0xd0262b, roughness: 0.8 });
    const M_WHITE = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.7 });
    for (const l of this.world.lifts) {
      const loc = l.line.map((p) => this.proj.toLocal(p));
      // remontées entièrement dans la zone : jouables ; les autres restent visibles (repères dans le paysage)
      const ridable = inside(loc[0]) && inside(loc[loc.length - 1]);

      const path = buildLiftPath(l.id, l.name, l.kind, loc, this.env.height, this.pylons);
      if (!path) continue;
      if (ridable) this.liftPaths.push(path);

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
          for (const sx of [-2.4, 2.4]) {
            const sheave = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 1.6), chairMat);
            sheave.position.set(sx, -0.35, 0);
            arm.add(sheave);
            // passerelle de maintenance sous les balanciers
            const deck = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 1.1), pylonMat);
            deck.position.set(sx, -0.9, 0);
            arm.add(deck);
          }
          // échelle le long du fût
          const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.45, path.towerH - 1, 0.06), chairMat);
          ladder.position.set(0, -0.5, 0.55);
          ladder.rotation.y = arm.rotation.y;
          pylon.add(ladder);
          // pylône sur une piste : matelas de protection (comme sur les domaines)
          if (maskAt(this.world, t.x, t.z) & 1) {
            const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 2.2, 12), padMat);
            pad.position.set(0, -path.towerH / 2 + 1.1, 0);
            const band = new THREE.Mesh(new THREE.CylinderGeometry(0.97, 0.97, 0.35, 12), M_WHITE);
            band.position.set(0, -path.towerH / 2 + 1.5, 0);
            pylon.add(pad, band);
          }
          this.scene.add(pylon);
        });
      else
        path.towers.forEach((t) => {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 5, 5), pylonMat);
          p.position.set(t.x + path.dir.z * 1.5, t.y + 2.5, t.z - path.dir.x * 1.5);
          this.scene.add(p);
        });

      // gares aval / amont (la gare OSM, si elle existe, remplace le bâtiment générique)
      for (const [st, isBottom] of [[path.bottom, true], [path.top, false]] as const) {
        const osmStation = this.buildingHash.query(st.x, st.z, 14, this.tmp).length > 0;
        this.scene.add(liftStation(path, isBottom, this.env.height, !osmStation));
        if (isBottom && ridable) {
          const yaw = Math.atan2(path.dir.x, path.dir.z);
          const sign = makeSign(liftSignTexture(l.name, LIFT_LABEL[l.kind]), 2.6, 1.3, 1.5);
          const sx = st.x - path.dir.z * 6 - path.dir.x * 4, sz = st.z + path.dir.x * 6 - path.dir.z * 4;
          sign.position.set(sx, this.env.height(sx, sz), sz);
          sign.rotation.y = yaw + Math.PI;
          this.scene.add(sign);
        }
      }

      // arrivée : poteau en bois avec flèches jaunes vers les villages (comme sur le domaine)
      if (ridable && !path.ground) this.scene.add(this.destinationPost(path));

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
        geo = gondolaGeometry(path.kind === 'telepherique' ? 1.8 : 1);
        mat = gondolaMat;
      } else {
        // siège de télésiège : assise, dossier, garde-corps et suspente
        const seatG = new THREE.BoxGeometry(2.6, 0.12, 0.6);
        seatG.translate(0, 0.1, 0.05);
        const backG = new THREE.BoxGeometry(2.6, 0.7, 0.08);
        backG.translate(0, 0.5, -0.25);
        const hang = new THREE.CylinderGeometry(0.04, 0.04, 2.5, 5);
        hang.translate(0, 1.6, -0.3);
        const bar = new THREE.CylinderGeometry(0.03, 0.03, 2.6, 5);
        bar.rotateZ(Math.PI / 2);
        bar.translate(0, 0.85, 0.45);
        geo = mergeGeometries([seatG.toNonIndexed(), backG.toNonIndexed(), hang.toNonIndexed(), bar.toNonIndexed()])!;
        geo.translate(0, -2.6, 0);
      }
      const cabins = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      cabins.castShadow = false;
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
    this.seat.traverse((o) => (o.userData.dynamic = true));
    this.scene.add(this.seat);
    this.cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 2.2), new THREE.MeshStandardMaterial({ color: 0xd52b1e, transparent: true, opacity: 0.35, roughness: 0.2 }));
    this.cabin.visible = false;
    this.cabin.userData.dynamic = true;
    this.scene.add(this.cabin);
  }

  /** Poteau de destinations (lames jaunes « LES GETS », « MORZINE »…) orientées vers chaque village. */
  private destinationPost(path: LiftPath): THREE.Group {
    const DEST: [string, LngLat][] = [
      ['LES GETS', [6.6697, 46.1586]],
      ['MORZINE', [6.7089, 46.1792]],
      ['LE PLÉNEY', [6.6926, 46.1696]],
      ['NYON', [6.7225, 46.1545]],
      ['CHAVANNES', [6.6496, 46.1531]],
      ['MONT-CHÉRY', [6.6313, 46.1608]],
    ];
    const st = path.top;
    const x = st.x - path.dir.z * 9 + path.dir.x * 10, z = st.z + path.dir.x * 9 + path.dir.z * 10;
    const g = new THREE.Group();
    g.position.set(x, this.env.height(x, z), z);
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.2, 8), wood);
    post.position.y = 1.6;
    g.add(post);
    const list = DEST.map(([name, ll]) => {
      const p = this.proj.toLocal(ll);
      return { name, dx: p.x - x, dz: p.z - z, d: Math.hypot(p.x - x, p.z - z) };
    })
      .filter((t) => t.d > 350)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    list.forEach((t, i) => {
      const sl = slot(512, 96, (c) => {
        c.fillStyle = '#f2c618';
        c.beginPath();
        c.moveTo(0, 6);
        c.lineTo(440, 6);
        c.lineTo(506, 48);
        c.lineTo(440, 90);
        c.lineTo(0, 90);
        c.closePath();
        c.fill();
        c.strokeStyle = '#2a2a2a';
        c.lineWidth = 5;
        c.stroke();
        c.fillStyle = '#1b1b1b';
        c.textBaseline = 'middle';
        c.font = '800 46px Inter, system-ui, sans-serif';
        c.fillText(t.name, 26, 50);
      });
      const blade = slotPlane(sl, 1.7, 0.32);
      // la flèche (vers +x du plan) pointe vers la destination
      const holder = new THREE.Group();
      holder.position.y = 2.85 - i * 0.4;
      holder.rotation.y = Math.atan2(-t.dz, t.dx);
      blade.position.x = 0.85;
      holder.add(blade);
      g.add(holder);
    });
    return g;
  }

  /** Hauteur du câble au-dessus de la position du passager (câble > siège). */
  private hangOf(path: LiftPath, _i: number) {
    return path.kind === 'telepherique' ? 5 : path.kind === 'telecabine' ? 3.2 : path.kind === 'telemix' ? 3 : 2.6;
  }

  // ================================================================== personnages
  private buildSkier() {
    this.rig = new SkierRig({ jacket: 0x1d5fd8, accent: 0xff7a1a, pants: 0xff6a1f, helmet: 0xffc21a, skis: 0x101318 });
    this.skierMesh = this.rig.root;
    this.scene.add(this.rig.root);
  }

  private buildBots() {
    const r = rng(99);
    const colors = [0xef4444, 0xf59e0b, 0x22c55e, 0xa855f7, 0xffffff, 0x06b6d4, 0xfacc15, 0xec4899];
    const n = Math.min(10, Math.max(3, Math.floor(this.track.total / 300)));
    for (let i = 0; i < n; i++) {
      const rig = new SkierRig({ jacket: colors[i % colors.length], accent: colors[(i + 3) % colors.length], pants: i % 2 ? 0x2a2f36 : 0x3b4252, helmet: i % 3 ? 0x111418 : 0xf8fafc, skis: colors[(i + 5) % colors.length] });
      this.scene.add(rig.root);
      this.bots.push({ mesh: rig.root, rig, s: 80 + (i / n) * (this.track.total - 120), lat: (r() - 0.5) * this.halfWidth, speed: 6 + r() * 7, phase: r() * 10, x: 0, z: 0 });
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
      this.audio.start();
      const k = map[e.code];
      if (k) {
        this.keyInput[k] = true;
        e.preventDefault();
      }
      if (e.repeat) return;
      if (e.code === 'KeyC') this.toggleCamera();
      if (e.code === 'KeyR') this.reset();
      if (e.code === 'KeyE') this.boardKey = true;
      if (e.code === 'KeyT' || e.code === 'Backspace') {
        this.rewindKey = true;
        e.preventDefault();
      }
      if (e.code === 'KeyM' && this.minimap) this.minimap.canvas.style.display = this.minimap.canvas.style.display === 'none' ? 'block' : 'none';
    };
    const up = (e: KeyboardEvent) => {
      const k = map[e.code];
      if (k) this.keyInput[k] = false;
    };
    const pointer = () => this.audio.start();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    this.o.container.addEventListener('pointerdown', pointer);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      this.o.container.removeEventListener('pointerdown', pointer);
    });
  }

  // ================================================================== commandes publiques
  toggleCamera() {
    const modes = ['poursuite', 'proche', 'cote', 'subjective'] as const;
    this.camMode = modes[(modes.indexOf(this.camMode) + 1) % modes.length];
    this.flash(`Caméra : ${this.camMode === 'cote' ? 'côté' : this.camMode}`, 1);
  }

  board() {
    this.boardKey = true;
  }

  rewind() {
    this.rewindKey = true;
  }

  setMuted(m: boolean) {
    this.audio.start();
    this.audio.setMuted(m);
  }

  startFree() {
    this.bankCombo();
    this.phase = 'free';
    this.env.freeRoam = true;
    if (this.ghostMesh) this.ghostMesh.visible = false;
    this.flash('Mode libre : remontées (E), snowparks, toutes les pistes', 3);
  }

  reset() {
    this.skier = createSkier(this.track, this.env.height);
    // ?at=<m> : départ en cours de piste (outil de vérification visuelle)
    const at = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('at') ?? 0) : 0;
    if (at > 0) respawnOnTrack(this.skier, this.env, Math.min(this.track.total - 20, at));
    this.ride = null;
    this.grind = null;
    this.env.freeRoam = false;
    this.phase = 'countdown';
    this.countdown = 3.2;
    this.time = 0;
    this.score = 0;
    this.tricks = 0;
    this.crashes = 0;
    this.rewinds = 0;
    this.maxSpeed = 0;
    this.message = null;
    this.lastTrick = null;
    this.events.length = 0;
    this.combo.reset();
    this.ghostRec.reset();
    this.rewindBuf.clear();
    this.timeScale = 1;
    this.slowTimer = 0;
    this.placeCamera(true);
  }

  unstuck() {
    if (this.ride) return;
    this.grind = null;
    if (this.phase === 'free') {
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
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05, raw);
    this.last = now;
    this.update(dt);
    this.post.render();
    this.adaptResolution(raw);
    this.perfTimer += raw;
    if (this.perfTimer > 5) {
      this.perfTimer = 0;
      const i = this.renderer.info.render;
      const cat: Record<string, [number, number]> = {};
      const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
      this.scene.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        if (m.frustumCulled && m.geometry.boundingSphere) {
          const sp = m.geometry.boundingSphere.clone().applyMatrix4(m.matrixWorld);
          if (!fr.intersectsSphere(sp)) return;
        }
        const k = (m.material as THREE.Material).type + (m.userData.cat ? ':' + m.userData.cat : '') + ((m as THREE.InstancedMesh).isInstancedMesh ? ':inst' : '');
        const g = m.geometry as THREE.InstancedBufferGeometry;
        const tri = ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * ((m as THREE.InstancedMesh).count ?? (g.isInstancedBufferGeometry ? g.instanceCount : 1));
        cat[k] = [(cat[k]?.[0] ?? 0) + 1, (cat[k]?.[1] ?? 0) + Math.round(tri)];
      });
      console.info('[pds3d] détail', JSON.stringify(cat));
      console.info('[pds3d] perf', Math.round(this.fpsEma), 'img/s | appels', i.calls, '| triangles', i.triangles, '| sapins', JSON.stringify(this.treeField.stats()), '| échelle', this.pixelRatio.toFixed(2));
    }
  };
  private perfTimer = 0;

  /** Résolution dynamique : vise 60 images/s en ajustant la définition du rendu. */
  private adaptResolution(raw: number) {
    if (raw <= 0 || raw > 0.5) return;
    this.fpsEma += (1 / raw - this.fpsEma) * 0.05;
    this.resTimer += raw;
    if (this.resTimer < 1.5) return;
    this.resTimer = 0;
    const max = this.q.pixelRatio, min = Math.min(max, 0.6);
    let next = this.pixelRatio;
    if (this.fpsEma < 50) next = Math.max(min, this.pixelRatio - 0.15);
    else if (this.fpsEma > 58) next = Math.min(max, this.pixelRatio + 0.1);
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.post.setSize(this.o.container.clientWidth, this.o.container.clientHeight);
    }
  }

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
    const idx = this.corridorPiste[best];
    if (idx === -1) return { name: 'Snowpark', difficulty: 'freeride' };
    const lp = this.pistes[idx];
    return lp ? { name: lp.piste.named ? lp.piste.name : 'Piste sans nom', difficulty: lp.piste.difficulty } : null;
  }

  private bankCombo() {
    if (!this.combo.active) return;
    const pts = this.combo.total;
    this.combo.reset();
    this.score += pts;
    this.flash(`Combo encaissé +${pts.toLocaleString('fr-FR')}`, 1.4);
    this.audio.bank();
  }

  // ------------------------------------------------------------------ grind
  private tryEnterRail(k: Skier) {
    if (this.grind || k.crashTimer > 0) return;
    const r = this.features.railNear(k.x, k.z);
    if (!r) return;
    const rail = this.features.rails[r.id];
    if (r.d > (rail.kind === 'box' ? 0.7 : 0.5)) return;
    const sp = Math.hypot(k.vx, k.vz);
    if (sp < 3) return;
    const along = (k.vx * r.ux + k.vz * r.uz) / sp;
    if (Math.abs(along) < 0.82) return;
    const fromAir = !k.grounded && k.vy <= 0.5 && Math.abs(k.y - r.y) < 0.7;
    const autoPop = k.grounded && ((r.t < 0.15 && along > 0) || (r.t > 0.85 && along < 0)) && k.y < r.y + 0.3;
    if (!fromAir && !autoPop) return;
    this.grind = { id: r.id, t: Math.max(0, Math.min(1, r.t)), dir: along > 0 ? 1 : -1, v: sp * Math.abs(along) };
    k.grounded = false;
    k.spin = 0;
    k.flip = 0;
    k.grabTime = 0;
    const name = (rail.kind === 'box' ? 'Boardslide' : '50-50') + (k.switchStance ? ' switch' : '');
    this.combo.add(name, 80);
    this.lastTrick = { id: ++this.trickId, name, points: 80, quality: 'Good' };
    this.audio.clack();
  }

  private updateGrind(dt: number, inp: Input) {
    const g = this.grind!;
    const k = this.skier;
    const rail = this.features.rails[g.id];
    const len = Math.hypot(rail.bx - rail.ax, rail.bz - rail.az) || 1;
    const ux = (rail.bx - rail.ax) / len, uz = (rail.bz - rail.az) / len;
    const drop = (rail.ya - rail.yb) / len; // > 0 si le rail descend de A vers B
    g.v = Math.max(0.8, g.v + (G * drop * g.dir - 0.7) * dt);
    g.t += (g.dir * g.v * dt) / len;
    this.combo.extend(28 * g.v * dt);
    const t = Math.max(0, Math.min(1, g.t));
    k.x = rail.ax + (rail.bx - rail.ax) * t;
    k.z = rail.az + (rail.bz - rail.az) * t;
    k.y = rail.ya + (rail.yb - rail.ya) * t;
    k.vx = ux * g.dir * g.v;
    k.vz = uz * g.dir * g.v;
    k.vy = 0;
    k.heading = Math.atan2(ux * g.dir, uz * g.dir) + (k.switchStance ? Math.PI : 0);
    k.airTime = 0;
    const popped = this.prevJump && !inp.jump;
    if (popped || g.t < 0 || g.t > 1) {
      k.vy = popped ? 4.8 : 1;
      k.grounded = false;
      this.grind = null;
    }
  }

  // ------------------------------------------------------------------ boucle
  private update(dtReal: number) {
    const inp: Input = {
      left: this.keyInput.left || this.input.left,
      right: this.keyInput.right || this.input.right,
      up: this.keyInput.up || this.input.up,
      down: this.keyInput.down || this.input.down,
      jump: this.keyInput.jump || this.input.jump,
      tuck: this.keyInput.tuck || this.input.tuck,
    };
    // ralenti après une grosse figure réussie
    if (this.slowTimer > 0) {
      this.slowTimer -= dtReal;
      this.timeScale = THREE.MathUtils.lerp(this.timeScale, this.slowTimer > 0 ? 0.35 : 1, 0.2);
    } else this.timeScale = THREE.MathUtils.lerp(this.timeScale, 1, 0.15);
    const dt = dtReal * this.timeScale;
    const k = this.skier;
    const wantBoard = this.boardKey;
    this.boardKey = false;
    let liftPrompt: string | null = null;

    // retour en arrière
    if (this.rewindKey) {
      this.rewindKey = false;
      if (!this.ride && (this.phase === 'running' || this.phase === 'free')) {
        const snap = this.rewindBuf.rewind(3);
        if (snap) {
          Object.assign(this.skier, snap.skier);
          this.score = snap.score;
          this.grind = null;
          this.combo.reset();
          this.rewinds++;
          this.flash('⏪ Retour en arrière', 1);
        }
      }
    }

    if (this.phase === 'countdown') {
      this.countdown -= dtReal;
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
        Object.assign(k, { x: ex.x, z: ex.z, y: ex.y, heading: ex.heading, vx: Math.sin(ex.heading) * 2, vz: Math.cos(ex.heading) * 2, grounded: true, crashTimer: 0, switchStance: false });
        this.flash(`Arrivée ${this.ride.path.name} — bonne descente !`, 2.2);
        this.ride = null;
      }
    } else if (this.phase === 'running' || this.phase === 'free') {
      if (this.grind) this.updateGrind(dt, inp);
      else {
        const sub = Math.ceil(dt / (1 / 120));
        const h = dt / sub;
        for (let i = 0; i < sub; i++) {
          step(k, inp, this.env, h, this.events);
          this.tryEnterRail(k);
          if (this.grind) break;
        }
      }
      if (this.phase === 'running') {
        this.time += dt;
        this.ghostRec.push(dt, k.x, k.y, k.z, k.heading);
      }
      this.rewindBuf.push(dt, () => ({ skier: { ...k }, score: this.score }));
      const sp = speedOf(k);
      this.maxSpeed = Math.max(this.maxSpeed, sp);
      if (k.grounded && !k.offPiste && k.crashTimer <= 0) this.score += sp * dt * 0.5;
      for (const e of this.events) {
        if (e.type === 'trick') {
          this.combo.add(e.name, e.points);
          this.tricks++;
          const q = e.quality ?? 'Good';
          this.lastTrick = { id: ++this.trickId, name: e.name, points: e.points, quality: q };
          this.audio.trick(q);
          if (q === 'Perfect' && e.points >= 900) this.slowTimer = 0.45;
        } else if (e.type === 'land') {
          this.audio.land(Math.min(1, Math.abs(k.groundVy) / 12));
          this.shake = Math.max(this.shake, Math.min(0.5, Math.abs(k.groundVy) / 30));
        } else if (e.type === 'crash') {
          const lost = this.combo.fail();
          this.score = Math.max(0, this.score - 250);
          this.crashes++;
          this.grind = null;
          this.flash(lost ? `💥 ${e.reason} — combo perdu (${lost})` : `💥 ${e.reason}`, 1.8);
          this.audio.crash();
          this.shake = 0.8;
        } else if (e.type === 'respawn') {
          this.score = Math.max(0, this.score - 200);
          this.flash('Retour sur la piste');
        } else if (e.type === 'bounds' && this.messageTimer <= 0) {
          this.flash('Limite de la zone chargée', 1);
        }
      }
      this.events.length = 0;
      const banked = this.combo.update(dt, k.grounded && !this.grind);
      if (banked) {
        this.score += banked;
        this.flash(`Combo encaissé +${banked.toLocaleString('fr-FR')}`, 1.4);
        this.audio.bank();
      }
      if (k.offPiste && k.grounded && this.messageTimer <= 0) this.flash('Hors piste : neige profonde', 0.8);
      if (this.phase === 'running' && k.s >= this.track.total - 8) this.finish();

      if (this.phase === 'free' && k.grounded && k.crashTimer <= 0) {
        const lift = boardable(this.liftPaths, k.x, k.z);
        if (lift) {
          liftPrompt = `E : monter — ${LIFT_LABEL[lift.kind]} ${lift.name}`;
          if (wantBoard) {
            if (sp > 8) this.flash('Ralentissez pour embarquer', 1);
            else {
              this.bankCombo();
              this.ride = new LiftRide(lift);
              this.flash(`${LIFT_LABEL[lift.kind]} ${lift.name} — maintenez Espace pour accélérer`, 2.5);
            }
          }
        } else if (wantBoard) this.flash('Approchez-vous d’une gare de départ', 1.2);
      }
    }
    this.prevJump = inp.jump;

    if (this.messageTimer > 0) {
      this.messageTimer -= dtReal;
      if (this.messageTimer <= 0) this.message = null;
    }

    this.updateSkierMesh(dtReal);
    this.updateGhost();
    this.updateBots(dt);
    this.updateLifts();
    this.updateParticles(dt);
    this.updateSparkles();
    this.placeCamera(false, dtReal);
    this.terrain.update(this.camera.position);
    this.treeField.update(this.camera, dtReal);
    const kmh = this.ride ? 0 : speedOf(k) * 3.6;
    this.post.setSpeed(kmh);
    this.audio.update(kmh, this.grind ? 0.9 : k.edgeLoss, !k.grounded && !this.grind, !!this.ride);

    this.hudTimer -= dtReal;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.minimap?.draw(k.x, k.z, k.heading, this.bots.map((b) => ({ x: b.x, z: b.z })), this.liftPaths.map((p) => ({ x: p.bottom.x, z: p.bottom.z, label: '🚡' })));
      this.o.onHud({
        phase: this.phase,
        countdown: Math.ceil(this.countdown),
        time: this.time,
        speedKmh: kmh,
        dist: k.s,
        remaining: Math.max(0, this.track.total - k.s),
        score: Math.round(this.score),
        tricks: this.tricks,
        airborne: !k.grounded && !this.grind,
        offPiste: k.offPiste,
        message: this.message,
        altitude: k.y,
        currentPiste: this.ride ? null : this.currentPiste(),
        liftPrompt,
        riding: this.ride ? { name: this.ride.path.name, kind: LIFT_LABEL[this.ride.path.kind], progress: this.ride.progress, remainingS: this.ride.remainingS(inp.jump ? 12 : 3) } : null,
        combo: this.combo.active ? { names: this.combo.names.slice(-5), total: this.combo.total, mult: this.combo.multiplier, window: this.combo.window } : null,
        lastTrick: this.lastTrick,
        charge: k.grounded ? k.charge : 0,
        switchStance: k.switchStance,
        grinding: !!this.grind,
        rewinds: this.rewinds,
        ghost: !!this.ghostPlayer && this.phase === 'running',
        fps: Math.round(this.fpsEma),
        renderScale: Math.round((this.pixelRatio / Math.max(0.01, this.q.pixelRatio)) * 100),
      });
    }
  }

  private finish() {
    this.bankCombo();
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
      rewinds: this.rewinds,
      ghost: this.ghostRec.serialize(),
    });
  }

  // ------------------------------------------------------------------ modules, fantôme, paillettes
  private buildFeatures() {
    const snow = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    for (const k of this.features.kickers) {
      const nu = 16, nv = 10;
      const u0 = -0.4, u1 = k.L + 1.5, vMax = k.W / 2 + 1.7;
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++) {
          const u = u0 + ((u1 - u0) * i) / nu, v = -vMax + (2 * vMax * j) / nv;
          const x = k.x + u * k.dx - v * k.dz, z = k.z + u * k.dz + v * k.dx;
          pos.push(x, this.env.height(x, z) + 0.05, z);
          const lip = u > k.L - 0.5 && u <= k.L + 0.05 && Math.abs(v) < k.W / 2;
          if (lip) col.push(0.15, 0.4, 1);
          else col.push(0.98, 0.99, 1);
        }
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      // l'enroulement doit regarder vers le haut
      const n = geo.getAttribute('normal');
      if (n.getY(Math.floor(n.count / 2)) < 0) {
        idx.reverse();
        geo.setIndex(idx);
        geo.computeVertexNormals();
      }
      const m = new THREE.Mesh(geo, snow);
      m.receiveShadow = true;
      m.castShadow = true;
      this.scene.add(m);
    }
    const railMat = new THREE.MeshStandardMaterial({ color: 0xc0c7d0, metalness: 0.9, roughness: 0.25 });
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.4 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x1d2127, roughness: 0.6 });
    for (const r of this.features.rails) {
      const a = new THREE.Vector3(r.ax, r.ya, r.az), b = new THREE.Vector3(r.bx, r.yb, r.bz);
      const len = a.distanceTo(b);
      const geo = r.kind === 'rail' ? new THREE.CylinderGeometry(0.05, 0.05, len, 10) : new THREE.BoxGeometry(0.55, len, 0.12);
      geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, r.kind === 'rail' ? railMat : boxMat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.position.y -= r.kind === 'rail' ? 0.05 : 0.06;
      m.lookAt(b.x, b.y - (r.kind === 'rail' ? 0.05 : 0.06), b.z);
      m.castShadow = true;
      this.scene.add(m);
      for (let t = 0.1; t <= 0.9; t += 0.4) {
        const x = r.ax + (r.bx - r.ax) * t, z = r.az + (r.bz - r.az) * t;
        const top = r.ya + (r.yb - r.ya) * t - 0.08, ground = this.env.height(x, z);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, Math.max(0.1, top - ground + 0.3), 6), postMat);
        post.position.set(x, (top + ground - 0.3) / 2, z);
        this.scene.add(post);
      }
    }
    for (const p of this.parkStarts) {
      const sign = makeSign(bannerSlot('SNOWPARK', '#7c3aed'), 3.2, 0.5, 2.2);
      const sx = p.x - p.dz * 9, sz = p.z + p.dx * 9;
      sign.position.set(sx, this.env.height(sx, sz), sz);
      sign.rotation.y = Math.atan2(-p.dx, -p.dz);
      this.scene.add(sign);
    }
  }

  private buildGhost() {
    try {
      this.ghostPlayer = GhostPlayer.parse(localStorage.getItem(ghostKey(this.o.piste.id)));
    } catch {
      this.ghostPlayer = null;
    }
    if (!this.ghostPlayer) return;
    const ghost = new SkierRig({ jacket: 0x9fd3ff, accent: 0x9fd3ff, pants: 0x9fd3ff, helmet: 0x9fd3ff, skis: 0x9fd3ff });
    ghost.override(new THREE.MeshStandardMaterial({ color: 0xbfe3ff, emissive: 0x3d8bff, emissiveIntensity: 0.6, transparent: true, opacity: 0.38, depthWrite: false }));
    this.ghostMesh = ghost.root;
    this.ghostMesh.visible = false;
    this.scene.add(this.ghostMesh);
  }

  private updateGhost() {
    if (!this.ghostMesh || !this.ghostPlayer) return;
    const p = this.phase === 'running' ? this.ghostPlayer.sample(this.time) : null;
    this.ghostMesh.visible = !!p;
    if (p) {
      this.ghostMesh.position.set(p.x, p.y, p.z);
      this.ghostMesh.rotation.set(0, p.heading, 0);
    }
  }

  private buildSparkles() {
    const N = this.q.sparkles;
    if (!N) return;
    const pos = new Float32Array(N * 3);
    this.sparkleCol = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.sparkleCol, 3));
    this.sparkles = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, toneMapped: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sparkles.frustumCulled = false;
    this.scene.add(this.sparkles);
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = -99999;
  }

  /** Paillettes de neige au soleil autour de la caméra (scintillement aléatoire). */
  private updateSparkles() {
    if (!this.sparkles || !this.sparkleCol) return;
    const p = this.sparkles.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    const c = this.sparkleCol;
    const cam = this.camera.position;
    const R = 38;
    for (let i = 0; i < a.length / 3; i++) {
      const dx = a[i * 3] - cam.x, dz = a[i * 3 + 2] - cam.z;
      if (dx * dx + dz * dz > R * R || a[i * 3 + 1] < -9999) {
        const ang = Math.random() * Math.PI * 2, rr = 3 + Math.sqrt(Math.random()) * (R - 3);
        const x = cam.x + Math.cos(ang) * rr, z = cam.z + Math.sin(ang) * rr;
        a[i * 3] = x;
        a[i * 3 + 1] = this.env.height(x, z) + 0.04;
        a[i * 3 + 2] = z;
        c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0;
      }
      if (Math.random() < 0.02) {
        const v = 2.5 + Math.random() * 6;
        c[i * 3] = v;
        c[i * 3 + 1] = v;
        c[i * 3 + 2] = v * 1.05;
      } else {
        c[i * 3] *= 0.82;
        c[i * 3 + 1] *= 0.82;
        c[i * 3 + 2] *= 0.82;
      }
    }
    p.needsUpdate = true;
    (this.sparkles.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateSkierMesh(dt: number) {
    const k = this.skier;
    const g = this.skierMesh;
    g.position.set(k.x, k.y, k.z);
    const e = 1.2;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const riding = !!this.ride;
    const air = !k.grounded && !riding && !this.grind;
    const hF = this.env.height(k.x + fx * e, k.z + fz * e) - this.env.height(k.x - fx * e, k.z - fz * e);
    const pitch = k.grounded && !riding ? Math.atan2(-hF, 2 * e) : 0;
    g.rotation.set(0, 0, 0);
    g.rotateY(k.heading + (air ? k.spin : 0));
    if (air && k.flip !== 0) {
      // rotation autour du centre du corps
      g.translateY(0.9);
      g.rotateX(k.flip);
      g.translateY(-0.9);
    } else g.rotateX(pitch);
    const speed = speedOf(k);
    const crash = k.crashTimer > 0;
    const seated = riding && !this.ride!.path.ground;
    const lerp = (a: number, b: number, t: number) => THREE.MathUtils.lerp(a, b, Math.min(1, dt * t));
    // inclinaison du corps dans le virage (plus marquée avec la vitesse)
    this.rig.lean.rotation.z = lerp(this.rig.lean.rotation.z, crash ? 1.3 : riding || this.grind ? 0 : -k.turn * Math.min(0.85, 0.15 + speed / 28), 9);
    const tuck = (this.keyInput.tuck || this.input.tuck) && !riding && k.grounded;
    const brake = (this.keyInput.down || this.input.down) && !riding && k.grounded;
    const grab = air && k.grabTime > 0;
    // planté de bâton à chaque changement de virage, côté intérieur
    const ts = Math.abs(k.turn) > 0.45 ? Math.sign(k.turn) : 0;
    if (ts && ts !== this.lastTurnSign && k.grounded && !riding) {
      this.plantSide = ts;
      this.plantTimer = 0.4;
    }
    if (ts) this.lastTurnSign = ts;
    this.plantTimer = Math.max(0, this.plantTimer - dt);
    const plant = Math.sin((1 - this.plantTimer / 0.4) * Math.PI) * (this.plantTimer > 0 ? 1 : 0);
    const P = this.pose;
    P.crouch = lerp(P.crouch, k.grounded ? 0.28 + k.charge * 0.6 + Math.abs(k.turn) * 0.15 + (this.grind ? 0.25 : 0) : air ? 0.55 : 0.3, 8);
    P.tuck = lerp(P.tuck, tuck ? 1 : 0, 7);
    P.grab = lerp(P.grab, grab ? 1 : 0, 10);
    P.brake = lerp(P.brake, brake ? 1 : 0, 8);
    P.sit = lerp(P.sit, seated ? 1 : 0, 6);
    P.lean = lerp(P.lean, riding ? 0 : k.turn, 8);
    P.plantL = this.plantSide > 0 ? plant : 0;
    P.plantR = this.plantSide < 0 ? plant : 0;
    P.armSwing = Math.sin(performance.now() / 600) * (speed > 2 ? 0.3 : 0);
    this.rig.pose(P);
    if (seated) g.position.y = k.y + 0.33 - this.rig.hipHeight;
    g.visible = !this.firstPerson;

    const gondola = riding && (this.ride!.path.kind === 'telecabine' || this.ride!.path.kind === 'telepherique' || this.ride!.path.kind === 'telemix');
    this.seat.visible = seated && !gondola;
    this.cabin.visible = gondola;
    if (seated) {
      this.seat.position.set(k.x, k.y + 0.25, k.z);
      this.seat.rotation.set(0, k.heading, 0);
      this.cabin.position.set(k.x, k.y + 1.1, k.z);
      this.cabin.rotation.set(0, k.heading, 0);
    }

    if ((k.grounded && !riding && speed > 5 && k.edgeLoss > 0.05) || (this.grind && Math.random() < 0.6)) {
      const n = this.grind ? 2 : Math.ceil(k.edgeLoss * 12);
      for (let i = 0; i < n; i++) this.emitSpray(k.x, k.y + 0.1, k.z, -k.vx * 0.2 + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2.5, -k.vz * 0.2 + (Math.random() - 0.5) * 3);
    }
    this.sun.position.set(k.x + this.sunDir.x * 300, k.y + this.sunDir.y * 300, k.z + this.sunDir.z * 300);
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
      // au-delà de 220 m, un skieur ne fait que quelques pixels : on ne le dessine pas
      const far = (b.x - this.camera.position.x) ** 2 + (b.z - this.camera.position.z) ** 2 > 220 * 220;
      b.mesh.visible = !far;
      if (far) continue;
      b.mesh.position.set(b.x, this.env.height(b.x, b.z), b.z);
      b.mesh.rotation.set(0, Math.atan2(a.tx, a.tz) + Math.cos(b.phase * 1.3) * 0.5, 0);
      const turn = -Math.cos(b.phase * 1.3);
      b.rig.lean.rotation.z = turn * 0.3;
      b.rig.pose({ crouch: 0.35 + Math.abs(turn) * 0.2, lean: -turn, tuck: 0, grab: 0, brake: 0, sit: 0, plantL: turn > 0.95 ? 1 : 0, plantR: turn < -0.95 ? 1 : 0, armSwing: 0 });
    }
  }

  private updateLifts() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const t = performance.now() / 1000;
    const cam = this.camera.position;
    for (const l of this.liftAnims) {
      if (!l.count) continue;
      const mid = l.loop[Math.floor(l.loop.length / 4)];
      if ((mid.x - cam.x) ** 2 + (mid.z - cam.z) ** 2 > 3500 ** 2) continue;
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
    } else if (this.camMode === 'proche') {
      want.set(k.x - dirX * 3.4, k.y + 1.7, k.z - dirZ * 3.4);
      want.y = Math.max(want.y, this.env.height(want.x, want.z) + 1.2);
      look.set(k.x + dirX * 4, k.y + 0.9, k.z + dirZ * 4);
    } else if (this.camMode === 'cote') {
      // travelling latéral façon retransmission TV
      want.set(k.x + dirZ * 5.5 - dirX * 1.5, k.y + 1.4, k.z - dirX * 5.5 - dirZ * 1.5);
      want.y = Math.max(want.y, this.env.height(want.x, want.z) + 1);
      look.set(k.x + dirX * 1.5, k.y + 0.9, k.z + dirZ * 1.5);
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
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 7);
    }
    this.camera.lookAt(this.camLook);
    if (!this.firstPerson && !this.ride) this.camera.rotateZ(-k.turn * 0.05 * Math.min(1, speed / 18));
    const near = this.firstPerson ? 0.15 : 0.6;
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
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
    this.audio.dispose();
    this.post?.dispose();
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
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
  }
}

