// 利用者登録ページ（tools/user-hash.html）の検証：ブラウザで作った文字列で実際にログインできるか。
//   node web/build.mjs && NODE_PATH=$(npm root -g) node web/test/user_hash_test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const server = await startServer({ port: 0, seed: false });
const browser = await chromium.launch();
const errors = [];
try {
  for (const vp of [{ width: 360, height: 740, isMobile: true, hasTouch: true }, { width: 1280, height: 800 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()); }); // 誤パスワードの確認で出る 401 は想定内
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective)));
    await page.goto(server.url + '/tools/user-hash.html');
    assert.ok(await page.evaluate((w) => document.documentElement.scrollWidth <= w && innerWidth <= w, vp.width), '横はみ出しなし');

    // 入力チェック
    await page.click('#gen');
    assert.match(await page.textContent('#msg'), /入力内容を確認/);
    // 2人分（1人目は既存登録、2人目を追加）
    await page.fill('.em >> nth=0', 'Taro@Example.com');
    await page.click('.gen-pw >> nth=0');
    await page.click('#add');
    await page.fill('.em >> nth=1', 'hanako@example.com');
    await page.fill('.pwd >> nth=1', 'hanako-password-2026');
    await page.click('#gen');
    await page.waitForFunction(() => /人分の文字列を作りました/.test(document.getElementById('msg').textContent), null, { timeout: 60000 });
    const result = await page.inputValue('#result');
    const taroPw = await page.inputValue('.pwd >> nth=0');
    const entries = result.split(';');
    assert.strictEqual(entries.length, 2);
    assert.match(entries[0], /^taro@example\.com:pbkdf2-sha256:600000:[0-9a-f]{32}:[0-9a-f]{64}$/, '形式（メールは小文字化）');

    // SESSION_SECRET の生成
    await page.click('#makeSecret');
    assert.match(await page.inputValue('#secret'), /^[0-9a-f]{64}$/, 'SESSION_SECRET は64桁の16進数');

    // 生成した値で Netlify Function にログイン
    process.env.EXO_USERS = result;
    const login = (email, password) => page.evaluate(async ([e, p]) => (await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', email: e, password: p }) })).status, [email, password]);
    assert.strictEqual(await login('taro@example.com', taroPw), 200, '自動作成パスワードでログイン');
    assert.strictEqual(await login('hanako@example.com', 'hanako-password-2026'), 200, '手入力パスワードでログイン');
    assert.strictEqual(await login('hanako@example.com', 'wrong-password-0000'), 401, '誤ったパスワードは拒否');

    // 既存の EXO_USERS に追記（同じメールは置き換え）
    await page.fill('#existing', result + ';old@example.com:00:11');
    await page.click('#gen');
    await page.waitForFunction((prev) => document.getElementById('result').value !== prev, result, { timeout: 60000 });
    const merged = (await page.inputValue('#result')).split(';');
    assert.strictEqual(merged.length, 3, '既存1件＋今回2件（重複は置換）');
    assert.ok(merged[0].startsWith('old@example.com:'));
    await ctx.close();
  }
  assert.deepStrictEqual(errors, [], 'ページのエラー・CSP違反なし');
  console.log('USER HASH TOOL TEST PASSED');
} finally {
  await browser.close();
  server.close();
}
