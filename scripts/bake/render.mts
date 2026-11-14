/**
 * Étape 3 : textures et fichiers finaux du monde (public/world).
 * - albedo_i_j.jpg : couleur du sol (neige, pistes damées, routes, rochers, sous-bois…) à 2,5 m/px ;
 * - light_i_j.jpg  : éclairage pré-calculé (R ombre du relief, G ombre des arbres et bâtiments, B occlusion ambiante) ;
 * - aux.jpg / dir.jpg : couvert arboré, emprise des pistes, rochers ; sens de damage et routes (5 m/px) ;
 * - height.dat, far.dat, mask.dat, trees.dat, osm.dat (compressés gzip), meta.json.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { BBOX, CACHE, CELL, CENTER, HALF_D, HALF_W, NX, NZ, OUT, proj } from './def.mts';
import { loadSharp } from './def.mts';
import { boxBlur, fbm, mulberry, px, pz, rast, stampDisc, vnoise } from './raster.mts';

const sharp = await loadSharp();
const ST = `${CACHE}/stage`;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const load = (name: string) => {
  const b = fs.readFileSync(`${ST}/${name}.bin`);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
fs.mkdirSync(OUT, { recursive: true });

// soleil : azimut 160° (sud-sud-est), hauteur 37° — fin de matinée en mars
const AZ = (160 * Math.PI) / 180, EL = (37 * Math.PI) / 180;
const SUN = { x: Math.sin(AZ) * Math.cos(EL), y: Math.sin(EL), z: -Math.cos(AZ) * Math.cos(EL) };
const sh = Math.hypot(SUN.x, SUN.z), ux = SUN.x / sh, uz = SUN.z / sh, tanEl = SUN.y / sh;

const GW = NX + 1, GH = NZ + 1;
const H = load('H');
const R25 = rast(2.5), R5 = rast(5);
const dem = load('dem25');
const canopy = load('canopy25');
const pisteCov = load('pisteCov'), pisteEdge = load('pisteEdge'), pisteC = load('pisteC'), pisteS = load('pisteS');
const roadCov = load('roadCov'), bank = load('bank'), water = load('water'), rock = load('rock'), parking = load('parking');
const bld = load('bld'), apron = load('apron');
const treesRaw = load('trees');
const NT = treesRaw.length / 5;

// ------------------------------------------------------------------ relief lointain (AWS terrarium z12)
const FAR_X = 27000, FAR_Z = 26000, FAR_CELL = 100;
const FW = (2 * FAR_X) / FAR_CELL + 1, FH = (2 * FAR_Z) / FAR_CELL + 1;
const farTiles = new Map<string, Uint8Array>();
for (const f of fs.readdirSync(`${CACHE}/far`)) {
  const m = /^12_(\d+)_(\d+)\.png$/.exec(f);
  if (!m) continue;
  const { data } = await sharp(`${CACHE}/far/${f}`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  farTiles.set(`${m[1]}_${m[2]}`, data);
}
const awsAt = (lon: number, lat: number) => {
  const n = 2 ** 12 * 256;
  const X = ((lon + 180) / 360) * n - 0.5;
  const s = Math.sin((lat * Math.PI) / 180);
  const Y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - 0.5;
  const pix = (gx: number, gy: number) => {
    const t = farTiles.get(`${Math.floor(gx / 256)}_${Math.floor(gy / 256)}`);
    if (!t) return 1000;
    const q = ((gy & 255) * 256 + (gx & 255)) * 3;
    return t[q] * 256 + t[q + 1] + t[q + 2] / 256 - 32768;
  };
  const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
  return pix(x0, y0) * (1 - fx) * (1 - fy) + pix(x0 + 1, y0) * fx * (1 - fy) + pix(x0, y0 + 1) * (1 - fx) * fy + pix(x0 + 1, y0 + 1) * fx * fy;
};
const nearAt = (x: number, z: number) => {
  const fx = Math.min(NX - 1e-6, Math.max(0, (x + HALF_W) / CELL)), fz = Math.min(NZ - 1e-6, Math.max(0, (z + HALF_D) / CELL));
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * GW + i;
  return H[k] * (1 - tx) * (1 - tz) + H[k + 1] * tx * (1 - tz) + H[k + GW] * (1 - tx) * tz + H[k + GW + 1] * tx * tz;
};
const far = new Float32Array(FW * FH);
for (let j = 0; j < FH; j++)
  for (let i = 0; i < FW; i++) {
    const x = -FAR_X + i * FAR_CELL, z = -FAR_Z + j * FAR_CELL;
    const inside = Math.abs(x) <= HALF_W && Math.abs(z) <= HALF_D;
    const ll = proj.toLngLat(x, z);
    far[j * FW + i] = inside ? nearAt(x, z) : awsAt(ll[0], ll[1]);
  }
// raccord progressif : la bordure du secteur se fond dans le relief lointain
const farAt = (x: number, z: number) => {
  const fx = Math.min(FW - 1 - 1e-6, Math.max(0, (x + FAR_X) / FAR_CELL)), fz = Math.min(FH - 1 - 1e-6, Math.max(0, (z + FAR_Z) / FAR_CELL));
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * FW + i;
  return far[k] * (1 - tx) * (1 - tz) + far[k + 1] * tx * (1 - tz) + far[k + FW] * (1 - tx) * tz + far[k + FW + 1] * tx * tz;
};
const anyH = (x: number, z: number) => (Math.abs(x) < HALF_W && Math.abs(z) < HALF_D ? nearAt(x, z) : farAt(x, z));
let farMax = -Infinity;
for (const v of far) farMax = Math.max(farMax, v);
log('relief lointain', FW, 'x', FH, 'max', farMax.toFixed(0), 'm');

// ------------------------------------------------------------------ ombres du relief + occlusion (grille 5 m)
function terrainShadow(x: number, z: number, h0: number) {
  let vis = 1;
  for (let t = 4; t < 20000; t += Math.max(2.5, t * 0.035)) {
    const ry = h0 + t * tanEl;
    if (ry > farMax + 10) break;
    const d = (ry - anyH(x + ux * t, z + uz * t)) / t; // marge angulaire
    const v = d / 0.04 + 0.5;
    if (v < vis) {
      vis = v;
      if (vis <= 0) return 0;
    }
  }
  return Math.min(1, vis);
}
const DIRS = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
function terrainAO(x: number, z: number, h0: number) {
  let s = 0;
  for (const [dx, dz] of DIRS) {
    let hor = 0;
    for (const d of [6, 12, 24, 48, 96, 192, 400]) hor = Math.max(hor, (anyH(x + dx * d, z + dz * d) - h0) / d);
    s += 1 - Math.sin(Math.atan(hor));
  }
  return s / DIRS.length;
}
const tShadow = new Float32Array(R5.w * R5.h), tAO = new Float32Array(R5.w * R5.h);
for (let j = 0; j < R5.h; j++) {
  for (let i = 0; i < R5.w; i++) {
    const x = -HALF_W + (i + 0.5) * 5, z = -HALF_D + (j + 0.5) * 5, h0 = nearAt(x, z);
    tShadow[j * R5.w + i] = terrainShadow(x, z, h0 + 0.5);
    tAO[j * R5.w + i] = terrainAO(x, z, h0);
  }
  if (j % 300 === 0) log('ombres du relief', j, '/', R5.h);
}

// ------------------------------------------------------------------ hauteur des objets (sapins + bâtiments) à 2,5 m
const obj = new Float32Array(R25.w * R25.h);
const isTree = new Uint8Array(R25.w * R25.h);
for (let k = 0; k < NT; k++) {
  const x = treesRaw[k * 5], z = treesRaw[k * 5 + 1], s = treesRaw[k * 5 + 2];
  const top = 15.5 * s, rad = 2.9 * s;
  stampDisc(R25, x, z, rad, (i, d) => {
    const hgt = 2.2 * s + (top - 2.2 * s) * (1 - d / rad);
    if (hgt > obj[i]) obj[i] = hgt;
    isTree[i] = 1;
  });
}
for (let i = 0; i < obj.length; i++) if (bld[i] > obj[i]) (obj[i] = bld[i]), (isTree[i] = 0);
log('hauteurs des objets ok');
const oShadow = new Float32Array(R25.w * R25.h);
for (let j = 0; j < R25.h; j++)
  for (let i = 0; i < R25.w; i++) {
    const x = -HALF_W + (i + 0.5) * 2.5, z = -HALF_D + (j + 0.5) * 2.5;
    const k0 = j * R25.w + i;
    const h0 = dem[k0] + (obj[k0] > 0 && !isTree[k0] ? obj[k0] : 0.3);
    let tr = 1;
    for (let t = 1.8; t < 60; t += 1.25) {
      const qi = Math.round(px(R25, x + ux * t)), qj = Math.round(pz(R25, z + uz * t));
      if (qi < 0 || qj < 0 || qi >= R25.w || qj >= R25.h) break;
      const q = qj * R25.w + qi;
      if (!obj[q]) continue;
      const ry = h0 + t * tanEl;
      if (dem[q] + obj[q] > ry) {
        tr *= isTree[q] ? 0.62 : 0.0;
        if (tr < 0.03) break;
      }
    }
    oShadow[k0] = tr;
  }
log('ombres des arbres et bâtiments ok');
// occlusion de proximité (sous les houppiers, au pied des murs)
const occ = new Float32Array(R25.w * R25.h);
for (let i = 0; i < occ.length; i++) occ[i] = obj[i] > 0 ? 1 : 0;
boxBlur(occ, R25.w, R25.h, 2);

// ------------------------------------------------------------------ albédo
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const canB = canopy.slice();
boxBlur(canB, R25.w, R25.h, 1);
const albedo = Buffer.alloc(R25.w * R25.h * 3);
const light = Buffer.alloc(R25.w * R25.h * 3);
const rnd = mulberry(77);
for (let j = 0; j < R25.h; j++)
  for (let i = 0; i < R25.w; i++) {
    const k = j * R25.w + i;
    const x = -HALF_W + (i + 0.5) * 2.5, z = -HALF_D + (j + 0.5) * 2.5;
    // pente locale
    const kx0 = Math.max(0, i - 1), kx1 = Math.min(R25.w - 1, i + 1), kz0 = Math.max(0, j - 1), kz1 = Math.min(R25.h - 1, j + 1);
    const gx = (dem[j * R25.w + kx1] - dem[j * R25.w + kx0]) / ((kx1 - kx0) * 2.5), gz = (dem[kz1 * R25.w + i] - dem[kz0 * R25.w + i]) / ((kz1 - kz0) * 2.5);
    const slope = Math.atan(Math.hypot(gx, gz)) * (180 / Math.PI);
    const n1 = fbm(x / 70, z / 70, 4), n2 = vnoise(x / 9, z / 9), n3 = rnd();
    // neige naturelle : légères variations (vent, lumière)
    let r = 236 + (n1 - 0.5) * 10 + (n2 - 0.5) * 4, g = 241 + (n1 - 0.5) * 8 + (n2 - 0.5) * 4, b = 248 + (n1 - 0.5) * 5;
    // sous-bois
    const c = canB[k];
    if (c > 0.02) {
      const t = Math.min(1, c * 1.1) * 0.75;
      r = lerp(r, 176, t);
      g = lerp(g, 186, t);
      b = lerp(b, 188, t);
      if (c > 0.25 && n3 < 0.12) (r -= 26), (g -= 22), (b -= 20); // aiguilles, branches tombées
    }
    // rochers : falaises OSM et pentes très raides, à peine saupoudrés
    const rk = Math.max(rock[k], sstep(36, 52, slope) * 0.9) * (1 - pisteCov[k]);
    if (rk > 0.02) {
      const snowy = sstep(0.35, 0.7, fbm(x / 6, z / 6, 3) + (1 - rk) * 0.4);
      const t = rk * (1 - snowy * 0.75);
      r = lerp(r, 112 + n2 * 22, t);
      g = lerp(g, 108 + n2 * 20, t);
      b = lerp(b, 104 + n2 * 18, t);
    }
    // eau
    if (water[k] === 1) (r = 226 + n2 * 6), (g = 235 + n2 * 5), (b = 244);
    else if (water[k] === 2) (r = 52), (g = 70), (b = 80);
    // parkings et abords des bâtiments
    if (parking[k]) {
      const snow = sstep(0.45, 0.65, n2);
      r = lerp(146, 238, snow);
      g = lerp(150, 241, snow);
      b = lerp(157, 246, snow);
    }
    if (apron[k] > 0) {
      const t = apron[k] * 0.35;
      r = lerp(r, 196, t);
      g = lerp(g, 200, t);
      b = lerp(b, 206, t);
    }
    // routes déneigées et congères
    if (bank[k] > 0) {
      const t = bank[k] * 0.9;
      r = lerp(r, 250, t);
      g = lerp(g, 252, t);
      b = lerp(b, 255, t);
    }
    if (roadCov[k] > 0) {
      const t = roadCov[k];
      r = lerp(r, 78 + n2 * 14, t);
      g = lerp(g, 82 + n2 * 14, t);
      b = lerp(b, 90 + n2 * 14, t);
    }
    // pistes damées (au-dessus de tout)
    const pc = pisteCov[k];
    if (pc > 0) {
      const e = pisteEdge[k];
      const gr = 247 + (n1 - 0.5) * 4, gg = 250 + (n1 - 0.5) * 3, gb = 253;
      r = lerp(r, lerp(gr, 233, e), pc);
      g = lerp(g, lerp(gg, 239, e), pc);
      b = lerp(b, lerp(gb, 248, e), pc);
    }
    albedo[k * 3] = Math.max(0, Math.min(255, r));
    albedo[k * 3 + 1] = Math.max(0, Math.min(255, g));
    albedo[k * 3 + 2] = Math.max(0, Math.min(255, b));
    // éclairage : interpolation des grilles 5 m
    const fx = Math.min(R5.w - 1.001, Math.max(0, (i + 0.5) / 2 - 0.5)), fz = Math.min(R5.h - 1.001, Math.max(0, (j + 0.5) / 2 - 0.5));
    const a = fx | 0, bb = fz | 0, tx = fx - a, tz = fz - bb, q = bb * R5.w + a;
    const bil = (A: Float32Array) => A[q] * (1 - tx) * (1 - tz) + A[q + 1] * tx * (1 - tz) + A[q + R5.w] * (1 - tx) * tz + A[q + R5.w + 1] * tx * tz;
    light[k * 3] = Math.round(bil(tShadow) * 255);
    light[k * 3 + 1] = Math.round(oShadow[k] * 255);
    light[k * 3 + 2] = Math.round(Math.min(1, bil(tAO)) * (1 - 0.42 * occ[k]) * (1 - 0.25 * apron[k]) * 255);
  }
log('albédo et éclairage ok');

const jpeg = (buf: Buffer, w: number, h: number, file: string, q = 88) =>
  sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: q, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(`${OUT}/${file}`);
const crop = (src: Buffer, W: number, x0: number, y0: number, w: number, h: number) => {
  const o = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) src.copy(o, y * w * 3, ((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + w) * 3);
  return o;
};
const TT = 2048;
const tiles: { i: number; j: number; w: number; h: number }[] = [];
for (let j = 0; j * TT < R25.h; j++)
  for (let i = 0; i * TT < R25.w; i++) {
    const w = Math.min(TT, R25.w - i * TT), h = Math.min(TT, R25.h - j * TT);
    tiles.push({ i, j, w, h });
    await jpeg(crop(albedo, R25.w, i * TT, j * TT, w, h), w, h, `albedo_${i}_${j}.jpg`, 86);
    await jpeg(crop(light, R25.w, i * TT, j * TT, w, h), w, h, `light_${i}_${j}.jpg`, 84);
  }
// aperçu réduit (contrôle visuel)
await sharp(albedo, { raw: { width: R25.w, height: R25.h, channels: 3 } }).resize(1600).jpeg({ quality: 80 }).toFile(`${CACHE}/preview-albedo.jpg`);
const shaded = Buffer.alloc(albedo.length);
for (let k = 0; k < R25.w * R25.h; k++) {
  const sv = (light[k * 3] / 255) * (light[k * 3 + 1] / 255), ao = light[k * 3 + 2] / 255;
  for (let c = 0; c < 3; c++) shaded[k * 3 + c] = Math.min(255, albedo[k * 3 + c] * (0.42 * ao + 0.62 * sv));
}
await sharp(shaded, { raw: { width: R25.w, height: R25.h, channels: 3 } }).resize(1600).jpeg({ quality: 80 }).toFile(`${CACHE}/preview-shaded.jpg`);
await sharp(crop(shaded, R25.w, 1800, 1500, 1000, 700), { raw: { width: 1000, height: 700, channels: 3 } }).jpeg({ quality: 85 }).toFile(`${CACHE}/preview-zoom.jpg`);
log('textures écrites');

// ------------------------------------------------------------------ aux (5 m) : couvert, piste, rocher | sens de damage, route
const aux = Buffer.alloc(R5.w * R5.h * 3), dir = Buffer.alloc(R5.w * R5.h * 3);
const mask = new Uint8Array(GW * GH);
for (let j = 0; j < R5.h; j++)
  for (let i = 0; i < R5.w; i++) {
    let cn = 0, pc = 0, rk = 0, cs = 0, sn = 0, rd = 0, best = -1;
    for (let dj = 0; dj < 2; dj++)
      for (let di = 0; di < 2; di++) {
        const k = (2 * j + dj) * R25.w + 2 * i + di;
        cn += canopy[k] / 4;
        rk = Math.max(rk, rock[k]);
        rd = Math.max(rd, roadCov[k]);
        if (pisteCov[k] > best) (best = pisteCov[k]), (cs = pisteC[k]), (sn = pisteS[k]);
        pc += pisteCov[k] / 4;
      }
    const q = (j * R5.w + i) * 3;
    aux[q] = Math.round(cn * 255);
    aux[q + 1] = Math.round(pc * 255);
    aux[q + 2] = Math.round(rk * 255);
    dir[q] = Math.round((cs * 0.5 + 0.5) * 255);
    dir[q + 1] = Math.round((sn * 0.5 + 0.5) * 255);
    dir[q + 2] = Math.round(rd * 255);
  }
await jpeg(aux, R5.w, R5.h, 'aux.jpg', 82);
await jpeg(dir, R5.w, R5.h, 'dir.jpg', 92);
// masque aux nœuds 5 m (physique : sur piste / route / eau / bâtiment)
const at25 = (A: Float32Array, x: number, z: number) => {
  const i = Math.min(R25.w - 1, Math.max(0, Math.round(px(R25, x)))), j = Math.min(R25.h - 1, Math.max(0, Math.round(pz(R25, z))));
  return A[j * R25.w + i];
};
for (let j = 0; j < GH; j++)
  for (let i = 0; i < GW; i++) {
    const x = -HALF_W + i * CELL, z = -HALF_D + j * CELL;
    mask[j * GW + i] = (at25(pisteCov, x, z) > 0.35 ? 1 : 0) | (at25(roadCov, x, z) > 0.5 ? 2 : 0) | (at25(water, x, z) > 0 ? 4 : 0) | (at25(bld, x, z) > 0 ? 8 : 0);
  }

// ------------------------------------------------------------------ lointain : albédo + éclairage cuits
const FT = 2048;
const farOrtho = new Map<string, { data: Buffer; w: number; h: number }>();
for (let j = 0; j < 4; j++)
  for (let i = 0; i < 4; i++) {
    const r = await sharp(`${CACHE}/far/ortho_${i}_${j}.jpg`).raw().toBuffer({ resolveWithObject: true });
    farOrtho.set(`${i}_${j}`, { data: r.data, w: r.info.width, h: r.info.height });
  }
const fw = BBOX.w - 0.3, fe = BBOX.e + 0.3, fs_ = BBOX.s - 0.21, fn = BBOX.n + 0.21;
const orthoAt = (lon: number, lat: number): [number, number, number] | null => {
  const u = ((lon - fw) / (fe - fw)) * 4, v = ((fn - lat) / (fn - fs_)) * 4;
  if (u < 0 || v < 0 || u >= 4 || v >= 4) return null;
  const t = farOrtho.get(`${Math.floor(u)}_${Math.floor(v)}`)!;
  const X = Math.min(t.w - 1, Math.floor((u % 1) * t.w)), Y = Math.min(t.h - 1, Math.floor((v % 1) * t.h));
  const q = (Y * t.w + X) * 3;
  return [t.data[q], t.data[q + 1], t.data[q + 2]];
};
const farAlb = Buffer.alloc(FT * FT * 3), farLight = Buffer.alloc(FT * FT * 3);
const fm = (2 * FAR_X) / FT, fmz = (2 * FAR_Z) / FT;
const fShadow = new Float32Array(FW * FH), fAO = new Float32Array(FW * FH);
for (let j = 0; j < FH; j++)
  for (let i = 0; i < FW; i++) {
    const x = -FAR_X + i * FAR_CELL, z = -FAR_Z + j * FAR_CELL, h0 = farAt(x, z);
    fShadow[j * FW + i] = terrainShadow(x, z, h0 + 2);
    let s = 0;
    for (const [dx, dz] of DIRS) {
      let hor = 0;
      for (const d of [150, 300, 600, 1200]) hor = Math.max(hor, (farAt(x + dx * d, z + dz * d) - h0) / d);
      s += 1 - Math.sin(Math.atan(hor));
    }
    fAO[j * FW + i] = s / DIRS.length;
  }
for (let j = 0; j < FT; j++)
  for (let i = 0; i < FT; i++) {
    const x = -FAR_X + (i + 0.5) * fm, z = -FAR_Z + (j + 0.5) * fmz;
    const h = farAt(x, z);
    const gx = (farAt(x + 30, z) - farAt(x - 30, z)) / 60, gz = (farAt(x, z + 30) - farAt(x, z - 30)) / 60;
    const slope = Math.atan(Math.hypot(gx, gz)) * (180 / Math.PI);
    const ll = proj.toLngLat(x, z);
    const o = orthoAt(ll[0], ll[1]);
    let forest: number;
    if (o && !(o[0] > 245 && o[1] > 245 && o[2] > 245)) {
      const lum = (o[0] + o[1] + o[2]) / 3;
      forest = sstep(95, 62, lum) * (o[1] >= o[0] - 6 ? 1 : 0.4);
    } else forest = sstep(0.45, 0.6, fbm(x / 400, z / 400)) * (1 - sstep(1650, 1900, h)) * (1 - sstep(35, 45, slope));
    forest *= 1 - sstep(1750, 2000, h);
    const n = fbm(x / 300, z / 300);
    let r = 236 + (n - 0.5) * 12, g = 241 + (n - 0.5) * 10, b = 248;
    const lowland = sstep(1000, 700, h) * 0.6;
    r = lerp(r, 150, lowland);
    g = lerp(g, 150, lowland);
    b = lerp(b, 140, lowland);
    r = lerp(r, 58, forest * 0.85);
    g = lerp(g, 74, forest * 0.85);
    b = lerp(b, 70, forest * 0.85);
    const rk = sstep(38, 55, slope) * 0.85;
    r = lerp(r, 120, rk);
    g = lerp(g, 116, rk);
    b = lerp(b, 112, rk);
    if (h < 375 && slope < 1) (r = 70), (g = 92), (b = 110); // Léman
    const q = (j * FT + i) * 3;
    farAlb[q] = r;
    farAlb[q + 1] = g;
    farAlb[q + 2] = b;
    const fx = Math.min(FW - 1.001, (x + FAR_X) / FAR_CELL), fz = Math.min(FH - 1.001, (z + FAR_Z) / FAR_CELL);
    const a = fx | 0, bb = fz | 0, tx = fx - a, tz = fz - bb, k = bb * FW + a;
    const bil = (A: Float32Array) => A[k] * (1 - tx) * (1 - tz) + A[k + 1] * tx * (1 - tz) + A[k + FW] * (1 - tx) * tz + A[k + FW + 1] * tx * tz;
    farLight[q] = Math.round(bil(fShadow) * 255);
    farLight[q + 1] = Math.round(255 * (1 - forest * 0.35));
    farLight[q + 2] = Math.round(Math.min(1, bil(fAO)) * 255);
  }
await jpeg(farAlb, FT, FT, 'far_albedo.jpg', 85);
await jpeg(farLight, FT, FT, 'far_light.jpg', 88);
log('lointain ok');

// ------------------------------------------------------------------ sapins : carrés de 320 m, positions au pas de 1,25 m
const CH = 320, CW = (2 * HALF_W) / CH, CDp = (2 * HALF_D) / CH;
const buckets: number[][] = Array.from({ length: CW * CDp }, () => []);
for (let k = 0; k < NT; k++) {
  const x = treesRaw[k * 5], z = treesRaw[k * 5 + 1];
  const ci = Math.min(CW - 1, Math.floor((x + HALF_W) / CH)), cj = Math.min(CDp - 1, Math.floor((z + HALF_D) / CH));
  buckets[cj * CW + ci].push(k);
}
const offsets = new Uint32Array(CW * CDp + 1);
const tb = Buffer.alloc(NT * 4);
let n = 0;
const rq = mulberry(5);
for (let c = 0; c < buckets.length; c++) {
  offsets[c] = n;
  const x0 = -HALF_W + (c % CW) * CH, z0 = -HALF_D + Math.floor(c / CW) * CH;
  for (const k of buckets[c]) {
    const x = treesRaw[k * 5], z = treesRaw[k * 5 + 1], s = treesRaw[k * 5 + 2];
    tb[n * 4] = Math.min(255, Math.max(0, Math.round((x - x0) / 1.25)));
    tb[n * 4 + 1] = Math.min(255, Math.max(0, Math.round((z - z0) / 1.25)));
    const sq = Math.min(15, Math.max(0, Math.round(((s - 0.6) / 1.5) * 15)));
    tb[n * 4 + 2] = (sq << 4) | Math.floor(rq() * 16);
    // ensoleillement au niveau du houppier
    const ti = Math.min(R5.w - 1, Math.max(0, Math.floor((x + HALF_W) / 5))), tj = Math.min(R5.h - 1, Math.max(0, Math.floor((z + HALF_D) / 5)));
    const ov = at25(oShadow, x, z);
    tb[n * 4 + 3] = Math.round(tShadow[tj * R5.w + ti] * (0.55 + 0.45 * ov) * 255);
    n++;
  }
}
offsets[buckets.length] = n;
const gz = (b: Buffer | Uint8Array) => zlib.gzipSync(b, { level: 9 });
fs.writeFileSync(`${OUT}/trees.dat`, gz(Buffer.concat([Buffer.from(offsets.buffer), tb])));

// ------------------------------------------------------------------ relief : deltas par ligne (compresse bien)
let hmin = Infinity;
for (const v of H) hmin = Math.min(hmin, v);
const hq = new Int16Array(GW * GH);
for (let j = 0; j < GH; j++) {
  let prev = 0;
  for (let i = 0; i < GW; i++) {
    const v = Math.round((H[j * GW + i] - hmin) * 10);
    hq[j * GW + i] = v - prev;
    prev = v;
  }
}
fs.writeFileSync(`${OUT}/height.dat`, gz(Buffer.from(hq.buffer)));
let fmin = Infinity;
for (const v of far) fmin = Math.min(fmin, v);
const fq = new Uint16Array(FW * FH);
for (let k = 0; k < far.length; k++) fq[k] = Math.round((far[k] - fmin) * 4);
fs.writeFileSync(`${OUT}/far.dat`, gz(Buffer.from(fq.buffer)));
fs.writeFileSync(`${OUT}/mask.dat`, gz(mask));
fs.writeFileSync(`${OUT}/osm.dat`, gz(fs.readFileSync(`${ST}/osm.json`)));

const meta = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  center: CENTER,
  bbox: [BBOX.w, BBOX.s, BBOX.e, BBOX.n],
  cell: CELL,
  nx: NX,
  nz: NZ,
  halfW: HALF_W,
  halfD: HALF_D,
  hmin,
  far: { halfX: FAR_X, halfZ: FAR_Z, cell: FAR_CELL, nx: FW, nz: FH, hmin: fmin },
  sun: SUN,
  texM: 2.5,
  tiles,
  tileSize: TT,
  trees: { count: NT, chunk: CH, cols: CW, rows: CDp, step: 1.25 },
  sources: {
    relief: 'IGN RGE ALTI® (Licence Ouverte Etalab 2.0) + AWS Terrain Tiles au loin',
    arbres: 'Orthophotographie IGN BD ORTHO® (Licence Ouverte Etalab 2.0) : chaque sapin est placé là où la photo aérienne montre un résineux',
    carto: '© OpenStreetMap contributors (ODbL)',
  },
};
const files: Record<string, number> = {};
for (const f of fs.readdirSync(OUT)) if (f !== 'meta.json') files[f] = fs.statSync(`${OUT}/${f}`).size;
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ ...meta, files }, null, 1));
for (const f of fs.readdirSync(OUT)) log(f, (fs.statSync(`${OUT}/${f}`).size / 1e6).toFixed(2), 'Mo');
