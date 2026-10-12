'use strict';
// 画面（ui/index.html）を出し、振り分けの依頼を gas/Code.gs の triageInquiry に渡す
//   node harness/server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, data } = require('./load-code');

const PORT = parseInt(process.argv[2] || '8791', 10);
const { triageInquiry } = load();
const faq = data('faq.json');
const mails = data('inquiries.json');

const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html')));
  if (u.pathname === '/api/mails') return send(res, 200, 'application/json', JSON.stringify(mails));
  if (u.pathname === '/api/triage') {
    const m = mails.find((x) => x.id === u.searchParams.get('id'));
    if (!m) return send(res, 404, 'application/json', '{"error":"not found"}');
    const t0 = Date.now();
    const r = triageInquiry(m, faq);
    r.ms = Date.now() - t0;
    console.log(m.id, 'L' + r.level, r.status, r.model || '', r.ms + 'ms');
    return send(res, 200, 'application/json', JSON.stringify(r));
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, () => console.log('http://localhost:' + PORT));
