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

## 簡易版（Google スプレッドシート＋Apps Script）

| ファイル | 内容 |
|---|---|
| `apps-script/コード.gs` | サーバー側（シート＝テーブル、入荷・検品・FEFO出荷・返品・追跡・回収・日次チェック） |
| `apps-script/index.html` | 操作画面 |
| `apps-script/test/` | モック環境でのテスト（`node apps-script/test/mock_test.js`、画面は `NODE_PATH=$(npm root -g) node apps-script/test/ui_test.js`） |

導入手順：スプレッドシートで「拡張機能 > Apps Script」→ `コード.gs` を貼り付け → 「＋ > HTML」で `index` を作成し `index.html` を貼り付け → 保存してスプレッドシートを再読込 → メニュー「EXO-TRACE > 初期設定」→「画面を開く」。

## Netlify 版（スマホ対応の操作画面）

データは引き続き Google スプレッドシートに保存し、画面だけを Netlify で配信します。

```
ブラウザ（web/dist） ──/api──▶ Netlify Function（ログイン・セッション検証） ──▶ Apps Script doPost ──▶ スプレッドシート
```

| ファイル | 内容 |
|---|---|
| `netlify.toml` | ビルド設定・セキュリティヘッダー（CSP 等）・キャッシュ設定 |
| `netlify/functions/api.mjs` | `/api`：ログイン（メール＋パスワード、12時間有効の署名付きトークン）と Apps Script への中継 |
| `web/src/` | 画面（index.html / styles.css / app.js / PWA マニフェスト・アイコン） |
| `web/build.mjs` | `web/dist` を生成（CSS/JS にハッシュを付けて長期キャッシュ） |
| `scripts/hash-password.mjs` | 利用者登録用の文字列を作成 |
| `web/test/` | ローカル検証サーバーとデザイン・レスポンシブ自動レビュー |

### デプロイ手順

1. **Apps Script 側**（スプレッドシートの「拡張機能 > Apps Script」）
   1. `apps-script/コード.gs` を最新に貼り替えて保存
   2. スプレッドシートのメニュー「EXO-TRACE > Netlify 連携シークレットの表示」で表示された値を控える
   3. 「デプロイ > 新しいデプロイ > 種類：ウェブアプリ」、実行ユーザー＝**自分**、アクセスできるユーザー＝**全員** でデプロイし、URL（…/exec）を控える
      （画面は公開されません。`doGet` は文字列を返すだけで、`doPost` はシークレットが一致する要求しか処理しません）
2. **利用者の登録文字列を作成**（人数分）：`node scripts/hash-password.mjs taro@example.com 'パスワード12文字以上'`
3. **Netlify**：このリポジトリを「Add new site > Import an existing project」で接続（ビルド設定は `netlify.toml` から自動で読まれます）し、環境変数を設定
   | 変数 | 値 |
   |---|---|
   | `GAS_URL` | 手順1-3 の URL |
   | `GAS_SECRET` | 手順1-2 の値 |
   | `SESSION_SECRET` | ランダムな長い文字列（例：`openssl rand -hex 32`） |
   | `EXO_USERS` | 手順2 の出力をセミコロン `;` 区切りで連結 |
4. デプロイ後、サイトにアクセスしてログイン。スマホではブラウザの「ホーム画面に追加」でアプリのように使えます。

### ローカルで確認・レビュー

```bash
node web/build.mjs
node web/test/serve.mjs                       # http://127.0.0.1:8888（demo@example.com / demo-password-123、サンプルデータ入り）
NODE_PATH=$(npm root -g) node web/test/review.mjs web/test/out   # 7種の画面幅で全画面を自動レビュー＋操作テスト
```
