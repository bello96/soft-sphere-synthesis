'use strict';
// All tunable numbers live here. World units are "tank pixels": the tank is 600 x 900,
// y grows downward, gravity points to +y.

const CFG = {
  // world.h is adapted to the screen at start-up (see fitWorldHeight).
  world: { w: 600, h: 900, margin: 18, minH: 860, maxH: 1060 },
  tank: { cornerBottom: 96, cornerTop: 40 },
  launcher: { x: 300, y: 100 },
  dangerY: 198,

  // radius(level) = r0 * growth^(level-1); level 1 = value 2.
  // growth 1.135 means each merge makes a ball ~1.29x bigger in area (the merged
  // ball is smaller than the two it came from, so merging frees room).
  size: { r0: 32, growth: 1.135 },

  phys: {
    substeps: 10,
    gravity: 240,             // low gravity: ~0.25 tank heights / s^2, close to the reference
    density: 0.001,
    // Skin tension T for a ball of radius r: T0 * (r / r0)^tensionExp. Laplace pressure is
    // T / r, so an exponent below 1 leaves small balls firmer and lets big ones flow like foam.
    tension0: 330,
    tensionExp: 0.9,
    areaCompliance: 0.0004,   // ~incompressible water inside the skin
    shapeStiffness: 0.001,    // weak pull back toward a round rest shape
    linearDrag: 0.12,         // air drag, 1/s
    deformDamping: 3.2,       // damps wobble relative to rigid motion, 1/s
    rollingDamping: 4.5,      // spin damping while touching something (rolling resistance), 1/s
    contactDrag: 1.4,         // translation damping while touching something, 1/s
    frictionStatic: 0.55,
    frictionDynamic: 0.32,
    wallFriction: 0.35,
    thickness: 3,             // skin half-thickness; contact distance = 2x
    spacing: 10.5,            // target distance between skin particles
    minParticles: 16,
    maxParticles: 110,
    cellSize: 24,
    maxSpeed: 2600,
  },

  launch: {
    minSpeed: 160,
    maxSpeed: 1120,
    maxDrag: 250,      // world units of drag for full power
    deadZone: 26,      // releasing inside this radius cancels the shot
    stretch: 0.2,      // front of the ball leaves faster than the back
    reload: 0.42,      // seconds before the next ball inflates in the launcher
  },

  merge: {
    cooldown: 0.32,    // a freshly merged ball waits this long before merging again
    shrinkTime: 0.2,   // union shape contracts to the new size over this time
    pop: 70,           // upward kick given to a merged ball
    shock: 140,        // outward push given to neighbours
    flashTime: 0.75,
  },

  game: {
    dangerGrace: 1.1,  // a launched ball is ignored by the danger line for this long
    dangerLimit: 3.2,  // seconds above the line before the round ends
    comboWindow: 1.6,
    shakeCharges: 3,
    mergesPerCharge: 12,
  },
};

// Balloon colours per level. Levels past the list reuse it as striped "beach balls".
const PALETTE = [
  null,
  { base: '#ff6f61', name: 'coral' },        // 2
  { base: '#ffa94d', name: 'tangerine' },    // 4
  { base: '#ffd43b', name: 'lemon' },        // 8
  { base: '#94d82d', name: 'lime' },         // 16
  { base: '#38d9a9', name: 'mint' },         // 32
  { base: '#4dabf7', name: 'sky' },          // 64
  { base: '#7b8cff', name: 'periwinkle' },   // 128
  { base: '#b98cff', name: 'lavender' },     // 256
  { base: '#f783ac', name: 'bubblegum' },    // 512
  { base: '#e64980', name: 'raspberry' },    // 1024
  { base: '#ff8a3d', stripe: '#fff4e0', name: 'beach-orange' },   // 2048
  { base: '#20c997', stripe: '#fff4e0', name: 'beach-teal' },     // 4096
  { base: '#5c7cfa', stripe: '#fff4e0', name: 'beach-blue' },     // 8192
  { base: '#cc5de8', stripe: '#fff4e0', name: 'beach-violet' },   // 16384
  { base: '#fa5252', stripe: '#fff4e0', name: 'beach-red' },      // 32768
  { base: '#fab005', stripe: '#fff4e0', name: 'beach-gold' },     // 65536
  { base: '#15aabf', stripe: '#fff4e0', name: 'beach-cyan' },     // 131072
];

function paletteFor(level) {
  if (level < PALETTE.length) return PALETTE[level];
  return PALETTE[11 + ((level - 11) % (PALETTE.length - 11))];
}

function radiusForLevel(level) {
  return CFG.size.r0 * Math.pow(CFG.size.growth, level - 1);
}

// Tall phone screens get a taller tank instead of empty space above and below it.
function fitWorldHeight(availW, availH) {
  const W = CFG.world;
  const h = Math.round((W.w + W.margin * 2) * availH / Math.max(1, availW)) - W.margin * 2;
  W.h = Math.max(W.minH, Math.min(W.maxH, h));
}
