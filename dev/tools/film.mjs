// Deterministic film strip of the real game: steps the real game logic frame by frame and tiles
// the canvas into one image. args: one JSON object
//   { out, w, h, seed, setup (JS, runs with g = game, W = world), settle (frames), act (JS),
//     pre (frames), frames, every (frames between cells), cols, cellW,
//     crop: [x0, y0, x1, y1] world units | cropFromBottom: height, events: [{ k, js }], report (JS) }
const INDEX = new URL('../../index.html', import.meta.url).href;
export default async (page, [json]) => {
  const a = JSON.parse(json);
  await page.viewport(a.w || 430, a.h || 900, 1, (a.w || 430) < 600);
  await page.navigate(a.url || INDEX, 700);
  await page.eval(`document.getElementById('btn-start').click()`);
  await page.eval(`(() => {
    const g = window.__game;
    let seed = ${a.seed || 7};
    Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.reset();
    window.__real = g.update.bind(g);
    g.update = () => {};
    g.showHint = false;
    window.__raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
  if (a.setup) await page.eval(`(() => { const g = window.__game, W = g.world; ${a.setup} })()`);
  await page.eval(`(() => { for (let i = 0; i < ${a.settle || 0}; i++) window.__real(1 / 60); })()`);
  if (a.act) await page.eval(`(() => { const g = window.__game, W = g.world; ${a.act} })()`);
  if (a.pre) await page.eval(`(() => { for (let i = 0; i < ${a.pre}; i++) window.__real(1 / 60); })()`);
  const info = await page.eval(`(() => {
    const cv = document.getElementById('game'), R = window.__renderer, M = CFG.world.margin;
    const H = CFG.world.h, fb = ${a.cropFromBottom || 0};
    const [x0, y0, x1, y1] = fb ? [-M, H - fb, CFG.world.w + M, H + M] : (${JSON.stringify(a.crop || null)} || [-M, -M, CFG.world.w + M, H + M]);
    const sx = (x0 + M) * R.scale, sy = (y0 + M) * R.scale, sw = (x1 - x0) * R.scale, sh = (y1 - y0) * R.scale;
    const cols = ${a.cols || 6}, cellW = ${a.cellW || 200}, cellH = Math.round(cellW * sh / sw), n = ${a.frames || 12};
    const film = document.createElement('canvas');
    film.width = cols * cellW; film.height = Math.ceil(n / cols) * (cellH + 16);
    film.style.cssText = 'position:fixed;left:0;top:0;z-index:99;background:#222';
    window.__film = { film, fg: film.getContext('2d'), cv, sx, sy, sw, sh, cols, cellW, cellH };
    window.__film.fg.fillStyle = '#222'; window.__film.fg.fillRect(0, 0, film.width, film.height);
    return { w: film.width, h: film.height };
  })()`);
  for (let k = 0; k < (a.frames || 12); k++) {
    for (const ev of (a.events || [])) if (ev.k === k) await page.eval(`(() => { const g = window.__game, W = g.world; ${ev.js} })()`);
    if (k > 0) await page.eval(`(() => { for (let i = 0; i < ${a.every || 2}; i++) window.__real(1 / 60); })()`);
    await page.eval(`window.__raf()`);
    await page.eval(`(() => { const F = window.__film, k = ${k};
      const x = (k % F.cols) * F.cellW, y = Math.floor(k / F.cols) * (F.cellH + 16);
      F.fg.drawImage(F.cv, F.sx, F.sy, F.sw, F.sh, x, y + 16, F.cellW, F.cellH);
      F.fg.fillStyle = '#ff0'; F.fg.font = '12px monospace'; F.fg.fillText((k * ${a.every || 2} / 60).toFixed(2) + 's', x + 4, y + 12);
    })()`);
  }
  await page.eval(`document.body.appendChild(window.__film.film)`);
  await page.viewport(info.w, info.h, 1, false);
  await page.sleep(200);
  await page.shot(a.out, { x: 0, y: 0, width: info.w, height: info.h });
  if (a.report) info.report = await page.eval(a.report);
  return info;
};
