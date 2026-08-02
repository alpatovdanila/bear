import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { CAR } from './car.js';
import { terrainHeight, inLake, lakeEdgeR } from './terrain.js';

// Собственная симуляция: рейкаст-подвеска (пружина + демпфер, силы в точках)
// и шинная модель со slip angle и эллипсом трения. Перенос веса, клевки при
// торможении, крены и занос при насыщении шин получаются сами собой.
// Оси шасси: +X — вперёд, +Y — вверх, +Z — правый борт.

export const TUNE = {
  mass: 1180,
  comHeight: 0.05,         // центр масс у самого днища — кузов-то теперь высоко
  inertia: { x: 520, y: 1700, z: 1560 }, // крен / рыскание / тангаж

  hardpointY: 0.4,         // точка крепления стойки
  suspRest: 0.7,
  suspTravel: 0.3,
  springK: 13988,          // Н/м; мягкая, просадка ~16 см, клиренс ~48 см
  bumpStopK: 160000,       // упор при пробое подвески
  dampComp: 2282.5,
  dampRebound: 2745,

  enginePower: 60e3,       // Вт — поживее
  engineMaxForce: 5200,    // Н на низах
  reverseForce: 2500,
  brakeForce: 10500,       // Н суммарно, 60/40 — ~0.9g, дальше режет эллипс трения
  topSpeed: 75 / 3.6,      // м/с
  engineBrake: 550,
  handbrakeForce: 5200,    // Н на корму

  muLong: 1.15,
  muLat: [1.05, 1.05, 0.95, 0.95], // корма чуть раньше срывается — занос
  handbrakeMuLat: 0.32,
  corneringCoef: 16,       // Cα = coef · Fz; насыщение на ~4°

  maxSteer: 0.6,
  steerSpeed: 3.0,
  drag: 0.45,
  rollResist: 160,
};

const RATIOS = [3.45, 1.95, 1.36, 1.03, 0.85];
const FINAL_DRIVE = 3.7;
const IDLE_RPM = 850;

const WHEEL_POS = [
  new THREE.Vector3(1.25, TUNE.hardpointY, -CAR.track / 2),  // FL
  new THREE.Vector3(1.25, TUNE.hardpointY, CAR.track / 2),   // FR
  new THREE.Vector3(-1.25, TUNE.hardpointY, -CAR.track / 2), // RL
  new THREE.Vector3(-1.25, TUNE.hardpointY, CAR.track / 2),  // RR
];

// переиспользуемые временные векторы — без мусора в кадре
const _q = new THREE.Quaternion(), _t = new THREE.Vector3();
const _up = new THREE.Vector3(), _hard = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _cv = new THREE.Vector3(), _f = new THREE.Vector3(), _p = new THREE.Vector3();

export class Vehicle {
  constructor(world, spawn) {
    this.world = world;
    this.chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setAngularDamping(0.3) // лёгкое демпфирование рыскания — против спина
        .setCanSleep(false),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.9, 0.32, 0.8)
        .setTranslation(0, 0.42, 0)
        .setMassProperties(
          TUNE.mass,
          { x: 0, y: TUNE.comHeight, z: 0 },
          TUNE.inertia,
          { x: 0, y: 0, z: 0, w: 1 },
        ),
      this.chassis,
    );

    this.steer = 0;
    this.parked = false;
    this.gear = 0;
    this.rpm = IDLE_RPM;
    this.speedFwd = 0;
    this.suspLen = new Array(4).fill(TUNE.suspRest);
    this.visualLen = new Array(4).fill(TUNE.suspRest); // для мешей: без зажима снизу
    this.spin = new Array(4).fill(0);
    this.grounded = new Array(4).fill(false);
    this.input = { throttle: 0, steer: 0, handbrake: false };
  }

  get speed() { return this.speedFwd; }

  update(dt) {
    const { throttle, handbrake } = this.input;
    const body = this.chassis;
    body.resetForces(true);
    body.resetTorques(true); // addForceAtPoint копит и момент — сбрасывать оба!

    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const tr = body.translation();
    _t.set(tr.x, tr.y, tr.z);
    _up.set(0, 1, 0).applyQuaternion(_q);
    const lv = body.linvel();
    _fwd.set(1, 0, 0).applyQuaternion(_q);
    this.speedFwd = _fwd.x * lv.x + _fwd.y * lv.y + _fwd.z * lv.z;
    const vAbs = Math.abs(this.speedFwd);

    // --- руль: на скорости меньше и угол, и скорость поворота ---
    const maxSteer = TUNE.maxSteer / (1 + vAbs * 0.09);
    const rate = TUNE.steerSpeed / (1 + vAbs * 0.05);
    const ds = THREE.MathUtils.clamp(this.input.steer * maxSteer - this.steer, -rate * dt, rate * dt);
    this.steer += ds;

    // --- газ / тормоз / задний ход ---
    let driveForce = 0, brakeF = 0;
    if (throttle > 0) {
      driveForce = Math.min(TUNE.engineMaxForce, TUNE.enginePower / Math.max(vAbs, 3.5));
      // мягкий ограничитель максималки
      driveForce *= THREE.MathUtils.clamp((TUNE.topSpeed - this.speedFwd) / 1.5, 0, 1);
    } else if (throttle < 0) {
      if (this.speedFwd > 0.5) brakeF = TUNE.brakeForce;
      else driveForce = -TUNE.reverseForce;
    } else {
      brakeF = TUNE.engineBrake;
    }

    // --- колёса ---
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      _hard.copy(WHEEL_POS[i]).applyQuaternion(_q).add(_t);
      const ray = new RAPIER.Ray(_hard, { x: -_up.x, y: -_up.y, z: -_up.z });
      const maxToi = TUNE.suspRest + TUNE.suspTravel + CAR.wheelRadius;
      const hit = this.world.castRay(ray, maxToi, true, undefined, undefined, undefined, body);

      if (!hit) {
        this.grounded[i] = false;
        this.suspLen[i] = Math.min(this.suspLen[i] + 1.5 * dt, TUNE.suspRest + TUNE.suspTravel);
        this.visualLen[i] = this.suspLen[i];
        continue;
      }
      this.grounded[i] = true;
      const rawLen = hit.timeOfImpact - CAR.wheelRadius;
      const minLen = TUNE.suspRest - TUNE.suspTravel;
      const len = THREE.MathUtils.clamp(rawLen, minLen, TUNE.suspRest + TUNE.suspTravel);
      this.suspLen[i] = len;
      // визуально колесо стоит на земле, даже когда подвеска пробита
      this.visualLen[i] = Math.max(rawLen, 0.02);

      // пружина + демпфер (+ жёсткий упор при пробое)
      const vp = body.velocityAtPoint(_hard);
      _cv.set(vp.x, vp.y, vp.z);
      const vSusp = _cv.dot(_up);
      const compression = TUNE.suspRest - len;
      const damp = vSusp > 0 ? TUNE.dampRebound : TUNE.dampComp;
      // прогрессивная пружина: чем сильнее сжата, тем жёстче
      const cn = Math.max(0, compression) / TUNE.suspTravel;
      let Fz = TUNE.springK * compression * (1 + 1.8 * cn * cn) - damp * vSusp;
      if (rawLen < minLen) Fz += TUNE.bumpStopK * (minLen - rawLen);
      Fz = THREE.MathUtils.clamp(Fz, 0, 42000);
      _f.copy(_up).multiplyScalar(Fz);
      body.addForceAtPoint(_f, _hard, true);

      // оси шины (с учётом поворота передних)
      const s = front ? this.steer : 0;
      _fwd.set(Math.cos(s), 0, -Math.sin(s)).applyQuaternion(_q);
      _right.set(Math.sin(s), 0, Math.cos(s)).applyQuaternion(_q);
      const vLong = _cv.dot(_fwd);
      const vLat = _cv.dot(_right);
      this.spin[i] += (vLong / CAR.wheelRadius) * dt;

      // боковая сила: линейна по slip angle до насыщения
      const slip = Math.atan2(vLat, Math.abs(vLong) + 0.6);
      let muLat = TUNE.muLat[i];
      // на скорости корма цепче носа — машина не срывается в спин на трассе,
      // а заносы остаются на малых скоростях и с ручником
      if (!front) muLat += Math.min(0.3, vAbs * 0.016);
      if (handbrake && !front) muLat = TUNE.handbrakeMuLat;
      let fLat = THREE.MathUtils.clamp(-TUNE.corneringCoef * Fz * slip, -muLat * Fz, muLat * Fz);

      // продольная: полный привод + тормоза
      let fLong = driveForce / 4;
      let wheelBrake = brakeF * (front ? 0.3 : 0.2);
      if (handbrake && !front) wheelBrake += TUNE.handbrakeForce / 2;
      if (Math.abs(vLong) > 0.4) {
        fLong -= Math.sign(vLong) * wheelBrake;
      } else if (throttle === 0) {
        // стоим без газа — держим крепко в обеих осях, не сползаем со склонов
        fLong -= vLong * 12000;
        fLat -= vLat * 12000;
      }

      // эллипс трения: длинн+бок не могут превысить сцепление
      const maxLong = TUNE.muLong * Fz;
      const n = Math.hypot(fLong / maxLong, fLat / (muLat * Fz + 1e-6));
      if (n > 1) { fLong /= n; fLat /= n; }

      // продольная — в центре колеса (клевки при торможении),
      // боковая — на середине стойки (ролл-центр): крен есть, кувырка нет
      _f.copy(_fwd).multiplyScalar(fLong);
      _p.copy(_up).multiplyScalar(-len).add(_hard);
      body.addForceAtPoint(_f, _p, true);
      _f.copy(_right).multiplyScalar(fLat);
      _p.copy(_up).multiplyScalar(-len * 0.5).add(_hard);
      body.addForceAtPoint(_f, _p, true);
    }

    // --- стоянка: гистерезис + сильное линейное демпфирование тела ---
    // (обнуление скорости каждый кадр дралось с подвеской и трясло машину)
    const still = throttle === 0 && !handbrake && Math.abs(this.speedFwd) < 0.3
      && Math.hypot(lv.x, lv.z) < 0.3;
    if (still && !this.parked) {
      this.parked = true;
      body.setLinearDamping(6);
    } else if (!still && this.parked && (throttle !== 0 || handbrake)) {
      this.parked = false;
      body.setLinearDamping(0);
    }

    // --- аэродинамика + сопротивление качению ---
    const vlen = Math.hypot(lv.x, lv.y, lv.z);
    if (vlen > 0.4) {
      const k = -(TUNE.drag * vlen + TUNE.rollResist / vlen);
      body.addForce({ x: lv.x * k, y: 0, z: lv.z * k }, true);
    }

    // --- обороты и АКПП (для звука и дымка) ---
    const wheelRpm = (vAbs / (2 * Math.PI * CAR.wheelRadius)) * 60;
    let rpm = wheelRpm * RATIOS[this.gear] * FINAL_DRIVE;
    if (rpm > 4600 && this.gear < RATIOS.length - 1) this.gear++;
    else if (rpm < 1500 && this.gear > 0) this.gear--;
    rpm = wheelRpm * RATIOS[this.gear] * FINAL_DRIVE;
    if (throttle > 0 && vAbs < 2) rpm = Math.max(rpm, 1300 + 1500 * throttle);
    const target = THREE.MathUtils.clamp(Math.max(rpm, IDLE_RPM), IDLE_RPM, 5800);
    this.rpm += (target - this.rpm) * Math.min(1, dt * 6); // инерция маховика
  }

  // Позы колёс в локальных осях шасси — для визуальных мешей
  syncWheels(wheelMeshes) {
    for (let i = 0; i < 4; i++) {
      const conn = WHEEL_POS[i];
      const w = wheelMeshes[i];
      w.position.set(conn.x, conn.y - this.visualLen[i], conn.z);
      w.rotation.set(0, i < 2 ? this.steer : 0, 0, 'YXZ');
      w.children[0].rotation.z = -this.spin[i];
      w.children[1].rotation.z = -this.spin[i];
    }
  }

  reset() {
    const p = this.chassis.translation();
    let x = p.x, z = p.z;
    const r = Math.hypot(x, z);
    // 340: береговая линия местами подходит к ~373 — на r=340 всюду суша
    // (на 380 были подводные точки — машина навсегда застревала в море)
    if (r > 340) { x *= 340 / r; z *= 340 / r; }
    if (inLake(x, z)) { // и никогда — в пруд: выталкиваемся на берег
      const rr = Math.hypot(x, z) || 1;
      const shore = lakeEdgeR(x, z) + 6;
      x = (x / rr) * shore;
      z = (z / rr) * shore;
    }
    this.chassis.setTranslation({ x, y: terrainHeight(x, z) + 1.2, z }, true);
    this.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}
