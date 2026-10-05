// デザイン・レスポンシブの自動レビュー＋操作テスト。
//   node web/build.mjs && NODE_PATH=$(npm root -g) node web/test/review.mjs [出力先]
// 出力: <出力先>/report.json と各画面のスクリーンショット。問題があれば終了コード1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer, DEMO_USER, SECOND_USER, OUTSIDER } from './serve.mjs';
import { psql } from '../../supabase/test/harness.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2] || 'web/test/out';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 740, mobile: true },
  { name: 'phone-390', width: 390, height: 844, mobile: true },
  { name: 'phone-390-dark', width: 390, height: 844, mobile: true, dark: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true },
  { name: 'laptop-1024', width: 1024, height: 768, mobile: false },
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false },
  { name: 'desktop-1440-dark', width: 1440, height: 900, mobile: false, dark: true },
];

// ---------------- ブラウザ内で実行する監査 ----------------
function audit(opts) {
  const issues = [];
  // モバイルではページが広がるとブラウザが縮小表示して innerWidth も広がるため、指定した画面幅で判定する
  const vw = opts.vw;
  if (window.innerWidth > vw + 1) issues.push({ type: 'overflow', detail: `表示領域が ${window.innerWidth}px に広がっている（画面 ${vw}px）` });
  const visible = (el) => {
    if (el.closest('[hidden]') || el.closest('dialog:not([open])')) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const desc = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ' "' + txt + '"' : ''}`;
  };
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
    }
    return false;
  };
  const openDialog = document.querySelector('dialog[open]');
  const scope = openDialog || document;

  // 1) 横はみ出し
  if (document.documentElement.scrollWidth > vw + 1) issues.push({ type: 'overflow', detail: `ページ幅 ${document.documentElement.scrollWidth}px > 画面 ${vw}px` });
  scope.querySelectorAll('body *').forEach((el) => {
    if (!visible(el) || inScroller(el) || el.closest('.sprite')) return;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) issues.push({ type: 'overflow', detail: `${desc(el)} が画面外（${Math.round(r.left)}〜${Math.round(r.right)}px）` });
  });

  // 2) タップ領域・入力文字サイズ（モバイル）
  if (opts.mobile) {
    scope.querySelectorAll('button, a[href], input, select, textarea, summary, [data-action]').forEach((el) => {
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (el.matches('input[type="checkbox"], input[type="radio"]')) {
        const lab = el.closest('label');
        const lr = lab ? lab.getBoundingClientRect() : r;
        if (lr.height < 44 || lr.width < 44) issues.push({ type: 'tap', detail: `${desc(lab || el)} のタップ領域 ${Math.round(lr.width)}×${Math.round(lr.height)}px` });
        return;
      }
      if (el.matches('tr')) return;
      if (r.height < 44 - 0.5 || r.width < 44 - 0.5) issues.push({ type: 'tap', detail: `${desc(el)} のタップ領域 ${Math.round(r.width)}×${Math.round(r.height)}px` });
      if (el.matches('input, select, textarea') && parseFloat(getComputedStyle(el).fontSize) < 16) {
        issues.push({ type: 'input-zoom', detail: `${desc(el)} の文字 ${getComputedStyle(el).fontSize}（16px未満はiOSで拡大される）` });
      }
    });
  }

  // 3) コントラスト（WCAG AA）
  const parse = (c) => {
    let m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; }
    m = c.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] }; }
    return null;
  };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !p.matches('select')) return null; // グラデーション上は判定しない
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (opts.dark) base = parse(getComputedStyle(document.body).backgroundColor) || base;
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const seen = new Set();
  scope.querySelectorAll('body *').forEach((el) => {
    if (!visible(el) || el.closest('svg') || el.closest(':disabled')) return; // 無効化された操作部品は WCAG のコントラスト要件の対象外
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ||
      (el.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea') && (el.value || el.placeholder));
    if (!hasText) return;
    const cs = getComputedStyle(el);
    let fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg || !bg) return;
    if (fg.a < 1) fg = blend(fg, bg);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need - 0.01) {
      const key = desc(el).slice(0, 40) + r.toFixed(2);
      if (!seen.has(key)) { seen.add(key); issues.push({ type: 'contrast', detail: `${desc(el)} コントラスト ${r.toFixed(2)}（必要 ${need}）` }); }
    }
  });

  // 3a) 表の中の横スクロール（列が切れて見落とされる）
  scope.querySelectorAll('.table-wrap').forEach((w) => {
    if (visible(w) && w.scrollWidth > w.clientWidth + 1) issues.push({ type: 'table-scroll', detail: `${desc(w.querySelector('th, td') || w)} を含む表が横スクロール（${w.scrollWidth}px > ${w.clientWidth}px）` });
  });
  // 3c) 枠からはみ出す中身（チェックリスト等）
  scope.querySelectorAll('.check, .card, .stat, .kpi, .target, .lot-card').forEach((el) => {
    if (!visible(el) || getComputedStyle(el).overflowY !== 'visible') return;
    if (el.scrollHeight > el.clientHeight + 2) issues.push({ type: 'content-overflow', detail: `${desc(el)} の中身が枠から ${el.scrollHeight - el.clientHeight}px はみ出す` });
  });
  // 3d) セルの中身が隣のセルへはみ出す（カード表示の2列グリッド等）
  scope.querySelectorAll('.rtable td, .target-grid > *, .form-grid > *, .lot-meta > div, .stat-row > *').forEach((el) => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    el.querySelectorAll('*').forEach((c) => {
      if (!visible(c) || c.closest('svg')) return;
      const cr = c.getBoundingClientRect();
      if (cr.right > r.right + 1.5) issues.push({ type: 'cell-overflow', detail: `${desc(c)} が ${desc(el)} の右端から ${Math.round(cr.right - r.right)}px はみ出す` });
    });
  });
  // 3b) 隣接要素の重なり（負のマージン等による食い込み）
  scope.querySelectorAll('#main *, dialog[open] *').forEach((el) => {
    const next = el.nextElementSibling;
    if (!next || !visible(el) || !visible(next) || el.closest('svg')) return;
    const a = getComputedStyle(el), b = getComputedStyle(next);
    if (!/^(block|grid|flex|table|list-item)$/.test(a.display) || !/^(block|grid|flex|table|list-item)$/.test(b.display)) return;
    if (['absolute', 'fixed', 'sticky'].includes(a.position) || ['absolute', 'fixed', 'sticky'].includes(b.position)) return;
    const pd = getComputedStyle(el.parentElement).display;
    if (pd === 'grid' || pd === 'flex' || pd === 'inline-flex') {
      if (getComputedStyle(el.parentElement).flexDirection === 'row' && pd !== 'grid') return;
    }
    const ra = el.getBoundingClientRect(), rb = next.getBoundingClientRect();
    const horiz = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    if (horiz > 4 && ra.bottom > rb.top + 0.5 && ra.top < rb.top) issues.push({ type: 'overlap', detail: `${desc(el)} と ${desc(next)} が ${Math.round(ra.bottom - rb.top)}px 重なる` });
  });

  // 4) 下部ナビに隠れる内容（モバイル）
  const nav = document.getElementById('bottomNav');
  if (!openDialog && nav && visible(nav)) {
    const main = document.getElementById('main');
    const last = [...main.querySelectorAll('section:not([hidden]) > *')].filter(visible).pop();
    if (last) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const lb = last.getBoundingClientRect().bottom, nt = nav.getBoundingClientRect().top;
      if (lb > nt + 1) issues.push({ type: 'hidden-by-nav', detail: `${desc(last)} が下部ナビに隠れる（${Math.round(lb - nt)}px）` });
      window.scrollTo(0, 0);
    }
  }
  return issues;
}

// ---------------- 実行 ----------------
const server = await startServer({ port: 0 });
const browser = await chromium.launch();
const report = { viewports: {}, flow: [], errors: [] };
let total = 0;

async function newPage(vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1,
    isMobile: vp.mobile && vp.width < 1024, hasTouch: vp.mobile, colorScheme: vp.dark ? 'dark' : 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  // 4xx 応答のリソース読込エラー（入力エラー等の想定内応答）はブラウザが自動出力するため除外
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI)); });
  return { ctx, page, errs };
}
const idle = (page) => page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'), null, { timeout: 15000 });

async function login(page) {
  await page.goto(server.url + '/');
  await page.fill('#loginEmail', DEMO_USER.email);
  await page.fill('#loginPassword', DEMO_USER.password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#app:not([hidden])');
  await idle(page);
}

const SCENES = [
  ['login', null],
  ['dashboard', async (p) => { await p.goto(server.url + '/#/dashboard'); }],
  ['receipt', async (p) => { await p.goto(server.url + '/#/receipt'); await p.selectOption('#rcProduct', { index: 1 }); }],
  ['inspect', async (p) => { await p.goto(server.url + '/#/inspect'); }],
  ['shipment', async (p) => { await p.goto(server.url + '/#/shipment'); }],
  ['return', async (p) => { await p.goto(server.url + '/#/return'); await p.fill('#rtShipNo', 'SH-202610-0003'); await p.click('#rtSearch button'); await idle(p);
    await p.click('[data-action="selectReturnLine"]'); }],
  ['inventory', async (p) => { await p.goto(server.url + '/#/inventory'); }],
  ['traceLot', async (p) => { await p.goto(server.url + '/#/traceLot'); await p.fill('#tlQuery', 'BS-2409'); await p.click('#tlSearch button'); }],
  ['traceCustomer', async (p) => { await p.goto(server.url + '/#/traceCustomer'); await p.selectOption('#tcCustomer', { index: 1 }); await p.click('#tcSearch button'); }],
  ['recall', async (p) => { await p.goto(server.url + '/#/recall'); }],
  ['recall-new', async (p) => { await p.goto(server.url + '/#/recall'); await idle(p); await p.click('#rcNew summary'); }],
  ['master', async (p) => { await p.goto(server.url + '/#/master'); await idle(p); await p.click('#msTabs [data-table="m_product"]'); }],
  ['master-rules', async (p) => { await p.goto(server.url + '/#/master'); await idle(p); await p.click('#msTabs [data-table="rules"]'); }],
  ['master-dialog', async (p) => { await p.goto(server.url + '/#/master'); await idle(p); await p.click('#msTabs [data-table="m_product"]'); await idle(p); await p.click('#msList tr[data-action]'); }],
  ['confirm-dialog', async (p) => { await p.goto(server.url + '/#/shipment'); await idle(p); await p.click('[data-action="cancelShip"]'); }],
  ['guide', async (p) => { await p.goto(server.url + '/#/dashboard'); await idle(p); await p.click('.topbar [data-action="guideOpen"]'); await p.click('#guideNext'); await p.click('#guideNext'); }],
  ['menu-sheet', async (p, vp) => { if (vp.width >= 768) return 'skip'; await p.goto(server.url + '/#/dashboard'); await idle(p); await p.click('#moreBtn'); }],
];

for (const vp of VIEWPORTS) {
  const { ctx, page, errs } = await newPage(vp);
  const res = (report.viewports[vp.name] = {});
  for (const [name, setup] of SCENES) {
    if (name === 'login') {
      await page.goto(server.url + '/');
      await page.waitForSelector('#login:not([hidden])');
    } else {
      if (!(await page.$('#app:not([hidden])'))) await login(page);
      if ((await setup(page, vp)) === 'skip') continue;
      await idle(page);
      await page.waitForTimeout(250);
    }
    const issues = await page.evaluate(audit, { mobile: vp.mobile, dark: !!vp.dark, vw: vp.width });
    await page.screenshot({ path: join(OUT, `${vp.name}__${name}.png`), fullPage: !(await page.$('dialog[open]')) && name !== 'menu-sheet' });
    if (await page.$('dialog[open]')) await page.keyboard.press('Escape');
    if (name === 'menu-sheet') await page.click('[data-action="closeSheet"]');
    res[name] = issues;
    total += issues.length;
  }
  if (errs.length) { report.errors.push({ viewport: vp.name, errs }); total += errs.length; }
  await ctx.close();
}

// ---------------- 操作フロー（スマホ幅） ----------------
{
  const vp = VIEWPORTS[1];
  const { ctx, page, errs } = await newPage(vp);
  const step = async (label, fn) => {
    try { await fn(); report.flow.push({ step: label, ok: true }); }
    catch (e) { report.flow.push({ step: label, ok: false, error: e.message.split('\n')[0], detail: e.message.slice(0, 1200) }); total++; }
  };
  const toastText = () => page.textContent('#toasts');
  const waitText = (sel, re) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout: 15000 });
  let shippedLot = '';
  await step('ログイン', () => login(page));
  await step('下部ナビ→入荷', async () => { await page.click('#bottomNav [data-page="receipt"]'); await page.waitForSelector('#page-receipt:not([hidden])'); });
  await step('入荷登録', async () => {
    await page.selectOption('#rcSupplier', { index: 1 }); await page.selectOption('#rcProduct', { index: 1 });
    await page.fill('#rcSupLot', 'FLOW-001'); await page.fill('#rcMfg', '2026-09-30'); await page.dispatchEvent('#rcMfg', 'change');
    await page.fill('#rcQty', '7'); await page.fill('#rcPrice', '20000');
    if (!(await page.inputValue('#rcLoc'))) await page.selectOption('#rcLoc', { index: 1 });
    await page.click('#receiptForm button[type="submit"]'); await waitText('#rcMsg', /。/);
    const t = await page.textContent('#rcMsg'); if (!/入荷を登録しました/.test(t)) throw new Error(t);
  });
  await step('下部ナビ→検品→合格', async () => {
    await page.click('#bottomNav [data-page="inspect"]'); await idle(page);
    const card = page.locator('.lot-card', { hasText: 'FLOW-001' });
    const btn = card.locator('[data-action="changeStatus"]');
    if (!(await btn.isDisabled())) throw new Error('判定未選択でボタンが押せる');
    await card.locator('select.insTo').selectOption('RELEASED');
    if (!(await btn.isDisabled())) throw new Error('COA未確認でボタンが押せる');
    await card.locator('input[type="checkbox"]').check();
    if ((await btn.textContent()).trim() !== '合格にする') throw new Error('ボタン文言: ' + (await btn.textContent()));
    await btn.click(); await waitText('#insMsg', /合格|。/);
    if (!/「合格」にしました/.test(await page.textContent('#insMsg'))) throw new Error(await page.textContent('#insMsg'));
  });
  await step('出荷（確認ダイアログ）', async () => {
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page);
    const cv = await page.$eval('#shCustomer', (s) => [...s.options].find((o) => o.text.includes('サロン・ド・ルミエール')).value);
    await page.selectOption('#shCustomer', cv);
    await page.selectOption('.slProd', { index: 1 }); await page.fill('.slQty', '2');
    await page.click('#shipForm button[type="submit"]'); await page.click('#dialogOk'); await page.waitForFunction(() => /出荷を確定しました/.test(document.getElementById('shDone').textContent) || document.querySelector('#shMsg .alert-ng'), null, { timeout: 15000 });
    const t = await page.textContent('#shDone'); if (!/出荷を確定しました/.test(t)) throw new Error(await page.textContent('#shMsg'));
    shippedLot = await page.textContent('#shDone .rtable .mono');
  });
  await step('不合格は確認ダイアログを出す', async () => {
    await page.click('#bottomNav [data-page="inspect"]'); await idle(page);
    await page.waitForSelector('#insBody:not(.is-loading) .lot-card select.insTo'); await page.waitForTimeout(400);
    const card = page.locator('#insBody .lot-card', { has: page.locator('select.insTo') }).first();
    await card.locator('select.insTo').selectOption('REJECTED'); await card.locator('input.insReason').fill('テスト');
    await card.locator('[data-action="changeStatus"]').click(); await page.waitForSelector('#dialog[open]');
    if (!/元に戻せません/.test(await page.textContent('#dialogBody'))) throw new Error('確認の文言がない');
    await page.click('#dialogForm [data-action="dialogCancel"]'); await page.waitForFunction(() => !document.getElementById('dialog').open);
  });
  await step('返品：出荷番号が空なら案内・最近の出荷から選べる', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="return"]'); await idle(page);
    await page.click('#rtSearch button[type="submit"]');
    await page.waitForSelector('#rtFindMsg .alert', { timeout: 10000 }).catch(() => { throw new Error('案内が見えない'); });
    await page.click('#rtRecent [data-action="pickReturnShipment"]'); await idle(page);
    if (!(await page.$('#rtShipment [data-action="selectReturnLine"]'))) throw new Error('出荷が表示されない');
  });
  await step('ロット追跡', async () => {
    await page.click('#bottomNav [data-page="traceLot"]'); await page.fill('#tlQuery', shippedLot); await page.click('#tlSearch button'); await idle(page);
    const t = await page.textContent('#tlBody'); if (!/サロン・ド・ルミエール/.test(t)) throw new Error('販売先が表示されない');
  });
  await step('出荷取消（理由入力ダイアログ）', async () => {
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page);
    await page.click('[data-action="cancelShip"]'); await page.fill('#dialogInput', '数量誤り'); await page.click('#dialogOk'); await waitText('#toasts', /取消しました|。/);
    if (!/取消しました/.test(await toastText())) throw new Error('取消トーストなし');
    if (!/取消済み/.test(await page.textContent('#shDone'))) throw new Error('上部の出荷完了表示が取消済みにならない');
  });
  await step('マスタ編集（フルスクリーンダイアログ）', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="master"]'); await idle(page);
    await page.click('#msList tr[data-action]'); await page.fill('#mf_reorder_point', '12');
    await page.click('#masterForm button[value="save"]'); await waitText('#toasts', /保存しました|。/).catch(() => {});
    if (await page.$('#masterDialog[open]')) throw new Error(await page.textContent('#masterMsg'));
  });
  await step('マスタ編集：Enter で保存、変更してキャンセルなら確認', async () => {
    await page.click('#msList tr[data-action]'); await page.fill('#mf_reorder_point', '13'); await page.press('#mf_reorder_point', 'Enter');
    await page.waitForFunction(() => !document.getElementById('masterDialog').open, null, { timeout: 10000 }).catch(() => { throw new Error('Enter で保存されない'); });
    await waitText('#toasts', /保存しました/);
    await page.click('#msList tr[data-action]'); await page.fill('#mf_reorder_point', '14');
    await page.click('#masterForm [data-action="dialogCancel"]'); await page.waitForSelector('#dialog[open]');
    if (!(await page.evaluate(() => document.activeElement.matches('#dialogForm [data-action="dialogCancel"]')))) throw new Error('破棄の確認でキャンセルに初期フォーカスがない');
    await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.getElementById('dialog').open);
    if (!(await page.$('#masterDialog[open]'))) throw new Error('キャンセルしたのに閉じた');
    await page.click('#masterForm [data-action="dialogCancel"]'); await page.click('#dialogOk');
    await page.waitForFunction(() => !document.getElementById('masterDialog').open);
  });
  await step('処分待ちの在庫を廃棄として記録', async () => {
    await page.click('#bottomNav [data-page="dashboard"]'); await idle(page);
    await page.click('#dashKpis [data-preset="dispose"]'); await waitText('#invPreset', /処分待ち/); await idle(page);
    await page.click('#invBody [data-action="openDispose"]'); await page.waitForSelector('#disposeDialog[open]');
    await page.click('#disposeForm button[value="ok"]');
    if (!/未入力の項目があります/.test(await page.textContent('#dpMsg'))) throw new Error('未入力のチェックがない');
    await page.selectOption('#dpKind', 'DISPOSE'); await page.fill('#dpQty', '1'); await page.fill('#dpReason', '回収品のため廃棄');
    await page.click('#disposeForm button[value="ok"]'); await waitText('#invMsg', /廃棄として記録/);
  });
  await step('ロット追跡は開き直すと最新の状態になる', async () => {
    await page.click('#bottomNav [data-page="traceLot"]'); await page.fill('#tlQuery', 'EXL-77812'); await page.click('#tlSearch button[type="submit"]'); await idle(page);
    const before = await page.textContent('#tlBody .as-of');
    await page.waitForTimeout(1100);
    await page.click('#bottomNav [data-page="dashboard"]'); await idle(page);
    await page.click('#bottomNav [data-page="traceLot"]'); await idle(page);
    if (!(await page.$('#tlBody .lot-card'))) throw new Error('結果が消えた');
    if (!/時点/.test(await page.textContent('#tlBody .as-of'))) throw new Error('時点の表示がない');
    void before;
  });
  await step('回収：ある顧客を保存しても、他の顧客の入力中の内容は消えない', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="recall"]'); await idle(page);
    const forms = page.locator('#rclList .target-edit');
    if ((await forms.count()) < 2) return; // 対象顧客が1件しかないデータでは確認しない
    for (const i of [0, 1]) { const d = forms.nth(i); if (!(await d.getAttribute('open'))) await d.locator('summary').click(); }
    await forms.nth(1).locator('input[id^="cr_"]').fill('入力途中のメモ');
    await forms.nth(0).locator('select[id^="cm_"]').selectOption('メール');
    await forms.nth(0).locator('[data-action="saveTarget"]').click(); await waitText('#toasts', /保存しました/); await idle(page);
    const v = await page.locator('#rclList .target-edit').nth(1).locator('input[id^="cr_"]').inputValue();
    if (v !== '入力途中のメモ') throw new Error('他の顧客の入力が消えた: ' + v);
  });
  await step('検品：別のロットを判定しても、他のカードの入力は消えない', async () => {
    await page.click('#bottomNav [data-page="inspect"]'); await idle(page);
    await page.waitForSelector('#insBody:not(.is-loading) .lot-card select.insTo');
    const cards = page.locator('#insBody .lot-card', { has: page.locator('select.insTo') });
    if ((await cards.count()) < 2) return;
    await cards.nth(1).locator('select.insTo').selectOption('HOLD'); await cards.nth(1).locator('input.insReason').fill('外観確認中');
    const keepId = await cards.nth(1).locator('select.insTo').getAttribute('data-id');
    await cards.nth(0).locator('select.insTo').selectOption('HOLD'); await cards.nth(0).locator('input.insReason').fill('テスト保留');
    await cards.nth(0).locator('[data-action="changeStatus"]').click(); await page.click('#dialogOk'); await waitText('#insMsg', /保留/);
    if ((await page.inputValue('#rs_' + keepId)) !== '外観確認中' || (await page.inputValue('#to_' + keepId)) !== 'HOLD') throw new Error('他のカードの入力が消えた');
  });
  await step('「戻る」で画面が変わったら確認ダイアログは閉じて実行されない', async () => {
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page);
    const n = Number(psql(server.sb.db, 'select count(*) from exo.t_shipment'));
    await page.selectOption('#shCustomer', { index: 1 }); await page.selectOption('.slProd', { index: 1 }); await page.fill('.slQty', '1');
    if (!(await page.inputValue('.slPrice'))) await page.fill('.slPrice', '1000');
    await page.click('#shipForm button[type="submit"]'); await page.waitForSelector('#dialog[open]');
    await page.goBack(); await page.waitForFunction(() => !document.getElementById('dialog').open);
    await page.waitForTimeout(500);
    if (Number(psql(server.sb.db, 'select count(*) from exo.t_shipment')) !== n) throw new Error('出荷が登録された');
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page); await page.fill('.slQty', ''); // 後のテストの再読み込みで「離れますか？」を出さないため
  });
  await step('出荷：日付の範囲は確定前に止め、サーバーのエラーは消えずに残る', async () => {
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page);
    await page.selectOption('#shCustomer', { index: 1 }); await page.selectOption('.slProd', { index: 1 }); await page.fill('.slQty', '1');
    if (!(await page.inputValue('.slPrice'))) await page.fill('.slPrice', '1000');
    await page.fill('#shDate', '2030-01-01');
    await page.click('#shipForm button[type="submit"]');
    if (await page.$('#dialog[open]')) throw new Error('範囲外の日付で確認ダイアログが開いた');
    if ((await page.getAttribute('#shDate', 'aria-invalid')) !== 'true') throw new Error('出荷日に印がない');
    await page.fill('#shDate', await page.evaluate(() => S.cfg.today));
    // 他の利用者が先に出荷して在庫が無くなった状態を作る（確定の直前に在庫を0にし、あとで戻す）
    const rows = psql(server.sb.db, "select id || ':' || on_hand_qty from exo.t_inventory where on_hand_qty > 0").split('\n');
    psql(server.sb.db, 'update exo.t_inventory set on_hand_qty = 0');
    try {
      await page.click('#shipForm button[type="submit"]'); await page.click('#dialogOk'); await waitText('#shMsg', /不足/);
      await page.waitForTimeout(1500);
      if (!/不足/.test(await page.textContent('#shMsg'))) throw new Error('サーバーのエラーが消えた');
      if ((await page.getAttribute('#shDate', 'aria-invalid')) === 'true') throw new Error('正しい出荷日に印が付いた');
      if ((await page.getAttribute('.slQty', 'aria-invalid')) !== 'true') throw new Error('数量に印がない');
    } finally {
      for (const r of rows) { const [id, q] = r.split(':'); psql(server.sb.db, `update exo.t_inventory set on_hand_qty = ${q} where id = ${id}`); }
    }
    await page.fill('.slQty', ''); await page.fill('#shNote', '');
  });
  await step('返品：返品可能数を超える数量でもフォームは消えない', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="return"]'); await idle(page);
    await page.fill('#rtShipNo', 'SH-202610-0003'); await page.click('#rtSearch button[type="submit"]'); await idle(page); await page.waitForTimeout(500);
    await page.locator('#rtShipment [data-action="selectReturnLine"]:not([disabled])').first().click();
    await page.fill('#rtQty', '999'); await page.selectOption('#rtQLoc', { index: 1 }).catch(() => {}); await page.fill('#rtReason', 'テスト');
    if (!(await page.inputValue('#rtDisp')) && !(await page.isDisabled('#rtDisp'))) await page.selectOption('#rtDisp', 'DISPOSE');
    await page.click('#rtForm button[type="submit"]');
    if (await page.isHidden('#rtForm')) throw new Error('フォームが消えた');
    if (!/1〜/.test(await page.textContent('#rtMsg'))) throw new Error(await page.textContent('#rtMsg'));
    await page.click('[data-action="cancelReturn"]'); await page.evaluate(() => { document.getElementById('rtReason').value = ''; document.getElementById('rtQty').value = ''; });
  });
  await step('回収管理を見ただけでは「未保存の入力」と判定しない', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="recall"]'); await idle(page);
    if (await page.evaluate(() => hasUnsavedInput())) throw new Error('見ただけで未保存と判定: ' + (await page.evaluate(() => unsavedScreens().join())));
  });
  await step('返品：表示中の出荷から「別の出荷を選ぶ」で一覧に戻れる', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="return"]'); await idle(page);
    if (await page.$('#rtShipment [data-action="newReturn"]')) { await page.click('#rtShipment [data-action="newReturn"]'); await idle(page); }
    if (!(await page.$('#rtRecent [data-action="pickReturnShipment"]'))) throw new Error('最近の出荷が出ない');
  });
  await step('同時編集：回収状況は競合後にもう一度保存でき、マスタは他の人の変更を消さない', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="recall"]'); await idle(page);
    const d = page.locator('#rclList .target-edit').first();
    if (await d.count()) {
      if (!(await d.getAttribute('open'))) await d.locator('summary').click();
      const tid = await d.locator('[data-action="saveTarget"]').getAttribute('data-id');
      await page.selectOption('#cm_' + tid, '訪問');
      psql(server.sb.db, `update exo.t_recall_target set contact_method = '電話', updated_at = now() where id = ${tid}`);
      await page.click(`[data-action="saveTarget"][data-id="${tid}"]`); await waitText('#cre_' + tid, /他の利用者/);
      if ((await page.inputValue('#cm_' + tid)) !== '訪問') throw new Error('自分の入力が消えた');
      await page.click(`[data-action="saveTarget"][data-id="${tid}"]`); await waitText('#toasts', /保存しました/);
      if (psql(server.sb.db, `select contact_method from exo.t_recall_target where id = ${tid}`) !== '訪問') throw new Error('2回目の保存ができない');
    }
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="master"]'); await idle(page);
    await page.click('#msTabs [data-table="m_product"]'); await idle(page);
    await page.click('#msList tr[data-action]');
    const pid = await page.evaluate(() => document.getElementById('masterForm').dataset.id);
    await page.fill('#mf_name', (await page.inputValue('#mf_name')) + '（改）');
    psql(server.sb.db, `update exo.m_product set list_price = 99999, updated_at = now() where id = ${pid}`);
    await page.click('#masterForm button[value="save"]'); await waitText('#masterMsg', /他の利用者が先に更新/);
    if ((await page.inputValue('#mf_list_price')) !== '99999') throw new Error('他の人の変更（標準売価）が取り込まれない');
    await page.click('#masterForm button[value="save"]'); await page.waitForFunction(() => !document.getElementById('masterDialog').open);
    if (psql(server.sb.db, `select list_price::int || '|' || (name like '%（改）') from exo.m_product where id = ${pid}`) !== '99999|true') throw new Error('他の人の変更が消えた');
  });
  await step('作成者がログインユーザーで記録される', async () => {
    const n = psql(server.sb.db, `select count(*) from exo.t_receipt where supplier_lot_no = 'FLOW-001' and created_by = '${DEMO_USER.email}'`);
    if (n !== '1') throw new Error('created_by がログインユーザーでない');
  });
  await step('未ログインの API は 401', async () => {
    const st = await page.evaluate(async ([url, key]) => (await fetch(url + '/rest/v1/rpc/get_masters', { method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' }, body: '{}' })).status, [server.sb.url, server.sb.anonKey]);
    if (st !== 401) throw new Error('status ' + st);
  });
  await step('内部関数・テーブルは API から見えない', async () => {
    const st = await page.evaluate(async ([url, key]) => {
      const s = JSON.parse(localStorage.getItem('exo-trace-auth'));
      const h = { apikey: key, Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' };
      return [(await fetch(url + '/rest/v1/rpc/daily_check', { method: 'POST', headers: h, body: '{}' })).status,
        (await fetch(url + '/rest/v1/t_lot', { headers: h })).status];
    }, [server.sb.url, server.sb.anonKey]);
    if (st.join() !== '404,404') throw new Error('status ' + st);
  });
  await step('アクセストークンの期限切れは自動更新', async () => {
    const before = server.sb.stats.refresh;
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('exo-trace-auth'));
      s.expires_at = Math.floor(Date.now() / 1000) - 10;
      localStorage.setItem('exo-trace-auth', JSON.stringify(s));
    });
    await page.reload(); await page.waitForSelector('#app:not([hidden])'); await idle(page);
    await page.click('[data-action="reload"]'); await waitText('#toasts', /更新しました/);
    if (server.sb.stats.refresh !== before + 1) throw new Error('更新回数 ' + (server.sb.stats.refresh - before) + '（同時に複数回更新していないか）');
    if (await page.$('#login:not([hidden])')) throw new Error('ログアウトされた');
  });
  await step('ログイン期限切れ：入力中の内容を残したまま、再ログインで元の画面へ', async () => {
    await page.click('#bottomNav [data-page="receipt"]'); await idle(page);
    await page.fill('#rcSupLot', 'KEEP-ME');
    // eslint-disable-next-line no-undef
    await page.evaluate(() => {
      S.sess.expires_at = Math.floor(Date.now() / 1000) - 10; S.sess.refresh_token = 'revoked';
      localStorage.setItem('exo-trace-auth', JSON.stringify(S.sess)); // 他のタブにも有効なセッションが無い状態
    });
    await page.click('[data-action="reload"]'); await page.waitForSelector('#login:not([hidden])');
    if (!/元の画面に戻ります/.test(await page.textContent('#loginMsg'))) throw new Error(await page.textContent('#loginMsg'));
    await page.fill('#loginPassword', DEMO_USER.password); await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#app:not([hidden])'); await idle(page);
    if (!(await page.isVisible('#page-receipt')) || (await page.inputValue('#rcSupLot')) !== 'KEEP-ME') throw new Error('入力または画面が戻らない');
    await page.fill('#rcSupLot', '');
  });
  await step('更新できないセッションはログイン画面へ', async () => {
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('exo-trace-auth'));
      s.expires_at = Math.floor(Date.now() / 1000) - 10; s.refresh_token = 'revoked';
      localStorage.setItem('exo-trace-auth', JSON.stringify(s));
    });
    await page.reload(); await page.waitForSelector('#login:not([hidden])');
    const t = await page.textContent('#loginMsg'); if (!/有効期限/.test(t)) throw new Error('メッセージ: ' + t);
    if ((await page.inputValue('#loginEmail')) !== DEMO_USER.email) throw new Error('メールアドレスが入っていない');
    await page.fill('#loginPassword', DEMO_USER.password); await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#app:not([hidden])'); await idle(page);
  });
  await step('ログアウト', async () => { await page.click('#moreBtn'); await page.click('#moreSheet [data-action="logout"]'); await page.waitForSelector('#login:not([hidden])'); });
  await step('パスワード誤り', async () => {
    await page.fill('#loginEmail', DEMO_USER.email); await page.fill('#loginPassword', 'wrong-password');
    await page.click('#loginForm button[type="submit"]'); await waitText('#loginMsg', /。/);
    const t = await page.textContent('#loginMsg'); if (!/正しくありません/.test(t)) throw new Error(t);
  });
  await step('利用者登録されていない人は使えない', async () => {
    await page.fill('#loginEmail', OUTSIDER.email); await page.fill('#loginPassword', OUTSIDER.password);
    await page.click('#loginForm button[type="submit"]'); await page.waitForSelector('#login:not([hidden])');
    await waitText('#loginMsg', /利用権限/);
    if (await page.evaluate(() => JSON.parse(localStorage.getItem('exo-trace-auth') || '{}').refresh_token)) throw new Error('セッションが残っている');
  });
  if (errs.length) { report.errors.push({ viewport: 'flow', errs }); total += errs.length; }
  await ctx.close();
}

// ---------------- はじめてガイド（データが空の新しい環境・初めてログインした人） ----------------
{
  const fresh = await startServer({ port: 0, seed: false, db: 'exo_web_fresh' });
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2], VIEWPORTS[3], VIEWPORTS[5]]) {
    const { ctx, page, errs } = await newPage(vp);
    const res = report.viewports[vp.name];
    const shot = async (name) => {
      await page.waitForTimeout(250);
      res[name] = await page.evaluate(audit, { mobile: vp.mobile, dark: !!vp.dark, vw: vp.width });
      total += res[name].length;
      await page.screenshot({ path: join(OUT, `${vp.name}__${name}.png`), fullPage: !(await page.$('dialog[open]')) });
    };
    fresh.sb.sql(`update exo.app_user set prefs = '{}' where email = '${DEMO_USER.email}'`); // 毎回「初めてログインした人」にする
    await page.goto(fresh.url + '/');
    await page.fill('#loginEmail', DEMO_USER.email); await page.fill('#loginPassword', DEMO_USER.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#guideDialog[open]'); await idle(page);
    await shot('onboarding-welcome');
    await page.click('#guideNext'); await shot('onboarding-step2');
    await page.click('#guideGo'); await idle(page); await shot('onboarding-resume');
    await page.click('[data-action="guideResumeClose"]');
    await page.goto(fresh.url + '/#/dashboard'); await idle(page); await shot('onboarding-dashboard');
    if (errs.length) { report.errors.push({ viewport: vp.name + '-fresh', errs }); total += errs.length; }
    await ctx.close();
  }
  // 操作フロー：ガイドに沿って登録し、完了が反映される
  const { ctx, page, errs } = await newPage(VIEWPORTS[1]);
  const step = async (label, fn) => {
    try { await fn(); report.flow.push({ step: label, ok: true }); }
    catch (e) { report.flow.push({ step: label, ok: false, error: e.message.split('\n')[0], detail: e.message.slice(0, 1200) }); total++; }
  };
  const waitText = (sel, re) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout: 15000 });
  await step('ガイド：初回ログインで自動表示', async () => {
    await page.goto(fresh.url + '/');
    await page.fill('#loginEmail', SECOND_USER.email); await page.fill('#loginPassword', SECOND_USER.password);
    await page.click('#loginForm button[type="submit"]'); await page.waitForSelector('#guideDialog[open]');
    if (!/はじめに/.test(await page.textContent('#guideCount'))) throw new Error(await page.textContent('#guideCount'));
    if (!(await page.isHidden('#guidePrev'))) throw new Error('最初のステップで「戻る」が出ている');
  });
  await step('ガイド：キーボードで前後に移動', async () => {
    await page.keyboard.press('ArrowRight'); await waitText('#guideCount', /準備 1 \/ 7/);
    await page.keyboard.press('ArrowLeft'); await waitText('#guideCount', /はじめに/);
    await page.click('#guideNext');
    if (!/まだ登録がありません/.test(await page.textContent('#guideStatus'))) throw new Error('未完了の表示がない');
  });
  await step('ガイド：画面を開いて登録→「ガイドに戻る」で次のステップへ', async () => {
    await page.click('#guideGo'); await idle(page);
    if (await page.$('#guideDialog[open]')) throw new Error('ガイドが閉じない');
    if ((await page.getAttribute('#msTabs [data-table="m_supplier"]', 'aria-selected')) !== 'true') throw new Error('仕入先タブが開かない');
    await page.click('#msNew'); await page.fill('#mf_supplier_code', 'S100'); await page.fill('#mf_name', 'ガイド仕入先');
    await page.click('#masterForm button[value="save"]'); await waitText('#toasts', /保存しました/);
    await waitText('#guideResume', /完了：仕入先/);
    await page.click('[data-action="guideResume"]'); await page.waitForSelector('#guideDialog[open]');
    await waitText('#guideCount', /準備 2 \/ 7/);
    if (!/完了しました。次は「商品を登録する」/.test(await page.textContent('#guideStatus'))) throw new Error('完了の表示がない');
  });
  await step('入荷：前提が足りないときの案内・未入力の項目を示す', async () => {
    await page.click('#guideSkip'); await page.waitForFunction(() => !document.getElementById('guideDialog').open);
    await page.goto(fresh.url + '/#/receipt'); await idle(page);
    if (!/先に 商品 を/.test(await page.textContent('#rcPre'))) throw new Error('前提の案内: ' + (await page.textContent('#rcPre')));
    await page.click('#receiptForm button[type="submit"]');
    const t = await page.textContent('#rcMsg'); if (!/未入力の項目があります：.*仕入先/.test(t)) throw new Error(t);
    if ((await page.getAttribute('#rcProduct', 'aria-invalid')) !== 'true') throw new Error('未入力の欄に印がない');
    if (!(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-invalid') === 'true'))) throw new Error('未入力の欄へ移動しない');
  });
  await step('ガイド：「?」は次にやるステップから開き、閉じるとフォーカスが戻る', async () => {
    await page.click('.topbar [data-action="guideOpen"]'); await page.waitForSelector('#guideDialog[open]');
    if (!/準備 2 \/ 7/.test(await page.textContent('#guideCount'))) throw new Error(await page.textContent('#guideCount'));
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('guideDialog').open);
    if (!(await page.evaluate(() => document.activeElement.matches('.topbar [data-action="guideOpen"]')))) throw new Error('フォーカスが戻らない');
  });
  await step('ガイド：閉じたら次回ログインでは自動表示しない', async () => {
    await page.waitForTimeout(300);
    await page.click('#moreBtn'); await page.click('#moreSheet [data-action="logout"]'); await page.waitForSelector('#login:not([hidden])');
    await page.fill('#loginPassword', SECOND_USER.password); await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#app:not([hidden])'); await idle(page); await page.waitForTimeout(300);
    if (await page.$('#guideDialog[open]')) throw new Error('2回目のログインでもガイドが開いた');
  });
  await step('ダッシュボード「はじめにやること」：進み具合・手順を見る・非表示', async () => {
    await page.goto(fresh.url + '/#/dashboard'); await idle(page);
    const t = await page.textContent('.setup-card'); if (!/1 \/ 7 完了/.test(t)) throw new Error(t.slice(0, 80));
    await page.click('.setup-card .next [data-action="guideStep"]'); await waitText('#guideCount', /準備 2 \/ 7/);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('guideDialog').open);
    await page.click('[data-action="hideSetup"]'); await waitText('#toasts', /非表示/);
    if (await page.$('.setup-card')) throw new Error('非表示にならない');
  });
  if (errs.length) { report.errors.push({ viewport: 'guide-flow', errs }); total += errs.length; }
  await ctx.close();
  fresh.close();
}

// ---------------- 複数タブ・通信障害 ----------------
{
  const { ctx, page, errs } = await newPage(VIEWPORTS[5]);
  const step = async (label, fn) => {
    try { await fn(); report.flow.push({ step: label, ok: true }); }
    catch (e) { report.flow.push({ step: label, ok: false, error: e.message.split('\n')[0], detail: e.message.slice(0, 1200) }); total++; }
  };
  const page2 = await ctx.newPage();
  await step('別タブで別アカウントがログインすると元のタブはログアウト', async () => {
    await login(page);
    await page2.goto(server.url + '/'); await page2.waitForSelector('#app:not([hidden])'); // 同じセッションを引き継ぐ
    await page2.click('[data-action="logout"]'); await page2.waitForSelector('#login:not([hidden])');
    await page.waitForSelector('#login:not([hidden])');
    if (!/別の画面でログアウト/.test(await page.textContent('#loginMsg'))) throw new Error('ログアウトが伝わらない');
    await login(page);
    await page2.fill('#loginEmail', SECOND_USER.email); await page2.fill('#loginPassword', SECOND_USER.password);
    await page2.click('#loginForm button[type="submit"]'); await page2.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#login:not([hidden])');
    const t = await page.textContent('#loginMsg'); if (!t.includes(SECOND_USER.email)) throw new Error(t);
  });
  await step('通信障害では再接続ボタン（セッションは保持）', async () => {
    await page2.route(server.sb.url + '/**', (r) => r.abort());
    await page2.reload(); await page2.waitForSelector('#retryBtn:not([hidden])');
    if (!/通信できませんでした/.test(await page2.textContent('#loginMsg'))) throw new Error(await page2.textContent('#loginMsg'));
    await page2.unroute(server.sb.url + '/**');
    await page2.click('#retryBtn'); await page2.waitForSelector('#app:not([hidden])'); await idle(page2);
    if ((await page2.textContent('#whoSide')) !== SECOND_USER.email) throw new Error('利用者が違う');
  });
  const real = errs.filter((e) => !/net::ERR_FAILED|Failed to fetch/.test(e));
  if (real.length) { report.errors.push({ viewport: 'multi-tab', errs: real }); total += real.length; }
  await ctx.close();
}

await browser.close();
server.close();
report.total = total;
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const summary = {};
for (const [vp, scenes] of Object.entries(report.viewports)) for (const [scene, issues] of Object.entries(scenes)) for (const i of issues) {
  summary[i.type] = (summary[i.type] || 0) + 1;
}
console.log('issues by type:', JSON.stringify(summary), '| flow:', report.flow.filter((f) => !f.ok).length, 'failed | errors:', report.errors.length);
console.log(total === 0 ? 'REVIEW PASSED' : `REVIEW FOUND ${total} ISSUES → ${join(OUT, 'report.json')}`);
process.exit(total === 0 ? 0 : 1);
