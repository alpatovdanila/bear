import * as THREE from 'three/webgpu';
import {
  positionWorld, time, vec3, float, mix, normalView, positionView,
  mx_fractal_noise_float, transformNormalToView,
} from 'three/tsl';

// Спокойная вода: мелкая процедурная рябь нормалей + френелевые отражения
// неба (Standard-материал сэмплит scene.environment), прозрачность зависит
// от угла взгляда — сверху видно «глубину», под острым углом — зеркало.
// Шум — MaterialX: полиномиальный, не взрывается NaN на больших мировых
// координатах (грабли с sin() из GDD).
export function waterMaterial({ color = 0x2e6f95, amp = 0.12, scale = 0.4, speed = 0.4 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({
    color, roughness: 0.08, metalness: 0, transparent: true,
  });
  const p = positionWorld.xz.mul(scale);
  const t = time.mul(speed);
  // два независимых поля ряби — наклоны нормали по двум осям плоскости
  const n1 = mx_fractal_noise_float(vec3(p.x, p.y, t), 3, 2.2, 0.55);
  const n2 = mx_fractal_noise_float(vec3(p.x.add(53.7), p.y.sub(31.4), t.add(11)), 3, 2.2, 0.55);
  // локаль плоскости воды: +Z — вверх (сама плоскость повёрнута на -90° по X)
  mat.normalNode = transformNormalToView(vec3(n1.mul(amp), n2.mul(amp), 1).normalize());
  // угол взгляда: 1 — смотрим в упор сверху, 0 — скользящий
  const cosV = normalView.dot(positionView.normalize().negate()).clamp(0, 1);
  mat.opacityNode = mix(float(0.97), float(0.78), cosV);
  return mat;
}
