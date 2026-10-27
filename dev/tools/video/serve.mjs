// Tiny static server for the video tools: the pages must read video pixels, which a canvas
// only allows for same-origin (http) media, not file:// URLs. Serves on 127.0.0.1:8765.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = { '/ref/': path.join(here, '../../../ReferenceResources'), '/tools/': here };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.png': 'image/png' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const pre = Object.keys(ROOTS).find(p => url.startsWith(p));
  const file = pre && path.join(ROOTS[pre], url.slice(pre.length));
  if (!file || !file.startsWith(ROOTS[pre])) { res.writeHead(404); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      // Video elements seek with range requests.
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = Number(s), end = e ? Number(e) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
}).listen(8765, '127.0.0.1', () => console.log('video tools on http://127.0.0.1:8765/tools/'));
