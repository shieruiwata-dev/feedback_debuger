-- =============================================================================
-- 長文フィードバックの分割
--
-- 1 つの投稿に複数の論点が混ざっていることがある。
--   例: 「検索が遅いです。あとCSV出力が欲しい。通知メールの文面も固いです」
-- これを 1 件として扱うと、
--   - 3 つの論点が 1 つのクラスタに入り、件数が実態より少なく出る
--   - 「検索が遅い」と言っている人が他に 5 人いても合流できない
--   - priority / category が 1 つしか付けられない
-- ので、論点ごとに feedback_items を分けて持つ。
--
-- 元の投稿は削除せず status='split' で残す（分割が誤っていたときに原文へ戻れるように）。
-- 一覧には出さないが、子から parent_item_id でたどれる。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- status に 'split' を追加
--   'split' = この行は分割元の原文。実体は子（parent_item_id で紐づく行）にある
-- -----------------------------------------------------------------------------
alter domain public.status_t drop constraint status_t_check;
alter domain public.status_t add constraint status_t_check
  check (value in ('new', 'reviewing', 'adopted', 'done', 'rejected', 'ignored', 'split'));

-- -----------------------------------------------------------------------------
-- 親子関係
-- -----------------------------------------------------------------------------
alter table public.feedback_items
  add column parent_item_id uuid references public.feedback_items (id) on delete cascade,
  add column segment_index  int;

comment on column public.feedback_items.parent_item_id is
  '分割元の投稿。null なら分割されていない通常の item';
comment on column public.feedback_items.segment_index is
  '分割元の中での通し番号（1 始まり）。原文のどこ由来かを追うために持つ';

create index feedback_items_parent_idx on public.feedback_items (parent_item_id)
  where parent_item_id is not null;

-- 一覧表示の索引から 'split'（原文）も除外する
drop index if exists feedback_items_app_visible_idx;
create index feedback_items_app_visible_idx
  on public.feedback_items (app_id, created_at desc)
  where status not in ('ignored', 'split');

-- -----------------------------------------------------------------------------
-- 分割の実行
--   p_segments: [{"text": "...", "summary": "...", "priority": "high", "category": "bug"}, ...]
--
--   子は分類済みの状態で作り、processing_state='pending' にしておく。
--   後段（enrich.ts）が埋め込み生成とクラスタリングだけを行う。
--   分類をやり直さないので、Dify の呼び出しは投稿 1 件につき 1 回のままで済む。
-- -----------------------------------------------------------------------------
create or replace function public.split_feedback_item(
  p_parent_id uuid,
  p_segments  jsonb
)
returns setof public.feedback_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.feedback_items%rowtype;
  v_seg    jsonb;
  v_idx    int := 0;
  v_count  int;
begin
  select * into v_parent from public.feedback_items where id = p_parent_id;
  if not found then
    raise exception 'feedback_item % not found', p_parent_id;
  end if;

  if jsonb_typeof(p_segments) <> 'array' then
    raise exception 'p_segments must be a json array';
  end if;

  v_count := jsonb_array_length(p_segments);
  if v_count < 2 then
    raise exception 'split requires at least 2 segments (got %)', v_count;
  end if;

  -- 既に分割済みなら作り直さない（再処理で子が二重に増えるのを防ぐ）
  if exists (select 1 from public.feedback_items where parent_item_id = p_parent_id) then
    return query
      select * from public.feedback_items
      where parent_item_id = p_parent_id order by segment_index;
    return;
  end if;

  for v_seg in select * from jsonb_array_elements(p_segments) loop
    v_idx := v_idx + 1;

    insert into public.feedback_items (
      app_id, source_type, external_id, raw_text,
      summary, priority, category,
      source_meta, parent_item_id, segment_index,
      is_feedback, triage_reason, processing_state
    )
    values (
      v_parent.app_id,
      v_parent.source_type,
      -- 親の external_id に通し番号を足して一意にする（重複取り込みの排除は親側で効く）
      case when v_parent.external_id is null
           then null
           else v_parent.external_id || '#' || v_idx
      end,
      coalesce(nullif(btrim(v_seg ->> 'text'), ''), v_seg ->> 'summary'),
      v_seg ->> 'summary',
      (v_seg ->> 'priority')::public.priority_t,
      (v_seg ->> 'category')::public.category_t,
      -- 親の付帯情報（permalink 等）を引き継ぎ、原文も残す
      v_parent.source_meta
        || jsonb_build_object(
             'split_from_item_id', v_parent.id,
             'segment_index', v_idx,
             'segment_count', v_count,
             'original_text', v_parent.raw_text
           ),
      v_parent.id,
      v_idx,
      -- 親が明示マーク済みならその保護を子にも引き継ぐ
      v_parent.is_feedback,
      v_parent.triage_reason,
      'pending'
    );
  end loop;

  -- 親は一覧から外すが削除はしない
  update public.feedback_items
  set status           = 'split',
      processing_state = 'done',
      processed_at     = now(),
      triage_reason    = coalesce(triage_reason, '') || format(' split_into:%s', v_count),
      cluster_id       = null
  where id = p_parent_id;

  return query
    select * from public.feedback_items
    where parent_item_id = p_parent_id order by segment_index;
end;
$$;

comment on function public.split_feedback_item(uuid, jsonb) is
  '長文投稿を論点ごとの子 item に分割する。親は status=split で残す';

revoke execute on function public.split_feedback_item(uuid, jsonb)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 分割の取り消し（分割が不適切だったときの逃げ道）
-- -----------------------------------------------------------------------------
create or replace function public.unsplit_feedback_item(p_parent_id uuid)
returns public.feedback_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      public.feedback_items%rowtype;
  v_clusters uuid[];
  v_app_id   uuid;
begin
  select app_id into v_app_id from public.feedback_items where id = p_parent_id;
  if v_app_id is null then
    raise exception 'feedback_item % not found', p_parent_id;
  end if;

  -- 子が載っていたクラスタを控えてから消す（集計を締め直すため）
  select array_agg(distinct cluster_id) filter (where cluster_id is not null)
    into v_clusters
  from public.feedback_items where parent_item_id = p_parent_id;

  delete from public.feedback_items where parent_item_id = p_parent_id;

  update public.feedback_items
  set status           = 'new',
      processing_state = 'pending',
      processing_error = null
  where id = p_parent_id
  returning * into v_row;

  if v_clusters is not null then
    perform public.refresh_cluster_aggregates(c) from unnest(v_clusters) as c;
    perform public.recalculate_app_scores(v_app_id);
  end if;

  return v_row;
end;
$$;

grant execute on function public.unsplit_feedback_item(uuid) to authenticated;
