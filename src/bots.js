import * as THREE from 'three/webgpu';
import { Vehicle } from './vehicle.js';
import { createCarMesh, M } from './car.js';
import { terrainHeight, waterLevelAt, lakeEdgeR, BASE_SPOTS } from './terrain.js';

// Машины-боты: медведи-соседи. Тот же Vehicle, что у игрока; AI простой:
// едут за лежащей добычей, с полным багажником — на свою базу, иногда
// на несколько секунд выбирают жертву и идут на таран.

export const BOT_COLORS = [0xc23b2f, 0xd7a53c]; // красный и жёлтый

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();

export function createBots(world, scene) {
  return BOT_COLORS.map((color, i) => {
    const { car, wheels, rack } = createCarMesh();
    const bodyMat = M.body.clone();
    bodyMat.color.set(color);
    // кузов после CSG несёт МАССИВ материалов [body, dark] — подменяем в обоих видах
    car.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material === M.body) o.material = bodyMat;
      else if (Array.isArray(o.material)) {
        o.material = o.material.map((m) => (m === M.body ? bodyMat : m));
      }
    });
    scene.add(car);
    const spot = BASE_SPOTS[i + 1];
    const sx = spot.x + 7, sz = spot.z;
    const vehicle = new Vehicle(world, { x: sx, y: terrainHeight(sx, sz) + 1.2, z: sz });
    return {
      car, wheels, rack, vehicle, color,
      foodIndex: i + 1,
      mode: 'food', target: { x: 0, z: 0 }, victim: null,
      think: 0, wanderT: 0, aggroT: 12 + Math.random() * 15, ramT: 0,
      stuckT: 0, revT: 0, flipT: 0,
    };
  });
}

// решения — раз в 0.4 с; food — API из createFood; others — [{car}] прочие машины
function think(b, food, others) {
  if (b.mode === 'ram') {
    if (b.ramT <= 0 || !b.victim) {
      b.mode = 'food';
      b.aggroT = 15 + Math.random() * 18;
    } else {
      b.target.x = b.victim.position.x;
      b.target.z = b.victim.position.z;
      return;
    }
  }
  if (b.aggroT <= 0 && others.length) { // пора кого-нибудь протаранить
    b.victim = others[(Math.random() * others.length) | 0].car;
    b.mode = 'ram';
    b.ramT = 6;
    return;
  }
  if (food.cargoCount(b.foodIndex) >= 5) { // багажник полон — на базу
    const base = food.baseOf(b.foodIndex);
    b.mode = 'deliver';
    b.target.x = base.x; b.target.z = base.z;
    return;
  }
  const p = b.car.position;
  const pick = food.nearestPickup(p.x, p.z, 140);
  if (pick) {
    b.mode = 'food';
    b.target.x = pick.x; b.target.z = pick.z;
    return;
  }
  b.wanderT -= 0.4; // некуда ехать — бродим по поляне и опушкам
  const dx = b.target.x - p.x, dz = b.target.z - p.z;
  if (b.wanderT <= 0 || dx * dx + dz * dz < 36) {
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 60;
    b.target.x = THREE.MathUtils.clamp(p.x + Math.cos(a) * r, -320, 320);
    b.target.z = THREE.MathUtils.clamp(p.z + Math.sin(a) * r, -320, 320);
    b.wanderT = 9;
  }
}

// руление на цель + анти-застревание; вызывать каждый кадр
export function updateBot(b, dt, food, others) {
  b.think -= dt;
  b.aggroT -= dt;
  b.ramT -= dt;
  if (b.think <= 0) { think(b, food, others); b.think = 0.4; }

  const p = b.car.position;
  _f.set(1, 0, 0).applyQuaternion(b.car.quaternion);
  _r.set(0, 0, 1).applyQuaternion(b.car.quaternion);
  let tx = b.target.x, tz = b.target.z;
  // объезд пруда: внутри опасного кольца цель виртуально отталкивается от центра
  const pr = Math.hypot(p.x, p.z);
  if (pr < 44 && b.mode !== 'ram') {
    const push = (lakeEdgeR(p.x, p.z) + 14 - pr) * 1.6;
    if (push > 0 && pr > 1) {
      tx += (p.x / pr) * push;
      tz += (p.z / pr) * push;
    }
  }
  const dx = tx - p.x, dz = tz - p.z;
  const lx = dx * _f.x + dz * _f.z;   // цель впереди/сзади
  const lz = dx * _r.x + dz * _r.z;   // цель справа/слева
  const err = Math.atan2(lz, lx);
  const dist = Math.hypot(dx, dz);
  const input = b.vehicle.input;
  input.steer = THREE.MathUtils.clamp(-err * 1.7, -1, 1);
  // у цели — сбрасываем ход, иначе пролетаем мимо ягод
  const v0 = b.vehicle.chassis.linvel();
  const speed = Math.hypot(v0.x, v0.z);
  const wantSpeed = b.mode === 'ram' ? 99 : dist < 7 ? 3.5 : dist < 18 ? 7 : 99;
  input.throttle = Math.abs(err) > 2.3 ? 0.45 : speed > wantSpeed ? -0.3 : 1;
  input.handbrake = false;

  // застрял — сдаём назад с обратным рулём
  const v = b.vehicle.chassis.linvel();
  const speed2 = v.x * v.x + v.z * v.z;
  if (speed2 < 0.36 && input.throttle > 0) b.stuckT += dt;
  else b.stuckT = 0;
  if (b.stuckT > 1.7) { b.revT = 1.3; b.stuckT = 0; }
  if (b.revT > 0) {
    b.revT -= dt;
    input.throttle = -1;
    input.steer = -input.steer;
  }

  // утонул или долго лежит на крыше — встаём заново
  const t = b.vehicle.chassis.translation();
  _u.set(0, 1, 0).applyQuaternion(b.car.quaternion);
  if (_u.y < 0.2) b.flipT += dt; else b.flipT = 0;
  if (t.y + 0.75 < waterLevelAt(t.x, t.z) || b.flipT > 3) {
    b.vehicle.reset();
    b.flipT = 0;
  }
}
