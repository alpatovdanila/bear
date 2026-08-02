// Процедурный звук двигателя: физически-информированная модель по мотивам
// Baldan/Delle Monache/Rocchesso «Physically informed car engine sound
// synthesis» и её открытых реализаций (DasEtwas/enginesound, Antonio-R1).
// Схема: фаза 4-тактного цикла → на каждый цилиндр давление (косинус хода
// поршня + полусинус вспышки с разбросом ампитуды от цикла к циклу) →
// волновод выпускного патрубка (клапан = переменный коэффициент отражения) →
// общий коллектор ↔ труба ↔ глушитель из 4 параллельных камер разной длины.
// Гармоники рождаются резонансами волноводов, а не осцилляторами; шум только
// гейченный (впуск) — поэтому «яркость» открывает тембр, а не песок.
// Тарахтение холостого — медленный (~57 Гц) джиттер фазы коленвала.

import { sliderPanel } from './ui.js';

const PROCESSOR = /* js */ `
class WG { // двунаправленный волновод: пара кольцевых линий задержки
  constructor(n, a, b) {
    this.n = Math.max(2, n | 0); this.a = a; this.b = b;
    this.c0 = new Float32Array(this.n); this.c1 = new Float32Array(this.n);
    this.i = 0; this.o0 = 0; this.o1 = 0;
  }
  step(in0, in1) {
    const e1 = this.c0[this.i], e0 = this.c1[this.i];
    this.o1 = e1 * (1 - Math.abs(this.b)); // прошло правый конец
    this.o0 = e0 * (1 - Math.abs(this.a)); // прошло левый конец
    this.c0[this.i] = in0 + e0 * this.a;
    this.c1[this.i] = in1 + e1 * this.b;
    this.i = (this.i + 1) % this.n;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 850, minValue: 0, maxValue: 8000 },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.cfg = { drone: 1, rumble: 1, noise: 1, intake: 1, bright: 1, reso: 1 };
    this.port.onmessage = (e) => Object.assign(this.cfg, e.data);
    const k = sampleRate / 48000;
    this.rev = 0;
    this.off = [0, 0.1255, 0.4996, 0.6497]; // неравномерный порядок — «лоуп»
    this.gFire = [1, 1, 1, 1];              // разброс вспышек цикл-к-циклу
    this.lastX = [0, 0, 0, 0];
    // выпускные патрубки (клапанный конец — a, коллекторный — b)
    this.runners = [46, 16, 34, 46].map((n) => new WG(n * k, 0.71, 0.06));
    this.pipe = new WG(294 * k, 0.06, 0.002);
    this.muffler = [7, 9, 10, 12].map((n) => new WG(n * k, 0.0, -0.14));
    this.collector = 0;
    this.jitterLp = 0;   // ~57 Гц джиттер коленвала
    this.noiseLp = 0;    // впускной шум
    this.vibLp = 0;      // вибрации блока, ~92 Гц
    this.dcLp = 0;       // DC-блокер 0.5 Гц
    this.lp = 0;         // выходной тон-фильтр
    this.wide = new Float32Array(2048); this.iw = 0;
    this.a57 = this.alpha(57); this.a92 = this.alpha(92);
    this.a11k = this.alpha(11000); this.aDC = this.alpha(0.5);
  }
  alpha(f) { const w = 6.2832 * f / sampleRate; return w / (w + 1); }

  process(inputs, outputs, params) {
    const out = outputs[0][0], outR = outputs[0][1] || out;
    const rpmP = params.rpm, thrP = params.throttle;
    const cfg = this.cfg;
    const dW = Math.round(sampleRate * 0.011);

    for (let i = 0; i < out.length; i++) {
      const rpm = rpmP.length > 1 ? rpmP[i] : rpmP[0];
      const thr = thrP.length > 1 ? thrP[i] : thrP[0];

      // фаза цикла (720°) и её медленное блуждание — тарахтение на низах
      this.jitterLp += this.a57 * ((Math.random() * 2 - 1) - this.jitterLp);
      const idleness = Math.max(0, 1 - rpm / 2600);
      const jitter = this.jitterLp * 0.11 * cfg.intake * (0.15 + idleness);
      this.rev += rpm / (120 * sampleRate);
      if (this.rev >= 1) this.rev -= 1;

      this.noiseLp += this.a11k * ((Math.random() * 2 - 1) - this.noiseLp);

      let vib = 0, collectorIn = 0, intakeOut = 0;
      for (let c = 0; c < 4; c++) {
        let x = this.rev + this.off[c] + jitter;
        x -= Math.floor(x);
        if (x < this.lastX[c]) { // новый цикл — новый разброс вспышки
          this.gFire[c] = 1 + (Math.random() - 0.5) * 0.36;
        }
        this.lastX[c] = x;

        // давление в цилиндре
        let cyl = 2.4 * Math.cos(12.566 * x) * 0.4;
        if (x > 0.5 && x < 0.5 + 0.035) { // вспышка
          cyl += 5 * Math.sin(6.2832 * (x - 0.5) / 0.07) *
            this.gFire[c] * (0.45 + 0.55 * thr);
        }
        vib += cyl;

        // выпускной клапан открыт в конце цикла → отражение падает
        const ev = x > 0.75 ? -Math.sin(12.566 * x) : 0;
        const r = this.runners[c];
        r.a = 0.71 * (1 - ev);
        r.step((1 - r.a) * cyl * 0.5, this.collector * 0.25);
        collectorIn += r.o1;

        // впускной шум, гейченный клапаном впуска
        const iv = x < 0.25 ? Math.sin(12.566 * x) : 0;
        intakeOut += this.noiseLp * iv;
      }

      // коллектор ↔ труба ↔ глушитель
      let mufflerBack = 0, exhaust = 0;
      for (const m of this.muffler) { mufflerBack += m.o0; }
      this.pipe.b = 0.002 * cfg.reso;
      this.pipe.step(this.collector * 0.9, mufflerBack);
      for (const m of this.muffler) {
        m.b = -0.14 * cfg.reso;
        m.step(this.pipe.o1 * 0.25, 0);
        exhaust += m.o1;
      }
      this.collector = collectorIn + this.pipe.o0;

      // вибрации блока — низкочастотное тело
      this.vibLp += this.a92 * (vib - this.vibLp);

      let s = exhaust * 0.9 * cfg.rumble +
        this.vibLp * 0.55 * cfg.drone +
        intakeOut * 0.05 * cfg.noise;

      // DC-блокер, мягкий клип, тон-фильтр
      this.dcLp += this.aDC * (s - this.dcLp);
      s -= this.dcLp;
      s = Math.tanh(s * 1.3) * 0.8;
      const k = Math.min(0.9, (0.10 + Math.min(rpm / 6000, 1) * 0.10) * cfg.bright);
      this.lp += k * (s - this.lp);
      out[i] = this.lp;
      // правый канал со сдвигом ~11 мс — ширина
      const rw = (this.iw + 1) % dW;
      outR[i] = this.lp * 0.55 + this.wide[rw] * 0.45;
      this.wide[this.iw] = this.lp; this.iw = rw;
    }
    return true;
  }
}
registerProcessor('engine', EngineProcessor);
`;

// [ключ, подпись, min, max, default]; volume — гейн на странице, остальное в worklet
const SLIDERS = [
  ['volume', 'громкость', 0, 1, 0.558],
  ['drone', 'вибрации блока', 0, 2, 0.672],
  ['rumble', 'выхлоп', 0, 2, 1.262],
  ['noise', 'шум впуска', 0, 2, 0.23],
  ['intake', 'неровность хода', 0, 2, 1.042],
  ['bright', 'яркость', 0.3, 2.5, 1.5268],
  ['reso', 'резонанс трубы', 0, 1.8, 0.4068],
];

// opts.panel=false — двигатель бота: без панели тюнинга, с внешним
// ослаблением по дистанции (setAtt)
export function createEngineSound(opts = {}) {
  let ctx = null, node = null, gain = null, att = null, failed = false;

  async function start() {
    if (failed) return;
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      node = new AudioWorkletNode(ctx, 'engine', { outputChannelCount: [2] });
      gain = ctx.createGain();
      att = ctx.createGain();
      node.connect(att).connect(gain).connect(ctx.destination);
      if (opts.panel !== false) {
        // панель применяет сохранённые значения сразу при построении
        sliderPanel('Звук двигателя', 12, SLIDERS, (key, v) => {
          if (key === 'volume') gain.gain.value = v;
          else node.port.postMessage({ [key]: v });
        });
      } else {
        gain.gain.value = 0.55; // бот: чуть тише игрока, дистанция — в att
      }
    } catch (e) {
      failed = true; // без звука, но игра живёт
      console.warn('engine sound failed:', e);
    }
  }

  function set(rpm, throttle) {
    if (!node) return;
    node.parameters.get('rpm').setTargetAtTime(rpm, ctx.currentTime, 0.05);
    node.parameters.get('throttle').setTargetAtTime(Math.max(0, throttle), ctx.currentTime, 0.08);
  }

  function setAtt(v) {
    if (att) att.gain.value = v;
  }

  return { start, set, setAtt };
}
