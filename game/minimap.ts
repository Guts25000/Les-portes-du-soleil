/** Mini-carte 2D (nord en haut) dessinée sur un canvas superposé au jeu. */
import { DIFF_COLOR } from '@/lib/estimates';
import type { Difficulty } from '@/lib/types';
import type { Pt } from './track';

export interface MiniLine {
  pts: Pt[];
  color: string;
  width: number;
  dash?: boolean;
}

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private bg: HTMLCanvasElement;
  private size: number;
  private scale = 1;
  private cx = 0;
  private cz = 0;
  /** Rayon visible autour du joueur (m). */
  radius = 900;

  constructor(
    private bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    heightAt: (x: number, z: number) => number,
    lines: MiniLine[],
    size = 176,
  ) {
    const small = window.innerWidth < 768;
    if (small) size = 120;
    this.size = size;
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    Object.assign(this.canvas.style, {
      position: 'absolute',
      right: '12px',
      ...(small ? { top: '150px' } : { bottom: '96px' }),
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)',
      boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
      pointerEvents: 'none',
      zIndex: '5',
    } as Partial<CSSStyleDeclaration>);

    // fond : ombrage du relief + pistes + remontées, à 4 m/pixel max
    const W = bounds.maxX - bounds.minX, D = bounds.maxZ - bounds.minZ;
    this.scale = Math.min(1 / 4, 2048 / Math.max(W, D));
    this.bg = document.createElement('canvas');
    this.bg.width = Math.ceil(W * this.scale);
    this.bg.height = Math.ceil(D * this.scale);
    const ctx = this.bg.getContext('2d')!;
    const step = 4; // px
    for (let py = 0; py < this.bg.height; py += step)
      for (let px = 0; px < this.bg.width; px += step) {
        const x = bounds.minX + px / this.scale, z = bounds.minZ + py / this.scale;
        const e = 6 / this.scale;
        const dx = heightAt(x + e, z) - heightAt(x - e, z), dz = heightAt(x, z + e) - heightAt(x, z - e);
        const shade = Math.max(0, Math.min(1, 0.7 + (-dx - dz) / (4 * e)));
        const v = Math.round(150 + shade * 95);
        ctx.fillStyle = `rgb(${v - 12},${v - 4},${v + 6})`;
        ctx.fillRect(px, py, step, step);
      }
    for (const l of lines) {
      ctx.beginPath();
      l.pts.forEach((p, i) => {
        const X = (p.x - bounds.minX) * this.scale, Y = (p.z - bounds.minZ) * this.scale;
        if (i) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
      });
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width;
      ctx.setLineDash(l.dash ? [4, 3] : []);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  static pisteColor(d: Difficulty) {
    return d === 'noire' ? '#111' : DIFF_COLOR[d];
  }

  draw(x: number, z: number, heading: number, others: Pt[] = [], poi: { x: number; z: number; label: string }[] = []) {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = this.canvas.width / this.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = this.size;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#dfe7ee';
    ctx.fillRect(0, 0, S, S);
    const k = S / (2 * this.radius); // px écran par mètre
    const r = k / this.scale; // px écran par px fond
    this.cx = x;
    this.cz = z;
    const sx = (x - this.bounds.minX) * this.scale, sz = (z - this.bounds.minZ) * this.scale;
    ctx.drawImage(this.bg, S / 2 - sx * r, S / 2 - sz * r, this.bg.width * r, this.bg.height * r);
    const toScreen = (px: number, pz: number) => [S / 2 + (px - x) * k, S / 2 + (pz - z) * k];
    for (const o of others) {
      const [ox, oy] = toScreen(o.x, o.z);
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.arc(ox, oy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = '700 9px Inter, system-ui, sans-serif';
    for (const p of poi) {
      const [ox, oy] = toScreen(p.x, p.z);
      if (ox < 0 || oy < 0 || ox > S || oy > S) continue;
      ctx.fillStyle = '#0f172a';
      ctx.fillText(p.label, ox + 4, oy - 2);
    }
    // joueur
    ctx.translate(S / 2, S / 2);
    ctx.rotate(-heading + Math.PI);
    ctx.fillStyle = '#1f6bff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(15,23,42,0.75)';
    ctx.font = '800 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', S / 2, 12);
    ctx.textAlign = 'start';
  }
}
