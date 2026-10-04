# -*- coding: utf-8 -*-
"""主要SQL（SQL-01〜04）をサンプルデータで検証するシナリオ。

前提: build.py の DDL を適用済みの空DBに対して psql で実行する SQL を標準出力に出す。
  python sql_scenario.py | psql -v ON_ERROR_STOP=1 ...
シナリオ: ロットL1(10本)を顧客A に3本・顧客B に4本出荷、顧客Bが1本返品、顧客C向けは取消。
期待: SQL-01 → A:3, B:3（正味）／SQL-03 → A:3, B:3 の2件／SQL-04 → 不一致0件
"""
import spec

SQL = {s[0]: s[2] for s in spec.SQLS}

SEED = """
INSERT INTO m_user (email,name,role,password_hash,created_by,updated_by) OVERRIDING SYSTEM VALUE
 VALUES ('admin@example.com','管理者','ADMIN','x',1,1);
INSERT INTO m_supplier (supplier_code,name,created_by,updated_by) VALUES ('S001','仕入先A',1,1);
INSERT INTO m_product (product_code,name,supplier_id,source_type,form,storage_class,shelf_life_days,regulatory_class,created_by,updated_by)
 VALUES ('P001','エクソソーム原液A',1,'UMBILICAL','FROZEN','M80',730,'COSMETIC_RAW',1,1);
INSERT INTO m_location (location_code,name,storage_class,temp_min,temp_max,created_by,updated_by) VALUES ('L-80-1','-80℃冷凍庫#1','M80',-90,-60,1,1);
INSERT INTO m_customer (customer_code,name,customer_type,address,created_by,updated_by) VALUES
 ('C001','サロンA','SALON','東京',1,1),('C002','サロンB','SALON','大阪',1,1),('C003','サロンC','SALON','福岡',1,1);
INSERT INTO m_ship_to (customer_id,name,address,is_default,created_by,updated_by) VALUES
 (1,'A本店','東京',true,1,1),(2,'B本店','大阪',true,1,1),(3,'C本店','福岡',true,1,1);
INSERT INTO t_receipt (receipt_no,supplier_id,receipt_date,status,created_by,updated_by) VALUES ('RC-202610-0001',1,'2026-10-01','CONFIRMED',1,1);
INSERT INTO t_lot (lot_no,product_id,supplier_id,supplier_lot_no,expires_on,status,created_by,updated_by)
 VALUES ('P001-261001-01',1,1,'SUP-LOT-9','2028-09-30','RELEASED',1,1);
INSERT INTO t_receipt_line (receipt_id,product_id,lot_id,location_id,quantity,unit_price,created_by,updated_by) VALUES (1,1,1,1,10,10000,1,1);
INSERT INTO t_stock_movement (moved_at,movement_type,lot_id,location_id,quantity,ref_type,ref_id,created_by) VALUES (now(),'RECEIPT',1,1,10,'receipt_line',1,1);
INSERT INTO t_sales_order (so_no,customer_id,ship_to_id,order_date,sales_user_id,created_by,updated_by) VALUES
 ('SO-1',1,1,'2026-10-02',1,1,1),('SO-2',2,2,'2026-10-02',1,1,1),('SO-3',3,3,'2026-10-02',1,1,1);
INSERT INTO t_sales_order_line (sales_order_id,line_no,product_id,quantity,unit_price,created_by,updated_by) VALUES
 (1,1,1,3,30000,1,1),(2,1,1,4,30000,1,1),(3,1,1,2,30000,1,1);
INSERT INTO t_shipment (shipment_no,sales_order_id,customer_id,ship_to_id,shipped_on,status,created_by,updated_by) VALUES
 ('SH-1',1,1,1,'2026-10-03','SHIPPED',1,1),('SH-2',2,2,2,'2026-10-03','SHIPPED',1,1),('SH-3',3,3,3,'2026-10-03','CANCELLED',1,1);
INSERT INTO t_shipment_line (shipment_id,sales_order_line_id,product_id,lot_id,location_id,quantity,unit_price,unit_cost,created_by,updated_by) VALUES
 (1,1,1,1,1,3,30000,10000,1,1),(2,2,1,1,1,4,30000,10000,1,1),(3,3,1,1,1,2,30000,10000,1,1);
INSERT INTO t_stock_movement (moved_at,movement_type,lot_id,location_id,quantity,ref_type,ref_id,created_by) VALUES
 (now(),'SHIPMENT',1,1,-3,'shipment_line',1,1),(now(),'SHIPMENT',1,1,-4,'shipment_line',2,1),
 (now(),'SHIPMENT',1,1,-2,'shipment_line',3,1),(now(),'CANCEL',1,1,2,'shipment_line',3,1);
INSERT INTO t_return (return_no,shipment_line_id,returned_on,quantity,reason,disposition,status,created_by,updated_by)
 VALUES ('RT-1',2,'2026-10-04',1,'破損','DISPOSE','CLOSED',1,1);
INSERT INTO t_inventory (lot_id,location_id,on_hand_qty,created_by,updated_by) VALUES (1,1,3,1,1);
INSERT INTO t_recall (recall_no,title,reason,severity,started_on,created_by,updated_by) VALUES ('RCL-2026-001','テスト回収','テスト','II','2026-10-04',1,1);
INSERT INTO t_recall_lot (recall_id,lot_id,created_by,updated_by) VALUES (1,1,1,1);
"""


def sub(sql, **kw):
    for k, v in kw.items():
        sql = sql.replace(f":{k}", v)
    return sql


if __name__ == "__main__":
    print("BEGIN;")
    print(SEED)
    print("\\echo === SQL-01 ロット→顧客")
    print(sub(SQL["SQL-01"], lot_id="1"))
    print("\\echo === SQL-02 顧客B→ロット")
    print(sub(SQL["SQL-02"], customer_id="2", **{"from": "'2026-01-01'", "to": "'2026-12-31'"}))
    print("\\echo === SQL-03 回収対象抽出（2回実行して冪等性確認）")
    print(sub(SQL["SQL-03"], recall_id="1", user_id="1"))
    print(sub(SQL["SQL-03"], recall_id="1", user_id="1"))
    print("SELECT customer_id, lot_id, shipped_qty FROM t_recall_target ORDER BY customer_id;")
    print("\\echo === SQL-04 在庫整合性（0行が正）")
    print(SQL["SQL-04"])
    print("ROLLBACK;")
