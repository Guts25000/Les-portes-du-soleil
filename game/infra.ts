/**
 * Infrastructures du domaine : gares de remontées (poulie, auvent, portiques, file d'attente),
 * restaurants d'altitude (enseigne au vrai nom OSM + terrasse), panneaux directionnels aux départs
 * de pistes, enneigeurs.
 */
import * as THREE from 'three';
import { slot, slotPlane } from './atlas';
import type { Difficulty } from '@/lib/types';
import { DIFF_COLOR } from '@/lib/estimates';
import type { LiftPath } from './lifts';

type H = (x: number, z: number) => number;


const M = {
  steel: new THREE.MeshStandardMaterial({ color: 0x8e979f, metalness: 0.7, roughness: 0.35 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23282e, metalness: 0.4, roughness: 0.5 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xa7a9a6, roughness: 0.9 }),
  roof: new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.75 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a5233, roughness: 0.85 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x4f3421, roughness: 0.9 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.6, side: THREE.DoubleSide }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 }),
  red: new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.6 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 }),
  canvas: new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.9 }),
  cladding: new THREE.MeshStandardMaterial({ color: 0x6f7984, metalness: 0.5, roughness: 0.45 }),
  shell: new THREE.MeshStandardMaterial({ color: 0xd9dee4, metalness: 0.5, roughness: 0.3 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8b8680, roughness: 0.95 }),
};

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Gare de remontée : socle, poteaux, auvent, grande poulie ; portiques et file d'attente en aval. */
export function liftStation(path: LiftPath, bottom: boolean, height: H, showBuilding: boolean): THREE.Group {
  const g = new THREE.Group();
  const st = bottom ? path.bottom : path.top;
  const ground = height(st.x, st.z);
  const yaw = Math.atan2(path.dir.x, path.dir.z);
  g.position.set(st.x, ground, st.z);
  g.rotation.y = yaw;
  if (path.ground) {
    // téléski : petite cabane de départ + poulie au sol
    if (bottom && showBuilding) {
      g.add(box(2.4, 2.4, 2.4, M.wood, 2.5, 1.2, -1));
      g.add(box(2.9, 0.25, 2.9, M.roof, 2.5, 2.5, -1));
    }
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.08, 6, 20), M.dark);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(0.75, 2.6, bottom ? -1 : 1);
    g.add(wheel, box(0.25, 2.6, 0.25, M.steel, 0.75, 1.3, bottom ? -1 : 1));
    return g;
  }
  const big = path.kind === 'telecabine' || path.kind === 'telepherique' || path.kind === 'telemix';
  const detach = !big && /express/i.test(path.name);
  const cableY = big ? 6.5 : 5.2;
  const back = bottom ? -1 : 1; // la gare s'étend au-delà du point d'embarquement / de débarquement
  const L = big ? 18 : detach ? 16 : 11;
  // enseigne au nom de la remontée sur la gare (repère visuel, comme sur place)
  const nameSign = () => {
    const sl = slot(512, 112, (c) => {
      c.fillStyle = '#20262d';
      c.fillRect(0, 0, 512, 112);
      c.fillStyle = '#ffffff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      let sz = 70;
      const t = path.name.toUpperCase();
      do {
        c.font = `800 ${sz}px Inter, system-ui, sans-serif`;
        sz -= 4;
      } while (c.measureText(t).width > 480 && sz > 20);
      c.fillText(t, 256, 60);
    });
    return slotPlane(sl, big ? 7 : 5, big ? 1.5 : 1.1);
  };
  if (big) {
    if (showBuilding) {
      // gare fermée (bardage métallique gris, toit enneigé), ouverte côté câble
      g.add(box(12, 0.3, L, M.concrete, 0, -0.05, back * (L / 2 + 1)));
      g.add(box(14, 8.5, 12, M.cladding, 0, 4.25, back * (L - 2)));
      g.add(box(15, 0.6, 13, M.roof, 0, 8.8, back * (L - 2)));
      g.add(box(10, 5.5, 0.2, M.dark, 0, 3.4, back * (L - 8.1)));
      for (const sx of [-6.6, 6.6]) g.add(box(0.15, 1.1, L - 4, M.red, sx, 0.55, back * (L / 2 - 1)));
    }
    // auvent au-dessus du quai (toujours : les gares OSM n'ont que leur emprise)
    for (const sx of [-5.5, 5.5]) for (const sz of [2, 9]) g.add(box(0.35, cableY + 2, 0.35, M.steel, sx, (cableY + 2) / 2, back * sz));
    g.add(box(13, 0.45, 11, M.cladding, 0, cableY + 2.2, back * 5.5));
    g.add(box(13.4, 0.35, 11.4, M.roof, 0, cableY + 2.6, back * 5.5));
    const sg = nameSign();
    sg.position.set(0, cableY + 2.2, back * (5.5 - 5.6 * back * back) + (bottom ? 0 : 0));
    sg.position.z = bottom ? 0.2 : -0.2;
    sg.rotation.y = bottom ? 0 : Math.PI;
    g.add(sg);
  } else if (detach) {
    // télésiège débrayable : carénage profilé au-dessus de la poulie, quai couvert
    const shell = new THREE.Mesh(new THREE.CapsuleGeometry(3.6, L - 6, 6, 16), M.shell);
    shell.rotation.x = Math.PI / 2;
    shell.scale.set(1.35, 1, 0.42);
    shell.position.set(0, cableY + 1.5, back * (L / 2 - 1));
    shell.castShadow = true;
    g.add(shell);
    const under = new THREE.Mesh(new THREE.CapsuleGeometry(3.4, L - 6, 6, 16), M.dark);
    under.rotation.x = Math.PI / 2;
    under.scale.set(1.3, 1, 0.12);
    under.position.set(0, cableY + 0.75, back * (L / 2 - 1));
    g.add(under);
    for (const sz of [3, L - 3]) g.add(box(0.9, cableY + 0.8, 1.2, M.cladding, 0, (cableY + 0.8) / 2, back * sz));
    if (showBuilding) {
      // garage des sièges (pierre et bois) à côté de la gare
      g.add(box(9, 4.2, 14, M.stone, 10.5, 2.1, back * (L - 3)));
      g.add(box(9.6, 0.5, 14.6, M.roof, 10.5, 4.6, back * (L - 3)));
      g.add(box(9.1, 1.6, 14.1, M.wood, 10.5, 3.3, back * (L - 3)));
    }
    const sg = nameSign();
    sg.position.set(0, cableY + 1.6, bottom ? 3.3 : -3.3);
    sg.rotation.y = bottom ? 0 : Math.PI;
    g.add(sg);
  } else if (showBuilding) {
    for (const sx of [-3.8, 3.8]) for (const sz of [1, L]) g.add(box(0.3, cableY + 0.7, 0.3, M.steel, sx, (cableY + 0.7) / 2, back * sz));
    g.add(box(9.5, 0.35, L + 1, M.roof, 0, cableY + 1.1, back * (L / 2 + 0.5)));
    // petite cabine du liftier
    g.add(box(2.4, 2.5, 2.4, M.wood, 6, 1.25, back * 4));
    g.add(box(3, 0.3, 3, M.roof, 6, 2.65, back * 4));
  }
  // poulie (bullwheel) au bout du câble : le repère visuel de toute gare de télésiège
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.16, 8, 32), M.dark);
  wheel.rotation.x = Math.PI / 2;
  wheel.position.set(0, cableY, back * 1.5);
  g.add(wheel);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.8, 12), M.yellow);
  hub.position.copy(wheel.position);
  g.add(hub);
  if (bottom) {
    // portiques d'accès (mains libres) et file d'attente balisée
    for (let i = -2; i <= 2; i++) {
      const gate = box(0.9, 1.1, 0.35, M.dark, -7, 0.55, -3 + i * 1.4);
      const top = box(0.6, 0.08, 0.36, M.yellow, -7, 1.12, -3 + i * 1.4);
      g.add(gate, top);
    }
    const net = new THREE.Mesh(new THREE.PlaneGeometry(14, 1), M.blue);
    for (const sz of [-6.5, 3.5]) {
      const n = net.clone();
      n.position.set(-14, 0.55, sz);
      g.add(n);
    }
  }
  return g;
}

/** Enseigne en bois au vrai nom du restaurant + terrasse avec parasols et transats. */
export function restaurant(name: string, x: number, z: number, faceYaw: number, height: H): THREE.Group {
  const g = new THREE.Group();
  const y = height(x, z);
  g.position.set(x, y, z);
  g.rotation.y = faceYaw;
  // terrasse en bois (posée sur la pente)
  const deck = box(12, 0.25, 7, M.wood, 0, 0.15, 0);
  g.add(deck);
  const umb = [M.red, M.white];
  let k = 0;
  for (const dx of [-4, 0, 4])
    for (const dz of [-1.6, 1.8]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), M.steel);
      pole.position.set(dx, 1.4, dz);
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 8), umb[k++ % 2]);
      top.position.set(dx, 2.75, dz);
      top.castShadow = true;
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 10), M.white);
      table.position.set(dx, 0.95, dz);
      g.add(pole, top, table);
    }
  for (let i = 0; i < 5; i++) {
    const t = box(0.6, 0.08, 1.6, M.canvas, -5 + i * 2.4, 0.55, 4.6);
    t.rotation.x = -0.35;
    g.add(t);
  }
  // enseigne
  const sign = slot(512, 160, (c) => {
    c.fillStyle = '#5b3a22';
    c.fillRect(0, 0, 512, 160);
    c.strokeStyle = '#d9b07a';
    c.lineWidth = 8;
    c.strokeRect(8, 8, 496, 144);
    c.fillStyle = '#fff7e6';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let s = 72;
    do {
      c.font = `800 ${s}px Georgia, 'Times New Roman', serif`;
      s -= 4;
    } while (c.measureText(name).width > 470 && s > 20);
    c.fillText(name, 256, 84);
  });
  const panel = slotPlane(sign, 4.2, 1.3);
  panel.position.set(0, 3.4, -4.6);
  g.add(panel);
  for (const sx of [-1.9, 1.9]) g.add(box(0.18, 4, 0.18, M.woodDark, sx, 2, -4.62));
  return g;
}

/** Panneau directionnel : une lame par piste (couleur + nom), comme aux carrefours des stations. */
export function directionPost(pistes: { name: string; d: Difficulty }[], x: number, z: number, faceYaw: number, height: H): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, height(x, z), z);
  g.rotation.y = faceYaw;
  const n = Math.min(6, pistes.length);
  const poleH = 1.6 + n * 0.42;
  g.add(box(0.12, poleH, 0.12, M.steel, 0, poleH / 2, 0));
  pistes.slice(0, n).forEach((p, i) => {
    const bg = p.d === 'noire' ? '#111' : DIFF_COLOR[p.d];
    const right = i % 2 === 0;
    const t = slot(512, 96, (c) => {
      c.fillStyle = bg;
      c.beginPath();
      if (right) {
        c.moveTo(0, 0);
        c.lineTo(450, 0);
        c.lineTo(512, 48);
        c.lineTo(450, 96);
        c.lineTo(0, 96);
      } else {
        c.moveTo(62, 0);
        c.lineTo(512, 0);
        c.lineTo(512, 96);
        c.lineTo(62, 96);
        c.lineTo(0, 48);
      }
      c.closePath();
      c.fill();
      c.fillStyle = '#fff';
      c.textBaseline = 'middle';
      c.textAlign = 'center';
      let s = 56;
      do {
        c.font = `800 ${s}px Inter, system-ui, sans-serif`;
        s -= 3;
      } while (c.measureText(p.name.toUpperCase()).width > 400 && s > 18);
      c.fillText(p.name.toUpperCase(), 256, 50);
    });
    const blade = slotPlane(t, 1.9, 0.36);
    blade.position.set(right ? 0.9 : -0.9, poleH - 0.25 - i * 0.42, 0.08);
    g.add(blade);
  });
  return g;
}

/** Enneigeurs (perches) : une InstancedMesh pour tout le domaine chargé. */
export function snowGuns(spots: { x: number; y: number; z: number; yaw: number }[]): THREE.Group {
  const g = new THREE.Group();
  if (!spots.length) return g;
  const pole = new THREE.CylinderGeometry(0.06, 0.09, 7, 6);
  pole.translate(0, 3.5, 0);
  pole.rotateX(0.32);
  const head = new THREE.CylinderGeometry(0.16, 0.16, 0.7, 8);
  head.rotateX(Math.PI / 2 + 0.32);
  head.translate(0, 6.6, 2.3);
  const base = new THREE.BoxGeometry(0.6, 0.9, 0.6);
  base.translate(0, 0.45, 0);
  const parts: [THREE.BufferGeometry, THREE.Material][] = [
    [pole, M.steel],
    [head, M.dark],
    [base, M.yellow],
  ];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3();
  for (const [geo, mat] of parts) {
    const im = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((s, i) => im.setMatrixAt(i, m.compose(p.set(s.x, s.y, s.z), q.setFromAxisAngle(up, s.yaw), one)));
    im.castShadow = false;
    im.computeBoundingSphere();
    g.add(im);
  }
  return g;
}
