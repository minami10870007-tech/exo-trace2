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

## Web 版（Netlify ＋ Supabase、スマホ対応）

画面を Netlify で配信し、ログインとデータは Supabase（PostgreSQL）で管理します。
入荷・出荷・回収などの業務ルールはすべてデータベースの関数（`supabase/schema.sql`）に実装されています。そのため、画面を改ざんしてもルールを迂回できません。

```
ブラウザ（web/dist） ──ログイン（Supabase Auth）──▶ Supabase
        │          └──業務処理（/rest/v1/rpc/…）────▶ データベース関数（ログイン済み＋利用者登録された人だけ実行可）
        └── /api/config（Netlify Function）… 接続先 URL と公開用キーを返すだけ
```

| ファイル | 内容 |
|---|---|
| `supabase/schema.sql` | テーブル・業務ルール（関数）・権限・初期データ・日次チェックの自動実行。Supabase の SQL Editor に貼って実行する |
| `supabase/test/` | ローカルの Supabase 互換環境（PostgreSQL＋PostgREST＋認証）での自動テスト |
| `netlify.toml` | ビルド設定・セキュリティヘッダー（CSP 等）・キャッシュ設定 |
| `netlify/functions/config.mjs` | `/api/config`：環境変数の Supabase URL と公開用キーを画面に渡す（秘密のキーが設定されていたら拒否） |
| `web/src/` | 画面（index.html / styles.css / app.js / PWA マニフェスト・アイコン） |
| `web/build.mjs` | `web/dist` を生成（CSS/JS にハッシュを付けて長期キャッシュ） |
| `web/test/` | ローカル検証サーバーとデザイン・レスポンシブ自動レビュー |

### セキュリティの考え方

- データのテーブルは API に公開しない `exo` スキーマに置いています。画面から呼べるのは `public` スキーマの関数だけです。
- 関数はどれも、最初にログイン済みかどうかと、利用者登録（`exo.app_user`）に載っているかを確認します。Supabase にアカウントがあっても、登録のない人は使えません。
- 画面に渡すのは公開用の anon（publishable）キーだけです。これはブラウザに渡る前提で作られたキーです。秘密のキー（service_role / secret）は使いません。誤って設定された場合は、`/api/config` が接続を止めます。
- 在庫を動かす処理は、データベースの中で1件ずつ順番に実行されます。複数の人が同時に出荷しても、在庫が二重に引き当てられることはありません。

### 導入手順（ターミナル不要）

**1. Supabase のプロジェクトを作る**
1. https://supabase.com にログインし、「New project」でプロジェクトを作ります。
   - Region：Northeast Asia (Tokyo)
   - Database Password：任意（控えておく）
   - Security の「Enable Data API」は**オンのまま**にします（画面がデータベースにつながる入口です）。ほかのチェックはどちらでも構いません。
2. 左メニュー「SQL Editor」→「New query」に、`supabase/schema.sql` の中身をすべて貼り付けて「Run」を押します。「Success. No rows returned」と出れば完了です。
   - 実行前に「Potential issues detected」（削除を含む処理がある、などの確認）が出ることがあります。更新に備えた削除なので、**実行する側のボタンを押してください**（Cancel は押さない）。

**2. 利用者を作る**
1. 「Authentication」→「Sign In / Providers」の「User Signups」にある **「Allow new users to sign up」をオフ**にして、「Save changes」を押します。知らない人が自分でアカウントを作れないようにするためです。
2. 「Authentication」→「Users」→「Add user」→「Create new user」で、メールアドレスとパスワードを入れます。**「Auto confirm user?」にチェックが入っていること**を確認して「Create user」を押します。
3. 「SQL Editor」→「New query」で次を実行し、利用を許可します。人数分、行を増やしてください。
   ```sql
   select exo.allow_user('taro@example.com');
   ```

**3. 接続情報を控える**
- プロジェクト画面上部の **「Connect」** を押すと、**Project URL**（例：`https://abcdefgh.supabase.co`）と **Publishable key**（`sb_publishable_…`）が表示されます。
- 「Project Settings」→「API Keys」でも確認できます。古いプロジェクトでは「Legacy anon, service_role API keys」タブの **anon public**（`eyJ…`）でも構いません。
- **service_role / Secret key は使いません。** 絶対に貼らないでください。

**4. Netlify（以前このリポジトリをデプロイしたプロジェクトをそのまま使います）**
1. Netlify で既存のプロジェクトを開き、「Project configuration」→「Environment variables」を開きます。
   新しく作り直す必要はありません。初めての場合だけ「Add new project」→「Import an existing project」で接続します。
2. 「Add a variable」→「Add a single variable」で、次の2つを追加します。

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | 手順3の Project URL |
   | `SUPABASE_ANON_KEY` | 手順3の Publishable key（または anon public） |

   - 公開用のキーなので、**「Contains secret values」にはチェックを入れません**。
   - Scopes が選べる場合は「All scopes」のままにします。
3. 同じ画面で、以前の Apps Script 連携の `GAS_URL` / `GAS_SECRET` / `SESSION_SECRET` / `EXO_USERS` を削除します（もう使いません）。
4. 「Deploys」→「Trigger deploy」→「Deploy project」で再デプロイします。「Published」になったらサイトを開き、手順2のメールアドレスとパスワードでログインします。
   スマホでは、ブラウザの「ホーム画面に追加」でアプリのように使えます。

### 運用メモ

- **利用者を追加する：** 手順2の2と3を行います（一度止めた人を戻すときも同じです）。
- **利用者を止める：** SQL Editor で次を実行します。あわせて Authentication → Users でユーザーを削除します。
  ```sql
  select exo.disallow_user('taro@example.com');
  ```
- **パスワードを再設定する：** ダッシュボードからパスワードを直接変える機能はありません。Authentication → Users でユーザーを削除し、同じメールアドレスで作り直してください（利用者登録はそのまま残ります）。
- **日次チェック：** 毎日 1:00（日本時間）に Supabase の pg_cron で自動実行されます。内容は、期限切れロットを「期限切れ」にすることと、在庫と在庫移動履歴の照合です。不一致があればダッシュボードに表示されます。設定されたかは「Integrations」→「Cron」に `exo-trace-daily-check` があるかで確認できます。
- **更新版の `schema.sql`：** もう一度 SQL Editor に貼って実行します。データは消えません。
- **Supabase の無料プラン：** しばらく利用がないとプロジェクトが一時停止します（事前にメールが届きます）。ダッシュボードの「Resume project」で再開できます。データは保持されます（停止から1年以内）。
- **Netlify の環境変数を変えたとき：** 再デプロイすると反映されます。
- **独自ドメインの Supabase：** `*.supabase.co` 以外の URL を使う場合は、`netlify.toml` の CSP（`connect-src`）にその URL を追加してください。

### ローカルで確認・テスト

PostgreSQL 15 以上と Node.js 20 以上が必要です。PostgREST は初回に自動でダウンロードされます。

```bash
node supabase/test/db_test.mjs                 # データベース関数の業務フロー・権限・同時実行テスト
node web/build.mjs
node web/test/serve.mjs                       # http://127.0.0.1:8888（demo@example.com / demo-password-123、サンプルデータ入り）
NODE_PATH=$(npm root -g) node web/test/review.mjs web/test/out   # 7種の画面幅で全画面を自動レビュー＋操作テスト
```

接続先の PostgreSQL は環境変数 `PG_ADMIN_URL` で指定します。既定は `postgresql://postgres:postgres@127.0.0.1:5432/postgres` です。

## 簡易版（Google スプレッドシート＋Apps Script）

Web 版とは別に、スプレッドシートだけで使える版です。データはそれぞれ別に保存されます。

| ファイル | 内容 |
|---|---|
| `apps-script/コード.gs` | サーバー側（シート＝テーブル、入荷・検品・FEFO出荷・返品・追跡・回収・日次チェック） |
| `apps-script/index.html` | 操作画面 |
| `apps-script/test/` | モック環境でのテスト（`node apps-script/test/mock_test.js`、画面は `NODE_PATH=$(npm root -g) node apps-script/test/ui_test.js`） |

導入手順：スプレッドシートで「拡張機能 > Apps Script」→ `コード.gs` を貼り付け → 「＋ > HTML」で `index` を作成し `index.html` を貼り付け → 保存してスプレッドシートを再読込 → メニュー「EXO-TRACE > 初期設定」→「画面を開く」。
