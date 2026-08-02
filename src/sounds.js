// Озвучка игровых событий: короткие сэмплы из public/sounds.
// Как у звука двигателя: start() вызывается по первому жесту (keydown),
// создаёт AudioContext и асинхронно грузит все файлы; до загрузки play()
// просто молчит. Отсутствие файла или ошибка декода игру не роняет.

// событие → массив вариантов; ИГРАЕТ ВСЕГДА ПЕРВЫЙ, остальные — кандидаты
// для панели «Прослушка звуков» (кнопка перебирает варианты; выбранный
// просто переставляется первым в списке)
const FILES = {
  treeHit: [ // тяжёлый глухой удар о дерево
    'sfx/independent_nu_ljudbank-hits_and_punches/hits/hit01.mp3.flac',
    'sfx/independent_nu_ljudbank-hits_and_punches/hits/hit05.mp3.flac',
    'sfx/independent_nu_ljudbank-hits_and_punches/hits/hit09.mp3.flac',
    'sfx/Materials/bamboo_drop.wav',
    'sfx/[kdd]DifferentSteps/wood02.ogg',
    'sfx/Materials/wood_small_drop.wav',
  ],
  carCrash: [                                           // жестяной лязг металла
    'sfx/Weapons/sword_clash.wav',
    'sfx/Weapons/sword_clash_2.wav',
    'sfx/Weapons/weapon_drop.wav',
    'sfx/Materials/pottery_clang.wav',
    'sfx/Retro/explosion_quick.wav',
  ],
  bushRustle: [                                         // шорох листвы
    'sfx/Footsteps/digital/digital_footstep_grass_1.wav',
    'sfx/Footsteps/digital/digital_footstep_grass_2.wav',
    'sfx/Items/broom_sweep_1.wav',
    'sfx/Items/broom_sweep_2.wav',
  ],
  berryPop: [                                           // сочный мягкий поп
    'sfx/Combat and Gore/splat_quick.wav',
    'sfx/Environment/water_drop_medium.wav',
    'sfx/Environment/water_drop_synthetic.wav',
    'sfx/Other/paste.wav',
    'sfx/Match Three/match_synth_1.wav',
  ],
  pickup: [                                             // короткий «взял предмет»
    'sfx/Fantasy Sound Library/Inventory_Open_00.wav',
    'sfx/Fantasy Sound Library/Inventory_Open_01.wav',
    'sfx/Items/heart_collect.wav',
    'sfx/Materials/wood_small_pickup.wav',
    'sfx/Weapons/weapon_pick_up.wav',
  ],
  deliver: [                                            // тёплая фанфарка успеха
    'sfx/Fantasy Sound Library/Jingle_Achievement_00.wav',
    'sfx/Fantasy Sound Library/Jingle_Win_00.wav',
    'sfx/Musical Effects/brass_chime_positive.wav',
    'sfx/Musical Effects/music_box_level_complete.wav',
    'sfx/Musical Effects/grand_piano_chime_positive.wav',
  ],
  splash: [                                             // всплеск воды
    'sfx/Fantasy Sound Library/Footsteps/Footstep_Water_00.wav',
    'sfx/Fantasy Sound Library/Footsteps/Footstep_Water_02.wav',
    'sfx/Environment/ice_in_water.wav',
    'sfx/Environment/water_splashing.wav',
  ],
  fishFlop: [                                           // мокрый шлепок
    'sfx/Combat and Gore/squelching_1.wav',
    'sfx/Combat and Gore/squelching_2.wav',
    'sfx/Combat and Gore/splat_double_quick.wav',
    'sfx/Combat and Gore/slap.wav',
  ],
  shroomKnock: [                                        // мягкий глухой тычок
    'sfx/Materials/cardboard_hit.wav',
    'sfx/Materials/cardboard_drop.wav',
    'sfx/[kdd]DifferentSteps/mud02.ogg',
    'sfx/Footsteps/foley_footstep_carpet_1.wav',
  ],
  squirrel: [                                           // писк/чирик (rate 1.4-1.7)
    'sfx/Fantasy Sound Library/Goblin_00.wav',
    'sfx/Fantasy Sound Library/Goblin_02.wav',
    'sfx/Retro/jump_short.wav',
    'sfx/Human/whistle.wav',
  ],
  skunkIn: [                                            // возня/шебуршание
    'sfx/Other/itching.wav',
    'sfx/Materials/paper_scrunch.wav',
    'sfx/Materials/clothing_2.wav',
    'sfx/[kdd]DifferentSteps/gravel.ogg',
  ],
  skunkOut: [                                           // свист-выброс/спринг
    'sfx/Other/elastic_twang.wav',
    'sfx/Other/whoosh_1.wav',
    'sfx/Retro/throw.wav',
    'sfx/Machines/hydraulic_up.wav',
  ],
  bees: [                                               // ровное жужжание (луп)
    'sfx/Machines/hairdryer.wav',
    'sfx/Machines/drill_whizz.wav',
    'sfx/Environment/water_boiling_loop.wav',
  ],
  gold: [                                               // сияющий подбор золота
    'sfx/Items/gem_collect.wav',
    'sfx/Items/coin_collect.wav',
    'sfx/Fantasy Sound Library/Spell_02.wav',
    'sfx/Retro/coin.wav',
  ],
  flip: [                                               // тяжёлый грохот переворота
    'sfx/Materials/stone_push_short.wav',
    'sfx/Retro/explosion_medium.wav',
    'sfx/Machines/hydraulic_down.wav',
    'sfx/Machines/industrial_door_open.wav',
  ],
  scatter: [                                            // россыпь мелких предметов
    'sfx/Card and Board/dice_roll_1.wav',
    'sfx/Card and Board/dice_roll_4.wav',
    'sfx/Items/coins_gather_quick.wav',
    'sfx/Items/keys_jingling.wav',
  ],
};

export function createSounds() {
  let ctx = null, failed = false;
  const buffers = {}; // имя → массив AudioBuffer (заполняется по мере загрузки)
  const lastAt = {};  // имя → время последнего запуска (антиспам)
  // слушатель: позиция машины игрока + «право» камеры для стерео-панорамы
  const listener = { x: 0, z: 0, rx: 0, rz: 1 };

  function setListener(x, z, rx, rz) {
    listener.x = x; listener.z = z; listener.rx = rx; listener.rz = rz;
  }

  // дистанция и панорама события в мире относительно слушателя
  function spatial(x, z) {
    const dx = x - listener.x, dz = z - listener.z;
    const d = Math.hypot(dx, dz);
    const pan = d > 1 ? Math.max(-1, Math.min(1, (dx * listener.rx + dz * listener.rz) / d)) : 0;
    return { d, pan };
  }

  function start() {
    if (failed) return;
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new AudioContext();
      for (const [name, spec] of Object.entries(FILES)) {
        const urls = Array.isArray(spec) ? spec : [spec];
        buffers[name] = [];
        urls.forEach((url, i) => {
          fetch(url)
            .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then((ab) => ctx.decodeAudioData(ab))
            .then((buf) => { buffers[name][i] = buf; })
            .catch((e) => console.warn('sound load failed:', url, e));
        });
      }
    } catch (e) {
      failed = true; // без звука, но игра живёт
      console.warn('sounds failed:', e);
    }
    buildTester();
  }

  // в игре звучат только первые ДВА варианта (остальные — кандидаты прослушки)
  function pick(name) {
    const ready = (buffers[name] || []).slice(0, 2).filter(Boolean);
    return ready.length ? ready[(Math.random() * ready.length) | 0] : null;
  }

  // прямое воспроизведение конкретного варианта — для панели прослушки
  function playIndex(name, i) {
    const buf = (buffers[name] || [])[i];
    if (!ctx || !buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return true;
  }

  // панель «Прослушка звуков»: кнопка события перебирает варианты по кругу,
  // имя файла — на кнопке и в консоли. Услышал нужный — скажи, какой оставить.
  let testerBuilt = false;
  async function buildTester() {
    if (testerBuilt) return;
    testerBuilt = true;
    const { buttonPanel } = await import('./ui.js');
    const entries = Object.keys(FILES).map((name) => {
      const e = {
        label: name,
        idx: 0,
        fn: () => {
          const urls = FILES[name];
          const i = e.idx % urls.length;
          e.idx++;
          const ok = playIndex(name, i);
          const short = urls[i].split('/').pop();
          e.ctrl.name(`${name} · №${i + 1}/${urls.length} ${ok ? '' : '⏳ '}${short}`);
          console.log('[звук]', name, `№${i + 1}`, urls[i]);
        },
      };
      return e;
    });
    buttonPanel('Прослушка звуков', entries);
  }

  // 3D: громкость падает с дистанцией, панорама — по «праву» камеры.
  // Если заданы мировые x/z — позиционируем; иначе играет «у уха» (dist).
  function play(name, { vol = 1, rate = 1, dist = 0, x, z } = {}) {
    if (!ctx) return;
    try {
      const now = performance.now();
      if (now - (lastAt[name] || -1e9) < 60) return; // антиспам
      let pan = 0;
      if (x !== undefined) {
        const sp = spatial(x, z);
        dist = sp.d; pan = sp.pan;
      }
      if (dist > 95) return; // совсем далёкое не слышно
      const buf = pick(name);
      if (!buf) return;
      lastAt[name] = now;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = vol / (1 + dist * 0.13);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g).connect(p).connect(ctx.destination);
      src.start();
    } catch (e) {
      console.warn('sound play failed:', name, e);
    }
  }

  // зацикленный звук (пчёлы) с живой позицией: возвращает { setPos, stop };
  // буфер мог ещё не загрузиться — тихо ждём его
  function loop(name, { vol = 1, rate = 1 } = {}) {
    let src = null, g = null, p = null, stopped = false;
    let px = listener.x, pz = listener.z;
    const tryStart = () => {
      if (stopped) return;
      const buf = ctx && pick(name);
      if (!buf) { setTimeout(tryStart, 300); return; }
      try {
        src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = rate;
        g = ctx.createGain();
        p = ctx.createStereoPanner();
        apply();
        src.connect(g).connect(p).connect(ctx.destination);
        src.start();
      } catch (e) {
        console.warn('sound loop failed:', name, e);
      }
    };
    const apply = () => {
      if (!g) return;
      const sp = spatial(px, pz);
      g.gain.value = vol / (1 + sp.d * 0.13);
      p.pan.value = sp.pan;
    };
    tryStart();
    return {
      setPos(x, z) { px = x; pz = z; apply(); },
      stop() {
        stopped = true;
        try { if (src) src.stop(); } catch (e) { /* уже остановлен */ }
      },
    };
  }

  return { start, play, loop, setListener };
}
