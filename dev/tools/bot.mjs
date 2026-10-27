// A bot plays the real game logic for N seconds of game time and monitors physics health.
// args: tag, seconds, w, h, seed
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
const OUT = process.env.SHOTS_DIR || path.join(os.tmpdir(), "squish-shots");
fs.mkdirSync(OUT, { recursive: true });
const INDEX = new URL("../../index.html", import.meta.url).href;
export default async (page, [tag = 'bot', seconds = '180', w = '390', h = '844', seed = '7']) => {
  await page.viewport(Number(w), Number(h), 1, Number(w) < 600);
  await page.navigate(INDEX, 800);
  await page.eval(`document.getElementById('btn-start').click()`);
  await page.eval(`(() => {
    const g = window.__game;
    // Sounds draw Math.random() but are throttled by the real audio clock; muting keeps runs reproducible.
    g.sound.setMuted(true);
    let seed = ${seed};
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    Math.random = rnd;  // deterministic spawns too
    g.reset();
    const realUpdate = g.update.bind(g);
    g.update = () => {};  // the live rAF loop must not advance the game during bot runs
    window.__realUpdate = realUpdate;
    const om = PhysicsWorld.prototype.mergeInto; window.__mergeKinds = {};
    PhysicsWorld.prototype.mergeInto = function (...a) { const c = om.apply(this, a); window.__mergeKinds[c.mergedBy] = (window.__mergeKinds[c.mergedBy] || 0) + 1; return c; };
    window.__bot = { frames: 0, shots: 0, deep: 0, deepMax: 0, deepFrames: 0, folds: 0, foldFrames: 0, squeezeMin: 1, swellMax: 1, crushFrames: 0, stepMax: 0, stepSum: 0, firstDeep: null, wait: 0, overAt: null, restarts: 0 };
    window.__botStep = (n) => {
      const B = window.__bot;
      for (let f = 0; f < n; f++) {
        if (g.state === 'paused') g.resume();  // a hidden tab auto-pauses the game
        if (g.state === 'over') { if (B.overAt === null) B.overAt = B.frames; B.restarts++; g.reset(); }
        // Aim when ready: target the highest ball with the same value, otherwise a random spot.
        if (g.canAim() && --B.wait <= 0) {
          const lv = g.held.level;
          let target = null;
          for (const b of g.world.bodies) if (b !== g.held && b.level === lv && (!target || b.cy < target.cy)) target = b;
          const tx = target ? target.cx + (rnd() - 0.5) * 20 : 60 + rnd() * 480;
          const ty = target ? target.cy : 500 + rnd() * 300;
          const dx = tx - CFG.launcher.x, dy = ty - CFG.launcher.y;
          const dist = Math.hypot(dx, dy);
          const power = Math.min(1, 0.25 + dist / 900 + rnd() * 0.35);
          const L = CFG.launch, len = L.deadZone + power * (L.maxDrag - L.deadZone);
          g.pointerDown(CFG.launcher.x + dx / dist * 40, CFG.launcher.y + dy / dist * 40);
          g.pointerUp(CFG.launcher.x + dx / dist * len, CFG.launcher.y + dy / dist * len);
          B.shots++; B.lastShotFrame = B.frames;
          B.wait = 20 + Math.floor(rnd() * 40);
        }
        window.__realUpdate(1 / 60);
        B.frames++;
        if (g.world !== B.lastWorld) { B.lastWorld = g.world; B.lastTangles = 0; }
        B.tangles = (B.tangles || 0) + g.world.tangles - B.lastTangles; B.lastTangles = g.world.tangles;
        B.kinds = window.__mergeKinds; B.stepSum += g.world.stepMs; B.stepMax = Math.max(B.stepMax, g.world.stepMs);
        // Health: particles deep inside other balls, folded edges, area error.
        let deep = 0, folds = 0;
        const bs = g.world.bodies;
        let crushed = false;
        for (const A of bs) {
          // Balloons are meant to squeeze; flag only ones that stay crushed (or over-inflated).
          const ratio = A.area / (A.restArea * A.scale * A.scale);
          if (A.age > 1 && A.scaleDur === 0 && !A.held) {
            A.lowFor = ratio < 0.45 ? (A.lowFor || 0) + 1 / 60 : 0;
            if (A.lowFor > 0.5) { crushed = true; if (!B.firstCrush) B.firstCrush = { frame: B.frames, id: A.id, lv: A.level, ratio: +ratio.toFixed(2), cx: Math.round(A.cx), cy: Math.round(A.cy) }; }
            if (ratio < B.squeezeMin) { B.squeezeMin = ratio; B.squeezeWorst = { frame: B.frames, lv: A.level, ratio: +ratio.toFixed(2), sp: Math.round(A.speed) }; }
            if (ratio > B.swellMax) B.swellMax = ratio;
          }
          for (let i = 0; i < A.n; i++) {
            const j = (i + 1) % A.n;
            if ((A.x[i] - A.cx) * (A.y[j] - A.cy) - (A.x[j] - A.cx) * (A.y[i] - A.cy) <= 0) folds++;
          }
          for (const Bd of bs) {
            if (Bd === A || A.maxX < Bd.minX || A.minX > Bd.maxX || A.maxY < Bd.minY || A.minY > Bd.maxY) continue;
            for (let i = 0; i < A.n; i++) {
              const x = A.x[i], y = A.y[i];
              if (x < Bd.minX || x > Bd.maxX || y < Bd.minY || y > Bd.maxY) continue;
              if (pointInRing(Bd, x, y)) deep++;
            }
          }
        }
        if (deep && !B.detail) {
          const ev = [];
          for (const A of bs) for (const Bd of bs) { if (Bd === A) continue; let k = 0;
            for (let i = 0; i < A.n; i++) if (pointInRing(Bd, A.x[i], A.y[i])) k++;
            if (k) ev.push({ A: A.id, lvA: A.level, ageA: +A.age.toFixed(2), heldA: A.held, scaleA: +A.scale.toFixed(2), sinceA: +A.sinceLaunch.toFixed(2), spA: Math.round(A.speed), arA: +(A.area/(A.restArea*A.scale*A.scale)).toFixed(2),
              B: Bd.id, lvB: Bd.level, ageB: +Bd.age.toFixed(2), heldB: Bd.held, scaleB: +Bd.scale.toFixed(2), arB: +(Bd.area/(Bd.restArea*Bd.scale*Bd.scale)).toFixed(2), inside: k }); }
          B.detail = { frame: B.frames, ev, recentShot: B.lastShotFrame, recentMerge: g.merges };
        }
        if (crushed) B.crushFrames++;
        if (deep) { B.deepFrames++; B.deep += deep; if (deep > B.deepMax) B.deepMax = deep; if (!B.firstDeep) B.firstDeep = { frame: B.frames, deep }; }
        if (folds) { B.foldFrames++; B.folds += folds; }
      }
      return B;
    };
  })()`);
  const total = Math.round(Number(seconds) * 60);
  let res; 
  for (let done = 0; done < total; done += 600) {
    res = await page.eval(`window.__botStep(${Math.min(600, total - done)})`);
  }
  await page.sleep(400);
  await page.shot(`${OUT}/${tag}.png`);
  const g = await page.eval(`(() => { const g = window.__game; return { state: g.state, score: g.score, merges: g.merges, maxLevel: g.maxLevel, bodies: g.world.bodies.length, particles: g.world.bodies.reduce((s, b) => s + b.n, 0) }; })()`);
  res.avgStep = +(res.stepSum / res.frames).toFixed(2);
  delete res.stepSum;
  delete res.lastWorld;
  return { ...res, ...g };
};
