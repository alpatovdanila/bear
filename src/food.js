import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainHeight, LAKE_LEVEL, lakeEdgeR, BASE_SPOTS } from './terrain.js';

// Добыча и логистика: рыба выпрыгивает из прудика, ягоды разлетаются из
// ЯГОДНЫХ кустов (один раз с куста), сбитые грибы и золотые шишки — лут.
// Лежащий лут крутится над жёлтым кольцом, как в видеоиграх; ловить можно
// и налету. Багажник растёт слоями без лимита; своя база принимает груз
// в стопки по типам. Переворот и тараны конкурентов рассыпают груз.

export { BASE_SPOTS }; // ре-экспорт: потребители еды знают, где базы

const BERRIES = 64, FISH_MAX = 4, GOLD_MAX = 6;
const FISH_SCALE = 1.9, BERRY_SCALE = 2.3; // в мире — крупные, чтобы было видно
const FISH_EVERY = [16, 30];  // редкая рыба: интервал спавна, сек
const FLIP_TIME = 0.6;        // сек вверх колёсами до потери груза
const CRASH_COOLDOWN = 2;

// cars: [{ car, rack, color, getVel }] — игрок первым, дальше боты
export function createFood(scene, world, forest, cars, sounds) {
  // — рыбка: вытянутое тело + плоский хвост, полосатая канвас-текстура
  const fishGeo = (() => {
    const body = new THREE.SphereGeometry(0.16, 8, 6);
    body.scale(1.9, 0.75, 0.55);
    const tail = new THREE.ConeGeometry(0.13, 0.26, 4);
    tail.rotateZ(-Math.PI / 2);
    tail.scale(1, 1, 0.3);
    tail.translate(-0.42, 0, 0);
    return mergeGeometries([body.toNonIndexed(), tail.toNonIndexed()]);
  })();
  const fishMat = (() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 32); // спинка темнее брюха
    grad.addColorStop(0, '#5f7f96');
    grad.addColorStop(0.55, '#9db8c9');
    grad.addColorStop(1, '#d8e2e8');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = 'rgba(52,74,92,0.55)'; // полосы
    for (let x = 8; x < 60; x += 9) ctx.fillRect(x, 2, 3.5, 22);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.35, metalness: 0.35, flatShading: true });
  })();
  const berryGeo = new THREE.SphereGeometry(0.1, 6, 5);
  const berryMat = new THREE.MeshLambertNodeMaterial({ color: 0xd0302e });
  // золотая шишка — самый ценный лут
  const goldGeo = new THREE.SphereGeometry(0.16, 7, 6);
  goldGeo.scale(0.8, 1.25, 0.8);
  const goldMat = new THREE.MeshStandardNodeMaterial({ color: 0xe3b23c, roughness: 0.25, metalness: 0.9 });

  const fish = [];
  for (let i = 0; i < FISH_MAX; i++) {
    const mesh = new THREE.Mesh(fishGeo, fishMat);
    // сначала курс (Y), потом «на бок» (X) в локальной системе:
    // с дефолтным XYZ при курсе ≠ 0 бок превращался в тангаж — рыба торчком
    mesh.rotation.order = 'YXZ';
    mesh.visible = false;
    scene.add(mesh);
    fish.push({ mesh, state: 'idle', t: 0 });
  }
  let fishTimer = 8;

  const berries = new THREE.InstancedMesh(berryGeo, berryMat, BERRIES);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < BERRIES; i++) berries.setMatrixAt(i, hidden);
  berries.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  berries.frustumCulled = false;
  scene.add(berries);
  const berryState = Array.from({ length: BERRIES }, () => ({ live: false, lying: false }));
  let berryCursor = 0;

  const golds = [];
  for (let i = 0; i < GOLD_MAX; i++) {
    const mesh = new THREE.Mesh(goldGeo, goldMat);
    mesh.visible = false;
    mesh.scale.setScalar(1.6);
    scene.add(mesh);
    golds.push({ mesh, live: false, lying: false });
  }

  const lyingShrooms = []; // сбитые и приземлившиеся грибы: {x, z, gi, mesh}

  // жёлтые кольца-подложки под ВЕСЬ лежащий лут — один InstancedMesh
  const RINGS = 96;
  const ringGeo = new THREE.TorusGeometry(0.34, 0.035, 6, 22);
  ringGeo.rotateX(Math.PI / 2);
  const rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicNodeMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 }), RINGS);
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rings.frustumCulled = false;
  scene.add(rings);

  const _m = new THREE.Matrix4(), _p = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  const _up = new THREE.Vector3();
  let tNow = 0;

  const snd = (name, x, z, vol = 1, rate = 1) =>
    sounds && sounds.play(name, { vol, rate, x, z }); // 3D: позиция события

  // — база: платформа цвета медведя, столбики, флаг; свой коллайдер
  function makeBase(spot, color) {
    const g = new THREE.Group();
    const y = terrainHeight(spot.x, spot.z);
    g.position.set(spot.x, y, spot.z);
    const teamCol = new THREE.Color(color);
    const platMat = new THREE.MeshLambertNodeMaterial({ color: teamCol.clone().lerp(new THREE.Color(0x9a9a9a), 0.35) });
    const brightMat = new THREE.MeshLambertNodeMaterial({ color: teamCol, side: THREE.DoubleSide });
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.5, 0.5, 18), platMat);
    plat.position.y = 0.05;
    g.add(plat);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.3, 8), platMat);
      post.position.set(Math.cos(a) * 4.5, 0.9, Math.sin(a) * 4.5);
      g.add(post);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.0, 8), platMat);
    pole.position.set(0, 1.7, 0);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), brightMat);
    flag.position.set(0.45, 2.9, 0);
    g.add(flag);
    scene.add(g);
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(0.25, 5.25).setTranslation(spot.x, y + 0.05, spot.z),
      world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
    );
    return { group: g, x: spot.x, z: spot.z };
  }

  const st = cars.map((c, i) => ({
    ...c, i,
    cargo: [],  // {kind, gi, mesh} на багажнике
    flipT: 0,
    base: makeBase(BASE_SPOTS[i], c.color),
    score: { fish: 0, berries: 0, shrooms: 0, gold: 0 },
    crashCool: 0,
  }));

  const rackMesh = (kind, gi) => {
    let m;
    if (kind === 'fish') {
      m = new THREE.Mesh(fishGeo, fishMat);
      m.scale.setScalar(0.85);
      m.rotation.order = 'YXZ'; // курс, потом «на бок» — строго плашмя
      m.rotation.set(Math.PI / 2, Math.random() * 0.6 - 0.3, 0);
    } else if (kind === 'shroom') {
      m = new THREE.Mesh(forest.shroomGeos[gi || 0], forest.material);
      m.scale.setScalar(0.9);
      m.rotation.set(0, Math.random() * Math.PI, 1.5); // лёжа на боку
    } else if (kind === 'gold') {
      m = new THREE.Mesh(goldGeo, goldMat);
      m.rotation.set(0, Math.random() * Math.PI, 1.5);
    } else {
      m = new THREE.Mesh(berryGeo, berryMat);
      m.scale.setScalar(1.15);
    }
    return m;
  };

  // погрузка на багажник: слоями вверх без лимита
  function addCargo(s, kind, gi) {
    const slot = s.cargo.length;
    const layer = (slot / 12) | 0, si = slot % 12;
    const col = (si / 3) | 0, row = si % 3;
    const mesh = rackMesh(kind, gi);
    mesh.position.set(-0.5 + col * 0.34, 0.17 + layer * 0.2, -0.34 + row * 0.34);
    s.rack.add(mesh);
    s.cargo.push({ kind, gi, mesh });
    return true;
  }

  // сдача: стопки одного типа по секторам платформы
  const SECTORS = { fish: 0, berries: 1, shrooms: 2, gold: 3 };
  function deliver(s) {
    for (const it of s.cargo) {
      s.rack.remove(it.mesh);
      const key = it.kind === 'fish' ? 'fish' : it.kind === 'shroom' ? 'shrooms' : it.kind === 'gold' ? 'gold' : 'berries';
      const n = s.score[key]++;
      const a = (SECTORS[key] / 4) * Math.PI * 2 + Math.PI / 8;
      const cell = n % 4, high = (n / 4) | 0; // 2×2 у основания, дальше — вверх
      it.mesh.position.set(
        Math.cos(a) * 2.3 + (cell % 2) * 0.45 - 0.22,
        0.42 + high * 0.22,
        Math.sin(a) * 2.3 + ((cell / 2) | 0) * 0.45 - 0.22,
      );
      if (it.kind === 'fish') {
        it.mesh.rotation.order = 'YXZ';
        it.mesh.rotation.set(Math.PI / 2, (n % 6) * 1.05, 0); // плашмя в стопке
      }
      s.base.group.add(it.mesh);
    }
    if (s.cargo.length) snd('deliver', s.base.x, s.base.z, 0.9);
    s.cargo.length = 0;
  }

  // потерять несколько верхних предметов (переворот — все, таран — часть)
  function scatterCargo(s, count = Infinity) {
    const p = s.car.position;
    let dropped = 0;
    while (s.cargo.length && dropped < count) {
      const it = s.cargo.pop();
      dropped++;
      s.rack.remove(it.mesh);
      const a = Math.random() * Math.PI * 2, r = 1.6 + Math.random() * 2.4;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (it.kind === 'berry') {
        const idx = takeBerrySlot();
        const bs = berryState[idx];
        bs.live = true; bs.lying = true; bs.rot = Math.random() * 6;
        bs.x = x; bs.y = terrainHeight(x, z) + 0.08 * BERRY_SCALE; bs.z = z;
      } else if (it.kind === 'fish') {
        const f = fish.find((ff) => ff.state === 'idle');
        if (f) {
          f.ex = x; f.ez = z; f.ey = terrainHeight(x, z) + 0.1;
          f.t = 0; f.life = 25; f.flopPhase = Math.random() * 10;
          f.heading = Math.random() * Math.PI * 2;
          f.state = 'flop';
          f.mesh.visible = true;
          f.mesh.scale.setScalar(FISH_SCALE);
        }
      } else if (it.kind === 'gold') {
        spawnGold(x, z, 0);
      } else { // гриб ложится в мир
        it.mesh.position.set(x, terrainHeight(x, z) + 0.12, z);
        it.mesh.rotation.set(0, Math.random() * Math.PI, 1.5);
        it.mesh.rotation.order = 'YXZ';
        it.mesh.scale.setScalar(1.3);
        scene.add(it.mesh);
        lyingShrooms.push({ x, z, gi: it.gi, mesh: it.mesh });
      }
    }
    if (dropped) snd('scatter', p.x, p.z);
  }

  function takeBerrySlot() {
    let idx = berryCursor, tries = 0;
    while (berryState[idx].live && tries++ < BERRIES) idx = (idx + 1) % BERRIES;
    berryCursor = (idx + 1) % BERRIES;
    return idx;
  }

  // сбитый гриб приземлился (main) — лежит горизонтально, ждёт погрузки
  function addLyingShroom(mesh, gi) {
    mesh.rotation.set(0, Math.random() * Math.PI, 1.5);
    mesh.rotation.order = 'YXZ';
    lyingShrooms.push({ x: mesh.position.x, z: mesh.position.z, gi, mesh });
  }

  // золотая шишка из кроны хвойного (impacts) — падает и лежит лутом
  function spawnGold(x, z, vy = 1.5) {
    const g = golds.find((gg) => !gg.live);
    if (!g) return;
    g.live = true; g.lying = vy === 0;
    g.x = x; g.z = z;
    g.y = g.lying ? terrainHeight(x, z) + 0.22 : terrainHeight(x, z) + 6;
    g.vy = vy; g.rot = Math.random() * 6;
    g.mesh.visible = true;
    if (!g.lying) snd('gold', x, z, 0.65);
  }

  function spawnFish(f) {
    const a = Math.random() * Math.PI * 2;
    const edge = lakeEdgeR(Math.cos(a) * 20, Math.sin(a) * 20);
    const r0 = Math.max(4, edge - 4), r1 = edge + 2 + Math.random() * 2.5;
    f.sx = Math.cos(a) * r0; f.sz = Math.sin(a) * r0;
    f.ex = Math.cos(a) * r1; f.ez = Math.sin(a) * r1;
    f.ey = terrainHeight(f.ex, f.ez) + 0.1;
    f.t = 0;
    f.life = 22 + Math.random() * 8;
    f.flopPhase = Math.random() * 10;
    f.heading = Math.atan2(f.ez - f.sz, f.ex - f.sx);
    f.state = 'jump';
    f.mesh.visible = true;
    f.mesh.scale.setScalar(FISH_SCALE);
    snd('splash', f.sx, f.sz);
  }

  // ближайшая лежащая добыча — для AI ботов
  function nearestPickup(x, z, maxR) {
    let best = null, bd = maxR * maxR;
    const consider = (px, pz) => {
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bd) { bd = d; best = { x: px, z: pz }; }
    };
    for (let i = 0; i < BERRIES; i++) if (berryState[i].live && berryState[i].lying) consider(berryState[i].x, berryState[i].z);
    for (const f of fish) if (f.state === 'flop') consider(f.ex, f.ez);
    for (const sh of lyingShrooms) consider(sh.x, sh.z);
    for (const g of golds) if (g.live && g.lying) consider(g.x, g.z);
    return best;
  }

  // пчёлы (impacts) воруют верхний предмет с багажника
  function stealCargo(i) {
    const s = st[i];
    if (!s.cargo.length) return false;
    const it = s.cargo.pop();
    s.rack.remove(it.mesh);
    return true;
  }

  function update(dt) {
    tNow += dt;
    let ringN = 0;
    const ring = (x, y, z) => {
      if (ringN >= RINGS) return;
      rings.setMatrixAt(ringN++, _m.compose(_p.set(x, y, z), _q.identity(), _s.setScalar(1)));
    };

    // — рыба: редкий спавн и анимация
    fishTimer -= dt;
    if (fishTimer <= 0) {
      const f = fish.find((ff) => ff.state === 'idle');
      if (f) spawnFish(f);
      fishTimer = FISH_EVERY[0] + Math.random() * (FISH_EVERY[1] - FISH_EVERY[0]);
    }
    for (const f of fish) {
      if (f.state === 'idle') continue;
      f.t += dt;
      const m = f.mesh;
      if (f.state === 'jump') {
        const k = Math.min(1, f.t / 1.15);
        m.position.set(
          f.sx + (f.ex - f.sx) * k,
          LAKE_LEVEL + (f.ey - LAKE_LEVEL) * k + Math.sin(k * Math.PI) * 2.3,
          f.sz + (f.ez - f.sz) * k,
        );
        m.rotation.set(0, -f.heading, k * Math.PI * 2 * 1.25);
        if (k >= 1) { f.state = 'flop'; f.t = 0; snd('fishFlop', f.ex, f.ez, 0.7); }
      } else if (f.state === 'flop') {
        const calm = Math.max(0, 1 - f.t / f.life);
        const hop = Math.abs(Math.sin(f.t * 6 + f.flopPhase)) * 0.16 * calm;
        m.position.set(f.ex, f.ey + hop, f.ez);
        m.rotation.set(Math.PI / 2 * 0.85, -f.heading + Math.sin(f.t * 6 + f.flopPhase) * 0.4 * calm, 0);
        ring(f.ex, f.ey - 0.06, f.ez);
        if (f.t > f.life) { f.state = 'gone'; f.t = 0; }
      } else if (f.state === 'gone') {
        const k = 1 - f.t / 0.4;
        if (k <= 0) { f.state = 'idle'; m.visible = false; }
        else m.scale.setScalar(k * FISH_SCALE);
      }
    }

    // — машины: флип, сдача, кусты, сборы, тараны друг друга
    for (const s of st) {
      const p = s.car.position;
      const v = s.getVel();
      const sp2 = v.x * v.x + v.z * v.z;
      s.crashCool -= dt;

      // переворот — рассыпаем весь груз
      _up.set(0, 1, 0).applyQuaternion(s.car.quaternion);
      if (_up.y < 0.2) {
        s.flipT += dt;
        if (s.flipT > FLIP_TIME && s.cargo.length) {
          snd('flip', p.x, p.z);
          scatterCargo(s);
        }
      } else s.flipT = 0;

      // сдача на своей базе
      const bdx = p.x - s.base.x, bdz = p.z - s.base.z;
      if (bdx * bdx + bdz * bdz < 27 && s.cargo.length) deliver(s);

      // таран ягодного куста: половина ягод сразу в багажник, половина в разлёт
      if (sp2 > 4) {
        for (const b of forest.bushes) {
          const dx = b.x - p.x;
          if (dx > 2 || dx < -2) continue;
          const dz = b.z - p.z;
          if (dz > 2 || dz < -2) continue;
          if (dx * dx + dz * dz > (1.1 * b.s + 0.9) ** 2) continue;
          if (b.spent) continue;
          snd('bushRustle', b.x, b.z);
          if (!b.berry) { b.spent = true; continue; } // не ягодный — только шорох
          b.spent = true; // ягоды с куста — один раз, ищите следующий
          if (forest.bushPlainGi !== undefined && forest.mesh.setGeometryIdAt) {
            forest.mesh.setGeometryIdAt(b.batchId, forest.bushPlainGi); // куст «обобран»
          }
          const n = 5 + (Math.random() * 4 | 0);
          for (let k = 0; k < n; k++) {
            if (k < n / 2) { addCargo(s, 'berry'); continue; } // сбор в момент отрыва
            const idx = takeBerrySlot();
            const s2 = berryState[idx];
            const ang = Math.random() * Math.PI * 2;
            s2.live = true; s2.lying = false; s2.rot = Math.random() * 6;
            s2.x = b.x; s2.y = terrainHeight(b.x, b.z) + 0.7 * b.s; s2.z = b.z;
            s2.vx = Math.cos(ang) * (1.5 + Math.random() * 2);
            s2.vz = Math.sin(ang) * (1.5 + Math.random() * 2);
            s2.vy = 2.5 + Math.random() * 2;
          }
          snd('scatter', b.x, b.z, 0.8);
        }
      }

      // сбор рыбы (флоп)
      for (const f of fish) {
        if (f.state !== 'flop') continue;
        const dx = f.ex - p.x, dz = f.ez - p.z;
        if (dx * dx + dz * dz < 1.9) {
          addCargo(s, 'fish');
          f.state = 'idle';
          f.mesh.visible = false;
          snd('pickup', f.ex, f.ez);
        }
      }
      // сбор грибов
      for (let i = lyingShrooms.length - 1; i >= 0; i--) {
        const sh = lyingShrooms[i];
        const dx = sh.x - p.x, dz = sh.z - p.z;
        if (dx * dx + dz * dz < 1.8) {
          scene.remove(sh.mesh);
          lyingShrooms.splice(i, 1);
          addCargo(s, 'shroom', sh.gi);
          snd('pickup', sh.x, sh.z);
        }
      }
      // сбор золота
      for (const g of golds) {
        if (!g.live) continue;
        const dx = g.x - p.x, dz = g.z - p.z;
        if (dx * dx + dz * dz < 2.1) {
          g.live = false;
          g.mesh.visible = false;
          addCargo(s, 'gold');
          snd('gold', g.x, g.z);
        }
      }
    }

    // столкновение машин: медленный теряет груз с шансом по разнице скоростей
    for (let a = 0; a < st.length; a++) {
      for (let b = a + 1; b < st.length; b++) {
        const A = st[a], B = st[b];
        const dx = A.car.position.x - B.car.position.x;
        const dz = A.car.position.z - B.car.position.z;
        // 16 = (~4 м)²: кубоиды шасси 3.8 м нос-в-корму — солвер не даёт
        // центрам сблизиться до старого порога 2.7 м, тараны не считались
        if (dx * dx + dz * dz > 16) continue;
        const va = A.getVel(), vb = B.getVel();
        // это контакт, только если машины сближаются (не параллельная езда)
        if (dx * (va.x - vb.x) + dz * (va.z - vb.z) >= 0) continue;
        if (A.crashCool > 0 || B.crashCool > 0) continue;
        A.crashCool = B.crashCool = CRASH_COOLDOWN;
        const sa = Math.hypot(va.x, va.z), sb = Math.hypot(vb.x, vb.z);
        const dv = Math.abs(sa - sb);
        if (dv < 2.5) continue;
        snd('carCrash', A.car.position.x, A.car.position.z);
        const loser = sa < sb ? A : B;
        if (Math.random() < Math.min(0.85, dv / 14)) {
          scatterCargo(loser, dv > 9 ? 2 : 1);
        }
      }
    }

    // — ягоды: полёт (ловятся налету), лежание с вращением, сбор
    let dirty = false;
    for (let i = 0; i < BERRIES; i++) {
      const s2 = berryState[i];
      if (!s2.live) continue;
      dirty = true;
      if (!s2.lying) {
        s2.vy -= 9.8 * dt;
        s2.x += s2.vx * dt; s2.y += s2.vy * dt; s2.z += s2.vz * dt;
        const gy = terrainHeight(s2.x, s2.z) + 0.08 * BERRY_SCALE;
        if (s2.y < gy && s2.vy < 0) { s2.y = gy; s2.lying = true; }
      } else {
        s2.rot += dt * 1.6; // лут крутится
        ring(s2.x, s2.y - 0.14, s2.z);
      }
      // сбор любой машиной — и лежащей, и летящей ягоды
      for (const s of st) {
        const dx = s2.x - s.car.position.x, dz = s2.z - s.car.position.z;
        if (dx * dx + dz * dz < 1.7) {
          s2.live = false;
          berries.setMatrixAt(i, hidden);
          addCargo(s, 'berry');
          snd('berryPop', s2.x, s2.z);
          break;
        }
      }
      if (s2.live) {
        berries.setMatrixAt(i, _m.compose(
          _p.set(s2.x, s2.y + (s2.lying ? Math.sin(tNow * 2.3 + i) * 0.05 : 0), s2.z),
          _q.setFromEuler(_e.set(0, s2.rot || 0, 0)),
          _s.setScalar(BERRY_SCALE),
        ));
      }
    }
    if (dirty) berries.instanceMatrix.needsUpdate = true;

    // — золото: падение и лут-вращение
    for (const g of golds) {
      if (!g.live) continue;
      if (!g.lying) {
        g.vy -= 9.8 * dt;
        g.y += g.vy * dt;
        const gy = terrainHeight(g.x, g.z) + 0.22;
        if (g.y < gy && g.vy < 0) { g.y = gy; g.lying = true; }
        g.mesh.rotation.x += dt * 5;
      } else {
        g.rot += dt * 1.6;
        g.mesh.rotation.set(0, g.rot, 1.5);
        g.mesh.rotation.order = 'YXZ';
        g.mesh.position.y = g.y + Math.sin(tNow * 2.1) * 0.06;
        ring(g.x, g.y - 0.18, g.z);
      }
      g.mesh.position.x = g.x; g.mesh.position.z = g.z;
      if (!g.lying) g.mesh.position.y = g.y;
    }

    // — грибы-лут: вращение над кольцом
    for (const sh of lyingShrooms) {
      sh.mesh.rotation.y += dt * 1.6;
      ring(sh.x, sh.mesh.position.y - 0.08, sh.z);
    }

    // спрятать неиспользуемые кольца
    for (let i = ringN; i < RINGS; i++) rings.setMatrixAt(i, hidden);
    rings.instanceMatrix.needsUpdate = true;
  }

  return {
    update, addLyingShroom, nearestPickup, spawnGold, stealCargo,
    grabShroom: (i, gi) => addCargo(st[i], 'shroom', gi), // поймал налету
    cargoCount: (i) => st[i].cargo.length,
    baseOf: (i) => BASE_SPOTS[i],
    scores: st.map((s) => s.score),
    playerState: () => st[0],
  };
}
