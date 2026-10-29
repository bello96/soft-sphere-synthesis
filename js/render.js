'use strict';
// Canvas renderer: a dark tank where flat balloons press into a mosaic, separated only by the
// thin seams of dark ink between them. Also the aim guide, the fill line and effects.

const FONT_FAMILY = '"Fredoka", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

const TANK_INK = '#110f18';         // tank interior; the seams between balloons are this showing through
const FRAME_RGB = [43, 40, 54];
const FRAME_LIP = 'rgba(255, 255, 255, 0.07)';
const DANGER_RGB = [255, 90, 78];
// Outline offset beyond the skin particles. Contact keeps particles 2 * thickness apart, so the
// visible seam between two touching balloons is 2 * (thickness - SEAM_INFLATE) wide: 2.4 units,
// about as thin as the reference's. Contacts almost never come closer than 2 * SEAM_INFLATE, so
// touching outlines do not overlap.
const SEAM_INFLATE = 1.8;

class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.scale = 1;
    this.time = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Scratch buffers for outline vertices.
    this.vx = new Float64Array(256);
    this.vy = new Float64Array(256);
  }

  get viewW() { return CFG.world.w + CFG.world.margin * 2; }
  get viewH() { return CFG.world.h + CFG.world.margin * 2; }

  resize(cssW, cssH) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = cssH + 'px';
    this.cv.width = Math.round(cssW * this.dpr);
    this.cv.height = Math.round(cssH * this.dpr);
    this.scale = this.cv.width / this.viewW;
    this.cssScale = cssW / this.viewW;
    // The tank height is fitted to the screen again at the start of each round.
    this.tankPath = roundedTankPath(0, CFG.tank.cornerTop, CFG.tank.cornerBottom);
    this.framePath = roundedTankPath(8, CFG.tank.cornerTop + 8, CFG.tank.cornerBottom + 8);
  }

  // Client (CSS px relative to canvas) -> world units.
  toWorld(px, py) {
    const M = CFG.world.margin;
    return { x: px / this.cssScale - M, y: py / this.cssScale - M };
  }

  addShake(amount) {
    if (this.reducedMotion) return;
    this.shake = Math.min(14, this.shake + amount);
  }

  frame(game, dt) {
    this.time += dt;
    this.shake *= Math.exp(-dt * 9);
    const t = this.time;
    this.shakeX = this.shake > 0.05 ? (Math.sin(t * 91) + Math.sin(t * 57)) * 0.5 * this.shake : 0;
    this.shakeY = this.shake > 0.05 ? (Math.sin(t * 77) + Math.sin(t * 43)) * 0.5 * this.shake : 0;

    const ctx = this.ctx, s = this.scale, M = CFG.world.margin;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    ctx.setTransform(s, 0, 0, s, (M + this.shakeX) * s, (M + this.shakeY) * s);

    const danger = Math.min(1, game.dangerT / CFG.game.dangerLimit);
    ctx.fillStyle = TANK_INK;
    ctx.fill(this.tankPath);
    ctx.save();
    ctx.clip(this.tankPath);
    this.drawDangerGlow(ctx, danger);
    if (game.held && !game.held.dead) this.drawHeldHalo(ctx, game);
    for (const b of game.world.bodies) this.drawBody(ctx, b);
    this.drawFillLine(ctx, game, danger);
    this.drawAim(ctx, game);
    game.fx.draw(ctx);
    this.drawNext(ctx, game);
    ctx.restore();

    this.drawFrame(ctx, danger);
  }

  // Smooth closed outline through the skin particles, pushed out a little past the skin.
  bodyPath(b, inflate) {
    const n = b.n, x = b.x, y = b.y, X = this.vx, Y = this.vy;
    for (let i = 0; i < n; i++) {
      const p = i === 0 ? n - 1 : i - 1, q = i + 1 === n ? 0 : i + 1;
      const dx = x[q] - x[p], dy = y[q] - y[p];
      const l = Math.sqrt(dx * dx + dy * dy) || 1;
      // Offsetting a sharp inward corner would tie a small loop into the outline,
      // so concave corners are pushed out less the sharper they are.
      const ax = x[i] - x[p], ay = y[i] - y[p], bx = x[q] - x[i], by = y[q] - y[i];
      const turn = (ax * by - ay * bx) / ((Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by)) || 1);
      const k = turn < 0 ? Math.max(0.1, 1 + 1.6 * turn) : 1;
      X[i] = x[i] + dy / l * inflate * k;
      Y[i] = y[i] - dx / l * inflate * k;
    }
    const path = new Path2D();
    path.moveTo((X[0] + X[1]) * 0.5, (Y[0] + Y[1]) * 0.5);
    for (let i = 1; i <= n; i++) {
      const a = i % n, c = (i + 1) % n;
      path.quadraticCurveTo(X[a], Y[a], (X[a] + X[c]) * 0.5, (Y[a] + Y[c]) * 0.5);
    }
    path.closePath();
    return path;
  }

  // Flat colour, no outline: neighbours are told apart by the seam of tank ink between them.
  drawBody(ctx, b) {
    const col = levelColors(b.level);
    const glow = Math.max(b.flash * 0.92, b.hitFlash * 0.12);
    ctx.fillStyle = rgbStr(glow > 0 ? mixRgb(col.base, WHITE, glow) : col.base);
    ctx.fill(this.bodyPath(b, SEAM_INFLATE));
    this.drawLabel(ctx, b, col, glow);
  }

  drawLabel(ctx, b, col, glow) {
    const txt = formatValue(b.value);
    const d = txt.length;
    // The number is a small stamp that grows slowly with the ball, capped so it always fits.
    const R = b.r * b.scale;
    const fit = R * (d <= 1 ? 0.9 : d === 2 ? 0.74 : d === 3 ? 0.56 : d === 4 ? 0.44 : d === 5 ? 0.36 : 0.3);
    const size = Math.min(fit, (18 + R * 0.15) * (d <= 2 ? 1 : d === 3 ? 0.92 : d === 4 ? 0.84 : 0.76));
    // Follow the skin's rotation and most of its deformation, so the number squishes too.
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle), k = 0.7;
    const m11 = ca + (b.defA - ca) * k, m12 = -sa + (b.defB + sa) * k;
    const m21 = sa + (b.defC - sa) * k, m22 = ca + (b.defD - ca) * k;
    ctx.save();
    ctx.transform(m11, m21, m12, m22, b.cx, b.cy);
    ctx.font = `700 ${size.toFixed(1)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgbStr(col.ink, 0.86 * (1 - glow * 0.6));
    ctx.fillText(txt, 0, size * 0.06);
    ctx.restore();
  }

  drawHeldHalo(ctx, game) {
    const b = game.held;
    const ready = game.canAim();
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    const R = b.r * b.scale + 12;
    ctx.save();
    ctx.strokeStyle = `rgba(242, 240, 250, ${ready ? 0.10 + pulse * 0.10 : 0.05})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 8]);
    ctx.lineDashOffset = -this.time * 12;
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, R, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawAim(ctx, game) {
    const aim = game.aim;
    if (!aim.active && game.showHint && game.canAim()) this.drawHint(ctx, game.held);
    if (!aim.active || !game.held) return;
    const b = game.held;
    const pts = aim.preview;
    if (aim.power > 0) {
      for (let k = 0; k < pts.length; k++) {
        const f = 1 - k / pts.length;
        ctx.fillStyle = `rgba(242,240,250,${(0.15 + 0.7 * f).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pts[k].x, pts[k].y, 2 + 3 * f, 0, TAU);
        ctx.fill();
      }
      if (aim.end) {
        ctx.save();
        ctx.setLineDash([7, 7]);
        ctx.lineDashOffset = -this.time * 30;
        ctx.strokeStyle = 'rgba(242,240,250,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(aim.end.x, aim.end.y, b.r, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
    // Power ring around the ball: cool at low power, hot at full power.
    const R = b.r + 12;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(242,240,250,0.12)';
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, R, 0, TAU);
    ctx.stroke();
    if (aim.power > 0) {
      ctx.strokeStyle = rgbStr(mixRgb([46, 211, 155], DANGER_RGB, aim.power));
      ctx.beginPath();
      const a0 = Math.atan2(aim.dirY, aim.dirX);
      ctx.arc(b.cx, b.cy, R, a0 - Math.PI * aim.power, a0 + Math.PI * aim.power);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(242,240,250,0.5)';
      ctx.setLineDash([3, 7]);
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, CFG.launch.deadZone, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  // First-run hint under the launcher: a pulsing chevron and one line of instruction.
  drawHint(ctx, b) {
    const t = this.time;
    const x = b.cx, y = b.cy + b.r + 16;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < 3; k++) {
      const a = 0.25 + 0.6 * Math.max(0, Math.sin(t * 4 - k * 0.9));
      ctx.strokeStyle = `rgba(242,240,250,${a.toFixed(3)})`;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 12, y + k * 13);
      ctx.lineTo(x, y + 9 + k * 13);
      ctx.lineTo(x + 12, y + k * 13);
      ctx.stroke();
    }
    ctx.font = `600 20px ${FONT_FAMILY}`;
    ctx.fillStyle = 'rgba(242,240,250,0.9)';
    ctx.fillText('按住拖动瞄准，松手发射', CFG.world.w / 2, CFG.dangerY + 36);
    ctx.restore();
  }

  // A warm glow creeps down from the top while the round is counting down.
  drawDangerGlow(ctx, danger) {
    if (danger <= 0) return;
    const a = (0.10 + 0.08 * Math.sin(this.time * 10)) * Math.min(1, danger * 3);
    const g = ctx.createLinearGradient(0, 0, 0, CFG.dangerY);
    g.addColorStop(0, rgbStr(DANGER_RGB, 0));
    g.addColorStop(1, rgbStr(DANGER_RGB, a));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CFG.world.w, CFG.dangerY);
  }

  // The fill line: a quiet dashed line that turns hot and starts counting when balls stay above it.
  drawFillLine(ctx, game, danger) {
    const W = CFG.world.w, y0 = CFG.dangerY;
    const hot = danger > 0 ? 0.5 + 0.5 * Math.sin(this.time * 10) : 0;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.setLineDash([2, 12]);
    ctx.lineDashOffset = danger > 0 && !this.reducedMotion ? -this.time * 40 : 0;
    ctx.strokeStyle = danger > 0
      ? rgbStr(mixRgb(DANGER_RGB, WHITE, hot * 0.4), 0.55 + 0.45 * Math.min(1, danger * 3))
      : 'rgba(242,240,250,0.22)';
    ctx.beginPath();
    ctx.moveTo(10, y0);
    ctx.lineTo(W - 10, y0);
    ctx.stroke();
    ctx.restore();
    if (danger > 0 && game.state === 'playing') {
      // Big countdown so the rule explains itself: 3, 2, 1.
      const left = Math.max(0, CFG.game.dangerLimit - game.dangerT);
      const frac = left - Math.floor(left);
      const pop = 1 + 0.25 * Math.pow(frac, 6);
      ctx.save();
      ctx.translate(W - 82, y0 - 70);
      ctx.scale(pop, pop);
      ctx.font = `700 60px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = Math.min(1, danger * 4);
      ctx.fillStyle = rgbStr(DANGER_RGB);
      ctx.fillText(String(Math.ceil(left)), 0, 0);
      ctx.restore();
    }
  }

  drawNext(ctx, game) {
    const lv = game.queue[0];
    if (!lv) return;
    const { x, y, r } = game.nextSlot;
    const col = levelColors(lv);
    ctx.save();
    ctx.strokeStyle = 'rgba(242,240,250,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r + 8, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgbStr(col.base);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    const txt = formatValue(2 ** lv);
    const size = r * (txt.length <= 2 ? 0.8 : txt.length === 3 ? 0.62 : 0.48);
    ctx.font = `700 ${size.toFixed(1)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgbStr(col.ink, 0.86);
    ctx.fillText(txt, x, y + size * 0.06);
    ctx.font = `600 17px ${FONT_FAMILY}`;
    ctx.fillStyle = 'rgba(242,240,250,0.6)';
    ctx.fillText('下一个', x, y + r + 25);
    ctx.restore();
  }

  // The container: a thick rounded frame that heats up while the round is counting down.
  drawFrame(ctx, danger) {
    const hot = danger > 0 ? Math.min(1, danger * 2) * (0.55 + 0.45 * Math.sin(this.time * 10)) : 0;
    ctx.save();
    ctx.lineWidth = 16;
    ctx.strokeStyle = rgbStr(mixRgb(FRAME_RGB, DANGER_RGB, hot));
    ctx.stroke(this.framePath);
    ctx.lineWidth = 2;
    ctx.strokeStyle = FRAME_LIP;
    ctx.stroke(this.tankPath);
    ctx.restore();
  }
}

function formatValue(v) {
  if (v >= 1e6) return Math.round(v / 1e6) + 'M';
  if (v >= 1e6 / 2) return Math.round(v / 1e3) + 'K';
  return String(v);
}

function roundedTankPath(pad, rt, rb) {
  const W = CFG.world.w, H = CFG.world.h;
  const x0 = -pad, y0 = -pad, x1 = W + pad, y1 = H + pad;
  const p = new Path2D();
  p.moveTo(x0 + rt, y0);
  p.lineTo(x1 - rt, y0);
  p.arcTo(x1, y0, x1, y0 + rt, rt);
  p.lineTo(x1, y1 - rb);
  p.arcTo(x1, y1, x1 - rb, y1, rb);
  p.lineTo(x0 + rb, y1);
  p.arcTo(x0, y1, x0, y1 - rb, rb);
  p.lineTo(x0, y0 + rt);
  p.arcTo(x0, y0, x0 + rt, y0, rt);
  p.closePath();
  return p;
}
