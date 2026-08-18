const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'test/harness.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    const type = file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.css') ? 'text/css'
      : file.endsWith('.png') ? 'image/png'
      : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}).listen(8796, '127.0.0.1', () => console.log('banc d\'essai : http://127.0.0.1:8796/test/harness.html'));
