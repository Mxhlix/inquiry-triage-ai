/**
 * 問い合わせの振り分けと返信案（部品）
 *
 * メールを1通受け取り、次の順に処理する。
 *   1. FAQ から意味の近い項目を探す（Gemini の埋め込み）
 *   2. AI（Gemini）が、メールの種類（問い合わせ・営業・迷惑メール）・レベル1〜3・分類・理由・使ったFAQ・返信案を決まった形で返す
 *   3. 営業と迷惑メールは、理由だけ残して返信案を作らない
 *   4. 決めた言葉（煙・焦げ・発火など）があれば、AIの判定にかかわらず問い合わせとして扱い、レベル3に上げる
 *   5. レベル3と、使えるFAQが無いときは返信案を作らない
 *
 * Gmail からの取り込み・下書きの作成・スプレッドシートへの記録は、この部品には入れていない。
 * APIキーはスクリプトのプロパティ GEMINI_API_KEY に置く（コードに書かない）。
 */

// 混んでいて答えないときは、次のモデルに切り替える
var MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];
var THRESHOLD = 0.71; // これより遠いFAQは渡さない

// AIが見落としても、この言葉があればレベル3（担当者へ回す）にする
var LEVEL3_WORDS = ['煙', '焦げ', '発火', '火花', '燃え', '溶け', '感電', 'やけど', '火傷', 'けが', '怪我', '事故'];

// ---- FAQ を探す ----
// 問い合わせとFAQを Gemini の埋め込み（文の意味を数の並びにしたもの）にして、近い順に並べる。
// 「点かなくなった」と「点灯しないとき」のように、言い方が違っても近いと分かる。
var EMBED_MODEL = 'gemini-embedding-001';
var faqVectors_ = null;

function apiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  return key;
}

function embed_(texts, taskType) {
  var key = apiKey_();
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + EMBED_MODEL + ':batchEmbedContents?key=' + encodeURIComponent(key);
  var payload = { requests: texts.map(function (t) {
    return { model: 'models/' + EMBED_MODEL, content: { parts: [{ text: t }] }, taskType: taskType };
  }) };
  var res = fetchWithRetry_(url, payload);
  return JSON.parse(res.getContentText()).embeddings.map(function (e) { return e.values; });
}

function cosine_(a, b) {
  var d = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 近いFAQを最大 topK 件返す。threshold 未満しか無ければ空。FAQの埋め込みは1回だけ作って使い回す。 */
function searchFaq(faq, text, topK, threshold) {
  topK = topK || 4;
  threshold = threshold || THRESHOLD;
  if (!faqVectors_) faqVectors_ = embed_(faq.map(function (f) { return f.title + '\n' + f.answer; }), 'RETRIEVAL_DOCUMENT');
  var q = embed_([text], 'RETRIEVAL_QUERY')[0];
  var scored = faq.map(function (f, i) {
    return { id: f.id, title: f.title, answer: f.answer, score: cosine_(q, faqVectors_[i]) };
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.filter(function (f) { return f.score >= threshold; }).slice(0, topK);
}

// ---- AI への指示 ----
function buildPrompt_(inquiry, hits) {
  var faqText = hits.length
    ? hits.map(function (f) { return '[' + f.id + '] ' + f.title + '\n' + f.answer; }).join('\n\n')
    : '（近いFAQはありません）';
  return [
    'あなたは植物育成ライトのメーカーで、問い合わせ窓口に届いたメールを振り分け、返信案を書く係です。',
    '',
    '# メール',
    '差出人: ' + (inquiry.name || '') + ' <' + (inquiry.from || '') + '>',
    '件名: ' + inquiry.subject,
    '本文:',
    inquiry.body,
    '',
    '# 参照できるFAQ',
    faqText,
    '',
    '# メールの種類の決め方',
    '- inquiry: お客様（個人・法人）からの、当社の商品についての質問・相談・故障の連絡・購入や見積の依頼。',
    '- sales: 当社に商品やサービスを売り込む営業・広告・提携の案内。',
    '- spam: なりすまし、ログインや支払いを急がせるリンク、当選・請求の詐欺、無差別の一斉送信。',
    '- お客様の問い合わせかどうか迷うときは inquiry にする。',
    '- sales と spam のときは、reason に見分けた理由を書き、level は1、used_faq と reply は空にする。',
    '',
    '# レベルの決め方（inquiry のとき）',
    '- レベル1: 使い方・仕様・よくある質問で、故障や交換に関わらないもの。',
    '- レベル2: 故障の可能性（水がかかった、点かないなど）・交換・保証・特殊な使い方。FAQで答えられても、人が確かめてから返す。',
    '- レベル3: 煙・焦げ・発火・けがなど事故につながるおそれ、重大なクレーム、品質問題、会社の判断が要るもの。',
    '- 迷うときは高いほうのレベルにする。',
    '',
    '# 書くもの',
    '- kind: inquiry／sales／spam のどれか。',
    '- level: 1〜3の数字。',
    '- category: 使い方／仕様／故障／交換・保証／安全／購入・見積／その他 のどれか。',
    '- reason: そのレベル（sales と spam はその種類）にした理由。メールの言葉を使って40字以内。',
    '- already_tried: お客様がすでに試したと書いていること。無ければ空の配列。',
    '- used_faq: 返信案で使ったFAQの番号（例 F03）。使ったものだけ。',
    '- reply: 返信案。',
    '',
    '# 返信案の決まり',
    '- 上のFAQに書いてあることだけを使う。FAQに無い数字・期間・対応（交換する、返金する、送料を持つなど）を約束しない。',
    '- FAQで答えられない問い合わせは、used_faq を空、reply を空の文字にする。',
    '- レベル3は reply を空の文字にする。',
    '- レベル2は、担当者が確かめる前提で、お客様に確かめたいこと（購入日、症状など）をたずねる形にする。',
    '- 冒頭は「お問い合わせありがとうございます。」から始める。宛名と署名は書かない（送る担当者が付ける）。',
    '- FAQの文をそのまま全部並べず、問い合わせに合う部分だけを使う。',
    '- 使う部分の手順と数字（秒数・時間・距離など）は省かずに書き、FAQの意味を変えない。',
    '- already_tried に書いたことと、それと同じ目的の確認（別のコンセントを試した人に、プラグの差し込みを確かめてもらう、など）は、返信案で頼まない。',
    '- 問い合わせに購入時期が書かれていれば、それに触れる。',
    '- FAQで答えられない質問（交換できるか、など）には「担当者が確認のうえご連絡します」と書き、可否を答えない。',
    '- 1文ごとに改行する。'
  ].join('\n');
}

function callGemini_(prompt) {
  var key = apiKey_();
  var schema = {
    type: 'OBJECT',
    properties: {
      kind: { type: 'STRING', enum: ['inquiry', 'sales', 'spam'] },
      level: { type: 'INTEGER' },
      category: { type: 'STRING' },
      reason: { type: 'STRING' },
      already_tried: { type: 'ARRAY', items: { type: 'STRING' } },
      used_faq: { type: 'ARRAY', items: { type: 'STRING' } },
      reply: { type: 'STRING' }
    },
    required: ['kind', 'level', 'category', 'reason', 'already_tried', 'used_faq', 'reply'],
    propertyOrdering: ['kind', 'level', 'category', 'reason', 'already_tried', 'used_faq', 'reply']
  };
  var lastError;
  for (var m = 0; m < MODELS.length; m++) {
    var model = MODELS[m];
    var config = { temperature: 0, responseMimeType: 'application/json', responseSchema: schema };
    if (model.indexOf('gemini-3') === 0) config.thinkingConfig = { thinkingLevel: 'low' };
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
    try {
      var res = fetchWithRetry_(url, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: config }, 2);
    } catch (e) {
      lastError = e;
      if (e.busy) continue;
      throw e;
    }
    var data = JSON.parse(res.getContentText());
    var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    var out = JSON.parse(parts.map(function (p) { return p.text || ''; }).join(''));
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('AIの答えの形が想定と違います');
    out.model = model;
    return out;
  }
  throw lastError;
}

// 混んでいるとき（429・503）は、間を空けて3回まで呼び直す
function fetchWithRetry_(url, payload, tries) {
  tries = tries || 4;
  for (var i = 0; i < tries; i++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) return res;
    if (code !== 429 && code !== 503) throw new Error('AIの呼び出しに失敗しました（' + code + '）');
    if (i < tries - 1) Utilities.sleep(5000 * (i + 1));
  }
  var e = new Error('AIが混んでいて応答がありませんでした');
  e.busy = true;
  throw e;
}

/**
 * メール1通を振り分ける。
 * @param {{subject:string, body:string, name?:string, from?:string}} inquiry
 * @param {Array<{id:string,title:string,answer:string}>} faq
 */
function triageInquiry(inquiry, faq) {
  var text = inquiry.subject + '\n' + inquiry.body;
  var hits, out;
  try {
    hits = searchFaq(faq, text);
    out = callGemini_(buildPrompt_(inquiry, hits));
  } catch (e) {
    // AIが応答しないときは止めずに、人が対応する印を付けて次へ進む
    return { kind: '', level: null, aiLevel: null, raisedBy: [], category: '', reason: String(e.message || e),
      alreadyTried: [], status: 'ai_error', usedFaq: [], candidates: [], reply: '' };
  }

  // AIの答えが決まった形から外れても止まらないよう、配列の項目を揃えておく
  var list = function (v) { return Array.isArray(v) ? v.map(String) : []; };

  var found = LEVEL3_WORDS.filter(function (w) { return text.indexOf(w) >= 0; });

  // 営業と迷惑メールは返信案を作らない。ただし事故の言葉があるメールは、見落とさないよう問い合わせとして扱う
  var kind = out.kind === 'sales' || out.kind === 'spam' ? out.kind : 'inquiry';
  var aiKind = kind;
  if (kind !== 'inquiry' && found.length) kind = 'inquiry';
  if (kind !== 'inquiry') {
    return { kind: kind, aiKind: aiKind, level: null, aiLevel: null, raisedBy: [], category: '', reason: out.reason || '',
      alreadyTried: [], model: out.model, status: kind, usedFaq: [], candidates: [], reply: '' };
  }

  var level = Math.min(3, Math.max(1, parseInt(out.level, 10) || 3));
  var aiLevel = level;
  if (found.length && level < 3) level = 3;

  // 使ったFAQは、探して渡したものだけを認める
  var hitIds = hits.map(function (h) { return h.id; });
  var used = list(out.used_faq).filter(function (id) { return hitIds.indexOf(id) >= 0; });
  var reply = String(out.reply || '').trim();

  var status;
  if (level === 3) { status = 'escalate'; reply = ''; }
  else if (!used.length || !reply) { status = 'no_faq'; reply = ''; used = []; }
  else status = 'draft';

  return {
    kind: kind,
    aiKind: aiKind,
    level: level,
    aiLevel: aiLevel,
    raisedBy: level !== aiLevel ? found : [],
    category: out.category || '',
    reason: out.reason || '',
    alreadyTried: list(out.already_tried),
    model: out.model,
    status: status,
    usedFaq: used.map(function (id) { return faq.filter(function (f) { return f.id === id; })[0]; }),
    candidates: hits.map(function (h) { return { id: h.id, title: h.title, score: Math.round(h.score * 100) / 100 }; }),
    reply: reply
  };
}

if (typeof module !== 'undefined') module.exports = { triageInquiry: triageInquiry, searchFaq: searchFaq, LEVEL3_WORDS: LEVEL3_WORDS };
