-- =============================================================================
-- Feedback Debugger : 初期スキーマ
--   - pgvector 拡張
--   - apps / feedback_sources / feedback_items / feedback_clusters
--   - app_settings（スコア重み・類似度閾値などの運用チューニング用）
--   - rate_limit_hits（フォーム経由の簡易レートリミット用）
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- -----------------------------------------------------------------------------
-- 列挙値は check 制約で表現する（enum 型だと値追加時に migration が重くなるため）
-- -----------------------------------------------------------------------------
create domain public.source_type_t as text
  check (value in ('slack', 'form', 'email'));

create domain public.priority_t as text
  check (value in ('urgent', 'high', 'medium', 'low'));

create domain public.category_t as text
  check (value in ('bug', 'feature_request', 'ux', 'other'));

create domain public.status_t as text
  check (value in ('new', 'reviewing', 'adopted', 'done', 'rejected'));

-- -----------------------------------------------------------------------------
-- apps : アプリ登録マスタ
-- -----------------------------------------------------------------------------
create table public.apps (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  created_at timestamptz not null default now()
);

comment on table public.apps is 'フィードバックを集約する対象アプリのマスタ';
comment on column public.apps.slug is 'フォーム埋め込み・メールエイリアスの識別子。URL セーフな文字のみ';

alter table public.apps
  add constraint apps_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$');

-- -----------------------------------------------------------------------------
-- feedback_sources : アプリごとのソース設定
--   Slack チャンネル ID やメールエイリアスから app_id を逆引きするための表
-- -----------------------------------------------------------------------------
create table public.feedback_sources (
  id                uuid primary key default gen_random_uuid(),
  app_id            uuid not null references public.apps (id) on delete cascade,
  source_type       public.source_type_t not null,
  source_identifier text not null,
  created_at        timestamptz not null default now()
);

comment on column public.feedback_sources.source_identifier is
  'slack: チャンネル ID (C...) / email: 受信エイリアス / form: 任意のラベル';

-- 同じ識別子が複数アプリに紐づくと逆引きが破綻するので大域一意にする
create unique index feedback_sources_type_identifier_key
  on public.feedback_sources (source_type, lower(source_identifier));

create index feedback_sources_app_id_idx on public.feedback_sources (app_id);

-- -----------------------------------------------------------------------------
-- feedback_clusters : 類似フィードバックの集約単位
--   feedback_items から参照されるため先に作成する
-- -----------------------------------------------------------------------------
create table public.feedback_clusters (
  id                       uuid primary key default gen_random_uuid(),
  app_id                   uuid not null references public.apps (id) on delete cascade,
  representative_summary   text,
  representative_embedding vector(1536),
  category                 public.category_t,
  priority                 public.priority_t,
  item_count               int  not null default 1,
  score                    numeric(10, 4) not null default 0,
  -- 要件のスキーマ定義には無いが、クラスタ単位のステータス管理 UI のために追加
  status                   public.status_t not null default 'new',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on column public.feedback_clusters.priority is
  'クラスタ内 items のうち最も高い優先度（priority_rank() の集計結果）';
comment on column public.feedback_clusters.score is
  '採用スコア。recalculate_app_scores() が同一 app 内で再計算する';
comment on column public.feedback_clusters.status is
  '要件スキーマへの追加列。クラスタ単位のトリアージ状態';

create index feedback_clusters_app_score_idx
  on public.feedback_clusters (app_id, score desc);

-- -----------------------------------------------------------------------------
-- feedback_items : 個別フィードバック
-- -----------------------------------------------------------------------------
create table public.feedback_items (
  id          uuid primary key default gen_random_uuid(),
  app_id      uuid not null references public.apps (id) on delete cascade,
  source_type public.source_type_t not null,
  external_id text,
  raw_text    text not null,
  summary     text,
  priority    public.priority_t,
  category    public.category_t,
  embedding   vector(1536),
  cluster_id  uuid references public.feedback_clusters (id) on delete set null,
  source_meta jsonb not null default '{}'::jsonb,
  status      public.status_t not null default 'new',
  created_at  timestamptz not null default now(),

  -- 要件のスキーマ定義には無いが、AI エンリッチメントの再試行制御のために追加
  processing_state text not null default 'pending'
    check (processing_state in ('pending', 'processing', 'done', 'failed', 'skipped')),
  processing_error text,
  processed_at     timestamptz,

  constraint feedback_items_raw_text_not_blank check (length(btrim(raw_text)) > 0)
);

comment on column public.feedback_items.external_id is
  'Slack: <channel>:<message_ts> / form: form:<uuid>。重複排除に使う';
comment on column public.feedback_items.processing_state is
  '要件スキーマへの追加列。pending→processing→done/failed。再処理バッチが参照する';

-- 重複排除。external_id が null の行は制約対象外にしたいので部分 unique index を使う。
-- 要件は「external_id に unique」だが、ソース種別をまたいだ偶発衝突を避けるため
-- (source_type, external_id) の複合にしている。
create unique index feedback_items_source_external_id_key
  on public.feedback_items (source_type, external_id)
  where external_id is not null;

create index feedback_items_app_created_idx  on public.feedback_items (app_id, created_at desc);
create index feedback_items_cluster_idx      on public.feedback_items (cluster_id);
create index feedback_items_pending_idx      on public.feedback_items (processing_state, created_at)
  where processing_state in ('pending', 'failed');

-- ベクトル索引。
-- ivfflat は行数 0 の状態で作るとリストが最適化されないため、
-- 件数が増えた段階で REINDEX するか、下部コメントの hnsw に貼り替える。
create index feedback_items_embedding_idx
  on public.feedback_items using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- クラスタ検索は「同一 app_id 内の top1」なので、hnsw の方が recall/レイテンシとも安定する。
create index feedback_clusters_embedding_idx
  on public.feedback_clusters using hnsw (representative_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- -----------------------------------------------------------------------------
-- app_settings : 運用中にチューニングする値を DB 側に置く
-- -----------------------------------------------------------------------------
create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('scoring.priority_weights',
   '{"urgent": 1.5, "high": 1.2, "medium": 1.0, "low": 0.7}'::jsonb),
  ('clustering.similarity_threshold',
   '0.85'::jsonb),
  ('scoring.default_priority',
   '"medium"'::jsonb);

-- -----------------------------------------------------------------------------
-- rate_limit_hits : フォーム投稿の簡易レートリミット
--   別インフラ（Redis 等）を持ち込まずに済ませるため Postgres で数える
-- -----------------------------------------------------------------------------
create table public.rate_limit_hits (
  bucket_key text        not null,
  hit_at     timestamptz not null default now()
);

create index rate_limit_hits_key_time_idx on public.rate_limit_hits (bucket_key, hit_at desc);

-- -----------------------------------------------------------------------------
-- updated_at 自動更新
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger feedback_clusters_touch_updated_at
  before update on public.feedback_clusters
  for each row execute function public.touch_updated_at();
