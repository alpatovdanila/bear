// Все панели тюнинга — папки одного lil-gui (как в демках three.js):
// сворачиваются, не перекрываются, значения хранятся в localStorage.
// Сигнатуры sliderPanel/colorPanel сохранены со времён самодельных панелей.

import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

let gui = null;
let hidden = false;

function root() {
  if (!gui) {
    gui = new GUI({ title: 'Тюнинг (T — скрыть)' });
    gui.domElement.addEventListener('mousedown', (e) => e.stopPropagation()); // не крутить камеру
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyT') {
        hidden = !hidden;
        gui.show(!hidden);
      }
    });
  }
  return gui;
}

export function sliderPanel(title, _top, rows, apply, opts = {}) {
  const f = root().addFolder(title);
  f.close();
  const params = {};
  const resets = [];
  for (const [key, label, min, max, def] of rows) {
    const storeKey = `bear.${title}.${key}`;
    const saved = parseFloat(localStorage.getItem(storeKey));
    params[key] = Number.isFinite(saved) ? saved : def;
    const ctrl = f.add(params, key, min, max)
      .name(label)
      .onChange((v) => {
        apply(key, v);
        localStorage.setItem(storeKey, v);
      });
    apply(key, params[key]);
    resets.push(() => {
      localStorage.removeItem(storeKey);
      ctrl.setValue(def);
    });
  }
  if (opts.reset) {
    f.add({ reset: () => resets.forEach((r) => r()) }, 'reset').name('сбросить на дефолт');
  }
  return f.$children; // контейнер папки — сюда можно дописывать свои контролы
}

// панель кнопок: entries = [{label, fn}]; каждой записи проставляется .ctrl
export function buttonPanel(title, entries) {
  const f = root().addFolder(title);
  f.close();
  for (const e of entries) e.ctrl = f.add(e, 'fn').name(e.label);
  return entries;
}

export function colorPanel(title, _top, rows, apply) {
  const f = root().addFolder(title);
  f.close();
  const params = {};
  for (const [key, label, def] of rows) {
    const storeKey = `bear.${title}.${key}`;
    params[key] = localStorage.getItem(storeKey) || def;
    f.addColor(params, key)
      .name(label)
      .onChange((v) => {
        apply(key, v);
        localStorage.setItem(storeKey, v);
      });
    apply(key, params[key]);
  }
  return f.$children;
}
