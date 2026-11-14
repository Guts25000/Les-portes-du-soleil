/**
 * Atlas de textures pour les panneaux (noms de pistes, remontées, restaurants) : toutes les
 * inscriptions partagent quelques grandes images, donc un seul matériau — les panneaux d'un
 * même secteur se dessinent en un seul appel au lieu d'un par panneau.
 */
import * as THREE from 'three';

const S = 2048;

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mat: THREE.MeshStandardMaterial;
  x: number;
  y: number;
  rowH: number;
}

export interface Slot {
  page: Page;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

let pages: Page[] = [];

export function resetAtlas() {
  pages = [];
}

function newPage(): Page {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, transparent: false, alphaTest: 0.5, side: THREE.DoubleSide });
  const p = { canvas, ctx, tex, mat, x: 0, y: 0, rowH: 0 };
  pages.push(p);
  return p;
}

/** Réserve un emplacement w×h px et y dessine (origine en haut à gauche de l'emplacement). */
export function slot(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): Slot {
  let p = pages[pages.length - 1] ?? newPage();
  if (p.x + w + 2 > S) {
    p.x = 0;
    p.y += p.rowH + 2;
    p.rowH = 0;
  }
  if (p.y + h > S) p = newPage();
  const x = p.x, y = p.y;
  p.ctx.save();
  p.ctx.translate(x, y);
  p.ctx.beginPath();
  p.ctx.rect(0, 0, w, h);
  p.ctx.clip();
  draw(p.ctx);
  p.ctx.restore();
  p.x += w + 2;
  p.rowH = Math.max(p.rowH, h);
  p.tex.needsUpdate = true;
  return { page: p, u0: (x + 0.5) / S, u1: (x + w - 0.5) / S, v0: 1 - (y + h - 0.5) / S, v1: 1 - (y + 0.5) / S };
}

/** Plan texturé par un emplacement de l'atlas. */
export function slotPlane(s: Slot, width: number, height: number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(width, height);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, s.u0 + uv.getX(i) * (s.u1 - s.u0), s.v0 + uv.getY(i) * (s.v1 - s.v0));
  return new THREE.Mesh(g, s.page.mat);
}
