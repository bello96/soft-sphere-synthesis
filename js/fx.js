'use strict';
// Short-lived visual effects drawn inside the tank: droplets, rings, score pops, absorbed ghosts.

class Fx {
  constructor() {
    this.drops = [];
    this.rings = [];
    this.texts = [];
    this.ghosts = [];
  }

  clear() {
    this.drops.length = 0; this.rings.length = 0; this.texts.length = 0;
    this.ghosts.length = 0;
  }

  // A ball absorbed by another drains into it: its outline shrinks toward the survivor.
  ghost(body, hex, target) {
    this.ghosts.push({ xs: Float64Array.from(body.x), ys: Float64Array.from(body.y), cx: body.cx, cy: body.cy,
      target, color: hexToRgb(hex), t: 0, dur: 0.2 });
  }

  splash(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.drops.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.35,
        r: 2.5 + Math.random() * 4, life: 1, decay: 1.4 + Math.random() * 1.2, color,
      });
    }
  }

  ring(x, y, r0, r1, color, width = 4) {
    this.rings.push({ x, y, r0, r1, t: 0, dur: 0.45, color, width });
  }

  pop(x, y, text, size, color, rise = 70) {
    this.texts.push({ x, y, text, size, color, t: 0, dur: 1.1, rise });
  }

  update(dt) {
    const W = CFG.world.w, H = CFG.world.h;
    for (const d of this.drops) {
      d.vy += 520 * dt;
      d.vx *= 1 - 1.5 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.y > H - 4) { d.y = H - 4; d.vy *= -0.3; }
      if (d.x < 4 || d.x > W - 4) d.vx *= -0.5;
      d.life -= d.decay * dt;
    }
    for (const r of this.rings) r.t += dt;
    for (const t of this.texts) t.t += dt;
    for (const g of this.ghosts) g.t += dt;
    this.ghosts = this.ghosts.filter(g => g.t < g.dur);
    this.drops = this.drops.filter(d => d.life > 0);
    this.rings = this.rings.filter(r => r.t < r.dur);
    this.texts = this.texts.filter(t => t.t < t.dur);
  }

  draw(ctx) {
    for (const g of this.ghosts) {
      const k = g.t / g.dur, e = k * k;
      const tx = g.target.cx, ty = g.target.cy;
      const s = 1 - 0.75 * e;
      // Shrink around a centre that slides into the survivor.
      const ox = g.cx + (tx - g.cx) * e, oy = g.cy + (ty - g.cy) * e;
      ctx.fillStyle = rgbStr(mixRgb(g.color, WHITE, 0.4 + 0.6 * k), 1 - k * 0.8);
      ctx.beginPath();
      for (let i = 0; i < g.xs.length; i++) {
        const x = ox + (g.xs[i] - g.cx) * s, y = oy + (g.ys[i] - g.cy) * s;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    for (const r of this.rings) {
      const k = r.t / r.dur, e = 1 - Math.pow(1 - k, 3);
      ctx.strokeStyle = rgbStr(r.color, (1 - k) * 0.8);
      ctx.lineWidth = r.width * (1 - k * 0.7);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, TAU);
      ctx.stroke();
    }
    for (const d of this.drops) {
      ctx.fillStyle = rgbStr(d.color, Math.min(1, d.life * 1.4));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * (0.5 + 0.5 * d.life), 0, TAU);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const t of this.texts) {
      const k = t.t / t.dur;
      const appear = Math.min(1, t.t / 0.12);
      const scale = 0.6 + 0.4 * (1 - Math.pow(1 - appear, 3)) + (appear < 1 ? 0 : 0.08 * Math.sin(Math.min(1, (t.t - 0.12) * 6) * Math.PI));
      const alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      ctx.save();
      ctx.translate(t.x, t.y - t.rise * (1 - Math.pow(1 - k, 2)));
      ctx.scale(scale, scale);
      ctx.font = `700 ${t.size}px ${FONT_FAMILY}`;
      ctx.lineWidth = t.size * 0.2;
      ctx.strokeStyle = rgbStr(INK, alpha * 0.85);
      ctx.strokeText(t.text, 0, 0);
      ctx.fillStyle = rgbStr(t.color, alpha);
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }
  }
}
