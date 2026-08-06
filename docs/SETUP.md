# セットアップ手順（人間側の手動設定チェックリスト）

要件の「実装順序」に対応した構成になっている。
**各ステップは前段の動作確認が取れてから次に進むこと。**

コード側で完結する部分と、人間がコンソールを触らないと進まない部分を分けて書いてある。
🔧 が付いている項目は人間の手動作業。

---

## Step 1. Supabase プロジェクトとスキーマ

### 🔧 手動設定

1. https://supabase.com/dashboard で新規プロジェクトを作成する
   - リージョン: 利用者に近いところ（例: Northeast Asia (Tokyo)）
   - DB パスワードは記録しておく
2. プロジェクト設定から以下を控える
   - `Project URL`（= `SUPABASE_URL`）
   - `anon` public key（フロントで使う）
   - `service_role` key（**外部に出さない**。Edge Functions のみ）
3. ローカルに Supabase CLI を入れる: `brew install supabase/tap/supabase`

### 適用

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

`pgvector` 拡張は migration の中で `create extension if not exists "vector"` により有効化される。
Dashboard の Database → Extensions で手動有効化する必要はない。

### 確認

```sql
-- テーブルが 6 つできていること
select table_name from information_schema.tables
where table_schema = 'public' order by 1;

-- マイサポが登録され、Slack チャンネルが紐づいていること
select a.name, a.slug, s.source_type, s.source_identifier
from apps a left join feedback_sources s on s.app_id = a.id;
```

---

## Step 2. Slack 経路（分類・クラスタリングなしの最小構成）

### 🔧 手動設定

1. https://api.slack.com/apps で **Create New App** → From scratch
   - App Name: `フィードバックデバッガー`
   - ワークスペース: 社内ワークスペース
2. **OAuth & Permissions** → Bot Token Scopes に以下を追加
   | スコープ | 用途 |
   |---|---|
   | `channels:history` | パブリックチャンネルのメッセージ受信 |
   | `channels:read` | チャンネル情報の取得 |
   | `chat:write` | （パーマリンク取得の前提となる基本権限） |
   | `users:read` | 投稿者の表示名取得 |
   | `reactions:read` | 📮 リアクションでフィードバックを拾う経路に必要 |
   | `groups:history` | プライベートチャンネルも対象にする場合のみ |
3. **Install to Workspace** し、`Bot User OAuth Token`（`xoxb-...`）を控える
4. **Basic Information** → App Credentials から `Signing Secret` を控える
5. 対象チャンネル `#（フィードバック投稿チャンネル）` に Bot を招待する
   - チャンネルで `/invite @フィードバックデバッガー`
   - **これを忘れるとイベントが飛んでこない**（一番よくあるハマりどころ）

### デプロイ（方法 A: CLI）

```bash
supabase secrets set \
  SLACK_SIGNING_SECRET=<Signing Secret> \
  SLACK_BOT_TOKEN=xoxb-... \
  ENABLE_AI_ENRICHMENT=false     # ← このステップでは AI 処理を止めておく

supabase functions deploy slack-events --no-verify-jwt
```

### デプロイ（方法 B: ダッシュボードだけで済ませる）

ローカルに CLI を入れずに進めたい場合はこちら。

`supabase/functions/_bundled/` に、`_shared` を連結した**1 ファイル版**を置いてある。
これをダッシュボードの Edge Functions エディタに貼り付ければデプロイできる。

1. Dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**
2. 関数名を `slack-events` にする（**この名前でないと Request URL が変わる**）
3. エディタの中身を全消しし、`_bundled/slack-events.ts` の内容を貼り付ける
4. **Verify JWT** を **OFF** にする（Slack は JWT を付けてこないため）
5. Deploy
6. Dashboard → Edge Functions → **Secrets** で環境変数を登録する

1 ファイル版は自動生成物なので、直接編集しないこと。
ロジックを変えたら `_shared` を直して再生成する:

```bash
node scripts/build-single-file-functions.mjs
```

分割版と同じ結合テストを 1 ファイル版に対しても流せる:

```bash
FN_BUNDLE_DIR=supabase/functions/_bundled deno test --allow-all supabase/functions/tests/
```

### 🔧 Event Subscriptions の設定（デプロイ後に行う）

6. Slack App → **Event Subscriptions** を ON
7. Request URL に `https://<project-ref>.supabase.co/functions/v1/slack-events` を入力
   - 入力した瞬間に Slack が `url_verification` を投げるので、**Verified ✓** になることを確認
   - ここで失敗する場合は `--no-verify-jwt` を付け忘れていないか確認する
8. **Subscribe to bot events** に以下を追加
   - `message.channels` … チャンネルの投稿を受信する
     （プライベートチャンネルも対象にするなら `message.groups` も）
   - `reaction_added` … 📮 リアクションで過去の投稿を拾い上げる経路に使う
9. **Save Changes** → 変更を反映するため **Reinstall your app**

### 確認

対象チャンネルに何か投稿し、以下で 1 行増えることを確認する。

```sql
select created_at, source_type, raw_text, source_meta->>'permalink'
from feedback_items order by created_at desc limit 5;
```

この時点では `summary` / `priority` / `category` / `embedding` はすべて NULL で正しい。

### フィードバック以外の投稿の扱い

チャンネルには雑談・連絡・自動通知も流れてくるので、3 層で選別している。

| 層 | いつ | 何をするか | 変更方法 |
|---|---|---|---|
| 0 | insert 前 | 相槌・URL だけ・絵文字だけ・設定した定型文を**破棄** | `NOISE_PATTERNS` / `NOISE_MIN_LENGTH` / `ENABLE_PREINSERT_NOISE_FILTER` |
| 1 | Dify 分類時 | AI が「フィードバックでない」と判定したものを `status='ignored'` に落とす | `app_settings` の `triage.min_confidence` |
| 2 | 人 | 📮 リアクション、`#fb` マーク、ダッシュボードの「フィードバックに戻す」 | `SLACK_FEEDBACK_MARKERS` / `SLACK_FEEDBACK_REACTIONS` |

層 1 のノイズは**削除せず DB に残る**ので、ダッシュボードの「ノイズ判定」欄から
判定理由と確信度を確認し、誤判定はワンクリックで戻せる。

チームには「フィードバックとして確実に拾ってほしいものは `#fb` を付けるか 📮 を押す」
とだけ伝えれば足りる（付けなくても AI が拾う）。

> **絵文字を変えたい場合**: `SLACK_FEEDBACK_REACTIONS` にコロン無しの emoji name を
> カンマ区切りで指定する（既定は `inbox_tray,memo,mega`）。
> カスタム絵文字も名前を書けば使える。

### 確認（選別）

```
チャンネルに「了解です」と投稿   → feedback_items に入らない（層 0 で破棄）
チャンネルに「#fb 了解です」    → 入る（明示マークが層 0 を上書き）
過去の投稿に 📮 を付ける        → その投稿が取り込まれる
```

> **チャンネル ID の調べ方**: Slack でチャンネルを開き、チャンネル名 → 一番下の「チャンネル ID」。
> 別のチャンネルを追加する場合は `feedback_sources` に行を足す。
> ```sql
> insert into feedback_sources (app_id, source_type, source_identifier)
> select id, 'slack', 'C0XXXXXXXXX' from apps where slug = 'mysupport';
> ```

---

## Step 3. フォーム経路

### デプロイ

```bash
# フォームを設置する自社サイトのオリジンを許可リストに入れる
supabase secrets set FORM_ALLOWED_ORIGINS="https://mysupport.example.com,https://www.example.com"

supabase functions deploy submit-feedback --no-verify-jwt
```

### 🔧 手動設定

1. 各アプリのサイトにウィジェットを設置する

   **React の場合**
   ```tsx
   import { FeedbackWidget } from "./components/FeedbackWidget";

   <FeedbackWidget
     appSlug="mysupport"
     endpoint="https://<project-ref>.supabase.co/functions/v1/submit-feedback"
   />
   ```

   **React を使っていないサイトの場合**
   ```html
   <script
     src="https://<dashboard-host>/feedback-widget.js"
     data-app-slug="mysupport"
     data-endpoint="https://<project-ref>.supabase.co/functions/v1/submit-feedback"
     defer></script>
   ```

2. 新しいアプリを増やすときは `apps` に行を足し、その `slug` を `appSlug` に指定する
   ```sql
   insert into apps (name, slug) values ('新アプリ', 'new-app');
   ```

### 確認

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/submit-feedback" \
  -H "Content-Type: application/json" \
  -d '{"app_slug":"mysupport","message":"テスト投稿です","email":"me@example.com"}'
# → {"ok":true,"status":"inserted"}

# レートリミットの確認（6 回連続で叩くと 429 が返る）
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    "https://<project-ref>.supabase.co/functions/v1/submit-feedback" \
    -H "Content-Type: application/json" \
    -d '{"app_slug":"mysupport","message":"rate limit test"}'
done
```

---

## Step 4.（メール経路）

**今回はスコープ外。** 依頼者判断により実装していない。

再開する場合に必要になる手動設定は以下（参考）:

- 受信サービス（Cloudflare Email Routing / Resend Inbound / Postmark Inbound 等）の選定と契約
- 受信ドメインの MX / SPF / DKIM レコード設定
- `feedback+<slug>@yourdomain.com` 形式のエイリアス発行と `feedback_sources` への登録
- Webhook 署名検証用のシークレット発行

スキーマ側は `source_type = 'email'` を受け付ける状態のままなので、
`_shared/ingest.ts` の `ingestFeedback()` に正規化済みデータを渡すアダプタを 1 本足せば繋がる。

---

## Step 5. Dify による分類

### 🔧 手動設定

1. https://cloud.dify.ai （またはセルフホスト）でアカウントを作り、新規ワークスペースを作成
2. **「ワークフロー」** タイプのアプリを新規作成する（チャットフローではなく Workflow）
3. **開始ノード**に入力変数を定義する
   | 変数名 | 型 | 必須 |
   |---|---|---|
   | `feedback_text` | 段落（Paragraph） | ✓ |
   | `app_name` | 短文（Text） | – |
4. **LLM ノード**を追加し、モデル（例: `gpt-4o-mini` / `claude-haiku` 相当）を選ぶ。
   システムプロンプトの例:

   ```
   あなたは社内プロダクトのフィードバック分類器です。
   与えられたテキストを読み、次の JSON だけを出力してください。
   前後の説明文やコードフェンスは書かないでください。

   {
     "is_feedback": true | false,
     "confidence": 0.0〜1.0,
     "noise_reason": "is_feedback が false のときだけ、その理由を日本語で 30 字以内",
     "priority": "urgent" | "high" | "medium" | "low",
     "category": "bug" | "feature_request" | "ux" | "other",
     "summary": "日本語で 60 字以内の要約"
   }

   is_feedback の基準:
   このテキストは Slack チャンネルから拾ったもので、
   プロダクトへの意見以外（雑談・業務連絡・自動通知）も混ざっています。
   - true:  プロダクトの不具合報告、要望、使いにくさの指摘、
            ユーザーからの声の共有（伝聞でも可）
   - false: 日程調整・雑談・挨拶、デプロイやCIの自動通知、
            プロダクトと無関係な相談、社内の事務連絡
   判断に迷う場合は true にし、confidence を 0.5 以下にしてください。
   （確信度が低いものは取りこぼしを避けるため残す設計になっています）

   priority の基準:
   - urgent: 業務が停止する / データが失われる / 全ユーザーに影響
   - high:   主要機能が使えない、回避策が面倒
   - medium: 不便だが回避策がある
   - low:    軽微な指摘、感想

   category の基準:
   - bug:             期待どおり動かない
   - feature_request: 新しい機能や項目の要望
   - ux:              動くが分かりにくい・使いにくい
   - other:           上記に当てはまらないもの

   対象アプリ: {{app_name}}

   テキスト:
   {{feedback_text}}
   ```

   > `is_feedback` を返さない旧いワークフローでもコード側は動く（その場合は常に
   > フィードバック扱いになり、選別は層 0 と層 2 だけになる）。

5. **終了ノード**の出力変数名を `result` にし、LLM ノードの出力を割り当てる
   （`priority` / `category` / `summary` の 3 変数に分けても動く。コード側が両方に対応している）
6. **公開（Publish）** する
7. 左メニューの **「APIアクセス」** から API キー（`app-...`）を発行して控える

### デプロイ

```bash
supabase secrets set \
  DIFY_API_BASE_URL=https://api.dify.ai/v1 \
  DIFY_CLASSIFY_API_KEY=app-xxxxxxxxxxxx

# この時点ではまだ AI を有効化しない（Step 6 で埋め込みと一緒に入れる）
```

### 単体での確認

```bash
curl -X POST https://api.dify.ai/v1/workflows/run \
  -H "Authorization: Bearer app-xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": {"feedback_text":"ログインしても画面が真っ白で何もできません","app_name":"マイサポ"},
    "response_mode": "blocking",
    "user": "setup-check"
  }'
```

`data.outputs.result` に JSON が入っていれば OK。
ノイズ側も確認しておく:

```bash
curl -X POST https://api.dify.ai/v1/workflows/run \
  -H "Authorization: Bearer app-xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": {"feedback_text":"明日の定例、15時からに変更でお願いします","app_name":"マイサポ"},
    "response_mode": "blocking",
    "user": "setup-check"
  }'
# → is_feedback: false, confidence: 0.9 前後が返ればよい
```

---

## Step 6. 埋め込みベクトルの生成

Dify には任意テキストをベクトル化する汎用 API が無いため、
**埋め込みだけは OpenAI の embeddings API を直接呼ぶ**（理由は [DECISIONS.md](DECISIONS.md) 参照）。

### 🔧 手動設定

1. https://platform.openai.com/api-keys で API キーを発行する
2. 課金設定（支払い方法）を有効にする。無料枠のままだと 429 が返る

### デプロイ

```bash
supabase secrets set \
  OPENAI_API_KEY=sk-... \
  EMBEDDING_MODEL=text-embedding-3-small \
  EMBEDDING_DIMENSIONS=1536

# ここで AI 処理を有効化する（Step 5〜8 がまとめて動き出す）
supabase secrets set ENABLE_AI_ENRICHMENT=true

supabase functions deploy slack-events   --no-verify-jwt
supabase functions deploy submit-feedback --no-verify-jwt
supabase functions deploy process-feedback
```

> **モデルを変える場合**: 次元数が変わるなら `feedback_items.embedding` と
> `feedback_clusters.representative_embedding` の `vector(N)` も合わせて変更し、
> 既存の埋め込みは作り直しになる。`EMBEDDING_DIMENSIONS` と列定義がズレていると
> Edge Function 側が明示的にエラーを出すようにしてある。

### 既存データの遡り処理

Step 2〜3 で取り込んだ分は `processing_state = 'skipped'` のままなので、必要なら戻す。

```sql
update feedback_items set processing_state = 'pending' where processing_state = 'skipped';
```

```bash
# 20 件ずつ処理される。件数が多ければ複数回叩く
curl -X POST "https://<project-ref>.supabase.co/functions/v1/process-feedback" \
  -H "Authorization: Bearer <service_role_key>" \
  -H "Content-Type: application/json" -d '{"mode":"pending","limit":20}'
```

### 確認

```sql
select id, priority, category, summary,
       (embedding is not null) as has_embedding,
       processing_state, processing_error
from feedback_items order by created_at desc limit 10;
```

---

## Step 7-8. クラスタリングと採用スコア

コード側は Step 6 の時点で動いている（`assign_item_to_cluster()` が enrichment の最後に走る）。

### 🔧 手動設定: 取りこぼしの自動回収（推奨）

Dify や OpenAI が一時的に落ちると `processing_state = 'failed'` の item が残る。
`pg_cron` で定期的に回収させる。

1. Supabase Dashboard → Database → Extensions で `pg_cron` と `pg_net` を有効化する
2. SQL Editor で以下を実行（`<...>` を置き換える）

```sql
select cron.schedule(
  'reprocess-pending-feedback',
  '*/10 * * * *',                     -- 10 分ごと
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/process-feedback',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role_key>"}'::jsonb,
    body    := '{"mode":"pending","limit":20}'::jsonb
  );
  $$
);
```

### 確認

```sql
-- クラスタがスコア順に並ぶこと
select representative_summary, item_count, priority, category, score
from feedback_clusters
where app_id = (select id from apps where slug = 'mysupport')
order by score desc;
```

似た内容の意見を 3〜4 件わざと投稿し、1 つのクラスタにまとまることを確認する。
まとまりすぎる / 割れすぎる場合は閾値を調整する（README の「チューニング」参照）。

---

## Step 9. フロントエンド

### ローカルでの確認

```bash
cd web
cp .env.example .env    # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を記入
npm install
npm run dev             # http://localhost:5173
```

- `.env` を作らずに起動するとモックデータで表示される（UI だけ先に確認したいとき用）
- `http://localhost:5173/?widget-demo=1` で埋め込みフォームの見た目を確認できる

### 🔧 手動設定: 社内ユーザーの作成

ダッシュボードは認証必須（`authenticated` ロールのみ読み取り可）。
サインアップは無効にしてあるので、管理者がユーザーを追加する。

1. Supabase Dashboard → Authentication → Users → **Add user**
2. メールアドレスとパスワードを設定して作成（`Auto Confirm User` を ON）
3. または **Invite user** でメール招待（この場合はログイン画面の「メールリンクでログイン」を使う）

### 🔧 手動設定: Auth の URL 設定

4. Authentication → URL Configuration
   - **Site URL**: Lovable の本番 URL
   - **Redirect URLs**: `http://localhost:5173`（開発用）と Lovable のプレビュー URL を追加

---

## Step 10. GitHub → Lovable デプロイ

### 🔧 手動設定（初回のみ）

1. https://lovable.dev でプロジェクトを作成する
2. プロジェクト設定 → **GitHub** → **Connect to GitHub** で本リポジトリを連携する
   - Lovable の GitHub App にリポジトリへのアクセス権を付与する
3. ビルド設定を確認する（Vite の標準構成なので自動検出されるはず）
   - Root directory: `web`
   - Build command: `npm run build`
   - Output directory: `dist`
   - Node version: 20 以上
4. **環境変数**を Lovable 側に登録する（`web/.env` と同じ内容）
   | 変数 | 値 |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | anon public key |
   | `VITE_FEEDBACK_ENDPOINT` | `https://<project-ref>.supabase.co/functions/v1/submit-feedback` |

   > `service_role` キーは絶対にフロント側に入れないこと。RLS を素通りする。

5. デプロイ後の URL を Supabase の Authentication → URL Configuration に登録する（Step 9 参照）

### 以降の開発フロー

```
Claude Code / artifact でコンポーネントを作る
  → web/ で npm run dev して動作確認
  → git push
  → Lovable が push を検知して自動ビルド・デプロイ
```

Lovable 固有のライブラリや記法には依存していないので、
Lovable を外して Vercel / Netlify / Cloudflare Pages に載せ替えることもできる。

---

## 環境変数一覧

### Edge Functions（`supabase secrets set` で設定）

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `SUPABASE_URL` | 自動 | – | Supabase が自動注入 |
| `SUPABASE_SERVICE_ROLE_KEY` | 自動 | – | Supabase が自動注入 |
| `SLACK_SIGNING_SECRET` | Slack 経路 | – | 署名検証。未設定だと slack-events が 500 |
| `SLACK_BOT_TOKEN` | 任意 | – | 未設定でも動くが permalink と表示名が取れない |
| `ENABLE_AI_ENRICHMENT` | – | `false` | 分類・埋め込み・クラスタリングの有効化 |
| `DIFY_API_BASE_URL` | – | `https://api.dify.ai/v1` | セルフホスト時に変更 |
| `DIFY_CLASSIFY_API_KEY` | AI 有効時 | – | 分類ワークフローの API キー |
| `DIFY_TIMEOUT_MS` | – | `30000` | 分類のタイムアウト |
| `EMBEDDING_PROVIDER` | – | `openai` | `openai` / `dify_workflow` |
| `OPENAI_API_KEY` | AI 有効時 | – | 埋め込み生成用 |
| `EMBEDDING_MODEL` | – | `text-embedding-3-small` | – |
| `EMBEDDING_DIMENSIONS` | – | `1536` | DB の `vector(N)` と一致させる |
| `ENABLE_PREINSERT_NOISE_FILTER` | – | `true` | 層 0（insert 前の破棄）の有効/無効 |
| `NOISE_MIN_LENGTH` | – | `6` | 装飾を除いた本文がこの文字数未満ならノイズ |
| `NOISE_PATTERNS` | – | – | 自動通知等を落とす正規表現をカンマ区切りで |
| `SLACK_FEEDBACK_MARKERS` | – | `#fb,#feedback,#フィードバック,#要望,#不具合` | 明示マーク |
| `SLACK_FEEDBACK_REACTIONS` | – | `inbox_tray,memo,mega` | 拾い上げに使う emoji name |
| `ENABLE_AI_TRIAGE` | – | `true` | 層 1（AI によるノイズ判定）の有効/無効 |
| `AI_TRIAGE_SOURCE_TYPES` | – | `slack` | AI トリアージを掛けるソース種別 |
| `AI_TRIAGE_MIN_CONFIDENCE` | – | `0.7` | app_settings 未設定時のフォールバック |
| `SLACK_API_BASE_URL` | – | `https://slack.com/api` | 社内プロキシ経由にする場合のみ |
| `FORM_ALLOWED_ORIGINS` | 本番必須 | `*` | フォームを設置するオリジンをカンマ区切りで |
| `FORM_RATE_LIMIT_SHORT_MAX` | – | `5` | 短期ウィンドウの上限件数 |
| `FORM_RATE_LIMIT_SHORT_WINDOW_SEC` | – | `60` | 短期ウィンドウの秒数 |
| `FORM_RATE_LIMIT_LONG_MAX` | – | `30` | 長期ウィンドウの上限件数 |
| `FORM_RATE_LIMIT_LONG_WINDOW_SEC` | – | `3600` | 長期ウィンドウの秒数 |
| `CAPTCHA_PROVIDER` | – | – | `turnstile` / `recaptcha`。設定時のみ検証する |
| `CAPTCHA_SECRET_KEY` | – | – | 同上 |
| `REPROCESS_BATCH_SIZE` | – | `20` | 再処理の 1 回あたり件数 |

### フロントエンド（`web/.env` と Lovable の環境変数）

| 変数 | 説明 |
|---|---|
| `VITE_SUPABASE_URL` | 未設定ならモックデータで起動する |
| `VITE_SUPABASE_ANON_KEY` | 同上 |
| `VITE_FEEDBACK_ENDPOINT` | `FeedbackWidget` の既定送信先 |

---

## 手動設定チェックリスト（まとめ）

- [ ] Supabase プロジェクト作成、URL / anon key / service_role key の控え
- [ ] Supabase CLI のインストールと `supabase link`
- [ ] Slack App 作成、Bot Token Scopes 設定、ワークスペースにインストール
- [ ] Slack Bot を対象チャンネルに招待（`/invite`）
- [ ] Slack Event Subscriptions の Request URL 設定と Verified 確認
- [ ] `message.channels` / `reaction_added` イベントの購読設定 + Reinstall
- [ ] フィードバック拾い上げ用の絵文字を決めてチームに周知（既定は 📮 = `inbox_tray`）
- [ ] 自動通知が多いチャンネルなら `NOISE_PATTERNS` に定型文を登録
- [ ] 自社サイトへのフィードバックウィジェット設置
- [ ] `FORM_ALLOWED_ORIGINS` に設置先オリジンを登録
- [ ] Dify アカウント作成、分類ワークフロー作成・公開、API キー発行
- [ ] OpenAI API キー発行と課金設定
- [ ] `pg_cron` / `pg_net` 拡張の有効化と再処理ジョブ登録
- [ ] Supabase Auth で社内ユーザーを作成（サインアップは無効のまま）
- [ ] Supabase Auth の Site URL / Redirect URLs 設定
- [ ] Lovable プロジェクト作成と GitHub 連携
- [ ] Lovable への環境変数登録（`VITE_*` のみ。service_role は入れない）
