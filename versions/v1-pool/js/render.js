'use strict';
// Canvas renderer: deep-water tank, glossy water balloons, aim guide, lane rope, effects.

const FONT_FAMILY = '"Fredoka", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

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
    this.xray = false;
    this.reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.caustic = makeCausticTexture(256);
    this.causticPattern = this.ctx.createPattern(this.caustic, 'repeat');
    this.tankPath = roundedTankPath(0, CFG.tank.cornerTop, CFG.tank.cornerBottom);
    this.framePath = roundedTankPath(6, CFG.tank.cornerTop + 6, CFG.tank.cornerBottom + 6);
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

    this.drawWater(ctx);
    ctx.save();
    ctx.clip(this.tankPath);
    this.drawCaustics(ctx);
    this.drawRays(ctx);

    const bodies = game.world.bodies;
    const paths = bodies.map(b => this.bodyPath(b, 2.2));
    ctx.fillStyle = 'rgba(2, 22, 38, 0.28)';
    ctx.save();
    ctx.translate(2, 7);
    for (const p of paths) ctx.fill(p);
    ctx.restore();

    if (game.held && !game.held.dead) this.drawHeldHalo(ctx, game);
    for (let k = 0; k < bodies.length; k++) this.drawBody(ctx, bodies[k], paths[k]);
    this.drawLaneRope(ctx, game);
    this.drawAim(ctx, game);
    game.fx.draw(ctx);
    this.drawNext(ctx, game);
    ctx.restore();

    this.drawFrame(ctx);
    if (this.xray) this.drawXray(ctx, game);
  }

  drawWater(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, CFG.world.h);
    g.addColorStop(0, '#1d7fa0');
    g.addColorStop(0.45, '#13607f');
    g.addColorStop(1, '#0a3b58');
    ctx.fillStyle = g;
    ctx.fill(this.tankPath);
  }

  drawCaustics(ctx) {
    const t = this.reducedMotion ? 0 : this.time;
    const W = CFG.world.w, H = CFG.world.h;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = this.causticPattern;
    ctx.globalAlpha = 0.055;
    ctx.save();
    const s1 = 1.8 + Math.sin(t * 0.7) * 0.06;
    ctx.scale(s1, s1);
    ctx.translate((t * 9) % 256, (t * 5) % 256);
    ctx.fillRect(-300, -300, W / 1.7 + 600, H / 1.7 + 600);
    ctx.restore();
    ctx.globalAlpha = 0.045;
    ctx.save();
    const s2 = 2.4 + Math.sin(t * 0.5 + 1) * 0.08;
    ctx.scale(s2, s2);
    ctx.rotate(0.6);
    ctx.translate(-(t * 7) % 256, (t * 4) % 256);
    ctx.fillRect(-400, -400, W + 800, H + 800);
    ctx.restore();
    ctx.restore();
  }

  drawRays(ctx) {
    const t = this.reducedMotion ? 0 : this.time;
    const W = CFG.world.w, H = CFG.world.h;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) {
      const x0 = W * (0.18 + 0.32 * k) + Math.sin(t * 0.25 + k * 2.1) * 26;
      const g = ctx.createLinearGradient(0, 0, 0, H * 0.8);
      g.addColorStop(0, 'rgba(190, 240, 255, 0.075)');
      g.addColorStop(1, 'rgba(190, 240, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0 - 26, 0);
      ctx.lineTo(x0 + 30, 0);
      ctx.lineTo(x0 + 150, H * 0.8);
      ctx.lineTo(x0 + 30, H * 0.8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Smooth closed outline through the skin particles, pushed out by the skin thickness so
  // neighbouring balloons visually touch.
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

  drawBody(ctx, b, path) {
    const col = levelColors(b.level);
    const R = Math.sqrt(Math.abs(b.area) / Math.PI) || b.r;
    const cx = b.cx, cy = b.cy;
    // The highlight sits between the centre and the surface point facing the light.
    let best = -Infinity, hx = cx, hy = cy;
    for (let i = 0; i < b.n; i++) {
      const d = (b.x[i] - cx) * -0.55 + (b.y[i] - cy) * -0.83;
      if (d > best) { best = d; hx = b.x[i]; hy = b.y[i]; }
    }
    const lx = cx + (hx - cx) * 0.52, ly = cy + (hy - cy) * 0.52;

    const g = ctx.createRadialGradient(lx, ly, R * 0.05, cx, cy, R * 1.2);
    g.addColorStop(0, rgbStr(col.light));
    g.addColorStop(0.5, rgbStr(col.base));
    g.addColorStop(1, rgbStr(col.dark));
    ctx.fillStyle = g;
    ctx.fill(path);

    ctx.save();
    ctx.clip(path);
    const bx = b.minX - 8, by = b.minY - 8, bw = b.maxX - b.minX + 16, bh = b.maxY - b.minY + 16;
    if (col.stripe) this.drawStripes(ctx, b, col, lx, ly, R);
    // Light passing through the water inside pools at the bottom of the balloon.
    const gx = cx + R * 0.18, gy = cy + R * 0.72;
    const g2 = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.85);
    g2.addColorStop(0, rgbStr(col.soft, 0.6));
    g2.addColorStop(1, rgbStr(col.soft, 0));
    ctx.fillStyle = g2;
    ctx.fillRect(bx, by, bw, bh);
    if (b.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(b.flash * 0.9).toFixed(3)})`;
      ctx.fillRect(bx, by, bw, bh);
    }
    if (b.hitFlash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(b.hitFlash * 0.35).toFixed(3)})`;
      ctx.fillRect(bx, by, bw, bh);
    }
    // Specular highlight.
    ctx.translate(lx, ly);
    ctx.rotate(-0.62);
    ctx.scale(1, 0.52);
    const hr = R * 0.42;
    const g3 = ctx.createRadialGradient(0, 0, 0, 0, 0, hr);
    g3.addColorStop(0, 'rgba(255,255,255,0.85)');
    g3.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    g3.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g3;
    ctx.beginPath();
    ctx.arc(0, 0, hr, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = 2.2;
    ctx.strokeStyle = rgbStr(col.rim, 0.85);
    ctx.stroke(path);
    this.drawLabel(ctx, b, R, col);
  }

  // Beach-ball wedges: anchored to skin particles, so they stretch and roll with the ball.
  drawStripes(ctx, b, col, lx, ly, R) {
    const n = b.n, segs = 6;
    ctx.fillStyle = rgbStr(col.stripe, 0.95);
    for (let s = 0; s < segs; s += 2) {
      const i0 = Math.floor(s * n / segs), i1 = Math.floor((s + 1) * n / segs);
      ctx.beginPath();
      ctx.moveTo(b.cx, b.cy);
      for (let i = i0; i <= i1; i++) {
        const k = i % n;
        ctx.lineTo(b.cx + (b.x[k] - b.cx) * 1.3, b.cy + (b.y[k] - b.cy) * 1.3);
      }
      ctx.closePath();
      ctx.fill();
    }
    const g = ctx.createRadialGradient(lx, ly, R * 0.1, b.cx, b.cy, R * 1.2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, rgbStr(col.dark, 0.08));
    g.addColorStop(1, rgbStr(col.dark, 0.55));
    ctx.fillStyle = g;
    ctx.fillRect(b.minX - 8, b.minY - 8, b.maxX - b.minX + 16, b.maxY - b.minY + 16);
  }

  drawLabel(ctx, b, R, col) {
    const txt = formatValue(b.value);
    const d = txt.length;
    const size = R * (d <= 1 ? 0.92 : d === 2 ? 0.78 : d === 3 ? 0.6 : d === 4 ? 0.49 : d === 5 ? 0.4 : 0.34);
    // Partly follow the skin's deformation so the number squishes with the balloon.
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle), k = 0.6;
    const m11 = ca + (b.defA - ca) * k, m12 = -sa + (b.defB + sa) * k;
    const m21 = sa + (b.defC - sa) * k, m22 = ca + (b.defD - ca) * k;
    ctx.save();
    ctx.transform(m11, m21, m12, m22, b.cx, b.cy);
    ctx.font = `700 ${size.toFixed(1)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.18);
    ctx.strokeStyle = rgbStr(col.ink, 0.92);
    const oy = size * 0.05;
    ctx.strokeText(txt, 0, oy);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(txt, 0, oy);
    ctx.restore();
  }

  drawHeldHalo(ctx, game) {
    const b = game.held;
    const ready = game.canAim();
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    const R = b.r * b.scale;
    ctx.save();
    const g = ctx.createRadialGradient(b.cx, b.cy, R * 0.6, b.cx, b.cy, R * 1.7);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(200,245,255,${ready ? 0.10 + pulse * 0.08 : 0.05})`);
    g.addColorStop(1, 'rgba(200,245,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, R * 1.7, 0, TAU);
    ctx.fill();
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
        ctx.fillStyle = `rgba(255,255,255,${(0.2 + 0.7 * f).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pts[k].x, pts[k].y, 2 + 3.2 * f, 0, TAU);
        ctx.fill();
      }
      if (aim.end) {
        ctx.save();
        ctx.setLineDash([7, 7]);
        ctx.lineDashOffset = -this.time * 30;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(aim.end.x, aim.end.y, b.r, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
    // Power ring around the ball: mint at low power, coral at full power.
    const R = b.r + 12;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, R, 0, TAU);
    ctx.stroke();
    if (aim.power > 0) {
      const c = mixRgb([99, 230, 190], [255, 107, 107], aim.power);
      ctx.strokeStyle = rgbStr(c);
      ctx.beginPath();
      const a0 = Math.atan2(aim.dirY, aim.dirX);
      ctx.arc(b.cx, b.cy, R, a0 - Math.PI * aim.power, a0 + Math.PI * aim.power);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
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
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 12, y + k * 13);
      ctx.lineTo(x, y + 9 + k * 13);
      ctx.lineTo(x + 12, y + k * 13);
      ctx.stroke();
    }
    ctx.font = `600 20px ${FONT_FAMILY}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(6, 40, 64, 0.7)';
    ctx.strokeText('按住拖动瞄准，松手发射', CFG.world.w / 2, CFG.dangerY + 36);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('按住拖动瞄准，松手发射', CFG.world.w / 2, CFG.dangerY + 36);
    ctx.restore();
  }

  drawLaneRope(ctx, game) {
    const W = CFG.world.w, y0 = CFG.dangerY;
    const danger = Math.min(1, game.dangerT / CFG.game.dangerLimit);
    const t = this.time;
    if (danger > 0) {
      const a = (0.10 + 0.12 * Math.sin(t * 10)) * Math.min(1, danger * 3);
      const g = ctx.createLinearGradient(0, 0, 0, y0);
      g.addColorStop(0, 'rgba(255, 90, 95, 0)');
      g.addColorStop(1, `rgba(255, 90, 95, ${a.toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, y0);
    }
    ctx.strokeStyle = 'rgba(230, 250, 255, 0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(W, y0);
    ctx.stroke();
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
      ctx.lineJoin = 'round';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(160, 20, 40, 0.85)';
      ctx.globalAlpha = Math.min(1, danger * 4);
      const txt = String(Math.ceil(left));
      ctx.strokeText(txt, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    }
    const count = 22, step = W / count;
    for (let k = 0; k < count; k++) {
      const x = step * (k + 0.5);
      const bob = this.reducedMotion ? 0 : Math.sin(t * 1.8 + k * 0.7) * (1.2 + danger * 2.5);
      const red = k % 2 === 0;
      const w = step * 0.78, h = 12;
      const g = ctx.createLinearGradient(0, y0 - h / 2, 0, y0 + h / 2);
      if (red) {
        const hot = danger > 0 ? 0.5 + 0.5 * Math.sin(t * 10) : 0;
        g.addColorStop(0, rgbStr(mixRgb([255, 140, 140], [255, 220, 200], hot)));
        g.addColorStop(1, '#d93a40');
      } else {
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, '#bcd9e4');
      }
      ctx.fillStyle = g;
      pillPath(ctx, x - w / 2, y0 - h / 2 + bob, w, h);
      ctx.fill();
    }
  }

  drawNext(ctx, game) {
    const lv = game.queue[0];
    if (!lv) return;
    const { x, y, r } = game.nextSlot;
    const col = levelColors(lv);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = 'rgba(220,248,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r + 8, 0, TAU);
    ctx.fill();
    ctx.stroke();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r * 1.2);
    g.addColorStop(0, rgbStr(col.light));
    g.addColorStop(0.5, rgbStr(col.base));
    g.addColorStop(1, rgbStr(col.dark));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = rgbStr(col.rim);
    ctx.stroke();
    const txt = formatValue(2 ** lv);
    const size = r * (txt.length <= 2 ? 0.85 : txt.length === 3 ? 0.66 : 0.5);
    ctx.font = `700 ${size.toFixed(1)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = rgbStr(col.ink);
    ctx.strokeText(txt, x, y + size * 0.05);
    ctx.fillStyle = '#fff';
    ctx.fillText(txt, x, y + size * 0.05);
    ctx.font = `600 17px ${FONT_FAMILY}`;
    ctx.fillStyle = 'rgba(225,248,255,0.85)';
    ctx.fillText('下一个', x, y + r + 25);
    ctx.restore();
  }

  drawFrame(ctx) {
    ctx.save();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#0b4864';
    ctx.stroke(this.framePath);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(205, 246, 255, 0.75)';
    ctx.stroke(this.framePath);
    // Soft reflection on the glass.
    ctx.clip(this.tankPath);
    const g = ctx.createLinearGradient(0, 0, CFG.world.w * 0.5, CFG.world.h * 0.35);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.03)');
    g.addColorStop(0.31, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CFG.world.w, CFG.world.h);
    ctx.restore();
  }

  // Physics view: particles, skin springs and the round rest shape each ball relaxes toward.
  drawXray(ctx, game) {
    ctx.save();
    for (const b of game.world.bodies) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= b.n; i++) {
        const k = i % b.n;
        if (i === 0) ctx.moveTo(b.x[k], b.y[k]); else ctx.lineTo(b.x[k], b.y[k]);
      }
      ctx.stroke();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(255,230,120,0.7)';
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, b.r * b.scale, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,230,120,0.5)';
      ctx.beginPath();
      ctx.moveTo(b.cx, b.cy);
      ctx.lineTo(b.cx + Math.cos(b.angle) * b.r * b.scale, b.cy + Math.sin(b.angle) * b.r * b.scale);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < b.n; i++) {
        ctx.beginPath();
        ctx.arc(b.x[i], b.y[i], 1.8, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function formatValue(v) {
  if (v >= 1e6) return Math.round(v / 1e6) + 'M';
  if (v >= 1e6 / 2) return Math.round(v / 1e3) + 'K';
  return String(v);
}

function pillPath(ctx, x, y, w, h) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
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

// Tileable caustic web: brightness peaks along Voronoi cell borders (F2 - F1 small).
function makeCausticTexture(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  let seed = 917;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pts = [];
  for (let k = 0; k < 22; k++) pts.push([rnd() * size, rnd() * size]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let f1 = 1e9, f2 = 1e9;
      for (const [px, py] of pts) {
        let dx = Math.abs(x - px), dy = Math.abs(y - py);
        if (dx > size / 2) dx = size - dx;
        if (dy > size / 2) dy = size - dy;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      const e = Math.sqrt(f2) - Math.sqrt(f1);
      const v = Math.max(0, 1 - e / 5.5);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(v * v * 255);
    }
  }
  g.putImageData(img, 0, 0);
  // Soften the web so it reads as moving light rather than cracked glass.
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const o = out.getContext('2d');
  o.filter = 'blur(1.2px)';
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) o.drawImage(cv, dx * size, dy * size);
  return out;
}
