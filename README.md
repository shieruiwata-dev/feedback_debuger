# フィードバックデバッガー

複数の自社アプリについて、Slack・フィードバックフォームから届く意見を 1 つの DB に集約し、
AI で分類・類似度クラスタリングして「どの意見が多く支持されているか」をスコア化して確認するための社内ツール。

- **DB / API**: Supabase（Postgres + pgvector + Edge Functions）
- **AI**: Dify（分類）+ OpenAI Embeddings（ベクトル生成）
- **フロント**: React + `@supabase/supabase-js`（Lovable にデプロイ）

---

## 目次

- [できること](#できること)
- [アーキテクチャ](#アーキテクチャ)
- [ディレクトリ構成](#ディレクトリ構成)
- [セットアップ](#セットアップ)
- [フィードバック選別（ノイズ除去）](#フィードバック選別ノイズ除去)
- [長文の分割（1 論点 = 1 件）](#長文の分割1-論点--1-件)
- [採用スコアの算出方法](#採用スコアの算出方法)
- [クラスタリングの挙動](#クラスタリングの挙動)
- [チューニング](#チューニング)
- [テスト](#テスト)
- [既知の弱点・未対応事項](#既知の弱点未対応事項)

---

## できること

| 経路 | 状態 | 概要 |
|---|---|---|
| Slack | 実装済み | Events API で指定チャンネルの投稿を取り込む（署名検証あり） |
| フォーム | 実装済み | `<FeedbackWidget appSlug="..." />` を各アプリのサイトに埋め込む |
| メール | **未実装** | 当初要件に含まれていたが、依頼者判断で今回のスコープから除外 |

取り込んだ意見は Dify で `priority` / `category` / `summary` に分類され、
埋め込みベクトルで類似する意見どうしがクラスタにまとめられ、
「件数 × 優先度」の採用スコア順にダッシュボードへ並ぶ。

Slack チャンネルにはフィードバック以外の投稿も流れてくるため、
[フィードバック選別](#フィードバック選別ノイズ除去)で雑談・連絡・自動通知を落としている。

---

## アーキテクチャ

```
 Slack Events API ──┐
                    ├─→ Edge Function（取り込みアダプタ）
 FeedbackWidget ────┘        │
                             │ 共通フォーマットに正規化
                             │ { app_id, source_type, raw_text, source_meta, external_id }
                             │
                             │ 層 0: 定型ノイズを破棄（#fb / 📮 が付いていれば素通り）
                             ↓
                      feedback_items に INSERT
                             │
                             │ バックグラウンド（Slack の 3 秒制限を守るため同期処理しない）
                             ↓
                        Dify workflow
                             │ priority / category / summary / is_feedback
                             │
                             ├─ 層 1: ノイズ判定 → status='ignored' でここで打ち切り
                             │        （埋め込み API を呼ばずに済ませる）
                             ↓
                        Embeddings API ───→ vector(1536)
                             ↓
              pgvector で同一 app_id 内の既存クラスタと類似度比較
                 類似度 ≥ 0.85 → 既存クラスタに紐付け（item_count +1）
                 類似度 < 0.85 → 新規クラスタ作成
                             ↓
                      採用スコアを再計算
                             ↓
              ダッシュボード（React / Lovable）でスコア降順に表示
```

すべての取り込みアダプタは `_shared/ingest.ts` の `ingestFeedback()` を通る。
新しい経路（メール等）を足すときは、入力を `NormalizedFeedback` に変換して同じ関数に渡すだけでよい。

### Edge Functions

| 関数 | JWT 検証 | 用途 |
|---|---|---|
| `slack-events` | 無効 | Slack Events API の受信口（署名検証で保護） |
| `submit-feedback` | 無効 | フォームの受信口（レートリミット + ハニーポットで保護） |
| `process-feedback` | 有効 | 分類・トリアージ・埋め込み・クラスタリングの実行 / 再実行 / 再スコアリング |

---

## ディレクトリ構成

```
supabase/
  config.toml                     # ローカル開発 + 関数ごとの verify_jwt 設定
  migrations/
    20260805000100_init.sql       # 拡張・テーブル・インデックス
    20260805000200_clustering.sql # クラスタリング / スコアリング関数
    20260805000300_rls.sql        # RLS ポリシーと GRANT
    20260805000400_seed.sql       # マイサポ + Slack チャンネル登録
    20260805000500_triage.sql     # ノイズ選別（ignored ステータス・復帰 RPC）
    20260805000600_update_slack_channel.sql
    20260805000700_split_items.sql # 長文の分割（親子関係・split/unsplit RPC）
  functions/
    _shared/                      # 全アダプタ共通の処理（triage.ts に選別ロジック）
    slack-events/                 # Slack 取り込みアダプタ
    submit-feedback/              # フォーム取り込みアダプタ
    process-feedback/             # エンリッチメント実行 / 再実行
    tests/                        # deno test
  tests/                          # psql で流す SQL テスト
web/
  src/components/FeedbackWidget.tsx  # 各アプリに埋め込むフォーム（React 版）
  public/feedback-widget.js          # 同上（素の JS 版・Shadow DOM）
  src/pages/Dashboard.tsx            # ダッシュボード本体
  src/components/NoiseList.tsx       # ノイズ判定欄（誤判定の復帰）
docs/
  SETUP.md                        # 手動設定チェックリスト（実装順序に対応）
  DECISIONS.md                    # 実装時の判断と、そう決めた理由
```

---

## セットアップ

手動設定（Supabase プロジェクト作成、Slack App 設定、Dify ワークフロー作成、Lovable 連携など）は
**[docs/SETUP.md](docs/SETUP.md)** に実装順序どおりのチェックリストとしてまとめてある。

最短の流れだけ書くと:

```bash
# 1. DB
supabase link --project-ref <your-project-ref>
supabase db push

# 2. Edge Functions
supabase secrets set SLACK_SIGNING_SECRET=... SLACK_BOT_TOKEN=...
supabase functions deploy slack-events   --no-verify-jwt
supabase functions deploy submit-feedback --no-verify-jwt
supabase functions deploy process-feedback

# 3. フロント（ローカル確認）
cd web && cp .env.example .env && npm install && npm run dev
```

`web/.env` を設定しなければ、フロントはモックデータで起動する（UI を先に固めたいとき用）。

---

## フィードバック選別（ノイズ除去）

Slack チャンネルには「今日休みます」「デプロイしました」「👍」なども流れてくる。
これらをそのままクラスタリングすると、スコア上位が業務連絡で埋まって使い物にならない。

選別は 3 層。**不可逆な破棄は層 0 だけ**にして、迷うものは必ず DB に残す設計にしている。

| 層 | タイミング | 対象 | 結果 |
|---|---|---|---|
| 0 | insert 前 | 相槌 / URL だけ / 絵文字だけ / `NOISE_PATTERNS` に一致 | **破棄**（DB に残らない） |
| 1 | Dify 分類時 | AI が `is_feedback: false` かつ確信度が閾値以上 | `status='ignored'`（DB に残る） |
| 2 | 人 | 📮 リアクション / `#fb` マーク / ダッシュボードの復帰ボタン | 層 0・層 1 を上書きして取り込む |

### 層 0: 定型ノイズの破棄（AI コストゼロ）

`「了解です」「ありがとうございます」「👍」「https://ci.example.com/builds/482」` のような、
判断の余地がない投稿を insert 前に落とす。

```bash
# 自動通知の定型文を追加で落とす
supabase secrets set NOISE_PATTERNS='^\[Deploy\],^Build #\d+,^\[ALERT\]'

# 層 0 自体を止める（すべて DB に入れて層 1 に任せる）
supabase secrets set ENABLE_PREINSERT_NOISE_FILTER=false
```

### 層 1: AI による判定

Dify の分類ワークフローが `is_feedback` / `confidence` / `noise_reason` も返す。
**確信度が閾値以上のときだけ**ノイズ扱いにするので、AI が迷ったものは一覧に残る。

```sql
-- ノイズ判定を採用する確信度の下限（既定 0.7）
-- 下げるとノイズがよく落ちるが誤判定も増える。上げると逆
update app_settings set value = '0.85'::jsonb where key = 'triage.min_confidence';
```

判定されたものは削除されず `status='ignored'` になり、
ダッシュボードの「ノイズ判定」欄に**判定理由と確信度つき**で並ぶ。
誤判定を見つけたら「フィードバックに戻す」で復帰でき、再処理でクラスタリングまで進む。

### 層 2: 人が明示する

- **`#fb` を本文に含める** … 層 0・層 1 を両方素通りして必ず取り込む。マーク自体は本文から除去される
- **📮 リアクションを付ける** … 過去の投稿でも拾える。既にノイズ判定されていれば復帰する
- **ダッシュボードの「フィードバックに戻す」** … 誤判定の救済

```bash
# マークと絵文字は変更できる（絵文字はコロン無しの emoji name）
supabase secrets set \
  SLACK_FEEDBACK_MARKERS='#fb,#voc,#要望' \
  SLACK_FEEDBACK_REACTIONS='inbox_tray,mega,voc'
```

### 効き具合の確認

```sql
-- 直近 1 週間の選別結果
select
  count(*) filter (where status = 'ignored')                as ノイズ,
  count(*) filter (where status <> 'ignored')               as フィードバック,
  count(*) filter (where triage_reason like 'marker:%'
                      or triage_reason like 'reaction:%')   as 明示マーク,
  count(*) filter (where triage_reason like 'ai_low_confidence:%') as 判定保留
from feedback_items
where created_at > now() - interval '7 days';

-- ノイズ判定の理由を確信度順に見る（閾値を動かす材料）
select triage_confidence, triage_reason, left(raw_text, 40)
from feedback_items where status = 'ignored'
order by triage_confidence asc limit 20;
```

層 0 で捨てた分は DB に残らないので、件数は Edge Function のログ
（`dropped before insert (...)`）で確認する。

---

## 長文の分割（1 論点 = 1 件）

1 つの投稿に複数の指摘が混ざっていることがある。

> 検索が遅くて5秒くらい待たされます。あと申請履歴をCSVで出せると助かります。通知メールの文面も少し事務的すぎる気がします。

これを 1 件として扱うと、件数もスコアも実態からズレる:

- 3 つの論点が 1 つのクラスタに入り、それぞれの支持数が見えない
- 他に「検索が遅い」と言っている人が 5 人いても合流できない
- priority / category を 1 つしか付けられない（バグと要望と UX が同居する）

そこで **Dify の分類時に論点ごとへ分割し、それぞれを独立した `feedback_items` として持つ**。

```
元の投稿（status='split' で保存。一覧には出さない）
  ├─ 検索の応答が遅い          … bug  / high   → 「検索が遅い」クラスタへ
  ├─ 申請履歴のCSVエクスポート  … feature_request / medium → 別クラスタへ
  └─ 通知メールの文面が事務的    … ux   / low    → 別クラスタへ
```

- 分割は **Dify の 1 回の呼び出しの中**で行う（API 呼び出し回数は増えない）
- 子は `parent_item_id` で原文にたどれる。`source_meta.original_text` に原文も持つ
- Slack の permalink は子に引き継がれるので、どの子からも元発言へ飛べる
- **原文は削除しない。** 分割が不適切だったときは `unsplit_feedback_item(<親のid>)` で元に戻せる

### 言い回しが違っても同じ内容ならまとまる

分割した論点は**要約をベクトル化**してクラスタリングする（`EMBEDDING_SOURCE=summary`、既定）。

原文をそのまま埋め込むと、敬語・前置き・周辺の文脈が距離に混ざる。
要約は Dify 側で「事象だけを書く」よう指示してあるため、表現の揺れが落ちて距離が安定する。

```
「検索が遅くて待たされる」
「検索結果がなかなか出てこない」   → いずれも要約は「検索の応答が遅い」
「商品検索が重いです」              → 同じクラスタに合流し、item_count と score が上がる
```

原文で埋め込む挙動に戻したい場合は `EMBEDDING_SOURCE=raw_text`。

### 分けすぎないための調整

プロンプトで「迷ったら分けない」と指示している（過剰分割は件数を水増しし、優先順位を誤らせるため）。
それでも分かれすぎる／分かれなさすぎる場合は、`docs/SETUP.md` の Step 5 にある
`issues の分け方` の例を増減して調整する。

```sql
-- 分割の効き具合を見る
select
  count(*) filter (where status = 'split')          as 分割された投稿,
  count(*) filter (where parent_item_id is not null) as 分割で生まれた論点,
  round(avg(cnt), 2)                                 as 平均分割数
from feedback_items
left join lateral (
  select count(*) as cnt from feedback_items c where c.parent_item_id = feedback_items.id
) x on true
where status = 'split';
```

---

## 採用スコアの算出方法

```
score = (100 × item_count ÷ 同一app内の最大item_count) × priority_weight
```

- `priority_weight` の初期値: `urgent=1.5, high=1.2, medium=1.0, low=0.7`
- 重みも類似度閾値も **`app_settings` テーブルに置いてあり、SQL で変更できる**（再デプロイ不要）

正規化は「最大クラスタ = 100 の比例スケール」を採用した。
要件に例示された min-max（最小 = 0）ではなく max スケールにしたのは、
min-max だと最小クラスタのスコアが必ず 0 になり、
「1 件だけ届いた urgent なバグ報告」が一覧の最下部に埋もれてしまうため。

重みを変えたあとは全クラスタの再計算が必要:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/process-feedback" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"rescore"}'
```

---

## クラスタリングの挙動

1. 新規 item の埋め込みを生成する
2. 同一 `app_id` の既存クラスタに対し、コサイン距離 `<=>` で最も近い 1 件を取る
3. 類似度（`1 - 距離`）が閾値以上なら、そのクラスタに紐付ける
4. 未満なら新規クラスタを作り、この item の要約・ベクトルで初期化する
5. クラスタの集計値（件数・優先度・カテゴリ・代表ベクトル）を貼り直し、スコアを再計算する

判断したポイント（理由は [docs/DECISIONS.md](docs/DECISIONS.md)）:

- **代表ベクトルは所属 item の重心（平均）で毎回更新する。** 先頭 item のベクトル固定にしない
- **代表要約は初回の要約を維持する。** 更新のたびに見出しが変わるとレビューしづらいため
- 同一 app への同時挿入は `pg_advisory_xact_lock` で直列化し、重複クラスタの発生を防ぐ

---

## チューニング

```sql
-- 類似度閾値（初期値 0.85）。上げるとクラスタが細かく割れ、下げると粗く混ざる
update app_settings set value = '0.80'::jsonb
where key = 'clustering.similarity_threshold';

-- 優先度の重み
update app_settings set value = '{"urgent":2.0,"high":1.3,"medium":1.0,"low":0.5}'::jsonb
where key = 'scoring.priority_weights';
```

閾値を変えても**既存のクラスタは組み直されない**（新規取り込み分から適用される）。
過去分もまとめて組み直したい場合は、`feedback_items.cluster_id` を NULL にし、
`feedback_clusters` を削除してから `process-feedback` を全件に対して流し直す。

---

## テスト

```bash
# Edge Function（署名検証・Dify 出力の正規化・ノイズ選別・アダプタの結合テスト）
deno test --allow-all supabase/functions/tests/

# DB（クラスタリング・スコアリング・RLS）
supabase start
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/clustering_test.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/triage_test.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/split_test.sql

# フロント
cd web && npm run build
```

SQL テストは末尾で `rollback` するのでデータは残らない。

---

## 既知の弱点・未対応事項

### 採用スコアは「件数が多い＝重要」という仮定に立っている

これは初期ヒューリスティックであり、**実際のユーザー影響度を反映していない**。具体的には:

- **有償ユーザーか無償ユーザーかを区別していない。**
  課金額の大きい顧客からの 1 件と、無償ユーザーからの 10 件が、後者の勝ちになる。
- **声の大きさとユーザー数を区別していない。**
  Slack で社内メンバーが同じ不満を 5 回書けば 5 件としてカウントされる。同一人物の重複投稿も名寄せしていない。
- **サイレントマジョリティが反映されない。**
  そもそもフィードバックを送るユーザーは全体のごく一部で、送ってこないユーザーの困りごとは 0 件として扱われる。
- **ビジネス影響度・実装コストがまったく入っていない。**
  「1 行で直るタイポ」と「アーキテクチャ変更が必要な要望」が同じ土俵で比較される。

改善するなら `feedback_items.source_meta` に契約プラン・ユーザー ID・ARR 等を入れ、
スコア式に重みとして持ち込むのが素直な拡張になる（`recalculate_app_scores()` の 1 箇所を変えれば済む）。

### そのほか

- **メール経路は未実装。** 要件には含まれていたが、依頼者の判断でスコープ外にした。
  スキーマ（`source_type = 'email'`）と型定義、ダッシュボードのソースフィルタは残してあるので、
  受信サービスを決めてアダプタを 1 本足せば動く状態になっている。
- **CAPTCHA は未導入。** レートリミット（IP 単位 60 秒 5 件 / 1 時間 30 件）とハニーポットのみ。
  `_shared/spam.ts` に Turnstile / reCAPTCHA の検証口を用意してあり、環境変数を入れれば有効になる。
- **ダッシュボードはクライアント側でクラスタと item を結合している。**
  1 アプリあたり クラスタ 500 / item 3000 の取得上限を設けてある。これを超える規模になったら
  サーバー側ページネーション（またはクラスタ単位の遅延ロード）に切り替える必要がある。
- **`priority` はクラスタ内の最高値を採用している。** 1 件でも urgent が混ざるとクラスタ全体が urgent になる。
  誤分類が 1 件あるだけで順位が動くため、運用しながら「最頻値」への変更も検討する。
- **Dify の分類結果を人手で修正する UI が無い。** 現状 status しか変更できない。
- **層 0 で捨てた投稿は復元できない。** DB に残らないので、
  `#fb` を付け直すか 📮 を押して再送してもらう以外に手段がない。
  取りこぼしが心配なら `ENABLE_PREINSERT_NOISE_FILTER=false` にして
  すべて層 1（DB に残る側）に回す運用もできる。
- **ノイズ判定の精度を測る仕組みが無い。** 「戻す」操作の回数は記録されるが
  （`triage_reason = 'manual_restore'`）、
  逆に「ノイズを見逃した」件数は分からない。閾値調整は目視に頼ることになる。
- **📮 リアクションは `reaction_added` のみ扱う。** 付け間違えて外しても取り込みは取り消されない。
- **分割の粒度は LLM 任せ。** 「1 論点」の境界に絶対的な正解はなく、
  同じ投稿でも実行のたびに 2 分割/3 分割が揺れることがある。
  過剰分割は件数の水増しに直結するので、運用初期は上の SQL で平均分割数を見ておく。
- **分割の誤りを個別に直す UI が無い。** `unsplit_feedback_item()` を SQL で叩けば戻せるが、
  ダッシュボードからは操作できない。
- **要約を埋め込むため、要約が外すとクラスタリングも外す。**
  Dify が論点を取り違えた場合、原文が似ていても別クラスタに入る。
- **埋め込みは OpenAI に直接投げている。** Dify に汎用の embeddings API が無いため
  （詳細は [docs/DECISIONS.md](docs/DECISIONS.md)）。AI 関連の課金経路が Dify と OpenAI の 2 つになる。
