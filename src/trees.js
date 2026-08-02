import * as THREE from 'three/webgpu';
import { attribute, positionWorld, texture, vec2, vec3, float, mix, uniform, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TreeGenerator } from 'three/addons/generators/TreeGenerator.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { SIZE, terrainHeight, onLand, shadowStrength, lakeEdgeR, BASE_SPOTS } from './terrain.js';

// поляны под базы медведей — там ничего не растёт
const onBase = (x, z) => BASE_SPOTS.some((b) => (x - b.x) ** 2 + (z - b.z) ** 2 < 121);

// Лес из полноценных деревьев: ветвящиеся скелеты TreeGenerator + листва
// комками, ели с рваными ярусами. Кусты, валуны, грибы — в том же BatchedMesh.
// AO и «порода» (для пикеров цвета) — в вершинных атрибутах.

const COUNT = 10000;        // деревья: плотный, почти сплошной лес (+25%)
const BUSHES = 380, STONES = 550, MUSHROOMS = 1200;
const BERRY_CHANCE = 0.2;   // ягодным становится лишь каждый пятый куст
const TREE_SPACING = 9;     // минимум метров между стволами (сетка)

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Вершинные цвета (чистые) + AO в отдельном атрибуте (ползунок теней ослабляет
// и self-shadows) + tintId — «порода» для панели цветов: 0 нет, 1 хвоя,
// 2 ствол хвойных, 3 листва лиственных, 4 ствол дуба/липы, 5 ствол берёзы.
// Убирает uv и индексацию, чтобы части мержились со скелетами TreeGenerator.
export function colored(geo, color, aoFn, tintId = 0, keepUv = false) {
  if (geo.index) geo = geo.toNonIndexed();
  if (!keepUv) geo.deleteAttribute('uv'); // keepUv — для иголочных юбок сосен
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const ao = new Float32Array(pos.count);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    ao[i] = aoFn ? THREE.MathUtils.clamp(aoFn(pos.getY(i)), 0.25, 1.15) : 1;
    c.copy(color);
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(pos.count).fill(tintId), 1));
  return geo;
}

// комковатый сплюснутый шар для крон и кустов
export function lumpySphere(r, squash, rand, detail = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  const o = rand() * 10;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const lump = 1 + 0.28 * Math.sin(x * 2.1 + o) * Math.sin(y * 2.7 + o * 1.3) * Math.sin(z * 2.4 + o * 0.7);
    p.setXYZ(i, x * lump, y * lump * squash, z * lump);
  }
  g.computeVertexNormals();
  return g;
}

const _cn = new THREE.Vector3(), _cu = new THREE.Vector3(), _cv = new THREE.Vector3();
const _leafCol = new THREE.Color();
function trunkGeo(rTop, rBot, h, color, aoBase = 0.55, tintId = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, 6);
  g.translate(0, h / 2, 0);
  return colored(g, color, (y) => aoBase + (1 - aoBase) * (y / h), tintId);
}

function spruce(rand) { // ель: рваные ярусы, поверх — хвойные карточки
  const h = 13 + rand() * 6;
  const parts = [trunkGeo(0.18, 0.36, h * 0.55, new THREE.Color(0x5a4429), 0.55, 2)];
  const baseGreen = new THREE.Color().setHSL(0.29 + rand() * 0.05, 0.42 + rand() * 0.16, 0.2 + rand() * 0.05);
  const layers = 6 + (rand() * 3 | 0);
  const crown0 = 0.9 + rand() * 0.9;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const y = crown0 + (h - crown0 - 1) * t;
    const ch = ((h - crown0) / layers) * (2.1 + rand() * 0.5);
    const R = (3.3 - 2.5 * t) * (0.85 + rand() * 0.3);
    const cone = new THREE.ConeGeometry(R, ch, 12, 1, true);
    // рваная юбка: обод каждого яруса гуляет по радиусу и высоте
    const p = cone.attributes.position;
    const phase = rand() * 10;
    for (let v = 0; v < p.count; v++) {
      if (p.getY(v) < 0) {
        const ang = Math.atan2(p.getZ(v), p.getX(v));
        const k = 1 + 0.22 * Math.sin(ang * 3 + phase) + (rand() - 0.5) * 0.14;
        p.setX(v, p.getX(v) * k);
        p.setZ(v, p.getZ(v) * k);
        p.setY(v, p.getY(v) + (rand() - 0.5) * ch * 0.25);
      }
    }
    const ox = (rand() - 0.5) * 0.4, oz = (rand() - 0.5) * 0.4;
    cone.translate(ox, y + ch / 2, oz);
    const layerGreen = baseGreen.clone().offsetHSL((rand() - 0.5) * 0.015, 0, (rand() - 0.5) * 0.03 + t * 0.03);
    const ao = 0.42 + 0.58 * t; // низ кроны в тени
    parts.push(colored(cone, layerGreen, (yy) => ao * (0.82 + 0.3 * (yy - y) / ch), 1));
  }
  return mergeGeometries(parts);
}

// Ветвящийся скелет через штатный TreeGenerator: мало веток, ветки толстые
function skeleton(rand, o) {
  return new TreeGenerator()
    .setSeed(1 + (rand() * 1e6 | 0))
    .setLevels(o.levels ?? 3)
    .setChildren(o.children ?? [3, 4])
    .setBranchAngle(o.branchAngle ?? [42, 55])
    .setTrunkLength(o.len)
    .setTrunkRadius(o.radius)
    .setLengthRatio(o.lengthRatio ?? 0.42) // короткие ветви — не торчат из кроны
    .setRadiusExponent(1.55)  // дети совсем толстые
    .setMinRadius(0.1)
    .setMinLength(0.9)
    .setRadialSegments(5)
    .setUpPull(o.upPull ?? 0.45)
    .setDroop(o.droop ?? 0.05)
    .setTrunkClear(o.clear ?? 0.35)
    .build().geometry;
}

// покраска дерева: цвет по высоте + AO и порода в атрибуты
function paintWood(geo, colorFn, hTop, tintId = 0) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const ao = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    colorFn(y).toArray(colors, i * 3);
    ao[i] = 0.55 + 0.45 * Math.min(1, y / hTop);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(pos.count).fill(tintId), 1));
  return geo;
}

// Комки листвы, гарантированно накрывающие ВСЕ ветви скелета: жадно ставим
// эллипсоид на самую торчащую непокрытую вершину, пока голых веток не останется
// (раньше комки сыпались случайно и «рога» торчали из кроны).
function coverBranches(skel, crownY, rand, o = {}) {
  const pos = skel.attributes.position;
  const pts = [];
  for (let i = 0; i < pos.count; i += 6) {
    if (pos.getY(i) > crownY) pts.push({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) });
  }
  const clumps = [];
  while (pts.length) {
    let best = 0, bestD = -1;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = p.x * p.x + p.z * p.z + p.y * p.y * 0.3; // сперва наружу и вверх
      if (d > bestD) { bestD = d; best = i; }
    }
    const p0 = pts[best];
    const r = (o.rMin ?? 1.3) + rand() * (o.rVar ?? 0.9);
    const squash = (o.squash ?? 0.7) + rand() * 0.15;
    // центр — чуть внутрь к оси (не дальше 0.4r), чтобы комок налез на ветку
    const d0 = Math.hypot(p0.x, p0.z) || 1;
    const pull = Math.min(0.4 * r / d0, 0.45);
    const c = { x: p0.x * (1 - pull), y: Math.max(p0.y, o.minY ?? 0), z: p0.z * (1 - pull), r, squash };
    clumps.push(c);
    pts.splice(best, 1);
    const rr = r * 0.92, ry = rr * squash;
    for (let i = pts.length - 1; i >= 0; i--) {
      const dx = pts[i].x - c.x, dy = pts[i].y - c.y, dz = pts[i].z - c.z;
      if ((dx * dx + dz * dz) / (rr * rr) + (dy * dy) / (ry * ry) < 1) pts.splice(i, 1);
    }
  }
  return clumps;
}

function pine(rand) { // сосна: голый ствол, лапы и сплошные комки хвои
  const h = 14 + rand() * 6;
  const parts = [];
  const bark = new THREE.Color(0x6d5238);
  const skel = skeleton(rand, {
    len: h * 0.9, radius: 0.26, levels: 2, children: [5],
    branchAngle: [68], clear: 0.72, droop: 0.25, upPull: 0.15, lengthRatio: 0.4,
  });
  parts.push(paintWood(skel, () => bark, h * 0.7, 2));
  const green = new THREE.Color().setHSL(0.27 + rand() * 0.04, 0.4 + rand() * 0.14, 0.22 + rand() * 0.05);
  // комки хвои жадным покрытием ветвей — ни одна лапа не торчит голой
  for (const c of coverBranches(skel, h * 0.6, rand, { rMin: 1.5, rVar: 0.9, squash: 0.5 })) {
    const blob = lumpySphere(c.r, c.squash, rand, 2);
    blob.translate(c.x, c.y, c.z);
    parts.push(colored(blob, green, (yy) => 0.5 + 0.5 * (yy - (c.y - c.r)) / (c.r * 1.4), 1));
  }
  // шапка на макушке
  const top = lumpySphere(1.6 + rand() * 0.5, 0.6, rand, 2);
  top.translate(0, h * 0.98, 0);
  parts.push(colored(top, green, (yy) => 0.6 + 0.4 * (yy - h * 0.9) / 2, 1));
  return mergeGeometries(parts);
}

// лиственные: берёза (белый ствол с поясками), дуб (тёмный, раскидистый), липа
const DECIDUOUS = [
  { trunk: 0xd6d2c4, hue: 0.24, sat: 0.45, lit: 0.26 }, // берёза
  { trunk: 0x6b5136, hue: 0.28, sat: 0.4, lit: 0.2 },   // дуб
  { trunk: 0x7d684a, hue: 0.21, sat: 0.5, lit: 0.28 },  // липа
];
function deciduous(rand, kind) {
  const k = DECIDUOUS[kind];
  const h = 10 + rand() * 4;
  const wide = kind === 1 ? 1.25 : 1; // дуб раскидистее
  const trunkCol = new THREE.Color(k.trunk);
  const parts = [];

  const skel = skeleton(rand, {
    len: h * 0.8, radius: kind === 1 ? 0.28 : 0.21,
    children: [3, 4], branchAngle: [42, 55], upPull: 0.45, clear: 0.35,
  });
  if (kind === 0) { // берёза: белая с тонкими частыми чёрными поясками
    const black = new THREE.Color(0x22201c);
    const phase = rand() * 10;
    parts.push(paintWood(skel, (y) => (Math.sin(y * 5.5 + phase) > 0.93 ? black : trunkCol), h * 0.7, 5));
  } else {
    parts.push(paintWood(skel, () => trunkCol, h * 0.7, 4));
  }

  // листва — жадное покрытие ветвей СПЛОШНЫМИ комками (объёмный лоу-поли);
  // у берёзы крона заметно мельче
  const green = new THREE.Color().setHSL(k.hue + rand() * 0.05, k.sat + rand() * 0.12, k.lit + rand() * 0.06);
  const birch = kind === 0;
  const addClump = (x, y, z, r, squash) => {
    const blob = lumpySphere(r, squash, rand, 2);
    blob.translate(x, y, z);
    parts.push(colored(blob, green, (yy) => 0.48 + 0.52 * (yy - (y - r)) / (r * 1.6), 3));
  };
  // minY держит низ кроны над проездом машины
  const clumpOpts = birch
    ? { rMin: 0.85, rVar: 0.5, minY: 3.4 }
    : { rMin: 1.4 * wide, rVar: 0.9, minY: 3.4 };
  for (const c of coverBranches(skel, Math.max(h * 0.33, 3.0), rand, clumpOpts))
    addClump(c.x, c.y, c.z, c.r, c.squash);
  // шапка на самой макушке
  addClump(0, h * 1.0, 0, birch ? 1.0 + rand() * 0.3 : (1.9 + rand() * 0.5) * wide, 0.75);
  // leafColor — для падающих листьев при таране: тот же цвет, что у кроны
  return { geo: mergeGeometries(parts), leafColor: green.clone() };
}

// куст — маленькое широкое дерево: стволики и сплошная лоу-поли крона
// комками; у ягодного сверху видны красные ягоды
function bush(rand, berry = false) {
  const parts = [];
  const green = new THREE.Color().setHSL(0.3 + rand() * 0.05, 0.5 + rand() * 0.15, 0.16 + rand() * 0.05);
  const twigCol = new THREE.Color(0x4a3a26);
  for (let i = 0; i < 3; i++) { // стволики
    const a = rand() * Math.PI * 2, d = rand() * 0.3;
    const twig = new THREE.CylinderGeometry(0.02, 0.045, 0.7, 5);
    twig.translate(Math.cos(a) * d, 0.35, Math.sin(a) * d);
    parts.push(colored(twig, twigCol, null, 4));
  }
  // крона: широкий нижний комок + пара комков сверху
  const lumps = [[0, 0.68, 0, 0.85, 0.75], [0.3, 0.95, 0.2, 0.5, 0.8], [-0.28, 0.98, -0.18, 0.45, 0.8]];
  for (const [x, y, z, r, squash] of lumps) {
    const blob = lumpySphere(r * (0.9 + rand() * 0.25), squash, rand);
    blob.translate(x, y, z);
    parts.push(colored(blob, green.clone().offsetHSL((rand() - 0.5) * 0.03, 0, (rand() - 0.5) * 0.05), (yy) => 0.45 + 0.55 * yy / 1.5, 3));
  }
  if (berry) { // видимые ягоды сверху куста
    const red = new THREE.Color(0xd0302e);
    const n = 6 + (rand() * 3 | 0);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, d = 0.15 + rand() * 0.55;
      const b = new THREE.SphereGeometry(0.075, 6, 5);
      b.translate(Math.cos(a) * d, 0.95 + rand() * 0.35, Math.sin(a) * d);
      parts.push(colored(b, red, () => 1));
    }
  }
  return mergeGeometries(parts);
}

function reeds(rand) { // камыш: пучок стеблей с бурыми початками
  const parts = [];
  const stemCol = new THREE.Color(0x3f6b2a);
  const cobCol = new THREE.Color(0x5f4426);
  const n = 4 + (rand() * 4 | 0);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, d = rand() * 0.3;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const h = 1.3 + rand() * 1.0;
    const stem = new THREE.CylinderGeometry(0.018, 0.032, h, 4);
    stem.translate(x, h / 2, z);
    parts.push(colored(stem, stemCol, (yy) => 0.6 + 0.4 * yy / h));
    if (rand() < 0.75) { // не на каждом стебле
      const cob = new THREE.CylinderGeometry(0.05, 0.055, 0.3, 5);
      cob.translate(x, h + 0.1, z);
      parts.push(colored(cob, cobCol, () => 1));
    }
  }
  return mergeGeometries(parts);
}

function stone(rand) { // валун, чуть врос в землю; пикерами не красится
  const r = 0.7 + rand() * 0.6;
  const rock = lumpySphere(r, 0.55 + rand() * 0.15, rand);
  rock.translate(0, r * 0.28, 0);
  const gray = new THREE.Color().setHSL(0.08 + rand() * 0.04, 0.04 + rand() * 0.05, 0.42 + rand() * 0.1);
  return colored(rock, gray, (yy) => 0.55 + 0.45 * yy / r);
}

function mushroom(rand, fly) { // гриб: купол-шляпка, плоский светлый низ, ножка
  const stemH = 0.22 + rand() * 0.12;
  const parts = [trunkGeo(0.05, 0.065, stemH, new THREE.Color(0xd9d0bf), 0.75)];
  const capR = 0.16 + rand() * 0.09;
  const cap = new THREE.SphereGeometry(capR, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.72, 1);
  cap.translate(0, stemH, 0);
  const capColored = colored(cap,
    fly ? new THREE.Color(0xb03226) : new THREE.Color(0x8a6b46),
    (yy) => 0.75 + 0.25 * (yy - stemH) / (capR * 0.72));
  if (fly) { // белые крапинки мухомора — по целым граням
    const cc = capColored.attributes.color;
    for (let i = 0; i + 2 < cc.count; i += 3) {
      if (rand() < 0.16) {
        for (let k = 0; k < 3; k++) cc.setXYZ(i + k, 0.9, 0.88, 0.82);
      }
    }
  }
  parts.push(capColored);
  // пластинки: плоский диск другого цвета под шляпкой
  const under = new THREE.CircleGeometry(capR * 0.98, 7);
  under.rotateX(Math.PI / 2); // лицом вниз
  under.translate(0, stemH + 0.004, 0);
  parts.push(colored(under, new THREE.Color(fly ? 0xe8e2d2 : 0xcbb98f)));
  return mergeGeometries(parts);
}

// оттенки пород (панель «Цвета»); базы — для калибровки пикеров
export const treeTints = {
  conifer: uniform(new THREE.Color(1, 1, 1)),      // хвоя
  coniferTrunk: uniform(new THREE.Color(1, 1, 1)),
  leaf: uniform(new THREE.Color(1, 1, 1)),         // листва лиственных и кустов
  leafTrunk: uniform(new THREE.Color(1, 1, 1)),
  birchTrunk: uniform(new THREE.Color(1, 1, 1)),
};
export const TINT_BASES = {
  conifer: 0x2e4a20, coniferTrunk: 0x5a4429,
  leaf: 0x4d7026, leafTrunk: 0x745c40, birchTrunk: 0xd6d2c4,
};

// Запечённые тени мира + self-AO + пер-породные оттенки.
// У материала с map (хвоя сосен) кастомный colorNode обошёл бы текстуру —
// возвращаем прорезь по альфе явными opacity/alphaTest-узлами.
export function applyForestShadows(mat, shadowTex) {
  const baked = texture(shadowTex, vec2(
    positionWorld.x.add(SIZE / 2).div(SIZE),
    float(SIZE / 2).sub(positionWorld.z).div(SIZE),
  )).r;
  const shade = mix(float(1), baked, shadowStrength);
  const selfAo = mix(float(1), attribute('ao', 'float'), shadowStrength); // и self-shadows
  const id = attribute('tint', 'float');
  const mask = (k) => float(1).sub(id.sub(k).abs().clamp(0, 1));
  const tint = vec3(1, 1, 1).mul(mask(0))
    .add(treeTints.conifer.mul(mask(1)))
    .add(treeTints.coniferTrunk.mul(mask(2)))
    .add(treeTints.leaf.mul(mask(3)))
    .add(treeTints.leafTrunk.mul(mask(4)))
    .add(treeTints.birchTrunk.mul(mask(5)));
  mat.colorNode = attribute('color', 'vec3').mul(tint).mul(selfAo).mul(shade);
  if (mat.map) {
    mat.opacityNode = texture(mat.map, uv()).a;
    mat.alphaTestNode = float(0.5);
  }
  mat.needsUpdate = true;
}

export function createForest() {
  const rand = mulberry32(20250731);
  const templates = [];
  for (let i = 0; i < 2; i++) templates.push({ geo: spruce(rand), trunkR: 0.36 });
  for (let i = 0; i < 2; i++) templates.push({ geo: pine(rand), trunkR: 0.36 });
  for (let i = 0; i < 8; i++) {
    const d = deciduous(rand, i % 3);
    templates.push({ geo: d.geo, leafColor: d.leafColor, trunkR: 0.27 });
  }
  const bushIds = [templates.push({ geo: bush(rand) }) - 1, templates.push({ geo: bush(rand) }) - 1];
  const berryBushIds = [templates.push({ geo: bush(rand, true) }) - 1];
  const stoneIds = [templates.push({ geo: stone(rand) }) - 1, templates.push({ geo: stone(rand) }) - 1];
  const shroomIds = [templates.push({ geo: mushroom(rand, true) }) - 1, templates.push({ geo: mushroom(rand, false) }) - 1];
  const reedIds = [templates.push({ geo: reeds(rand) }) - 1, templates.push({ geo: reeds(rand) }) - 1];

  let maxVerts = 0, maxIndices = 0;
  for (const t of templates) {
    maxVerts += t.geo.attributes.position.count;
    maxIndices += (t.geo.index ? t.geo.index.count : t.geo.attributes.position.count);
    t.geo.computeBoundingBox();
    t.h = t.geo.boundingBox.max.y; // высота шаблона — для спавна листьев/шишек
  }

  // Lambert: тени гаснут в чёрный, без зеркального отблеска окружения
  const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true, flatShading: true });
  const POND_DECOR = 220; // камешки и камыш вокруг пруда
  const mesh = new THREE.BatchedMesh(COUNT + BUSHES + STONES + MUSHROOMS + POND_DECOR, maxVerts, maxIndices, mat);
  const geoIds = templates.map((t) => mesh.addGeometry(t.geo));

  // лес почти всюду, поляны — только в глубоком минусе шума
  const noise = new ImprovedNoise();
  const density = (x, z) => {
    const n = noise.noise(x * 0.012 + 50, z * 0.012 + 9, 3.7);
    const t = THREE.MathUtils.clamp((n + 0.42) / 0.45, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const slopeAt = (x, z) => {
    const hx = terrainHeight(x + 1, z) - terrainHeight(x - 1, z);
    const hz = terrainHeight(x, z + 1) - terrainHeight(x, z - 1);
    return 1 / Math.hypot(1, hx / 2, hz / 2);
  };

  const trees = [];
  const m = new THREE.Matrix4(), e = new THREE.Euler(), q = new THREE.Quaternion();
  const p = new THREE.Vector3(), sc = new THREE.Vector3();
  const cells = new Set(); // сетка: не гуще одного дерева на ячейку TREE_SPACING
  let placed = 0, attempts = 0;
  while (placed < COUNT && attempts++ < COUNT * 14) {
    const x = (rand() - 0.5) * (SIZE - 6);
    const z = (rand() - 0.5) * (SIZE - 6);
    if (Math.hypot(x, z) < 32) continue;          // пруд с песчаным берегом
    if (Math.hypot(x - 45, z) < 12) continue;     // спаун у берега
    if (onBase(x, z)) continue;                   // поляны баз
    if (!onLand(x, z)) continue;                  // не в море и не на обрыве
    if (slopeAt(x, z) < 0.5) continue;
    if (rand() >= density(x, z)) continue;
    const cell = ((x + SIZE / 2) / TREE_SPACING | 0) * 2048 + ((z + SIZE / 2) / TREE_SPACING | 0);
    if (cells.has(cell)) continue;
    cells.add(cell);

    // почти весь лес — сосны: 72% сосен, 13% елей, 15% лиственных
    const k = rand();
    const ti = k < 0.13 ? (rand() * 2 | 0) : k < 0.28 ? 4 + (rand() * 8 | 0) : 2 + (rand() * 2 | 0);
    const s = 0.7 + rand() * rand() * 0.9;        // квадратичный уклон: гиганты редки
    const id = mesh.addInstance(geoIds[ti]);
    p.set(x, terrainHeight(x, z) - 0.15, z);
    e.set((rand() - 0.5) * 0.08, rand() * Math.PI * 2, (rand() - 0.5) * 0.08);
    sc.set(s * (0.9 + rand() * 0.2), s, s * (0.9 + rand() * 0.2));
    mesh.setMatrixAt(id, m.compose(p, q.setFromEuler(e), sc));
    // batchId/conifer/h/leaf — для таранов: шатание, листья цвета кроны или шишки
    trees.push({
      x, z, s, trunkR: templates[ti].trunkR * s, batchId: id,
      conifer: ti < 4, h: templates[ti].h * s, leaf: templates[ti].leafColor,
    });
    placed++;
  }

  // кусты — на опушках и полянах; камни — где угодно; грибы — в лесу
  const stones = [], mushrooms = [], bushes = [];
  const place = (ids, count, sMin, sMax, sink, cond, clearR = 14) => {
    let n = 0, tries = 0;
    while (n < count && tries++ < count * 12) {
      const x = (rand() - 0.5) * (SIZE - 6);
      const z = (rand() - 0.5) * (SIZE - 6);
      if (Math.hypot(x, z) < clearR) continue;
      if (onBase(x, z)) continue;
      if (!onLand(x, z)) continue;
      const d = density(x, z);
      if (!cond(d)) continue;
      const s = sMin + rand() * (sMax - sMin);
      const pick = (rand() * ids.length) | 0;
      const id = mesh.addInstance(ids[pick]);
      p.set(x, terrainHeight(x, z) - sink * s, z);
      e.set(0, rand() * Math.PI * 2, 0);
      sc.setScalar(s);
      mesh.setMatrixAt(id, m.compose(p, q.setFromEuler(e), sc));
      n++;
      if (ids === stoneIds) stones.push({ x, z, r: 0.75 * s, s, gi: pick });
      if (ids === shroomIds) mushrooms.push({ x, z, s, batchId: id, gi: pick });
      // куст помнит, ягодный ли он — только такие дают ягоды при таране
      if (ids === bushIds || ids === berryBushIds) bushes.push({ x, z, s, batchId: id, berry: ids === berryBushIds });
    }
  };
  place(bushIds, Math.round(BUSHES * (1 - BERRY_CHANCE)), 0.7, 1.5, 0.1, (d) => d < 0.75 && rand() < 0.6, 28);
  place(berryBushIds, Math.round(BUSHES * BERRY_CHANCE), 0.9, 1.5, 0.1, (d) => d < 0.75 && rand() < 0.6, 28);
  place(stoneIds, STONES, 0.6, 1.6, 0.12, () => true, 28); // у камней коллайдеры
  place(shroomIds, MUSHROOMS, 1.3, 2.2, 0.02, (d) => d > 0.45); // крупные и редкие

  // прудик: мелкие камешки по берегу и камыш кое-где у самой кромки
  // (без коллайдеров: мелочь, машина проезжает)
  const pondDecor = (ids, count, rMin, rMax, sMin, sMax, sink) => {
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const edge = lakeEdgeR(Math.cos(a) * 20, Math.sin(a) * 20);
      const r = edge + rMin + rand() * (rMax - rMin);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const id = mesh.addInstance(ids[(rand() * ids.length) | 0]);
      p.set(x, terrainHeight(x, z) - sink, z);
      e.set(0, rand() * Math.PI * 2, 0);
      const s = sMin + rand() * (sMax - sMin);
      mesh.setMatrixAt(id, m.compose(p, q.setFromEuler(e), sc.setScalar(s)));
    }
  };
  pondDecor(stoneIds, 140, 0.3, 7.5, 0.1, 0.38, 0.02);
  pondDecor(reedIds, 75, -0.7, 1.7, 0.8, 1.35, 0.04);

  return {
    mesh, trees, stones, mushrooms, bushes,
    shroomGeos: shroomIds.map((i) => templates[i].geo),
    stoneGeos: stoneIds.map((i) => templates[i].geo), // для честных коллайдеров камней
    bushPlainGi: bushIds[0], // обобранный ягодный куст подменяется этим шаблоном
    material: mat,
  };
}
