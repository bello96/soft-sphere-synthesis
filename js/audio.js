'use strict';
// All sounds are synthesised with WebAudio: no audio files.

class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.lastBloop = 0;
    this.bloopsThisFrame = 0;
  }

  // Browsers only allow audio after a user gesture; call this from one.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.7;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      this.noise = this.makeNoise();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.02);
  }

  get ready() { return this.ctx && this.ctx.state === 'running' && !this.muted; }

  makeNoise() {
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  env(gainNode, t, attack, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // Squishy collision: a falling sine "bloop" plus a little filtered noise.
  bloop(radius, strength) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBloop < 0.035) return;
    this.lastBloop = now;
    const vol = Math.min(0.5, 0.05 + strength * 0.45);
    const f0 = 640 * Math.pow(27 / radius, 0.55) * (0.94 + Math.random() * 0.12);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * 1.35, now);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.62, now + 0.14);
    this.env(g, now, 0.006, vol, 0.16);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.2);
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + f0;
    bp.Q.value = 1.2;
    const ng = this.ctx.createGain();
    this.env(ng, now, 0.003, vol * 0.25, 0.06);
    n.connect(bp).connect(ng).connect(this.master);
    n.start(now, Math.random() * 0.3, 0.1);
  }

  // Merge chime: climbs a pentatonic scale with the level so bigger merges sound brighter.
  merge(level, combo) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const scale = [0, 2, 4, 7, 9];
    const step = level - 1 + Math.min(4, combo - 1);
    const semis = scale[step % 5] + 12 * Math.floor(step / 5);
    const f = 392 * Math.pow(2, Math.min(semis, 30) / 12);
    [0, 0.07].forEach((dt, k) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = k === 0 ? 'triangle' : 'sine';
      const fk = f * (k === 0 ? 1 : 1.5);
      o.frequency.setValueAtTime(fk * 0.8, now + dt);
      o.frequency.exponentialRampToValueAtTime(fk, now + dt + 0.05);
      this.env(g, now + dt, 0.008, k === 0 ? 0.32 : 0.22, 0.32);
      o.connect(g).connect(this.master);
      o.start(now + dt); o.stop(now + dt + 0.4);
    });
    // Watery pop.
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.setValueAtTime(600, now);
    hp.frequency.exponentialRampToValueAtTime(2400, now + 0.12);
    hp.Q.value = 3;
    const g = this.ctx.createGain();
    this.env(g, now, 0.004, 0.22, 0.12);
    n.connect(hp).connect(g).connect(this.master);
    n.start(now, 0, 0.2);
  }

  launch(power) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(300, now);
    bp.frequency.exponentialRampToValueAtTime(1200 + power * 1400, now + 0.2);
    const g = this.ctx.createGain();
    this.env(g, now, 0.02, 0.12 + power * 0.25, 0.22);
    n.connect(bp).connect(g).connect(this.master);
    n.start(now, Math.random() * 0.2, 0.3);
    const o = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(220, now);
    o.frequency.exponentialRampToValueAtTime(520 + power * 200, now + 0.09);
    this.env(og, now, 0.005, 0.18, 0.1);
    o.connect(og).connect(this.master);
    o.start(now); o.stop(now + 0.15);
  }

  inflate() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(300, now);
    o.frequency.exponentialRampToValueAtTime(700, now + 0.16);
    this.env(g, now, 0.02, 0.08, 0.14);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.2);
  }

  tick(urgency) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = 660 + urgency * 330;
    this.env(g, now, 0.003, 0.05, 0.06);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.08);
  }

  shake() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (let k = 0; k < 3; k++) {
      const t = now + k * 0.07;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(180 + k * 40, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.12);
      this.env(g, t, 0.01, 0.25, 0.12);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.16);
    }
  }

  gameOver() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    [523, 440, 349, 262].forEach((f, k) => {
      const t = now + k * 0.16;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.94, t + 0.25);
      this.env(g, t, 0.01, 0.25, 0.3);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.35);
    });
  }

  click() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(900, now);
    o.frequency.exponentialRampToValueAtTime(500, now + 0.05);
    this.env(g, now, 0.003, 0.12, 0.05);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.08);
  }
}
