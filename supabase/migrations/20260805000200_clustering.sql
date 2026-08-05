-- =============================================================================
-- クラスタリング & 採用スコア算出
--
-- 設計メモ（詳細は docs/DECISIONS.md）
--   * 類似判定は pgvector のコサイン距離演算子 `<=>` を使う。similarity = 1 - distance。
--   * representative_embedding は「クラスタ所属 items の平均ベクトル（重心）」で更新する。
--     先頭 item のベクトル固定だと、最初に入った 1 件の言い回しにクラスタ全体が
--     引きずられて後続の recall が落ちるため。
--   * representative_summary は最初に作られたときの要約を維持する（毎回書き換えない）。
--     ダッシュボード上の見出しが更新のたびに変わるとレビュー体験が壊れるため。
--   * 同一 app に対する同時挿入で重複クラスタが生まれるのを防ぐため、
--     app_id 単位のトランザクション内アドバイザリロックを取る。
-- =============================================================================

-- 優先度の強さを数値化する（集計・比較用）
create or replace function public.priority_rank(p text)
returns int
language sql
immutable
as $$
  select case p
           when 'urgent' then 4
           when 'high'   then 3
           when 'medium' then 2
           when 'low'    then 1
           else 0
         end;
$$;

-- app_settings から数値設定を読む（未設定ならフォールバック値）
create or replace function public.get_setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
as $$
  select coalesce((select value #>> '{}' from public.app_settings where key = p_key)::numeric, p_default);
$$;

-- -----------------------------------------------------------------------------
-- 同一 app 内で最も似ているクラスタを 1 件返す
-- -----------------------------------------------------------------------------
create or replace function public.find_similar_cluster(
  p_app_id    uuid,
  p_embedding vector(1536)
)
returns table (cluster_id uuid, similarity double precision)
language sql
stable
as $$
  select c.id,
         1 - (c.representative_embedding <=> p_embedding) as similarity
  from public.feedback_clusters c
  where c.app_id = p_app_id
    and c.representative_embedding is not null
  order by c.representative_embedding <=> p_embedding
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- クラスタの集計値（件数・優先度・カテゴリ・重心ベクトル）を貼り直す
-- -----------------------------------------------------------------------------
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
  where c.id = p_cluster_id;

  -- 所属 item が 0 件になったクラスタは残さない
  delete from public.feedback_clusters
  where id = p_cluster_id and item_count = 0;
end;
$$;

-- -----------------------------------------------------------------------------
-- 採用スコアの再計算
--   score = normalize(item_count) * priority_weight
--   normalize: 同一 app 内の最大 item_count を 100 とする比例スケール
--              （min-max だと最小クラスタが常に 0 になり、
--                「1 件だけの urgent」が完全に埋もれるため max スケールを採用）
-- -----------------------------------------------------------------------------
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
  set score = round(
        (100.0 * c.item_count / v_max_count)
        * coalesce((v_weights ->> c.priority)::numeric, 1.0),
        4)
  where c.app_id = p_app_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- item を既存クラスタに紐付ける、または新規クラスタを作る
--   戻り値: 割り当てられた cluster_id
-- -----------------------------------------------------------------------------
create or replace function public.assign_item_to_cluster(
  p_item_id   uuid,
  p_threshold double precision default null
)
returns uuid
language plpgsql
as $$
declare
  v_item      public.feedback_items%rowtype;
  v_threshold double precision;
  v_match     record;
  v_cluster   uuid;
  v_old       uuid;
begin
  select * into v_item from public.feedback_items where id = p_item_id;
  if not found then
    raise exception 'feedback_item % not found', p_item_id;
  end if;

  if v_item.embedding is null then
    -- 埋め込みが無い item はクラスタリング対象外（呼び出し側で再試行する）
    return null;
  end if;

  v_threshold := coalesce(
    p_threshold,
    public.get_setting_numeric('clustering.similarity_threshold', 0.85)::double precision
  );

  -- 同一 app への同時挿入を直列化して、重複クラスタの生成を防ぐ
  perform pg_advisory_xact_lock(hashtextextended(v_item.app_id::text, 0));

  v_old := v_item.cluster_id;

  select * into v_match
  from public.find_similar_cluster(v_item.app_id, v_item.embedding);

  if found and v_match.similarity >= v_threshold then
    v_cluster := v_match.cluster_id;
  else
    insert into public.feedback_clusters (
      app_id, representative_summary, representative_embedding,
      category, priority, item_count, score
    )
    values (
      v_item.app_id,
      coalesce(v_item.summary, left(v_item.raw_text, 200)),
      v_item.embedding,
      v_item.category,
      v_item.priority,
      0,      -- 直後の refresh_cluster_aggregates() で実数に置き換わる
      0
    )
    returning id into v_cluster;
  end if;

  update public.feedback_items
  set cluster_id = v_cluster
  where id = p_item_id;

  perform public.refresh_cluster_aggregates(v_cluster);

  -- 付け替えが起きた場合は旧クラスタも締め直す
  if v_old is not null and v_old <> v_cluster then
    perform public.refresh_cluster_aggregates(v_old);
  end if;

  perform public.recalculate_app_scores(v_item.app_id);

  return v_cluster;
end;
$$;

-- -----------------------------------------------------------------------------
-- クラスタ単位のステータス更新（配下 items にも反映する）
--   ダッシュボードから RPC で呼ぶ
-- -----------------------------------------------------------------------------
create or replace function public.set_cluster_status(
  p_cluster_id uuid,
  p_status     text
)
returns public.feedback_clusters
language plpgsql
security invoker
as $$
declare
  v_row public.feedback_clusters%rowtype;
begin
  if p_status not in ('new', 'reviewing', 'adopted', 'done', 'rejected') then
    raise exception 'invalid status: %', p_status;
  end if;

  update public.feedback_clusters
  set status = p_status
  where id = p_cluster_id
  returning * into v_row;

  if not found then
    raise exception 'cluster % not found', p_cluster_id;
  end if;

  update public.feedback_items
  set status = p_status
  where cluster_id = p_cluster_id;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 簡易レートリミット
--   直近 p_window_seconds 秒に p_max_hits 回を超えていたら false を返す
-- -----------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_bucket_key     text,
  p_window_seconds int,
  p_max_hits       int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from public.rate_limit_hits
  where hit_at < now() - interval '1 day';

  select count(*) into v_count
  from public.rate_limit_hits
  where bucket_key = p_bucket_key
    and hit_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max_hits then
    return false;
  end if;

  insert into public.rate_limit_hits (bucket_key) values (p_bucket_key);
  return true;
end;
$$;
