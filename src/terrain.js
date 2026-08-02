import * as THREE from 'three/webgpu';
import { texture, uv, attribute, uniform, mix, float } from 'three/tsl';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// глобальная сила запечённых теней (0 — нет, 1 — как запечено)
export const shadowStrength = uniform(1);
// множитель-оттенок земли (панель «Цвета»); база травяных участков — 0x6b9440
export const groundTint = uniform(new THREE.Color(1, 1, 1));
export const GROUND_BASE = 0x6b9440;

export const SIZE = 1000;
export const SEA_LEVEL = -3;
export const LAKE_LEVEL = 4.9;
const SEA_FLOOR = -22;
const SEGS = 512;
const PHYS_SEGS = 256; // коллайдеру такая плотность не нужна

const noise = new ImprovedNoise();

// Базы медведей, раскиданы по лесу: игрок (синий), красный и жёлтый боты.
// Террейн под каждой плавно выравнивается; h кэшируется при первом обращении.
export const BASE_SPOTS = [
  { x: 60, z: 35 },
  { x: -65, z: 45 },
  { x: -20, z: -70 },
];

// Единственный источник правды о высоте — им пользуются рендер, физика и трава.
// Карта — остров неправильной формы: за рваным краем обрыв в море.
// В центре, на главной опушке, — озеро-чаша.
function rawHeight(x, z) {
  let h = 6;
  h += noise.noise(x * 0.006, z * 0.006, 0.5) * 6.0;   // холмы
  h += noise.noise(x * 0.02, z * 0.02, 7.3) * 1.6;     // неровности
  h += noise.noise(x * 0.09, z * 0.09, 13.7) * 0.25;   // мелочь
  const r = Math.hypot(x, z);
  if (r < 45) { // лесной прудик: ровный низкий берег и мелкая чаша
    const edge = lakeEdgeR(x, z);
    const flat = 1 - THREE.MathUtils.smoothstep(r, edge + 2, edge + 14);
    h = h * (1 - flat) + 5.4 * flat;               // берег выравнивается к воде
    h -= 2.6 * Math.max(0, 1 - (r / edge) ** 2);   // мелко: ~2 м в центре
  }
  const inv = r > 1e-3 ? 1 / r : 0;
  // край острова гуляет по направлению (непрерывен по кругу, без шва)
  const rEdge = 430 + noise.noise(x * inv * 2.3 + 7.7, z * inv * 2.3 - 3.1, 21.5) * 90;
  const t = THREE.MathUtils.smoothstep(r, rEdge - 16, rEdge + 12);
  return h * (1 - t) + SEA_FLOOR * t;
}

export function terrainHeight(x, z) {
  let h = rawHeight(x, z);
  for (const b of BASE_SPOTS) { // ровная площадка под каждой базой
    const dx = x - b.x, dz = z - b.z;
    if (dx > 12 || dx < -12 || dz > 12 || dz < -12) continue;
    if (b.h === undefined) b.h = rawHeight(b.x, b.z);
    const t = 1 - THREE.MathUtils.smoothstep(Math.hypot(dx, dz), 6.5, 11);
    h = h * (1 - t) + b.h * t;
  }
  return h;
}

// кромка пруда гуляет по направлению — естественная форма вместо круга
export function lakeEdgeR(x, z) {
  const r = Math.hypot(x, z);
  const inv = r > 1e-3 ? 1 / r : 0;
  return 19 + noise.noise(x * inv * 1.7 + 3.3, z * inv * 1.7 + 8.9, 11.2) * 7;
}

export function inLake(x, z) {
  return Math.hypot(x, z) < lakeEdgeR(x, z) + 1.5;
}

// плотность травы у пруда: 0 на песке, 1 дальше ~12 м от кромки
export function lakeGrassFactor(x, z) {
  const r = Math.hypot(x, z);
  if (r > 45) return 1;
  return THREE.MathUtils.clamp((r - lakeEdgeR(x, z) - 4) / 12, 0, 1);
}

// вода в точке: озеро в центре, море за обрывом
export function waterLevelAt(x, z) {
  return inLake(x, z) ? LAKE_LEVEL : SEA_LEVEL;
}

// под водой (для травы и растительности)
export function underWater(x, z) {
  return terrainHeight(x, z) < waterLevelAt(x, z) + 0.15;
}

// суша, пригодная для растительности и живности
export function onLand(x, z) {
  return terrainHeight(x, z) > 1.5 && !inLake(x, z);
}

export function createTerrain() {
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(0x6b9440);
  const dry = new THREE.Color(0x9a9a58);
  const dirt = new THREE.Color(0x5c4a2e);
  const sand = new THREE.Color(0x8a7a55);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    // пятна сухой травы и земли по отдельному каналу шума
    const patch = noise.noise(x * 0.03 + 50, z * 0.03 - 50, 3.1);
    c.copy(grass).lerp(dry, THREE.MathUtils.clamp(patch * 1.6, 0, 1));
    if (patch < -0.25) c.lerp(dirt, Math.min(1, -patch * 1.5 - 0.3));
    if (y < 1.5) c.lerp(sand, Math.min(1, (1.5 - y) * 0.2)); // обрыв и дно моря — песок
    const rC = Math.hypot(x, z);
    if (rC < 45) c.lerp(sand, THREE.MathUtils.clamp((lakeEdgeR(x, z) + 4 - rC) / 5, 0, 1)); // пляж
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Lambert: без зеркального слоя — тень гасит поверхность в чёрный,
  // а не оставляет серо-голубой отблеск окружения (френель на скользящих углах)
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertNodeMaterial());
  mesh.receiveShadow = true;

  // Данные для trimesh-коллайдера Rapier
  const vertices = new Float32Array(pos.array);
  const indices = new Uint32Array(geo.index.array);
  return { mesh, vertices, indices };
}

// Облик земли: вершинные цвета × запечённые тени (по-пиксельно, жёстко)
export function applyGroundLook(mesh, shadowTex) {
  const mat = mesh.material;
  const shade = mix(float(1), texture(shadowTex, uv()).r, shadowStrength);
  mat.colorNode = attribute('color', 'vec3').mul(groundTint).mul(shade);
  mat.needsUpdate = true;
}

// Тени, запечённые в текстуру-мультипликатор террейна: длинные тени крон
// деревьев + мелкие от пучков травы. Спрайты рисуются один раз уже
// повёрнутыми по азимуту солнца, дальше только дешёвые drawImage.
export function bakeGrassShadows(positions, sunDir, trees = []) {
  const size = 8192; // статика — можно дорого
  const px = size / SIZE;
  const ang = Math.atan2(-sunDir.z, -sunDir.x); // тень — от солнца
  const horiz = Math.hypot(sunDir.x, sunDir.z) / Math.max(sunDir.y, 0.15);

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);

  // кроны: длинная мягкая тень + тёмное пятно под деревом
  if (trees.length) {
    const tLenPx = Math.min(30, 13 * horiz) * px;
    const crownPx = 2.6 * px;
    const sd = Math.ceil((tLenPx + crownPx) * 2 + 12);
    const spr = document.createElement('canvas');
    spr.width = spr.height = sd;
    const sc = spr.getContext('2d');
    sc.translate(sd / 2, sd / 2);
    sc.rotate(ang);
    sc.fillStyle = 'rgba(0,0,0,0.99)'; // жёсткие, практически чёрные
    sc.beginPath();
    sc.ellipse(tLenPx / 2, 0, tLenPx / 2 + crownPx * 0.4, crownPx, 0, 0, Math.PI * 2);
    sc.fill();
    sc.fillStyle = 'rgba(0,0,0,0.5)';
    sc.beginPath();
    sc.ellipse(0, 0, crownPx * 1.1, crownPx * 1.1, 0, 0, Math.PI * 2);
    sc.fill();
    for (const t of trees) {
      const w = sd * t.s;
      ctx.drawImage(spr, (t.x + SIZE / 2) * px - w / 2, (t.z + SIZE / 2) * px - w / 2, w, w);
    }
  }

  // трава: лёгкие короткие штрихи, чтобы не спорили с тенями крон
  const lenPx = Math.max(2.5, Math.min(0.7, 0.3 * horiz) * px);
  const sd = Math.ceil(lenPx * 2 + 8);
  const spr = document.createElement('canvas');
  spr.width = spr.height = sd;
  const sc = spr.getContext('2d');
  sc.translate(sd / 2, sd / 2);
  sc.rotate(ang);
  sc.fillStyle = 'rgba(0,0,0,0.26)';
  sc.beginPath();
  sc.ellipse(lenPx / 2, 0, lenPx / 2 + 1, 1.4, 0, 0, Math.PI * 2);
  sc.fill();
  const half = sd / 2;
  for (let i = 0; i < positions.length; i += 3) {
    ctx.drawImage(spr,
      (positions[i] + SIZE / 2) * px - half,
      (positions[i + 2] + SIZE / 2) * px - half);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 16; // чёткость под острыми углами
  return tex;
}
