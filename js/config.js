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
    gravity: 140,             // floaty: matched to the reference relative to ball size
    density: 0.001,
    // Balloon model: a skin that barely stretches, wrapped around gas that can be squeezed.
    // Rest pressure p0 = pressure0 * (r / r0)^pressureExp. The skin carries the matching
    // tension p0 * r, so a ball is taut at rest, wobbles at about 1 Hz and, being unable to
    // grow its perimeter, gives up area when it is pushed out of round.
    pressure0: 6,
    pressureExp: 1.25,
    bulk: 220,                // pressure rise per unit of relative compression (lower = squashier)
    skinStretch: 0.03,        // skin strain at rest; it grows in proportion to the pressure
    gasDamping: 0.02,         // s; damps the "breathing" (area) motion without slowing the wobble much
    shapeStiffness: 0,        // pull toward the round rest shape (0: pressure alone keeps it round)
    linearDrag: 0.12,         // air drag, 1/s
    deformDamping: 0.5,       // wobble damping in flight, 1/s: a launched ball keeps jiggling
    contactDeformDamping: 3,  // wobble damping while touching something, 1/s: piles settle
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
    maxSpeed: 900,
    maxDrag: 250,      // world units of drag for full power
    deadZone: 26,      // releasing inside this radius cancels the shot
    stretch: 0.2,      // front of the ball leaves faster than the back
    squash: 1.2,       // while aiming the ball is pressed flat along the shot: aspect 1 + squash * power
    squashGrip: 0.02,  // how firmly the launcher holds that pressed shape (per substep)
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
  },
};

// Flat balloon colours per level, bright enough to carry a dark number. Up to 1024 they walk
// round the colour wheel; bigger balls get a second, lighter set, ordered so that neighbouring
// values never share a hue. Levels past the list repeat that second set.
const PALETTE = [
  null,
  { base: '#ff5468', name: 'coral' },        // 2
  { base: '#ff9a3c', name: 'orange' },       // 4
  { base: '#ffd93d', name: 'sunflower' },    // 8
  { base: '#9be15d', name: 'lime' },         // 16
  { base: '#2ed39b', name: 'mint' },         // 32
  { base: '#33c7f2', name: 'sky' },          // 64
  { base: '#4d7cff', name: 'blue' },         // 128
  { base: '#9a6bff', name: 'violet' },       // 256
  { base: '#e06bf0', name: 'orchid' },       // 512
  { base: '#ff6fae', name: 'pink' },         // 1024
  { base: '#63e6d2', name: 'aqua' },         // 2048
  { base: '#ffbf5e', name: 'amber' },        // 4096
  { base: '#79a8ff', name: 'cornflower' },   // 8192
  { base: '#cdf065', name: 'chartreuse' },   // 16384
  { base: '#b996ff', name: 'lavender' },     // 32768
  { base: '#ff8a7a', name: 'salmon' },       // 65536
  { base: '#f5f0ff', name: 'pearl' },        // 131072
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
