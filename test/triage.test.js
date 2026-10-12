'use strict';
// gas/Code.gs の振り分けの決まりを、AI を呼ばずに確かめる。
// UrlFetchApp を差し替え、埋め込みと AI の答えをテストごとに決めて返す。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, data } = require('../harness/load-code');

const faq = data('faq.json');
const idx = (id) => faq.findIndex((f) => f.id === id);

// FAQ i 番目の埋め込みは i 番目だけ 1 のベクトルにする。
// 問い合わせの埋め込みは weights（{F01: 0.8, ...}）で決めるので、FAQ との近さ（コサイン）がそのまま weights の値になる。
function queryVector(weights) {
  const v = new Array(faq.length).fill(0);
  let rest = 1;
  for (const [id, w] of Object.entries(weights)) { v[idx(id)] = w; rest -= w * w; }
  if (rest < -1e-9) throw new Error('weights の2乗の和は1以下にする');
  v.push(Math.sqrt(Math.max(0, rest))); // 長さを 1 に揃えるための余りの成分
  return v;
}
const docVector = (i) => { const v = new Array(faq.length + 1).fill(0); v[i] = 1; return v; };

const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const aiText = (text) => res(200, { candidates: [{ content: { parts: [{ text }] } }] });
const aiJson = (out) => aiText(JSON.stringify(out));

/**
 * AI の答え（generateContent への応答）を順に返す偽の UrlFetchApp を作り、Code.gs を読み込む。
 * answers の要素は、応答そのもの（res(...)）か、AI が返す JSON のオブジェクト。
 */
function setup({ weights = {}, answers = [], key = 'test-key' } = {}) {
  const calls = { embed: 0, generate: [], sleeps: [], prompts: [] };
  const queue = answers.slice();
  const fetch = (url, opt) => {
    const payload = JSON.parse(opt.payload);
    if (url.includes(':batchEmbedContents')) {
      calls.embed++;
      const embeddings = payload.requests.map((r, i) => ({
        values: r.taskType === 'RETRIEVAL_DOCUMENT' ? docVector(i) : queryVector(weights),
      }));
      return res(200, { embeddings });
    }
    if (url.includes(':generateContent')) {
      calls.generate.push(url.match(/models\/([^:]+):/)[1]);
      calls.prompts.push(payload.contents[0].parts[0].text);
      const next = queue.shift();
      if (!next) throw new Error('想定より多く AI が呼ばれました');
      return typeof next.getResponseCode === 'function' ? next : aiJson(next);
    }
    throw new Error('想定していない URL: ' + url);
  };
  const code = load({ key, fetch, sleep: (ms) => calls.sleeps.push(ms) });
  // vm の中で作られた配列・オブジェクトは別の世界のものなので、比べる前に JSON で通常の値にする
  const triage = (mail) => JSON.parse(JSON.stringify(code.triageInquiry(mail, faq)));
  return { code, triage, calls };
}

const mail = (subject, body) => ({ name: 'テスト', from: 'test@example.jp', subject, body });
const answer = (o) => Object.assign({ kind: 'inquiry', level: 1, category: '使い方', reason: '使い方の質問',
  already_tried: [], used_faq: [], reply: '' }, o);

test('FAQ 検索: 近さが 0.71 未満の FAQ は候補に入れない', () => {
  const { code } = setup({ weights: { F01: 0.8, F02: 0.6 } });
  const hits = code.searchFaq(faq, '葉からどのくらい離す？');
  assert.deepEqual(hits.map((h) => h.id), ['F01']);
});

test('FAQ 検索: 近い順に最大4件、FAQ の埋め込みは1回だけ作る', () => {
  const { code, calls } = setup({ weights: { F03: 0.45, F01: 0.5, F02: 0.42, F04: 0.41, F05: 0.4 } });
  const hits = code.searchFaq(faq, 'x', 4, 0.3);
  assert.deepEqual(hits.map((h) => h.id), ['F01', 'F03', 'F02', 'F04']);
  code.searchFaq(faq, 'y', 4, 0.3);
  assert.equal(calls.embed, 3); // FAQ 1回 + 問い合わせ 2回
});

test('FAQ で答えられる問い合わせは返信案を残す', () => {
  const { triage } = setup({ weights: { F01: 0.75, F02: 0.65 },
    answers: [answer({ used_faq: ['F01', 'F02'], reply: 'お問い合わせありがとうございます。\n20〜40cm離してください。' })] });
  const r = triage(mail('モンステラに使いたい', 'どのくらい離せばいいですか。'));
  assert.equal(r.status, 'draft');
  assert.equal(r.level, 1);
  assert.deepEqual(r.usedFaq.map((f) => f.id), ['F01']);
  assert.match(r.reply, /^お問い合わせありがとうございます。/);
});

test('AI が渡していない FAQ を使ったと答えたら、その FAQ は認めず返信案を作らない', () => {
  const { triage } = setup({ weights: { F01: 0.9 },
    answers: [answer({ used_faq: ['F08'], reply: '保証期間は1年です。' })] });
  const r = triage(mail('保証について', '保証はありますか。'));
  assert.equal(r.status, 'no_faq');
  assert.deepEqual(r.usedFaq, []);
  assert.equal(r.reply, '');
});

test('FAQ に答えが無いと AI が答えたら、返信案を作らない', () => {
  const { triage } = setup({ weights: {}, answers: [answer({ category: 'その他', used_faq: [], reply: '' })] });
  const r = triage(mail('吊り下げて使えますか', '金具は付いていますか。'));
  assert.equal(r.status, 'no_faq');
  assert.equal(r.reply, '');
});

test('レベル3は担当者へ回し、AI が返信案を書いていても消す', () => {
  const { triage } = setup({ weights: { F10: 0.8 },
    answers: [answer({ level: 3, category: '安全', used_faq: ['F10'], reply: '使い続けて大丈夫です。' })] });
  const r = triage(mail('熱い', '本体がとても熱いです。'));
  assert.equal(r.status, 'escalate');
  assert.equal(r.reply, '');
  assert.deepEqual(r.candidates.map((c) => c.id), ['F10']);
});

test('事故につながる言葉があれば、AI がレベル1と答えてもレベル3に上げる', () => {
  const { triage } = setup({ weights: { F10: 0.8 },
    answers: [answer({ level: 1, used_faq: ['F10'], reply: 'お問い合わせありがとうございます。' })] });
  const r = triage(mail('においがします', '焦げたようなにおいがして、煙も少し出ました。'));
  assert.equal(r.aiLevel, 1);
  assert.equal(r.level, 3);
  assert.equal(r.status, 'escalate');
  assert.deepEqual(r.raisedBy, ['煙', '焦げ']);
  assert.equal(r.reply, '');
});

test('事故につながる言葉があれば、AI が迷惑メールと答えても問い合わせとして扱う', () => {
  const { triage } = setup({ weights: {}, answers: [answer({ kind: 'spam', level: 1, reason: '不審' })] });
  const r = triage(mail('至急', 'ライトから発火しました。'));
  assert.equal(r.aiKind, 'spam');
  assert.equal(r.kind, 'inquiry');
  assert.equal(r.level, 3);
  assert.equal(r.status, 'escalate');
});

for (const kind of ['sales', 'spam']) {
  test(`${kind} は理由だけ残し、返信案もレベルも付けない`, () => {
    const { triage } = setup({ weights: { F04: 0.8 },
      answers: [answer({ kind, level: 2, reason: '見分けた理由', used_faq: ['F04'], reply: 'ご提案ありがとうございます。' })] });
    const r = triage(mail('ご提案', '広告運用の改善をご提案します。'));
    assert.equal(r.status, kind);
    assert.equal(r.kind, kind);
    assert.equal(r.level, null);
    assert.equal(r.reply, '');
    assert.deepEqual(r.usedFaq, []);
    assert.equal(r.reason, '見分けた理由');
  });
}

test('種類が決まった3つ以外なら、問い合わせとして扱う', () => {
  const { triage } = setup({ weights: { F01: 0.9 },
    answers: [answer({ kind: 'newsletter', used_faq: ['F01'], reply: 'お問い合わせありがとうございます。' })] });
  assert.equal(triage(mail('a', 'b')).kind, 'inquiry');
});

for (const [given, expected] of [[7, 3], [0, 3], [-1, 1], ['2', 2], ['abc', 3], [null, 3]]) {
  test(`レベル ${JSON.stringify(given)} は ${expected} として扱う（範囲外は丸め、読めなければ高いほう）`, () => {
    const { triage } = setup({ weights: {}, answers: [answer({ level: given })] });
    assert.equal(triage(mail('a', 'b')).level, expected);
  });
}

test('AI の答えが JSON として読めないときは止めずに「AIの応答なし」にする', () => {
  const { triage } = setup({ weights: {}, answers: [aiText('すみません、うまく答えられません')] });
  const r = triage(mail('a', 'b'));
  assert.equal(r.status, 'ai_error');
  assert.equal(r.reply, '');
});

for (const [label, out] of [
  ['used_faq が配列でない', answer({ used_faq: 'F01', reply: 'お問い合わせありがとうございます。' })],
  ['already_tried が配列でない', answer({ already_tried: '別のコンセント', used_faq: ['F01'], reply: 'お問い合わせありがとうございます。' })],
  ['答えが null', null],
  ['答えが配列', []],
]) {
  test(`AI の答えの形がおかしいとき（${label}）も例外で止まらない`, () => {
    const { triage } = setup({ weights: { F01: 0.9 }, answers: [out === null ? aiText('null') : out] });
    let r;
    assert.doesNotThrow(() => { r = triage(mail('a', 'b')); });
    assert.ok(Array.isArray(r.usedFaq) && Array.isArray(r.alreadyTried));
    if (r.status === 'draft') assert.deepEqual(r.usedFaq.map((f) => f.id), ['F01']);
    else assert.equal(r.reply, '');
  });
}

test('APIキーが無いときは、AI を呼ばずにその旨を返す', () => {
  const { triage, calls } = setup({ key: '', weights: {}, answers: [] });
  const r = triage(mail('a', 'b'));
  assert.equal(r.status, 'ai_error');
  assert.match(r.reason, /GEMINI_API_KEY/);
  assert.equal(calls.embed, 0);
  assert.equal(calls.generate.length, 0);
});

test('混んでいる（429・503）ときは待って呼び直し、だめなら次のモデルに切り替える', () => {
  const { triage, calls, code } = setup({ weights: { F01: 0.9 },
    answers: [res(429, '{}'), res(503, '{}'), answer({ used_faq: ['F01'], reply: 'お問い合わせありがとうございます。' })] });
  const r = triage(mail('a', 'b'));
  assert.equal(r.status, 'draft');
  assert.equal(calls.generate[0], calls.generate[1]); // 同じモデルで1回呼び直す
  assert.notEqual(calls.generate[2], calls.generate[0]); // そのあと次のモデル
  assert.equal(r.model, calls.generate[2]);
  assert.deepEqual(calls.sleeps, [5000]);
});

test('すべてのモデルが混んでいれば「AIの応答なし」にする', () => {
  const busy = Array.from({ length: 6 }, () => res(429, '{}'));
  const { triage, calls } = setup({ weights: {}, answers: busy });
  const r = triage(mail('a', 'b'));
  assert.equal(r.status, 'ai_error');
  assert.equal(calls.generate.length, 6); // 3モデル × 2回
  assert.equal(new Set(calls.generate).size, 3);
});

test('混雑以外のエラー（400 など）は呼び直さず「AIの応答なし」にする', () => {
  const { triage, calls } = setup({ weights: {}, answers: [res(400, '{"error":{}}')] });
  const r = triage(mail('a', 'b'));
  assert.equal(r.status, 'ai_error');
  assert.equal(calls.generate.length, 1);
  assert.match(r.reason, /400/);
});

test('AI への指示には、検索で選んだ FAQ だけを入れる', () => {
  const { triage, calls } = setup({ weights: { F06: 0.9 }, answers: [answer({})] });
  triage(mail('点かない', '点かなくなりました。'));
  assert.match(calls.prompts[0], /\[F06\] 点灯しないとき/);
  assert.doesNotMatch(calls.prompts[0], /\[F01\]/);
});

test('見本データ: FAQ と問い合わせの id が重ならず、必要な項目がそろっている', () => {
  const mails = data('inquiries.json');
  assert.equal(new Set(faq.map((f) => f.id)).size, faq.length);
  assert.equal(new Set(mails.map((m) => m.id)).size, mails.length);
  for (const f of faq) assert.ok(f.title && f.answer, f.id);
  for (const m of mails) assert.ok(m.subject && m.body && m.from, m.id);
});
