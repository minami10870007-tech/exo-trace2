# -*- coding: utf-8 -*-
"""設計データの整合性チェック。指摘があれば一覧表示して終了コード1を返す。"""
import re
import sys

import spec

ID_PATTERNS = {
    "func": re.compile(r"\b(?:MST|PUR|RCV|LOT|INV|SAL|SHP|RET|TRC|RCL|RPT|SYS)-\d{2}\b"),
    "screen": re.compile(r"\bSCR-\d{2}\b"),
    "msg": re.compile(r"\bMSG-[EW]\d{2}\b"),
    "proc": re.compile(r"\bP-\d{2}\b"),
    "rule": re.compile(r"\bBR-\d{2}\b"),
    "sql": re.compile(r"\bSQL-\d{2}\b"),
    "report": re.compile(r"\bRP-\d{2}\b"),
}


def all_columns():
    cols = {}
    for t, rows in spec.COLUMNS.items():
        names = [r[0] for r in rows] + [c[0] for c in spec.COMMON_COLUMNS]
        cols[t] = set(names)
    return cols


def text_of(rows):
    return "\n".join(" ".join(str(x) for x in r) for r in rows)


def run():
    issues = []
    add = issues.append
    func_ids = [f[0] for f in spec.FUNCTIONS]
    screen_ids = [s[0] for s in spec.SCREENS]
    msg_ids = [m[0] for m in spec.MESSAGES]
    proc_ids = sorted({p[0] for p in spec.PROCESSES})
    rule_ids = [r[0] for r in spec.RULES]
    sql_ids = [s[0] for s in spec.SQLS]
    report_ids = [r[0] for r in spec.REPORTS]
    cols = all_columns()
    defined = {"func": func_ids, "screen": screen_ids, "msg": msg_ids, "proc": proc_ids,
               "rule": rule_ids, "sql": sql_ids, "report": report_ids}

    # 0. ID重複
    for kind, ids in defined.items():
        dup = {i for i in ids if ids.count(i) > 1}
        if dup:
            add(f"[ID重複] {kind}: {sorted(dup)}")

    # 1. 全シートの参照IDが定義済みか
    sheets = {
        "OVERVIEW": spec.OVERVIEW, "FLOWS": spec.FLOWS, "FUNCTIONS": spec.FUNCTIONS, "SCREENS": spec.SCREENS,
        "STATES": spec.STATES, "RULES": spec.RULES, "REPORTS": spec.REPORTS, "NONFUNC": spec.NONFUNC,
        "CODES": spec.CODES, "ISSUES": spec.ISSUES, "SCREEN_ITEMS": spec.SCREEN_ITEMS, "APIS": spec.APIS,
        "PROCESSES": spec.PROCESSES, "SQLS": spec.SQLS, "INDEXES": spec.INDEXES, "BATCHES": spec.BATCHES,
        "COLUMNS": [r for rows in spec.COLUMNS.values() for r in rows],
    }
    used = {k: set() for k in ID_PATTERNS}
    for name, rows in sheets.items():
        txt = text_of(rows)
        for kind, pat in ID_PATTERNS.items():
            for ref in set(pat.findall(txt)):
                used[kind].add(ref)
                if ref not in defined[kind]:
                    add(f"[未定義参照] {name} が {ref} を参照")

    # 2. 定義されたが一度も参照されないID
    for kind in ("screen", "msg", "proc", "rule", "sql"):
        own = {"screen": "SCREENS", "msg": "MESSAGES", "proc": "PROCESSES", "rule": "RULES", "sql": "SQLS"}[kind]
        # 自シート以外からの参照を数える
        ext = set()
        for name, rows in sheets.items():
            if name == own:
                continue
            ext |= set(ID_PATTERNS[kind].findall(text_of(rows)))
        for i in defined[kind]:
            if i not in ext:
                add(f"[未使用] {kind} {i} がどこからも参照されていない")

    # 3. 機能はAPIと画面を持つ
    api_funcs = set()
    for a in spec.APIS:
        api_funcs |= set(ID_PATTERNS["func"].findall(a[4]))
    for f in func_ids:
        if f not in api_funcs:
            add(f"[API漏れ] 機能 {f} に対応するAPIがない")

    # 4. 権限マトリクス
    if set(spec.PERMISSIONS) != set(func_ids):
        add(f"[権限] 過不足: 不足={set(func_ids)-set(spec.PERMISSIONS)} 余剰={set(spec.PERMISSIONS)-set(func_ids)}")
    for f, p in spec.PERMISSIONS.items():
        if len(p) != len(spec.ROLES) or set(p) - set("CRA-"):
            add(f"[権限] {f} の値 '{p}' が不正")

    # 5. API許可ロール ⇔ 権限マトリクス
    for a in spec.APIS:
        api_id, method, _, _, funcs, roles, _ = a
        fids = ID_PATTERNS["func"].findall(funcs)
        role_codes = [r for r in spec.ROLES if re.search(rf"\b{r}\b", roles)]
        if "全ロール" in roles or "全員" in roles:
            role_codes = spec.ROLES
            if any(spec.PERMISSIONS.get(f, "------").count("-") for f in fids):
                add(f"[API権限] {api_id} は全ロール許可だが、権限マトリクスで不可(-)のロールがある {fids}")
            continue
        if "権限マトリクスに従う" in roles or ("参照:" in roles):
            continue
        writes = method != "GET"
        for r in role_codes:
            idx = spec.ROLES.index(r)
            for f in fids:
                v = spec.PERMISSIONS.get(f, "------")[idx]
                if v == "-" or (writes and v == "R"):
                    add(f"[API権限] {api_id}({method}) が {r} を許可しているが、権限マトリクス {f}={v}")
        # 逆方向：更新権限(C/A)を持つのにAPIで許可されていないロール
        for f in fids:
            for idx, v in enumerate(spec.PERMISSIONS.get(f, "")):
                r = spec.ROLES[idx]
                if writes and v in "CA" and r not in role_codes and len(fids) == 1:
                    pass  # 同一機能の別API（承認等）で許可されている場合があるため集計で判定
    for f in func_ids:
        perm = spec.PERMISSIONS.get(f, "")
        allowed_write = set()
        for a in spec.APIS:
            if f in ID_PATTERNS["func"].findall(a[4]) and a[1] != "GET":
                allowed_write |= {r for r in spec.ROLES if re.search(rf"\b{r}\b", a[5])}
                if "全員" in a[5]:
                    allowed_write |= set(spec.ROLES)
        for idx, v in enumerate(perm):
            if v in "CA" and spec.ROLES[idx] not in allowed_write:
                add(f"[API権限] 権限マトリクス {f}={v}({spec.ROLES[idx]}) だが更新系APIで許可されていない")

    # 6. テーブル・カラム
    if set(spec.TABLES) != set(spec.COLUMNS):
        add(f"[テーブル] TABLES と COLUMNS の不一致 {set(spec.TABLES) ^ set(spec.COLUMNS)}")
    for t, rows in spec.COLUMNS.items():
        names = [r[0] for r in rows]
        if len(names) != len(set(names)):
            add(f"[カラム重複] {t}")
        if not any(r[4] == "Y" for r in rows):
            add(f"[PKなし] {t}")
        for r in rows:
            if len(r) != 9:
                add(f"[列数] {t}.{r[0]}")
            fk = r[5]
            if fk:
                ft, fc = fk.split(".")
                if ft not in cols or fc not in cols[ft]:
                    add(f"[FK不正] {t}.{r[0]} -> {fk}")
            if r[2] in ("VARCHAR", "CHAR") and not r[3]:
                add(f"[桁なし] {t}.{r[0]}")

    # 7. 画面項目の対応カラム
    for it in spec.SCREEN_ITEMS:
        for ref in re.findall(r"\b([mt]_[a-z_]+)\.([a-z_]+)\b", it[7]):
            t, c = ref
            if t not in cols or c not in cols[t]:
                add(f"[画面項目] {it[0]}#{it[1]} の対応カラム {t}.{c} が存在しない")
        for t in re.findall(r"\b([mt]_[a-z_]+)\b", it[7]):
            if t not in cols:
                add(f"[画面項目] {it[0]}#{it[1]} のテーブル {t} が存在しない")
    for sid in {i[0] for i in spec.SCREEN_ITEMS}:
        if sid not in screen_ids:
            add(f"[画面項目] 画面 {sid} が画面一覧にない")

    # 8. インデックス
    for ix in spec.INDEXES:
        t = ix[0]
        if t not in cols:
            add(f"[INDEX] テーブル {t} が存在しない")
            continue
        target = ix[3].split(" WHERE ")[0]
        for c in [x.strip() for x in target.split(",")]:
            if c not in cols[t]:
                add(f"[INDEX] {ix[2]} のカラム {t}.{c} が存在しない")
    names = [ix[2] for ix in spec.INDEXES]
    if len(names) != len(set(names)):
        add("[INDEX] 名前重複")

    # 9. SQL内のテーブル.カラム（エイリアス解決）
    for sid, _, sql in spec.SQLS:
        aliases = dict((a, t) for t, a in re.findall(r"\b([mt]_[a-z_]+)\s+([a-z]{1,3})\b", sql))
        derived = set(re.findall(r"\b([a-z]{1,3}) AS \(", sql)) | set(re.findall(r"\)\s+([a-z]{1,3})\b", sql))
        for a, c in re.findall(r"\b([a-z]{1,3})\.([a-z_]+)\b", sql):
            t = aliases.get(a)
            if t is None:
                if a in derived:
                    continue
                add(f"[SQL] {sid} エイリアス {a} が未定義")
            elif c not in cols[t]:
                add(f"[SQL] {sid} {t}.{c} が存在しない")

    # 10. コード値：カラム備考の『コード値：』とコード定義の整合
    code_types = {}
    for ct, code, nm, _ in spec.CODES:
        code_types.setdefault(ct, {})[code] = nm
    for t, rows in spec.COLUMNS.items():
        for r in rows:
            if r[8].startswith("コード値："):
                vals = r[8].split("：", 1)[1].split("/")
                ct = r[1]
                if ct not in code_types:
                    add(f"[コード値] {t}.{r[0]}（{ct}）のコード定義がない")
                    continue
                if set(vals) != set(code_types[ct]):
                    add(f"[コード値] {t}.{r[0]} の備考値 {vals} がコード定義 {sorted(code_types[ct])} と不一致")

    # 11. 状態遷移の状態がコード定義と一致（ロット）
    lot_codes = set(code_types.get("ロットステータス", {}))
    for s in spec.STATES:
        if s[0] == "ロット":
            for part in (s[1] + "/" + s[3]).split("/"):
                code = part.split("（")[0]
                if code not in lot_codes and code != "":
                    add(f"[状態遷移] ロット状態 {code} がコード定義にない")
    # 11b. MUST機能の業務画面には画面項目定義がある
    item_screens = {i[0] for i in spec.SCREEN_ITEMS}
    cat = {sc[0]: sc[2] for sc in spec.SCREENS}
    for f in spec.FUNCTIONS:
        if f[4] != "MUST":
            continue
        for sid in ID_PATTERNS["screen"].findall(f[5]):
            if cat.get(sid) in ("仕入", "ロット", "在庫", "販売", "トレース", "品質") and sid not in item_screens:
                add(f"[画面項目] MUST機能 {f[0]} の画面 {sid} に画面項目定義がない")

    # 12. メッセージID接頭辞と種別の整合
    for mid, kind, _, _ in spec.MESSAGES:
        if (mid.startswith("MSG-E") and kind != "エラー") or (mid.startswith("MSG-W") and kind != "警告"):
            add(f"[メッセージ] {mid} の種別 {kind} がID接頭辞と不一致")

    # 13. 状態遷移の実行ロールがロール定義に存在
    for s in spec.STATES:
        if s[5] not in spec.ROLES and s[5] != "システム":
            add(f"[状態遷移] 実行ロール {s[5]} が未定義")
    return issues


if __name__ == "__main__":
    res = run()
    for i in res:
        print(i)
    print(f"--- 指摘 {len(res)} 件")
    sys.exit(1 if res else 0)
