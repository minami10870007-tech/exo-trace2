// デザイン・レスポンシブの自動レビュー＋操作テスト。
//   node web/build.mjs && NODE_PATH=$(npm root -g) node web/test/review.mjs [出力先]
// 出力: <出力先>/report.json と各画面のスクリーンショット。問題があれば終了コード1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer, DEMO_USER, OUTSIDER } from './serve.mjs';
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
    catch (e) { report.flow.push({ step: label, ok: false, error: e.message.split('\n')[0] }); total++; }
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
  await step('メニュー→検品→合格', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="inspect"]'); await idle(page);
    const card = page.locator('.lot-card', { hasText: 'FLOW-001' });
    const btn = card.locator('[data-action="changeStatus"]');
    if (!(await btn.isDisabled())) throw new Error('判定未選択でボタンが押せる');
    await card.locator('select.insTo').selectOption('RELEASED');
    if (!(await btn.isDisabled())) throw new Error('COA未確認でボタンが押せる');
    await card.locator('input[type="checkbox"]').check();
    if ((await btn.textContent()).trim() !== '合格にする') throw new Error('ボタン文言: ' + (await btn.textContent()));
    await btn.click(); await waitText('#toasts', /合格/);
    if (!/合格/.test(await toastText())) throw new Error(await page.textContent('#insMsg'));
  });
  await step('出荷（確認ダイアログ）', async () => {
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page);
    const cv = await page.$eval('#shCustomer', (s) => [...s.options].find((o) => o.text.includes('サロン・ド・ルミエール')).value);
    await page.selectOption('#shCustomer', cv);
    await page.selectOption('.slProd', { index: 1 }); await page.fill('.slQty', '2');
    await page.click('#shipForm button[type="submit"]'); await page.click('#dialogOk'); await waitText('#shMsg', /出荷を確定しました|。/);
    const t = await page.textContent('#shMsg'); if (!/出荷を確定しました/.test(t)) throw new Error(t);
    shippedLot = await page.textContent('#shMsg .rtable .mono');
  });
  await step('ロット追跡', async () => {
    await page.click('#bottomNav [data-page="traceLot"]'); await page.fill('#tlQuery', shippedLot); await page.click('#tlSearch button'); await idle(page);
    const t = await page.textContent('#tlBody'); if (!/サロン・ド・ルミエール/.test(t)) throw new Error('販売先が表示されない');
  });
  await step('出荷取消（理由入力ダイアログ）', async () => {
    await page.click('#bottomNav [data-page="shipment"]'); await idle(page);
    await page.click('[data-action="cancelShip"]'); await page.fill('#dialogInput', '数量誤り'); await page.click('#dialogOk'); await waitText('#toasts', /取消しました|。/);
    if (!/取消しました/.test(await toastText())) throw new Error('取消トーストなし');
  });
  await step('マスタ編集（フルスクリーンダイアログ）', async () => {
    await page.click('#moreBtn'); await page.click('#sheetNav [data-page="master"]'); await idle(page);
    await page.click('#msList tr[data-action]'); await page.fill('#mf_reorder_point', '12');
    await page.click('#masterForm button[value="save"]'); await waitText('#toasts', /保存しました|。/).catch(() => {});
    if (await page.$('#masterDialog[open]')) throw new Error(await page.textContent('#masterMsg'));
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
