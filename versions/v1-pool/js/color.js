'use strict';
// Small colour helpers. Colours are cached per level because the renderer asks every frame.

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgbStr(c, alpha = 1) {
  return alpha >= 1
    ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
}

const WHITE = [255, 255, 255];
const DEEP = [4, 30, 52];
const levelColorCache = new Map();

function levelColors(level) {
  let c = levelColorCache.get(level);
  if (c) return c;
  const pal = paletteFor(level);
  const base = hexToRgb(pal.base);
  c = {
    base,
    light: mixRgb(base, WHITE, 0.5),
    soft: mixRgb(base, WHITE, 0.25),
    dark: mixRgb(base, DEEP, 0.3),
    rim: mixRgb(base, DEEP, 0.42),
    ink: mixRgb(base, DEEP, 0.55),
    stripe: pal.stripe ? hexToRgb(pal.stripe) : null,
  };
  levelColorCache.set(level, c);
  return c;
}
