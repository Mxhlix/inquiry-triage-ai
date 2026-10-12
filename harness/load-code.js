'use strict';
// gas/Code.gs を Node の vm でそのまま動かす。GAS の機能のうち、この部品が使う3つだけを用意する。
//   PropertiesService … APIキーを環境変数 GEMINI_API_KEY か、リポジトリ直下の .env から読む
//   UrlFetchApp       … curl で同期的に呼ぶ（GAS の fetch は同期なので形を合わせる）
//   Utilities.sleep   … 同期で待つ
// テストでは load({ key, fetch, sleep }) で3つとも差し替え、通信せずに動かす。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function envKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return '';
  const m = fs.readFileSync(file, 'utf8').match(/^GEMINI_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function curlFetch(url, opt) {
  const out = execFileSync('curl', ['-s', '-X', 'POST', '-H', 'Content-Type: application/json',
    '--data-binary', '@-', '-w', '\n%{http_code}', url], { input: opt.payload, maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  const i = out.lastIndexOf('\n');
  const body = out.slice(0, i), code = parseInt(out.slice(i + 1), 10);
  return { getResponseCode: () => code, getContentText: () => body };
}

const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function load(opts = {}) {
  const key = opts.key !== undefined ? opts.key : envKey();
  const sandbox = {
    module: { exports: {} },
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'GEMINI_API_KEY' ? key : null) }) },
    UrlFetchApp: { fetch: opts.fetch || curlFetch },
    Utilities: { sleep: opts.sleep || blockingSleep },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

const data = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

module.exports = { load, data };
