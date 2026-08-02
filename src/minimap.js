import { SIZE, SEA_LEVEL, terrainHeight, inLake } from './terrain.js';

// Круглая миникарта в нижнем левом углу: карта острова запекается один раз
// (по той же terrainHeight, что рендер и физика), поверх — стрелка машины.

const MAP_N = 160;   // сетка сэмплов острова
const VIEW = 172;    // диаметр на экране, px

// bases: [{x, z, color}] — рисуются на статичной карте
export function createMinimap(bases = []) {
  // статичная карта острова
  const map = document.createElement('canvas');
  map.width = map.height = MAP_N;
  const mctx = map.getContext('2d');
  const img = mctx.createImageData(MAP_N, MAP_N);
  for (let iz = 0; iz < MAP_N; iz++) {
    for (let ix = 0; ix < MAP_N; ix++) {
      const x = (ix / (MAP_N - 1) - 0.5) * SIZE;
      const z = (iz / (MAP_N - 1) - 0.5) * SIZE;
      const h = terrainHeight(x, z);
      let r, g, b;
      if (inLake(x, z)) { r = 74; g = 142; b = 178; }          // прудик
      else if (h < SEA_LEVEL + 0.6) { r = 42; g = 104; b = 141; } // море
      else if (h < 1.5) { r = 199; g = 182; b = 132; }         // обрыв и песок
      else { r = 98; g = 150; b = 66; }                        // трава и лес
      const o = (iz * MAP_N + ix) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  mctx.putImageData(img, 0, 0);
  // базы — цветные кружки с белой обводкой прямо на карте
  for (const b of bases) {
    const bx = (b.x / SIZE + 0.5) * MAP_N, bz = (b.z / SIZE + 0.5) * MAP_N;
    mctx.fillStyle = '#' + b.color.toString(16).padStart(6, '0');
    mctx.strokeStyle = 'rgba(255,255,255,0.85)';
    mctx.lineWidth = 1;
    mctx.beginPath();
    mctx.arc(bx, bz, 3.2, 0, Math.PI * 2);
    mctx.fill();
    mctx.stroke();
  }

  const el = document.createElement('canvas');
  el.width = el.height = VIEW;
  el.style.cssText = 'position:fixed;left:14px;bottom:64px;width:172px;height:172px;'
    + 'border-radius:50%;border:2px solid rgba(255,255,255,0.5);z-index:9;'
    + 'pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,0.4)';
  document.body.appendChild(el);
  const ctx = el.getContext('2d');
  const R = VIEW / 2;

  // marks: [{x, z, color}] — живые точки (боты)
  function update(carPos, heading, marks = []) {
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(map, 0, 0, VIEW, VIEW);
    for (const mk of marks) { // другие медведи
      ctx.fillStyle = '#' + mk.color.toString(16).padStart(6, '0');
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc((mk.x / SIZE + 0.5) * VIEW, (mk.z / SIZE + 0.5) * VIEW, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // стрелка машины
    const mx = (carPos.x / SIZE + 0.5) * VIEW;
    const my = (carPos.z / SIZE + 0.5) * VIEW;
    ctx.translate(mx, my);
    ctx.rotate(heading);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, 4.5);
    ctx.lineTo(-5, -4.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  return { update };
}
