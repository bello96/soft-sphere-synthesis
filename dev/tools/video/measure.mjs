// Tracks one ball in a reference video: area, size, aspect ratio and centroid per frame.
// Needs serve.mjs running. args: one JSON object
//   { video (file name in ReferenceResources), crop: [x, y, w, h] video px, t0, t1, dt (s),
//     seed: [x, y] a point inside the ball (crop px, off the number), col?: [r, g, b], tol? }
export default async (page, [json]) => {
  const a = JSON.parse(json);
  await page.navigate('http://127.0.0.1:8765/tools/measure.html', 200);
  const meta = await page.eval(`load('/ref/' + ${JSON.stringify(encodeURIComponent(a.video))})`);
  let col = a.col;
  if (!col) col = await page.eval(`sample(${a.t0}, ${JSON.stringify(a.crop)}, ${a.seed[0]}, ${a.seed[1]})`);
  const rows = await page.eval(`track(${a.t0}, ${a.t1}, ${a.dt}, ${JSON.stringify(a.crop)}, ${JSON.stringify(col)}, ${a.tol || 40}, ${JSON.stringify(a.seed)})`);
  const lines = rows.map(r => r.A ? `${r.t.toFixed(3)}  A=${String(r.A).padStart(6)}  w=${String(r.w).padStart(4)} h=${String(r.h).padStart(4)}  aspect=${r.aspect.toFixed(2)} ang=${String(r.angle).padStart(4)}  c=(${r.cx},${r.cy})  Q=${r.Q}` : `${r.t.toFixed(3)}  -`);
  return `meta ${JSON.stringify(meta)} col ${JSON.stringify(col)}\n` + lines.join('\n');
};
