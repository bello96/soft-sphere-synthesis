// Minimal Chrome DevTools Protocol driver (no deps, uses Node's global WebSocket).
// Usage: node cdp.mjs <steps.mjs> [args...]
//   steps.mjs exports default async (page, args) => { ... }
// Connects to a headless Chrome on port 9333 (start it with chrome-start.sh).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.CDP_PORT || 9333);

async function getTarget() {
  if (process.env.CDP_NEW) {
    // A private tab, so this run does not collide with another script using the first tab.
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    process.on('exit', () => {});
    globalThis.__closeTarget = () => fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
    return t;
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  let t = list.find(x => x.type === 'page');
  if (!t) t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  return t;
}

export async function connect() {
  const t = await getTarget();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const consoleLog = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { r, j } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result);
    } else if (msg.method) {
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLog.push(`[${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleLog.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      listeners.forEach(f => f(msg));
    }
  };
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id; pending.set(i, { r, j });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const page = {
    send, consoleLog,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    async viewport(width, height, dpr = 1, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    },
    async navigate(url, waitMs = 0) {
      const loaded = new Promise(r => {
        const f = m => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(f), 1); r(); } };
        listeners.push(f);
      });
      await send('Page.navigate', { url });
      await Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]);
      if (waitMs) await page.sleep(waitMs);
    },
    async eval(expr) {
      const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    },
    async waitFor(expr, timeoutMs = 60000, everyMs = 250) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (await page.eval(expr)) return true;
        await page.sleep(everyMs);
      }
      throw new Error('waitFor timeout: ' + expr);
    },
    async shot(file, clip) {
      const res = await send('Page.captureScreenshot', { format: file.endsWith('.png') ? 'png' : 'jpeg', quality: 85, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
      return file;
    },
    // Dispatch a touch-like mouse drag through the input pipeline.
    async drag(x0, y0, x1, y1, steps = 12, holdMs = 30) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await page.sleep(holdMs);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
    },
    close() { ws.close(); },
  };
  return page;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stepsFile = path.resolve(process.argv[2]);
  const mod = await import(pathToFileURL(stepsFile).href);
  const page = await connect();
  try {
    const out = await mod.default(page, process.argv.slice(3));
    if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('STEP ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    if (page.consoleLog.length) console.log('--- console ---\n' + page.consoleLog.slice(-40).join('\n'));
    page.close();
    if (globalThis.__closeTarget) await globalThis.__closeTarget();
  }
}
