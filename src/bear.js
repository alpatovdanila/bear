import * as THREE from 'three/webgpu';

// Медведь-водитель: сидит на водительском месте, левая лапа на руле.
// Сферы и капсулы, flatShading — в стиль остального мира.

export function createBear() {
  const fur = new THREE.MeshStandardNodeMaterial({ color: 0x6d4a2f, roughness: 0.92, metalness: 0, flatShading: true });
  const muzzleM = new THREE.MeshStandardNodeMaterial({ color: 0xa5825f, roughness: 0.9, metalness: 0, flatShading: true });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x241a12, roughness: 0.55, metalness: 0 });

  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };

  // торс, слегка откинут на спинку
  const torso = new THREE.SphereGeometry(0.28, 10, 8);
  torso.scale(0.9, 1.15, 0.95);
  add(torso, fur, -0.05, 0.68, 0, 0, 0, -0.12);
  // голова — под самой крышей, видна в окна
  add(new THREE.SphereGeometry(0.18, 10, 8), fur, 0.0, 0.99, 0);
  // уши
  add(new THREE.SphereGeometry(0.06, 6, 5), fur, -0.02, 1.14, -0.11);
  add(new THREE.SphereGeometry(0.06, 6, 5), fur, -0.02, 1.14, 0.11);
  // морда и нос — вперёд, по ходу машины
  const muzzle = new THREE.SphereGeometry(0.08, 8, 6);
  muzzle.scale(1.4, 0.75, 0.9);
  add(muzzle, muzzleM, 0.15, 0.94, 0);
  add(new THREE.SphereGeometry(0.032, 6, 5), dark, 0.25, 0.96, 0);
  // глаза
  add(new THREE.SphereGeometry(0.024, 6, 5), dark, 0.14, 1.05, -0.075);
  add(new THREE.SphereGeometry(0.024, 6, 5), dark, 0.14, 1.05, 0.075);
  // обе лапы — вперёд-вверх к рулю, кисти на ободе (видно из кабины)
  for (const s of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.055, 0.32, 4, 6), fur, 0.17, 0.78, s * 0.12, s * 0.35, 0, -1.15);
    add(new THREE.SphereGeometry(0.07, 6, 5), fur, 0.33, 0.9, s * 0.11);
  }
  return g;
}
