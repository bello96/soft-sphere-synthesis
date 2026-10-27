// Headless physics lab: loads the game's config + physics into a VM context (no browser) so
// scenarios can be scripted and measured with the same metrics used on the reference videos.
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.GAME_ROOT || fileURLToPath(new URL('../..', import.meta.url));

export function load(overrides = {}) {
  const ctx = vm.createContext({ console, performance, Math });
  for (const f of ['js/config.js', 'js/physics.js']) vm.runInContext(fs.readFileSync(`${ROOT}/${f}`, 'utf8'), ctx, { filename: f });
  const api = vm.runInContext('({ CFG, PhysicsWorld, SoftBody, radiusForLevel })', ctx);
  deepAssign(api.CFG, overrides);
  return api;
}

function deepAssign(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) deepAssign(dst[k], src[k]);
    else dst[k] = src[k];
  }
}

// Exact polygon moments: area, centroid, aspect ratio of the equivalent ellipse, bounding box.
export function shape(b) {
  const n = b.n, x = b.x, y = b.y;
  let A = 0, cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, cr = x[i] * y[j] - x[j] * y[i];
    A += cr; cx += (x[i] + x[j]) * cr; cy += (y[i] + y[j]) * cr;
    sxx += (x[i] * x[i] + x[i] * x[j] + x[j] * x[j]) * cr;
    syy += (y[i] * y[i] + y[i] * y[j] + y[j] * y[j]) * cr;
    sxy += (x[i] * y[j] + 2 * x[i] * y[i] + 2 * x[j] * y[j] + x[j] * y[i]) * cr;
  }
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  const ixx = sxx / 12 / A - cx * cx, iyy = syy / 12 / A - cy * cy, ixy = sxy / 24 / A - cx * cy;
  const tr = ixx + iyy, det = ixx * iyy - ixy * ixy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  return { A, cx, cy, aspect: Math.sqrt((tr / 2 + disc) / Math.max(1e-9, tr / 2 - disc)),
    w: Math.max(...x) - Math.min(...x), h: Math.max(...y) - Math.min(...y) };
}

// Area-preserving squash of a ball into an ellipse with the given aspect (long along x).
export function squash(b, aspect) {
  const s = Math.sqrt(aspect);
  let cx = 0, cy = 0;
  for (let i = 0; i < b.n; i++) { cx += b.x[i]; cy += b.y[i]; }
  cx /= b.n; cy /= b.n;
  for (let i = 0; i < b.n; i++) {
    b.x[i] = b.px[i] = cx + (b.x[i] - cx) * s;
    b.y[i] = b.py[i] = cy + (b.y[i] - cy) / s;
  }
}
