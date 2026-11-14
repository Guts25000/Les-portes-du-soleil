/**
 * Signalisation des pistes : jalons de couleur, panneaux de départ, panneaux de remontées,
 * panneaux de danger. Textures dessinées sur canvas.
 */
import * as THREE from 'three';
import { slot, slotPlane, type Slot } from './atlas';
import type { Difficulty } from '@/lib/types';
import { DIFF_COLOR, DIFF_LABEL } from '@/lib/estimates';

const PANEL_BG: Record<Difficulty, string> = {
  verte: '#16a34a',
  bleue: '#2563eb',
  rouge: '#dc2626',
  noire: '#111111',
  freeride: '#d97706',
  inconnue: '#52525b',
};

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 800) {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px Inter, system-ui, sans-serif`;
    s -= 2;
  } while (ctx.measureText(text).width > maxW && s > 14);
}

/** Panneau de départ de piste : nom + couleur, au format des panneaux français. */
export function pisteSignTexture(name: string, d: Difficulty): Slot {
  return slot(512, 256, (ctx) => {
    ctx.fillStyle = PANEL_BG[d];
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 12;
    ctx.strokeRect(10, 10, 492, 236);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, name.toUpperCase(), 460, 84);
    ctx.fillText(name.toUpperCase(), 256, 112);
    ctx.font = '600 34px Inter, system-ui, sans-serif';
    ctx.fillText(DIFF_LABEL[d].toUpperCase(), 256, 196);
  });
}

/** Panneau de remontée (fond blanc, pictogramme). */
export function liftSignTexture(name: string, kindLabel: string): Slot {
  return slot(512, 256, (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 512, 64);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 34px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`🚡 ${kindLabel.toUpperCase()}`, 256, 34);
    ctx.fillStyle = '#0f172a';
    fitText(ctx, name, 470, 64);
    ctx.fillText(name, 256, 140);
    ctx.font = '600 28px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#1f6bff';
    ctx.fillText('Touche E pour embarquer', 256, 212);
  });
}

export function dangerSignTexture(text: string): Slot {
  return slot(256, 256, (ctx) => {
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(128, 16);
    ctx.lineTo(244, 220);
    ctx.lineTo(12, 220);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#111';
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = '900 120px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 128, 140);
    ctx.font = '800 26px Inter, system-ui, sans-serif';
    ctx.fillText(text, 128, 246);
  });
}

export function bannerSlot(text: string, color = '#1f6bff'): Slot {
  return slot(1024, 128, (ctx) => drawBanner(ctx, text, color));
}

export function bannerTexture(text: string, color = '#1f6bff'): THREE.CanvasTexture {
  return canvasTexture(1024, 128, (ctx) => drawBanner(ctx, text, color));
}

function drawBanner(ctx: CanvasRenderingContext2D, text: string, color: string) {
  {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1024, 128);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 76px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 512, 68);
  }
}

const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.5, roughness: 0.5 });

/** Panneau sur poteau, lisible des deux côtés. */
export function makeSign(tex: Slot, width: number, height: number, poleH: number): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, poleH + height, 6), poleMat);
  pole.position.y = (poleH + height) / 2;
  pole.castShadow = true;
  g.add(pole);
  const front = slotPlane(tex, width, height);
  front.position.set(0, poleH + height / 2, 0.05);
  front.castShadow = true;
  g.add(front);
  return g;
}

/** Jalons de bord de piste pour un ensemble de pistes (une seule InstancedMesh). */
export function makePoles(
  poles: { x: number; y: number; z: number; d: Difficulty; right: boolean }[],
): THREE.Group {
  const g = new THREE.Group();
  if (!poles.length) return g;
  const geo = new THREE.CylinderGeometry(0.045, 0.05, 1.7, 5);
  geo.translate(0, 0.85, 0);
  const tipGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 5);
  tipGeo.translate(0, 1.55, 0);
  const body = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }), poles.length);
  const rightPoles = poles.filter((p) => p.right);
  const tips = new THREE.InstancedMesh(tipGeo, new THREE.MeshStandardMaterial({ color: 0xff7a00, emissive: 0x401800, roughness: 0.4 }), Math.max(1, rightPoles.length));
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  poles.forEach((p, i) => {
    body.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
    body.setColorAt(i, c.set(DIFF_COLOR[p.d] === '#111827' ? '#1a1a1a' : DIFF_COLOR[p.d]));
  });
  rightPoles.forEach((p, i) => tips.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  tips.count = rightPoles.length;
  body.castShadow = false;
  g.add(body, tips);
  return g;
}
