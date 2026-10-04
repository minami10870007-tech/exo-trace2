// index.html を Chromium で開き、google.script.run をモック環境のコード.gsに中継して画面操作を検証する。
// 実行: NODE_PATH=$(npm root -g) node apps-script/test/ui_test.js [スクリーンショット出力先]
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { createEnv } = require('./mock_env');

(async () => {
  const outDir = process.argv[2] || path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const env = createEnv();
  env.G.setup();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('テスト取消') : d.accept());
  await page.exposeFunction('__gas', (fn, args) => {
    try { return { ok: true, value: JSON.parse(JSON.stringify(env.G[fn](...args) ?? null)) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  await page.addInitScript(() => {
    const runner = (ok, ng) => new Proxy({}, { get: (_, k) => {
      if (k === 'withSuccessHandler') return f => runner(f, ng);
      if (k === 'withFailureHandler') return f => runner(ok, f);
      return (...args) => window.__gas(k, args).then(r => (r.ok ? ok && ok(r.value) : ng && ng(new Error(r.message))));
    } });
    window.google = { script: { run: runner(null, null) } };
  });
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  await page.route('https://exo-trace.test/', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://exo-trace.test/'); // setContent では addInitScript が適用されないため遷移で読み込む
  const idle = () => page.waitForFunction(() => document.getElementById('loading').style.display === 'none');
  const tab = async id => { await page.click('nav button[data-tab="' + id + '"]'); await idle(); };
  await page.waitForSelector('nav button');
  await idle();

  // マスタ登録（画面から）
  await tab('master');
  const saveMaster = async (table, values) => {
    await page.selectOption('#msTable', table);
    await page.click('text=＋ 新規');
    for (const [k, v] of Object.entries(values)) {
      const sel = '#mf_' + k;
      const tag = await page.$eval(sel, e => e.tagName + (e.type || ''));
      if (tag.startsWith('SELECT')) await page.selectOption(sel, v); else await page.fill(sel, String(v));
    }
    await page.click('#msForm button:has-text("保存")');
    await idle();
    assert.match(await page.textContent('#msMsg'), /保存しました/, table + ' 保存');
  };
  await saveMaster('m_supplier', { supplier_code: 'S001', name: '仕入先A' });
  await saveMaster('m_product', { product_code: 'EXO-A', name: 'エクソソーム原液A', storage_class: 'M80', shelf_life_days: 730, regulatory_class: 'COSMETIC_RAW', list_price: 30000 });
  await saveMaster('m_customer', { customer_code: 'C001', name: 'サロンA', customer_type: 'SALON', address: '東京', email: 'a@salon.jp' });
  await page.screenshot({ path: path.join(outDir, '1_master.png'), fullPage: true });

  // 入荷
  await tab('receipt');
  await page.selectOption('#rcSupplier', { label: 'S001 仕入先A' });
  await page.selectOption('#rcProduct', { index: 1 });
  await page.fill('#rcSupLot', 'SUP-LOT-9');
  await page.fill('#rcMfg', '2026-09-01');
  await page.dispatchEvent('#rcMfg', 'change');
  assert.strictEqual(await page.inputValue('#rcExp'), '2028-08-31', '使用期限の自動入力');
  await page.fill('#rcQty', '10');
  await page.fill('#rcPrice', '10000');
  await page.selectOption('#rcLoc', { index: 1 });
  await page.click('text=入荷確定');
  await idle();
  assert.match(await page.textContent('#rcMsg'), /EXO-A-\d{6}-01/, '入荷登録');

  // 検品
  await tab('inspect');
  await page.check('input[id^="coa_"]');
  await page.click('#insBody button:has-text("変更")');
  await idle();
  assert.match(await page.textContent('#insMsg'), /合格/, '検品合格');

  // 出荷
  await tab('shipment');
  await page.selectOption('#shCustomer', { index: 1 });
  await page.selectOption('.slProd', { index: 1 });
  await page.fill('.slQty', '3');
  await page.click('text=出荷確定');
  await idle();
  assert.match(await page.textContent('#shMsg'), /SH-\d{6}-0001/, '出荷確定');
  await page.screenshot({ path: path.join(outDir, '2_shipment.png'), fullPage: true });

  // ロット追跡
  await tab('traceLot');
  await page.fill('#tlQuery', 'sup-lot');
  await page.click('#traceLot button:has-text("検索")');
  await idle();
  const tl = await page.textContent('#tlBody');
  assert.match(tl, /サロンA/, 'ロット追跡に販売先が出る');
  assert.match(tl, /顧客の手元（出荷正味）：3/, '出荷正味');
  await page.screenshot({ path: path.join(outDir, '3_trace.png'), fullPage: true });

  // 回収
  await tab('recall');
  await page.fill('#rcTitle', 'テスト回収');
  await page.selectOption('#rcSev', 'II');
  await page.fill('#rcReason', '規格外');
  await page.selectOption('#rcLots', { index: 0 });
  await page.click('text=回収開始');
  await idle();
  assert.match(await page.textContent('#rclMsg'), /対象顧客 1 件/, '回収登録');
  await page.screenshot({ path: path.join(outDir, '4_recall.png'), fullPage: true });

  // ダッシュボード・在庫・顧客追跡・返品画面が例外なく表示できる
  await tab('dashboard');
  assert.match(await page.textContent('#dashBody'), /対応中の回収/, 'ダッシュボード');
  await tab('inventory');
  assert.match(await page.textContent('#invBody'), /回収/, '在庫照会');
  await tab('traceCustomer');
  await page.selectOption('#tcCustomer', { index: 1 });
  await page.click('#traceCustomer button:has-text("検索")');
  await idle();
  assert.match(await page.textContent('#tcBody'), /EXO-A-/, '顧客追跡');
  await tab('return');
  await page.fill('#rtShipNo', 'SH-202610-0001');
  await page.click('#return button:has-text("検索")');
  await idle();
  await page.click('text=この明細を返品');
  await page.selectOption('#rtQLoc', { index: 1 });
  await page.fill('#rtReason', '回収品');
  await page.click('#rtForm button:has-text("返品登録")');
  await idle();
  assert.match(await page.textContent('#rtMsg'), /回収品として計上/, '回収品返品');

  assert.deepStrictEqual(errors, [], 'ページ上のJavaScriptエラー');
  await browser.close();
  console.log('UI TEST PASSED（スクリーンショット: ' + outDir + '）');
})().catch(e => { console.error(e); process.exit(1); });
