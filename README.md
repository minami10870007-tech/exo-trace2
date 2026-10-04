# EXO-TRACE

エクソソーム製品の **仕入 → 受入検品 → 在庫 → 販売（ロット引当） → 返品・回収** をロット単位で管理し、
「どのロットを、いつ、どのお客さんに、何本売ったか」を即座に追跡するためのシステム。

## 設計書

| ファイル | 内容 |
|---|---|
| `docs/design/EXO-TRACE_詳細設計書.xlsx` | 詳細設計書（スプレッドシート。Google ドライブにアップロードすれば Google スプレッドシートで開けます） |
| `docs/design/schema.sql` | DDL（PostgreSQL。設計書の「DDL」シートと同じ内容） |
| `docs/design/tools/spec.py` | 設計の正本（全シートの内容をデータとして定義） |
| `docs/design/tools/check.py` | 設計の整合性チェック（ID参照・FK・権限・コード値など） |
| `docs/design/tools/build.py` | spec.py から xlsx（DDL含む）を生成 |
| `docs/design/tools/sql_scenario.py` | 主要SQL（追跡・回収抽出・在庫整合性）をサンプルデータで検証 |

### 設計を修正するとき

```bash
cd docs/design/tools
python check.py          # 指摘 0 件になるまで spec.py を修正
python build.py          # xlsx を再生成
# 任意: DDL・SQL の実DB検証（PostgreSQL）
python sql_scenario.py | psql -v ON_ERROR_STOP=1 <DDL適用済みの空DB>
```

xlsx を直接編集すると次回の生成で上書きされます。変更は `spec.py` に入れてください
（課題一覧の「ステータス」「回答」欄だけは記入用です。決まった内容は `spec.py` に反映してください）。
