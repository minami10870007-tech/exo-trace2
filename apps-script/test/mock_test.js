// コード.gs をスプレッドシートのモック上で動かし、主要業務フローを検証する。
// 実行: node apps-script/test/mock_test.js
'use strict';
const assert = require('assert');

const { createEnv } = require('./mock_env');
const env = createEnv();
const G = env.G, sheets = env.sheets, mails = env.mails;

function throwsMsg(fn, re, label) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  assert(msg && re.test(msg), label + ' → 期待するエラーにならない: ' + msg);
}
let passed = 0;
function ok(cond, label) { assert(cond, label); passed++; }

// ---------------- シナリオ ----------------
G.setup();
G.setup(); // 2回実行しても初期データが重複しない
let M = G.getMasters();
ok(M.locations.length === 4 && M.salesRules.length === 20, '初期設定：保管場所4・販売可否ルール20（冪等）');

const sup = G.saveMaster('m_supplier', { supplier_code: 'S001', name: '仕入先A', is_active: true });
const prod = G.saveMaster('m_product', { product_code: 'EXO-A', name: 'エクソソーム原液A', storage_class: 'M80', shelf_life_days: 730,
  min_remaining_days: 90, regulatory_class: 'COSMETIC_RAW', list_price: 30000, reorder_point: 5, is_active: true });
const salon = G.saveMaster('m_customer', { customer_code: 'C001', name: 'サロンA', customer_type: 'SALON', address: '東京', email: 'a@salon.jp', is_active: true });
const salonB = G.saveMaster('m_customer', { customer_code: 'C002', name: 'サロンB', customer_type: 'SALON', address: '大阪', is_active: true });
const lab = G.saveMaster('m_customer', { customer_code: 'C003', name: '研究所C', customer_type: 'RESEARCH', address: '茨城', is_active: true });
throwsMsg(() => G.saveMaster('m_customer', { customer_code: 'C009', name: '病院', customer_type: 'MEDICAL', address: 'x' }), /医療機関コード/, 'BR-10');
throwsMsg(() => G.saveMaster('m_product', { product_code: 'EXO-A', name: '重複', storage_class: 'M80', shelf_life_days: 1, regulatory_class: 'OTHER' }), /既に使われ/, 'コード重複');
M = G.getMasters();
const freezer = M.locations.find(l => l.location_code === 'L-M80-01');
const qFreezer = M.locations.find(l => l.location_code === 'Q-M80-01');
const fridge = M.locations.find(l => l.location_code === 'L-COLD-01');
ok(true, 'マスタ登録・入力チェック');

// 入荷
throwsMsg(() => G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'X', receiptDate: '2026-10-01', expiresOn: '2028-01-01',
  quantity: 5, unitPrice: 100, locationId: fridge.id }), /入庫できません/, 'BR-06 温度区分不一致');
throwsMsg(() => G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'X', receiptDate: '2026-10-05', expiresOn: '2028-01-01',
  quantity: 5, unitPrice: 100, locationId: freezer.id }), /当日以前/, '未来日の入荷');
const r1 = G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'SUP-1', receiptDate: '2026-10-01', manufacturedOn: '2026-09-01',
  quantity: 10, unitPrice: 10000, arrivalTemp: -50, locationId: freezer.id });
ok(r1.lotNo === 'EXO-A-261001-01' && /許容範囲/.test(r1.warning), '入荷：ロット採番・到着温度警告');
const r1b = G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'SUP-1', receiptDate: '2026-10-02', manufacturedOn: '2026-09-01',
  quantity: 10, unitPrice: 12000, locationId: freezer.id });
ok(r1b.lotNo === r1.lotNo, '分納（検品待ちロット）は同一ロットに加算');
throwsMsg(() => G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'SUP-1', receiptDate: '2026-10-02', expiresOn: '2029-01-01',
  quantity: 1, unitPrice: 1, locationId: freezer.id }), /使用期限 2028-08-31/, 'BR-15 使用期限不一致');
const r2 = G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'SUP-2', receiptDate: '2026-10-03', expiresOn: '2027-06-30',
  quantity: 5, unitPrice: 9000, locationId: freezer.id });
let lots = G.getLots([]);
const lot1 = lots.find(l => l.lot_no === r1.lotNo), lot2 = lots.find(l => l.lot_no === r2.lotNo);
ok(lot1.stock === 20 && lot1.unit_cost === 11000 && lot1.expires_on === '2028-08-31', '移動平均原価・使用期限自動計算（製造日＋有効期間）');

// 検品前は出荷不可
throwsMsg(() => G.createShipment({ customerId: salon.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /不足/, '検品待ちは引当不可');
throwsMsg(() => G.changeLotStatus({ lotId: lot1.id, to: 'RELEASED', coaConfirmed: false }), /COA/, 'BR-08 COA未確認');
G.changeLotStatus({ lotId: lot1.id, to: 'RELEASED', coaConfirmed: true });
G.changeLotStatus({ lotId: lot2.id, to: 'RELEASED', coaConfirmed: true });
throwsMsg(() => G.registerReceipt({ supplierId: sup.id, productId: prod.id, supplierLotNo: 'SUP-1', receiptDate: '2026-10-04', manufacturedOn: '2026-09-01',
  quantity: 1, unitPrice: 1, locationId: freezer.id }), /合格のため/, '合格済ロットへの分納は不可');
ok(true, '検品：COA必須・合格');

// 販売可否
throwsMsg(() => G.createShipment({ customerId: lab.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /販売できません/, 'BR-09');
// FEFO：lot2（期限2027-06-30）→ lot1 の順。同一出荷内の2行でも二重割当しない
const s1 = G.createShipment({ customerId: salon.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 4 }, { productId: prod.id, quantity: 3, unitPrice: 28000 }] });
ok(s1.lines.length === 3 && s1.lines[0].lot_no === r2.lotNo && s1.lines[0].quantity === 4 &&
   s1.lines[1].lot_no === r2.lotNo && s1.lines[1].quantity === 1 && s1.lines[2].lot_no === r1.lotNo && s1.lines[2].quantity === 2, 'FEFO・同一出荷内の二重割当なし');
ok(s1.shipment_no === 'SH-202610-0001' && s1.amount === 4 * 30000 + 3 * 28000, '出荷番号・金額');
throwsMsg(() => G.createShipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 100 }] }), /不足 82/, '在庫不足は全体を登録しない');
ok(G.getRecentShipments().length === 1, '在庫不足時は出荷が作成されない');
// 最低出荷残期間：lot2 は 2027-06-30。出荷日 2027-04-15 では残76日 < 90 → lot1 のみ
const s2 = G.createShipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 5 }] });
ok(s2.lines.every(l => l.lot_no === r1.lotNo), 'lot2 が尽きた後は lot1 から引当');

// 返品
const lineB = s2.lines[0];
throwsMsg(() => G.registerReturn({ shipmentLineId: lineB.id, quantity: 6, reason: 'x', quarantineLocationId: qFreezer.id, disposition: 'DISPOSE' }), /返品可能数（5）/, 'BR-12');
throwsMsg(() => G.registerReturn({ shipmentLineId: lineB.id, quantity: 1, reason: 'x', quarantineLocationId: freezer.id, disposition: 'DISPOSE' }), /隔離保管場所/, '返品は隔離保管場所へ');
G.registerReturn({ shipmentLineId: lineB.id, quantity: 1, reason: '破損', quarantineLocationId: qFreezer.id, disposition: 'DISPOSE' });
G.registerReturn({ shipmentLineId: lineB.id, quantity: 1, reason: '誤発注', quarantineLocationId: qFreezer.id, disposition: 'RESTOCK', restockLocationId: freezer.id });
let inv = G.getInventory();
ok(inv.find(i => i.lot_no === r1.lotNo && !i.quarantine).qty === 20 - 2 - 5 + 1, '返品：廃棄は在庫に戻らず、在庫戻しは通常保管場所へ');
ok(!inv.some(i => i.quarantine && i.qty !== 0), '隔離保管場所に残数なし');

// ロット追跡
let tl = G.traceLot('sup-1')[0];
ok(tl.shipments.length === 2 && tl.shipments.find(s => s.customer === 'サロンB').net === 3 && tl.shipments.find(s => s.customer === 'サロンA').net === 2, 'ロット追跡（仕入先ロット番号・部分一致）');
let tc = G.traceCustomer(salonB.id);
ok(tc.rows.length === 1 && tc.rows[0].net === 3, '顧客追跡（正味）');

// 回収
throwsMsg(() => G.createRecall({ title: 't', reason: 'r', severity: 'II', lotIds: [] }), /1件以上/, '回収：ロット必須');
const rc = G.createRecall({ title: '粒子濃度逸脱', reason: 'COA再試験で規格外', severity: 'II', lotIds: [lot1.id] });
const tA = rc.targets.find(t => t.customer === 'サロンA'), tB = rc.targets.find(t => t.customer === 'サロンB');
ok(rc.status === 'IN_PROGRESS' && tA.shipped_qty === 2 && tB.shipped_qty === 3 && rc.targets.length === 2, '回収対象抽出（出荷正味）');
ok(G.getLots(['RECALLED']).length === 1, '回収ロットは RECALLED');
throwsMsg(() => G.createShipment({ customerId: salonB.id, shippedOn: '2026-10-04', lines: [{ productId: prod.id, quantity: 1 }] }), /不足/, '回収ロットは出荷停止');
// 回収品の返品（処置は自動で廃棄）
const ret = G.registerReturn({ shipmentLineId: lineB.id, quantity: 2, reason: '回収', quarantineLocationId: qFreezer.id, disposition: 'RESTOCK', restockLocationId: freezer.id });
ok(ret.recall && ret.disposition === 'DISPOSE', '回収品は廃棄に強制（BR-18）');
let rv = G.listRecalls()[0];
ok(rv.targets.find(t => t.customer === 'サロンB').recovered_qty === 2 && rv.targets.find(t => t.customer === 'サロンB').status === 'NOT_CONTACTED', '回収数を返品から集計');
// 回収不能1 → RECOVERED
G.updateRecallTarget({ targetId: tB.id, contactedOn: '2026-10-04', contactMethod: '電話', status: 'CONTACTED', unrecoverableQty: 1 });
rv = G.listRecalls()[0];
ok(rv.targets.find(t => t.customer === 'サロンB').status === 'RECOVERED', '回収＋回収不能 ≥ 出荷正味で RECOVERED');
throwsMsg(() => G.closeRecall(rc.id), /未完了の回収対象顧客が 1 件/, 'P-14 未完了あり');
// サロンA の出荷を取消 → 再抽出で A=0・CLOSED
G.cancelShipment(s1.id, '誤出荷');
rv = G.listRecalls()[0];
const tA2 = rv.targets.find(t => t.customer === 'サロンA');
ok(tA2.shipped_qty === 0 && tA2.status === 'CLOSED', '出荷取消で回収対象を自動クローズ');
const closed = G.closeRecall(rc.id);
ok(closed.status === 'CLOSED' && /未処分の在庫/.test(closed.warning), '回収完了（残在庫の警告）');

// 状態遷移
throwsMsg(() => G.changeLotStatus({ lotId: lot1.id, to: 'RELEASED', coaConfirmed: true }), /変更できません/, 'RECALLED からは変更不可');
G.changeLotStatus({ lotId: lot2.id, to: 'HOLD', reason: '温度確認' });
G.changeLotStatus({ lotId: lot2.id, to: 'RELEASED', reason: '問題なし', coaConfirmed: true });
ok(true, 'HOLD→RELEASED（検品済）');

// 日次チェック：期限切れ判定と整合性
env.setNow(new Date('2027-07-05T03:00:00Z'));
const dc = G.dailyCheck();
ok(dc.expired.indexOf(r2.lotNo) >= 0 && dc.mismatches.length === 0, '日次チェック：期限切れ判定・在庫＝移動履歴');
ok(mails.length === 1, '日次チェック結果メール');
// 不整合の検出
sheets.t_inventory._data()[1][3] = '999';
ok(G.dailyCheck().mismatches.length === 1, '在庫不整合を検出');

console.log('ALL ' + passed + ' CHECKS PASSED');
