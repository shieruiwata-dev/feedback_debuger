-- =============================================================================
-- Notion 同期
--
-- ダッシュボードを別に建てず、集計結果を Notion のデータベースに書き出す。
-- 「論点 1 つ = Notion のページ 1 枚」で、ページ本文に元の投稿を並べる。
--
-- 同期は片方向（Supabase → Notion）。
-- Notion 側で人が入れたステータスや担当者は上書きしない。
-- そのためにこちらが書き込むプロパティを app_settings で明示的に限定する。
--
-- 差分だけ送るために、
--   - クラスタ側は updated_at と notion_synced_at を比べる
--   - item 側は notion_block_id が null のものだけを追記する
-- という 2 つの目印を持つ。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 目印の列
-- -----------------------------------------------------------------------------
alter table public.feedback_clusters
  add column if not exists notion_page_id   text,
  add column if not exists notion_synced_at timestamptz;

comment on column public.feedback_clusters.notion_page_id is
  '対応する Notion ページの ID。null なら未作成';
comment on column public.feedback_clusters.notion_synced_at is
  '最後に Notion へ書き出した時刻。updated_at がこれより新しければ再送する';

alter table public.feedback_items
  add column if not exists notion_block_id text;

comment on column public.feedback_items.notion_block_id is
  'Notion ページ本文に追記したブロックの ID。null なら未追記';

-- 未同期・要更新のクラスタを引くための部分索引
create index if not exists feedback_clusters_notion_dirty_idx
  on public.feedback_clusters (app_id, updated_at)
  where notion_page_id is null or notion_synced_at is null or updated_at > notion_synced_at;

create index if not exists feedback_items_notion_pending_idx
  on public.feedback_items (cluster_id)
  where notion_block_id is null and cluster_id is not null;

-- -----------------------------------------------------------------------------
-- 消えたクラスタの後始末
--
-- item が 0 件になったクラスタは refresh_cluster_aggregates が削除する。
-- そのとき Notion 側にページだけが残ると、実体のない論点が一覧に居座るので、
-- ページ ID を控えておいて次回の同期でアーカイブする。
-- -----------------------------------------------------------------------------
create table if not exists public.notion_orphan_pages (
  page_id     text primary key,
  cluster_id  uuid,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

comment on table public.notion_orphan_pages is
  '削除済みクラスタに対応する Notion ページ。同期処理がアーカイブしてから archived_at を埋める';

create or replace function public.record_notion_orphan()
returns trigger
language plpgsql
as $$
begin
  if old.notion_page_id is not null then
    insert into public.notion_orphan_pages (page_id, cluster_id)
    values (old.notion_page_id, old.id)
    on conflict (page_id) do nothing;
  end if;
  return old;
end;
$$;

drop trigger if exists feedback_clusters_notion_orphan on public.feedback_clusters;
create trigger feedback_clusters_notion_orphan
  before delete on public.feedback_clusters
  for each row execute function public.record_notion_orphan();

-- -----------------------------------------------------------------------------
-- updated_at を「実際に変化があったとき」だけ進める
--
-- 差分同期はこの列だけを頼りに「送るか送らないか」を決める。ところが既存の作りには
-- 2 つ問題があった。
--
--   (1) touch_updated_at トリガが now() を入れていた。
--       now() はトランザクション開始時刻で固定なので、同じトランザクション内で
--       「更新 → 同期済みを記録」と続けると両者が同じ値になり、差分が消える。
--   (2) 値が変わっていなくても update 文を投げれば updated_at が進んでいた。
--       recalculate_app_scores は同一 app の全クラスタを対象にするため、
--       1 件取り込むたびに全クラスタが要同期となり、Notion へ毎回全件送ることになる。
--       さらに「同期済みを記録する」update 自体も updated_at を進めてしまうため、
--       同期した直後にまた要同期になり、永久に送り続ける状態になる。
--
-- 対処:
--   トリガを clock_timestamp() に変え、さらに when 句で
--   「中身の列が変わったときだけ」動くようにする。
--   notion_page_id / notion_synced_at は同期の帳簿であって中身ではないので対象外。
--   representative_embedding も内部値なので除く（Notion 側の表示は変わらない）。
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists feedback_clusters_touch_updated_at on public.feedback_clusters;
create trigger feedback_clusters_touch_updated_at
  before update on public.feedback_clusters
  for each row
  when (
    old.representative_summary is distinct from new.representative_summary
    or old.priority   is distinct from new.priority
    or old.category   is distinct from new.category
    or old.item_count is distinct from new.item_count
    or old.score      is distinct from new.score
    or old.status     is distinct from new.status
  )
  execute function public.touch_updated_at();

create or replace function public.refresh_cluster_aggregates(p_cluster_id uuid)
returns void
language plpgsql
as $$
begin
  update public.feedback_clusters c
  set item_count = coalesce(agg.cnt, 0),
      priority   = coalesce(agg.top_priority, c.priority),
      category   = coalesce(agg.top_category, c.category),
      representative_embedding = coalesce(agg.centroid, c.representative_embedding)
  from (
    select
      count(*)                                     as cnt,
      avg(i.embedding)                             as centroid,
      -- 優先度はクラスタ内で最も高いものを代表値にする
      (select i2.priority
         from public.feedback_items i2
        where i2.cluster_id = p_cluster_id and i2.priority is not null
        order by public.priority_rank(i2.priority) desc, i2.created_at asc
        limit 1)                                   as top_priority,
      -- カテゴリは最頻値（同数なら先に入った方）
      (select i3.category
         from public.feedback_items i3
        where i3.cluster_id = p_cluster_id and i3.category is not null
        group by i3.category
        order by count(*) desc, min(i3.created_at) asc
        limit 1)                                   as top_category
    from public.feedback_items i
    where i.cluster_id = p_cluster_id
  ) agg
  where c.id = p_cluster_id
    -- 何も変わらないなら update しない（updated_at を無駄に進めないため）
    and (
      c.item_count is distinct from coalesce(agg.cnt, 0)
      or c.priority is distinct from coalesce(agg.top_priority, c.priority)
      or c.category is distinct from coalesce(agg.top_category, c.category)
      or c.representative_embedding
         is distinct from coalesce(agg.centroid, c.representative_embedding)
    );

  -- 所属 item が 0 件になったクラスタは残さない
  delete from public.feedback_clusters
  where id = p_cluster_id and item_count = 0;
end;
$$;

create or replace function public.recalculate_app_scores(p_app_id uuid)
returns void
language plpgsql
as $$
declare
  v_weights   jsonb;
  v_max_count int;
begin
  select value into v_weights
  from public.app_settings where key = 'scoring.priority_weights';

  v_weights := coalesce(v_weights, '{"urgent":1.5,"high":1.2,"medium":1.0,"low":0.7}'::jsonb);

  select greatest(max(item_count), 1) into v_max_count
  from public.feedback_clusters where app_id = p_app_id;

  if v_max_count is null then
    return;
  end if;

  update public.feedback_clusters c
  set score = v.new_score
  from (
    select id,
           round(
             (100.0 * item_count / v_max_count)
             * coalesce((v_weights ->> priority)::numeric, 1.0),
             4) as new_score
    from public.feedback_clusters
    where app_id = p_app_id
  ) v
  where c.id = v.id
    and c.score is distinct from v.new_score;
end;
$$;

-- -----------------------------------------------------------------------------
-- 同期対象のクラスタを引く
--
-- 「まだページが無い」「前回同期より後に中身が変わった」のどちらかで、
-- かつ件数が下限以上のものを、新しく動いた順に返す。
-- -----------------------------------------------------------------------------
create or replace function public.notion_sync_queue(
  p_limit  int  default 50,
  p_app_id uuid default null
)
returns table (
  cluster_id     uuid,
  app_id         uuid,
  app_name       text,
  summary        text,
  priority       public.priority_t,
  category       public.category_t,
  status         public.status_t,
  item_count     int,
  score          numeric,
  notion_page_id text,
  created_at     timestamptz,
  updated_at     timestamptz
)
language sql
stable
as $$
  select c.id, c.app_id, a.name, c.representative_summary,
         c.priority, c.category, c.status, c.item_count, c.score,
         c.notion_page_id, c.created_at, c.updated_at
  from public.feedback_clusters c
  join public.apps a on a.id = c.app_id
  where (p_app_id is null or c.app_id = p_app_id)
    and c.item_count >= public.get_setting_numeric('notion.min_item_count', 1)
    and (
      c.notion_page_id is null
      or c.notion_synced_at is null
      or c.updated_at > c.notion_synced_at
    )
  order by c.updated_at asc
  limit greatest(p_limit, 1);
$$;

comment on function public.notion_sync_queue(int, uuid) is
  'Notion へ書き出す必要があるクラスタ。古い変更から順に返す';

-- -----------------------------------------------------------------------------
-- ページ本文へまだ追記していない item を引く
--   分割された子は原文ではなく該当箇所だけを持つので、そのまま出せばよい。
-- -----------------------------------------------------------------------------
create or replace function public.notion_pending_items(
  p_cluster_id uuid,
  p_limit      int default 20
)
returns table (
  item_id      uuid,
  raw_text     text,
  summary      text,
  source_type  public.source_type_t,
  permalink    text,
  author       text,
  created_at   timestamptz
)
language sql
stable
as $$
  select i.id, i.raw_text, i.summary, i.source_type,
         i.source_meta ->> 'permalink',
         coalesce(i.source_meta ->> 'slack_user_name', i.source_meta ->> 'author'),
         i.created_at
  from public.feedback_items i
  where i.cluster_id = p_cluster_id
    and i.notion_block_id is null
    and i.status <> 'split'
  order by i.created_at asc
  limit greatest(p_limit, 1);
$$;

comment on function public.notion_pending_items(uuid, int) is
  'Notion ページ本文へまだ追記していない元投稿';

-- -----------------------------------------------------------------------------
-- 書き出し完了の記録
--
-- p_seen_updated_at には「同期処理がキューから読み取ったときの updated_at」を渡す。
-- 読み取ってから書き終わるまでの間にクラスタが更新されていた場合、
-- Notion に送ったのは古い内容なので、同期済みの印を進めてはいけない。
--
--   時刻 T1  取り込み処理がクラスタを更新（コミット前）
--   時刻 T2  同期処理が古い内容を読む
--   時刻 T3  取り込み処理がコミット
--   時刻 T4  同期処理が「同期済み」を書く  ← ここで印を進めると T1 の変更が永久に消える
--
-- updated_at が読み取り時と一致するときだけ印を進めることで、
-- ずれていれば次回また拾われる（取りこぼすより二度送るほうが安全）。
--
-- ページ ID は内容が古かろうと必ず記録する。記録しないと次回ページを作り直してしまい、
-- Notion に同じ論点のページが二重にできる。
-- -----------------------------------------------------------------------------
create or replace function public.mark_cluster_notion_synced(
  p_cluster_id      uuid,
  p_page_id         text,
  p_seen_updated_at timestamptz default null
)
returns boolean
language plpgsql
as $$
declare
  v_marked boolean;
begin
  update public.feedback_clusters
  set notion_page_id   = p_page_id,
      notion_synced_at = case
        when p_seen_updated_at is null or updated_at = p_seen_updated_at
        then clock_timestamp()
        else notion_synced_at
      end
  where id = p_cluster_id
  returning (notion_synced_at is not null and notion_synced_at >= updated_at)
  into v_marked;

  return coalesce(v_marked, false);
end;
$$;

comment on function public.mark_cluster_notion_synced(uuid, text, timestamptz) is
  'Notion への書き出し完了を記録する。読み取り後に更新されていれば印を進めず、次回再送する';

create or replace function public.mark_item_notion_block(
  p_item_id  uuid,
  p_block_id text
)
returns void
language sql
as $$
  update public.feedback_items
  set notion_block_id = p_block_id
  where id = p_item_id;
$$;

create or replace function public.mark_notion_orphan_archived(p_page_id text)
returns void
language sql
as $$
  update public.notion_orphan_pages
  set archived_at = now()
  where page_id = p_page_id;
$$;

-- Notion 側でページが消された場合の作り直し用
create or replace function public.clear_cluster_notion_page(p_cluster_id uuid)
returns void
language sql
as $$
  update public.feedback_clusters
  set notion_page_id = null, notion_synced_at = null
  where id = p_cluster_id;

  update public.feedback_items
  set notion_block_id = null
  where cluster_id = p_cluster_id;
$$;

-- -----------------------------------------------------------------------------
-- 設定
--
-- property_map は「こちらの項目 → Notion のプロパティ名」の対応表。
-- Notion 側のデータベースは別の人が作るので、名前が違っても
-- ここを書き換えるだけで合わせられるようにしておく。
-- 値を null にした項目は書き込まない。
--
-- title だけは特別扱いで、Notion のデータベースで type=title のプロパティを
-- 自動で探して使う（名前に依存させない）。
-- -----------------------------------------------------------------------------
--   notion.property_map    … 項目 → Notion のプロパティ名。存在しない名前は自動で読み飛ばす
--   notion.min_item_count  … Notion に出す最低件数。2 にすると「2 人以上が言った論点」だけ上がる
--   notion.*_labels        … 優先度・種別を Notion のセレクト名に読み替える表
insert into public.app_settings (key, value) values
  ('notion.property_map',
   '{
      "score": "スコア",
      "item_count": "件数",
      "priority": "優先度",
      "category": "種別",
      "app_name": "アプリ",
      "last_updated": "最終更新"
    }'::jsonb),
  ('notion.min_item_count', '1'::jsonb),
  ('notion.priority_labels',
   '{"urgent":"urgent","high":"high","medium":"medium","low":"low"}'::jsonb),
  ('notion.category_labels',
   '{"bug":"bug","feature_request":"feature_request","ux":"ux","other":"other"}'::jsonb)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 権限
--   同期は Edge Function が service_role で行う。画面から触らせる必要はない。
-- -----------------------------------------------------------------------------
revoke all on public.notion_orphan_pages from public, anon, authenticated;

revoke execute on function public.notion_sync_queue(int, uuid) from public, anon, authenticated;
revoke execute on function public.notion_pending_items(uuid, int) from public, anon, authenticated;
revoke execute on function public.mark_cluster_notion_synced(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.mark_item_notion_block(uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_notion_orphan_archived(text) from public, anon, authenticated;
revoke execute on function public.clear_cluster_notion_page(uuid) from public, anon, authenticated;
