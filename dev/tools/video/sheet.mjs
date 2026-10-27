// Contact sheet of a reference video (frames tiled into one image). Needs serve.mjs running.
// args: video (file name in ReferenceResources) out.png t0 t1 step cols cellW [cropX cropY cropW cropH]
export default async (page, [video, out, t0, t1, step, cols, cellW, ...crop]) => {
  await page.navigate('http://127.0.0.1:8765/tools/sheet.html', 300);
  const meta = await page.eval(`load('/ref/' + ${JSON.stringify(encodeURIComponent(video))})`);
  const times = [];
  for (let t = Number(t0); t <= Math.min(Number(t1), meta.d - 0.01) + 1e-9; t += Number(step)) times.push(+t.toFixed(3));
  const cr = crop.length === 4 ? crop.map(Number) : null;
  const size = await page.eval(`sheet(${JSON.stringify(times)}, ${cols}, ${cellW}, ${JSON.stringify(cr)})`);
  await page.viewport(size.w, size.h, 1, false);
  await page.sleep(150);
  await page.shot(out, { x: 0, y: 0, width: size.w, height: size.h });
  return { meta, frames: times.length, size };
};
