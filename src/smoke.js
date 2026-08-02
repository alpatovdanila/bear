import * as THREE from 'three/webgpu';

// Клубы из выхлопной трубы. Пыхи синхронны тактам двигателя: один клуб на
// два оборота коленвала (4-тактный цикл, rpm/120 Гц). На скорости выхлоп
// растворяется набегающим потоком — дым почти исчезает.

const N = 64;
const PIPE_LOCAL = new THREE.Vector3(-2.02, 0.12, 0.5);

export function createSmoke() {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({ // без шейдинга — мягкий клуб
    color: 0xc9cfd4, transparent: true, opacity: 0.22, depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.frustumCulled = false;

  const puffs = Array.from({ length: N }, () => ({
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 1e9, maxLife: 1, size: 0.1,
  }));
  let cursor = 0, acc = 0;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pipe = new THREE.Vector3(), fwd = new THREE.Vector3(), s = new THREE.Vector3();

  function update(dt, car, carVel, rpm, throttle) {
    // один пых на цикл (2 оборота); быстрее 3000 об/мин пыхи сливаются сами
    acc += dt * (rpm / 120);
    while (acc > 1) {
      acc -= 1;
      const p = puffs[cursor];
      cursor = (cursor + 1) % N;
      pipe.copy(PIPE_LOCAL).applyMatrix4(car.matrixWorld);
      fwd.set(1, 0, 0).applyQuaternion(car.quaternion);
      p.pos.copy(pipe).add(s.set(
        (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06));
      p.vel.set(
        -fwd.x * (0.7 + Math.random() * 0.3 + throttle * 0.6) + carVel.x * 0.35,
        0.25 + Math.random() * 0.2,
        -fwd.z * (0.7 + Math.random() * 0.3 + throttle * 0.6) + carVel.z * 0.35,
      );
      p.life = 0;
      p.maxLife = 0.8 + Math.random() * 0.4;
      p.size = 0.035 + throttle * 0.025 + (rpm / 6000) * 0.02 + Math.random() * 0.015;
    }

    // на оборотах выхлоп горячее и чище — дым тает; тарахтим на холостых — пыхает
    mat.opacity = 0.22 * THREE.MathUtils.clamp(1 - (rpm - 950) / 2200, 0.07, 1);

    for (let i = 0; i < N; i++) {
      const p = puffs[i];
      p.life += dt;
      const t = p.life / p.maxLife;
      if (t >= 1) {
        m.makeScale(0, 0, 0);
      } else {
        p.vel.y += 0.45 * dt;               // тёплый — всплывает
        p.vel.multiplyScalar(1 - 1.0 * dt); // и тормозит в воздухе
        p.pos.addScaledVector(p.vel, dt);
        // пышный: быстро раздувается и мягко сдувается в конце
        const grow = p.size * (1 + 2.6 * Math.sqrt(t));
        const fade = t > 0.7 ? (1 - t) / 0.3 : 1;
        s.setScalar(grow * (0.3 + 0.7 * fade));
        m.compose(p.pos, q, s);
      }
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, update };
}
