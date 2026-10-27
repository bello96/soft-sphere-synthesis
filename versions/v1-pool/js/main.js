'use strict';
// Boot: wires the canvas, input, UI and the fixed-step game loop together.

(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('game');
  const stageEl = $('stage');
  fitWorldHeight(stageEl.clientWidth - 16, stageEl.clientHeight - 4);
  const sound = new Sound();
  const renderer = new Renderer(canvas);

  const ui = {
    score: $('score'), best: $('best'), scoreTile: $('score-tile'), pips: $('pips'),
    shake: $('btn-shake'), swap: $('btn-swap'), xray: $('btn-xray'), soundBtn: $('btn-sound'),
    start: $('overlay-start'), pause: $('overlay-pause'), over: $('overlay-over'),
  };

  let shownScore = 0;
  let targetScore = 0;

  const game = new Game(sound, {
    onScore(score, best) {
      targetScore = score;
      ui.best.textContent = best.toLocaleString('en-US');
      if (score > 0) {
        ui.scoreTile.classList.remove('bump');
        void ui.scoreTile.offsetWidth;
        ui.scoreTile.classList.add('bump');
      }
    },
    onCharges(n) {
      [...ui.pips.children].forEach((pip, i) => pip.classList.toggle('full', i < n));
      ui.shake.disabled = n <= 0;
    },
    onShake(amount) { renderer.addShake(amount); },
    onQueue() {},
    onMerge() {},
    onState(state, info) {
      ui.pause.hidden = state !== 'paused';
      if (state === 'over') {
        // Let the last balloons settle for a moment before the card covers them.
        setTimeout(() => { if (game.state === 'over') showGameOver(info); }, 900);
      }
    },
  });
  ui.best.textContent = game.best.toLocaleString('en-US');

  function showGameOver(info) {
    $('final-score').textContent = info.score.toLocaleString('en-US');
    $('final-best').textContent = info.score >= info.best && info.score > 0
      ? '新纪录！'
      : `最高纪录 ${info.best.toLocaleString('en-US')} 分`;
    $('final-ball-value').textContent = formatValue(2 ** info.maxLevel);
    $('final-ball').style.setProperty('--ball', paletteFor(info.maxLevel).base);
    ui.over.hidden = false;
    $('btn-again').focus();
  }

  // ---- Layout -------------------------------------------------------------------------

  function layout() {
    const stage = $('stage');
    const availW = stage.clientWidth - 16;
    const availH = stage.clientHeight - 4;
    const aspect = renderer.viewW / renderer.viewH;
    let w = availW, h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    w = Math.max(200, Math.floor(w)); h = Math.floor(w / aspect);
    renderer.resize(w, h);
    document.documentElement.style.setProperty('--stage-w', Math.max(w, 340) + 'px');
  }
  window.addEventListener('resize', layout);
  layout();

  // ---- Input --------------------------------------------------------------------------

  let activePointer = null;
  function worldPoint(e) {
    const r = canvas.getBoundingClientRect();
    return renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
  }
  canvas.addEventListener('pointerdown', e => {
    sound.unlock();
    if (activePointer !== null) return;
    activePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const p = worldPoint(e);
    game.pointerDown(p.x, p.y);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== activePointer) return;
    const p = worldPoint(e);
    game.pointerMove(p.x, p.y);
  });
  const endPointer = e => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (e.type === 'pointercancel') { game.cancelAim(); return; }
    const p = worldPoint(e);
    game.pointerUp(p.x, p.y);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // ---- Buttons ------------------------------------------------------------------------

  function startGame() {
    sound.unlock();
    sound.click();
    ui.start.hidden = true;
    ui.over.hidden = true;
    ui.pause.hidden = true;
    shownScore = 0;
    game.reset();
  }

  $('btn-start').addEventListener('click', startGame);
  $('btn-again').addEventListener('click', startGame);
  $('btn-restart').addEventListener('click', startGame);
  $('btn-resume').addEventListener('click', () => { sound.click(); game.resume(); });
  $('btn-pause').addEventListener('click', () => {
    sound.unlock();
    if (game.state === 'paused') game.resume(); else { sound.click(); game.pause(); }
  });
  ui.shake.addEventListener('click', () => { sound.unlock(); game.useShake(); });
  ui.swap.addEventListener('click', () => { sound.unlock(); game.swap(); });
  ui.xray.addEventListener('click', () => {
    renderer.xray = !renderer.xray;
    ui.xray.setAttribute('aria-pressed', String(renderer.xray));
  });
  ui.soundBtn.addEventListener('click', () => {
    sound.unlock();
    sound.setMuted(!sound.muted);
    ui.soundBtn.setAttribute('aria-pressed', String(sound.muted));
    ui.soundBtn.setAttribute('aria-label', sound.muted ? '打开声音' : '关闭声音');
    try { localStorage.setItem('squish-pool.muted', sound.muted ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  try {
    if (localStorage.getItem('squish-pool.muted') === '1') {
      sound.setMuted(true);
      ui.soundBtn.setAttribute('aria-pressed', 'true');
      ui.soundBtn.setAttribute('aria-label', '打开声音');
    }
  } catch (e) { /* storage blocked */ }

  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') {
      if (game.state === 'playing') { game.swap(); e.preventDefault(); }
    } else if (k === 'p' || k === 'escape') {
      if (game.state === 'playing') game.pause(); else if (game.state === 'paused') game.resume();
    } else if (k === 's') {
      game.useShake();
    } else if (k === 'x') {
      ui.xray.click();
    } else if (k === 'm') {
      ui.soundBtn.click();
    } else if (k === 'enter') {
      if (!ui.start.hidden || !ui.over.hidden) startGame();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing') game.pause();
  });

  // ---- Loop ---------------------------------------------------------------------------

  const STEP = 1 / 60;
  let acc = 0;
  let last = performance.now();

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 3) {
      game.update(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === 3) acc = 0;
    renderer.frame(game, dt);
    if (shownScore !== targetScore) {
      shownScore += Math.ceil((targetScore - shownScore) * Math.min(1, dt * 12));
      if (Math.abs(targetScore - shownScore) < 1 || shownScore > targetScore) shownScore = targetScore;
      ui.score.textContent = shownScore.toLocaleString('en-US');
    }
    requestAnimationFrame(frame);
  }

  // Draw the title screen over a few idle balloons so the tank is never empty.
  function seedDemo() {
    const levels = [3, 1, 5, 2, 4, 6, 1, 3, 2, 7, 4, 1];
    const xs = [120, 300, 470, 200, 400, 90, 520, 260, 340, 160, 450, 300];
    levels.forEach((lv, i) => {
      const b = game.world.add(new SoftBody(lv, xs[i], 330));
      b.setVelocity(0, 500);
      b.cooldown = 99;
      for (let k = 0; k < 18; k++) game.world.step(STEP);
    });
    for (let i = 0; i < 120; i++) game.world.step(STEP);
  }
  seedDemo();

  window.__game = game;
  window.__renderer = renderer;
  requestAnimationFrame(frame);
  if (document.fonts && document.fonts.load) document.fonts.load(`700 24px "Fredoka"`).catch(() => {});
})();
