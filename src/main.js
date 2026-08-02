import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, uniform } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { createForest, applyForestShadows, treeTints, TINT_BASES } from './trees.js';
import { createWildlife } from './wildlife.js';
import {
  createTerrain, terrainHeight, onLand, inLake, bakeGrassShadows, applyGroundLook,
  shadowStrength, groundTint, GROUND_BASE, SIZE, SEA_LEVEL, LAKE_LEVEL, BASE_SPOTS,
} from './terrain.js';
import { createGrass, grassColors, grassHeight, grassBands } from './grass.js';
import { createCarMesh, applyCarShade, setBrakeLights } from './car.js';
import { Vehicle, TUNE } from './vehicle.js';
import { createSmoke } from './smoke.js';
import { createImpacts } from './impacts.js';
import { waterMaterial } from './water.js';
import { createFood } from './food.js';
import { createBots, updateBot, BOT_COLORS } from './bots.js';
import { createMinimap } from './minimap.js';
import { createSounds } from './sounds.js';
import { createEngineSound } from './engine-sound.js';
import { sliderPanel, colorPanel } from './ui.js';

await RAPIER.init();

const renderer = new THREE.WebGPURenderer({ antialias: true, trackTimestamp: true });
renderer.setSize(innerWidth, innerHeight);
// стартуем с 1: на ретине dpr=2 означает ×4 пикселей (и GTAO по ним же) —
// на интеграшках это разница между 30 и 120 fps; ползунок «масштаб рендера»
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping; // дропдаун в панели «Картинка»
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap; // жёсткая тень без смягчения
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
// лёгкая воздушная дымка — даёт кадру глубину; дальность крутится ползунком
scene.fog = new THREE.Fog(0xaec7d6, 70, 420);
scene.background = new THREE.Color(0x9ec1e0);
scene.fog = new THREE.Fog(0x9ec1e0, 160, 850);

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 1800);

// GTAO поверх сцены + ползунки настройки
const postProcessing = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, normal: normalView }));
const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
const aoPow = uniform(1);
// денойз глушит белые каймы на силуэтах (артефакт скринспейс-АО)
const aoDenoised = denoise(
  aoPass.getTextureNode(),
  scenePass.getTextureNode('depth'),
  scenePass.getTextureNode('normal'),
  camera,
);
// два выхода: с GTAO и без; при интенсивности 0 AO-пассы не исполняются вовсе
const outputWithAO = scenePass.getTextureNode('output').mul(aoDenoised.r.pow(aoPow));
const outputPlain = scenePass.getTextureNode('output');
postProcessing.outputNode = outputWithAO;

// Свет: IBL с небесной панорамы (сконвертирована из OpenImageIO .tx в .hdr)
const envTex = await new RGBELoader().setDataType(THREE.FloatType).loadAsync('sky_linekotsi_07_HDRI.hdr');
envTex.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = envTex;
scene.background = envTex; // скайбокс — сама панорама

// Солнце — самая яркая точка панорамы. Света не даёт (светит IBL),
// нужно только как направление для запечённых теней.
function findSunDir(tex) {
  const { data, width, height } = tex.image;
  let best = -1, bi = 0;
  for (let i = 0; i < width * height; i++) {
    const l = data[i * 4] + data[i * 4 + 1] * 2 + data[i * 4 + 2] * 0.5;
    if (l > best) { best = l; bi = i; }
  }
  const u = ((bi % width) + 0.5) / width;
  const v = (Math.floor(bi / width) + 0.5) / height;
  const lat = (v - 0.5) * Math.PI;
  const az = (u - 0.5) * 2 * Math.PI;
  const cl = Math.cos(lat);
  const dir = new THREE.Vector3(Math.cos(az) * cl, Math.sin(lat), Math.sin(az) * cl);
  dir.y = Math.max(Math.abs(dir.y), 0.15); // солнце — над горизонтом
  return dir.normalize();
}
const sunDir = findSunDir(envTex);
// солнце пониже — длинные читаемые тени (высокое полуденное их прячет под кронами)
sunDir.y = Math.min(sunDir.y, 0.42);
sunDir.normalize();

// Солнце — направленный свет; тени мира запечены в террейн, а динамическую
// тень кастит ТОЛЬКО машина: узкий плотный фрустум едет за ней (за подсказку
// про молчаливый depth-range тест спасибо расследованию по исходникам three)
scene.environmentIntensity = 0.55; // окружение — ambient-подсветка
const sun = new THREE.DirectionalLight(0xfff1d8, 1.5);
sun.position.copy(sunDir).multiplyScalar(300);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const shCam = sun.shadow.camera;
shCam.left = shCam.bottom = -25;
shCam.right = shCam.top = 25;
shCam.near = 1;
shCam.far = 800;
shCam.updateProjectionMatrix();
sun.shadow.bias = -0.002;
sun.shadow.normalBias = 0.3;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfe0f0, 0x59703a, 0.5);
scene.add(hemi);

// панель «Картинка»: значения сохраняются в localStorage
sliderPanel('Картинка', 360, [
  ['radius', 'GTAO радиус', 0.05, 2.5, 0.05],
  ['thickness', 'GTAO толщина', 0.1, 3, 0.5771],
  ['scale', 'GTAO интенсивность', 0, 3, 0.414],
  ['pow', 'GTAO жёсткость', 0.3, 4, 0.9065],
  ['env', 'окружение / небо', 0, 4, 4],
  ['shadow', 'интенсивность теней', 0, 1, 0.884],
  ['grassH', 'высота травы', 0.3, 2.5, 1.4454],
  ['fog', 'туманчик', 0, 1, 1],
  ['pixels', 'масштаб рендера', 0.5, 2, 1],
], (key, v) => {
  if (key === 'pow') aoPow.value = v;
  else if (key === 'grassH') grassHeight.value = v;
  else if (key === 'env') {
    // HDRI — единственный источник света: солнце и небо масштабируются вместе
    scene.environmentIntensity = v;
    scene.backgroundIntensity = v;
    hemi.intensity = v * 0.9;
    sun.intensity = v * 2.7; // ~6.8 при дефолтных 2.52
  }
  else if (key === 'shadow') { shadowStrength.value = v; sun.shadow.intensity = v; }
  else if (key === 'fog') { // 0 — без дымки, 1 — плотная
    scene.fog.near = 160 - v * 130;   // 160..30
    scene.fog.far = 900 - v * 560;    // 900..340
  }
  else if (key === 'pixels') renderer.setPixelRatio(v); // 1 = размер окна; ретина = 2
  else if (key === 'scale') {
    // на нуле выкидываем AO-пассы из графа целиком — они не считаются
    postProcessing.outputNode = v <= 0.001 ? outputPlain : outputWithAO;
    postProcessing.needsUpdate = true;
    if (aoPass.scale?.value !== undefined) aoPass.scale.value = v;
    else aoPass.scale = v;
  }
  else if (aoPass[key]?.value !== undefined) aoPass[key].value = v;
  else aoPass[key] = v;
}).appendChild((() => {
  // дропдаун тонмаппера
  const row = document.createElement('label');
  row.style.cssText = 'display:block;margin-top:8px';
  row.textContent = 'тонмаппинг ';
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:4px;margin-top:2px';
  const maps = {
    None: THREE.NoToneMapping,
    ACES: THREE.ACESFilmicToneMapping,
    AgX: THREE.AgXToneMapping,
    Neutral: THREE.NeutralToneMapping,
    Reinhard: THREE.ReinhardToneMapping,
  };
  for (const name of Object.keys(maps)) sel.add(new Option(name, name));
  sel.value = localStorage.getItem('bear.tonemap') || 'Neutral';
  const apply = () => {
    renderer.toneMapping = maps[sel.value];
    postProcessing.needsUpdate = true;
    localStorage.setItem('bear.tonemap', sel.value);
  };
  sel.onchange = apply;
  apply();
  row.appendChild(sel);
  return row;
})());

// панель «Цвета»: травинки, земля, лес. Тинты калиброваны так, что пикер
// показывает итоговый средний цвет соответствующей поверхности
{
  const ratioTint = (hex, baseHex, u) => {
    const p = new THREE.Color(hex), b = new THREE.Color(baseHex);
    u.value.setRGB(
      Math.min(4, p.r / Math.max(b.r, 1e-3)),
      Math.min(4, p.g / Math.max(b.g, 1e-3)),
      Math.min(4, p.b / Math.max(b.b, 1e-3)),
    );
  };
  const hexOf = (n) => '#' + n.toString(16).padStart(6, '0');
  colorPanel('Цвета', 620, [
    ['root', 'травинки: корень', '#244601'],
    ['tip', 'травинки: кончик', '#3b7105'],
    ['far', 'дальняя трава', '#1f3d00'],
    ['ground', 'земля (трава)', '#244601'],
    ['conifer', 'хвоя', '#3a7e15'],
    ['coniferTrunk', 'ствол хвойных', hexOf(TINT_BASES.coniferTrunk)],
    ['leaf', 'листва лиственных', '#55c11a'],
    ['leafTrunk', 'ствол дуба/липы', '#8c6940'],
    ['birchTrunk', 'ствол берёзы', '#ffffff'],
  ], (key, hex) => {
    if (key === 'root') grassColors.root.value.set(hex);
    else if (key === 'tip') grassColors.tip.value.set(hex);
    else if (key === 'far') grassColors.ground.value.set(hex);
    else if (key === 'ground') ratioTint(hex, GROUND_BASE, groundTint);
    else ratioTint(hex, TINT_BASES[key], treeTints[key]);
  });
}

// панель физики машины (слева, с кнопкой сброса) — правит TUNE вживую
sliderPanel('Физика', 12, [
  ['enginePower', 'мощность, Вт', 20000, 150000, 60000],
  ['engineMaxForce', 'тяга, Н', 2000, 12000, 5200],
  ['topSpeed', 'максималка, м/с', 10, 45, 75 / 3.6],
  ['brakeForce', 'тормоза, Н', 3000, 20000, 10500],
  ['springK', 'пружины, Н/м', 8000, 60000, 13988],
  ['dampComp', 'демпфер сжатия', 500, 6000, 2282.5],
  ['dampRebound', 'демпфер отбоя', 500, 8000, 2745],
  ['muF', 'сцепление перед', 0.4, 2, 1.05],
  ['muR', 'сцепление зад', 0.4, 2, 0.95],
  ['corneringCoef', 'отклик шин', 5, 30, 16],
  ['maxSteer', 'угол руля, рад', 0.2, 1, 0.6],
], (key, v) => {
  if (key === 'muF') { TUNE.muLat[0] = v; TUNE.muLat[1] = v; }
  else if (key === 'muR') { TUNE.muLat[2] = v; TUNE.muLat[3] = v; }
  else TUNE[key] = v;
}, { left: true, reset: true });


// Физика
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// Террейн
// стадии загрузки на сплэше; setTimeout (не rAF!) — чтобы текст успел
// отрисоваться на видимой вкладке, а фоновая вкладка не зависла навсегда
const stage = (t) => {
  window.__loadStage?.(t);
  return new Promise((r) => setTimeout(r, 30));
};
await stage('Лепим остров…');
const terrain = createTerrain();
scene.add(terrain.mesh);
world.createCollider(
  RAPIER.ColliderDesc.trimesh(terrain.vertices, terrain.indices),
  world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
);

// Невидимые стены на самом краю мира (за морем), чтобы не выпасть из него
const walls = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
for (const [hx, hz, x, z] of [
  [5, 510, 500, 0], [5, 510, -500, 0], [510, 5, 0, 500], [510, 5, 0, -500],
]) {
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 80, hz).setTranslation(x, 0, z), walls);
}

// Море вокруг острова: широкая рябь покрупнее
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  waterMaterial({ color: 0x2e6f95, amp: 0.16, scale: 0.35, speed: 0.5 }),
);
water.rotation.x = -Math.PI / 2;
water.position.y = SEA_LEVEL;
scene.add(water);

// Озеро в центральной опушке: почти штиль, рябь мельче и тише
const lake = new THREE.Mesh(
  new THREE.CircleGeometry(27, 48),
  waterMaterial({ color: 0x2f7386, amp: 0.07, scale: 0.9, speed: 0.3 }),
);
lake.rotation.x = -Math.PI / 2;
lake.position.y = LAKE_LEVEL;
scene.add(lake);

// Лес: ели/сосны/лиственные + кусты, камни, грибы — один BatchedMesh
// (castShadow на BatchedMesh нельзя: два прохода с разными камерами дерутся
// за его буфер видимости — деревья моргают; тени крон на кузов кладём иначе)
await stage('Растим лес…');
const forest = createForest();
forest.mesh.sortObjects = false; // непрозрачный статичный лес — сортировка 10k инстансов не нужна
scene.add(forest.mesh);
{
  // Все стволы и валуны — ОДИН trimesh-коллайдер: Rapier 0.19 тратит ~52 нс
  // на КАЖДЫЙ коллайдер за шаг даже на спящей статике (замер аудита:
  // 6.6k коллайдеров = 0.34 мс/шаг, один trimesh = 0.018 мс)
  const verts = [], idx = [];
  const addPrism = (x, z, r, y0, y1) => { // ствол — открытая 8-гранная призма
    const base = verts.length / 3;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r;
      verts.push(cx, y0, cz, cx, y1, cz);
    }
    for (let k = 0; k < 8; k++) {
      const a0 = base + k * 2, a1 = base + ((k + 1) % 8) * 2;
      idx.push(a0, a0 + 1, a1, a1, a0 + 1, a1 + 1);
    }
  };
  for (const t of forest.trees) {
    const y = terrainHeight(t.x, t.z);
    addPrism(t.x, t.z, Math.max(0.13, t.trunkR), y - 0.5, y + 8);
  }
  // валун — треугольники РЕАЛЬНОГО меша камня (масштаб как у инстанса;
  // поворот вокруг Y опускаем — форма почти изотропна): колёса катятся честно
  for (const st of forest.stones) {
    const pos = forest.stoneGeos[st.gi].attributes.position;
    const y0 = terrainHeight(st.x, st.z) - 0.12 * st.s;
    const b = verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      verts.push(st.x + pos.getX(i) * st.s, y0 + pos.getY(i) * st.s, st.z + pos.getZ(i) * st.s);
    }
    for (let i = 0; i < pos.count; i++) idx.push(b + i); // неиндексированные тройки
  }
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)),
    world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
  );
}

// Птицы и бабочки
await stage('Выпускаем зверьё…');
const wildlife = createWildlife();
scene.add(wildlife.group);

// Запекаем тени крон и травы — один раз, при старте. Карту сэмплируют земля,
// сами деревья (низ в тени леса) и трава. Для теней травинок генерим статичный
// ковёр на всю карту (живая трава ездит с машиной).
const N = 150000;
const shadowTufts = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  let x = 0, z = 0;
  do {
    x = (Math.random() - 0.5) * (SIZE - 4);
    z = (Math.random() - 0.5) * (SIZE - 4);
  } while (!onLand(x, z));
  shadowTufts[i * 3] = x;
  shadowTufts[i * 3 + 2] = z;
}
await stage('Печём тени…');
const shadowTex = bakeGrassShadows(shadowTufts, sunDir, forest.trees);
applyGroundLook(terrain.mesh, shadowTex);
applyForestShadows(forest.material, shadowTex);
applyCarShade(shadowTex); // кроны затеняют и кузов

// Трава — ковёр вокруг машины, затеняется той же картой
await stage('Сеем траву…');
const grass = createGrass(shadowTex);
scene.add(grass.mesh);

// ползунки зон травы: изменения применяются волной за ~1/3 секунды
sliderPanel('Трава', 0, [
  ['d0', 'плотность: ближняя', 0, 1, 0],
  ['d1', 'плотность: средняя', 0, 1, 0.324],
  ['d2', 'плотность: дальняя', 0, 1, 0.471],
  ['r0', 'радиус: ближняя', 0.3, 1.5, 0.3],
  ['r1', 'радиус: средняя', 0.3, 1.5, 0.5712],
  ['r2', 'радиус: дальняя', 0.3, 1.5, 1.5],
], (key, v) => {
  const band = +key[1];
  if (key[0] === 'd') { grassBands.d[band] = v; grass.refresh(); }
  else { grassBands.rad[band] = v; grass.refresh(true); } // радиус — с пересевом
});

// Сбиваемые грибы: удар машиной выбивает гриб из BatchedMesh в полёт
const flyingShrooms = [];
const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
function knockShrooms(dt, carVel) {
  const cp = car.position;
  // скан 3500 грибов — через кадр (за 33 мс машина не проскочит зону удара)
  if ((frameNo & 1) === 0 && carVel.x * carVel.x + carVel.z * carVel.z > 2) {
    for (const sh of forest.mushrooms) {
      if (sh.dead) continue;
      const dx = sh.x - cp.x, dz = sh.z - cp.z;
      if (dx * dx + dz * dz < 2.2) {
        sh.dead = true;
        sounds.play('shroomKnock', { vol: 0.85 });
        forest.mesh.setMatrixAt(sh.batchId, zeroM);
        const mesh = new THREE.Mesh(forest.shroomGeos[sh.gi], forest.material);
        mesh.position.set(sh.x, terrainHeight(sh.x, sh.z), sh.z);
        mesh.scale.setScalar(sh.s);
        scene.add(mesh);
        flyingShrooms.push({
          mesh, gi: sh.gi, // gi — чтобы потом погрузить этот гриб на багажник
          vel: new THREE.Vector3(carVel.x * 0.5 + (Math.random() - 0.5), 3.5 + Math.random() * 2, carVel.z * 0.5 + (Math.random() - 0.5)),
          spin: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
        });
        if (flyingShrooms.length > 24) scene.remove(flyingShrooms.shift().mesh);
      }
    }
  }
  for (let i = flyingShrooms.length - 1; i >= 0; i--) {
    const f = flyingShrooms[i];
    f.vel.y -= 9.8 * dt;
    f.mesh.position.addScaledVector(f.vel, dt);
    f.mesh.rotation.x += f.spin.x * dt;
    f.mesh.rotation.z += f.spin.z * dt;
    // гриб ловится прямо налету — любой машиной
    let grabbed = false;
    for (let ci = 0; ci < rammers.length; ci++) {
      const cp2 = rammers[ci].pos;
      const ddx = f.mesh.position.x - cp2.x, ddz = f.mesh.position.z - cp2.z;
      if (ddx * ddx + ddz * ddz < 2 && Math.abs(f.mesh.position.y - cp2.y) < 2.2) {
        food.grabShroom(ci, f.gi);
        scene.remove(f.mesh);
        flyingShrooms.splice(i, 1);
        grabbed = true;
        break;
      }
    }
    if (grabbed) continue;
    const gy = terrainHeight(f.mesh.position.x, f.mesh.position.z);
    if (f.mesh.position.y < gy && f.vel.y < 0) {
      f.mesh.position.y = gy + 0.12;
      food.addLyingShroom(f.mesh, f.gi); // лежит — можно переехать и погрузить
      flyingShrooms.splice(i, 1);
    }
  }
}

// Машина
await stage('Заводим машины…');
const { car, wheels, rack, steerFace } = createCarMesh();
scene.add(car);
// спаун — на своей базе
const SPAWN = { x: BASE_SPOTS[0].x + 7, z: BASE_SPOTS[0].z };
const vehicle = new Vehicle(world, { x: SPAWN.x, y: terrainHeight(SPAWN.x, SPAWN.z) + 1.2, z: SPAWN.z });

// Боты-медведи: две машины со своим Vehicle и простым AI
const bots = createBots(world, scene);
bots[0].othersList = [{ car }, { car: bots[1].car }];
bots[1].othersList = [{ car }, { car: bots[0].car }];

// Звуковые эффекты (события); стартуют по первому жесту вместе с двигателем
const sounds = createSounds();

// Еда и базы: игрок + боты собирают, сдают на свои платформы
const food = createFood(scene, world, forest, [
  { car, rack, color: 0x2456b8, getVel: () => vehicle.chassis.linvel() },
  ...bots.map((b) => ({ car: b.car, rack: b.rack, color: b.color, getVel: () => b.vehicle.chassis.linvel() })),
], sounds);
const minimap = createMinimap([
  { ...BASE_SPOTS[0], color: 0x2456b8 },
  { ...BASE_SPOTS[1], color: BOT_COLORS[0] },
  { ...BASE_SPOTS[2], color: BOT_COLORS[1] },
]);
const botMarks = [
  { x: 0, z: 0, color: BOT_COLORS[0] },
  { x: 0, z: 0, color: BOT_COLORS[1] },
];

// интерполяция физика(60 Гц)→визуал(любой Гц): пред/тек состояние тел
const lerpBodies = [vehicle, bots[0].vehicle, bots[1].vehicle].map((v) => ({
  body: v.chassis,
  t0: new THREE.Vector3(), q0: new THREE.Quaternion(),
  t1: new THREE.Vector3(), q1: new THREE.Quaternion(),
}));
for (const ls of lerpBodies) {
  const lt = ls.body.translation(), lr = ls.body.rotation();
  ls.t0.set(lt.x, lt.y, lt.z); ls.t1.copy(ls.t0);
  ls.q0.set(lr.x, lr.y, lr.z, lr.w); ls.q1.copy(ls.q0);
}

// список машин для таранов деревьев (vel заполняется каждый кадр)
const rammers = [
  { pos: car.position, vel: null },
  { pos: bots[0].car.position, vel: null },
  { pos: bots[1].car.position, vel: null },
];

// Тараны деревьев: шатание, листья, шишки; из крон валятся белки, скунс,
// пчёлы-воры и золотые шишки
const impacts = createImpacts(scene, forest, sounds, food, car);

// Дымок и звук
const smoke = createSmoke();
scene.add(smoke.mesh);
const engine = createEngineSound();
// движки ботов: те же ворклеты, без панели, громкость по дистанции
for (const b of bots) b.engine = createEngineSound({ panel: false });

// Ввод
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR') vehicle.reset();
  if (e.code === 'Space' && !e.repeat) impacts.skunkPress(); // только отдельные нажатия
  engine.start(); // звук можно включать только после жеста пользователя
  sounds.start();
  for (const b of bots) b.engine.start();
});
addEventListener('mousedown', () => { engine.start(); sounds.start(); for (const b of bots) b.engine.start(); }, { once: true });
addEventListener('keyup', (e) => keys.delete(e.code));

function readInput() {
  vehicle.input.throttle = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
    (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  vehicle.input.steer = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) -
    (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
  vehicle.input.handbrake = keys.has('Space') && !impacts.skunkActive();
  if (impacts.skunkActive()) { // скунс в салоне: машина живёт своей жизнью
    const t = performance.now() / 1000;
    vehicle.input.steer = Math.sin(t * 6.7) * 0.9;
    vehicle.input.throttle = 0.55 + Math.sin(t * 4.3) * 0.45;
  }
}

// Камера-погоня + орбита на зажатой ЛКМ
const CAM_DIST = 7.8;
const camPos = new THREE.Vector3(SPAWN.x - CAM_DIST, terrainHeight(SPAWN.x, SPAWN.z) + 4, SPAWN.z);
const camTarget = new THREE.Vector3();
const fwd = new THREE.Vector3();
const camOff = new THREE.Vector3();
const dbgUp = new THREE.Vector3(), dbgRight = new THREE.Vector3(), lerpTmp = new THREE.Vector3();
const trailRight = new THREE.Vector3(); // поперечник машины для колеи
const camRight = new THREE.Vector3();   // «право» камеры — стерео-панорама звука
const orbit = { yaw: 0, pitch: 0, active: false };
let hoodCam = false;
addEventListener('keydown', (e) => { if (e.code === 'KeyC') hoodCam = !hoodCam; });
addEventListener('mousedown', (e) => { if (e.button === 0) orbit.active = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) orbit.active = false; });
addEventListener('mousemove', (e) => {
  if (!orbit.active) return;
  orbit.yaw -= e.movementX * 0.006;
  orbit.pitch = THREE.MathUtils.clamp(orbit.pitch - e.movementY * 0.004, -0.25, 0.75);
});

function updateCamera(dt) {
  if (hoodCam) { // из кабины: глаза медведя — руль и обе лапы в кадре
    camera.position.copy(camTarget.set(-0.16, 1.17, -0.42).applyMatrix4(car.matrixWorld));
    camTarget.set(10, 0.15, -0.42).applyMatrix4(car.matrixWorld);
    camera.lookAt(camTarget);
    camPos.copy(camera.position);
    return;
  }
  fwd.set(1, 0, 0).applyQuaternion(car.quaternion);
  fwd.y = 0;
  fwd.normalize();
  if (!orbit.active) { // отпустили — плавно возвращаемся за корму
    const k = Math.exp(-3 * dt);
    orbit.yaw *= k;
    orbit.pitch *= k;
  }
  const back = Math.atan2(fwd.z, fwd.x) + Math.PI + orbit.yaw;
  const elev = 0.47 + orbit.pitch; // повыше и с лёгким наклоном вперёд
  const desired = camTarget.set(
    car.position.x + Math.cos(back) * Math.cos(elev) * CAM_DIST,
    car.position.y + Math.sin(elev) * CAM_DIST,
    car.position.z + Math.sin(back) * Math.cos(elev) * CAM_DIST,
  );
  camPos.lerp(desired, 1 - Math.exp(-8 * dt));
  // Камера сидит рядом: дистанция не растягивается на разгоне
  camOff.copy(camPos).sub(car.position);
  if (camOff.length() > CAM_DIST) camPos.copy(car.position).addScaledVector(camOff.normalize(), CAM_DIST);
  camPos.y = Math.max(camPos.y, terrainHeight(camPos.x, camPos.z) + 1.2);
  camera.position.copy(camPos);
  camTarget.copy(car.position).addScaledVector(fwd, 2.5);
  camTarget.y += 0.8; // цель чуть ниже — камера наклонена вперёд
  camera.lookAt(camTarget);
}

// HUD и телеметрия для отладки
const speedEl = document.getElementById('speed');
let lastKmh = -1;
window.__debug = { speed: 0, pos: [0, 0, 0], fps: 0, food: food.scores };
window.__three = { renderer, scene, grass, vehicle }; // отладка из консоли

const FIXED = 1 / 60;
world.timestep = FIXED;
let frameNo = 0;
let accum = 0;
let last = performance.now();
let frames = 0, fpsTime = 0;

// перф-оверлей: CPU-время кадра, GPU-время (timestamp queries),
// и потолок fps без vsync = 1000 / max(cpu, gpu)
const perfEl = document.getElementById('perf');
let cpuAcc = 0, perfN = 0, perfTimer = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  frameNo++;

  readInput();
  for (const b of bots) updateBot(b, dt, food, b.othersList); // AI пишет в input ботов
  accum += dt;
  let steps = 0;
  while (accum >= FIXED && steps < 4) {
    // прошлое состояние тел — для интерполяции визуала между шагами
    for (const ls of lerpBodies) {
      const lt = ls.body.translation(), lr = ls.body.rotation();
      ls.t0.set(lt.x, lt.y, lt.z);
      ls.q0.set(lr.x, lr.y, lr.z, lr.w);
    }
    vehicle.update(FIXED);
    for (const b of bots) b.vehicle.update(FIXED);
    world.step();
    accum -= FIXED;
    steps++;
  }
  if (steps > 0) {
    for (const ls of lerpBodies) {
      const lt = ls.body.translation(), lr = ls.body.rotation();
      ls.t1.set(lt.x, lt.y, lt.z);
      ls.q1.set(lr.x, lr.y, lr.z, lr.w);
    }
  }
  // физика — 60 Гц, экран может быть 120+ Гц (ProMotion): без интерполяции
  // машины обновляются через кадр и картинку «трясёт»
  const alpha = Math.min(accum / FIXED, 1);

  // Синхронизация визуала (интерполированная)
  const t = vehicle.chassis.translation();
  car.position.lerpVectors(lerpBodies[0].t0, lerpBodies[0].t1, alpha);
  car.quaternion.slerpQuaternions(lerpBodies[0].q0, lerpBodies[0].q1, alpha);
  vehicle.syncWheels(wheels);
  steerFace.rotation.z = -vehicle.steer * 2.8; // руль в кабине крутится
  car.updateMatrixWorld();
  grass.carPos.value.copy(car.position);
  const lv = vehicle.chassis.linvel();
  if (lv.x * lv.x + lv.z * lv.z > 0.6) {
    grass.moveDir.value.lerp(lerpTmp.set(lv.x, 0, lv.z), 0.15).normalize();
  }
  smoke.update(dt, car, lv, vehicle.rpm, Math.max(0, vehicle.input.throttle));
  engine.set(vehicle.rpm, vehicle.input.throttle);
  grass.follow(car.position);
  trailRight.set(0, 0, 1).applyQuaternion(car.quaternion);
  grass.trail(car.position, trailRight.x, trailRight.z, lv.x * lv.x + lv.z * lv.z > 1);
  botMarks[0].x = bots[0].car.position.x; botMarks[0].z = bots[0].car.position.z;
  botMarks[1].x = bots[1].car.position.x; botMarks[1].z = bots[1].car.position.z;
  minimap.update(car.position, Math.atan2(-trailRight.x, trailRight.z), botMarks); // курс из поперечника
  wildlife.update(dt, car.position);
  // синк ботов (интерполированный) + их след в траве
  for (let bi = 0; bi < bots.length; bi++) {
    const b = bots[bi];
    const bls = lerpBodies[bi + 1];
    b.car.position.lerpVectors(bls.t0, bls.t1, alpha);
    b.car.quaternion.slerpQuaternions(bls.q0, bls.q1, alpha);
    const bt = b.car.position;
    b.vehicle.syncWheels(b.wheels);
    b.car.updateMatrixWorld();
    const bv = b.vehicle.chassis.linvel();
    if (bv.x * bv.x + bv.z * bv.z > 1) {
      trailRight.set(0, 0, 1).applyQuaternion(b.car.quaternion);
      grass.stampPair(bt.x, bt.z, trailRight.x, trailRight.z);
    }
    // двигатель бота: громкость по дистанции + панорама по камере
    b.engine.set(b.vehicle.rpm, b.vehicle.input.throttle);
    const brx = bt.x - car.position.x, brz = bt.z - car.position.z;
    const bd = Math.hypot(brx, brz);
    const bpan = bd > 1 ? THREE.MathUtils.clamp((brx * camRight.x + brz * camRight.z) / bd, -1, 1) : 0;
    b.engine.setAtt(Math.min(1, 6 / (1 + bd * 0.3)), bpan);
  }
  knockShrooms(dt, lv);
  rammers[0].vel = lv;
  rammers[1].vel = bots[0].vehicle.chassis.linvel();
  rammers[2].vel = bots[1].vehicle.chassis.linvel();
  impacts.update(dt, rammers);
  food.update(dt);
  setBrakeLights((vehicle.input.throttle < 0 && vehicle.speed > 0.5) || vehicle.input.handbrake);
  // теневой фрустум едет за машиной
  sun.position.copy(car.position).addScaledVector(sunDir, 300);
  sun.target.position.copy(car.position);

  // вода выше капота — перезапуск
  const waterY = inLake(t.x, t.z) ? LAKE_LEVEL : SEA_LEVEL;
  if (t.y + 0.75 < waterY) vehicle.reset();

  updateCamera(dt);
  camRight.setFromMatrixColumn(camera.matrixWorld, 0); // столбец X = вправо
  sounds.setListener(car.position.x, car.position.z, camRight.x, camRight.z);
  postProcessing.render();

  cpuAcc += performance.now() - now;
  perfN++;
  perfTimer += dt;
  if (perfTimer > 0.5) {
    renderer.resolveTimestampsAsync('render'); // раз в полсекунды, не каждый кадр
    const cpu = cpuAcc / perfN;
    const gpu = renderer.info.render.timestamp || 0;
    const fpsNow = Math.round(perfN / perfTimer);
    // gpu-таймстампы на Metal (маки) часто врут: 130 мс при плавных 60 fps
    // невозможны — противоречащий реальному fps замер помечаем и не даём
    // ему красить потолок
    const gpuValid = gpu > 0.01 && gpu * fpsNow < 2000;
    const worst = Math.max(cpu, gpuValid ? gpu : 0);
    perfEl.textContent =
      `fps ${fpsNow} · CPU ${cpu.toFixed(1)} мс · GPU ${gpuValid ? gpu.toFixed(1) : '?'} мс`
      + ` · потолок ~${worst > 0.01 ? Math.round(1000 / worst) : '—'} fps`;
    cpuAcc = 0; perfN = 0; perfTimer = 0;
  }

  const kmh = Math.round(Math.abs(vehicle.speed * 3.6));
  if (kmh !== lastKmh) { lastKmh = kmh; speedEl.textContent = kmh; } // DOM — только по делу
  frames++; fpsTime += dt;
  window.__debug.speed = vehicle.speed;
  if (fpsTime > 1) { // телеметрия — 1 Гц, без аллокаций в каждом кадре
    window.__debug.fps = Math.round(frames / fpsTime);
    frames = 0; fpsTime = 0;
    window.__debug.pos = [t.x, t.y, t.z];
    dbgUp.set(0, 1, 0).applyQuaternion(car.quaternion);
    dbgRight.set(0, 0, 1).applyQuaternion(car.quaternion);
    window.__debug.up = +dbgUp.y.toFixed(2);
    window.__debug.side = +(dbgRight.x * lv.x + dbgRight.y * lv.y + dbgRight.z * lv.z).toFixed(2);
    window.__debug.rpm = Math.round(vehicle.rpm);
    window.__debug.gear = vehicle.gear;
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

window.__loadStage?.('Поехали!');
document.getElementById('loading').style.opacity = '0';
setTimeout(() => document.getElementById('loading').remove(), 500);
