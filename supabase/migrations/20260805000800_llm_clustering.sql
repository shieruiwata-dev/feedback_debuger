-- =============================================================================
-- LLM によるクラスタ照合（埋め込み API を使わない経路）
--
-- 埋め込み API（OpenAI 等）が使えない環境向けに、
-- 「既存クラスタの要約一覧を LLM に見せて、同じ論点かどうかを判断させる」方式を足す。
-- pgvector 方式は残したまま、環境変数 CLUSTERING_STRATEGY で切り替える。
--
--   embedding … 従来どおり。要約をベクトル化して pgvector で最近傍を探す
--   llm       … 候補をここで絞り、Dify の分類呼び出しに同居させて照合する
--
-- LLM に全クラスタを見せると、増えるほどプロンプトが膨らんで精度もコストも悪化する。
-- そこで Postgres 側で候補を絞ってから渡す。
-- =============================================================================

-- 文字列の近さで候補を絞るために使う（日本語でも文字トライグラムとして機能する）
create extension if not exists "pg_trgm";

create index if not exists feedback_clusters_summary_trgm_idx
  on public.feedback_clusters using gin (representative_summary gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- LLM に見せる候補クラスタを選ぶ
--
-- 2 つの母集団を混ぜる:
--   1. 文字列が近いもの（同じ単語を含む論点）
--   2. 件数が多いもの（合流先になりやすい主要な論点）
-- 1 だけだと「検索が遅い」と「なかなか表示されない」のように
-- 語が重ならない同義の論点を候補から落としてしまう。
-- 2 を混ぜることで、主要クラスタは常に候補に残る。
-- -----------------------------------------------------------------------------
create or replace function public.candidate_clusters(
  p_app_id uuid,
  p_query  text,
  p_limit  int default 40
)
returns table (
  cluster_id uuid,
  summary    text,
  item_count int,
  similarity real
)
language sql
stable
as $$
  with scored as (
    select c.id,
           c.representative_summary,
           c.item_count,
           similarity(c.representative_summary, coalesce(p_query, '')) as sim
    from public.feedback_clusters c
    where c.app_id = p_app_id
      and c.representative_summary is not null
  ),
  by_similarity as (
    select * from scored order by sim desc, item_count desc limit p_limit
  ),
  by_size as (
    select * from scored order by item_count desc, sim desc
    limit greatest(p_limit / 2, 10)
  )
  select id, representative_summary, item_count, sim
  from (
    select * from by_similarity
    union
    select * from by_size
  ) merged
  order by sim desc, item_count desc
  limit p_limit;
$$;

comment on function public.candidate_clusters(uuid, text, int) is
  'LLM に突き合わせさせる候補クラスタ。文字列の近さと件数の多さの両方から拾う';

-- -----------------------------------------------------------------------------
-- クラスタを指定して item を割り当てる（埋め込み不要）
--   p_cluster_id が null なら新規クラスタを作る。
--   assign_item_to_cluster() のベクトル検索部分を、呼び出し側の判断で置き換えた版。
-- -----------------------------------------------------------------------------
create or replace function public.attach_item_to_cluster(
  p_item_id    uuid,
  p_cluster_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_item    public.feedback_items%rowtype;
  v_cluster uuid;
  v_old     uuid;
begin
  select * into v_item from public.feedback_items where id = p_item_id;
  if not found then
    raise exception 'feedback_item % not found', p_item_id;
  end if;

  -- 同一 app への同時挿入を直列化して、重複クラスタの生成を防ぐ
  perform pg_advisory_xact_lock(hashtextextended(v_item.app_id::text, 0));

  v_old := v_item.cluster_id;

  if p_cluster_id is not null then
    -- 他アプリのクラスタを指定されても紐付けない（LLM の出力を鵜呑みにしない）
    select id into v_cluster
    from public.feedback_clusters
    where id = p_cluster_id and app_id = v_item.app_id;
  end if;

  if v_cluster is null then
    insert into public.feedback_clusters (
      app_id, representative_summary, representative_embedding,
      category, priority, item_count, score
    )
    values (
      v_item.app_id,
      coalesce(v_item.summary, left(v_item.raw_text, 200)),
      v_item.embedding,   -- 埋め込み方式と併用する場合のみ入る。llm 方式では null
      v_item.category,
      v_item.priority,
      0,                  -- 直後の refresh_cluster_aggregates() で実数に置き換わる
      0
    )
    returning id into v_cluster;
  end if;

  update public.feedback_items
  set cluster_id = v_cluster
  where id = p_item_id;

  perform public.refresh_cluster_aggregates(v_cluster);

  if v_old is not null and v_old <> v_cluster then
    perform public.refresh_cluster_aggregates(v_old);
  end if;

  perform public.recalculate_app_scores(v_item.app_id);

  return v_cluster;
end;
$$;

comment on function public.attach_item_to_cluster(uuid, uuid) is
  'LLM が選んだクラスタに item を割り当てる。null なら新規作成。埋め込み不要';

revoke execute on function public.candidate_clusters(uuid, text, int)
  from public, anon, authenticated;
revoke execute on function public.attach_item_to_cluster(uuid, uuid)
  from public, anon, authenticated;
