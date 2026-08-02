import * as THREE from 'three/webgpu';
import { createBear } from './bear.js';
import { materialColor, positionWorld, texture, vec2, float, mix } from 'three/tsl';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { SIZE, shadowStrength } from './terrain.js';

// Хэтчбэк по лоу-поли референсу: оранжевый корпус, чёрная юбка (бампера +
// пороги), белые фары с янтарными поворотниками, зауженная кверху крыша.
// Локальные оси: +X — вперёд, +Y — вверх, +Z — правый борт. y=0 — пороги.

export const CAR = {
  width: 1.7,
  wheelBase: 2.5,      // колёса на x = ±1.25
  track: 1.44,
  wheelRadius: 0.42, // лифтованный — большие зубастые колёса
  wheelWidth: 0.3,
};

// ---------- материалы ----------
export const M = {
  // синий металлик; бампера и резина — матовые (PBR-контраст)
  body: new THREE.MeshStandardNodeMaterial({ color: 0x2456b8, roughness: 0.28, metalness: 0.55 }),
  glass: new THREE.MeshStandardNodeMaterial({
    color: 0x46555e, roughness: 0.12, metalness: 0.3,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  }),
  dark: new THREE.MeshStandardNodeMaterial({ color: 0x1c1c1e, roughness: 0.95, metalness: 0 }),
  chrome: new THREE.MeshStandardNodeMaterial({ color: 0xb9bcbf, roughness: 0.3, metalness: 0.7 }),
  rim: new THREE.MeshStandardNodeMaterial({ color: 0x8f9296, roughness: 0.45, metalness: 0.5 }),
  interior: new THREE.MeshStandardNodeMaterial({ color: 0x2a2624, roughness: 0.95 }),
  seat: new THREE.MeshStandardNodeMaterial({ color: 0x3b332c, roughness: 0.9 }),
  headlight: new THREE.MeshStandardNodeMaterial({ color: 0xf4f4ee, emissive: 0xf4f4ee, emissiveIntensity: 0.25 }),
  amber: new THREE.MeshStandardNodeMaterial({ color: 0xf09c28, emissive: 0xf09c28, emissiveIntensity: 0.3 }),
  taillight: new THREE.MeshStandardNodeMaterial({ color: 0xc22318, emissive: 0xc22318, emissiveIntensity: 0.3 }),
  plate: new THREE.MeshStandardNodeMaterial({ color: 0xf2f2f2, roughness: 0.6 }),
};
for (const k in M) M[k].flatShading = true; // единая flat-shaded эстетика
M.glass.flatShading = false;

// Рабочие стоп-сигналы: при торможении фонари вспыхивают
export function setBrakeLights(on) {
  M.taillight.emissiveIntensity = on ? 1.7 : 0.3;
}

// Номер «MED» мультяшным рубленым шрифтом — канвас-текстура
function plateTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = '#1a1a1a';
  ctx.font = '900 44px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('M E D', 128, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Кузов затеняется запечёнными тенями крон, как земля и трава
export function applyCarShade(shadowTex) {
  const baked = texture(shadowTex, vec2(
    positionWorld.x.add(SIZE / 2).div(SIZE),
    float(SIZE / 2).sub(positionWorld.z).div(SIZE),
  )).r;
  const shade = mix(float(1), baked, shadowStrength);
  for (const k in M) {
    M[k].colorNode = materialColor.mul(shade);
    M[k].needsUpdate = true;
  }
}

// ---------- кузов ----------
// Рубленый рамный внедорожник в духе Pajero MK1: квадратный отвесный перёд,
// плоский короткий капот, большая кабина, отвесный зад
function silhouette() {
  const s = new THREE.Shape();
  s.moveTo(-1.86, 0.1);
  s.lineTo(1.86, 0.1);
  s.lineTo(1.92, 0.62);    // отвесная квадратная морда
  s.lineTo(1.7, 0.72);     // кромка капота
  s.lineTo(0.92, 0.76);    // плоский короткий капот
  s.lineTo(0.42, 1.3);     // лобовое
  s.lineTo(-1.6, 1.33);    // плоская крыша — медведь с ушами внутри
  s.lineTo(-1.86, 0.7);    // отвесный зад
  s.lineTo(-1.9, 0.32);
  s.closePath();
  return s;
}

function box(w, h, d, x, y, z, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

const archGeos = (w) => {
  const list = [];
  for (const x of [1.25, -1.25]) {
    for (const side of [-1, 1]) {
      const arch = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 24);
      arch.rotateX(Math.PI / 2);
      arch.translate(x, 0.06, side * (w / 2 + 0.11 - 0.25));
      list.push(arch);
    }
  }
  return list;
};

function csgSubtract(baseGeo, baseMat, geos) {
  const ev = new Evaluator();
  let out = new Brush(baseGeo, baseMat);
  for (const g of geos) {
    const b = new Brush(g, M.dark);
    b.updateMatrixWorld();
    out = ev.evaluate(out, b, SUBTRACTION);
  }
  return out;
}

function buildBody() {
  const w = CAR.width - 0.08;
  const bodyGeo = new THREE.ExtrudeGeometry(silhouette(), {
    depth: w, bevelEnabled: true,
    bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2,
  });
  bodyGeo.translate(0, 0, -w / 2);
  // tumblehome: крыша уже порогов — борта заваливаются внутрь выше пояса
  const pos = bodyGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0.78) pos.setZ(i, pos.getZ(i) * (1 - (y - 0.78) * 0.22));
  }

  const cuts = [...archGeos(w)];
  // полость салона — высокая кабина: медведь сидит, уши не торчат
  cuts.push(box(2.35, 1.24, 1.46, -0.55, 0.66, 0));
  // проёмы стёкол
  const wsAngle = Math.atan2(1.3 - 0.76, 0.42 - 0.92);
  cuts.push(box(0.62, 0.5, 1.34, 0.67, 1.03, 0, wsAngle));
  const rsAngle = Math.atan2(0.7 - 1.33, -1.86 + 1.6);
  cuts.push(box(0.48, 0.5, 1.24, -1.71, 1.02, 0, rsAngle));
  const sideWin = (pts) => {
    const sh = new THREE.Shape();
    sh.moveTo(...pts[0]);
    for (let i = 1; i < pts.length; i++) sh.lineTo(...pts[i]);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 2.4, bevelEnabled: false });
    g.translate(0, 0, -1.2);
    return g;
  };
  // два боковых проёма: дверное окно до самой лобовой стойки (стойка тонкая)
  cuts.push(sideWin([[0.55, 0.8], [0.18, 1.17], [-0.66, 1.17], [-0.66, 0.8]]));
  cuts.push(sideWin([[-0.78, 0.8], [-0.78, 1.17], [-1.45, 1.17], [-1.56, 0.8]]));

  const body = csgSubtract(bodyGeo, M.body, cuts);
  body.castShadow = true;
  return body;
}

// Чёрная юбка: бампера и пороги единым контуром, чуть шире и длиннее кузова
function buildSkirt() {
  const w = CAR.width - 0.02;
  const s = new THREE.Shape();
  s.moveTo(-2.03, 0.02);
  s.lineTo(2.02, 0.02);
  s.lineTo(2.02, 0.24);
  s.lineTo(1.96, 0.34);   // губа переднего бампера
  s.lineTo(-1.97, 0.34);  // пороги/задний бампер
  s.lineTo(-2.03, 0.24);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: w, bevelEnabled: true,
    bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1,
  });
  geo.translate(0, 0, -w / 2);
  const skirt = csgSubtract(geo, M.dark, archGeos(w));
  skirt.castShadow = true;
  return skirt;
}

// ---------- стёкла ----------
function slopeGlass(p1, p2, width) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const inv = -0.01 / Math.hypot(dx, dy); // внутрь на 1 см
  const nx = dy * inv, ny = -dx * inv;
  const hw = width / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    p1.x + nx, p1.y + ny, -hw, p1.x + nx, p1.y + ny, hw,
    p2.x + nx, p2.y + ny, hw, p2.x + nx, p2.y + ny, -hw,
  ]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, M.glass);
}

function sideGlass(pts, z) {
  const sh = new THREE.Shape();
  sh.moveTo(...pts[0]);
  for (let i = 1; i < pts.length; i++) sh.lineTo(...pts[i]);
  sh.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), M.glass);
  m.position.z = z;
  return m;
}

function addGlass(car) {
  const w = CAR.width - 0.08;
  car.add(slopeGlass({ x: 0.92, y: 0.76 }, { x: 0.42, y: 1.3 }, 1.3));
  car.add(slopeGlass({ x: -1.6, y: 1.33 }, { x: -1.86, y: 0.7 }, 1.2));
  const front = [[0.55, 0.8], [0.18, 1.17], [-0.66, 1.17], [-0.66, 0.8]];
  const rear = [[-0.78, 0.8], [-0.78, 1.17], [-1.45, 1.17], [-1.56, 0.8]];
  for (const side of [-1, 1]) {
    car.add(sideGlass(front, side * (w / 2 - 0.05)));
    car.add(sideGlass(rear, side * (w / 2 - 0.05)));
  }
}

// ---------- салон ----------
function seat(x, z, wide = 0.5) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, wide), M.seat);
  base.position.set(x, 0.36, z);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.52, wide), M.seat);
  back.position.set(x - 0.28, 0.62, z);
  back.rotation.z = -0.2;
  g.add(base, back);
  if (wide < 1) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.26), M.seat);
    head.position.set(x - 0.38, 0.98, z);
    g.add(head);
  }
  return g;
}

function steeringWheel() {
  // rim — отдельная под-группа с чистой осью вращения: крутится по steer
  const rim = new THREE.Group();
  rim.add(new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 10, 24), M.dark));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.17, 0.02), M.dark);
    spoke.position.set(Math.sin(a) * 0.08, Math.cos(a) * 0.08, 0);
    spoke.rotation.z = -a;
    rim.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 12), M.dark);
  hub.rotation.x = Math.PI / 2;
  rim.add(hub);
  const face = new THREE.Group();
  face.add(rim);
  face.rotation.y = Math.PI / 2;

  const g = new THREE.Group();
  g.add(face);
  g.rotation.z = -0.45;
  g.position.set(0.14, 0.82, -0.42);
  g.userData.face = face; // обод — крутится вместе с рулём игрока
  return g;
}

function addInterior(car) {
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 1.42), M.interior);
  dash.position.set(0.42, 0.62, 0);
  dash.rotation.z = -0.12;
  car.add(dash);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.28, 10), M.interior);
  col.rotation.z = 1.12;
  col.position.set(0.28, 0.74, -0.42);
  car.add(col);
  const sw = steeringWheel();
  car.add(sw);
  car.add(seat(-0.25, -0.42), seat(-0.25, 0.42));
  car.add(seat(-1.05, 0, 1.3));
  return sw.userData.face;
}

// ---------- внешние детали ----------
function addDetails(car) {
  const w = CAR.width - 0.08;
  const side2 = [-1, 1];

  // Круглые фары на отвесной морде + янтарные поворотники в углах
  for (const s of side2) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 16), M.headlight);
    lens.rotation.z = Math.PI / 2;
    lens.position.set(1.92, 0.46, s * 0.5);
    car.add(lens);
    const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.04, 16), M.chrome);
    bezel.rotation.z = Math.PI / 2;
    bezel.position.set(1.91, 0.46, s * 0.5);
    car.add(bezel);
    const signal = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.13), M.amber);
    signal.position.set(1.9, 0.46, s * 0.75);
    car.add(signal);
    // задние фонари — широкие полосы
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.44), M.taillight);
    tail.position.set(-1.945, 0.48, s * 0.42);
    car.add(tail);
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.14, 0.62), M.dark);
  grille.position.set(1.925, 0.46, 0);
  car.add(grille);

  // выступающие бампера — рубленые чёрные брусья за габаритом кузова
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 1.82), M.dark);
  bumperF.position.set(2.0, 0.3, 0);
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 1.82), M.dark);
  bumperR.position.set(-1.96, 0.3, 0);
  car.add(bumperF, bumperR);

  // Номера «MED» — на юбке
  const plateMat = new THREE.MeshStandardNodeMaterial({ map: plateTexture(), roughness: 0.6 });
  for (const [x, ry] of [[2.036, Math.PI / 2], [-2.046, -Math.PI / 2]]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.11), plateMat);
    plate.position.set(x, 0.16, 0);
    plate.rotation.y = ry;
    car.add(plate);
  }

  // Швы дверей — двухдверка: по два шва на борт, ручка одна
  for (const s of side2) {
    for (const x of [0.42, -0.72]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.62, 0.012), M.dark);
      seam.position.set(x, 0.5, s * (w / 2 + 0.038));
      car.add(seam);
    }
    {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.032, 0.03), M.dark);
      handle.position.set(-0.5, 0.7, s * (w / 2 + 0.042));
      car.add(handle);
    }
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.1), M.body);
    arm.position.set(0.42, 0.78, s * (w / 2 + 0.06));
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.18), M.dark);
    mirror.position.set(0.38, 0.82, s * (w / 2 + 0.13));
    car.add(arm, mirror);
  }

  // Дворники
  const wsAngle = Math.atan2(1.14 - 0.7, -0.08 - 0.55);
  for (const z of [-0.35, 0.2]) {
    const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.025), M.dark);
    wiper.rotation.z = wsAngle;
    wiper.position.set(0.42, 0.79, z);
    wiper.rotation.y = z < 0 ? 0.12 : 0.2;
    car.add(wiper);
  }

  // Выхлоп и антенна
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 12), M.chrome);
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set(-2.0, 0.1, 0.5);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.004, 0.28, 6), M.dark);
  antenna.position.set(0.5, 0.76, -0.6);
  antenna.rotation.x = -0.25;
  car.add(pipe, antenna);
}

// ---------- колёса ----------
// Джиперское колесо булевым стеком: шина с CSG-канавками протектора шире
// утопленного диска с отверстиями. Дорогой CSG строится один раз, потом клоны.
let wheelProto = null;
function buildWheelProto() {
  const R = CAR.wheelRadius, W = CAR.wheelWidth;
  // шина: цилиндр, из которого вырезаны поперечные канавки — крупные шашки
  const tireGeo = new THREE.CylinderGeometry(R, R, W, 22);
  tireGeo.rotateX(Math.PI / 2);
  const cuts = [];
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2;
    const groove = new THREE.BoxGeometry(0.06, 0.08, W + 0.04);
    groove.rotateZ(a);
    groove.translate(Math.cos(a) * R, Math.sin(a) * R, 0);
    cuts.push(groove);
  }
  // посадочные карманы с обеих сторон: диск утоплен, шина шире диска
  for (const s of [-1, 1]) {
    const pocket = new THREE.CylinderGeometry(R * 0.62, R * 0.62, W * 0.4, 18);
    pocket.rotateX(Math.PI / 2);
    pocket.translate(0, 0, s * W * 0.42);
    cuts.push(pocket);
  }
  const tire = csgSubtract(tireGeo, M.dark, cuts);
  tire.castShadow = true;

  // диск: тарелка с шестью круглыми окнами + ступица
  const rimGeo = new THREE.CylinderGeometry(R * 0.6, R * 0.6, W * 0.3, 18);
  rimGeo.rotateX(Math.PI / 2);
  const holes = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const hole = new THREE.CylinderGeometry(R * 0.13, R * 0.13, W, 10);
    hole.rotateX(Math.PI / 2);
    hole.translate(Math.cos(a) * R * 0.34, Math.sin(a) * R * 0.34, 0);
    holes.push(hole);
  }
  const rim = csgSubtract(rimGeo, M.rim, holes);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.13, R * 0.13, W * 0.44, 10), M.chrome);
  hub.rotation.x = Math.PI / 2;
  rim.add(hub);

  const wheel = new THREE.Group();
  wheel.add(tire, rim); // порядок важен: syncWheels крутит children[0] и [1]
  return wheel;
}
function wheelMesh() {
  if (!wheelProto) wheelProto = buildWheelProto();
  return wheelProto.clone();
}

export function createCarMesh() {
  const car = new THREE.Group();
  car.add(buildBody());
  car.add(buildSkirt());
  addGlass(car);
  const steerFace = addInterior(car); // обод руля — крутится по vehicle.steer
  addDetails(car);

  // медведь за рулём (водительское место слева)
  const bear = createBear();
  bear.position.set(-0.22, 0.06, -0.42);
  car.add(bear);

  // багажник на крыше: рейлинги + поперечины; собранная еда складывается сюда
  const rack = new THREE.Group();
  rack.position.set(-0.55, 1.36, 0); // на высокой крыше «Нивы»
  const bar = (w2, h2, d2, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), M.dark);
    m.position.set(x, y, z);
    rack.add(m);
  };
  bar(1.35, 0.05, 0.07, 0, 0.08, -0.5);
  bar(1.35, 0.05, 0.07, 0, 0.08, 0.5);
  for (const x of [-0.6, -0.2, 0.2, 0.6]) bar(0.06, 0.04, 1.07, x, 0.09, 0);
  for (const x of [-0.55, 0.55]) for (const z of [-0.5, 0.5]) bar(0.05, 0.08, 0.05, x, 0.02, z);
  car.add(rack);

  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = wheelMesh();
    car.add(w);
    wheels.push(w);
  }
  return { car, wheels, rack, steerFace };
}
