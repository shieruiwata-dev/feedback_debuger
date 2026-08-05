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

---

## アーキテクチャ

```
 Slack Events API ──┐
                    ├─→ Edge Function（取り込みアダプタ）
 FeedbackWidget ────┘        │
                             │ 共通フォーマットに正規化
                             │ { app_id, source_type, raw_text, source_meta, external_id }
                             ↓
                      feedback_items に INSERT
                             │
                             │ バックグラウンド（Slack の 3 秒制限を守るため同期処理しない）
                             ↓
                   ┌─── Dify workflow ────→ priority / category / summary
                   └─── Embeddings API ───→ vector(1536)
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
| `process-feedback` | 有効 | 分類・埋め込み・クラスタリングの実行 / 再実行 / 再スコアリング |

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
  functions/
    _shared/                      # 全アダプタ共通の処理
    slack-events/                 # Slack 取り込みアダプタ
    submit-feedback/              # フォーム取り込みアダプタ
    process-feedback/             # エンリッチメント実行 / 再実行
    tests/                        # deno test
  tests/                          # psql で流す SQL テスト
web/
  src/components/FeedbackWidget.tsx  # 各アプリに埋め込むフォーム（React 版）
  public/feedback-widget.js          # 同上（素の JS 版・Shadow DOM）
  src/pages/Dashboard.tsx            # ダッシュボード本体
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
# Edge Function（署名検証・Dify 出力の正規化・アダプタの結合テスト）
deno test --allow-all supabase/functions/tests/

# DB（クラスタリング・スコアリング・RLS）
supabase start
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/clustering_test.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql

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
- **埋め込みは OpenAI に直接投げている。** Dify に汎用の embeddings API が無いため
  （詳細は [docs/DECISIONS.md](docs/DECISIONS.md)）。AI 関連の課金経路が Dify と OpenAI の 2 つになる。
