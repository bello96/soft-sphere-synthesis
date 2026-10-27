// Prints the "feel" numbers compared against the reference in docs/ANALYSIS.md section 2.3.
// usage: node dev/tools/feel.mjs ['{"phys":{"pressure0":7}}']   (optional config overrides)
import { load, shape, squash } from './lab.mjs';
const ov = process.argv[2] ? JSON.parse(process.argv[2]) : {};

// Mode-2 wobble: project the ring onto cos(2θ); zero crossings give the period, peaks the decay.
function wobble(level) {
  const { PhysicsWorld, SoftBody } = load(ov);
  const w = new PhysicsWorld(); w.gravityY = 0;
  const b = w.add(new SoftBody(level, 300, 450));
  for (let f = 0; f < 30; f++) w.step(1 / 60);
  squash(b, 2.2);
  const mode2 = () => {
    let cx = 0, cy = 0; for (let i = 0; i < b.n; i++) { cx += b.x[i]; cy += b.y[i]; } cx /= b.n; cy /= b.n;
    let c = 0, R = 0;
    for (let i = 0; i < b.n; i++) { const dx = b.x[i] - cx, dy = b.y[i] - cy, r = Math.hypot(dx, dy); c += r * Math.cos(2 * Math.atan2(dy, dx)); R += r; }
    return 2 * c / R;
  };
  const z = [], pk = []; let prev = mode2(), last = Math.abs(prev), rising = false, minA = 9;
  const dt = 1 / 240;
  for (let k = 1; k <= 960; k++) {
    w.step(dt);
    const v = mode2(), av = Math.abs(v);
    minA = Math.min(minA, shape(b).A / b.restArea);
    if ((v > 0) !== (prev > 0)) z.push(k * dt);
    if (av < last && rising) pk.push(last);
    rising = av > last; last = av; prev = v;
  }
  const m = Math.min(z.length - 1, 6);
  return { r: b.r, period: 2 * (z[m] - z[0]) / m, keep: Math.pow(pk[3] / pk[0], 1 / 3), minA };
}

function impact(level, vx, vy) {
  const { PhysicsWorld, SoftBody, radiusForLevel } = load(ov);
  const w = new PhysicsWorld();
  const b = w.add(new SoftBody(level, 600 - radiusForLevel(level) - 30, 300)); b.setVelocity(vx, vy);
  let asp = 0, minA = 9;
  for (let f = 0; f <= 60; f++) { const s = shape(b); asp = Math.max(asp, s.aspect); minA = Math.min(minA, s.A / b.restArea); w.step(1 / 60); }
  return `aspect ${asp.toFixed(2)}, area ${(minA * 100).toFixed(0)}%`;
}

function settle(build) {
  const api = load(ov);
  const w = new api.PhysicsWorld();
  const bodies = build(w, api);
  for (let f = 0; f < 300; f++) w.step(1 / 60);
  return bodies.map(b => shape(b)).map((s, i) => ({ ...s, ratio: s.A / bodies[i].restArea }));
}

const rows = [];
for (const lv of [1, 3, 6, 10, 13]) {
  const r = wobble(lv);
  rows.push([`wobble, level ${lv} (r ${r.r.toFixed(0)})`, `period ${r.period.toFixed(2)} s, keeps ${(r.keep * 100).toFixed(0)}% per half period, area down to ${(r.minA * 100).toFixed(0)}%`]);
}
rows.push(['side-wall hit, level 6, v (300, 480)', impact(6, 300, 480)]);
rows.push(['head-on wall hit, level 6, v 700', impact(6, 700, 0)]);
const [rest] = settle((w, { SoftBody, radiusForLevel }) => [w.add(new SoftBody(6, 300, 900 - radiusForLevel(6) - 10))]);
rows.push(['level 6 resting on the floor', `width/height ${(rest.w / rest.h).toFixed(2)}, area ${(rest.ratio * 100).toFixed(0)}%`]);
const [under] = settle((w, { SoftBody, radiusForLevel }) => {
  const rb = radiusForLevel(6), rt = radiusForLevel(12);
  return [w.add(new SoftBody(6, 300, 900 - rb - 4)), w.add(new SoftBody(12, 300, 900 - 2 * rb - rt - 14))];
});
rows.push(['level 6 under a level 12', `aspect ${under.aspect.toFixed(2)}, area ${(under.ratio * 100).toFixed(0)}%`]);
const pad = Math.max(...rows.map(r => r[0].length));
console.log(rows.map(([k, v]) => k.padEnd(pad) + '  ' + v).join('\n'));
