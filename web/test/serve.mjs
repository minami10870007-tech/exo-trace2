// ローカル検証用サーバー：web/dist を netlify.toml のヘッダー付きで配信し、/api/config は Netlify Function をそのまま動かす。
// 接続先の Supabase は supabase/test/harness.mjs のローカル Supabase（PostgreSQL＋PostgREST＋認証）。
//   node web/build.mjs && node web/test/serve.mjs   → http://127.0.0.1:8888 （ログイン: demo@example.com / demo-password-123）
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSupabase } from '../../supabase/test/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

export const DEMO_USER = { email: 'demo@example.com', password: 'demo-password-123' };
/** Supabase にはログインできるが、利用者登録（exo.app_user）されていない人 */
export const OUTSIDER = { email: 'outsider@example.com', password: 'outsider-password-1' };

/** netlify.toml の [[headers]] だけを読む最小パーサー */
function parseHeaders() {
  const rules = [];
  let cur = null, inValues = false;
  for (const raw of readFileSync(join(repo, 'netlify.toml'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '[[headers]]') { cur = { for: '', values: {} }; rules.push(cur); inValues = false; continue; }
    if (line.startsWith('[')) { inValues = line === '[headers.values]' && !!cur; if (!inValues && line !== '[headers.values]') cur = null; continue; }
    const m = line.match(/^([\w-]+)\s*=\s*"(.*)"$/);
    if (!m || !cur) continue;
    if (inValues) cur.values[m[1]] = m[2]; else if (m[1] === 'for') cur.for = m[2];
  }
  return rules;
}
const matches = (pattern, path) => (pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

export async function startServer({ port = 8888, seed = true, db = 'exo_web_test' } = {}) {
  const sb = await startSupabase({ db, users: [{ ...DEMO_USER, allowed: true }, { ...OUTSIDER, allowed: false }] });
  if (seed) await seedData(sb);

  process.env.SUPABASE_URL = sb.url;
  process.env.SUPABASE_ANON_KEY = sb.anonKey;
  const configHandler = (await import(pathToFileURL(join(repo, 'netlify', 'functions', 'config.mjs')).href)).default;
  // 本番の CSP は https://*.supabase.co への接続だけを許可する。ローカルの Supabase に向けて書き換える
  const headerRules = parseHeaders().map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) =>
    [k, k === 'Content-Security-Policy' ? v.replace('https://*.supabase.co', sb.url) : v])) }));
  const dist = join(repo, 'web', 'dist');

  const app = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/config') {
      const response = await configHandler(new Request('http://localhost/api/config', { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('Not Found'); return; }
    const headers = { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' };
    for (const rule of headerRules) if (matches(rule.for, url.pathname)) Object.assign(headers, rule.values);
    res.writeHead(200, headers);
    res.end(readFileSync(file));
  });
  await new Promise((r) => app.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${app.address().port}`, sb, close: () => { app.close(); sb.close(); } };
}

/** 画面確認用のサンプルデータ（全画面に表示内容が出るように）。画面と同じ API（RPC）で登録する */
export async function seedData(sb) {
  const token = await sb.signIn(DEMO_USER.email, DEMO_USER.password);
  const G = new Proxy({}, { get: (_, fn) => (p) => sb.rpc(token, fn, p) });
  const M = await G.get_masters();
  const loc = (code) => M.locations.find((l) => l.location_code === code);
  const master = (table, data) => G.save_master({ table, data });
  const sup = await master('m_supplier', { supplier_code: 'S001', name: 'バイオソース株式会社', contact_name: '佐藤', phone: '03-1234-5678', email: 'sales@biosource.example' });
  const sup2 = await master('m_supplier', { supplier_code: 'S002', name: 'Exo Lab Inc.', email: 'order@exolab.example' });
  const pA = await master('m_product', { product_code: 'EXO-UC50', name: '臍帯由来エクソソーム原液 50億', storage_class: 'M80', shelf_life_days: 730, min_remaining_days: 90, regulatory_class: 'COSMETIC_RAW', list_price: 48000, reorder_point: 10 });
  const pB = await master('m_product', { product_code: 'EXO-AD10', name: '脂肪幹細胞エクソソーム 凍結乾燥 10本', storage_class: 'COLD', shelf_life_days: 365, min_remaining_days: 60, regulatory_class: 'COSMETIC_RAW', list_price: 120000, reorder_point: 3 });
  const pC = await master('m_product', { product_code: 'EXO-RS01', name: '研究用エクソソーム標準品', storage_class: 'M80', shelf_life_days: 540, min_remaining_days: 30, regulatory_class: 'RESEARCH_USE', list_price: 65000 });
  const c1 = await master('m_customer', { customer_code: 'C001', name: '表参道スキンクリニック', customer_type: 'MEDICAL', medical_inst_code: '1312345678', address: '東京都港区北青山3-1-1', contact_name: '山田 花子', phone: '03-5555-0101', email: 'yamada@omotesando-skin.example' });
  const c2 = await master('m_customer', { customer_code: 'C002', name: 'サロン・ド・ルミエール', customer_type: 'SALON', address: '大阪府大阪市北区梅田1-2-3', contact_name: '田中', phone: '06-6666-0202', email: 'info@lumiere.example' });
  const c3 = await master('m_customer', { customer_code: 'C003', name: '関西ビューティー商事', customer_type: 'DISTRIBUTOR', address: '京都府京都市下京区四条通', email: 'buyer@kansai-beauty.example' });
  await master('m_customer', { customer_code: 'C004', name: '先端医科学研究所', customer_type: 'RESEARCH', address: '茨城県つくば市千現1-1' });
  const rc = (p, s, lot, date, mfg, exp, qty, price, locCode) => G.register_receipt({ supplierId: s.id, productId: p.id, supplierLotNo: lot, receiptDate: date,
    manufacturedOn: mfg, expiresOn: exp, quantity: qty, unitPrice: price, locationId: loc(locCode).id, arrivalTemp: '' });
  await rc(pA, sup, 'BS-2409-A17', '2026-09-10', '2026-08-20', '', 40, 21000, 'L-M80-01');
  await rc(pA, sup, 'BS-2405-C02', '2026-06-01', '', '2026-12-15', 12, 20000, 'L-M80-01');
  await rc(pB, sup2, 'EXL-77812', '2026-09-28', '2026-09-01', '', 8, 64000, 'L-COLD-01');
  await rc(pC, sup2, 'EXL-RS-0042', '2026-10-02', '', '2028-03-31', 5, 30000, 'L-M80-01');
  await rc(pA, sup, 'BS-2410-B01', '2026-10-03', '2026-09-25', '', 30, 21500, 'L-M80-01');
  const lots = await G.get_lots({ statuses: [] });
  const lot = (no) => lots.find((l) => l.supplier_lot_no === no);
  for (const n of ['BS-2409-A17', 'BS-2405-C02', 'EXL-77812', 'EXL-RS-0042']) await G.change_lot_status({ lotId: lot(n).id, to: 'RELEASED', coaConfirmed: true });
  await G.create_shipment({ customerId: c1.id, shippedOn: '2026-10-01', lines: [{ productId: pA.id, quantity: 6 }, { productId: pB.id, quantity: 2 }] });
  await G.create_shipment({ customerId: c2.id, shippedOn: '2026-10-02', lines: [{ productId: pA.id, quantity: 10 }] });
  await G.create_shipment({ customerId: c3.id, shippedOn: '2026-10-03', note: '月次定期', lines: [{ productId: pA.id, quantity: 8 }, { productId: pB.id, quantity: 3 }] });
  const recall = await G.create_recall({ title: '粒子濃度の規格外（再試験）', reason: 'COA再試験で粒子濃度が規格下限を下回ったため自主回収', severity: 'II', lotIds: [lot('EXL-77812').id] });
  const t = recall.targets.find((x) => x.shipped_qty > 0);
  if (t) await G.update_recall_target({ targetId: t.id, contactedOn: '2026-10-04', contactMethod: '電話', status: 'CONTACTED' });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer({ port: Number(process.env.PORT || 8888) });
  console.log('EXO-TRACE local:', s.url, '（', DEMO_USER.email, '/', DEMO_USER.password, '）');
  console.log('Supabase（ローカル）:', s.sb.url);
}
