'use strict';
// 見本のメール9通を本物の Gemini で振り分け、結果を out/results.json に残して確かめる
const fs = require('fs');
const path = require('path');
const { load, data } = require('./load-code');

const { triageInquiry } = load();
const faq = data('faq.json');
const mails = data('inquiries.json');

// 見本ごとに期待する振り分け（これを満たさなければ NG）
const expect = {
  M1: { status: 'draft', level: 1, faq: ['F01', 'F02'] },
  M2: { status: 'draft', level: 1, faq: ['F03'] },
  M3: { status: 'draft', level: 2, faq: ['F06'] },
  M4: { status: 'draft', level: 2, faq: ['F05'] },
  M5: { status: 'escalate', level: 3 },
  M6: { status: 'no_faq' },
  M7: { status: 'sales' },
  M8: { status: 'spam' },
  M9: { kind: 'inquiry' }, // 法人の見積依頼は営業ではなくお客様の問い合わせ
};

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) fails++; };
const results = {};
const GAP = parseInt(process.env.GAP_MS || '0', 10); // 無料枠の1分あたりの回数に当たらないよう、1通ごとに間を空ける
for (const m of mails) {
  if (GAP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, GAP);
  const t0 = Date.now();
  const r = triageInquiry(m, faq);
  r.ms = Date.now() - t0;
  results[m.id] = r;
  const e = expect[m.id];
  if (r.status === 'ai_error') { console.log(`[${m.id}] AI応答なし: ${r.reason}`); fails++; continue; }
  console.log(`\n[${m.id}] ${m.subject} → ${r.kind}（AI ${r.aiKind}） L${r.level}（AI L${r.aiLevel}・${r.model}）${r.status} ${r.category} / ${r.reason} / ${r.ms}ms`);
  console.log('  候補:', r.candidates.map((c) => `${c.id}:${c.score}`).join(' '), ' 使用:', r.usedFaq.map((f) => f.id).join(','));
  if (r.reply) console.log('  ' + r.reply.replace(/\n/g, '\n  '));
  if (e.status) ok(r.status === e.status, `${m.id} 状態 ${e.status}`);
  if (e.kind) ok(r.kind === e.kind, `${m.id} 種類 ${e.kind}`);
  if (e.level) ok(r.level === e.level, `${m.id} レベル ${e.level}`);
  if (e.faq) ok(e.faq.every((id) => r.usedFaq.some((f) => f.id === id)), `${m.id} FAQ ${e.faq.join(',')} を使う`);
  if (r.status !== 'draft') ok(r.reply === '', `${m.id} 返信案を作らない`);
}

fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'out', 'results.json'), JSON.stringify(results, null, 1));
console.log(`\n${fails ? 'NG ' + fails + '件' : 'すべて OK'}`);
process.exit(fails ? 1 : 0);
