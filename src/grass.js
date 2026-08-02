import * as THREE from 'three/webgpu';
import {
  positionLocal, positionWorld, time, hash, instanceIndex, instancedBufferAttribute, uniform,
  mix, vec3, vec2, sin, cos, smoothstep, length, color, positionView, texture, float, uv,
} from 'three/tsl';
import { SIZE, terrainHeight, waterLevelAt, shadowStrength, lakeGrassFactor, BASE_SPOTS } from './terrain.js';

// 0 — травы нет (вода, песок пруда, крутизна); иначе множитель высоты:
// на ровном лугу трава ниже, на склонах — выше. h0 — уже вычисленная высота
// точки (бережём вызовы terrainHeight — это горячий путь переката)
function grassHeightFactor(x, z, h0) {
  if (h0 < waterLevelAt(x, z) + 0.15) return 0; // под водой
  for (const b of BASE_SPOTS) { // на площадках баз травы нет
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz < 33) return 0;
  }
  const f = lakeGrassFactor(x, z);
  if (f <= 0) return 0;
  if (f < 1) { // детерминированное прорежение к берегу
    const rnd = ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1 + 1) % 1;
    if (rnd >= f) return 0;
  }
  // уклон прямой разностью от уже известной точки: 2 вызова вместо 4
  const hx = terrainHeight(x + 1.4, z) - h0;
  const hz = terrainHeight(x, z + 1.4) - h0;
  const ny = 1 / Math.hypot(1, hx / 1.4, hz / 1.4);
  if (ny < 0.86) return 0;
  return 0.75 + (1 - ny) * 5; // 0.75 на плоском ... ~1.45 на пределе уклона
}

// Ковёр вокруг машины: пучки живут в квадрате ±RADIUS от неё, вышедшие за
// край перекатываются на противоположную сторону (плотность постоянная,
// счёт мал). Позиции пучков привязаны к миру, пока машина рядом.
const COUNT = 380_000;
const RADIUS = 190; // самая дальняя зона
// динамическая плотность, три зоны: плотно у машины, средне, редко вдали
const Z1 = 45, Z2 = 110;
const S1 = 0.48, S2 = 0.78; // доли счётчика на зоны 1 и 1+2
const bandOf = (i) => (i < COUNT * S1 ? 0 : i < COUNT * S2 ? 1 : 2);

// настройки зон (ползунки): плотность и радиус каждой зоны
export const grassBands = { d: [1, 1, 1], rad: [1, 1, 1] };

// цвета и высота травы — юниформы, крутятся из панелей
export const grassColors = {
  root: uniform(new THREE.Color(0x3a581f)),
  tip: uniform(new THREE.Color(0x486c23)),
  ground: uniform(new THREE.Color(0x7f924f)),
};
export const grassHeight = uniform(1);

// Детерминированный PRNG, чтобы лес был один и тот же
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Широкая травинка с продольным сгибом: две грани вдоль центрального ребра,
// лёгкий изгиб по высоте, верх почти плоский (+зеркальная копия для обзора
// с обеих сторон). Нормали граней подтянуты к вертикали: сгиб чуть читается
// на свету, но травинки не раскрашиваются вразнобой.
function tuftGeometry() {
  const positions = [], normals = [], uvs = [], indices = [];
  const rows = [
    { y: 0, w: 0.12, lean: 0 },
    { y: 0.55, w: 0.105, lean: 0.1 },
    { y: 1, w: 0.08, lean: 0.28 },
  ];
  const n0 = new THREE.Vector3();
  let vo = 0;
  for (const flip of [1, -1]) {
    for (const r of rows) {
      positions.push(
        -r.w * flip, r.y, r.lean,
        0, r.y, r.lean + 0.075, // ребро сгиба
        r.w * flip, r.y, r.lean,
      );
      for (const nx of [-0.4 * flip, 0, 0.4 * flip]) {
        n0.set(nx, 1, nx === 0 ? -0.3 : 0.1).normalize();
        normals.push(n0.x, n0.y, n0.z);
      }
      uvs.push(0, r.y, 0, r.y, 0, r.y);
    }
    for (let s = 0; s < 2; s++) {
      const b = vo + s * 3;
      indices.push(b, b + 1, b + 4, b, b + 4, b + 3, b + 1, b + 2, b + 5, b + 1, b + 5, b + 4);
    }
    vo += 9;
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// shadowTex — запечённая карта теней мира: травинки затеняются кронами так же,
// как земля под ними
export function createGrass(shadowTex) {
  const geo = tuftGeometry();

  const rand = mulberry32(1337);
  // на пучок: xyz + w = запечённая высота (рандом × уклон)
  const tuftPos = new Float32Array(COUNT * 4);
  const bandRad = new Float32Array(COUNT);   // базовый радиус зоны с джиттером — fuzzy-границы
  const hRand = new Float32Array(COUNT);     // персональный разброс высоты
  const dRand = new Float32Array(COUNT);     // порог для ползунка плотности
  for (let i = 0; i < COUNT; i++) {
    const b = bandOf(i);
    bandRad[i] = (b === 0 ? Z1 : b === 1 ? Z2 : RADIUS) * (0.8 + rand() * 0.4);
    hRand[i] = 0.78 + rand() * 0.44; // ±22% личного разброса
    dRand[i] = rand();
  }

  // пересчёт пучка на месте (x, z уже записаны)
  const computeTuft = (i) => {
    const x = tuftPos[i * 4], z = tuftPos[i * 4 + 2];
    const b = bandOf(i);
    let hf = 0;
    if (dRand[i] < grassBands.d[b]) {
      const h0 = terrainHeight(x, z);
      hf = grassHeightFactor(x, z, h0);
      tuftPos[i * 4 + 1] = hf > 0 ? h0 - 0.07 : -100;
    } else {
      tuftPos[i * 4 + 1] = -100;
    }
    tuftPos[i * 4 + 3] = hf * hRand[i];
  };
  // эффективный радиус зоны пучка: базовый джиттер × ползунок зоны
  const zoneR = (i) => bandRad[i] * grassBands.rad[bandOf(i)];
  for (let i = 0; i < COUNT; i++) {
    const R = zoneR(i);
    tuftPos[i * 4] = (rand() - 0.5) * R * 2;
    tuftPos[i * 4 + 2] = (rand() - 0.5) * R * 2;
    computeTuft(i);
  }
  const posAttr = new THREE.InstancedBufferAttribute(tuftPos, 4);
  geo.instanceCount = COUNT;

  // Перекат пучков — инкрементально: срез в 20k за кадр + загрузка в GPU
  // только затронутого диапазона. refreshLeft — «волна» полного пересчёта
  // после смены ползунков плотности/длины.
  let cursor = 0;
  let refreshLeft = 0;
  let rescatter = false; // волна ещё и пересеивает позиции (смена радиуса зоны)
  const SLICE = 20000;
  const REFRESH_SLICE = 6000; // волна пересчёта — мелкими порциями, без фризов
  function follow(carPos) {
    const refreshing = refreshLeft > 0;
    const end = Math.min(cursor + (refreshing ? REFRESH_SLICE : SLICE), COUNT);
    let minT = Infinity, maxT = -1;
    for (let i = cursor; i < end; i++) {
      let x = tuftPos[i * 4], z = tuftPos[i * 4 + 2];
      const R = zoneR(i);
      const dx = x - carPos.x, dz = z - carPos.z;
      if (Math.abs(dx) > R || Math.abs(dz) > R) {
        x = carPos.x + (((dx + R) % (R * 2)) + R * 2) % (R * 2) - R;
        z = carPos.z + (((dz + R) % (R * 2)) + R * 2) % (R * 2) - R;
        tuftPos[i * 4] = x;
        tuftPos[i * 4 + 2] = z;
        computeTuft(i);
        if (i < minT) minT = i;
        maxT = i;
      } else if (refreshing) {
        if (rescatter) { // детерминированный пересев в новом радиусе вокруг машины
          const u = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
          const v = ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1;
          tuftPos[i * 4] = carPos.x + (u * 2 - 1) * R;
          tuftPos[i * 4 + 2] = carPos.z + (v * 2 - 1) * R;
        }
        computeTuft(i);
        if (i < minT) minT = i;
        maxT = i;
      }
    }
    if (refreshing) {
      refreshLeft--;
      if (refreshLeft === 0) rescatter = false;
    }
    cursor = end >= COUNT ? 0 : end;
    posAttr.clearUpdateRanges();
    if (maxT >= 0) {
      posAttr.addUpdateRange(minT * 4, (maxT - minT + 1) * 4);
      posAttr.needsUpdate = true;
    }
  }

  // полный пересчёт волной за один круг переката (~1 сек мелкими срезами);
  // rescatterZones — ещё и раскидать пучки заново (после смены радиуса зоны)
  function refresh(rescatterZones = false) {
    refreshLeft = Math.ceil(COUNT / REFRESH_SLICE);
    if (rescatterZones) rescatter = true;
  }

  // След колёс: прижатость травы в R8-текстуре на окне 220×220 м вокруг
  // машины. Колёса штампуют колеи, четверть текстуры за кадр гаснет
  // (трава расправляется ~7 с), окно переезжает за машиной со сдвигом.
  const TRAIL_N = 512, TRAIL_EXTENT = 220;
  const TEXEL = TRAIL_EXTENT / TRAIL_N;
  const trailBytes = new Uint8Array(TRAIL_N * TRAIL_N);
  const trailF = new Float32Array(TRAIL_N * TRAIL_N);
  const trailTmp = new Float32Array(TRAIL_N * TRAIL_N);
  const trailTex = new THREE.DataTexture(trailBytes, TRAIL_N, TRAIL_N, THREE.RedFormat, THREE.UnsignedByteType);
  trailTex.minFilter = THREE.LinearFilter; // мягкие края колеи
  trailTex.magFilter = THREE.LinearFilter;
  trailTex.needsUpdate = true;
  const trailOrigin = uniform(new THREE.Vector2(-TRAIL_EXTENT / 2, -TRAIL_EXTENT / 2));
  let trailQuarter = 0;

  const stamp = (wx, wz) => {
    const tx = (wx - trailOrigin.value.x) / TEXEL;
    const tz = (wz - trailOrigin.value.y) / TEXEL;
    const x0 = tx | 0, z0 = tz | 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const x = x0 + dx, z = z0 + dz;
        if (x < 1 || z < 1 || x >= TRAIL_N - 1 || z >= TRAIL_N - 1) continue; // кайма всегда 0
        const w = (1 - Math.abs(tx - x)) * (1 - Math.abs(tz - z)); // билинейный штамп
        const i = z * TRAIL_N + x;
        trailF[i] = Math.min(1, trailF[i] + w * 1.3);
      }
    }
  };

  function recenterTrail(cx, cz) {
    const nx = Math.round((cx - TRAIL_EXTENT / 2 - trailOrigin.value.x) / TEXEL);
    const nz = Math.round((cz - TRAIL_EXTENT / 2 - trailOrigin.value.y) / TEXEL);
    for (let z = 0; z < TRAIL_N; z++) {
      const sz = z + nz;
      if (sz < 0 || sz >= TRAIL_N) { trailTmp.fill(0, z * TRAIL_N, z * TRAIL_N + TRAIL_N); continue; }
      for (let x = 0; x < TRAIL_N; x++) {
        const sx = x + nx;
        trailTmp[z * TRAIL_N + x] = (sx >= 0 && sx < TRAIL_N) ? trailF[sz * TRAIL_N + sx] : 0;
      }
    }
    trailF.set(trailTmp);
    for (let i = 0; i < trailF.length; i++) trailBytes[i] = (trailF[i] * 255) | 0;
    trailOrigin.value.x += nx * TEXEL;
    trailOrigin.value.y += nz * TEXEL;
  }

  function trail(carPosV, rightX, rightZ, moving) {
    const cx = trailOrigin.value.x + TRAIL_EXTENT / 2;
    const cz = trailOrigin.value.y + TRAIL_EXTENT / 2;
    if (Math.abs(carPosV.x - cx) > 55 || Math.abs(carPosV.z - cz) > 55) recenterTrail(carPosV.x, carPosV.z);
    if (moving) { // две колеи по бортам
      stamp(carPosV.x + rightX * 0.72, carPosV.z + rightZ * 0.72);
      stamp(carPosV.x - rightX * 0.72, carPosV.z - rightZ * 0.72);
    }
    // расправление: четверть карты за кадр, ~7 с на полный подъём
    const q = trailQuarter;
    trailQuarter = (trailQuarter + 1) & 3;
    const start = q * (TRAIL_N * TRAIL_N / 4), end = start + TRAIL_N * TRAIL_N / 4;
    for (let i = start; i < end; i++) {
      let f = trailF[i];
      if (f === 0) { if (trailBytes[i] !== 0) trailBytes[i] = 0; continue; }
      f *= 0.965;
      if (f < 0.02) f = 0;
      trailF[i] = f;
      trailBytes[i] = (f * 255) | 0;
    }
    trailTex.needsUpdate = true;
  }

  // след чужих машин (боты): только штампы, гашение и окно ведёт trail()
  function stampPair(px, pz, rx, rz) {
    stamp(px + rx * 0.72, pz + rz * 0.72);
    stamp(px - rx * 0.72, pz - rz * 0.72);
  }

  const carPos = uniform(new THREE.Vector3(0, -100, 0));
  const moveDir = uniform(new THREE.Vector3(1, 0, 0)); // куда едет машина

  // Lambert: нет френеля Standard'а (та самая «чёрная трава»), зато сан-свет
  // с картой теней честно затеняет траву под кронами
  const mat = new THREE.MeshLambertNodeMaterial();
  const tuft = instancedBufferAttribute(posAttr);
  const h = positionLocal.y; // 0..1 вдоль лезвия

  // Случайный поворот и размер пучка — в шейдере, из hash(instanceIndex)
  const ang = hash(instanceIndex).mul(Math.PI * 2);
  const ca = cos(ang), sa = sin(ang);
  const lx = positionLocal.x.mul(ca).sub(positionLocal.z.mul(sa));
  const lz = positionLocal.x.mul(sa).add(positionLocal.z.mul(ca));
  const width = hash(instanceIndex.add(1)).mul(0.5).add(0.75);
  // высота запечена в w: личный рандом × уклон места
  const height = tuft.w.mul(0.5);

  // Трава сидит спокойно: еле заметная когерентная волна, не дёргается вразнобой
  const calm = sin(time.mul(0.8).add(tuft.x.mul(0.3)).add(tuft.z.mul(0.23))).mul(0.018);

  // Машина приминает траву, и та складывается по ходу движения
  const dist = length(tuft.xz.sub(carPos.xz));
  // 1 вплотную, 0 дальше 2.6 м (smoothstep с обратными краями в WGSL нелегален)
  const press = smoothstep(0.7, 2.6, dist).oneMinus();
  const bend = vec2(moveDir.x, moveDir.z).mul(press).mul(h).mul(1.15);

  // след колёс: примятость из карты следа (сэмпл в вершинном стейдже)
  const trailUv = tuft.xz.sub(trailOrigin).div(TRAIL_EXTENT);
  const trailFlat = texture(trailTex, trailUv).r.mul(0.85).oneMinus();

  mat.positionNode = tuft.xyz.add(vec3(
    lx.mul(width).add(calm.mul(h)).add(bend.x),
    h.mul(height).mul(grassHeight).mul(press.mul(-0.65).add(1)).mul(trailFlat), // мнётся машиной и следом
    lz.mul(width).add(calm.mul(h).mul(0.6)).add(bend.y),
  ));

  // instanceIndex/hash во фрагментном стейдже дают мусор (проверено дважды),
  // поэтому вариация цвета — линейный fract от позиции пучка: безопасно везде
  const tint = tuft.x.mul(0.371).add(tuft.z.mul(0.6173)).fract().mul(0.14).add(0.9);
  // градиент по uv.y: после назначения positionNode узел positionLocal во
  // фрагменте возвращает уже СМЕЩЁННУЮ позицию (мировые высоты!) — mix
  // экстраполировался в дичь; uv-атрибут этим не задет
  const blade = mix(grassColors.root, grassColors.tip, uv().y).mul(tint);
  // Вдали травинки ужимаются в пиксель и тёмное альбедо читается грязными
  // точками на светлой земле — с дистанцией перекрашиваем их в тон террейна.
  // Глубина фрагмента — готовый варинг пайплайна, безопасен во фрагментном стейдже
  const far = smoothstep(30, 170, positionView.z.negate());
  // запечённые тени мира — по мировой позиции травинки
  const baked = texture(shadowTex, vec2(
    positionWorld.x.add(SIZE / 2).div(SIZE),
    float(SIZE / 2).sub(positionWorld.z).div(SIZE),
  )).r;
  const shade = mix(float(1), baked, shadowStrength);
  mat.colorNode = mix(blade, grassColors.ground, far.mul(0.85)).mul(shade);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // одна геометрия на всю карту
  mesh.receiveShadow = true;
  return { mesh, carPos, moveDir, mat, follow, refresh, trail, stampPair };
}
