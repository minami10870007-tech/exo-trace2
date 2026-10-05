// schema.sql をローカル Supabase（PostgreSQL＋PostgREST）に適用し、API 経由で業務フロー・権限・同時実行を検証する。
//   実行: node supabase/test/db_test.mjs
import assert from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupabase, psql } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sb = await startSupabase({ db: 'exo_db_test', users: [
  { email: 'qa@example.com', password: 'pw-qa', allowed: true },
  { email: 'Stranger@example.com', password: 'pw-x', allowed: false },
] });
let passed = 0;
const ok = (cond, label) => { assert(cond, label); passed++; };
async function throwsMsg(promise, re, label) {
  let msg = null;
  try { await promise; } catch (e) { msg = e.message; }
  assert(msg && re.test(msg), label + ' → 期待するエラーにならない: ' + msg);
  passed++;
}

try {
  const token = await sb.signIn('qa@example.com', 'pw-qa');
  const G = new Proxy({}, { get: (_, fn) => (p) => sb.rpc(token, fn, p) });

  // ---------------- 権限 ----------------
  await throwsMsg(sb.rpc(null, 'get_masters'), /permission denied/, '未ログイン（anon）は実行不可');
  try { await sb.rpc(null, 'get_masters'); } catch (e) { ok(e.status === 401, '未ログインは 401'); }
  const stranger = await sb.signIn('stranger@example.com', 'pw-x');
  try { await sb.rpc(stranger, 'get_config'); assert.fail('許可外ユーザーが実行できた'); } catch (e) { ok(e.status === 403 && /利用権限がありません/.test(e.message), '許可外ユーザーは 403'); }
  for (const path of ['/rest/v1/t_lot', '/rest/v1/m_customer', '/rest/v1/rpc/daily_check', '/rest/v1/rpc/move']) {
    const r = await fetch(sb.url + path, { method: path.includes('rpc') ? 'POST' : 'GET', headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: path.includes('rpc') ? '{}' : undefined });
    ok(r.status === 404, `内部テーブル・関数は API に公開されない（${path} → ${r.status}）`);
  }
  {
    const r = await fetch(sb.url + '/rest/v1/t_lot', { headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + token, 'Accept-Profile': 'exo' } });
    ok(r.status === 406, 'exo スキーマは API の公開対象外（' + r.status + '）');
  }
  ok(psql(sb.db, "select count(*) from information_schema.role_routine_grants where routine_schema = 'public' and grantee in ('anon', 'PUBLIC')") === '0', 'anon / PUBLIC に実行権限なし');
  ok(psql(sb.db, "select has_schema_privilege('authenticated', 'exo', 'USAGE')::text") === 'false', 'authenticated は exo スキーマを直接使えない');
  ok(psql(sb.db, "select count(*) from pg_proc where pronamespace in ('public'::regnamespace, 'exo'::regnamespace) and not (proconfig @> array['search_path=\"\"'])") === '0', '全関数で search_path を固定');
  // 利用者の登録・停止（管理者用）：大文字混じりでも登録でき、停止→再登録もできる
  psql(sb.db, "select exo.allow_user(' Stranger@Example.com ')");
  ok((await sb.rpc(stranger, 'get_config')).user === 'stranger@example.com', 'exo.allow_user で利用可能になる（大文字・空白を正規化）');
  psql(sb.db, "select exo.disallow_user('stranger@example.com')");
  try { await sb.rpc(stranger, 'get_config'); assert.fail('停止した利用者が実行できた'); } catch (e) { ok(e.status === 403, 'exo.disallow_user で停止'); }
  psql(sb.db, "select exo.allow_user('stranger@example.com'); select exo.disallow_user('stranger@example.com')");
  ok(psql(sb.db, "select is_active::text from exo.app_user where email = 'stranger@example.com'") === 'false', '停止→再登録→停止');
  // schema.sql は何度実行してもよい（データ・権限が維持される）
  psql(sb.db, '', { file: join(here, '..', 'schema.sql') });
  let M = await G.get_masters();
  ok(M.locations.length === 4 && M.salesRules.length === 20, '初期設定：保管場所4・販売可否ルール20（再実行しても重複しない）');
  ok(Object.keys((await G.get_config()).codes.storage_class).join() === 'M80,M20,COLD,RT', 'コード定義の並び順を保持');

  // ---------------- はじめてガイド ----------------
  const cfg0 = await G.get_config();
  ok(cfg0.prefs && !cfg0.prefs.guideDone && cfg0.setup.suppliers === false && cfg0.setup.shipments === false, '初回：ガイド未表示・初期設定未完了');
  ok((await G.save_user_prefs({ guideDone: true, evil: 'x' })).guideDone === true, 'ガイド表示済みを保存（許可外のキーは無視）');
  const cfg1 = await G.get_config();
  ok(cfg1.prefs.guideDone === true && !('evil' in cfg1.prefs), '保存した設定が次回ログインで返る');
  try { await sb.rpc(null, 'save_user_prefs', {}); assert.fail(); } catch (e) { ok(e.status === 401, '未ログインは設定を保存できない'); }

  // ---------------- マスタ ----------------
  const sup = await G.save_master({ table: 'm_supplier', data: { supplier_code: 'S001', name: '仕入先A', is_active: true } });
  const prod = await G.save_master({ table: 'm_product', data: { product_code: 'EXO-A', name: 'エクソソーム原液A', storage_class: 'M80', shelf_life_days: 730,
    min_remaining_days: 90, regulatory_class: 'COSMETIC_RAW', list_price: 30000, reorder_point: 5, is_active: true } });
  const salon = await G.save_master({ table: 'm_customer', data: { customer_code: 'C001', name: 'サロンA', customer_type: 'SALON', address: '東京', email: 'a@salon.jp', is_active: true } });
  const salonB = await G.save_master({ table: 'm_customer', data: { customer_code: 'C002', name: 'サロンB', customer_type: 'SALON', address: '大阪', is_active: true } });
  const lab = await G.save_master({ table: 'm_customer', data: { customer_code: 'C003', name: '研究所C', customer_type: 'RESEARCH', address: '茨城', is_active: true } });
  await throwsMsg(G.save_master({ table: 'm_customer', data: { customer_code: 'C009', name: '病院', customer_type: 'MEDICAL', address: 'x' } }), /医療機関コード/, 'BR-10');
  await throwsMsg(G.save_master({ table: 'm_product', data: { product_code: 'exo-a', name: '重複', storage_class: 'M80', shelf_life_days: 1, regulatory_class: 'OTHER' } }), /既に使われ/, 'コード重複（大文字小文字を区別しない）');
  await throwsMsg(G.save_master({ table: 'm_product', data: { product_code: 'X 1', name: 'x', storage_class: 'M80', shelf_life_days: 1, regulatory_class: 'OTHER' } }), /英数字/, 'コードの文字種');
  await throwsMsg(G.save_master({ table: 'm_product', data: { product_code: 'X1', name: 'x', storage_class: 'M80', shelf_life_days: 'abc', regulatory_class: 'OTHER' } }), /有効期間/, '数値でない入力');
  await throwsMsg(G.save_master({ table: 't_lot', data: {} }), /更新できないテーブル/, 'マスタ以外は更新不可');
  await throwsMsg(G.save_master({ table: 'm_location', data: { location_code: 'L9', name: 'x', storage_class: 'RT', temp_min: '', temp_max: 25 } }), /下限 < 上限/, '保管場所の温度範囲');
  ok(prod.list_price === 30000 && prod.min_remaining_days === 90 && prod.is_active === true && !('created_at' in prod) && prod.updated_at, 'マスタの戻り値');
  const prodEdited = await G.save_master({ table: 'm_product', data: { ...prod, name: 'エクソソーム原液A（改）', list_price: '' } });
  ok(prodEdited.id === prod.id && prodEdited.name === 'エクソソーム原液A（改）' && prodEdited.list_price === null, 'マスタ更新（空欄は未設定）');
  await throwsMsg(G.save_master({ table: 'm_product', data: { ...prod, expected_updated_at: prod.updated_at } }), /他の利用者が先に更新/, '古い編集画面からの上書きは拒否');
  ok((await G.save_master({ table: 'm_product', data: { ...prodEdited, name: 'エクソソーム原液A（改2）', expected_updated_at: prodEdited.updated_at } })).name === 'エクソソーム原液A（改2）', '最新の編集画面からは保存できる');
  await G.save_master({ table: 'm_product', data: { ...prod } });
  ok((await G.save_sales_rule({ regulatoryClass: 'OTHER', customerType: 'SALON', allowed: false })) === true, '販売可否ルール保存');
  await throwsMsg(G.save_sales_rule({ regulatoryClass: 'BAD', customerType: 'SALON', allowed: true }), /不正/, '販売可否ルールの区分チェック');
  M = await G.get_masters();
  const freezer = M.locations.find((l) => l.location_code === 'L-M80-01');
  const qFreezer = M.locations.find((l) => l.location_code === 'Q-M80-01');
  const fridge = M.locations.find((l) => l.location_code === 'L-COLD-01');

  // ---------------- 入荷 ----------------
  const rcp = (o) => G.register_receipt({ supplierId: sup.id, productId: prod.id, locationId: freezer.id, ...o });
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 5, unitPrice: 100, locationId: fridge.id }), /入庫できません/, 'BR-06 温度区分不一致');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-05', expiresOn: '2028-01-01', quantity: 5, unitPrice: 100 }), /当日以前/, '未来日の入荷');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-02-30', expiresOn: '2028-01-01', quantity: 5, unitPrice: 100 }), /当日以前/, '存在しない日付');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 1.5, unitPrice: 100 }), /1以上の整数/, '数量は整数');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 1, unitPrice: '' }), /仕入単価/, '仕入単価必須');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-01', quantity: 1, unitPrice: 1 }), /使用期限を入力/, '使用期限か製造日が必要');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 1, unitPrice: 1, arrivalTemp: 'abc' }), /到着時温度/, '到着時温度は数値');
  const r1 = await rcp({ supplierLotNo: 'SUP-1', receiptDate: '2026-10-01', manufacturedOn: '2026-09-01', quantity: 10, unitPrice: 10000, arrivalTemp: -50 });
  ok(r1.lotNo === 'EXO-A-261001-01' && r1.receiptNo === 'RC-202610-0001' && /許容範囲（-90〜-60℃）外/.test(r1.warning), '入荷：ロット採番・入荷番号・到着温度警告');
  const r1b = await rcp({ supplierLotNo: 'SUP-1', receiptDate: '2026-10-02', manufacturedOn: '2026-09-01', quantity: 10, unitPrice: 12000, arrivalTemp: '' });
  ok(r1b.lotNo === r1.lotNo && r1b.warning === '' && r1b.receiptNo === 'RC-202610-0002', '分納（検品待ちロット）は同一ロットに加算');
  await throwsMsg(rcp({ supplierLotNo: 'SUP-1', receiptDate: '2026-10-02', expiresOn: '2029-01-01', quantity: 1, unitPrice: 1 }), /使用期限 2028-08-31/, 'BR-15 使用期限不一致');
  const r2 = await rcp({ supplierLotNo: 'SUP-2', receiptDate: '2026-10-03', expiresOn: '2027-06-30', quantity: 5, unitPrice: 9000 });
  let lots = await G.get_lots({ statuses: [] });
  const lot1 = lots.find((l) => l.lot_no === r1.lotNo), lot2 = lots.find((l) => l.lot_no === r2.lotNo);
  ok(lot1.stock === 20 && lot1.unit_cost === 11000 && lot1.expires_on === '2028-08-31' && lot1.daysLeft === 697, '移動平均原価・使用期限自動計算（製造日＋有効期間）・残日数');
  ok((await G.get_dashboard()).quarantine.length === 2, 'ダッシュボード：検品待ち');

  // ---------------- 検品 ----------------
  await throwsMsg(G.create_shipment({ customerId: salon.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /不足/, '検品待ちは引当不可');
  await throwsMsg(G.change_lot_status({ lotId: lot1.id, to: 'RELEASED', coaConfirmed: false }), /COA/, 'BR-08 COA未確認');
  await throwsMsg(G.change_lot_status({ lotId: lot1.id, to: 'REJECTED' }), /理由を入力/, '不合格は理由必須');
  await throwsMsg(G.change_lot_status({ lotId: lot1.id, to: 'EXPIRED', reason: 'x' }), /変更できません/, '許可されない遷移');
  const released = await G.change_lot_status({ lotId: lot1.id, to: 'RELEASED', coaConfirmed: true });
  ok(released.status === 'RELEASED' && released.statusLabel === '合格' && released.inspected_at, '検品：合格（検品日時を記録）');
  await G.change_lot_status({ lotId: lot2.id, to: 'RELEASED', coaConfirmed: 'true' });
  await throwsMsg(rcp({ supplierLotNo: 'SUP-1', receiptDate: '2026-10-04', manufacturedOn: '2026-09-01', quantity: 1, unitPrice: 1 }), /合格のため/, '合格済ロットへの分納は不可');

  // ---------------- 出荷 ----------------
  await throwsMsg(G.create_shipment({ customerId: lab.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /販売できません/, 'BR-09 販売可否');
  await throwsMsg(G.create_shipment({ customerId: salon.id, shippedOn: '2026-10-04', lines: [{ productId: '', quantity: 1 }] }), /1行以上/, '明細必須');
  await throwsMsg(G.create_shipment({ customerId: salon.id, shippedOn: '', lines: [{ productId: prod.id, quantity: 1 }] }), /出荷日/, '出荷日必須');
  await throwsMsg(G.create_shipment({ customerId: salon.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1, unitPrice: -1 }] }), /1行目の単価/, '単価チェック');
  // FEFO：lot2（期限2027-06-30）→ lot1 の順。同一出荷内の2行でも二重割当しない
  const s1 = await G.create_shipment({ customerId: salon.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 4 }, { productId: prod.id, quantity: 3, unitPrice: 28000 }] });
  ok(s1.lines.length === 3 && s1.lines[0].lot_no === r2.lotNo && s1.lines[0].quantity === 4 &&
     s1.lines[1].lot_no === r2.lotNo && s1.lines[1].quantity === 1 && s1.lines[2].lot_no === r1.lotNo && s1.lines[2].quantity === 2, 'FEFO・同一出荷内の二重割当なし');
  ok(s1.shipment_no === 'SH-202610-0001' && s1.amount === 4 * 30000 + 3 * 28000 && s1.customer === 'サロンA', '出荷番号・金額');
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 100 }] }), /不足 82/, '在庫不足は全体を登録しない');
  ok((await G.get_recent_shipments({ limit: 30 })).length === 1, '在庫不足時は出荷が作成されない（ロールバック）');
  // 最低出荷残期間：700日にすると lot2（残269日）・lot1（残697日）とも引当対象外
  await G.save_master({ table: 'm_product', data: { ...prod, min_remaining_days: 700 } });
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /残期間 700日以上/, '最低出荷残期間');
  await G.save_master({ table: 'm_product', data: { ...prod } });
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-09-30', lines: [{ productId: prod.id, quantity: 1 }] }), /出荷日までに入荷・検品/, '出荷日より後に入荷したロットは引当しない');
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-05', lines: [{ productId: prod.id, quantity: 1 }] }), /当日以前/, '未来日の出荷は不可');
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-07-05', lines: [{ productId: prod.id, quantity: 1 }] }), /過去90日以内/, '古すぎる出荷日は不可');
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-04', note: 'x'.repeat(2001), lines: [{ productId: prod.id, quantity: 1 }] }), /長すぎ/, '長すぎる入力');
  await throwsMsg(rcp({ supplierLotNo: 'X', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 1, unitPrice: '999999999999.999' }), /大きすぎ/, '丸め後の桁あふれ');
  await throwsMsg(rcp({ supplierLotNo: 'BIG', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 1000000000, unitPrice: 1 }).then(() =>
    rcp({ supplierLotNo: 'BIG', receiptDate: '2026-10-01', expiresOn: '2028-01-01', quantity: 1, unitPrice: 1 })), /上限/, '在庫数の上限');
  ok(psql(sb.db, "select exo.next_no('SH', '2026-10-01', array['SH-202610-9999'])") === 'SH-202610-10000', '連番が桁あふれしても重複しない');
  const s2 = await G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 5 }] });
  ok(s2.lines.every((l) => l.lot_no === r1.lotNo) && s2.shipment_no === 'SH-202610-0002', 'lot2 が尽きた後は lot1 から引当');
  ok((await G.get_shipment_by_no({ no: ' sh-202610-0002 ' })).id === s2.id, '出荷番号で検索（大文字小文字・空白を無視）');
  await throwsMsg(G.get_shipment_by_no({ no: 'SH-0' }), /見つかりません/, '出荷番号が無い');

  // ---------------- 返品 ----------------
  const lineB = s2.lines[0];
  await throwsMsg(G.register_return({ shipmentLineId: lineB.id, quantity: 6, reason: 'x', quarantineLocationId: qFreezer.id, disposition: 'DISPOSE' }), /返品可能数（5）/, 'BR-12');
  await throwsMsg(G.register_return({ shipmentLineId: lineB.id, quantity: 1, reason: 'x', quarantineLocationId: freezer.id, disposition: 'DISPOSE' }), /隔離保管場所/, '返品は隔離保管場所へ');
  await throwsMsg(G.register_return({ shipmentLineId: lineB.id, quantity: 1, reason: 'x', returnedOn: '2026-10-03', quarantineLocationId: qFreezer.id, disposition: 'DISPOSE' }), /出荷日（2026-10-04）以降/, '返品日は出荷日以降');
  await throwsMsg(G.register_return({ shipmentLineId: lineB.id, quantity: 1, reason: 'x', quarantineLocationId: qFreezer.id }), /処置/, '処置の選択必須');
  await G.register_return({ shipmentLineId: lineB.id, quantity: 1, reason: '破損', quarantineLocationId: qFreezer.id, disposition: 'DISPOSE' });
  const rt2 = await G.register_return({ shipmentLineId: lineB.id, quantity: 1, reason: '誤発注', quarantineLocationId: qFreezer.id, disposition: 'RESTOCK', restockLocationId: freezer.id });
  ok(rt2.returnNo === 'RT-202610-0002' && rt2.recall === false && rt2.disposition === 'RESTOCK', '返品番号・処置');
  let inv = await G.get_inventory();
  ok(inv.find((i) => i.lot_no === r1.lotNo && !i.quarantine).qty === 20 - 2 - 5 + 1, '返品：廃棄は在庫に戻らず、在庫戻しは通常保管場所へ');
  ok(!inv.some((i) => i.quarantine && i.qty !== 0), '隔離保管場所に残数なし');
  ok(inv.every((i) => typeof i.allocatable === 'boolean'), '在庫照会：引当可否');
  await throwsMsg(G.cancel_shipment({ shipmentId: s2.id, reason: 'x' }), /返品が登録されている/, '返品済みの出荷は取消不可');

  // ---------------- 追跡 ----------------
  const tl = (await G.trace_lot({ query: 'sup-1' }))[0];
  ok(tl.shipments.length === 2 && tl.shipments.find((s) => s.customer === 'サロンB').net === 3 && tl.shipments.find((s) => s.customer === 'サロンA').net === 2, 'ロット追跡（仕入先ロット番号・部分一致）');
  ok(tl.movementTotals.RECEIPT === 20 && tl.movementTotals.SHIPMENT === -7 && tl.history.length === 2 && tl.history[0].to_status === 'QUARANTINE' && tl.history[0].changed_by === 'qa@example.com', 'ロット追跡：移動集計・履歴（作成者＝ログインユーザー）');
  ok((await G.trace_lot({ query: '%' })).length === 0, '検索語の % はワイルドカードにならない');
  await throwsMsg(G.trace_lot({ query: ' ' }), /ロット番号を入力/, 'ロット番号必須');
  const tc = await G.trace_customer({ customerId: salonB.id, from: '', to: '' });
  ok(tc.rows.length === 1 && tc.rows[0].net === 3 && tc.customer.name === 'サロンB', '顧客追跡（正味）');
  ok((await G.trace_customer({ customerId: salonB.id, from: '2026-10-05' })).rows.length === 0, '顧客追跡：期間指定');

  // ---------------- 回収 ----------------
  await throwsMsg(G.create_recall({ title: 't', reason: 'r', severity: 'II', lotIds: [] }), /1件以上/, '回収：ロット必須');
  await throwsMsg(G.create_recall({ title: 't', reason: 'r', severity: 'IV', lotIds: [lot1.id] }), /重大度/, '回収：重大度');
  const rc = await G.create_recall({ title: '粒子濃度逸脱', reason: 'COA再試験で規格外', severity: 'II', lotIds: [String(lot1.id), lot1.id] });
  const tA = rc.targets.find((t) => t.customer === 'サロンA'), tB = rc.targets.find((t) => t.customer === 'サロンB');
  ok(rc.recall_no === 'RCL-2026-001' && rc.status === 'IN_PROGRESS' && tA.shipped_qty === 2 && tB.shipped_qty === 3 && rc.targets.length === 2 && rc.lots.length === 1, '回収対象抽出（出荷正味）');
  ok((await G.get_lots({ statuses: ['RECALLED'] })).length === 1, '回収ロットは RECALLED');
  await throwsMsg(G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /不足/, '回収ロットは出荷停止');
  const ret = await G.register_return({ shipmentLineId: lineB.id, quantity: 2, reason: '回収', quarantineLocationId: qFreezer.id, disposition: 'RESTOCK', restockLocationId: freezer.id });
  ok(ret.recall && ret.disposition === 'DISPOSE', '回収品は廃棄に強制（BR-18）');
  let rv = (await G.list_recalls())[0];
  ok(rv.targets.find((t) => t.customer === 'サロンB').recovered_qty === 2 && rv.targets.find((t) => t.customer === 'サロンB').status === 'CONTACTED' && rv.targets.find((t) => t.customer === 'サロンB').contacted_on === '2026-10-04', '回収数を返品から集計（回収品が届いたら連絡済）');
  await throwsMsg(G.update_recall_target({ targetId: tB.id, unrecoverableQty: 2 }), /超えています/, '回収不能数の上限');
  await throwsMsg(G.update_recall_target({ targetId: tB.id, contactedOn: '2026-09-01' }), /回収開始日以降/, '連絡日は回収開始日以降');
  await throwsMsg(G.update_recall_target({ targetId: tB.id, contactMethod: '電話', expectedUpdatedAt: '2000-01-01 00:00:00+00' }), /他の利用者または返品登録で更新/, '古い画面からの回収状況の保存は拒否');
  ok((await G.get_shipment_by_no({ no: s2.shipment_no })).lines.every((l) => l.in_open_recall === true && l.storage_class === 'M80'), '返品画面用：回収中フラグ・温度区分');
  await G.update_recall_target({ targetId: tB.id, contactedOn: '2026-10-04', contactMethod: '電話', status: 'CONTACTED', unrecoverableQty: 1, closeReason: '' });
  rv = (await G.list_recalls())[0];
  const tB2 = rv.targets.find((t) => t.customer === 'サロンB');
  ok(tB2.status === 'RECOVERED' && tB2.contacted_on === '2026-10-04' && tB2.contact_method === '電話', '回収＋回収不能 ≥ 出荷正味で RECOVERED');
  ok(rv.contactedRate === 50 && rv.recoveredRate === 40, '連絡済率・回収率（回収不能は回収に含めない）');
  await throwsMsg(G.close_recall({ recallId: rc.id }), /未完了の回収対象顧客が 1 件/, 'P-14 未完了あり');
  await throwsMsg(G.update_recall_target({ targetId: tA.id, status: 'CLOSED', closeReason: '' }), /クローズ理由/, 'クローズ理由必須');
  // サロンA の出荷を取消 → 再抽出で A=0・CLOSED
  const cancelled = await G.cancel_shipment({ shipmentId: s1.id, reason: '誤出荷' });
  ok(cancelled.status === 'CANCELLED' && /取消：誤出荷/.test(cancelled.note) && cancelled.lines.every((l) => l.returnable === 0), '出荷取消');
  await throwsMsg(G.cancel_shipment({ shipmentId: s1.id, reason: 'x' }), /既に取消/, '二重取消不可');
  rv = (await G.list_recalls())[0];
  const tA2 = rv.targets.find((t) => t.customer === 'サロンA');
  ok(tA2.shipped_qty === 0 && tA2.status === 'CLOSED', '出荷取消で回収対象を自動クローズ');
  ok((await G.reextract_recall({ recallId: rc.id })).targets.length === 2, '再抽出（冪等）');
  ok(Object.entries(await G.get_setup()).every(([k, v]) => v || k === 'rules'), '初期設定〜初回出荷まで完了（販売可否ルール以外）');
  await G.save_user_prefs({ rulesChecked: true });
  ok((await G.get_setup()).rules === true, '販売可否ルールの確認を記録');
  const dash = await G.get_dashboard();
  ok(dash.recalls.length === 1 && dash.recalls[0].recall_no === 'RCL-2026-001', 'ダッシュボード：対応中の回収');
  const closed = await G.close_recall({ recallId: rc.id });
  ok(closed.status === 'CLOSED' && closed.closed_on === '2026-10-04' && /未処分の在庫/.test(closed.warning), '回収完了（残在庫の警告）');
  await throwsMsg(G.update_recall_target({ targetId: tA.id, status: 'CONTACTED' }), /完了した回収案件/, '完了後は更新不可');
  // 同じロットの2回目の回収：前回回収済みの数量は対象にしない
  const rc2 = await G.create_recall({ title: '再回収', reason: '追加調査', severity: 'III', lotIds: [lot1.id] });
  const tB3 = rc2.targets.find((t) => t.customer === 'サロンB');
  // サロンB：出荷5 − 通常返品2 − 前回の回収品2 = 1（前回「回収不能」とした1本は今回も対象）
  ok(rc2.recall_no === 'RCL-2026-002' && tB3.shipped_qty === 1 && tB3.recovered_qty === 0 && tB3.status === 'NOT_CONTACTED', '2回目の回収：前回回収済みの数量は除外');
  await throwsMsg(G.create_recall({ title: '重複', reason: 'x', severity: 'III', lotIds: [lot1.id] }), /対応中の回収案件の対象/, '対応中の回収と同じロットは不可');
  await G.update_recall_target({ targetId: tB3.id, unrecoverableQty: 1, closeReason: '' });
  await G.close_recall({ recallId: rc2.id });

  // ---------------- 処分（廃棄・仕入先返品） ----------------
  const recInv = (await G.get_inventory()).find((i) => i.lot_no === r1.lotNo && !i.quarantine);
  ok((await G.get_dashboard()).toDispose.some((l) => l.lot_no === r1.lotNo), 'ダッシュボード：回収ロットの在庫は処分待ち');
  await throwsMsg(G.dispose_stock({ lotId: recInv.lot_id, locationId: recInv.location_id, quantity: recInv.qty + 1, kind: 'DISPOSE', reason: 'x' }), /在庫（\d+）を超えて/, '処分は在庫以内');
  await throwsMsg(G.dispose_stock({ lotId: recInv.lot_id, locationId: recInv.location_id, quantity: 1, kind: 'X', reason: 'x' }), /処分の方法/, '処分の方法');
  await throwsMsg(G.dispose_stock({ lotId: recInv.lot_id, locationId: recInv.location_id, quantity: 1, kind: 'DISPOSE', reason: '' }), /理由/, '処分の理由');
  const dsp = await G.dispose_stock({ lotId: recInv.lot_id, locationId: recInv.location_id, quantity: recInv.qty, kind: 'SUPPLIER_RETURN', reason: '回収品を返送' });
  ok(dsp.left === 0 && dsp.kind === 'SUPPLIER_RETURN', '仕入先返品で在庫を落とす');
  ok(!(await G.get_dashboard()).toDispose.some((l) => l.lot_no === r1.lotNo), '処分後は処分待ちから消える');
  ok((await G.trace_lot({ query: r1.lotNo }))[0].movementTotals.SUPPLIER_RETURN === -recInv.qty, '在庫移動履歴に記録');

  // ---------------- 状態遷移 ----------------
  await throwsMsg(G.change_lot_status({ lotId: lot1.id, to: 'RELEASED', coaConfirmed: true }), /変更できません/, 'RECALLED からは変更不可');
  await throwsMsg(G.change_lot_status({ lotId: lot2.id, to: 'HOLD', reason: 'x', expectedStatus: 'QUARANTINE' }), /他の利用者により「合格」/, '古い画面からの判定は拒否');
  await G.change_lot_status({ lotId: lot2.id, to: 'HOLD', reason: '温度確認' });
  await throwsMsg(G.change_lot_status({ lotId: lot2.id, to: 'QUARANTINE', reason: 'x' }), /検品済/, '検品済は検品待ちに戻せない');
  await G.change_lot_status({ lotId: lot2.id, to: 'RELEASED', reason: '問題なし', coaConfirmed: true });
  ok(true, 'HOLD→RELEASED（検品済）');

  // ---------------- 同時実行：同じ在庫を同時に出荷しても在庫がマイナスにならない ----------------
  const r3 = await rcp({ supplierLotNo: 'SUP-3', receiptDate: '2026-10-04', expiresOn: '2028-12-31', quantity: 10, unitPrice: 1 });
  const lot3 = (await G.get_lots({ statuses: ['QUARANTINE'] })).find((l) => l.lot_no === r3.lotNo);
  await G.change_lot_status({ lotId: lot3.id, to: 'RELEASED', coaConfirmed: true });
  const avail = (await G.get_inventory()).filter((i) => i.allocatable && i.product_code === 'EXO-A').reduce((s, i) => s + i.qty, 0);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    G.create_shipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 4 }] })));
  const shippedOk = results.filter((r) => r.status === 'fulfilled').length;
  const left = (await G.get_inventory()).filter((i) => i.allocatable && i.product_code === 'EXO-A').reduce((s, i) => s + i.qty, 0);
  ok(shippedOk === Math.floor(avail / 4) && left === avail - shippedOk * 4 && results.filter((r) => r.status === 'rejected').every((r) => /不足/.test(r.reason.message)),
    `同時出荷 8件：${shippedOk}件成功・在庫 ${avail}→${left}（過剰引当なし）`);
  const nos = new Set((await G.get_recent_shipments({ limit: 50 })).map((s) => s.shipment_no));
  ok(nos.size === (await G.get_recent_shipments({ limit: 50 })).length, '同時実行でも出荷番号が重複しない');

  // ---------------- 日次チェック ----------------
  psql(sb.db, `alter database ${sb.db} set exo.today = '2027-07-05'`);
  const dc = JSON.parse(psql(sb.db, "set exo.today = '2027-07-05'; select exo.daily_check()"));
  ok(dc.expired.includes(r2.lotNo) && dc.mismatches.length === 0, '日次チェック：期限切れ判定・在庫＝移動履歴');
  psql(sb.db, 'update exo.t_inventory set on_hand_qty = on_hand_qty + 999 where id = (select min(id) from exo.t_inventory)');
  const dc2 = JSON.parse(psql(sb.db, 'select exo.daily_check()'));
  ok(dc2.mismatches.length === 1 && dc2.mismatches[0].on_hand - dc2.mismatches[0].movement_total === 999, '在庫不整合を検出');
  const d2 = await G.get_dashboard();
  ok(d2.lastCheck && d2.lastCheck.mismatches.length === 1 && d2.lastCheck.ran_at && d2.checkStale === false, 'ダッシュボードに日次チェック結果');
  psql(sb.db, "update exo.t_job_log set ran_at = now() - interval '2 days'");
  ok((await G.get_dashboard()).checkStale === true, '日次チェックが止まっていたら警告');
  ok(psql(sb.db, "select count(*) from information_schema.role_routine_grants where routine_schema = 'exo' and grantee in ('PUBLIC', 'anon', 'authenticated')") === '0', 'exo の関数は PUBLIC に実行権限なし');
  ok(psql(sb.db, "select count(*) from pg_proc where proname = 'daily_check' and pronamespace = 'exo'::regnamespace") === '1', '日次チェック関数');

  console.log(`ALL ${passed} CHECKS PASSED`);
} finally {
  sb.close();
}
