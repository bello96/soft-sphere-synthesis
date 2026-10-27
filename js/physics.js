'use strict';
// Soft-body physics: every ball is a balloon, a closed ring of particles.
//   * skin    - distance constraints between neighbours, pre-stretched so the skin is taut
//   * gas     - one compliant area constraint per ball: an internal pressure that can be squeezed
//   * shape   - optional shape matching toward a round rest shape (always gives the rotation)
//   * no-fold - every edge keeps a minimum triangle area with the centroid
// Solved with XPBD using many small substeps. Collisions are particle-vs-edge against other
// rings, found through a uniform grid that is rebuilt every substep; a once-per-frame pass
// rescues particles that ended up deep inside another ring.

const TAU = Math.PI * 2;

function particleCountForRadius(r) {
  const P = CFG.phys;
  return Math.max(P.minParticles, Math.min(P.maxParticles, Math.round(TAU * r / P.spacing)));
}

let nextBodyId = 1;

class SoftBody {
  constructor(level, cx, cy, n) {
    this.id = nextBodyId++;
    this.level = level;
    this.value = 2 ** level;
    this.r = radiusForLevel(level);
    n = n || particleCountForRadius(this.r);
    this.n = n;
    this.x = new Float64Array(n); this.y = new Float64Array(n);
    this.px = new Float64Array(n); this.py = new Float64Array(n);
    this.vx = new Float64Array(n); this.vy = new Float64Array(n);
    this.qx = new Float64Array(n); this.qy = new Float64Array(n);   // rest offsets
    this.nx = new Float64Array(n); this.ny = new Float64Array(n);   // outward normal of edge i -> i+1
    this.gx = new Float64Array(n); this.gy = new Float64Array(n);   // scratch (area gradient)
    const r = this.r;
    for (let k = 0; k < n; k++) {
      const a = TAU * k / n;
      this.qx[k] = Math.cos(a) * r;
      this.qy[k] = Math.sin(a) * r;
      this.x[k] = this.px[k] = cx + this.qx[k];
      this.y[k] = this.py[k] = cy + this.qy[k];
    }
    const P = CFG.phys;
    this.restArea = 0.5 * n * r * r * Math.sin(TAU / n);
    this.mass = P.density * this.restArea;
    this.w = n / this.mass;                       // inverse mass of one particle
    // Gas at pressure p0 pushes the skin out; the skin holds it with tension T0. For a regular
    // n-gon the two balance when T0 = p0 r cos(pi/n). The skin's rest length and the gas's
    // preferred area are both offset so that this free equilibrium is exactly the circle.
    this.p0 = P.pressure0 * Math.pow(r / CFG.size.r0, P.pressureExp);
    const T0 = this.p0 * r * Math.cos(Math.PI / n);
    this.skinK = T0 / P.skinStretch;                              // force per unit strain
    this.restLen = 2 * r * Math.sin(Math.PI / n) / (1 + P.skinStretch);
    this.areaBoost = 1 + this.p0 / P.bulk;

    // Size animation (spawn inflate / merge contraction): scale multiplies the rest shape.
    this.scale = 1;
    this.scaleFrom = 1;
    this.scaleTo = 1;
    this.scaleT = 0;
    this.scaleDur = 0;
    // Extra skin length at birth (merged outlines are longer than a circle), eased out with scale.
    this.skinBoost = 1;
    this.skinFrom = 1;

    // Derived every step.
    this.cx = cx; this.cy = cy;
    this.vcx = 0; this.vcy = 0;
    this.angle = 0;
    this.area = this.restArea;
    this.minX = cx - r; this.maxX = cx + r; this.minY = cy - r; this.maxY = cy + r;
    // Affine deformation (2x2, row-major) relative to the rest shape, for squishing the label.
    this.defA = 1; this.defB = 0; this.defC = 0; this.defD = 1;

    // Gameplay state.
    this.held = false;       // sitting in the launcher (no gravity, spring to anchor)
    this.ax = cx; this.ay = cy;
    this.squash = 0;         // launcher press while aiming: extra aspect, along (squashX, squashY)
    this.squashX = 0; this.squashY = 1;
    this.dead = false;
    this.age = 0;
    this.sinceLaunch = 99;
    this.cooldown = 0;
    this.flash = 0;
    this.hitFlash = 0;
  }

  setVelocity(vx, vy) {
    this.vx.fill(vx); this.vy.fill(vy);
    this.vcx = vx; this.vcy = vy;
  }

  animateScale(from, to, dur) {
    this.scale = from;
    this.scaleFrom = from;
    this.scaleTo = to;
    this.scaleT = 0;
    this.scaleDur = dur;
    this.skinBoost = this.skinFrom = 1;
  }

  // Lets the skin start at the length of the outline it was born with (at its normal rest
  // stretch), so a long peanut-shaped merge outline is not yanked tight in its first frame,
  // which could twist its waist. The extra length eases out with the scale animation.
  fitSkinToRing() {
    let per = 0;
    for (let i = 0; i < this.n; i++) {
      const j = i + 1 === this.n ? 0 : i + 1;
      per += Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i]);
    }
    const rest = this.n * this.restLen * this.scale * (1 + CFG.phys.skinStretch);
    this.skinBoost = this.skinFrom = Math.max(1, per / rest);
  }

  // Puts the ring on its rest circle at the current scale (for balls that spawn small: the soft
  // gas would otherwise take several frames to squeeze a full-size ring down).
  fitRingToScale() {
    let cx = 0, cy = 0;
    for (let i = 0; i < this.n; i++) { cx += this.x[i]; cy += this.y[i]; }
    cx /= this.n; cy /= this.n;
    const s = this.scale;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = this.px[i] = cx + this.qx[i] * s;
      this.y[i] = this.py[i] = cy + this.qy[i] * s;
    }
  }

  updateScale(dt) {
    if (this.scaleDur <= 0) return;
    this.scaleT = Math.min(1, this.scaleT + dt / this.scaleDur);
    const t = this.scaleT;
    const e = 1 - Math.pow(1 - t, 3);          // ease-out cubic
    this.scale = this.scaleFrom + (this.scaleTo - this.scaleFrom) * e;
    this.skinBoost = 1 + (this.skinFrom - 1) * (1 - e);
    if (t >= 1) this.scaleDur = 0;
  }

  updateDerived() {
    const n = this.n, x = this.x, y = this.y;
    let cx = 0, cy = 0, vx = 0, vy = 0, area = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      cx += xi; cy += yi; vx += this.vx[i]; vy += this.vy[i];
      if (xi < minX) minX = xi; if (xi > maxX) maxX = xi;
      if (yi < minY) minY = yi; if (yi > maxY) maxY = yi;
      const j = i + 1 === n ? 0 : i + 1;
      area += xi * y[j] - x[j] * yi;
    }
    this.cx = cx / n; this.cy = cy / n;
    this.vcx = vx / n; this.vcy = vy / n;
    this.area = area * 0.5;
    this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;

    // Best-fit affine map from rest shape to current shape: A = Apq * Aqq^-1.
    // For a regular polygon Aqq is (n r^2 / 2) * I, which keeps this cheap.
    let a = 0, b = 0, c = 0, d = 0;
    const s = this.scale;
    for (let i = 0; i < n; i++) {
      const px = x[i] - this.cx, py = y[i] - this.cy;
      const qx = this.qx[i] * s, qy = this.qy[i] * s;
      a += px * qx; b += px * qy; c += py * qx; d += py * qy;
    }
    const inv = 2 / (n * this.r * this.r * s * s);
    this.defA = a * inv; this.defB = b * inv; this.defC = c * inv; this.defD = d * inv;
  }

  get speed() { return Math.hypot(this.vcx, this.vcy); }
}

class PhysicsWorld {
  constructor() {
    this.bodies = [];
    this.gravityX = 0;
    this.gravityY = CFG.phys.gravity;
    const W = CFG.world.w, H = CFG.world.h;
    this.cs = CFG.phys.cellSize;
    this.gx0 = -80; this.gy0 = -80;
    this.gw = Math.ceil((W + 160) / this.cs);
    this.gh = Math.ceil((H + 160) / this.cs);
    const cells = this.gw * this.gh;
    this.cellCount = new Int32Array(cells);
    this.cellStart = new Int32Array(cells + 1);
    this.entries = new Int32Array(8192);
    // Per-particle scratch for picking the nearest edge of each neighbouring body.
    this.candBody = new Int32Array(8);
    this.candEdge = new Int32Array(8);
    this.candT = new Float64Array(8);
    this.candD2 = new Float64Array(8);
    this.mergePairs = [];
    this.mergeKeys = new Set();
    this.impacts = new Map();      // pair key -> {a, b, speed, x, y}
    this.contactKeys = new Set();  // pairs touching this frame
    this.prevContactKeys = new Set();
    this.wallImpacts = [];
    this.canMerge = () => false;   // supplied by the game
    this.stepMs = 0;
    this.tangles = 0;              // frames x balls found crossing themselves (diagnostics)
  }

  add(body) { this.bodies.push(body); return body; }

  remove(body) { body.dead = true; }

  // Drop removed bodies now (otherwise they linger in the list until the next step).
  compact() {
    if (this.bodies.some(b => b.dead)) this.bodies = this.bodies.filter(b => !b.dead);
  }

  step(dt) {
    const t0 = performance.now();
    const P = CFG.phys;
    this.compact();
    const bodies = this.bodies;
    for (const b of bodies) b.updateScale(dt);
    this.mergePairs.length = 0;
    this.mergeKeys.clear();
    this.impacts.clear();
    const tmp = this.prevContactKeys;
    this.prevContactKeys = this.contactKeys;
    this.contactKeys = tmp;
    this.contactKeys.clear();
    this.wallImpacts.length = 0;

    const sub = P.substeps, h = dt / sub;
    for (let s = 0; s < sub; s++) {
      this.integrate(h);
      for (const b of bodies) {
        this.solveSkin(b, h, (s & 1) === 1);
        this.solveArea(b, h);
        this.solveShape(b);
        this.solveNoFold(b);
      }
      this.buildGrid();
      this.solveCollisions(h);
      if (s === 0) this.rescueDeepPenetrations();
      this.solveWalls(h);
      this.updateVelocities(h);
    }
    for (const b of bodies) {
      // Pressure and skin only act along the ring, so a ring that has crossed itself (a ball
      // spawned inside another, a violent squeeze) cannot undo that alone: re-thread it.
      if (ringTurning(b) !== 1) { untangleRing(b); this.tangles++; }
      b.updateDerived();
    }
    this.stepMs = performance.now() - t0;
  }

  integrate(h) {
    for (const b of this.bodies) {
      b.touching = false;
      const gx = b.held ? 0 : this.gravityX * h;
      const gy = b.held ? 0 : this.gravityY * h;
      const n = b.n, x = b.x, y = b.y, px = b.px, py = b.py, vx = b.vx, vy = b.vy;
      for (let i = 0; i < n; i++) {
        vx[i] += gx; vy[i] += gy;
        px[i] = x[i]; py[i] = y[i];
        x[i] += vx[i] * h; y[i] += vy[i] * h;
      }
    }
  }

  solveSkin(b, h, reverse) {
    const n = b.n, x = b.x, y = b.y, w = b.w;
    const L = b.restLen * b.scale * b.skinBoost;
    const alpha = (L / b.skinK) / (h * h);
    const denom = 2 * w + alpha;
    // Sweeping the ring in one fixed direction biases Gauss-Seidel toward a slow spin,
    // so the sweep direction alternates every substep.
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k;
      const j = i + 1 === n ? 0 : i + 1;
      const dx = x[j] - x[i], dy = y[j] - y[i];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) continue;
      const lambda = -(d - L) / denom;
      const cx = w * lambda * dx / d, cy = w * lambda * dy / d;
      x[i] -= cx; y[i] -= cy;
      x[j] += cx; y[j] += cy;
    }
  }

  solveArea(b, h) {
    const n = b.n, x = b.x, y = b.y, gx = b.gx, gy = b.gy, w = b.w;
    let area = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const k = i === 0 ? n - 1 : i - 1;
      area += x[i] * y[j] - x[j] * y[i];
      const g0 = 0.5 * (y[j] - y[k]), g1 = 0.5 * (x[k] - x[j]);
      gx[i] = g0; gy[i] = g1;
      sum += g0 * g0 + g1 * g1;
    }
    area *= 0.5;
    // Compliant area constraint = gas pressure: p = bulk * (target - area) / restArea. Like a real
    // gas it stiffens as it is squeezed (bulk ~ 1 / fill^2): a full-power hit can flatten a ball
    // hard, but never into a line, where its ring would fold over and stay crushed.
    const P = CFG.phys;
    const rest = b.restArea * b.scale * b.scale;
    const target = rest * b.areaBoost;
    const fill = Math.max(0.15, area / rest);
    const alpha = (rest / P.bulk) * fill * fill / (h * h);
    // Damping on the rate of area change (XPBD damping), so a ball does not keep "breathing".
    let rate = 0;
    for (let i = 0; i < n; i++) rate += gx[i] * (x[i] - b.px[i]) + gy[i] * (y[i] - b.py[i]);
    const gamma = P.gasDamping / h;
    const lambda = -(area - target + gamma * rate) / ((1 + gamma) * w * sum + alpha);
    const k = w * lambda;
    for (let i = 0; i < n; i++) { x[i] += k * gx[i]; y[i] += k * gy[i]; }
  }

  solveShape(b) {
    const squeezed = b.held && b.squash > 0;
    const k = squeezed ? CFG.launch.squashGrip : CFG.phys.shapeStiffness * (b.held ? 3 : 1);
    const n = b.n, x = b.x, y = b.y, qx = b.qx, qy = b.qy, s = b.scale;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
    cx /= n; cy /= n;
    let dot = 0, cross = 0;
    for (let i = 0; i < n; i++) {
      const px = x[i] - cx, py = y[i] - cy;
      dot += qx[i] * px + qy[i] * py;
      cross += qx[i] * py - qy[i] * px;
    }
    const ang = Math.atan2(cross, dot);
    b.angle = ang;
    if (k <= 0) return;
    const c = Math.cos(ang) * s, sn = Math.sin(ang) * s;
    // A ball held in the launcher while aiming is pressed flat along the shot direction (area
    // kept): M = a^-1/2 along d plus a^1/2 across it, applied to the rotated rest shape.
    let m11 = 1, m12 = 0, m22 = 1;
    if (squeezed) {
      const a = 1 + b.squash, dx = b.squashX, dy = b.squashY;
      const along = 1 / Math.sqrt(a), across = Math.sqrt(a);
      m11 = along * dx * dx + across * dy * dy;
      m12 = (along - across) * dx * dy;
      m22 = along * dy * dy + across * dx * dx;
    }
    for (let i = 0; i < n; i++) {
      const rx = qx[i] * c - qy[i] * sn, ry = qx[i] * sn + qy[i] * c;
      const gx = cx + m11 * rx + m12 * ry;
      const gy = cy + m12 * rx + m22 * ry;
      x[i] += (gx - x[i]) * k;
      y[i] += (gy - y[i]) * k;
    }
  }

  // A soft ring hit hard can fold over itself, and a folded ring snags its neighbours.
  // Keep every edge's triangle with the centroid above a minimum area: the ring stays
  // star-shaped around its centre, which still allows heavy squashing but never folding.
  solveNoFold(b) {
    const n = b.n, x = b.x, y = b.y;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
    cx /= n; cy /= n;
    const s = b.scale;
    const minA = 0.5 * b.r * b.r * Math.sin(TAU / n) * s * s * 0.12;
    let sx = 0, sy = 0, fixed = false;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = x[i] - cx, ay = y[i] - cy, bx = x[j] - cx, by = y[j] - cy;
      const area = 0.5 * (ax * by - bx * ay);
      if (area >= minA) continue;
      // Gradients of the triangle area w.r.t. both edge particles (centroid held fixed).
      const g0x = 0.5 * by, g0y = -0.5 * bx, g1x = -0.5 * ay, g1y = 0.5 * ax;
      const den = g0x * g0x + g0y * g0y + g1x * g1x + g1y * g1y;
      if (den < 1e-12) continue;
      const k = (minA - area) / den;
      x[i] += k * g0x; y[i] += k * g0y;
      x[j] += k * g1x; y[j] += k * g1y;
      sx += k * (g0x + g1x); sy += k * (g0y + g1y);
      fixed = true;
    }
    if (!fixed) return;
    // Keep the correction momentum-neutral.
    sx /= n; sy /= n;
    for (let i = 0; i < n; i++) { x[i] -= sx; y[i] -= sy; }
  }

  cellOf(x, y) {
    let cx = Math.floor((x - this.gx0) / this.cs);
    let cy = Math.floor((y - this.gy0) / this.cs);
    if (cx < 0) cx = 0; else if (cx >= this.gw) cx = this.gw - 1;
    if (cy < 0) cy = 0; else if (cy >= this.gh) cy = this.gh - 1;
    return cy * this.gw + cx;
  }

  buildGrid() {
    const bodies = this.bodies, cs = this.cs, gx0 = this.gx0, gy0 = this.gy0;
    const gw = this.gw, gh = this.gh;
    const pad = CFG.phys.thickness * 2;
    const count = this.cellCount;
    count.fill(0);
    let total = 0;
    for (let bi = 0; bi < bodies.length; bi++) {
      const b = bodies[bi], n = b.n, x = b.x, y = b.y;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const dx = x[j] - x[i], dy = y[j] - y[i];
        const len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
        b.nx[i] = dy / len; b.ny[i] = -dx / len;
        const x0 = Math.max(0, Math.floor((Math.min(x[i], x[j]) - pad - gx0) / cs));
        const x1 = Math.min(gw - 1, Math.floor((Math.max(x[i], x[j]) + pad - gx0) / cs));
        const y0 = Math.max(0, Math.floor((Math.min(y[i], y[j]) - pad - gy0) / cs));
        const y1 = Math.min(gh - 1, Math.floor((Math.max(y[i], y[j]) + pad - gy0) / cs));
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) { count[cy * gw + cx]++; total++; }
      }
    }
    const start = this.cellStart;
    start[0] = 0;
    for (let c = 0; c < count.length; c++) start[c + 1] = start[c] + count[c];
    if (this.entries.length < total) this.entries = new Int32Array(total * 2);
    const entries = this.entries;
    count.fill(0);
    for (let bi = 0; bi < bodies.length; bi++) {
      const b = bodies[bi], n = b.n, x = b.x, y = b.y;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const x0 = Math.max(0, Math.floor((Math.min(x[i], x[j]) - pad - gx0) / cs));
        const x1 = Math.min(gw - 1, Math.floor((Math.max(x[i], x[j]) + pad - gx0) / cs));
        const y0 = Math.max(0, Math.floor((Math.min(y[i], y[j]) - pad - gy0) / cs));
        const y1 = Math.min(gh - 1, Math.floor((Math.max(y[i], y[j]) + pad - gy0) / cs));
        const code = (bi << 10) | i;
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
          const c = cy * gw + cx;
          entries[start[c] + count[c]++] = code;
        }
      }
    }
  }

  solveCollisions(h) {
    const bodies = this.bodies, entries = this.entries, start = this.cellStart;
    const cd = CFG.phys.thickness * 2;
    const cand = this.candBody, candE = this.candEdge, candT = this.candT, candD2 = this.candD2;
    const reach2 = (cd * 2) * (cd * 2);
    for (let ai = 0; ai < bodies.length; ai++) {
      const A = bodies[ai], n = A.n, ax = A.x, ay = A.y;
      for (let i = 0; i < n; i++) {
        const c = this.cellOf(ax[i], ay[i]);
        const e0 = start[c], e1 = start[c + 1];
        if (e0 === e1) continue;
        let nc = 0;
        const x0 = ax[i], y0 = ay[i];
        for (let e = e0; e < e1; e++) {
          const code = entries[e];
          const bi = code >> 10;
          if (bi === ai) continue;
          const B = bodies[bi];
          const j = code & 1023;
          const j1 = j + 1 === B.n ? 0 : j + 1;
          const sx = B.x[j], sy = B.y[j];
          const ex = B.x[j1] - sx, ey = B.y[j1] - sy;
          const len2 = ex * ex + ey * ey;
          let t = len2 > 1e-12 ? ((x0 - sx) * ex + (y0 - sy) * ey) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const dx = x0 - (sx + ex * t), dy = y0 - (sy + ey * t);
          const d2 = dx * dx + dy * dy;
          if (d2 > reach2) continue;
          let k = 0;
          while (k < nc && cand[k] !== bi) k++;
          if (k === nc) {
            if (nc === 8) continue;
            cand[k] = bi; candD2[k] = Infinity; nc++;
          }
          if (d2 < candD2[k]) { candD2[k] = d2; candE[k] = j; candT[k] = t; }
        }
        for (let k = 0; k < nc; k++) this.resolveContact(A, i, bodies[cand[k]], candE[k], candT[k], cd, h);
      }
    }
  }

  // The grid only reports edges within reach of a particle, so a particle that ends up
  // deep inside another ring (violent squeeze, spawn on top of a ball) would never be
  // pushed out and the two rings would interlock. Once per frame, find such particles with
  // a point-in-polygon test and move them out radially from the other ball's centre, so
  // both balls end up on their own side of a shared interface. The previous position moves
  // by the same amount: this is an error correction and must not inject velocity.
  rescueDeepPenetrations() {
    const bodies = this.bodies, cd = CFG.phys.thickness * 2;
    for (const b of bodies) {
      let cx = 0, cy = 0;
      for (let i = 0; i < b.n; i++) { cx += b.x[i]; cy += b.y[i]; }
      b.rcx = cx / b.n; b.rcy = cy / b.n;
    }
    for (let ai = 0; ai < bodies.length; ai++) {
      const A = bodies[ai];
      for (let bi = 0; bi < bodies.length; bi++) {
        if (bi === ai) continue;
        const B = bodies[bi];
        if (A.maxX < B.minX || A.minX > B.maxX || A.maxY < B.minY || A.minY > B.maxY) continue;
        for (let i = 0; i < A.n; i++) {
          const x = A.x[i], y = A.y[i];
          if (x < B.minX || x > B.maxX || y < B.minY || y > B.maxY) continue;
          if (!pointInRing(B, x, y)) continue;
          let ux = x - B.rcx, uy = y - B.rcy;
          const ul = Math.sqrt(ux * ux + uy * uy);
          if (ul < 1e-6) { ux = 0; uy = -1; } else { ux /= ul; uy /= ul; }
          const t = rayFarHit(B.rcx, B.rcy, ux, uy, B);
          if (t < 0) continue;
          const dx = B.rcx + ux * (t + cd) - x, dy = B.rcy + uy * (t + cd) - y;
          A.x[i] += dx; A.y[i] += dy;
          A.px[i] += dx; A.py[i] += dy;
        }
      }
    }
  }

  resolveContact(A, i, B, j, t, cd, h) {
    const n = B.n;
    const j1 = j + 1 === n ? 0 : j + 1;
    const sx = B.x[j], sy = B.y[j], ex = B.x[j1] - sx, ey = B.y[j1] - sy;
    const dx = A.x[i] - (sx + ex * t), dy = A.y[i] - (sy + ey * t);
    const dist = Math.sqrt(dx * dx + dy * dy);
    let nX, nY, sd;
    if (t > 1e-6 && t < 1 - 1e-6) {
      nX = B.nx[j]; nY = B.ny[j];
      sd = dx * nX + dy * nY;
    } else {
      // Closest feature is a vertex: decide inside/outside with its pseudo-normal.
      const v = t <= 1e-6 ? j : j1;
      const prev = v === 0 ? n - 1 : v - 1;
      let pnX = B.nx[prev] + B.nx[v], pnY = B.ny[prev] + B.ny[v];
      const pl = Math.sqrt(pnX * pnX + pnY * pnY) || 1;
      pnX /= pl; pnY /= pl;
      const side = dx * pnX + dy * pnY;
      if (side >= 0 && dist > 1e-9) { sd = dist; nX = dx / dist; nY = dy / dist; }
      else { sd = -dist; nX = pnX; nY = pnY; }
    }
    if (sd >= cd) return;
    const pen = cd - sd;
    A.touching = true; B.touching = true;
    const wp = A.w, wB = B.w;
    const wa = wB * (1 - t), wb = wB * t;
    const wsum = wp + (1 - t) * wa + t * wb;
    const lam = pen / wsum;
    A.x[i] += wp * lam * nX; A.y[i] += wp * lam * nY;
    B.x[j] -= wa * lam * nX; B.y[j] -= wa * lam * nY;
    B.x[j1] -= wb * lam * nX; B.y[j1] -= wb * lam * nY;

    // Relative motion over this substep, for friction and impact strength.
    const rdx = (A.x[i] - A.px[i]) - ((1 - t) * (B.x[j] - B.px[j]) + t * (B.x[j1] - B.px[j1]));
    const rdy = (A.y[i] - A.py[i]) - ((1 - t) * (B.y[j] - B.py[j]) + t * (B.y[j1] - B.py[j1]));
    const dn = rdx * nX + rdy * nY;
    const tx = rdx - dn * nX, ty = rdy - dn * nY;
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > 1e-9) {
      const P = CFG.phys;
      const f = tl < P.frictionStatic * pen ? 1 : Math.min(1, P.frictionDynamic * pen / tl);
      const lt = f / wsum;
      A.x[i] -= wp * lt * tx; A.y[i] -= wp * lt * ty;
      B.x[j] += wa * lt * tx; B.y[j] += wa * lt * ty;
      B.x[j1] += wb * lt * tx; B.y[j1] += wb * lt * ty;
    }

    // Bookkeeping: contacts, impacts and merge candidates.
    const lo = A.id < B.id ? A : B, hi = lo === A ? B : A;
    const key = lo.id * 4194304 + hi.id;
    this.contactKeys.add(key);
    const approach = (-(A.vx[i] - B.vx[j]) * nX - (A.vy[i] - B.vy[j]) * nY);
    const prevImpact = this.impacts.get(key);
    if (!prevImpact) this.impacts.set(key, { a: lo, b: hi, speed: approach, x: A.x[i], y: A.y[i] });
    else if (approach > prevImpact.speed) { prevImpact.speed = approach; prevImpact.x = A.x[i]; prevImpact.y = A.y[i]; }
    if (A.level === B.level && !this.mergeKeys.has(key) && this.canMerge(A, B)) {
      this.mergeKeys.add(key);
      this.mergePairs.push([lo, hi, A.x[i], A.y[i]]);
    }
  }

  solveWalls(h) {
    const P = CFG.phys, W = CFG.world.w, H = CFG.world.h;
    const th = P.thickness;
    const L = th, R = W - th, T = th, B = H - th;
    const rb = CFG.tank.cornerBottom, rt = CFG.tank.cornerTop;
    const mu = P.wallFriction;
    for (const b of this.bodies) {
      const n = b.n, x = b.x, y = b.y, px = b.px, py = b.py;
      for (let i = 0; i < n; i++) {
        let xi = x[i], yi = y[i];
        let pen = 0, nX = 0, nY = 0;
        if (yi > H - rb && (xi < rb || xi > W - rb)) {
          // Rounded bottom corners.
          const ccx = xi < rb ? rb : W - rb, ccy = H - rb;
          const dx = xi - ccx, dy = yi - ccy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const lim = rb - th;
          if (d > lim) { pen = d - lim; nX = -dx / d; nY = -dy / d; }
        } else if (yi < rt && (xi < rt || xi > W - rt)) {
          const ccx = xi < rt ? rt : W - rt, ccy = rt;
          const dx = xi - ccx, dy = yi - ccy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const lim = rt - th;
          if (d > lim) { pen = d - lim; nX = -dx / d; nY = -dy / d; }
        } else {
          if (xi < L) { pen = L - xi; nX = 1; nY = 0; }
          else if (xi > R) { pen = xi - R; nX = -1; nY = 0; }
          if (yi > B) { const p2 = yi - B; if (p2 > pen) { pen = p2; nX = 0; nY = -1; } }
          else if (yi < T) { const p2 = T - yi; if (p2 > pen) { pen = p2; nX = 0; nY = 1; } }
        }
        if (pen <= 0) continue;
        b.touching = true;
        xi += nX * pen; yi += nY * pen;
        // Friction against the static wall.
        const dx = xi - px[i], dy = yi - py[i];
        const dn = dx * nX + dy * nY;
        const tx = dx - dn * nX, ty = dy - dn * nY;
        const tl = Math.sqrt(tx * tx + ty * ty);
        if (tl > 1e-9) {
          const f = Math.min(1, mu * pen / tl);
          xi -= tx * f; yi -= ty * f;
        }
        const approach = -(b.vx[i] * nX + b.vy[i] * nY);
        if (approach > 220) this.wallImpacts.push({ body: b, speed: approach, x: xi, y: yi });
        x[i] = xi; y[i] = yi;
      }
    }
  }

  updateVelocities(h) {
    const P = CFG.phys;
    const inv = 1 / h;
    const drag = Math.max(0, 1 - P.linearDrag * h);
    const vmax = P.maxSpeed;
    for (const b of this.bodies) {
      const kd = Math.min(1, (b.touching ? P.contactDeformDamping : P.deformDamping) * h);
      const n = b.n, x = b.x, y = b.y, px = b.px, py = b.py, vx = b.vx, vy = b.vy;
      let cx = 0, cy = 0, mvx = 0, mvy = 0;
      for (let i = 0; i < n; i++) {
        const v0 = (x[i] - px[i]) * inv, v1 = (y[i] - py[i]) * inv;
        vx[i] = v0; vy[i] = v1;
        cx += x[i]; cy += y[i]; mvx += v0; mvy += v1;
      }
      cx /= n; cy /= n; mvx /= n; mvy /= n;
      let L = 0, I = 0;
      for (let i = 0; i < n; i++) {
        const rx = x[i] - cx, ry = y[i] - cy;
        L += rx * vy[i] - ry * vx[i];
        I += rx * rx + ry * ry;
      }
      const om = I > 1e-9 ? L / I : 0;
      let hx = 0, hy = 0;
      if (b.held) {
        // Damped spring that keeps a launcher ball hovering at its anchor.
        hx = (420 * (b.ax - cx) - 26 * mvx) * h;
        hy = (420 * (b.ay - cy) - 26 * mvy) * h;
      }
      // Resting contact loses energy to skin flexing: damp spin and drift while touching.
      const kr = b.touching ? Math.min(1, P.rollingDamping * h) : 0;
      const kc = b.touching ? Math.min(1, P.contactDrag * h) : 0;
      for (let i = 0; i < n; i++) {
        const rx = x[i] - cx, ry = y[i] - cy;
        const rvx = mvx - om * ry, rvy = mvy + om * rx;
        let v0 = vx[i] + (rvx - vx[i]) * kd;
        let v1 = vy[i] + (rvy - vy[i]) * kd;
        v0 += om * ry * kr - mvx * kc;
        v1 -= om * rx * kr + mvy * kc;
        v0 = v0 * drag + hx; v1 = v1 * drag + hy;
        const sp = v0 * v0 + v1 * v1;
        if (sp > vmax * vmax) { const f = vmax / Math.sqrt(sp); v0 *= f; v1 *= f; }
        vx[i] = v0; vy[i] = v1;
      }
    }
  }

  // ---- Merging ---------------------------------------------------------------------

  // Builds a new ball one level up. Preferred: its first outline is the union of a and b,
  // so the merge starts exactly where the two balls were and then contracts. If that outline
  // is not clean (odd squashed shapes, a neighbour in the way), the larger ball's skin is
  // resampled instead and inflates to the new size.
  mergeInto(a, b, level, contactX, contactY) {
    const areaA = Math.abs(a.area), areaB = Math.abs(b.area);
    const tot = areaA + areaB || 1;
    let cx = (a.cx * areaA + b.cx * areaB) / tot;
    let cy = (a.cy * areaA + b.cy * areaB) / tot;
    // The rays need an origin inside one of the parents, not in the seam between them: a ray
    // running along the seam finds nothing and cuts a slit into the outline. Step from the
    // pair's centroid toward the larger parent's centre until inside it.
    if (!pointInRing(a, cx, cy) && !pointInRing(b, cx, cy)) {
      const big = areaA >= areaB ? a : b;
      let found = false;
      for (let t = 0.15; t < 1.01 && !found; t += 0.15) {
        const x = cx + (big.cx - cx) * t, y = cy + (big.cy - cy) * t;
        if (pointInRing(big, x, y)) { cx = x; cy = y; found = true; }
      }
      if (!found && contactX !== undefined) { cx = contactX; cy = contactY; }
    }
    const others = this.bodies.filter(o => o !== a && o !== b && !o.dead);
    let body = this.unionOutline(a, b, level, cx, cy, others, tot);
    if (body) {
      body.mergedBy = 'union';
    } else {
      body = this.survivorOutline(a, b, level);
      body.mergedBy = 'grow';
    }
    const mA = a.mass, mB = b.mass;
    body.setVelocity((a.vcx * mA + b.vcx * mB) / (mA + mB), (a.vcy * mA + b.vcy * mB) / (mA + mB));
    body.updateDerived();
    return body;
  }

  survivorOutline(a, b, level) {
    const s = Math.abs(a.area) >= Math.abs(b.area) ? a : b;
    const body = new SoftBody(level, s.cx, s.cy);
    resampleRing(s, body);
    body.absorbed = s === a ? b : a;
    const s0 = Math.sqrt(Math.abs(s.area) / body.restArea);
    body.animateScale(Math.max(0.5, Math.min(1, s0)), 1, CFG.merge.shrinkTime * 1.2);
    body.fitSkinToRing();
    return body;
  }

  // Returns null when the union outline would be degenerate or overlap a neighbour.
  unionOutline(a, b, level, cx, cy, others, parentArea) {
    const body = new SoftBody(level, cx, cy);
    const n = body.n;
    const cd = CFG.phys.thickness * 2;
    const dist = new Float64Array(n);
    const inA = pointInRing(a, cx, cy), inB = pointInRing(b, cx, cy);
    const iv = [];
    for (let k = 0; k < n; k++) {
      const ang = TAU * k / n;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      // Walk outward through the parts of a and b the ray covers, bridging only the thin
      // skin gap between them. Jumping a wider gap could swallow a third ball sitting there.
      iv.length = 0;
      rayIntervals(cx, cy, dx, dy, a, inA, iv);
      rayIntervals(cx, cy, dx, dy, b, inB, iv);
      iv.sort((p, q) => p[0] - q[0]);
      let end = -1;
      for (const [s, e] of iv) {
        if (end < 0) { if (s <= cd * 2.5) end = e; else break; }
        else if (s <= end + cd * 2.5) end = Math.max(end, e);
        else break;
      }
      // Never reach into a neighbour.
      for (const o of others) {
        const t = rayNearHit(cx, cy, dx, dy, o);
        if (t >= 0 && t < end + cd) end = Math.max(cd, t - cd);
      }
      dist[k] = end;
    }
    fillGaps(dist, body.r);
    closeWedges(dist, 2);
    // Interpolated rays skipped the neighbour check above: pull back any point that ended up
    // inside a neighbour (unless the merge centre itself sits inside it).
    for (const o of others) {
      if (pointInRing(o, cx, cy)) continue;
      for (let k = 0; k < n; k++) {
        const ang = TAU * k / n;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const px = cx + dx * dist[k], py = cy + dy * dist[k];
        if (px < o.minX - cd || px > o.maxX + cd || py < o.minY - cd || py > o.maxY + cd) continue;
        const t = rayNearHit(cx, cy, dx, dy, o);
        if (t >= 0 && t < dist[k] + cd) dist[k] = Math.max(cd, t - cd);
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      const ang = TAU * k / n;
      const x = cx + Math.cos(ang) * dist[k], y = cy + Math.sin(ang) * dist[k];
      body.x[k] = body.px[k] = x;
      body.y[k] = body.py[k] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    let unionArea = 0;
    for (let k = 0; k < n; k++) {
      const j = k + 1 === n ? 0 : k + 1;
      unionArea += body.x[k] * body.y[j] - body.x[j] * body.y[k];
    }
    unionArea *= 0.5;
    if (unionArea < parentArea * 0.75 || unionArea > parentArea * 1.6) return null;
    // Validate against neighbours: none of our points inside them, and at most a few of
    // theirs inside us (those get pushed out below).
    const engulfed = [];
    for (const o of others) {
      if (o.maxX < minX || o.minX > maxX || o.maxY < minY || o.minY > maxY) continue;
      for (let k = 0; k < n; k++) if (pointInRing(o, body.x[k], body.y[k])) return null;
      for (let i = 0; i < o.n; i++) if (pointInRing(body, o.x[i], o.y[i])) engulfed.push(o, i);
    }
    if (engulfed.length > 12) return null;
    for (let e = 0; e < engulfed.length; e += 2) {
      const o = engulfed[e], i = engulfed[e + 1];
      let ux = o.x[i] - cx, uy = o.y[i] - cy;
      const ul = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= ul; uy /= ul;
      const t = Math.max(ul, rayFarHit(cx, cy, ux, uy, body));
      o.x[i] = o.px[i] = cx + ux * (t + cd);
      o.y[i] = o.py[i] = cy + uy * (t + cd);
    }
    // Even spacing along the outline: the rays bunch points on round lobes and leave long gaps
    // across the waist, and uneven skin segments would twist as they contract.
    resampleRing({ n, x: Float64Array.from(body.x), y: Float64Array.from(body.y) }, body);
    const s0 = Math.sqrt(unionArea / body.restArea);
    body.animateScale(Math.max(1, Math.min(1.6, s0)), 1, CFG.merge.shrinkTime);
    body.fitSkinToRing();
    return body;
  }

  // Outward impulse on every ball near (x, y): used for merge shock waves and power-ups.
  impulse(x, y, radius, strength, except) {
    for (const b of this.bodies) {
      if (b === except || b.held) continue;
      const dx = b.cx - x, dy = b.cy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const reach = radius + b.r;
      if (d > reach || d < 1e-6) continue;
      const f = strength * (1 - d / reach);
      const ix = dx / d * f, iy = dy / d * f;
      for (let i = 0; i < b.n; i++) { b.vx[i] += ix; b.vy[i] += iy; }
    }
  }
}

// Places dst's particles evenly (by arc length) along src's current outline.
function resampleRing(src, dst) {
  const n = src.n, m = dst.n;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    cum[i + 1] = cum[i] + Math.hypot(src.x[j] - src.x[i], src.y[j] - src.y[i]);
  }
  const per = cum[n] || 1;
  let seg = 0;
  for (let k = 0; k < m; k++) {
    const target = per * k / m;
    while (seg < n - 1 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    const i1 = seg + 1 === n ? 0 : seg + 1;
    dst.x[k] = dst.px[k] = src.x[seg] + (src.x[i1] - src.x[seg]) * t;
    dst.y[k] = dst.py[k] = src.y[seg] + (src.y[i1] - src.y[seg]) * t;
  }
}

// Repairs a self-crossing ring without moving anything: the same particles (with their
// velocities) are re-threaded in order of angle around the centroid. The ball keeps its place,
// footprint and momentum, and its skin no longer crosses itself.
function untangleRing(b) {
  const n = b.n, x = b.x, y = b.y;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
  cx /= n; cy /= n;
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) ang[i] = Math.atan2(y[i] - cy, x[i] - cx);
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => ang[p] - ang[q]);
  for (const arr of [b.x, b.y, b.vx, b.vy, b.px, b.py]) {
    const copy = Float64Array.from(arr);
    for (let k = 0; k < n; k++) arr[k] = copy[order[k]];
  }
}

// Turning number of the ring (sum of exterior angles / 2pi): 1 for any simple ring, however
// dented; anything else means the ring crosses itself.
function ringTurning(b) {
  const n = b.n, x = b.x, y = b.y;
  let turn = 0, ex = x[0] - x[n - 1], ey = y[0] - y[n - 1];
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const fx = x[j] - x[i], fy = y[j] - y[i];
    turn += Math.atan2(ex * fy - ey * fx, ex * fx + ey * fy);
    ex = fx; ey = fy;
  }
  return Math.round(turn / TAU);
}

function pointInRing(b, px, py) {
  let inside = false;
  const n = b.n, x = b.x, y = b.y;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if ((y[i] > py) !== (y[j] > py) && px < (x[j] - x[i]) * (py - y[i]) / (y[j] - y[i]) + x[i]) inside = !inside;
  }
  return inside;
}

function rayFarHit(ox, oy, dx, dy, b) {
  let best = -1;
  const n = b.n, x = b.x, y = b.y;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ex = x[j] - x[i], ey = y[j] - y[i];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = x[i] - ox, wy = y[i] - oy;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t >= 0 && u >= 0 && u <= 1 && t > best) best = t;
  }
  return best;
}

function rayNearHit(ox, oy, dx, dy, b) {
  let best = -1;
  const n = b.n, x = b.x, y = b.y;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ex = x[j] - x[i], ey = y[j] - y[i];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = x[i] - ox, wy = y[i] - oy;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t >= 0 && u >= 0 && u <= 1 && (best < 0 || t < best)) best = t;
  }
  return best;
}

// Appends the [enter, exit] stretches of a ray that lie inside ring b.
function rayIntervals(ox, oy, dx, dy, b, startsInside, out) {
  const ts = [];
  const n = b.n, x = b.x, y = b.y;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ex = x[j] - x[i], ey = y[j] - y[i];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = x[i] - ox, wy = y[i] - oy;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t >= 0 && u >= 0 && u < 1) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  let k = 0;
  if (startsInside) { out.push([0, ts.length ? ts[0] : 0]); k = 1; }
  for (; k + 1 < ts.length; k += 2) out.push([ts[k], ts[k + 1]]);
}

// Morphological closing of the outline's radius around the circle: fills slits up to about
// 2w + 1 rays wide (rays that slipped along a seam) and leaves wider features alone.
function closeWedges(dist, w) {
  const n = dist.length, hi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let m = 0;
    for (let d = -w; d <= w; d++) m = Math.max(m, dist[(k + d + n) % n]);
    hi[k] = m;
  }
  for (let k = 0; k < n; k++) {
    let m = Infinity;
    for (let d = -w; d <= w; d++) m = Math.min(m, hi[(k + d + n) % n]);
    if (m > dist[k]) dist[k] = m;
  }
}

// Rays that missed both shapes get a distance interpolated from their neighbours.
function fillGaps(dist, fallback) {
  const n = dist.length;
  let any = false;
  for (let k = 0; k < n; k++) if (dist[k] > 0) { any = true; break; }
  if (!any) { dist.fill(fallback); return; }
  for (let k = 0; k < n; k++) {
    if (dist[k] > 0) continue;
    let l = k, r = k, dl = 0, dr = 0;
    do { l = (l - 1 + n) % n; dl++; } while (dist[l] <= 0);
    do { r = (r + 1) % n; dr++; } while (dist[r] <= 0);
    dist[k] = (dist[l] * dr + dist[r] * dl) / (dl + dr);
  }
}
