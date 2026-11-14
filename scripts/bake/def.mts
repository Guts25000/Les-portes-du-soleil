/** Définition fixe du monde « Pléney – Nyon – Les Gets » (partagée par toutes les étapes du pré-calcul). */
import { LocalProjection } from '../../lib/geo';

export const CENTER: [number, number] = [6.679, 46.158];
export const CELL = 5; // m, maille du relief
export const NX = 2048; // mailles est-ouest  -> 10,24 km
export const NZ = 1792; // mailles nord-sud    -> 8,96 km
export const HALF_W = (NX * CELL) / 2;
export const HALF_D = (NZ * CELL) / 2;
export const TEX_M = 2.5; // m par pixel des textures du sol
export const TEX_W = (NX * CELL) / TEX_M; // 4096
export const TEX_H = (NZ * CELL) / TEX_M; // 3584
export const TILE = 1280; // m, découpage des téléchargements
export const proj = new LocalProjection(CENTER);
/** Téléchargements et étapes intermédiaires (hors dépôt). */
export const CACHE = process.env.BAKE_CACHE ?? new URL('./.cache', import.meta.url).pathname;

/** sharp (décodage/encodage d'images) : `npm i -D sharp` avant de relancer le pré-calcul. */
export async function loadSharp() {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  for (const id of ['sharp', '/opt/npm-tools/node_modules/sharp']) {
    try {
      return req(id);
    } catch {
      /* suivant */
    }
  }
  throw new Error('sharp introuvable : npm i -D sharp');
}
export const OUT = new URL('../../public/world/', import.meta.url).pathname;

/** Emprise lon/lat d'un rectangle local (x vers l'est, z vers le sud). */
export function llBox(x0: number, z0: number, x1: number, z1: number) {
  const a = proj.toLngLat(x0, z1), b = proj.toLngLat(x1, z0);
  return { w: a[0], s: a[1], e: b[0], n: b[1] };
}
export const BBOX = llBox(-HALF_W, -HALF_D, HALF_W, HALF_D);

export async function pool<T>(jobs: (() => Promise<T>)[], n = 6): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}
