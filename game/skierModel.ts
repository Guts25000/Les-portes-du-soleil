/**
 * Skieur articulé : jambes (cuisse, tibia, chaussure), buste, tête casquée avec masque, bras,
 * gants, bâtons et skis. Les articulations sont recalculées à chaque image par `pose()` :
 * flexion des genoux, angulation dans les virages, position de recherche de vitesse, grabs,
 * plantés de bâtons, position assise sur le télésiège.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface SkierColors {
  jacket: number;
  accent: number;
  pants: number;
  helmet: number;
  skis: number;
}

export interface PoseParams {
  crouch: number; // 0 debout … 1 très fléchi
  lean: number; // -1..1 inclinaison dans le virage (positif = vers la gauche)
  tuck: number; // 0..1 position aéro
  grab: number; // 0..1
  brake: number; // 0..1 chasse-neige
  sit: number; // 0..1 assis (télésiège)
  plantL: number; // 0..1 planté de bâton gauche
  plantR: number;
  armSwing: number; // -1..1 balancier
}

const SHIN = 0.48;
const THIGH = 0.46;

function std(color: number, rough = 0.6, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: 0, ...extra });
}

export class SkierRig {
  readonly root = new THREE.Group();
  /** Inclinaison générale (roulis) dans les virages. */
  readonly lean = new THREE.Group();
  readonly skis = new THREE.Group();
  hipHeight = 0.9;
  private legs: { shin: THREE.Group; knee: THREE.Group; foot: THREE.Group }[] = [];
  private torso = new THREE.Group();
  private arms: { shoulder: THREE.Group; elbow: THREE.Group; pole: THREE.Group }[] = [];
  private head = new THREE.Group();
  readonly materials: THREE.Material[] = [];

  constructor(c: SkierColors) {
    const mJacket = std(c.jacket, 0.55, { sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffffff) });
    const mAccent = std(c.accent, 0.5);
    const mPants = std(c.pants, 0.75, { sheen: 0.3 });
    const mHelmet = std(c.helmet, 0.25, { clearcoat: 1, clearcoatRoughness: 0.15 });
    const mGoggle = new THREE.MeshPhysicalMaterial({ color: 0xff8a00, metalness: 1, roughness: 0.08, iridescence: 0.6 });
    const mSkin = std(0xe8b896, 0.7);
    const mBoot = std(0x1a1d22, 0.35, { clearcoat: 0.6 });
    const mGlove = std(0x15171b, 0.7);
    const mPole = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.8, roughness: 0.3 });
    const mSki = std(c.skis, 0.25, { clearcoat: 1 });
    const mSkiBase = std(0x111317, 0.4);
    const mBinding = std(0x2b2f36, 0.4, { metalness: 0.5 });
    this.materials.push(mJacket, mAccent, mPants, mHelmet, mGoggle, mSkin, mBoot, mGlove, mPole, mSki, mSkiBase, mBinding);

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    this.root.add(this.lean);
    this.lean.add(this.skis);

    // --- skis : spatule et talon relevés, largeur en taille de guêpe, fixations
    const skiGeo = (() => {
      const g = new THREE.BoxGeometry(0.09, 0.022, 1.72, 2, 1, 24);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const z = p.getZ(i);
        let y = p.getY(i);
        let x = p.getX(i);
        if (z > 0.62) y += (z - 0.62) ** 2 * 1.15;
        if (z < -0.72) y += (-0.72 - z) ** 2 * 0.55;
        const waist = 1 - 0.14 * Math.exp(-((z * 2.2) ** 2));
        const tipNarrow = z > 0.78 ? 1 - (z - 0.78) * 1.6 : 1;
        x *= waist * Math.max(0.55, tipNarrow);
        p.setXYZ(i, x, y, z);
      }
      g.computeVertexNormals();
      return g;
    })();
    for (const sx of [-0.12, 0.12]) {
      const ski = new THREE.Group();
      ski.position.x = sx;
      mesh(skiGeo, mSki, ski, 0, 0.03, -0.02);
      mesh(new THREE.BoxGeometry(0.06, 0.004, 1.2), mAccent, ski, 0, 0.042, -0.05);
      mesh(new RoundedBoxGeometry(0.08, 0.055, 0.42, 2, 0.02), mBinding, ski, 0, 0.07, 0);
      mesh(new RoundedBoxGeometry(0.07, 0.07, 0.09, 2, 0.02), mSkiBase, ski, 0, 0.09, -0.19);
      this.skis.add(ski);
    }

    // --- jambes : chaînes depuis la cheville
    for (const sx of [-0.12, 0.12]) {
      const foot = new THREE.Group();
      foot.position.set(sx, 0.09, 0);
      this.lean.add(foot);
      mesh(new RoundedBoxGeometry(0.13, 0.17, 0.32, 3, 0.05), mBoot, foot, 0, 0.05, 0.03);
      mesh(new RoundedBoxGeometry(0.14, 0.035, 0.34, 2, 0.015), mSkiBase, foot, 0, -0.03, 0.03);
      for (const by of [0.04, 0.12]) mesh(new THREE.BoxGeometry(0.145, 0.018, 0.04), mAccent, foot, 0, by, 0.1); // boucles
      const shin = new THREE.Group();
      shin.position.y = 0.06;
      foot.add(shin);
      mesh(new THREE.CapsuleGeometry(0.072, SHIN - 0.12, 4, 12), mBoot, shin, 0, 0.13, 0.005).scale.set(1, 0.55, 1.12); // tige de chaussure
      mesh(new THREE.CapsuleGeometry(0.083, SHIN - 0.14, 4, 12), mPants, shin, 0, SHIN / 2 + 0.03, 0).scale.set(1, 1, 1.05);
      mesh(new THREE.SphereGeometry(0.09, 12, 10), mPants, shin, 0, SHIN - 0.01, 0.01); // genou
      const knee = new THREE.Group();
      knee.position.y = SHIN;
      shin.add(knee);
      mesh(new THREE.CapsuleGeometry(0.098, THIGH - 0.12, 4, 12), mPants, knee, 0, THIGH / 2, 0).scale.set(1, 1, 1.08);
      mesh(new THREE.BoxGeometry(0.025, 0.09, 0.07), mAccent, knee, sx > 0 ? 0.095 : -0.095, THIGH / 2, 0.01); // poche cargo
      this.legs.push({ shin, knee, foot });
    }

    // --- buste (positionné au bassin calculé)
    this.lean.add(this.torso);
    mesh(new THREE.CapsuleGeometry(0.16, 0.14, 4, 12), mPants, this.torso, 0, 0.02, 0).scale.set(1.15, 1, 0.9);
    const chest = mesh(new THREE.CapsuleGeometry(0.18, 0.3, 8, 16), mJacket, this.torso, 0, 0.34, 0);
    chest.scale.set(1.1, 1, 0.82);
    const hem = mesh(new THREE.CylinderGeometry(0.2, 0.215, 0.12, 16), mJacket, this.torso, 0, 0.12, 0);
    hem.scale.set(1.05, 1, 0.82);
    mesh(new THREE.BoxGeometry(0.4, 0.035, 0.31), mAccent, this.torso, 0, 0.24, 0.0); // bande réfléchissante
    mesh(new THREE.BoxGeometry(0.012, 0.42, 0.012), mBinding, this.torso, 0, 0.36, 0.152); // fermeture éclair
    const collar = mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.13, 14), mJacket, this.torso, 0, 0.61, 0.0);
    collar.scale.set(1, 1, 0.9);
    const hood = mesh(new THREE.TorusGeometry(0.12, 0.04, 8, 16, Math.PI * 1.2), mJacket, this.torso, 0, 0.64, -0.04);
    hood.rotation.set(Math.PI / 2 + 0.3, 0, Math.PI * 0.9);
    this.head.position.set(0, 0.73, 0.02);
    this.torso.add(this.head);
    mesh(new THREE.SphereGeometry(0.11, 16, 12), mSkin, this.head, 0, 0, 0.01);
    const helmet = mesh(new THREE.SphereGeometry(0.135, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), mHelmet, this.head, 0, 0.02, -0.01);
    helmet.scale.set(1, 1.02, 1.1);
    const goggles = mesh(new THREE.CylinderGeometry(0.138, 0.138, 0.078, 22, 1, false, -1.05, 2.1), mGoggle, this.head, 0, 0.0, 0.0);
    goggles.rotation.y = Math.PI / 2;
    goggles.scale.set(1.04, 1, 1.08);
    mesh(new THREE.TorusGeometry(0.131, 0.012, 6, 24, Math.PI * 1.15), mBinding, this.head, 0, 0.01, -0.01).rotation.set(Math.PI / 2, 0, -0.4);

    // --- bras + bâtons
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.24, 0.5, 0);
      this.torso.add(shoulder);
      mesh(new THREE.SphereGeometry(0.085, 12, 10), mJacket, shoulder, 0, -0.01, 0);
      mesh(new THREE.CapsuleGeometry(0.068, 0.22, 4, 12), mJacket, shoulder, 0, -0.15, 0);
      mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.05, 10), mAccent, shoulder, 0, -0.03, 0);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      shoulder.add(elbow);
      mesh(new THREE.CapsuleGeometry(0.06, 0.2, 4, 12), mJacket, elbow, 0, -0.12, 0);
      mesh(new THREE.CylinderGeometry(0.058, 0.052, 0.06, 12), mGlove, elbow, 0, -0.245, 0); // manchette
      mesh(new RoundedBoxGeometry(0.085, 0.11, 0.1, 2, 0.035), mGlove, elbow, 0, -0.3, 0.01);
      const pole = new THREE.Group();
      pole.position.set(0, -0.29, 0.02);
      elbow.add(pole);
      mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.13, 8), mGlove, pole, 0, 0.02, 0); // poignée
      mesh(new THREE.CylinderGeometry(0.009, 0.007, 1.15, 6), mPole, pole, 0, -0.55, 0);
      mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 10), mBinding, pole, 0, -1.03, 0); // rondelle
      this.arms.push({ shoulder, elbow, pole });
    }
    this.pose({ crouch: 0.3, lean: 0, tuck: 0, grab: 0, brake: 0, sit: 0, plantL: 0, plantR: 0, armSwing: 0 });
  }

  pose(p: PoseParams) {
    const sit = p.sit;
    const crouch = Math.min(1, 0.12 + p.crouch + p.tuck * 0.45 + p.grab * 0.6);
    // angles (depuis la verticale) : tibia vers l'avant, cuisse vers l'arrière
    const s = THREE.MathUtils.lerp(0.32 + crouch * 0.55, 0.05, sit);
    const t = THREE.MathUtils.lerp(0.2 + crouch * 0.95, Math.PI / 2 - 0.05, sit);
    for (const [i, leg] of this.legs.entries()) {
      const plow = p.brake * (i ? -1 : 1);
      leg.foot.rotation.set(0, plow * 0.25, 0);
      leg.shin.rotation.set(s, 0, plow * -0.08);
      leg.knee.rotation.set(-(s + t), 0, 0);
    }
    const hipY = 0.15 + SHIN * Math.cos(s) + THIGH * Math.cos(t);
    const hipZ = SHIN * Math.sin(s) - THIGH * Math.sin(t);
    this.hipHeight = hipY;
    this.torso.position.set(0, hipY, hipZ);
    const u = THREE.MathUtils.lerp(0.18 + crouch * 0.35 + p.tuck * 0.55 + p.grab * 0.5, -0.12, sit);
    this.torso.rotation.set(u, 0, -p.lean * 0.35 * (1 - sit));
    this.head.rotation.set(-u * 0.7, 0, p.lean * 0.2);
    // skis : en position assise, ils pendent sous les genoux
    this.skis.position.set(0, sit * 0.02, 0);
    for (const [i, arm] of this.arms.entries()) {
      const side = i ? 1 : -1; // i=0 gauche (x<0)
      const plant = side < 0 ? p.plantL : p.plantR;
      const forward = THREE.MathUtils.lerp(0.8 + p.armSwing * 0.15 * side + plant * 0.45 + p.tuck * 0.5, 0.35, sit);
      arm.shoulder.rotation.set(-forward - p.grab * (side > 0 ? 0.9 : 0.2), 0, side * (0.1 - p.tuck * 0.08));
      arm.elbow.rotation.set(-THREE.MathUtils.lerp(0.55 + p.tuck * 0.9, 1.2, sit), 0, 0);
      // bâtons : pointés vers l'arrière, la pointe touche la neige lors d'un planté
      arm.pole.rotation.set(THREE.MathUtils.lerp(1.15 - plant * 0.75 + p.tuck * 0.5, 0.2, sit), 0, -side * 0.08);
    }
  }

  /** Remplace tous les matériaux (fantôme). */
  override(mat: THREE.Material) {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = mat;
        m.castShadow = false;
      }
    });
  }
}
