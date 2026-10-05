-- 生成元: docs/design/tools/spec.py（手修正しないこと）
-- 作成順は外部キーの依存順

-- ユーザー：システム利用者
CREATE TABLE m_user (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(50) NOT NULL,
  role VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  mfa_secret VARCHAR(255),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id) DEFERRABLE INITIALLY DEFERRED,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id) DEFERRABLE INITIALLY DEFERRED,
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_user IS 'ユーザー';
COMMENT ON COLUMN m_user.id IS 'ユーザーID';
COMMENT ON COLUMN m_user.email IS 'メール（ログインID）';
COMMENT ON COLUMN m_user.name IS '氏名';
COMMENT ON COLUMN m_user.role IS 'ロール';
COMMENT ON COLUMN m_user.password_hash IS 'パスワードハッシュ';
COMMENT ON COLUMN m_user.mfa_secret IS '2要素認証シークレット';
COMMENT ON COLUMN m_user.failed_login_count IS 'ログイン失敗回数';
COMMENT ON COLUMN m_user.is_active IS '有効フラグ';
COMMENT ON COLUMN m_user.created_at IS '作成日時';
COMMENT ON COLUMN m_user.created_by IS '作成者';
COMMENT ON COLUMN m_user.updated_at IS '更新日時';
COMMENT ON COLUMN m_user.updated_by IS '更新者';
COMMENT ON COLUMN m_user.version IS '版数';

-- 仕入先：仕入先（製造元・輸入元）
CREATE TABLE m_supplier (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  country VARCHAR(2) NOT NULL DEFAULT 'JP',
  address VARCHAR(200),
  contact_name VARCHAR(50),
  phone VARCHAR(20),
  email VARCHAR(254),
  payment_terms VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_supplier IS '仕入先';
COMMENT ON COLUMN m_supplier.id IS '仕入先ID';
COMMENT ON COLUMN m_supplier.supplier_code IS '仕入先コード';
COMMENT ON COLUMN m_supplier.name IS '仕入先名';
COMMENT ON COLUMN m_supplier.country IS '国';
COMMENT ON COLUMN m_supplier.address IS '住所';
COMMENT ON COLUMN m_supplier.contact_name IS '担当者名';
COMMENT ON COLUMN m_supplier.phone IS '電話番号';
COMMENT ON COLUMN m_supplier.email IS 'メール';
COMMENT ON COLUMN m_supplier.payment_terms IS '支払条件';
COMMENT ON COLUMN m_supplier.is_active IS '有効フラグ';
COMMENT ON COLUMN m_supplier.created_at IS '作成日時';
COMMENT ON COLUMN m_supplier.created_by IS '作成者';
COMMENT ON COLUMN m_supplier.updated_at IS '更新日時';
COMMENT ON COLUMN m_supplier.updated_by IS '更新者';
COMMENT ON COLUMN m_supplier.version IS '版数';

-- 顧客：販売先（請求先）
CREATE TABLE m_customer (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  customer_type VARCHAR(20) NOT NULL,
  medical_inst_code VARCHAR(20),
  representative VARCHAR(50),
  contact_name VARCHAR(50),
  postal_code VARCHAR(8),
  address VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(254),
  credit_limit NUMERIC(12,0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_customer IS '顧客';
COMMENT ON COLUMN m_customer.id IS '顧客ID';
COMMENT ON COLUMN m_customer.customer_code IS '顧客コード';
COMMENT ON COLUMN m_customer.name IS '顧客名';
COMMENT ON COLUMN m_customer.customer_type IS '顧客区分';
COMMENT ON COLUMN m_customer.medical_inst_code IS '医療機関コード';
COMMENT ON COLUMN m_customer.representative IS '代表者名';
COMMENT ON COLUMN m_customer.contact_name IS '担当者名';
COMMENT ON COLUMN m_customer.postal_code IS '郵便番号';
COMMENT ON COLUMN m_customer.address IS '住所';
COMMENT ON COLUMN m_customer.phone IS '電話番号';
COMMENT ON COLUMN m_customer.email IS 'メール';
COMMENT ON COLUMN m_customer.credit_limit IS '与信限度額（円）';
COMMENT ON COLUMN m_customer.is_active IS '有効フラグ';
COMMENT ON COLUMN m_customer.created_at IS '作成日時';
COMMENT ON COLUMN m_customer.created_by IS '作成者';
COMMENT ON COLUMN m_customer.updated_at IS '更新日時';
COMMENT ON COLUMN m_customer.updated_by IS '更新者';
COMMENT ON COLUMN m_customer.version IS '版数';

-- 保管場所：倉庫・冷凍庫・冷蔵庫等
CREATE TABLE m_location (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location_code VARCHAR(20) NOT NULL,
  name VARCHAR(50) NOT NULL,
  storage_class VARCHAR(10) NOT NULL,
  temp_min NUMERIC(5,1) NOT NULL,
  temp_max NUMERIC(5,1) NOT NULL,
  is_quarantine BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_location IS '保管場所';
COMMENT ON COLUMN m_location.id IS '保管場所ID';
COMMENT ON COLUMN m_location.location_code IS '保管場所コード';
COMMENT ON COLUMN m_location.name IS '保管場所名';
COMMENT ON COLUMN m_location.storage_class IS '保管温度区分';
COMMENT ON COLUMN m_location.temp_min IS '許容温度下限（℃）';
COMMENT ON COLUMN m_location.temp_max IS '許容温度上限（℃）';
COMMENT ON COLUMN m_location.is_quarantine IS '隔離保管フラグ';
COMMENT ON COLUMN m_location.is_active IS '有効フラグ';
COMMENT ON COLUMN m_location.created_at IS '作成日時';
COMMENT ON COLUMN m_location.created_by IS '作成者';
COMMENT ON COLUMN m_location.updated_at IS '更新日時';
COMMENT ON COLUMN m_location.updated_by IS '更新者';
COMMENT ON COLUMN m_location.version IS '版数';

-- 販売可否ルール：規制区分×顧客区分の販売可否
CREATE TABLE m_sales_rule (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  regulatory_class VARCHAR(20) NOT NULL,
  customer_type VARCHAR(20) NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_sales_rule IS '販売可否ルール';
COMMENT ON COLUMN m_sales_rule.id IS 'ルールID';
COMMENT ON COLUMN m_sales_rule.regulatory_class IS '規制区分';
COMMENT ON COLUMN m_sales_rule.customer_type IS '顧客区分';
COMMENT ON COLUMN m_sales_rule.allowed IS '販売可否';
COMMENT ON COLUMN m_sales_rule.created_at IS '作成日時';
COMMENT ON COLUMN m_sales_rule.created_by IS '作成者';
COMMENT ON COLUMN m_sales_rule.updated_at IS '更新日時';
COMMENT ON COLUMN m_sales_rule.updated_by IS '更新者';
COMMENT ON COLUMN m_sales_rule.version IS '版数';

-- 回収案件：回収（リコール）案件
CREATE TABLE t_recall (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recall_no VARCHAR(20) NOT NULL,
  title VARCHAR(100) NOT NULL,
  reason TEXT NOT NULL,
  severity VARCHAR(10) NOT NULL,
  started_on DATE NOT NULL,
  closed_on DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_recall IS '回収案件';
COMMENT ON COLUMN t_recall.id IS '回収案件ID';
COMMENT ON COLUMN t_recall.recall_no IS '回収番号';
COMMENT ON COLUMN t_recall.title IS '件名';
COMMENT ON COLUMN t_recall.reason IS '回収理由';
COMMENT ON COLUMN t_recall.severity IS '重大度';
COMMENT ON COLUMN t_recall.started_on IS '開始日';
COMMENT ON COLUMN t_recall.closed_on IS '完了日';
COMMENT ON COLUMN t_recall.status IS 'ステータス';
COMMENT ON COLUMN t_recall.created_at IS '作成日時';
COMMENT ON COLUMN t_recall.created_by IS '作成者';
COMMENT ON COLUMN t_recall.updated_at IS '更新日時';
COMMENT ON COLUMN t_recall.updated_by IS '更新者';
COMMENT ON COLUMN t_recall.version IS '版数';

-- 添付ファイル：COA・輸入書類等
CREATE TABLE t_attachment (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type VARCHAR(30) NOT NULL,
  owner_id BIGINT NOT NULL,
  doc_type VARCHAR(20) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_attachment IS '添付ファイル';
COMMENT ON COLUMN t_attachment.id IS '添付ID';
COMMENT ON COLUMN t_attachment.owner_type IS '所属種別';
COMMENT ON COLUMN t_attachment.owner_id IS '所属ID';
COMMENT ON COLUMN t_attachment.doc_type IS '書類種別';
COMMENT ON COLUMN t_attachment.file_name IS 'ファイル名';
COMMENT ON COLUMN t_attachment.storage_key IS '保存先キー';
COMMENT ON COLUMN t_attachment.sha256 IS 'ハッシュ値';
COMMENT ON COLUMN t_attachment.created_at IS '作成日時';
COMMENT ON COLUMN t_attachment.created_by IS '作成者';
COMMENT ON COLUMN t_attachment.updated_at IS '更新日時';
COMMENT ON COLUMN t_attachment.updated_by IS '更新者';
COMMENT ON COLUMN t_attachment.version IS '版数';

-- 監査ログ：操作履歴（追記のみ）
CREATE TABLE t_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  user_id BIGINT REFERENCES m_user(id),
  action VARCHAR(20) NOT NULL,
  target_table VARCHAR(50),
  target_id BIGINT,
  before_json JSONB,
  after_json JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id)
);
COMMENT ON TABLE t_audit_log IS '監査ログ';
COMMENT ON COLUMN t_audit_log.id IS 'ID';
COMMENT ON COLUMN t_audit_log.occurred_at IS '発生日時';
COMMENT ON COLUMN t_audit_log.user_id IS 'ユーザーID';
COMMENT ON COLUMN t_audit_log.action IS '操作';
COMMENT ON COLUMN t_audit_log.target_table IS '対象テーブル';
COMMENT ON COLUMN t_audit_log.target_id IS '対象ID';
COMMENT ON COLUMN t_audit_log.before_json IS '変更前';
COMMENT ON COLUMN t_audit_log.after_json IS '変更後';
COMMENT ON COLUMN t_audit_log.ip_address IS 'IPアドレス';
COMMENT ON COLUMN t_audit_log.created_at IS '作成日時';
COMMENT ON COLUMN t_audit_log.created_by IS '作成者';

-- 商品：エクソソーム製品・原料
CREATE TABLE m_product (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  supplier_id BIGINT REFERENCES m_supplier(id),
  source_type VARCHAR(20) NOT NULL,
  form VARCHAR(20) NOT NULL,
  particle_conc NUMERIC(20,0),
  volume_ml NUMERIC(8,2),
  unit VARCHAR(10) NOT NULL DEFAULT '本',
  storage_class VARCHAR(10) NOT NULL,
  shelf_life_days INTEGER NOT NULL,
  min_remaining_days INTEGER NOT NULL DEFAULT 90,
  regulatory_class VARCHAR(20) NOT NULL,
  standard_cost NUMERIC(12,2),
  list_price NUMERIC(12,2),
  reorder_point INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_product IS '商品';
COMMENT ON COLUMN m_product.id IS '商品ID';
COMMENT ON COLUMN m_product.product_code IS '商品コード';
COMMENT ON COLUMN m_product.name IS '商品名';
COMMENT ON COLUMN m_product.supplier_id IS '主仕入先ID';
COMMENT ON COLUMN m_product.source_type IS '由来';
COMMENT ON COLUMN m_product.form IS '形態';
COMMENT ON COLUMN m_product.particle_conc IS '粒子濃度（個/mL）';
COMMENT ON COLUMN m_product.volume_ml IS '内容量（mL）';
COMMENT ON COLUMN m_product.unit IS '販売単位';
COMMENT ON COLUMN m_product.storage_class IS '保管温度区分';
COMMENT ON COLUMN m_product.shelf_life_days IS '有効期間（日）';
COMMENT ON COLUMN m_product.min_remaining_days IS '最低出荷残期間（日）';
COMMENT ON COLUMN m_product.regulatory_class IS '規制区分';
COMMENT ON COLUMN m_product.standard_cost IS '標準原価（円）';
COMMENT ON COLUMN m_product.list_price IS '標準売価（円）';
COMMENT ON COLUMN m_product.reorder_point IS '発注点';
COMMENT ON COLUMN m_product.is_active IS '有効フラグ';
COMMENT ON COLUMN m_product.created_at IS '作成日時';
COMMENT ON COLUMN m_product.created_by IS '作成者';
COMMENT ON COLUMN m_product.updated_at IS '更新日時';
COMMENT ON COLUMN m_product.updated_by IS '更新者';
COMMENT ON COLUMN m_product.version IS '版数';

-- 納品先：顧客ごとの納品先
CREATE TABLE m_ship_to (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES m_customer(id),
  name VARCHAR(100) NOT NULL,
  postal_code VARCHAR(8),
  address VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  contact_name VARCHAR(50),
  email VARCHAR(254),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE m_ship_to IS '納品先';
COMMENT ON COLUMN m_ship_to.id IS '納品先ID';
COMMENT ON COLUMN m_ship_to.customer_id IS '顧客ID';
COMMENT ON COLUMN m_ship_to.name IS '納品先名';
COMMENT ON COLUMN m_ship_to.postal_code IS '郵便番号';
COMMENT ON COLUMN m_ship_to.address IS '住所';
COMMENT ON COLUMN m_ship_to.phone IS '電話番号';
COMMENT ON COLUMN m_ship_to.contact_name IS '担当者名';
COMMENT ON COLUMN m_ship_to.email IS 'メール';
COMMENT ON COLUMN m_ship_to.is_default IS '既定フラグ';
COMMENT ON COLUMN m_ship_to.is_active IS '有効フラグ';
COMMENT ON COLUMN m_ship_to.created_at IS '作成日時';
COMMENT ON COLUMN m_ship_to.created_by IS '作成者';
COMMENT ON COLUMN m_ship_to.updated_at IS '更新日時';
COMMENT ON COLUMN m_ship_to.updated_by IS '更新者';
COMMENT ON COLUMN m_ship_to.version IS '版数';

-- 発注：発注ヘッダ
CREATE TABLE t_purchase_order (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_no VARCHAR(20) NOT NULL,
  supplier_id BIGINT NOT NULL REFERENCES m_supplier(id),
  order_date DATE NOT NULL,
  expected_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  approved_by BIGINT REFERENCES m_user(id),
  approved_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_purchase_order IS '発注';
COMMENT ON COLUMN t_purchase_order.id IS '発注ID';
COMMENT ON COLUMN t_purchase_order.po_no IS '発注番号';
COMMENT ON COLUMN t_purchase_order.supplier_id IS '仕入先ID';
COMMENT ON COLUMN t_purchase_order.order_date IS '発注日';
COMMENT ON COLUMN t_purchase_order.expected_date IS '入荷予定日';
COMMENT ON COLUMN t_purchase_order.status IS 'ステータス';
COMMENT ON COLUMN t_purchase_order.approved_by IS '承認者';
COMMENT ON COLUMN t_purchase_order.approved_at IS '承認日時';
COMMENT ON COLUMN t_purchase_order.note IS '備考';
COMMENT ON COLUMN t_purchase_order.created_at IS '作成日時';
COMMENT ON COLUMN t_purchase_order.created_by IS '作成者';
COMMENT ON COLUMN t_purchase_order.updated_at IS '更新日時';
COMMENT ON COLUMN t_purchase_order.updated_by IS '更新者';
COMMENT ON COLUMN t_purchase_order.version IS '版数';

-- 温度記録：保管場所の温度記録
CREATE TABLE t_temperature_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location_id BIGINT NOT NULL REFERENCES m_location(id),
  measured_at TIMESTAMPTZ NOT NULL,
  temperature NUMERIC(5,1) NOT NULL,
  is_excursion BOOLEAN NOT NULL DEFAULT false,
  source VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id)
);
COMMENT ON TABLE t_temperature_log IS '温度記録';
COMMENT ON COLUMN t_temperature_log.id IS 'ID';
COMMENT ON COLUMN t_temperature_log.location_id IS '保管場所ID';
COMMENT ON COLUMN t_temperature_log.measured_at IS '測定日時';
COMMENT ON COLUMN t_temperature_log.temperature IS '温度（℃）';
COMMENT ON COLUMN t_temperature_log.is_excursion IS '逸脱フラグ';
COMMENT ON COLUMN t_temperature_log.source IS '入力元';
COMMENT ON COLUMN t_temperature_log.created_at IS '作成日時';
COMMENT ON COLUMN t_temperature_log.created_by IS '作成者';

-- 発注明細：発注明細
CREATE TABLE t_purchase_order_line (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id BIGINT NOT NULL REFERENCES t_purchase_order(id),
  line_no INTEGER NOT NULL,
  product_id BIGINT NOT NULL REFERENCES m_product(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_purchase_order_line IS '発注明細';
COMMENT ON COLUMN t_purchase_order_line.id IS '発注明細ID';
COMMENT ON COLUMN t_purchase_order_line.purchase_order_id IS '発注ID';
COMMENT ON COLUMN t_purchase_order_line.line_no IS '行番号';
COMMENT ON COLUMN t_purchase_order_line.product_id IS '商品ID';
COMMENT ON COLUMN t_purchase_order_line.quantity IS '発注数量';
COMMENT ON COLUMN t_purchase_order_line.unit_price IS '仕入単価（円）';
COMMENT ON COLUMN t_purchase_order_line.received_qty IS '入荷済数量';
COMMENT ON COLUMN t_purchase_order_line.created_at IS '作成日時';
COMMENT ON COLUMN t_purchase_order_line.created_by IS '作成者';
COMMENT ON COLUMN t_purchase_order_line.updated_at IS '更新日時';
COMMENT ON COLUMN t_purchase_order_line.updated_by IS '更新者';
COMMENT ON COLUMN t_purchase_order_line.version IS '版数';

-- 入荷：入荷ヘッダ
CREATE TABLE t_receipt (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no VARCHAR(20) NOT NULL,
  supplier_id BIGINT NOT NULL REFERENCES m_supplier(id),
  purchase_order_id BIGINT REFERENCES t_purchase_order(id),
  receipt_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_receipt IS '入荷';
COMMENT ON COLUMN t_receipt.id IS '入荷ID';
COMMENT ON COLUMN t_receipt.receipt_no IS '入荷番号';
COMMENT ON COLUMN t_receipt.supplier_id IS '仕入先ID';
COMMENT ON COLUMN t_receipt.purchase_order_id IS '発注ID';
COMMENT ON COLUMN t_receipt.receipt_date IS '入荷日';
COMMENT ON COLUMN t_receipt.status IS 'ステータス';
COMMENT ON COLUMN t_receipt.note IS '備考';
COMMENT ON COLUMN t_receipt.created_at IS '作成日時';
COMMENT ON COLUMN t_receipt.created_by IS '作成者';
COMMENT ON COLUMN t_receipt.updated_at IS '更新日時';
COMMENT ON COLUMN t_receipt.updated_by IS '更新者';
COMMENT ON COLUMN t_receipt.version IS '版数';

-- ロット：ロット（トレーサビリティの中核）
CREATE TABLE t_lot (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_no VARCHAR(30) NOT NULL,
  product_id BIGINT NOT NULL REFERENCES m_product(id),
  supplier_id BIGINT NOT NULL REFERENCES m_supplier(id),
  supplier_lot_no VARCHAR(50) NOT NULL,
  manufactured_on DATE,
  expires_on DATE NOT NULL,
  received_on DATE NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL,
  measured_particle_conc NUMERIC(20,0),
  status VARCHAR(20) NOT NULL DEFAULT 'QUARANTINE',
  status_reason TEXT,
  inspected_by BIGINT REFERENCES m_user(id),
  inspected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_lot IS 'ロット';
COMMENT ON COLUMN t_lot.id IS 'ロットID';
COMMENT ON COLUMN t_lot.lot_no IS '社内ロット番号';
COMMENT ON COLUMN t_lot.product_id IS '商品ID';
COMMENT ON COLUMN t_lot.supplier_id IS '仕入先ID';
COMMENT ON COLUMN t_lot.supplier_lot_no IS '仕入先ロット番号';
COMMENT ON COLUMN t_lot.manufactured_on IS '製造日';
COMMENT ON COLUMN t_lot.expires_on IS '使用期限';
COMMENT ON COLUMN t_lot.received_on IS '初回入荷日';
COMMENT ON COLUMN t_lot.unit_cost IS '原価単価（円）';
COMMENT ON COLUMN t_lot.measured_particle_conc IS '実測粒子濃度（個/mL）';
COMMENT ON COLUMN t_lot.status IS 'ロットステータス';
COMMENT ON COLUMN t_lot.status_reason IS '最新ステータス変更理由';
COMMENT ON COLUMN t_lot.inspected_by IS '検品者';
COMMENT ON COLUMN t_lot.inspected_at IS '検品日時';
COMMENT ON COLUMN t_lot.created_at IS '作成日時';
COMMENT ON COLUMN t_lot.created_by IS '作成者';
COMMENT ON COLUMN t_lot.updated_at IS '更新日時';
COMMENT ON COLUMN t_lot.updated_by IS '更新者';
COMMENT ON COLUMN t_lot.version IS '版数';

-- 受注：受注ヘッダ
CREATE TABLE t_sales_order (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  so_no VARCHAR(20) NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES m_customer(id),
  ship_to_id BIGINT NOT NULL REFERENCES m_ship_to(id),
  order_date DATE NOT NULL,
  requested_date DATE,
  sales_user_id BIGINT NOT NULL REFERENCES m_user(id),
  credit_approved_by BIGINT REFERENCES m_user(id),
  credit_approved_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_sales_order IS '受注';
COMMENT ON COLUMN t_sales_order.id IS '受注ID';
COMMENT ON COLUMN t_sales_order.so_no IS '受注番号';
COMMENT ON COLUMN t_sales_order.customer_id IS '顧客ID';
COMMENT ON COLUMN t_sales_order.ship_to_id IS '納品先ID';
COMMENT ON COLUMN t_sales_order.order_date IS '受注日';
COMMENT ON COLUMN t_sales_order.requested_date IS '希望納期';
COMMENT ON COLUMN t_sales_order.sales_user_id IS '営業担当';
COMMENT ON COLUMN t_sales_order.credit_approved_by IS '与信超過承認者';
COMMENT ON COLUMN t_sales_order.credit_approved_at IS '与信超過承認日時';
COMMENT ON COLUMN t_sales_order.status IS 'ステータス';
COMMENT ON COLUMN t_sales_order.note IS '備考';
COMMENT ON COLUMN t_sales_order.created_at IS '作成日時';
COMMENT ON COLUMN t_sales_order.created_by IS '作成者';
COMMENT ON COLUMN t_sales_order.updated_at IS '更新日時';
COMMENT ON COLUMN t_sales_order.updated_by IS '更新者';
COMMENT ON COLUMN t_sales_order.version IS '版数';

-- 入荷明細：入荷明細（入荷明細:ロット＝多:1。分納は同一ロットに加算）
CREATE TABLE t_receipt_line (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES t_receipt(id),
  purchase_order_line_id BIGINT REFERENCES t_purchase_order_line(id),
  product_id BIGINT NOT NULL REFERENCES m_product(id),
  supplier_lot_no VARCHAR(50) NOT NULL,
  manufactured_on DATE,
  expires_on DATE NOT NULL,
  arrival_temp NUMERIC(5,1),
  lot_id BIGINT REFERENCES t_lot(id),
  split_status VARCHAR(20),
  location_id BIGINT NOT NULL REFERENCES m_location(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_receipt_line IS '入荷明細';
COMMENT ON COLUMN t_receipt_line.id IS '入荷明細ID';
COMMENT ON COLUMN t_receipt_line.receipt_id IS '入荷ID';
COMMENT ON COLUMN t_receipt_line.purchase_order_line_id IS '発注明細ID';
COMMENT ON COLUMN t_receipt_line.product_id IS '商品ID';
COMMENT ON COLUMN t_receipt_line.supplier_lot_no IS '仕入先ロット番号';
COMMENT ON COLUMN t_receipt_line.manufactured_on IS '製造日';
COMMENT ON COLUMN t_receipt_line.expires_on IS '使用期限';
COMMENT ON COLUMN t_receipt_line.arrival_temp IS '到着時温度（℃）';
COMMENT ON COLUMN t_receipt_line.lot_id IS 'ロットID';
COMMENT ON COLUMN t_receipt_line.split_status IS '分納判定';
COMMENT ON COLUMN t_receipt_line.location_id IS '入庫保管場所ID';
COMMENT ON COLUMN t_receipt_line.quantity IS '入荷数量';
COMMENT ON COLUMN t_receipt_line.unit_price IS '仕入単価（円）';
COMMENT ON COLUMN t_receipt_line.created_at IS '作成日時';
COMMENT ON COLUMN t_receipt_line.created_by IS '作成者';
COMMENT ON COLUMN t_receipt_line.updated_at IS '更新日時';
COMMENT ON COLUMN t_receipt_line.updated_by IS '更新者';
COMMENT ON COLUMN t_receipt_line.version IS '版数';

-- ロットステータス履歴：ロット判定・状態変更の経緯（追記のみ）
CREATE TABLE t_lot_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id BIGINT NOT NULL REFERENCES t_lot(id),
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  reason TEXT,
  temperature_log_id BIGINT REFERENCES t_temperature_log(id),
  recall_id BIGINT REFERENCES t_recall(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id)
);
COMMENT ON TABLE t_lot_status_history IS 'ロットステータス履歴';
COMMENT ON COLUMN t_lot_status_history.id IS 'ID';
COMMENT ON COLUMN t_lot_status_history.lot_id IS 'ロットID';
COMMENT ON COLUMN t_lot_status_history.from_status IS '変更前ステータス';
COMMENT ON COLUMN t_lot_status_history.to_status IS '変更後ステータス';
COMMENT ON COLUMN t_lot_status_history.reason IS '理由';
COMMENT ON COLUMN t_lot_status_history.temperature_log_id IS '関連温度記録ID';
COMMENT ON COLUMN t_lot_status_history.recall_id IS '関連回収案件ID';
COMMENT ON COLUMN t_lot_status_history.changed_at IS '変更日時';
COMMENT ON COLUMN t_lot_status_history.created_at IS '作成日時';
COMMENT ON COLUMN t_lot_status_history.created_by IS '作成者';

-- 在庫：ロット×保管場所の現在庫（移動履歴の集計結果）
CREATE TABLE t_inventory (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id BIGINT NOT NULL REFERENCES t_lot(id),
  location_id BIGINT NOT NULL REFERENCES m_location(id),
  on_hand_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_inventory IS '在庫';
COMMENT ON COLUMN t_inventory.id IS '在庫ID';
COMMENT ON COLUMN t_inventory.lot_id IS 'ロットID';
COMMENT ON COLUMN t_inventory.location_id IS '保管場所ID';
COMMENT ON COLUMN t_inventory.on_hand_qty IS '現在庫数';
COMMENT ON COLUMN t_inventory.allocated_qty IS '引当済数';
COMMENT ON COLUMN t_inventory.created_at IS '作成日時';
COMMENT ON COLUMN t_inventory.created_by IS '作成者';
COMMENT ON COLUMN t_inventory.updated_at IS '更新日時';
COMMENT ON COLUMN t_inventory.updated_by IS '更新者';
COMMENT ON COLUMN t_inventory.version IS '版数';

-- 在庫移動履歴：在庫の全増減の記録（追記のみ）
CREATE TABLE t_stock_movement (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  moved_at TIMESTAMPTZ NOT NULL,
  movement_type VARCHAR(20) NOT NULL,
  lot_id BIGINT NOT NULL REFERENCES t_lot(id),
  location_id BIGINT NOT NULL REFERENCES m_location(id),
  quantity INTEGER NOT NULL,
  ref_type VARCHAR(30),
  ref_id BIGINT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id)
);
COMMENT ON TABLE t_stock_movement IS '在庫移動履歴';
COMMENT ON COLUMN t_stock_movement.id IS '移動履歴ID';
COMMENT ON COLUMN t_stock_movement.moved_at IS '発生日時';
COMMENT ON COLUMN t_stock_movement.movement_type IS '移動区分';
COMMENT ON COLUMN t_stock_movement.lot_id IS 'ロットID';
COMMENT ON COLUMN t_stock_movement.location_id IS '保管場所ID';
COMMENT ON COLUMN t_stock_movement.quantity IS '数量（符号付）';
COMMENT ON COLUMN t_stock_movement.ref_type IS '参照伝票種別';
COMMENT ON COLUMN t_stock_movement.ref_id IS '参照伝票ID';
COMMENT ON COLUMN t_stock_movement.reason IS '理由';
COMMENT ON COLUMN t_stock_movement.created_at IS '作成日時';
COMMENT ON COLUMN t_stock_movement.created_by IS '作成者';

-- 受注明細：受注明細
CREATE TABLE t_sales_order_line (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_order_id BIGINT NOT NULL REFERENCES t_sales_order(id),
  line_no INTEGER NOT NULL,
  product_id BIGINT NOT NULL REFERENCES m_product(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  shipped_qty INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_sales_order_line IS '受注明細';
COMMENT ON COLUMN t_sales_order_line.id IS '受注明細ID';
COMMENT ON COLUMN t_sales_order_line.sales_order_id IS '受注ID';
COMMENT ON COLUMN t_sales_order_line.line_no IS '行番号';
COMMENT ON COLUMN t_sales_order_line.product_id IS '商品ID';
COMMENT ON COLUMN t_sales_order_line.quantity IS '受注数量';
COMMENT ON COLUMN t_sales_order_line.unit_price IS '販売単価（円）';
COMMENT ON COLUMN t_sales_order_line.shipped_qty IS '出荷済数量';
COMMENT ON COLUMN t_sales_order_line.created_at IS '作成日時';
COMMENT ON COLUMN t_sales_order_line.created_by IS '作成者';
COMMENT ON COLUMN t_sales_order_line.updated_at IS '更新日時';
COMMENT ON COLUMN t_sales_order_line.updated_by IS '更新者';
COMMENT ON COLUMN t_sales_order_line.version IS '版数';

-- 出荷：出荷ヘッダ
CREATE TABLE t_shipment (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_no VARCHAR(20) NOT NULL,
  sales_order_id BIGINT NOT NULL REFERENCES t_sales_order(id),
  customer_id BIGINT NOT NULL REFERENCES m_customer(id),
  ship_to_id BIGINT NOT NULL REFERENCES m_ship_to(id),
  shipped_on DATE NOT NULL,
  carrier VARCHAR(50),
  tracking_no VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'ALLOCATED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_shipment IS '出荷';
COMMENT ON COLUMN t_shipment.id IS '出荷ID';
COMMENT ON COLUMN t_shipment.shipment_no IS '出荷番号';
COMMENT ON COLUMN t_shipment.sales_order_id IS '受注ID';
COMMENT ON COLUMN t_shipment.customer_id IS '顧客ID';
COMMENT ON COLUMN t_shipment.ship_to_id IS '納品先ID';
COMMENT ON COLUMN t_shipment.shipped_on IS '出荷日';
COMMENT ON COLUMN t_shipment.carrier IS '配送業者';
COMMENT ON COLUMN t_shipment.tracking_no IS '送り状番号';
COMMENT ON COLUMN t_shipment.status IS 'ステータス';
COMMENT ON COLUMN t_shipment.created_at IS '作成日時';
COMMENT ON COLUMN t_shipment.created_by IS '作成者';
COMMENT ON COLUMN t_shipment.updated_at IS '更新日時';
COMMENT ON COLUMN t_shipment.updated_by IS '更新者';
COMMENT ON COLUMN t_shipment.version IS '版数';

-- 回収対象ロット：回収案件×ロット
CREATE TABLE t_recall_lot (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recall_id BIGINT NOT NULL REFERENCES t_recall(id),
  lot_id BIGINT NOT NULL REFERENCES t_lot(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_recall_lot IS '回収対象ロット';
COMMENT ON COLUMN t_recall_lot.id IS 'ID';
COMMENT ON COLUMN t_recall_lot.recall_id IS '回収案件ID';
COMMENT ON COLUMN t_recall_lot.lot_id IS 'ロットID';
COMMENT ON COLUMN t_recall_lot.created_at IS '作成日時';
COMMENT ON COLUMN t_recall_lot.created_by IS '作成者';
COMMENT ON COLUMN t_recall_lot.updated_at IS '更新日時';
COMMENT ON COLUMN t_recall_lot.updated_by IS '更新者';
COMMENT ON COLUMN t_recall_lot.version IS '版数';

-- 回収対象顧客：回収案件×顧客の連絡・回収状況
CREATE TABLE t_recall_target (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recall_id BIGINT NOT NULL REFERENCES t_recall(id),
  customer_id BIGINT NOT NULL REFERENCES m_customer(id),
  ship_to_id BIGINT NOT NULL REFERENCES m_ship_to(id),
  lot_id BIGINT NOT NULL REFERENCES t_lot(id),
  shipped_qty INTEGER NOT NULL,
  contacted_on DATE,
  contact_method VARCHAR(20),
  recovered_qty INTEGER NOT NULL DEFAULT 0,
  unrecoverable_qty INTEGER NOT NULL DEFAULT 0,
  close_reason VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'NOT_CONTACTED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_recall_target IS '回収対象顧客';
COMMENT ON COLUMN t_recall_target.id IS 'ID';
COMMENT ON COLUMN t_recall_target.recall_id IS '回収案件ID';
COMMENT ON COLUMN t_recall_target.customer_id IS '顧客ID';
COMMENT ON COLUMN t_recall_target.ship_to_id IS '納品先ID';
COMMENT ON COLUMN t_recall_target.lot_id IS 'ロットID';
COMMENT ON COLUMN t_recall_target.shipped_qty IS '出荷正味数量';
COMMENT ON COLUMN t_recall_target.contacted_on IS '連絡日';
COMMENT ON COLUMN t_recall_target.contact_method IS '連絡方法';
COMMENT ON COLUMN t_recall_target.recovered_qty IS '回収数量';
COMMENT ON COLUMN t_recall_target.unrecoverable_qty IS '回収不能数量';
COMMENT ON COLUMN t_recall_target.close_reason IS 'クローズ理由';
COMMENT ON COLUMN t_recall_target.status IS 'ステータス';
COMMENT ON COLUMN t_recall_target.created_at IS '作成日時';
COMMENT ON COLUMN t_recall_target.created_by IS '作成者';
COMMENT ON COLUMN t_recall_target.updated_at IS '更新日時';
COMMENT ON COLUMN t_recall_target.updated_by IS '更新者';
COMMENT ON COLUMN t_recall_target.version IS '版数';

-- 出荷明細：出荷明細（ロット紐付け必須）
CREATE TABLE t_shipment_line (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES t_shipment(id),
  sales_order_line_id BIGINT NOT NULL REFERENCES t_sales_order_line(id),
  product_id BIGINT NOT NULL REFERENCES m_product(id),
  lot_id BIGINT NOT NULL REFERENCES t_lot(id),
  location_id BIGINT NOT NULL REFERENCES m_location(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  unit_cost NUMERIC(12,2),
  status VARCHAR(20) NOT NULL DEFAULT 'ALLOCATED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_shipment_line IS '出荷明細';
COMMENT ON COLUMN t_shipment_line.id IS '出荷明細ID';
COMMENT ON COLUMN t_shipment_line.shipment_id IS '出荷ID';
COMMENT ON COLUMN t_shipment_line.sales_order_line_id IS '受注明細ID';
COMMENT ON COLUMN t_shipment_line.product_id IS '商品ID';
COMMENT ON COLUMN t_shipment_line.lot_id IS 'ロットID';
COMMENT ON COLUMN t_shipment_line.location_id IS '出庫保管場所ID';
COMMENT ON COLUMN t_shipment_line.quantity IS '出荷数量';
COMMENT ON COLUMN t_shipment_line.unit_price IS '販売単価（円）';
COMMENT ON COLUMN t_shipment_line.unit_cost IS '原価単価（円）';
COMMENT ON COLUMN t_shipment_line.status IS '明細ステータス';
COMMENT ON COLUMN t_shipment_line.created_at IS '作成日時';
COMMENT ON COLUMN t_shipment_line.created_by IS '作成者';
COMMENT ON COLUMN t_shipment_line.updated_at IS '更新日時';
COMMENT ON COLUMN t_shipment_line.updated_by IS '更新者';
COMMENT ON COLUMN t_shipment_line.version IS '版数';

-- 返品：返品（元出荷明細に紐付け）
CREATE TABLE t_return (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_no VARCHAR(20) NOT NULL,
  shipment_line_id BIGINT NOT NULL REFERENCES t_shipment_line(id),
  recall_target_id BIGINT REFERENCES t_recall_target(id),
  returned_on DATE NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  disposition VARCHAR(20),
  location_id BIGINT NOT NULL REFERENCES m_location(id),
  restock_location_id BIGINT REFERENCES m_location(id),
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NOT NULL REFERENCES m_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES m_user(id),
  version INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE t_return IS '返品';
COMMENT ON COLUMN t_return.id IS '返品ID';
COMMENT ON COLUMN t_return.return_no IS '返品番号';
COMMENT ON COLUMN t_return.shipment_line_id IS '元出荷明細ID';
COMMENT ON COLUMN t_return.recall_target_id IS '回収対象ID';
COMMENT ON COLUMN t_return.returned_on IS '返品日';
COMMENT ON COLUMN t_return.quantity IS '返品数量';
COMMENT ON COLUMN t_return.reason IS '返品理由';
COMMENT ON COLUMN t_return.disposition IS '処置';
COMMENT ON COLUMN t_return.location_id IS '受入保管場所ID';
COMMENT ON COLUMN t_return.restock_location_id IS '戻し保管場所ID';
COMMENT ON COLUMN t_return.status IS 'ステータス';
COMMENT ON COLUMN t_return.created_at IS '作成日時';
COMMENT ON COLUMN t_return.created_by IS '作成者';
COMMENT ON COLUMN t_return.updated_at IS '更新日時';
COMMENT ON COLUMN t_return.updated_by IS '更新者';
COMMENT ON COLUMN t_return.version IS '版数';

-- 一意制約・CHECK・インデックス
ALTER TABLE m_supplier ADD CONSTRAINT uq_supplier_code UNIQUE (supplier_code);
ALTER TABLE m_product ADD CONSTRAINT uq_product_code UNIQUE (product_code);
ALTER TABLE m_customer ADD CONSTRAINT uq_customer_code UNIQUE (customer_code);
ALTER TABLE m_customer ADD CONSTRAINT ck_customer_medical_code CHECK (customer_type<>'MEDICAL' OR medical_inst_code IS NOT NULL);
CREATE UNIQUE INDEX uq_ship_to_default ON m_ship_to (customer_id) WHERE is_default;
ALTER TABLE m_location ADD CONSTRAINT uq_location_code UNIQUE (location_code);
ALTER TABLE m_location ADD CONSTRAINT ck_location_temp CHECK (temp_min < temp_max);
ALTER TABLE m_sales_rule ADD CONSTRAINT uq_sales_rule UNIQUE (regulatory_class, customer_type);
ALTER TABLE m_user ADD CONSTRAINT uq_user_email UNIQUE (email);
ALTER TABLE t_purchase_order ADD CONSTRAINT uq_po_no UNIQUE (po_no);
ALTER TABLE t_purchase_order_line ADD CONSTRAINT uq_po_line UNIQUE (purchase_order_id, line_no);
ALTER TABLE t_receipt ADD CONSTRAINT uq_receipt_no UNIQUE (receipt_no);
ALTER TABLE t_lot ADD CONSTRAINT uq_lot_no UNIQUE (lot_no);
ALTER TABLE t_lot ADD CONSTRAINT uq_lot_supplier_lot UNIQUE (supplier_id, product_id, supplier_lot_no);
CREATE INDEX ix_lot_product_status_exp ON t_lot (product_id, status, expires_on, received_on);
CREATE INDEX ix_lot_status_history ON t_lot_status_history (lot_id, changed_at);
ALTER TABLE t_receipt_line ADD CONSTRAINT ck_receipt_line_qty CHECK (quantity > 0);
ALTER TABLE t_inventory ADD CONSTRAINT uq_inventory_lot_loc UNIQUE (lot_id, location_id);
ALTER TABLE t_inventory ADD CONSTRAINT ck_inventory_qty CHECK (on_hand_qty >= 0 AND 0 <= allocated_qty AND allocated_qty <= on_hand_qty);
CREATE INDEX ix_movement_lot_loc ON t_stock_movement (lot_id, location_id, moved_at);
CREATE INDEX ix_movement_ref ON t_stock_movement (ref_type, ref_id);
ALTER TABLE t_sales_order ADD CONSTRAINT uq_so_no UNIQUE (so_no);
CREATE INDEX ix_so_customer_date ON t_sales_order (customer_id, order_date);
ALTER TABLE t_sales_order_line ADD CONSTRAINT uq_so_line UNIQUE (sales_order_id, line_no);
ALTER TABLE t_shipment ADD CONSTRAINT uq_shipment_no UNIQUE (shipment_no);
CREATE INDEX ix_shipment_customer_date ON t_shipment (customer_id, shipped_on);
CREATE INDEX ix_shipment_line_lot ON t_shipment_line (lot_id, status);
CREATE INDEX ix_shipment_line_so_line ON t_shipment_line (sales_order_line_id, status);
ALTER TABLE t_shipment_line ADD CONSTRAINT ck_shipment_line_qty CHECK (quantity > 0);
ALTER TABLE t_return ADD CONSTRAINT uq_return_no UNIQUE (return_no);
CREATE INDEX ix_return_shipment_line ON t_return (shipment_line_id);
CREATE INDEX ix_return_recall_target ON t_return (recall_target_id);
ALTER TABLE t_recall ADD CONSTRAINT uq_recall_no UNIQUE (recall_no);
ALTER TABLE t_recall_lot ADD CONSTRAINT uq_recall_lot UNIQUE (recall_id, lot_id);
ALTER TABLE t_recall_target ADD CONSTRAINT uq_recall_target UNIQUE (recall_id, ship_to_id, lot_id);
CREATE INDEX ix_temp_location_time ON t_temperature_log (location_id, measured_at);
CREATE INDEX ix_attachment_owner ON t_attachment (owner_type, owner_id);
CREATE INDEX ix_audit_target ON t_audit_log (target_table, target_id, occurred_at);
CREATE INDEX ix_audit_user_time ON t_audit_log (user_id, occurred_at);
