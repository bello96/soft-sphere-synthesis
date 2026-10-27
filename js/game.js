'use strict';
// Game rules on top of the physics: launcher and queue, aiming, merging, scoring, danger line.

const BEST_KEY = 'squish-pool.best';
const HINT_KEY = 'squish-pool.hinted';

function loadBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { return 0; }
}

function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* storage blocked: keep in memory */ }
}

class Game {
  constructor(sound, hooks) {
    this.sound = sound;
    this.hooks = hooks;
    this.fx = new Fx();
    this.best = loadBest();
    try { this.showHint = localStorage.getItem(HINT_KEY) !== '1'; } catch (e) { this.showHint = true; }
    this.nextSlot = { x: 62, y: 66, r: 22 };
    this.reset();
    this.state = 'title';
  }

  reset() {
    this.world = new PhysicsWorld();
    this.world.canMerge = (a, b) => this.canMergePair(a, b);
    this.fx.clear();
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.merges = 0;
    this.maxLevel = 1;
    this.charges = CFG.game.shakeCharges;
    this.mergesTowardCharge = 0;
    this.shakeCooldown = 0;
    this.held = null;
    this.lastRolls = [];
    this.queue = [this.rollLevel(), this.rollLevel()];
    this.reload = 0.3;
    this.dangerT = 0;
    this.tickT = 0;
    this.time = 0;
    this.aim = { active: false, power: 0, dirX: 0, dirY: 1, preview: [], end: null };
    this.state = 'playing';
    this.hooks.onScore(this.score, this.best);
    this.hooks.onCharges(this.charges);
  }

  // New balls follow a simple rule: small values are common, and the largest value that can
  // appear grows with the biggest ball you have made (never above 128).
  rollLevel() {
    const top = Math.max(3, Math.min(7, this.maxLevel - 3));
    const weights = [];
    let sum = 0;
    for (let lv = 1; lv <= top; lv++) {
      let w = Math.pow(0.6, lv - 1);
      // Avoid long streaks of the same value.
      const rep = this.lastRolls.filter(v => v === lv).length;
      if (rep >= 2) w *= 0.35;
      weights.push(w); sum += w;
    }
    let r = Math.random() * sum, lv = 1;
    for (let k = 0; k < weights.length; k++) { r -= weights[k]; if (r <= 0) { lv = k + 1; break; } }
    this.lastRolls.push(lv);
    if (this.lastRolls.length > 3) this.lastRolls.shift();
    return lv;
  }

  canMergePair(a, b) {
    if (a.cooldown > 0 || b.cooldown > 0) return false;
    if ((a.held && a.scaleDur > 0) || (b.held && b.scaleDur > 0)) return false;
    return true;
  }

  canAim() {
    return this.state === 'playing' && this.held && !this.held.dead && this.held.scaleDur === 0;
  }

  update(dt) {
    if (this.state === 'paused' || this.state === 'title') return;
    this.time += dt;
    for (const b of this.world.bodies) {
      b.age += dt;
      b.sinceLaunch += dt;
      if (b.cooldown > 0) b.cooldown -= dt;
      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt / CFG.merge.flashTime);
      if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - dt * 5);
    }
    if (this.shakeCooldown > 0) this.shakeCooldown -= dt;
    if (this.state === 'playing') this.updateLauncher(dt);
    this.world.step(dt);
    this.handleMerges();
    this.handleImpacts();
    if (this.state === 'playing') this.updateDanger(dt);
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    this.fx.update(dt);
  }

  updateLauncher(dt) {
    const L = CFG.launcher;
    if (!this.held || this.held.dead) {
      this.held = null;
      this.reload -= dt;
      if (this.reload <= 0 && this.launcherClear()) this.spawnHeld();
      return;
    }
    // Drawing the shot pulls the ball back a little and presses it flat against the "pouch",
    // so on release it springs long along the shot and keeps jiggling in flight.
    const pull = this.aim.active ? this.aim.power * 18 : 0;
    this.held.ax = L.x - this.aim.dirX * pull;
    this.held.ay = L.y - this.aim.dirY * pull;
    this.held.squash = this.aim.active ? this.aim.power * CFG.launch.squash : 0;
    this.held.squashX = this.aim.dirX;
    this.held.squashY = this.aim.dirY;
    if (this.aim.active) this.updatePreview();
  }

  // The next ball starts small at the launcher and inflates, pushing its neighbours aside as it
  // grows, but it must never appear inside another ball (a squeezable balloon born inside
  // another cannot get out). While something sits on the spot, push it away and wait.
  launcherClear() {
    const L = CFG.launcher, need = radiusForLevel(this.queue[0]) * 0.3 + 10;
    let clear = true;
    for (const o of this.world.bodies) {
      let near = pointInRing(o, L.x, L.y);
      for (let i = 0; !near && i < o.n; i++) near = Math.hypot(o.x[i] - L.x, o.y[i] - L.y) < need;
      if (!near) continue;
      clear = false;
      const dx = o.cx - L.x, dy = o.cy - L.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      for (let i = 0; i < o.n; i++) { o.vx[i] += dx / d * 12; o.vy[i] += 18; }
    }
    return clear;
  }

  spawnHeld(level) {
    const L = CFG.launcher;
    const lv = level || this.queue.shift();
    if (!level) this.queue.push(this.rollLevel());
    const r = radiusForLevel(lv);
    // Nudge anything that drifted into the launcher so the new ball does not spawn inside it.
    for (const o of this.world.bodies) {
      const dx = o.cx - L.x, dy = o.cy - L.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d < r + o.r + 12) {
        for (let i = 0; i < o.n; i++) { o.vx[i] += dx / d * 160; o.vy[i] += 220; }
      }
    }
    const b = new SoftBody(lv, L.x, L.y);
    b.held = true;
    b.ax = L.x; b.ay = L.y;
    b.animateScale(0.3, 1, 0.3);
    b.fitRingToScale();
    this.world.add(b);
    this.held = b;
    this.sound.inflate();
    this.hooks.onQueue(this.held.level, this.queue[0]);
  }

  swap() {
    if (!this.canAim() || this.aim.active) return false;
    const cur = this.held.level, next = this.queue[0];
    if (cur === next) return false;
    this.queue[0] = cur;
    this.world.remove(this.held);
    this.world.compact();
    this.held = null;
    this.spawnHeld(next);
    this.held.animateScale(0.55, 1, 0.2);
    this.held.fitRingToScale();
    this.sound.click();
    return true;
  }

  // ---- Aiming -----------------------------------------------------------------------

  pointerDown(x, y) {
    const s = this.nextSlot;
    if (Math.hypot(x - s.x, y - s.y) < s.r + 16) { this.swap(); return; }
    if (!this.canAim()) return;
    this.aim.active = true;
    this.aimAt(x, y);
  }

  pointerMove(x, y) {
    if (this.aim.active) this.aimAt(x, y);
  }

  pointerUp(x, y) {
    if (!this.aim.active) return;
    this.aimAt(x, y);
    this.aim.active = false;
    if (this.aim.power <= 0 || !this.canAim()) return;  // released in the middle: cancelled
    this.launch(this.aim.dirX, this.aim.dirY, this.aim.power);
  }

  cancelAim() { this.aim.active = false; }

  aimAt(x, y) {
    const L = CFG.launch;
    const dx = x - CFG.launcher.x, dy = y - CFG.launcher.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-3) { this.aim.dirX = dx / len; this.aim.dirY = dy / len; }
    this.aim.power = Math.max(0, Math.min(1, (len - L.deadZone) / (L.maxDrag - L.deadZone)));
  }

  launchSpeed(power) {
    const L = CFG.launch;
    return L.minSpeed + (L.maxSpeed - L.minSpeed) * Math.pow(power, 1.2);
  }

  launch(dirX, dirY, power) {
    const b = this.held;
    const L = CFG.launch;
    const speed = this.launchSpeed(power);
    b.held = false;
    b.sinceLaunch = 0;
    // The front of the ball leaves a bit faster than the back, so it stretches in flight.
    for (let i = 0; i < b.n; i++) {
      const along = ((b.x[i] - b.cx) * dirX + (b.y[i] - b.cy) * dirY) / b.r;
      const k = 1 + L.stretch * along;
      b.vx[i] = dirX * speed * k + b.vx[i] * 0.3;
      b.vy[i] = dirY * speed * k + b.vy[i] * 0.3;
    }
    this.held = null;
    this.reload = L.reload;
    if (this.showHint) {
      this.showHint = false;
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* storage blocked */ }
    }
    this.sound.launch(power);
    this.fx.ring(b.cx, b.cy, b.r * 0.9, b.r + 34, WHITE, 3);
    this.hooks.onShake(1 + power * 2);
  }

  // Point-mass prediction of the first part of the flight (walls bounce, stops at a ball).
  updatePreview() {
    const b = this.held;
    const P = CFG.phys, W = CFG.world.w, H = CFG.world.h;
    const pts = [];
    const speed = this.launchSpeed(this.aim.power);
    let x = CFG.launcher.x, y = CFG.launcher.y;
    let vx = this.aim.dirX * speed, vy = this.aim.dirY * speed;
    const r = b.r * 0.95, dt = 1 / 60;
    let end = null;
    outer:
    for (let k = 0; k < 75; k++) {
      vy += P.gravity * dt;
      vx *= 1 - P.linearDrag * dt; vy *= 1 - P.linearDrag * dt;
      x += vx * dt; y += vy * dt;
      if (x < r) { x = r; vx = -vx * 0.5; }
      if (x > W - r) { x = W - r; vx = -vx * 0.5; }
      if (y < r) { y = r; vy = -vy * 0.5; }
      if (y > H - r) { end = { x, y: H - r }; break; }
      for (const o of this.world.bodies) {
        if (o === b) continue;
        const R = Math.sqrt(Math.abs(o.area) / Math.PI);
        if (Math.hypot(x - o.cx, y - o.cy) < r + R * 0.9) { end = { x, y }; break outer; }
      }
      if (k % 3 === 2) pts.push({ x, y });
    }
    this.aim.preview = pts;
    this.aim.end = end;
  }

  // ---- Merging, impacts, danger -------------------------------------------------------

  handleMerges() {
    for (const [a, b, x, y] of this.world.mergePairs) {
      if (a.dead || b.dead) continue;
      const level = a.level + 1;
      const wasHeld = a.held || b.held;
      const c = this.world.mergeInto(a, b, level, x, y);
      if (c.absorbed) this.fx.ghost(c.absorbed, levelColors(a.level).base, c);
      c.cooldown = CFG.merge.cooldown;
      c.flash = 1;
      c.sinceLaunch = 0;
      for (let i = 0; i < c.n; i++) c.vy[i] -= CFG.merge.pop;
      this.world.remove(a);
      this.world.remove(b);
      this.world.add(c);
      if (wasHeld) { this.held = null; this.reload = CFG.launch.reload; }
      this.world.impulse(c.cx, c.cy, c.r + 36, CFG.merge.shock, c);

      this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
      this.comboTimer = CFG.game.comboWindow;
      const gained = c.value * this.combo;
      this.score += gained;
      this.merges++;
      if (level > this.maxLevel) this.maxLevel = level;
      if (this.score > this.best) {
        // Save as soon as the record is beaten, so closing the tab mid-round keeps it.
        this.best = this.score;
        saveBest(this.best);
      }
      this.mergesTowardCharge++;
      if (this.mergesTowardCharge >= CFG.game.mergesPerCharge) {
        this.mergesTowardCharge = 0;
        if (this.charges < CFG.game.shakeCharges) { this.charges++; this.hooks.onCharges(this.charges); }
      }

      const col = levelColors(level);
      this.fx.splash(x, y, col.light, 9 + Math.min(14, level), 150 + level * 14);
      this.fx.ring(c.cx, c.cy, c.r * 0.6, c.r * 1.55, col.light, 5);
      this.fx.pop(c.cx, c.cy - c.r - 12, '+' + gained, 22 + Math.min(18, level * 1.6), WHITE);
      if (this.combo >= 2) this.fx.pop(c.cx, c.cy - c.r - 46, `连击 ×${this.combo}`, 20 + Math.min(12, this.combo * 2), [255, 212, 59], 95);
      this.sound.merge(level, this.combo);
      this.hooks.onShake(Math.min(10, 0.5 + level * 0.55));
      this.hooks.onScore(this.score, this.best);
      this.hooks.onMerge(level, this.combo);
    }
    this.world.compact();
  }

  handleImpacts() {
    const W = this.world;
    for (const [key, imp] of W.impacts) {
      if (W.prevContactKeys.has(key) || imp.speed < 80) continue;
      const s = Math.min(1, (imp.speed - 80) / 650);
      this.sound.bloop(Math.min(imp.a.r, imp.b.r), s);
      if (imp.speed > 320) {
        this.fx.splash(imp.x, imp.y, levelColors(imp.a.level).light, 3, 70 + s * 80);
        imp.a.hitFlash = Math.max(imp.a.hitFlash, s);
        imp.b.hitFlash = Math.max(imp.b.hitFlash, s);
      }
      if (imp.speed > 520) this.hooks.onShake(s * 3);
    }
    for (const w of W.wallImpacts) {
      const b = w.body;
      if (this.time - (b.lastWallSound || -1) < 0.3) continue;
      b.lastWallSound = this.time;
      this.sound.bloop(b.r, Math.min(1, (w.speed - 200) / 700));
    }
  }

  // Any ball (past its launch grace period) above the rope runs the timer. Speed is not
  // checked on purpose: a crammed tank jitters, and requiring "at rest" would let it go on
  // forever. Brief bounces cannot end the round because the timer drains when the zone clears.
  updateDanger(dt) {
    let over = false;
    for (const b of this.world.bodies) {
      if (b.held || b.sinceLaunch < CFG.game.dangerGrace) continue;
      if (b.minY < CFG.dangerY - 2) { over = true; break; }
    }
    if (over) {
      this.dangerT += dt;
      this.tickT -= dt;
      const u = this.dangerT / CFG.game.dangerLimit;
      if (this.tickT <= 0) { this.tickT = 0.5 - 0.3 * u; this.sound.tick(u); }
      if (this.dangerT >= CFG.game.dangerLimit) this.gameOver();
    } else {
      this.dangerT = Math.max(0, this.dangerT - dt * 1.5);
      this.tickT = 0;
    }
  }

  gameOver() {
    this.state = 'over';
    this.aim.active = false;
    if (this.held) { this.held.held = false; this.held.sinceLaunch = 0; this.held = null; }
    if (this.score >= this.best) { this.best = this.score; }
    saveBest(this.best);
    this.sound.gameOver();
    let maxLevel = this.maxLevel;
    for (const b of this.world.bodies) if (b.level > maxLevel) maxLevel = b.level;
    this.hooks.onState('over', { score: this.score, best: this.best, maxLevel, merges: this.merges });
  }

  useShake() {
    if (this.state !== 'playing' || this.charges <= 0 || this.shakeCooldown > 0) return false;
    this.charges--;
    this.shakeCooldown = 0.8;
    for (const b of this.world.bodies) {
      if (b.held) continue;
      const kick = (220 + Math.random() * 140) * Math.min(1.5, 0.55 + 40 / b.r);
      const side = (Math.random() - 0.5) * 220;
      for (let i = 0; i < b.n; i++) { b.vx[i] += side; b.vy[i] -= kick; }
      b.sinceLaunch = 0;  // thrown balls get the same grace period as launched ones
    }
    this.sound.shake();
    this.hooks.onShake(12);
    this.hooks.onCharges(this.charges);
    return true;
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.aim.active = false;
    this.hooks.onState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.hooks.onState('playing');
  }
}
