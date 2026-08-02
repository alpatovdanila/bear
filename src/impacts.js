import * as THREE from 'three/webgpu';
import { terrainHeight } from './terrain.js';
import { treeTints } from './trees.js';

// Тараны деревьев: ствол качается с затуханием (правим матрицу инстанса
// BatchedMesh), с лиственных сыплются листья, с хвойных — шишки.
// Сильный удар может стряхнуть белку (убежит), скунса (падает на крышу
// игрока и бегает по салону — спамь пробел!), рой пчёл-воров или золотую
// шишку с хвойного. Частицы — пулы InstancedMesh.

const LEAVES = 240, CONES = 64;
const HIT_SPEED = 3;         // м/с — медленнее дерево вообще не реагирует
const FALL_SPEED = 35 / 3.6; // листья/шишки сыплются только с 35 км/ч
const DROP_SPEED = 5.5;      // с этой скорости из кроны может что-то свалиться
const COOLDOWN = 1.2;        // сек между ударами по одному дереву

export function createImpacts(scene, forest, sounds, food, playerCar) {
  // листочек: овал (как на кронах), виден с обеих сторон
  const leafGeo = new THREE.CircleGeometry(0.085, 6);
  leafGeo.scale(1, 1.5, 1);
  const leafMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, LEAVES);
  // шишка: вытянутый эллипсоид
  const coneGeo = new THREE.SphereGeometry(0.085, 6, 4);
  coneGeo.scale(1, 1.4, 1);
  const cones = new THREE.InstancedMesh(coneGeo, new THREE.MeshLambertNodeMaterial({ color: 0x5f4426 }), CONES);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  // ВАЖНО: буфер instanceColor должен существовать ДО первого рендера —
  // WebGPU-пайплайн собирается один раз и ленивое появление буфера
  // не подхватывает (WebGL-рендерер пересобирал программу, этот — нет)
  const initCol = new THREE.Color(1, 1, 1);
  for (let i = 0; i < LEAVES; i++) { leaves.setMatrixAt(i, hidden); leaves.setColorAt(i, initCol); }
  for (let i = 0; i < CONES; i++) cones.setMatrixAt(i, hidden);
  leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  leaves.frustumCulled = cones.frustumCulled = false; // частицы всегда у машины
  scene.add(leaves, cones);

  const leafState = Array.from({ length: LEAVES }, () => ({ live: false }));
  const coneState = Array.from({ length: CONES }, () => ({ live: false }));
  let leafCursor = 0, coneCursor = 0;

  const shakes = []; // активные качания деревьев
  const _m = new THREE.Matrix4(), _rot = new THREE.Matrix4(), _shift = new THREE.Matrix4();
  const _axis = new THREE.Vector3(), _p = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _col = new THREE.Color(), _e = new THREE.Euler();
  const _fallbackGreen = new THREE.Color(0x4d7026);

  const snd = (name, x, z, vol = 1, rate = 1) =>
    sounds && sounds.play(name, { vol, rate, x, z }); // 3D: позиция события

  function hit(tr, vel, speed, carIdx) {
    const py = terrainHeight(tr.x, tr.z) - 0.15; // точка опоры = низ ствола
    snd('treeHit', tr.x, tr.z, Math.min(1, 0.4 + speed * 0.05));
    if (speed > DROP_SPEED) { // из кроны может что-то свалиться
      const roll = Math.random();
      if (tr.conifer && roll < 0.1) food.spawnGold(tr.x + (Math.random() - 0.5) * 2, tr.z + (Math.random() - 0.5) * 2);
      else if (roll < 0.2) dropSquirrel(tr, py);
      else if (roll < 0.26 && carIdx === 0) dropSkunk(tr, py);
      else if (roll < 0.33) spawnBees(tr, py, carIdx);
    }
    // ось качания — поперёк движения машины; повторный удар не «запекает» наклон
    let sh = shakes.find((s) => s.batchId === tr.batchId);
    if (!sh) {
      sh = { batchId: tr.batchId, base: new THREE.Matrix4() };
      forest.mesh.getMatrixAt(tr.batchId, sh.base);
      shakes.push(sh);
    }
    sh.t = 0;
    sh.amp = Math.min(0.1, 0.02 + speed * 0.004);
    sh.px = tr.x; sh.py = py; sh.pz = tr.z;
    sh.ax = vel.z / speed; sh.az = -vel.x / speed;

    if (speed < FALL_SPEED) return; // слабый удар: только качание, без осыпания

    if (tr.conifer) { // шишки: сыплются из кроны и скачут по земле
      const n = 3 + Math.min(5, (speed - FALL_SPEED) * 0.7 | 0);
      for (let k = 0; k < n; k++) {
        let idx = coneCursor, tries = 0;
        while (coneState[idx].live && tries++ < CONES) idx = (idx + 1) % CONES;
        coneCursor = (idx + 1) % CONES;
        const c = coneState[idx];
        const ang = Math.random() * Math.PI * 2, rad = tr.h * 0.12 * Math.random();
        c.live = true;
        c.x = tr.x + Math.cos(ang) * rad;
        c.y = py + tr.h * (0.55 + Math.random() * 0.35);
        c.z = tr.z + Math.sin(ang) * rad;
        c.vx = (Math.random() - 0.5) * 2.4;
        c.vy = 0;
        c.vz = (Math.random() - 0.5) * 2.4;
        c.spin = (Math.random() - 0.5) * 12;
        c.rx = Math.random() * 3; c.rz = Math.random() * 3;
      }
    } else { // листья: флаттер из кроны, чем сильнее удар — тем больше
      const n = 10 + Math.min(16, (speed - FALL_SPEED) * 2.5 | 0);
      for (let k = 0; k < n; k++) {
        // ещё летящие слоты не отбираем (лежащие — можно), иначе лист
        // телепортируется из середины падения в новую крону
        let idx = leafCursor, tries = 0;
        while (leafState[idx].live && tries++ < LEAVES) idx = (idx + 1) % LEAVES;
        leafCursor = (idx + 1) % LEAVES;
        const l = leafState[idx];
        const ang = Math.random() * Math.PI * 2, rad = tr.s * (0.5 + Math.random() * 1.8);
        l.live = true;
        l.t = Math.random() * 5; // фаза флаттера
        l.x = tr.x + Math.cos(ang) * rad;
        l.y = py + tr.h * (0.32 + Math.random() * 0.16); // самый низ кроны
        l.z = tr.z + Math.sin(ang) * rad;
        l.spin1 = 1.5 + Math.random() * 3; l.spin2 = 1 + Math.random() * 2;
        // цвет — кроны этого дерева (с учётом пикера листвы), чуть вразнобой
        _col.copy(tr.leaf || _fallbackGreen).multiply(treeTints.leaf.value);
        _col.offsetHSL((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.08);
        leaves.setColorAt(idx, _col);
      }
      if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    }
  }

  // ---------- существа, стряхиваемые с деревьев ----------
  const furMat = new THREE.MeshStandardNodeMaterial({ color: 0xa9622f, roughness: 0.9, flatShading: true });
  const blackMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c1a18, roughness: 0.85, flatShading: true });
  const whiteMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e4da, roughness: 0.8, flatShading: true });

  // — белка: падает и убегает
  const squirrels = [];
  function dropSquirrel(tr, py) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.2, 4, 6), furMat);
    body.rotation.z = Math.PI / 2;
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5), furMat);
    tail.scale.set(1, 1.9, 1);
    tail.position.set(-0.2, 0.12, 0);
    g.add(body, tail);
    g.position.set(tr.x + (Math.random() - 0.5), py + tr.h * 0.55, tr.z + (Math.random() - 0.5));
    scene.add(g);
    const dir = Math.random() * Math.PI * 2;
    squirrels.push({ g, state: 'fall', t: 0, vy: 0, dir, py });
    snd('squirrel', tr.x, tr.z, 0.9, 1.5);
  }

  // — скунс: на крышу игрока → в салон → спам пробела выкидывает
  const skunkHud = document.createElement('div');
  skunkHud.style.cssText = 'position:fixed;left:50%;top:20%;transform:translateX(-50%);'
    + 'font:bold 30px system-ui;color:#fff;text-shadow:0 2px 10px #000;display:none;z-index:20';
  skunkHud.textContent = 'СКУНС В САЛОНЕ! ЖМИ ПРОБЕЛ!';
  document.body.appendChild(skunkHud);
  const skunk = { state: 'idle', t: 0, presses: 0, cool: 0 };
  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.26, 4, 6), blackMat);
    body.rotation.z = Math.PI / 2;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.08), whiteMat);
    stripe.position.y = 0.1;
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), blackMat);
    tail.scale.set(1.6, 1, 1);
    tail.position.set(-0.26, 0.12, 0);
    g.add(body, stripe, tail);
    g.visible = false;
    scene.add(g);
    skunk.g = g;
  }
  function dropSkunk(tr, py) {
    if (skunk.state !== 'idle' || skunk.cool > 0) return;
    skunk.state = 'fall';
    skunk.t = 0;
    skunk.g.visible = true;
    skunk.g.position.set(tr.x, py + tr.h * 0.55, tr.z);
    skunk.from = skunk.g.position.clone();
    snd('skunkIn', tr.x, tr.z);
  }
  function skunkPress() {
    if (skunk.state !== 'inside') return;
    if (++skunk.presses >= 6) { // выкинули!
      skunk.state = 'flee';
      skunk.t = 0;
      skunk.presses = 0;
      skunkHud.style.display = 'none';
      skunk.g.visible = true;
      skunk.g.position.copy(playerCar.position).add(_p.set(0, 1.4, 0));
      skunk.dir = Math.random() * Math.PI * 2;
      snd('skunkOut', playerCar.position.x, playerCar.position.z);
    }
  }

  // — пчёлы: рой у кроны, потом по одной воруют груз с багажника
  const bees = { state: 'idle', list: [], t: 0, victim: 0 };
  function spawnBees(tr, py, carIdx) {
    if (bees.state !== 'idle') return;
    bees.state = 'swarm';
    bees.t = 0;
    bees.victim = carIdx;
    bees.tx = tr.x; bees.ty = py + tr.h * 0.6; bees.tz = tr.z;
    const n = 5 + (Math.random() * 2 | 0);
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), new THREE.MeshStandardNodeMaterial({ color: 0xe0b23a, roughness: 0.7, flatShading: true }));
      body.scale.set(1.35, 1, 1);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.2), blackMat);
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), whiteMat);
      wing.position.y = 0.12;
      wing.rotation.x = -Math.PI / 2.4;
      g.add(body, stripe, wing);
      g.position.set(bees.tx, bees.ty, bees.tz);
      scene.add(g);
      bees.list.push({ g, phase: Math.random() * 6, mode: 'orbit', t: 0 });
    }
    bees.hum = sounds && sounds.loop ? sounds.loop('bees') : null;
  }
  function killBees() {
    for (const b of bees.list) scene.remove(b.g);
    bees.list.length = 0;
    bees.state = 'idle';
    if (bees.hum) { bees.hum.stop(); bees.hum = null; }
  }

  let tNow = 0;
  // rammers: [{pos, vel}] — игрок и боты; деревья шатает любая машина
  function update(dt, rammers) {
    tNow += dt;

    for (const rm of rammers) {
      const carPos = rm.pos, vel = rm.vel;
      // скан деревьев — только на скорости; два раннихвыхода на дерево
      const sp2 = vel.x * vel.x + vel.z * vel.z;
      if (sp2 <= HIT_SPEED * HIT_SPEED) continue;
      const speed = Math.sqrt(sp2);
      const fx = vel.x / speed, fz = vel.z / speed;
      for (const tr of forest.trees) {
        const dx = tr.x - carPos.x;
        if (dx > 3.4 || dx < -3.4) continue;
        const dz = tr.z - carPos.z;
        if (dz > 3.4 || dz < -3.4) continue;
        if (tNow < (tr.cool || 0)) continue;
        // бокс по стволу: ствол прямо перед носом и в пределах ширины машины
        const lon = dx * fx + dz * fz;             // вдоль курса до ствола
        if (lon < 0 || lon > 2.6) continue;        // сзади или ещё далеко
        const lat = Math.abs(dx * fz - dz * fx);   // поперёк курса
        if (lat > tr.trunkR + 0.9) continue;       // проезжаем мимо ствола
        tr.cool = tNow + COOLDOWN;
        hit(tr, vel, speed, rammers.indexOf(rm));
      }
    }

    // качание: затухающий синус вокруг точки опоры ствола
    for (let i = shakes.length - 1; i >= 0; i--) {
      const sh = shakes[i];
      sh.t += dt;
      const k = Math.exp(-2.2 * sh.t);
      if (k < 0.02) {
        forest.mesh.setMatrixAt(sh.batchId, sh.base);
        shakes.splice(i, 1);
        continue;
      }
      const angle = Math.sin(sh.t * 13) * sh.amp * k;
      _rot.makeRotationAxis(_axis.set(sh.ax, 0, sh.az).normalize(), angle);
      _shift.makeTranslation(-sh.px, -sh.py, -sh.pz);
      _m.makeTranslation(sh.px, sh.py, sh.pz).multiply(_rot).multiply(_shift).multiply(sh.base);
      forest.mesh.setMatrixAt(sh.batchId, _m);
    }

    // листья: медленное падение с флаттером, на земле остаются лежать
    let leafDirty = false;
    for (let i = 0; i < LEAVES; i++) {
      const l = leafState[i];
      if (!l.live) continue;
      leafDirty = true;
      l.t += dt;
      l.x += Math.sin(l.t * 2.6) * dt * 0.9;
      l.z += Math.cos(l.t * 2.1) * dt * 0.7;
      l.y -= dt * (1.0 + Math.sin(l.t * 4) * 0.3);
      // земля — живым замером: флаттер уносит лист вбок, на склоне кеш врал бы
      const gy = terrainHeight(l.x, l.z) + 0.03;
      if (l.y <= gy) {
        l.y = gy;
        l.live = false; // лежит: последняя матрица остаётся в буфере
        _q.setFromEuler(_e.set(-Math.PI / 2 + (Math.random() - 0.5) * 0.5, Math.random() * Math.PI, 0));
      } else {
        _q.setFromEuler(_e.set(l.t * l.spin1, l.t * l.spin2, Math.sin(l.t * 3) * 0.8));
      }
      leaves.setMatrixAt(i, _m.compose(_p.set(l.x, l.y, l.z), _q, _s.setScalar(1)));
    }
    if (leafDirty) leaves.instanceMatrix.needsUpdate = true;

    // шишки: честная гравитация с парой отскоков
    let coneDirty = false;
    for (let i = 0; i < CONES; i++) {
      const c = coneState[i];
      if (!c.live) continue;
      coneDirty = true;
      c.vy -= 9.8 * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      c.rx += c.spin * dt;
      const gy = terrainHeight(c.x, c.z) + 0.06;
      if (c.y < gy && c.vy < 0) {
        c.y = gy;
        if (c.vy < -1.5) { // отскок
          c.vy *= -0.35;
          c.vx *= 0.55; c.vz *= 0.55; c.spin *= 0.5;
        } else {
          c.live = false; // улеглась
        }
      }
      cones.setMatrixAt(i, _m.compose(_p.set(c.x, c.y, c.z), _q.setFromEuler(_e.set(c.rx, 0, c.rz)), _s.setScalar(1)));
    }
    if (coneDirty) cones.instanceMatrix.needsUpdate = true;

    // — белки: падение, пробежка прыжками, исчезновение
    for (let i = squirrels.length - 1; i >= 0; i--) {
      const s = squirrels[i];
      s.t += dt;
      if (s.state === 'fall') {
        s.vy -= 9.8 * dt;
        s.g.position.y += s.vy * dt;
        const gy = terrainHeight(s.g.position.x, s.g.position.z) + 0.12;
        if (s.g.position.y <= gy) { s.g.position.y = gy; s.state = 'run'; s.t = 0; }
      } else if (s.state === 'run') {
        s.g.position.x += Math.cos(s.dir) * 7 * dt;
        s.g.position.z += Math.sin(s.dir) * 7 * dt;
        s.g.position.y = terrainHeight(s.g.position.x, s.g.position.z) + 0.12 + Math.abs(Math.sin(s.t * 11)) * 0.16;
        s.g.rotation.y = -s.dir;
        if (s.t > 2.5) { s.state = 'gone'; s.t = 0; }
      } else {
        s.g.scale.setScalar(Math.max(0.01, 1 - s.t / 0.3));
        if (s.t > 0.3) { scene.remove(s.g); squirrels.splice(i, 1); }
      }
    }

    // — скунс
    skunk.cool -= dt;
    if (skunk.state !== 'idle') {
      skunk.t += dt;
      if (skunk.state === 'fall') { // с кроны на крышу машины
        const k = Math.min(1, skunk.t / 0.7);
        _p.set(0.2, 1.5, 0).applyMatrix4(playerCar.matrixWorld);
        skunk.g.position.lerpVectors(skunk.from, _p, k);
        skunk.g.position.y += Math.sin(k * Math.PI) * 1.2;
        if (k >= 1) { skunk.state = 'roof'; skunk.t = 0; }
      } else if (skunk.state === 'roof') { // мгновение на крыше
        _p.set(0.2, 1.5, 0).applyMatrix4(playerCar.matrixWorld);
        skunk.g.position.copy(_p);
        if (skunk.t > 0.5) {
          skunk.state = 'inside'; // забежал в салон — хаос управления
          skunk.t = 0;
          skunk.presses = 0;
          skunk.g.visible = false;
          skunkHud.style.display = 'block';
        }
      } else if (skunk.state === 'flee') { // выкинут — убегает
        skunk.g.position.x += Math.cos(skunk.dir) * 8 * dt;
        skunk.g.position.z += Math.sin(skunk.dir) * 8 * dt;
        skunk.g.position.y = terrainHeight(skunk.g.position.x, skunk.g.position.z) + 0.14 + Math.abs(Math.sin(skunk.t * 9)) * 0.12;
        skunk.g.rotation.y = -skunk.dir;
        if (skunk.t > 2.2) {
          skunk.state = 'idle';
          skunk.cool = 20; // передышка перед следующим скунсом
          skunk.g.visible = false;
        }
      }
    }

    // — пчёлы
    if (bees.state !== 'idle') {
      bees.t += dt;
      const victim = rammers[bees.victim] ? rammers[bees.victim].pos : playerCar.position;
      const distTreeCar = Math.hypot(victim.x - bees.tx, victim.z - bees.tz);
      if (bees.hum) bees.hum.setPos(bees.tx, bees.tz); // жужжание из точки роя
      if (bees.state === 'swarm') { // кружат у кроны — время уехать!
        for (const b of bees.list) {
          b.g.position.set(
            bees.tx + Math.cos(bees.t * 2.2 + b.phase) * 1.6,
            bees.ty + Math.sin(bees.t * 3.1 + b.phase) * 0.7,
            bees.tz + Math.sin(bees.t * 2.2 + b.phase) * 1.6,
          );
        }
        if (bees.t > 3) {
          if (distTreeCar > 40) { bees.state = 'return'; bees.t = 0; } // успели уехать
          else bees.state = 'attack';
        }
      } else if (bees.state === 'attack') { // по одной летят воровать
        let allHome = true;
        bees.list.forEach((b, bi) => {
          if (b.mode === 'orbit') {
            b.g.position.set(
              bees.tx + Math.cos(bees.t * 2.2 + b.phase) * 1.6,
              bees.ty + Math.sin(bees.t * 3.1 + b.phase) * 0.7,
              bees.tz + Math.sin(bees.t * 2.2 + b.phase) * 1.6,
            );
            if (bees.t > bi * 1.2) b.mode = 'steal';
            allHome = false;
          } else if (b.mode === 'steal') {
            allHome = false;
            _p.set(victim.x, victim.y + 1.6, victim.z);
            const d = b.g.position.distanceTo(_p);
            if (d > 55) { b.mode = 'back'; return; } // отстала
            b.g.position.addScaledVector(_p.sub(b.g.position).normalize(), Math.min(13 * dt, d));
            if (d < 1.1) {
              food.stealCargo(bees.victim); // украла (или впустую, если пусто)
              b.mode = 'back';
            }
          } else if (b.mode === 'back') {
            _p.set(bees.tx, bees.ty, bees.tz);
            const d = b.g.position.distanceTo(_p);
            if (d < 1.5) { b.mode = 'home'; b.g.visible = false; }
            else { b.g.position.addScaledVector(_p.sub(b.g.position).normalize(), 13 * dt); allHome = false; }
          }
        });
        if (allHome) killBees();
      } else if (bees.state === 'return') { // жертва уехала — рой расходится
        for (const b of bees.list) b.g.position.y += dt * 2;
        if (bees.t > 1.2) killBees();
      }
    }
  }

  return { update, skunkPress, skunkActive: () => skunk.state === 'inside' };
}
