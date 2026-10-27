// Final end-to-end verification through real input and real UI controls.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
const OUT = process.env.SHOTS_DIR || path.join(os.tmpdir(), "squish-shots");
fs.mkdirSync(OUT, { recursive: true });
const INDEX = new URL("../../index.html", import.meta.url).href;
export default async (page, [tag = 'final', w = '390', h = '844']) => {
  const R = {};
  await page.viewport(Number(w), Number(h), 2, Number(w) < 600);
  await page.navigate(INDEX, 300);
  await page.eval(`localStorage.clear()`);
  await page.navigate(INDEX, 900);
  const q = expr => page.eval(expr);
  const click = async sel => {
    const [x, y] = await q(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await page.sleep(120);
  };
  const key = async k => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k === ' ' ? 'Space' : 'Key' + k.toUpperCase(), text: k });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k === ' ' ? 'Space' : 'Key' + k.toUpperCase() });
    await page.sleep(120);
  };
  R.titleVisible = await q(`!document.getElementById('overlay-start').hidden`);
  await click('#btn-start');
  await page.sleep(700);
  R.startedPlaying = await q(`window.__game.state === 'playing' && document.getElementById('overlay-start').hidden`);
  R.hintShownBeforeFirstShot = await q(`window.__game.showHint`);
  const toClient = async (wx, wy) => q(`(() => { const r = document.getElementById('game').getBoundingClientRect(); const Rn = window.__renderer; const M = CFG.world.margin; return [r.left + (${wx} + M) * Rn.cssScale, r.top + (${wy} + M) * Rn.cssScale]; })()`);
  const [lx, ly] = await toClient(300, 100);
  let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 8; k++) {
    const [ax, ay] = await toClient(80 + rnd() * 440, 300 + rnd() * 200);
    await page.drag(lx, ly + 30, ax, ay, 8, 18);
    await page.sleep(1000);
  }
  R.afterShots = await q(`({ merges: window.__game.merges, score: window.__game.score, bodies: window.__game.world.bodies.length, scoreText: document.getElementById('score').textContent })`);
  R.hintGoneAfterShot = await q(`!window.__game.showHint`);
  // Shake
  const c0 = await q(`window.__game.charges`);
  await click('#btn-shake');
  R.shakeUsesCharge = (await q(`window.__game.charges`)) === c0 - 1 && (await q(`document.querySelectorAll('#pips i.full').length`)) === c0 - 1;
  await page.sleep(1500);
  // Swap (force different levels so the swap is observable)
  await q(`(() => { const g = window.__game; if (g.queue[0] === g.held.level) g.queue[0] = g.held.level === 1 ? 2 : 1; })()`);
  await page.sleep(400);
  const before = await q(`[window.__game.held && window.__game.held.level, window.__game.queue[0]]`);
  await click('#btn-swap');
  await page.sleep(300);
  const after = await q(`[window.__game.held && window.__game.held.level, window.__game.queue[0]]`);
  R.swapWorks = before[0] === after[1] && before[1] === after[0];
  await page.sleep(300);
  await key(' ');
  await page.sleep(300);
  const after2 = await q(`[window.__game.held && window.__game.held.level, window.__game.queue[0]]`);
  R.spaceSwaps = after2[0] === after[1] && after2[1] === after[0];
  // X-ray toggle
  await click('#btn-xray');
  R.xrayOn = await q(`window.__renderer.xray && document.getElementById('btn-xray').getAttribute('aria-pressed') === 'true'`);
  await page.shot(`${OUT}/${tag}-xray.png`);
  await key('x');
  R.xrayOffByKey = await q(`!window.__renderer.xray`);
  // Sound toggle
  await click('#btn-sound');
  R.muteOn = await q(`window.__game.sound.muted && document.getElementById('btn-sound').getAttribute('aria-pressed') === 'true'`);
  await key('m');
  R.muteOffByKey = await q(`!window.__game.sound.muted`);
  R.audioRunning = await q(`window.__game.sound.ctx && window.__game.sound.ctx.state`);
  // Pause / resume / restart
  await key('p');
  R.pausedByKey = await q(`window.__game.state === 'paused' && !document.getElementById('overlay-pause').hidden`);
  await click('#btn-resume');
  R.resumed = await q(`window.__game.state === 'playing' && document.getElementById('overlay-pause').hidden`);
  await click('#btn-pause');
  await click('#btn-restart');
  await page.sleep(500);
  R.restarted = await q(`window.__game.state === 'playing' && window.__game.score === 0`);
  // A merge after the restart must persist the record immediately (no game over needed).
  await q(`(() => { const g = window.__game; const H = CFG.world.h;
    const a = g.world.add(new SoftBody(3, 250, H - 50)); const b = g.world.add(new SoftBody(3, 330, H - 50));
    a.setVelocity(60, 0); b.setVelocity(-60, 0); })()`);
  await page.sleep(800);
  R.bestSavedOnRecord = await q(`Number(localStorage.getItem('squish-pool.best')) === window.__game.best && window.__game.best > 0`);
  // Game over for real: pile non-merging balls past the rope and let the danger timer run out.
  await q(`(() => { const g = window.__game; let k = 0;
    const id = setInterval(() => { const lv = 6 + (k % 3), x = k % 2 ? 110 : 490;
      // Drop only onto a clear spot, as a real shot would: a balloon born inside another cannot get out.
      if (g.world.bodies.some(o => Math.hypot(o.cx - x, o.cy - 150) < o.r * 1.1 + 80)) { if (g.state !== 'playing') clearInterval(id); return; }
      const b = g.world.add(new SoftBody(lv, x, 150));
      b.cooldown = 99; b.setVelocity(0, 150); if (++k >= 60 || g.state !== 'playing') clearInterval(id); }, 260); })()`);
  const t0 = Date.now();
  let sawCountdown = false;
  while (Date.now() - t0 < 40000) {
    const s = await q(`({ st: window.__game.state, d: window.__game.dangerT, card: !document.getElementById('overlay-over').hidden })`);
    if (s.d > 0.5) sawCountdown = true;
    if (s.card) break;
    await page.sleep(250);
  }
  R.dangerCountdownRan = sawCountdown;
  R.gameOverCard = await q(`window.__game.state === 'over' && !document.getElementById('overlay-over').hidden`);
  R.finalCardText = await q(`document.getElementById('final-score').textContent + ' / ' + document.getElementById('final-best').textContent + ' / ball ' + document.getElementById('final-ball-value').textContent`);
  await page.shot(`${OUT}/${tag}-over.png`);
  await click('#btn-again');
  await page.sleep(600);
  R.playAgain = await q(`window.__game.state === 'playing' && document.getElementById('overlay-over').hidden && window.__game.world.bodies.length <= 1`);
  R.bestSaved = await q(`localStorage.getItem('squish-pool.best') !== null`);
  await page.sleep(800);
  await page.shot(`${OUT}/${tag}-end.png`);
  return R;
};
