# -*- coding: utf-8 -*-
"""主要SQL（SQL-01〜05）をサンプルデータで検証するシナリオ（ASSERT付き）。

前提: schema.sql を適用した直後の空DB（ID採番が1から始まる前提のため、再実行時はスキーマを作り直す）。
  python sql_scenario.py | psql -v ON_ERROR_STOP=1 -q <接続先>
ASSERT 失敗時は psql がエラー終了する。最後に ROLLBACK するためDBは汚れない。

シナリオ
  ロットL1（10本）を顧客A に3本・顧客B に4本出荷、顧客C 向け2本は出荷取消。
  顧客Bが1本を通常返品（隔離保管場所へ受入→廃棄）。L1 を回収開始。
  → 回収対象は A:3, B:3。
  回収中に B がさらに通常返品1本 → 再抽出で B:2。
  A が回収品として3本返品 → 再抽出しても A:3 のまま（回収品は recovered_qty 側）。
  B が残り2本を通常返品 → 再抽出で B:0・CLOSED。
  別受注で1本を引当中（ALLOCATED）→ 在庫・引当の整合性チェック（SQL-04/05）は0件。
"""
import spec

SQL = {s[0]: s[2].rstrip().rstrip(";") for s in spec.SQLS}


def mv(mtype, loc, qty, ref_type, ref_id, alloc=0):
    """アプリと同じく移動履歴と在庫を同一トランザクションで更新する。"""
    return (f"INSERT INTO t_stock_movement (moved_at,movement_type,lot_id,location_id,quantity,ref_type,ref_id,created_by)"
            f" VALUES (now(),'{mtype}',1,{loc},{qty},'{ref_type}',{ref_id},1);\n"
            # CHECK制約は ON CONFLICT 判定前に評価されるため UPDATE → 無ければ INSERT の順で行う
            f"UPDATE t_inventory SET on_hand_qty = on_hand_qty + {qty}, allocated_qty = allocated_qty + {alloc}"
            f" WHERE lot_id = 1 AND location_id = {loc};\n"
            f"INSERT INTO t_inventory (lot_id,location_id,on_hand_qty,allocated_qty,created_by,updated_by)"
            f" SELECT 1,{loc},{qty},{alloc},1,1 WHERE NOT EXISTS"
            f" (SELECT 1 FROM t_inventory WHERE lot_id = 1 AND location_id = {loc});\n")


def ret(no, line, qty, target="NULL"):
    return (f"INSERT INTO t_return (return_no,shipment_line_id,recall_target_id,returned_on,quantity,reason,location_id,disposition,status,created_by,updated_by)"
            f" VALUES ('{no}',{line},{target},'2026-10-04',{qty},'test',2,'DISPOSE','CLOSED',1,1);\n"
            + mv("RETURN", 2, qty, "return", f"(SELECT id FROM t_return WHERE return_no='{no}')")
            + mv("DISPOSE", 2, -qty, "return", f"(SELECT id FROM t_return WHERE return_no='{no}')"))


def check(sql, cond, msg):
    return f"DO $$ BEGIN ASSERT ({sql}) {cond}, '{msg}'; END $$;\n"


def sub(sql, **kw):
    for k, v in kw.items():
        sql = sql.replace(f":{k}", v)
    return sql


SEED = """
INSERT INTO m_user (id,email,name,role,password_hash,created_by,updated_by) OVERRIDING SYSTEM VALUE
 VALUES (1,'admin@example.com','管理者','ADMIN','x',1,1);
INSERT INTO m_supplier (supplier_code,name,created_by,updated_by) VALUES ('S001','仕入先A',1,1);
INSERT INTO m_product (product_code,name,supplier_id,source_type,form,storage_class,shelf_life_days,regulatory_class,created_by,updated_by)
 VALUES ('P001','エクソソーム原液A',1,'UMBILICAL','FROZEN','M80',730,'COSMETIC_RAW',1,1);
INSERT INTO m_location (location_code,name,storage_class,temp_min,temp_max,is_quarantine,created_by,updated_by) VALUES
 ('L-80-1','-80℃冷凍庫#1','M80',-90,-60,false,1,1),('Q-80-1','-80℃隔離庫','M80',-90,-60,true,1,1);
INSERT INTO m_customer (customer_code,name,customer_type,address,created_by,updated_by) VALUES
 ('C001','サロンA','SALON','東京',1,1),('C002','サロンB','SALON','大阪',1,1),('C003','サロンC','SALON','福岡',1,1);
INSERT INTO m_ship_to (customer_id,name,address,is_default,created_by,updated_by) VALUES
 (1,'A本店','東京',true,1,1),(2,'B本店','大阪',true,1,1),(3,'C本店','福岡',true,1,1);
INSERT INTO t_receipt (receipt_no,supplier_id,receipt_date,status,created_by,updated_by) VALUES ('RC-202610-0001',1,'2026-10-01','CONFIRMED',1,1);
INSERT INTO t_lot (lot_no,product_id,supplier_id,supplier_lot_no,expires_on,received_on,unit_cost,status,created_by,updated_by)
 VALUES ('P001-261001-01',1,1,'SUP-LOT-9','2028-09-30','2026-10-01',10000,'RELEASED',1,1);
INSERT INTO t_receipt_line (receipt_id,product_id,supplier_lot_no,expires_on,lot_id,location_id,quantity,unit_price,created_by,updated_by)
 VALUES (1,1,'SUP-LOT-9','2028-09-30',1,1,10,10000,1,1);
INSERT INTO t_sales_order (so_no,customer_id,ship_to_id,order_date,sales_user_id,created_by,updated_by) VALUES
 ('SO-1',1,1,'2026-10-02',1,1,1),('SO-2',2,2,'2026-10-02',1,1,1),('SO-3',3,3,'2026-10-02',1,1,1),('SO-4',3,3,'2026-10-04',1,1,1);
INSERT INTO t_sales_order_line (sales_order_id,line_no,product_id,quantity,unit_price,created_by,updated_by) VALUES
 (1,1,1,3,30000,1,1),(2,1,1,4,30000,1,1),(3,1,1,2,30000,1,1),(4,1,1,1,30000,1,1);
INSERT INTO t_shipment (shipment_no,sales_order_id,customer_id,ship_to_id,shipped_on,status,created_by,updated_by) VALUES
 ('SH-1',1,1,1,'2026-10-03','SHIPPED',1,1),('SH-2',2,2,2,'2026-10-03','SHIPPED',1,1),
 ('SH-3',3,3,3,'2026-10-03','CANCELLED',1,1),('SH-4',4,3,3,'2026-10-05','ALLOCATED',1,1);
INSERT INTO t_shipment_line (shipment_id,sales_order_line_id,product_id,lot_id,location_id,quantity,unit_price,unit_cost,status,created_by,updated_by) VALUES
 (1,1,1,1,1,3,30000,10000,'SHIPPED',1,1),(2,2,1,1,1,4,30000,10000,'SHIPPED',1,1),
 (3,3,1,1,1,2,30000,10000,'CANCELLED',1,1),(4,4,1,1,1,1,30000,NULL,'ALLOCATED',1,1);
"""


def scenario():
    out = ["BEGIN;", SEED]
    out.append(mv("RECEIPT", 1, 10, "receipt_line", 1))
    out.append(mv("SHIPMENT", 1, -3, "shipment_line", 1))
    out.append(mv("SHIPMENT", 1, -4, "shipment_line", 2))
    out.append(mv("SHIPMENT", 1, -2, "shipment_line", 3))
    out.append(mv("CANCEL", 1, 2, "shipment_line", 3))
    out.append("UPDATE t_inventory SET allocated_qty = 1 WHERE lot_id = 1 AND location_id = 1;\n")  # SH-4 の引当
    out.append(ret("RT-1", 2, 1))

    out.append(f"CREATE TEMP TABLE r1 AS {sub(SQL['SQL-01'], lot_id='1')};\n")
    out.append(check("SELECT count(*) FROM r1", "= 2", "SQL-01: 取消出荷を除き2行"))
    out.append(check("SELECT net_qty FROM r1 WHERE customer_code='C002'", "= 3", "SQL-01: B 正味3"))
    out.append(f"CREATE TEMP TABLE r2 AS {sub(SQL['SQL-02'], customer_id='2', **{'from': chr(39)+'2026-01-01'+chr(39), 'to': chr(39)+'2026-12-31'+chr(39)})};\n")
    out.append(check("SELECT net_qty FROM r2", "= 3", "SQL-02: B 正味3"))

    out.append("INSERT INTO t_recall (recall_no,title,reason,severity,started_on,created_by,updated_by)"
               " VALUES ('RCL-2026-001','テスト回収','テスト','II','2026-10-04',1,1);\n"
               "INSERT INTO t_recall_lot (recall_id,lot_id,created_by,updated_by) VALUES (1,1,1,1);\n")
    extract = sub(SQL["SQL-03"], recall_id="1", user_id="1") + ";\n"
    out += [extract, extract]
    tq = "SELECT shipped_qty FROM t_recall_target WHERE customer_id={c}"
    out.append(check("SELECT count(*) FROM t_recall_target", "= 2", "SQL-03: 2件・再実行で重複なし"))
    out.append(check(tq.format(c=1), "= 3", "SQL-03: A=3"))
    out.append(check(tq.format(c=2), "= 3", "SQL-03: B=3"))

    out.append(ret("RT-2", 2, 1))
    out.append(extract)
    out.append(check(tq.format(c=2), "= 2", "SQL-03再抽出: 通常返品後 B=2"))

    out.append(ret("RT-3", 1, 3, target="(SELECT id FROM t_recall_target WHERE customer_id=1)"))
    out.append("UPDATE t_recall_target SET recovered_qty = 3, status = 'RECOVERED' WHERE customer_id = 1;\n")
    out.append(extract)
    out.append(check(tq.format(c=1), "= 3", "SQL-03再抽出: 回収品返品は出荷正味から除かない A=3"))
    out.append(check("SELECT status FROM t_recall_target WHERE customer_id=1", "= 'RECOVERED'", "SQL-03再抽出: 回収済ステータス維持"))

    out.append(ret("RT-4", 2, 2))
    out.append(extract)
    out.append(check(tq.format(c=2), "= 0", "SQL-03再抽出: 全量返品で B=0"))
    out.append(check("SELECT status FROM t_recall_target WHERE customer_id=2", "= 'CLOSED'", "SQL-03再抽出: B CLOSED"))

    out.append(check(f"SELECT count(*) FROM ({SQL['SQL-04']}) x", "= 0", "SQL-04: 在庫＝移動履歴"))
    out.append(check(f"SELECT count(*) FROM ({SQL['SQL-05']}) x", "= 0", "SQL-05: 引当済＝ALLOCATED明細"))
    out.append("UPDATE t_inventory SET on_hand_qty = on_hand_qty + 1 WHERE location_id = 1;\n")
    out.append(check(f"SELECT count(*) FROM ({SQL['SQL-04']}) x", "= 1", "SQL-04: 不一致を検出できる"))
    out.append("\\echo 'ALL ASSERTIONS PASSED'\nROLLBACK;")
    return "".join(out)


if __name__ == "__main__":
    print(scenario())
