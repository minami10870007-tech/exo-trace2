/**
 * EXO-TRACE 簡易版（Google スプレッドシート＋Apps Script）
 *
 * 詳細設計書 v1.3 のテーブル・業務ルールに沿って、ロット単位の
 *   入荷 → 受入検品 → 出荷（FEFO自動引当） → 返品 → ロット/顧客追跡 → 回収
 * を実装した第1段階（設計書 非機能要件「簡易版（段階導入）」）。
 *
 * 簡易版で省略している主な点（Webアプリ本格版で実装）
 *   - 発注・受注の伝票（出荷登録で引当と確定を同時に行う。そのため引当済数は持たない）
 *   - 納品先（顧客＝納品先として扱う）、ロール別権限（スプレッドシートの共有権限で管理）
 *   - 合格済ロットへの分納（新しい仕入先ロット番号で登録する）、温度記録、添付ファイル
 *
 * 使い方
 *   1. メニュー「EXO-TRACE」>「初期設定」を実行（シート作成）
 *   2. 「EXO-TRACE」>「画面を開く」で操作画面を表示
 *   3. 「EXO-TRACE」>「日次チェックのトリガー設定」で期限切れ判定・整合性チェックを毎日実行
 */

const TZ = 'Asia/Tokyo';

/** テーブル定義（シート名＝テーブル物理名、1行目＝カラム名） */
const SCHEMA = {
  m_supplier: ['id', 'supplier_code', 'name', 'contact_name', 'phone', 'email', 'is_active'],
  m_product: ['id', 'product_code', 'name', 'storage_class', 'shelf_life_days', 'min_remaining_days',
    'regulatory_class', 'list_price', 'reorder_point', 'is_active'],
  m_customer: ['id', 'customer_code', 'name', 'customer_type', 'medical_inst_code', 'address',
    'contact_name', 'phone', 'email', 'is_active'],
  m_location: ['id', 'location_code', 'name', 'storage_class', 'temp_min', 'temp_max', 'is_quarantine', 'is_active'],
  m_sales_rule: ['id', 'regulatory_class', 'customer_type', 'allowed'],
  t_lot: ['id', 'lot_no', 'product_id', 'supplier_id', 'supplier_lot_no', 'manufactured_on', 'expires_on',
    'received_on', 'unit_cost', 'status', 'status_reason', 'inspected_by', 'inspected_at'],
  t_receipt: ['id', 'receipt_no', 'supplier_id', 'receipt_date', 'product_id', 'supplier_lot_no', 'manufactured_on',
    'expires_on', 'arrival_temp', 'location_id', 'quantity', 'unit_price', 'lot_id', 'status', 'created_at', 'created_by'],
  t_inventory: ['id', 'lot_id', 'location_id', 'on_hand_qty'],
  t_stock_movement: ['id', 'moved_at', 'movement_type', 'lot_id', 'location_id', 'quantity', 'ref_type', 'ref_id',
    'reason', 'created_by'],
  t_shipment: ['id', 'shipment_no', 'customer_id', 'shipped_on', 'status', 'note', 'created_at', 'created_by'],
  t_shipment_line: ['id', 'shipment_id', 'product_id', 'lot_id', 'location_id', 'quantity', 'unit_price', 'unit_cost', 'status'],
  t_return: ['id', 'return_no', 'shipment_line_id', 'recall_target_id', 'returned_on', 'quantity', 'reason',
    'disposition', 'location_id', 'restock_location_id', 'created_at', 'created_by'],
  t_recall: ['id', 'recall_no', 'title', 'reason', 'severity', 'started_on', 'closed_on', 'status'],
  t_recall_lot: ['id', 'recall_id', 'lot_id'],
  t_recall_target: ['id', 'recall_id', 'customer_id', 'lot_id', 'shipped_qty', 'recovered_qty', 'unrecoverable_qty',
    'contacted_on', 'contact_method', 'status', 'close_reason'],
  t_lot_status_history: ['id', 'lot_id', 'from_status', 'to_status', 'reason', 'changed_at', 'changed_by'],
};

/** コード定義（設計書「コード定義」シートと同じ値） */
const CODES = {
  storage_class: { M80: '-80℃', M20: '-20℃', COLD: '2-8℃', RT: '室温' },
  regulatory_class: { COSMETIC_RAW: '化粧品原料', RESEARCH_USE: '研究用', MEDICAL_USE: '医療機関向け', OTHER: 'その他' },
  customer_type: { MEDICAL: '医療機関', SALON: 'サロン', DISTRIBUTOR: '代理店', RESEARCH: '研究機関', OTHER: 'その他' },
  lot_status: { QUARANTINE: '検品待ち', RELEASED: '合格', HOLD: '保留', REJECTED: '不合格', RECALLED: '回収', EXPIRED: '期限切れ', VOID: '無効' },
  target_status: { NOT_CONTACTED: '未連絡', CONTACTED: '連絡済', RECOVERED: '回収済', CLOSED: 'クローズ' },
};

/** QA によるロットステータス変更で許可する遷移（設計書「状態遷移」P-02 / P-15） */
const LOT_TRANSITIONS = {
  QUARANTINE: ['RELEASED', 'REJECTED', 'HOLD'],
  RELEASED: ['HOLD'],
  HOLD: ['RELEASED', 'QUARANTINE', 'REJECTED'],
};

const MASTER_TABLES = ['m_supplier', 'm_product', 'm_customer', 'm_location'];

// ============================================================================
// メニュー・画面
// ============================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('EXO-TRACE')
    .addItem('画面を開く', 'openApp')
    .addSeparator()
    .addItem('初期設定（シート作成）', 'setup')
    .addItem('日次チェックを今すぐ実行', 'dailyCheck')
    .addItem('日次チェックのトリガー設定（毎日1時）', 'installDailyTrigger')
    .addToUi();
}

function openApp() {
  const html = HtmlService.createHtmlOutputFromFile('index').setWidth(1200).setHeight(800);
  SpreadsheetApp.getUi().showModelessDialog(html, 'EXO-TRACE エクソソーム仕入・販売トレーサビリティ');
}

/** ウェブアプリとしてデプロイした場合の入口 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('EXO-TRACE')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** シートを作成し、初期データ（保管場所・販売可否ルール）を投入する。何度実行しても既存データは消さない。 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const cols = SCHEMA[name];
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); // 日付・コードの自動変換を防ぐ
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#1F4E5F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  });
  withLock_(() => {
    const T = ctx_();
    if (T.m_location.rows.length === 0) {
      [['L-M80-01', '-80℃冷凍庫#1', 'M80', -90, -60, false], ['Q-M80-01', '-80℃隔離庫（返品・保留）', 'M80', -90, -60, true],
        ['L-COLD-01', '2-8℃冷蔵庫#1', 'COLD', 2, 8, false], ['Q-COLD-01', '2-8℃隔離庫（返品・保留）', 'COLD', 2, 8, true]]
        .forEach(r => T.m_location.insert({ location_code: r[0], name: r[1], storage_class: r[2], temp_min: r[3], temp_max: r[4], is_quarantine: r[5], is_active: true }));
    }
    if (T.m_sales_rule.rows.length === 0) {
      // 初期値は仮設定。法的区分の確認（設計書 課題 Q-01）後に「マスタ」画面で必ず見直すこと
      const allow = { COSMETIC_RAW: ['MEDICAL', 'SALON', 'DISTRIBUTOR'], RESEARCH_USE: ['RESEARCH'], MEDICAL_USE: ['MEDICAL'], OTHER: [] };
      Object.keys(CODES.regulatory_class).forEach(rc => Object.keys(CODES.customer_type).forEach(ct =>
        T.m_sales_rule.insert({ regulatory_class: rc, customer_type: ct, allowed: allow[rc].indexOf(ct) >= 0 })));
    }
  });
  try { SpreadsheetApp.getUi().alert('初期設定が完了しました。メニュー「EXO-TRACE」>「画面を開く」から利用できます。'); } catch (e) { /* トリガー実行時 */ }
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyCheck').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyCheck').timeBased().everyDays(1).atHour(1).inTimezone(TZ).create();
  SpreadsheetApp.getUi().alert('日次チェック（毎日1時）を設定しました。');
}

// ============================================================================
// 共通ユーティリティ
// ============================================================================

/** スクリプトロックで直列化する（設計書 P-00 の簡易版：全更新処理を1本ずつ実行） */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** シートを1つのテーブルとして読み書きする */
function tbl_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。メニュー「EXO-TRACE」>「初期設定」を実行してください。');
  const cols = SCHEMA[name];
  const last = sh.getLastRow();
  const values = last > 1 ? sh.getRange(2, 1, last - 1, cols.length).getValues() : [];
  const rows = values.map((v, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = v[j] instanceof Date ? fmtDate_(v[j]) : v[j]; });
    return o;
  }).filter(o => o.id !== '' && o.id !== null);
  const toArr = o => cols.map(c => (o[c] === undefined || o[c] === null) ? '' : String(o[c]));
  return {
    rows: rows,
    find: pred => rows.find(pred),
    filter: pred => rows.filter(pred),
    byId: id => rows.find(r => same_(r.id, id)),
    insert(obj) {
      obj.id = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
      const row = sh.getLastRow() + 1;
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
      sh.getRange(row, 1, 1, cols.length).setNumberFormat('@').setValues([toArr(obj)]);
      obj._row = row;
      rows.push(obj);
      return obj;
    },
    update(obj, fields) {
      Object.assign(obj, fields);
      sh.getRange(obj._row, 1, 1, cols.length).setValues([toArr(obj)]);
      return obj;
    },
  };
}

/** 1回の処理の中でテーブルを遅延読込・キャッシュする */
function ctx_() {
  const cache = {};
  return new Proxy(cache, { get: (o, k) => (o[k] || (o[k] = tbl_(k))) });
}

function same_(a, b) { return String(a) === String(b); }
function num_(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function bool_(v) { return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function fmtDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function today_() { return fmtDate_(new Date()); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function user_() { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'unknown'); }
function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function addDays_(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function round2_(n) { return Math.round(n * 100) / 100; }
function must_(row, label) { if (!row) throw new Error(label + 'が見つかりません。画面を再読込してください。'); return row; }
function posInt_(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(label + 'は1以上の整数で入力してください。');
  return n;
}
function lotLabel_(s) { return CODES.lot_status[s] || s; }

/** 伝票番号 例: SH-202610-0001 */
function nextNo_(table, field, prefix, date) {
  const head = prefix + '-' + date.slice(0, 4) + date.slice(5, 7) + '-';
  const n = table.filter(r => String(r[field]).indexOf(head) === 0).length + 1;
  return head + ('000' + n).slice(-4);
}

/** 在庫を増減し、在庫移動履歴を記録する（BR-02：在庫は必ず移動履歴と一緒に更新） */
function move_(T, type, lotId, locId, qty, refType, refId, reason) {
  const row = T.t_inventory.find(r => same_(r.lot_id, lotId) && same_(r.location_id, locId));
  const newQty = (row ? num_(row.on_hand_qty) : 0) + qty;
  if (newQty < 0) throw new Error('在庫が不足しています（ロットID ' + lotId + '、保管場所ID ' + locId + '）。');
  if (row) T.t_inventory.update(row, { on_hand_qty: newQty });
  else T.t_inventory.insert({ lot_id: lotId, location_id: locId, on_hand_qty: newQty });
  T.t_stock_movement.insert({ moved_at: now_(), movement_type: type, lot_id: lotId, location_id: locId, quantity: qty,
    ref_type: refType, ref_id: refId, reason: reason || '', created_by: user_() });
}

function lotStock_(T, lotId) {
  return T.t_inventory.filter(r => same_(r.lot_id, lotId)).reduce((s, r) => s + num_(r.on_hand_qty), 0);
}

function setLotStatus_(T, lot, to, reason, by) {
  const from = lot.status;
  T.t_lot.update(lot, { status: to, status_reason: reason || '' });
  T.t_lot_status_history.insert({ lot_id: lot.id, from_status: from, to_status: to, reason: reason || '', changed_at: now_(), changed_by: by || user_() });
}

/** 通常返品（回収品でない返品）の合計 */
function returnedQty_(T, lineId, recallOnly) {
  return T.t_return.filter(r => same_(r.shipment_line_id, lineId) &&
    (recallOnly === undefined ? true : (recallOnly ? r.recall_target_id !== '' : r.recall_target_id === '')))
    .reduce((s, r) => s + num_(r.quantity), 0);
}

function openRecallIdsForLot_(T, lotId) {
  return T.t_recall_lot.filter(rl => same_(rl.lot_id, lotId)).map(rl => rl.recall_id)
    .filter(id => { const rc = T.t_recall.byId(id); return rc && rc.status !== 'CLOSED'; });
}

// ============================================================================
// 画面用の参照API
// ============================================================================

function getConfig() {
  return { codes: CODES, today: today_(), user: user_() };
}

function getMasters() {
  const T = ctx_();
  const strip = rows => rows.map(r => { const o = Object.assign({}, r); delete o._row; return o; });
  return {
    suppliers: strip(T.m_supplier.rows), products: strip(T.m_product.rows),
    customers: strip(T.m_customer.rows), locations: strip(T.m_location.rows), salesRules: strip(T.m_sales_rule.rows),
  };
}

function getDashboard() {
  const T = ctx_();
  const today = today_();
  const lots = T.t_lot.rows.map(l => lotView_(T, l));
  const stocked = lots.filter(l => l.stock > 0);
  const lowStock = T.m_product.filter(p => bool_(p.is_active) && num_(p.reorder_point) > 0).map(p => {
    const avail = stocked.filter(l => same_(l.product_id, p.id) && l.status === 'RELEASED').reduce((s, l) => s + l.availableStock, 0);
    return { product: p.name, available: avail, reorderPoint: num_(p.reorder_point) };
  }).filter(x => x.available <= x.reorderPoint);
  const recalls = T.t_recall.filter(r => r.status !== 'CLOSED').map(r => recallView_(T, r));
  return {
    expiringSoon: stocked.filter(l => l.expires_on >= today && l.daysLeft <= 90 && ['RELEASED', 'HOLD', 'QUARANTINE'].indexOf(l.status) >= 0)
      .sort((a, b) => a.daysLeft - b.daysLeft),
    expired: stocked.filter(l => l.status === 'EXPIRED' || l.expires_on < today),
    quarantine: lots.filter(l => l.status === 'QUARANTINE'),
    hold: stocked.filter(l => l.status === 'HOLD'),
    lowStock: lowStock,
    recalls: recalls,
  };
}

function lotView_(T, l) {
  const p = T.m_product.byId(l.product_id) || {};
  const s = T.m_supplier.byId(l.supplier_id) || {};
  const inv = T.t_inventory.filter(r => same_(r.lot_id, l.id) && num_(r.on_hand_qty) !== 0);
  const stock = inv.reduce((a, r) => a + num_(r.on_hand_qty), 0);
  const availableStock = inv.filter(r => { const loc = T.m_location.byId(r.location_id); return loc && !bool_(loc.is_quarantine); })
    .reduce((a, r) => a + num_(r.on_hand_qty), 0);
  return {
    id: l.id, lot_no: l.lot_no, supplier_lot_no: l.supplier_lot_no, product_id: l.product_id, product: p.name, product_code: p.product_code,
    supplier: s.name, manufactured_on: l.manufactured_on, expires_on: l.expires_on, received_on: l.received_on,
    daysLeft: l.expires_on ? daysBetween_(today_(), l.expires_on) : null, unit_cost: num_(l.unit_cost),
    status: l.status, statusLabel: lotLabel_(l.status), status_reason: l.status_reason, inspected_at: l.inspected_at,
    stock: stock, availableStock: availableStock,
  };
}

function getLots(statuses) {
  const T = ctx_();
  return T.t_lot.filter(l => !statuses || statuses.length === 0 || statuses.indexOf(l.status) >= 0)
    .map(l => lotView_(T, l)).sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
}

function getInventory() {
  const T = ctx_();
  const today = today_();
  return T.t_inventory.filter(r => num_(r.on_hand_qty) !== 0).map(r => {
    const l = T.t_lot.byId(r.lot_id) || {};
    const p = T.m_product.byId(l.product_id) || {};
    const loc = T.m_location.byId(r.location_id) || {};
    const daysLeft = l.expires_on ? daysBetween_(today, l.expires_on) : null;
    const allocatable = l.status === 'RELEASED' && !bool_(loc.is_quarantine) && daysLeft !== null && daysLeft >= num_(p.min_remaining_days);
    return { product: p.name, product_code: p.product_code, lot_no: l.lot_no, supplier_lot_no: l.supplier_lot_no,
      location: loc.name, quarantine: bool_(loc.is_quarantine), expires_on: l.expires_on, daysLeft: daysLeft,
      status: l.status, statusLabel: lotLabel_(l.status), qty: num_(r.on_hand_qty), allocatable: allocatable };
  }).sort((a, b) => (a.product_code + a.expires_on).localeCompare(b.product_code + b.expires_on));
}

function getRecentShipments(limit) {
  const T = ctx_();
  return T.t_shipment.rows.slice().sort((a, b) => num_(b.id) - num_(a.id)).slice(0, limit || 30).map(s => shipmentView_(T, s));
}

function getShipmentByNo(no) {
  const T = ctx_();
  const s = T.t_shipment.find(x => String(x.shipment_no).toUpperCase() === String(no || '').trim().toUpperCase());
  if (!s) throw new Error('出荷番号「' + no + '」が見つかりません。');
  return shipmentView_(T, s);
}

function shipmentView_(T, s) {
  const c = T.m_customer.byId(s.customer_id) || {};
  const lines = T.t_shipment_line.filter(l => same_(l.shipment_id, s.id)).map(l => {
    const lot = T.t_lot.byId(l.lot_id) || {};
    const p = T.m_product.byId(l.product_id) || {};
    const returned = returnedQty_(T, l.id);
    return { id: l.id, product: p.name, lot_no: lot.lot_no, expires_on: lot.expires_on, lot_status: lotLabel_(lot.status),
      quantity: num_(l.quantity), unit_price: num_(l.unit_price), returned: returned, returnable: l.status === 'SHIPPED' ? num_(l.quantity) - returned : 0,
      status: l.status };
  });
  return { id: s.id, shipment_no: s.shipment_no, customer: c.name, customer_id: s.customer_id, shipped_on: s.shipped_on,
    status: s.status, note: s.note, lines: lines, amount: lines.reduce((a, l) => a + l.quantity * l.unit_price, 0) };
}

// ============================================================================
// マスタ更新
// ============================================================================

function saveMaster(table, data) {
  if (MASTER_TABLES.indexOf(table) < 0) throw new Error('更新できないテーブルです: ' + table);
  return withLock_(() => {
    const T = ctx_();
    const t = T[table];
    const codeField = { m_supplier: 'supplier_code', m_product: 'product_code', m_customer: 'customer_code', m_location: 'location_code' }[table];
    const obj = {};
    SCHEMA[table].forEach(c => { if (c !== 'id' && data[c] !== undefined) obj[c] = typeof data[c] === 'string' ? data[c].trim() : data[c]; });
    if (!obj[codeField] || !obj.name) throw new Error('コードと名称は必須です。');
    if (!/^[A-Za-z0-9-]+$/.test(obj[codeField])) throw new Error('コードは英数字とハイフンのみ使用できます。');
    const dup = t.find(r => String(r[codeField]).toUpperCase() === String(obj[codeField]).toUpperCase() && !same_(r.id, data.id));
    if (dup) throw new Error('コード「' + obj[codeField] + '」は既に使われています。');
    if (table === 'm_product') {
      if (!CODES.storage_class[obj.storage_class]) throw new Error('保管温度区分を選択してください。');
      if (!CODES.regulatory_class[obj.regulatory_class]) throw new Error('規制区分を選択してください。');
      if (!(num_(obj.shelf_life_days) > 0)) throw new Error('有効期間（日）を入力してください。');
      if (obj.min_remaining_days === '' || obj.min_remaining_days === undefined) obj.min_remaining_days = 90;
    }
    if (table === 'm_customer') {
      if (!CODES.customer_type[obj.customer_type]) throw new Error('顧客区分を選択してください。');
      if (obj.customer_type === 'MEDICAL' && !obj.medical_inst_code) throw new Error('医療機関の場合、医療機関コードは必須です（BR-10）。');
      if (!obj.address) throw new Error('住所は必須です。');
    }
    if (table === 'm_location') {
      if (!CODES.storage_class[obj.storage_class]) throw new Error('保管温度区分を選択してください。');
      if (!(num_(obj.temp_min) < num_(obj.temp_max))) throw new Error('許容温度は 下限 < 上限 で入力してください。');
      if (data.id && !bool_(obj.is_active) && T.t_inventory.find(r => same_(r.location_id, data.id) && num_(r.on_hand_qty) > 0)) {
        throw new Error('在庫がある保管場所は無効化できません。');
      }
    }
    if (obj.is_active === undefined) obj.is_active = true;
    if (data.id) return clean_(t.update(must_(t.byId(data.id), 'データ'), obj));
    return clean_(t.insert(obj));
  });
}

function saveSalesRule(regulatoryClass, customerType, allowed) {
  return withLock_(() => {
    const T = ctx_();
    const r = T.m_sales_rule.find(x => x.regulatory_class === regulatoryClass && x.customer_type === customerType);
    if (r) T.m_sales_rule.update(r, { allowed: !!allowed });
    else T.m_sales_rule.insert({ regulatory_class: regulatoryClass, customer_type: customerType, allowed: !!allowed });
    return true;
  });
}

function clean_(o) { const c = Object.assign({}, o); delete c._row; return c; }

// ============================================================================
// 入荷・検品（P-01 / P-02 / P-15 の簡易版）
// ============================================================================

function registerReceipt(d) {
  return withLock_(() => {
    const T = ctx_();
    const product = must_(T.m_product.byId(d.productId), '商品');
    const supplier = must_(T.m_supplier.byId(d.supplierId), '仕入先');
    const loc = must_(T.m_location.byId(d.locationId), '保管場所');
    const qty = posInt_(d.quantity, '入荷数量');
    const price = Number(d.unitPrice);
    if (d.unitPrice === '' || isNaN(price) || price < 0) throw new Error('仕入単価は0以上で入力してください。');
    const supLot = String(d.supplierLotNo || '').trim();
    if (!supLot) throw new Error('仕入先ロット番号を入力してください。');
    const today = today_();
    if (!isDate_(d.receiptDate) || d.receiptDate > today) throw new Error('入荷日は当日以前の日付を入力してください。');
    if (d.manufacturedOn && (!isDate_(d.manufacturedOn) || d.manufacturedOn > d.receiptDate)) throw new Error('製造日は入荷日以前の日付を入力してください。');
    const expires = d.expiresOn || (d.manufacturedOn ? addDays_(d.manufacturedOn, num_(product.shelf_life_days)) : '');
    if (!isDate_(expires)) throw new Error('使用期限を入力してください（製造日が不明な場合は必須）。');
    if (expires <= d.receiptDate) throw new Error('使用期限は入荷日より後の日付を入力してください。');
    if (loc.storage_class !== product.storage_class || bool_(loc.is_quarantine) || !bool_(loc.is_active)) {
      throw new Error('保管場所「' + loc.name + '」には入庫できません（温度区分が商品と異なるか、隔離保管場所です）。');
    }

    let lot = T.t_lot.find(l => same_(l.supplier_id, supplier.id) && same_(l.product_id, product.id) && l.supplier_lot_no === supLot);
    if (lot) {
      if (lot.expires_on !== expires) {
        throw new Error('仕入先ロット番号「' + supLot + '」は既に使用期限 ' + lot.expires_on + ' で登録されています。使用期限を確認してください。');
      }
      if (lot.status === 'VOID') {
        setLotStatus_(T, lot, 'QUARANTINE', '再入荷');
      } else if (lot.status !== 'QUARANTINE') {
        throw new Error('ロット「' + lot.lot_no + '」は' + lotLabel_(lot.status) + 'のため、簡易版では追加入荷できません。' +
          '（合格済ロットへの分納はQA確認が必要です。仕入先に確認のうえ別の仕入先ロット番号で登録してください）');
      }
      const stock = lotStock_(T, lot.id);
      T.t_lot.update(lot, { unit_cost: round2_((stock * num_(lot.unit_cost) + qty * price) / (stock + qty)) });
    } else {
      const head = product.product_code + '-' + d.receiptDate.slice(2, 4) + d.receiptDate.slice(5, 7) + d.receiptDate.slice(8, 10) + '-';
      const seq = T.t_lot.filter(l => String(l.lot_no).indexOf(head) === 0).length + 1;
      lot = T.t_lot.insert({ lot_no: head + ('0' + seq).slice(-2), product_id: product.id, supplier_id: supplier.id, supplier_lot_no: supLot,
        manufactured_on: d.manufacturedOn || '', expires_on: expires, received_on: d.receiptDate, unit_cost: price,
        status: 'QUARANTINE', status_reason: '', inspected_by: '', inspected_at: '' });
      T.t_lot_status_history.insert({ lot_id: lot.id, from_status: '', to_status: 'QUARANTINE', reason: '入荷', changed_at: now_(), changed_by: user_() });
    }

    const rc = T.t_receipt.insert({ receipt_no: nextNo_(T.t_receipt, 'receipt_no', 'RC', d.receiptDate), supplier_id: supplier.id,
      receipt_date: d.receiptDate, product_id: product.id, supplier_lot_no: supLot, manufactured_on: d.manufacturedOn || '',
      expires_on: expires, arrival_temp: d.arrivalTemp === undefined ? '' : d.arrivalTemp, location_id: loc.id, quantity: qty,
      unit_price: price, lot_id: lot.id, status: 'CONFIRMED', created_at: now_(), created_by: user_() });
    move_(T, 'RECEIPT', lot.id, loc.id, qty, 'receipt', rc.id);

    let warning = '';
    if (d.arrivalTemp !== '' && d.arrivalTemp !== undefined && d.arrivalTemp !== null &&
        (num_(d.arrivalTemp) < num_(loc.temp_min) || num_(d.arrivalTemp) > num_(loc.temp_max))) {
      warning = '到着時温度が許容範囲（' + loc.temp_min + '〜' + loc.temp_max + '℃）外です。検品時にQAが評価してください。';
    }
    return { receiptNo: rc.receipt_no, lotNo: lot.lot_no, warning: warning };
  });
}

/**
 * ロットステータス変更（受入検品 P-02 と QA によるステータス変更 P-15）
 * d = { lotId, to, reason, coaConfirmed }
 */
function changeLotStatus(d) {
  return withLock_(() => {
    const T = ctx_();
    const lot = must_(T.t_lot.byId(d.lotId), 'ロット');
    const from = lot.status;
    if ((LOT_TRANSITIONS[from] || []).indexOf(d.to) < 0) {
      throw new Error('現在のステータス（' + lotLabel_(from) + '）から「' + lotLabel_(d.to) + '」には変更できません。');
    }
    const reason = String(d.reason || '').trim();
    if (d.to === 'RELEASED') {
      if (!d.coaConfirmed) throw new Error('合格にはCOA（試験成績書）の確認が必要です（BR-08）。');
      if (from === 'HOLD' && !lot.inspected_at) throw new Error('未検品のロットは「検品待ち」に戻してから検品してください（BR-17）。');
      if (from === 'HOLD' && !reason) throw new Error('保留解除の理由を入力してください。');
    } else if (!reason) {
      throw new Error('理由を入力してください。');
    }
    if (from === 'HOLD' && d.to === 'QUARANTINE' && lot.inspected_at) {
      throw new Error('検品済のロットは「合格」または「不合格」に変更してください。');
    }
    if (from === 'QUARANTINE') T.t_lot.update(lot, { inspected_by: user_(), inspected_at: now_() });
    setLotStatus_(T, lot, d.to, reason || '検品合格（COA確認済）');
    return lotView_(T, lot);
  });
}

// ============================================================================
// 出荷（P-04 FEFO自動引当 ＋ P-05 出荷確定 を同時に実行）
// ============================================================================

/**
 * d = { customerId, shippedOn, note, lines: [{ productId, quantity, unitPrice }] }
 * 全明細の在庫が揃わない場合は何も登録しない（全量引当できたときだけ確定）。
 */
function createShipment(d) {
  return withLock_(() => {
    const T = ctx_();
    const customer = must_(T.m_customer.byId(d.customerId), '顧客');
    if (!bool_(customer.is_active)) throw new Error('無効な顧客には出荷できません。');
    if (!isDate_(d.shippedOn)) throw new Error('出荷日を入力してください。');
    const lines = (d.lines || []).filter(l => l && l.productId);
    if (lines.length === 0) throw new Error('出荷明細を1行以上入力してください。');

    const used = {}; // 同一出荷内で既に割り当てた数量（inventory.id → 数量）
    const plan = [];
    lines.forEach((ln, i) => {
      const p = must_(T.m_product.byId(ln.productId), '商品');
      const qty = posInt_(ln.quantity, (i + 1) + '行目の数量');
      const price = Number(ln.unitPrice === '' || ln.unitPrice === undefined ? p.list_price : ln.unitPrice);
      if (isNaN(price) || price < 0) throw new Error((i + 1) + '行目の単価が不正です。');
      const rule = T.m_sales_rule.find(r => r.regulatory_class === p.regulatory_class && r.customer_type === customer.customer_type);
      if (!rule || !bool_(rule.allowed)) {
        throw new Error('商品「' + p.name + '」（' + (CODES.regulatory_class[p.regulatory_class] || p.regulatory_class) +
          '）は顧客区分「' + (CODES.customer_type[customer.customer_type] || customer.customer_type) + '」に販売できません（BR-09）。');
      }
      // BR-04 引当可能在庫 → BR-05 FEFO（使用期限→入荷日→保管場所）
      const candidates = T.t_inventory.filter(inv => num_(inv.on_hand_qty) - (used[inv.id] || 0) > 0).map(inv => {
        const lot = T.t_lot.byId(inv.lot_id);
        const loc = T.m_location.byId(inv.location_id);
        return { inv: inv, lot: lot, loc: loc };
      }).filter(c => c.lot && c.loc && same_(c.lot.product_id, p.id) && c.lot.status === 'RELEASED' && !bool_(c.loc.is_quarantine) &&
        daysBetween_(d.shippedOn, c.lot.expires_on) >= num_(p.min_remaining_days))
        .sort((a, b) => (a.lot.expires_on + a.lot.received_on).localeCompare(b.lot.expires_on + b.lot.received_on) || num_(a.loc.id) - num_(b.loc.id));
      let remain = qty;
      candidates.forEach(c => {
        if (remain <= 0) return;
        const take = Math.min(remain, num_(c.inv.on_hand_qty) - (used[c.inv.id] || 0));
        used[c.inv.id] = (used[c.inv.id] || 0) + take;
        plan.push({ product: p, lot: c.lot, loc: c.loc, qty: take, price: price });
        remain -= take;
      });
      if (remain > 0) {
        throw new Error('商品「' + p.name + '」の引当可能在庫が不足しています（不足 ' + remain + '）。' +
          '合格済・残期間 ' + num_(p.min_remaining_days) + '日以上・隔離保管場所以外の在庫のみ引当できます。');
      }
    });

    const sh = T.t_shipment.insert({ shipment_no: nextNo_(T.t_shipment, 'shipment_no', 'SH', d.shippedOn), customer_id: customer.id,
      shipped_on: d.shippedOn, status: 'SHIPPED', note: d.note || '', created_at: now_(), created_by: user_() });
    plan.forEach(a => {
      const line = T.t_shipment_line.insert({ shipment_id: sh.id, product_id: a.product.id, lot_id: a.lot.id, location_id: a.loc.id,
        quantity: a.qty, unit_price: a.price, unit_cost: num_(a.lot.unit_cost), status: 'SHIPPED' });
      move_(T, 'SHIPMENT', a.lot.id, a.loc.id, -a.qty, 'shipment_line', line.id);
    });
    return shipmentView_(T, sh);
  });
}

/** 出荷取消（P-06）：赤伝で在庫を戻す。返品がある出荷は取消不可。 */
function cancelShipment(shipmentId, reason) {
  return withLock_(() => {
    const T = ctx_();
    const sh = must_(T.t_shipment.byId(shipmentId), '出荷');
    if (sh.status !== 'SHIPPED') throw new Error('この出荷は既に取消されています。');
    if (!String(reason || '').trim()) throw new Error('取消理由を入力してください。');
    const lines = T.t_shipment_line.filter(l => same_(l.shipment_id, sh.id) && l.status === 'SHIPPED');
    if (lines.some(l => returnedQty_(T, l.id) > 0)) throw new Error('返品が登録されている出荷は取消できません。');
    const lotIds = {};
    lines.forEach(l => {
      move_(T, 'CANCEL', l.lot_id, l.location_id, num_(l.quantity), 'shipment_line', l.id, reason);
      T.t_shipment_line.update(l, { status: 'CANCELLED' });
      lotIds[l.lot_id] = true;
    });
    T.t_shipment.update(sh, { status: 'CANCELLED', note: (sh.note ? sh.note + ' / ' : '') + '取消：' + reason });
    Object.keys(lotIds).forEach(lotId => openRecallIdsForLot_(T, lotId).forEach(id => extractTargets_(T, T.t_recall.byId(id))));
    return shipmentView_(T, sh);
  });
}

// ============================================================================
// 返品（P-07 の簡易版：登録と処置判定を同時に行う）
// ============================================================================

/**
 * d = { shipmentLineId, quantity, reason, returnedOn, quarantineLocationId, disposition: 'RESTOCK'|'DISPOSE', restockLocationId }
 * 回収中ロットの返品は自動的に回収品として扱い、処置は廃棄のみ（BR-18）。
 */
function registerReturn(d) {
  return withLock_(() => {
    const T = ctx_();
    const line = must_(T.t_shipment_line.byId(d.shipmentLineId), '出荷明細');
    if (line.status !== 'SHIPPED') throw new Error('取消済の出荷明細には返品を登録できません。');
    const sh = T.t_shipment.byId(line.shipment_id);
    const lot = T.t_lot.byId(line.lot_id);
    const product = T.m_product.byId(line.product_id);
    const qty = posInt_(d.quantity, '返品数量');
    const returnable = num_(line.quantity) - returnedQty_(T, line.id);
    if (qty > returnable) throw new Error('返品数量が返品可能数（' + returnable + '）を超えています（BR-12）。');
    if (!String(d.reason || '').trim()) throw new Error('返品理由を入力してください。');
    const returnedOn = d.returnedOn || today_();
    if (!isDate_(returnedOn)) throw new Error('返品日が不正です。');
    const qLoc = must_(T.m_location.byId(d.quarantineLocationId), '受入保管場所');
    if (!bool_(qLoc.is_quarantine) || qLoc.storage_class !== product.storage_class) {
      throw new Error('受入保管場所は、商品と同じ温度区分の隔離保管場所を選択してください。');
    }

    // 回収中ロットなら回収対象に紐づける（P-07 ステップ2）
    let target = null;
    openRecallIdsForLot_(T, lot.id).some(rid => {
      target = T.t_recall_target.find(t => same_(t.recall_id, rid) && same_(t.customer_id, sh.customer_id) && same_(t.lot_id, lot.id));
      return !!target;
    });
    let disposition = d.disposition;
    if (target) disposition = 'DISPOSE';
    if (disposition !== 'RESTOCK' && disposition !== 'DISPOSE') throw new Error('処置（在庫戻し／廃棄）を選択してください。');
    let rLoc = null;
    if (disposition === 'RESTOCK') {
      if (lot.status !== 'RELEASED') throw new Error('ロットが合格（RELEASED）ではないため在庫に戻せません。廃棄を選択してください。');
      rLoc = must_(T.m_location.byId(d.restockLocationId), '戻し保管場所');
      if (bool_(rLoc.is_quarantine) || rLoc.storage_class !== product.storage_class || !bool_(rLoc.is_active)) {
        throw new Error('戻し保管場所は、商品と同じ温度区分の通常保管場所を選択してください。');
      }
    }

    const rt = T.t_return.insert({ return_no: nextNo_(T.t_return, 'return_no', 'RT', returnedOn), shipment_line_id: line.id,
      recall_target_id: target ? target.id : '', returned_on: returnedOn, quantity: qty, reason: d.reason, disposition: disposition,
      location_id: qLoc.id, restock_location_id: rLoc ? rLoc.id : '', created_at: now_(), created_by: user_() });
    move_(T, 'RETURN', lot.id, qLoc.id, qty, 'return', rt.id);
    if (disposition === 'RESTOCK') {
      move_(T, 'TRANSFER_OUT', lot.id, qLoc.id, -qty, 'return', rt.id);
      move_(T, 'TRANSFER_IN', lot.id, rLoc.id, qty, 'return', rt.id);
    } else {
      move_(T, 'DISPOSE', lot.id, qLoc.id, -qty, 'return', rt.id, '返品廃棄：' + d.reason);
    }

    if (target) {
      const recovered = T.t_return.filter(r => same_(r.recall_target_id, target.id)).reduce((s, r) => s + num_(r.quantity), 0);
      const fields = { recovered_qty: recovered };
      if (recovered + num_(target.unrecoverable_qty) >= num_(target.shipped_qty)) fields.status = 'RECOVERED';
      T.t_recall_target.update(target, fields);
    } else {
      openRecallIdsForLot_(T, lot.id).forEach(id => extractTargets_(T, T.t_recall.byId(id)));
    }
    return { returnNo: rt.return_no, recall: !!target, disposition: disposition };
  });
}

// ============================================================================
// トレース（SQL-01 / SQL-02 相当）
// ============================================================================

/** ロット番号（社内・仕入先どちらでも、部分一致）→ 出荷先顧客 */
function traceLot(query) {
  const T = ctx_();
  const q = String(query || '').trim().toUpperCase();
  if (!q) throw new Error('ロット番号を入力してください。');
  const lots = T.t_lot.filter(l => String(l.lot_no).toUpperCase().indexOf(q) >= 0 || String(l.supplier_lot_no).toUpperCase().indexOf(q) >= 0).slice(0, 20);
  return lots.map(l => {
    const view = lotView_(T, l);
    view.inventory = T.t_inventory.filter(r => same_(r.lot_id, l.id) && num_(r.on_hand_qty) !== 0)
      .map(r => ({ location: (T.m_location.byId(r.location_id) || {}).name, qty: num_(r.on_hand_qty) }));
    view.shipments = T.t_shipment_line.filter(sl => same_(sl.lot_id, l.id)).map(sl => {
      const sh = T.t_shipment.byId(sl.shipment_id) || {};
      const c = T.m_customer.byId(sh.customer_id) || {};
      const returned = returnedQty_(T, sl.id, false);
      const recalled = returnedQty_(T, sl.id, true);
      return { customer_code: c.customer_code, customer: c.name, phone: c.phone, email: c.email, shipment_no: sh.shipment_no,
        shipped_on: sh.shipped_on, status: sl.status, quantity: num_(sl.quantity), returned: returned, recalled: recalled,
        net: sl.status === 'SHIPPED' ? num_(sl.quantity) - returned - recalled : 0 };
    }).sort((a, b) => String(a.shipped_on).localeCompare(String(b.shipped_on)));
    const totals = {};
    T.t_stock_movement.filter(m => same_(m.lot_id, l.id)).forEach(m => { totals[m.movement_type] = (totals[m.movement_type] || 0) + num_(m.quantity); });
    view.movementTotals = totals;
    view.history = T.t_lot_status_history.filter(h => same_(h.lot_id, l.id)).map(clean_);
    return view;
  });
}

/** 顧客 → 購入ロット */
function traceCustomer(customerId, from, to) {
  const T = ctx_();
  const c = must_(T.m_customer.byId(customerId), '顧客');
  const rows = [];
  T.t_shipment.filter(s => same_(s.customer_id, c.id) && s.status === 'SHIPPED' && (!from || s.shipped_on >= from) && (!to || s.shipped_on <= to))
    .forEach(s => T.t_shipment_line.filter(sl => same_(sl.shipment_id, s.id) && sl.status === 'SHIPPED').forEach(sl => {
      const lot = T.t_lot.byId(sl.lot_id) || {};
      const p = T.m_product.byId(sl.product_id) || {};
      const returned = returnedQty_(T, sl.id);
      rows.push({ shipped_on: s.shipped_on, shipment_no: s.shipment_no, product: p.name, lot_no: lot.lot_no, supplier_lot_no: lot.supplier_lot_no,
        expires_on: lot.expires_on, lot_status: lot.status, lot_status_label: lotLabel_(lot.status), quantity: num_(sl.quantity),
        returned: returned, net: num_(sl.quantity) - returned });
    }));
  rows.sort((a, b) => String(b.shipped_on).localeCompare(String(a.shipped_on)));
  return { customer: clean_(c), rows: rows };
}

// ============================================================================
// 回収（P-08 / P-14 / P-18 / P-19 の簡易版）
// ============================================================================

/** d = { title, reason, severity, lotIds: [] } */
function createRecall(d) {
  return withLock_(() => {
    const T = ctx_();
    if (!String(d.title || '').trim() || !String(d.reason || '').trim()) throw new Error('件名と回収理由は必須です。');
    if (['I', 'II', 'III'].indexOf(d.severity) < 0) throw new Error('重大度（クラスI/II/III）を選択してください。');
    const lotIds = (d.lotIds || []).filter(String);
    if (lotIds.length === 0) throw new Error('対象ロットを1件以上選択してください。');
    const lots = lotIds.map(id => must_(T.t_lot.byId(id), 'ロット'));
    if (lots.some(l => l.status === 'VOID')) throw new Error('無効（VOID）のロットは回収対象に指定できません。');
    const today = today_();
    const rc = T.t_recall.insert({ recall_no: 'RCL-' + today.slice(0, 4) + '-' + ('00' + (T.t_recall.filter(r => String(r.recall_no).indexOf('RCL-' + today.slice(0, 4)) === 0).length + 1)).slice(-3),
      title: d.title.trim(), reason: d.reason.trim(), severity: d.severity, started_on: today, closed_on: '', status: 'OPEN' });
    lots.forEach(l => {
      T.t_recall_lot.insert({ recall_id: rc.id, lot_id: l.id });
      if (l.status !== 'RECALLED') setLotStatus_(T, l, 'RECALLED', '回収 ' + rc.recall_no + '：' + d.reason.trim());
    });
    extractTargets_(T, rc);
    return recallView_(T, rc);
  });
}

/** 回収対象抽出（SQL-03 相当。何度実行しても同じ結果） */
function extractTargets_(T, recall) {
  if (!recall || recall.status === 'CLOSED') return;
  const lotIds = T.t_recall_lot.filter(rl => same_(rl.recall_id, recall.id)).map(rl => String(rl.lot_id));
  const net = {}; // "customerId|lotId" → 出荷正味数量（出荷−通常返品）
  T.t_recall_target.filter(t => same_(t.recall_id, recall.id)).forEach(t => { net[t.customer_id + '|' + t.lot_id] = 0; });
  T.t_shipment_line.filter(sl => sl.status === 'SHIPPED' && lotIds.indexOf(String(sl.lot_id)) >= 0).forEach(sl => {
    const sh = T.t_shipment.byId(sl.shipment_id);
    const key = sh.customer_id + '|' + sl.lot_id;
    net[key] = (net[key] || 0) + num_(sl.quantity) - returnedQty_(T, sl.id, false);
  });
  Object.keys(net).forEach(key => {
    const parts = key.split('|');
    const qty = net[key];
    const t = T.t_recall_target.find(x => same_(x.recall_id, recall.id) && same_(x.customer_id, parts[0]) && same_(x.lot_id, parts[1]));
    if (!t) {
      T.t_recall_target.insert({ recall_id: recall.id, customer_id: parts[0], lot_id: parts[1], shipped_qty: qty, recovered_qty: 0,
        unrecoverable_qty: 0, contacted_on: '', contact_method: '', status: qty > 0 ? 'NOT_CONTACTED' : 'CLOSED',
        close_reason: qty > 0 ? '' : '自動：出荷正味0' });
      return;
    }
    const fields = { shipped_qty: qty };
    const recovered = num_(t.recovered_qty);
    if (qty === 0 && recovered === 0) { fields.status = 'CLOSED'; fields.close_reason = '自動：出荷正味0'; }
    else if (recovered + num_(t.unrecoverable_qty) >= qty) fields.status = 'RECOVERED';
    T.t_recall_target.update(t, fields);
  });
  if (recall.status === 'OPEN') T.t_recall.update(recall, { status: 'IN_PROGRESS' });
}

function recallView_(T, r) {
  const targets = T.t_recall_target.filter(t => same_(t.recall_id, r.id)).map(t => {
    const c = T.m_customer.byId(t.customer_id) || {};
    const l = T.t_lot.byId(t.lot_id) || {};
    return Object.assign(clean_(t), { shipped_qty: num_(t.shipped_qty), recovered_qty: num_(t.recovered_qty),
      unrecoverable_qty: num_(t.unrecoverable_qty), customer: c.name, customer_code: c.customer_code, contact_name: c.contact_name, phone: c.phone,
      email: c.email, lot_no: l.lot_no, statusLabel: CODES.target_status[t.status] || t.status });
  });
  const active = targets.filter(t => num_(t.shipped_qty) > 0);
  const shipped = active.reduce((s, t) => s + num_(t.shipped_qty), 0);
  const done = active.reduce((s, t) => s + Math.min(num_(t.shipped_qty), num_(t.recovered_qty) + num_(t.unrecoverable_qty)), 0);
  return Object.assign(clean_(r), {
    lots: T.t_recall_lot.filter(rl => same_(rl.recall_id, r.id)).map(rl => (T.t_lot.byId(rl.lot_id) || {}).lot_no),
    targets: targets,
    contactedRate: active.length ? Math.round(100 * active.filter(t => t.status !== 'NOT_CONTACTED').length / active.length) : 100,
    recoveredRate: shipped ? Math.round(100 * done / shipped) : 100,
    remainingStock: T.t_recall_lot.filter(rl => same_(rl.recall_id, r.id)).reduce((s, rl) => s + lotStock_(T, rl.lot_id), 0),
  });
}

function listRecalls() {
  const T = ctx_();
  return T.t_recall.rows.slice().sort((a, b) => num_(b.id) - num_(a.id)).map(r => recallView_(T, r));
}

function reextractRecall(recallId) {
  return withLock_(() => {
    const T = ctx_();
    const r = must_(T.t_recall.byId(recallId), '回収案件');
    if (r.status === 'CLOSED') throw new Error('完了した回収案件です。');
    extractTargets_(T, r);
    return recallView_(T, r);
  });
}

/** d = { targetId, contactedOn, contactMethod, status: 'CONTACTED'|'CLOSED'|'', unrecoverableQty, closeReason } */
function updateRecallTarget(d) {
  return withLock_(() => {
    const T = ctx_();
    const t = must_(T.t_recall_target.byId(d.targetId), '回収対象');
    const r = T.t_recall.byId(t.recall_id);
    if (r.status === 'CLOSED') throw new Error('完了した回収案件は更新できません。');
    const fields = {};
    if (d.contactedOn !== undefined) {
      if (d.contactedOn && !isDate_(d.contactedOn)) throw new Error('連絡日が不正です。');
      fields.contacted_on = d.contactedOn;
    }
    if (d.contactMethod !== undefined) fields.contact_method = d.contactMethod;
    if (d.unrecoverableQty !== undefined && d.unrecoverableQty !== '') {
      const u = Number(d.unrecoverableQty);
      if (!Number.isInteger(u) || u < 0) throw new Error('回収不能数量は0以上の整数で入力してください。');
      if (u + num_(t.recovered_qty) > num_(t.shipped_qty)) throw new Error('回収数量＋回収不能数量が出荷正味数量を超えています。');
      fields.unrecoverable_qty = u;
    }
    if (d.status === 'CLOSED') {
      if (!String(d.closeReason || '').trim()) throw new Error('クローズ理由を入力してください。');
      fields.status = 'CLOSED';
      fields.close_reason = d.closeReason.trim();
    } else if (d.status === 'CONTACTED' && t.status === 'NOT_CONTACTED') {
      fields.status = 'CONTACTED';
    }
    Object.assign(t, fields);
    if (t.status !== 'CLOSED' && num_(t.shipped_qty) > 0 && num_(t.recovered_qty) + num_(t.unrecoverable_qty) >= num_(t.shipped_qty)) {
      fields.status = 'RECOVERED';
    }
    T.t_recall_target.update(t, fields);
    return recallView_(T, r);
  });
}

function closeRecall(recallId) {
  return withLock_(() => {
    const T = ctx_();
    const r = must_(T.t_recall.byId(recallId), '回収案件');
    if (r.status === 'CLOSED') throw new Error('既に完了しています。');
    const open = T.t_recall_target.filter(t => same_(t.recall_id, r.id) && t.status !== 'RECOVERED' && t.status !== 'CLOSED');
    if (open.length) throw new Error('未完了の回収対象顧客が ' + open.length + ' 件あるため完了できません。');
    T.t_recall.update(r, { status: 'CLOSED', closed_on: today_() });
    const view = recallView_(T, r);
    view.warning = view.remainingStock > 0 ? '回収対象ロットに未処分の在庫（' + view.remainingStock + '）が残っています。' : '';
    return view;
  });
}

// ============================================================================
// 日次チェック（B-01 期限切れ判定 ／ B-03 在庫整合性チェック）
// ============================================================================

function dailyCheck() {
  const result = withLock_(() => {
    const T = ctx_();
    const today = today_();
    const expired = [];
    T.t_lot.filter(l => (l.status === 'RELEASED' || l.status === 'HOLD') && l.expires_on && l.expires_on < today).forEach(l => {
      setLotStatus_(T, l, 'EXPIRED', '期限到来（日次チェック）', 'system');
      expired.push(l.lot_no);
    });
    const sums = {};
    T.t_stock_movement.rows.forEach(m => { const k = m.lot_id + '|' + m.location_id; sums[k] = (sums[k] || 0) + num_(m.quantity); });
    const seen = {};
    const mismatches = [];
    T.t_inventory.rows.forEach(i => {
      const k = i.lot_id + '|' + i.location_id;
      seen[k] = true;
      if (num_(i.on_hand_qty) !== (sums[k] || 0)) mismatches.push(k + ' 在庫=' + i.on_hand_qty + ' 移動合計=' + (sums[k] || 0));
    });
    Object.keys(sums).forEach(k => { if (!seen[k] && sums[k] !== 0) mismatches.push(k + ' 在庫行なし 移動合計=' + sums[k]); });
    return { expired: expired, mismatches: mismatches };
  });
  const body = [];
  if (result.expired.length) body.push('期限切れにしたロット：' + result.expired.join(', '));
  if (result.mismatches.length) body.push('在庫と移動履歴の不一致（ロットID|保管場所ID）：\n' + result.mismatches.join('\n'));
  const dash = getDashboard();
  if (dash.expiringSoon.length) body.push('使用期限90日以内の在庫ロット：' + dash.expiringSoon.map(l => l.lot_no + '（残' + l.daysLeft + '日）').join(', '));
  if (dash.lowStock.length) body.push('発注点以下の商品：' + dash.lowStock.map(x => x.product + '（' + x.available + '）').join(', '));
  if (body.length) {
    const to = Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail(to, '[EXO-TRACE] 日次チェック結果 ' + today_(), body.join('\n\n'));
  }
  return result;
}
