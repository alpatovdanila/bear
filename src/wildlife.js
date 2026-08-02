import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIZE, terrainHeight, onLand } from './terrain.js';
import { colored } from './trees.js';

// Бабочки — тупые и декоративные: порхают по лугу синусоидами.
// Птицы — конечный автомат: клюёт → машина ближе 12 м → перелетает на
// новое место по дуге → снова клюёт.

const BUTTERFLIES = 100;
const FLOCKS = 24; // стайки по 2–4 птицы
const SQUIRRELS = 16;

// случайная точка на суше
function landSpot() {
  for (let i = 0; i < 30; i++) {
    const x = (Math.random() - 0.5) * (SIZE - 40);
    const z = (Math.random() - 0.5) * (SIZE - 40);
    if (onLand(x, z)) return [x, z];
  }
  return [0, 0];
}

function butterflyGeometry() {
  // два крыла-треугольника, сложенных «домиком»
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, -0.06, 0.03, -0.05, -0.06, 0.03, 0.05,
    0, 0, 0, 0.06, 0.03, -0.05, 0.06, 0.03, 0.05,
  ]), 3));
  g.computeVertexNormals();
  return g;
}

function birdGeometry() {
  const body = new THREE.IcosahedronGeometry(0.09, 1);
  body.scale(1.5, 0.9, 0.8);
  const head = new THREE.IcosahedronGeometry(0.05, 1);
  head.translate(0.13, 0.07, 0);
  const beak = new THREE.ConeGeometry(0.015, 0.05, 4);
  beak.rotateZ(-Math.PI / 2);
  beak.translate(0.2, 0.06, 0);
  const tail = new THREE.BoxGeometry(0.1, 0.015, 0.05);
  tail.rotateZ(0.35);
  tail.translate(-0.14, 0.03, 0);
  const brown = new THREE.Color(0x6a5140);
  return mergeGeometries([
    colored(body, brown), colored(head, new THREE.Color(0x54402f)),
    colored(beak, new THREE.Color(0xcc8822)), colored(tail, brown),
  ]);
}

function squirrelGeometry() {
  const rust = new THREE.Color(0x9a5230);
  const body = new THREE.IcosahedronGeometry(0.09, 1);
  body.scale(1.6, 1, 0.9);
  body.translate(0, 0.09, 0);
  const head = new THREE.IcosahedronGeometry(0.055, 1);
  head.translate(0.15, 0.15, 0);
  const ears = [];
  for (const s of [-1, 1]) {
    const ear = new THREE.ConeGeometry(0.018, 0.05, 4);
    ear.translate(0.14, 0.21, s * 0.03);
    ears.push(colored(ear, new THREE.Color(0x6e3a20)));
  }
  const tail = new THREE.IcosahedronGeometry(0.09, 1);
  tail.scale(1.0, 1.9, 0.7); // пушистый хвост дугой вверх
  tail.translate(-0.17, 0.2, 0);
  return mergeGeometries([
    colored(body, rust), colored(head, rust),
    colored(tail, new THREE.Color(0xa85f38)), ...ears,
  ]);
}

export function createWildlife() {
  const group = new THREE.Group();

  // --- бабочки ---
  const bMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const bMesh = new THREE.InstancedMesh(butterflyGeometry(), bMat, BUTTERFLIES);
  bMesh.frustumCulled = false;
  const bColors = [0xffffff, 0xffe28a, 0xff9d5c, 0xbfd7ff];
  const flies = [];
  for (let i = 0; i < BUTTERFLIES; i++) {
    const [cx, cz] = landSpot();
    flies.push({
      cx, cz,
      r: 2 + Math.random() * 6,
      w: 0.3 + Math.random() * 0.5,       // угловая скорость кружения
      f: 8 + Math.random() * 6,           // частота взмахов
      ph: Math.random() * 100,
    });
    bMesh.setColorAt(i, new THREE.Color(bColors[i % bColors.length]));
  }
  group.add(bMesh);

  // --- птицы: пасутся стайками, взлетают тоже стайкой ---
  const flocks = [];
  const birds = [];
  for (let f = 0; f < FLOCKS; f++) {
    const [cx, cz] = landSpot();
    const flock = { cx, cz, members: [] };
    const n = 2 + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++) {
      const ox = (Math.random() - 0.5) * 5, oz = (Math.random() - 0.5) * 5;
      const b = {
        flock, ox, oz, state: 'peck', delay: 0, u: 0, dur: 1,
        pos: new THREE.Vector3(cx + ox, terrainHeight(cx + ox, cz + oz) + 0.06, cz + oz),
        from: new THREE.Vector3(), to: new THREE.Vector3(),
        yaw: Math.random() * Math.PI * 2,
      };
      flock.members.push(b);
      birds.push(b);
    }
    flocks.push(flock);
  }
  const birdMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9 });
  const birdMesh = new THREE.InstancedMesh(birdGeometry(), birdMat, birds.length);
  birdMesh.frustumCulled = false;
  group.add(birdMesh);

  // --- белки: кормятся с перебежками, от машины бегут прочь, потом вбок ---
  const sqMesh = new THREE.InstancedMesh(squirrelGeometry(), birdMat, SQUIRRELS);
  sqMesh.frustumCulled = false;
  group.add(sqMesh);
  const squirrels = [];
  for (let i = 0; i < SQUIRRELS; i++) {
    const [x, z] = landSpot();
    squirrels.push({
      pos: new THREE.Vector3(x, terrainHeight(x, z) + 0.02, z),
      target: new THREE.Vector3(),
      state: 'feed', t: Math.random() * 3, yaw: Math.random() * Math.PI * 2,
      heading: 0, runLeft: 0,
    });
  }
  // демонстрационная белка — в шести метрах перед спауном машины
  squirrels[0].pos.set(52, terrainHeight(52, 0) + 0.02, 0);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const s = new THREE.Vector3(1, 1, 1), tmp = new THREE.Vector3();

  let fr = 0;
  function update(dt, carPos) {
    const t0 = performance.now() / 1000;
    fr++;

    for (let i = 0; i < BUTTERFLIES; i++) {
      const b = flies[i];
      // дальние бабочки субпиксельны — обновляем каждый 4-й кадр
      if ((b.cx - carPos.x) ** 2 + (b.cz - carPos.z) ** 2 > 120 * 120 && ((i + fr) & 3)) continue;
      const a = t0 * b.w + b.ph;
      const x = b.cx + Math.cos(a) * b.r;
      const z = b.cz + Math.sin(a * 1.3) * b.r;
      const y = terrainHeight(x, z) + 0.5 + Math.sin(a * 2.7) * 0.35 + Math.sin(t0 * b.f) * 0.06;
      e.set(Math.sin(t0 * b.f) * 1.1, -a, 0, 'YXZ'); // взмах крыльев + курс
      m.compose(tmp.set(x, y, z), q.setFromEuler(e), s.setScalar(1.4));
      bMesh.setMatrixAt(i, m);
    }
    bMesh.instanceMatrix.needsUpdate = true;

    // машина пугает целую стайку — все выбирают общее новое место
    for (const f of flocks) {
      const grazing = f.members.some((b) => b.state === 'peck');
      if (!grazing) continue;
      if ((f.cx - carPos.x) ** 2 + (f.cz - carPos.z) ** 2 > 13 * 13) continue;
      tmp.set(f.cx - carPos.x, 0, f.cz - carPos.z).normalize();
      const ang = Math.atan2(tmp.z, tmp.x) + (Math.random() - 0.5) * 1.2;
      const dist = 35 + Math.random() * 40;
      let nx = f.cx + Math.cos(ang) * dist;
      let nz = f.cz + Math.sin(ang) * dist;
      const rr = Math.hypot(nx, nz);
      if (rr > 380) { nx *= 380 / rr; nz *= 380 / rr; } // не в море
      f.cx = nx; f.cz = nz;
      f.members.forEach((b, k) => {
        if (b.state !== 'peck') return;
        b.state = 'wait';
        b.delay = k * 0.14 + Math.random() * 0.08; // взлетают вразнобой, но дружно
        b.from.copy(b.pos);
        const tx = nx + b.ox, tz = nz + b.oz;
        b.to.set(tx, terrainHeight(tx, tz) + 0.06, tz);
        b.u = 0;
        b.dur = b.from.distanceTo(b.to) / (9 + Math.random() * 4);
      });
    }

    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      // дальние клюющие птицы статичны — матрицу можно обновлять реже
      if (b.state === 'peck' && ((i + fr) & 3)
        && (b.flock.cx - carPos.x) ** 2 + (b.flock.cz - carPos.z) ** 2 > 130 * 130) continue;
      if (b.state === 'peck') {
        // клюёт: периодический наклон к земле
        const pecking = Math.sin(t0 * 7 + i * 3) > 0.4 ? -0.7 : 0;
        e.set(0, b.yaw, pecking, 'YXZ');
        m.compose(b.pos, q.setFromEuler(e), s.setScalar(1));
      } else if (b.state === 'wait') {
        b.delay -= dt;
        if (b.delay <= 0) b.state = 'fly';
        e.set(0, b.yaw, -0.3, 'YXZ'); // пригнулась перед взлётом
        m.compose(b.pos, q.setFromEuler(e), s.setScalar(1));
      } else {
        b.u += dt / b.dur;
        if (b.u >= 1) {
          b.state = 'peck';
          b.pos.copy(b.to);
          e.set(0, b.yaw, 0, 'YXZ');
          m.compose(b.pos, q.setFromEuler(e), s.setScalar(1));
        } else {
          const u = b.u;
          b.pos.lerpVectors(b.from, b.to, u);
          b.pos.y += Math.sin(Math.PI * u) * (5 + b.dur) + Math.sin(t0 * 18 + i) * 0.12;
          b.yaw = -Math.atan2(b.to.z - b.from.z, b.to.x - b.from.x);
          e.set(Math.sin(t0 * 16 + i) * 0.25, b.yaw, 0.15, 'YXZ'); // машет крыльями телом
          m.compose(b.pos, q.setFromEuler(e), s.setScalar(1));
        }
      }
      birdMesh.setMatrixAt(i, m);
    }
    birdMesh.instanceMatrix.needsUpdate = true;

    // --- белки ---
    for (let i = 0; i < SQUIRRELS; i++) {
      const sq = squirrels[i];
      const dx = sq.pos.x - carPos.x, dz = sq.pos.z - carPos.z;
      const far2 = dx * dx + dz * dz;
      // дальние белки — каждый 4-й кадр с компенсированным шагом времени
      let sdt = dt;
      if (far2 > 130 * 130) {
        if ((i + fr) & 3) continue;
        sdt = dt * 4;
      }
      const carNear = far2 < 14 * 14;
      let moving = false;

      if (sq.state === 'feed') {
        if (carNear) {
          sq.state = 'flee';
          sq.t = 1.5 + Math.random();
        } else {
          sq.t -= sdt;
          if (sq.t <= 0) { // перебежка на соседнее место, как настоящая белка
            const a = Math.random() * Math.PI * 2;
            const d = 2 + Math.random() * 4;
            sq.target.set(sq.pos.x + Math.cos(a) * d, 0, sq.pos.z + Math.sin(a) * d);
            sq.state = 'dash';
          }
        }
      } else if (sq.state === 'dash') {
        tmp.set(sq.target.x - sq.pos.x, 0, sq.target.z - sq.pos.z);
        const dist = tmp.length();
        if (dist < 0.2) {
          sq.state = 'feed';
          sq.t = 1.5 + Math.random() * 2.5;
        } else {
          tmp.divideScalar(dist);
          sq.pos.addScaledVector(tmp, Math.min(3.2 * sdt, dist));
          sq.yaw = -Math.atan2(tmp.z, tmp.x);
          moving = true;
        }
        if (carNear) { sq.state = 'flee'; sq.t = 1.5 + Math.random(); }
      } else if (sq.state === 'flee') {
        // бежит строго от машины, направление обновляется на бегу
        tmp.set(dx, 0, dz).normalize();
        sq.pos.addScaledVector(tmp, 7 * sdt);
        sq.yaw = -Math.atan2(tmp.z, tmp.x);
        moving = true;
        sq.t -= sdt;
        if (sq.t <= 0) { // сворачивает вбок и ищет новое место
          sq.state = 'relocate';
          sq.heading = Math.atan2(tmp.z, tmp.x) + (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.6);
          sq.runLeft = 20 + Math.random() * 20;
        }
      } else { // relocate
        sq.pos.x += Math.cos(sq.heading) * 6 * sdt;
        sq.pos.z += Math.sin(sq.heading) * 6 * sdt;
        sq.yaw = -sq.heading;
        moving = true;
        sq.runLeft -= 6 * sdt;
        const rr = Math.hypot(sq.pos.x, sq.pos.z);
        if (rr > 380) sq.heading += 2.5 * sdt; // от берега заворачивает
        if (sq.runLeft <= 0 && onLand(sq.pos.x, sq.pos.z)) {
          sq.state = 'feed';
          sq.t = 2 + Math.random() * 3;
        }
      }

      sq.pos.y = terrainHeight(sq.pos.x, sq.pos.z) + 0.02;
      const hop = moving ? Math.abs(Math.sin(t0 * 16 + i * 2)) * 0.09 : 0;
      const nibble = !moving && Math.sin(t0 * 5 + i * 1.7) > 0.5 ? -0.4 : 0;
      e.set(0, sq.yaw, nibble, 'YXZ');
      m.compose(tmp.set(sq.pos.x, sq.pos.y + hop, sq.pos.z), q.setFromEuler(e), s.setScalar(1.15));
      sqMesh.setMatrixAt(i, m);
    }
    sqMesh.instanceMatrix.needsUpdate = true;
  }

  return { group, update };
}
