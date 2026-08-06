-- =============================================================================
-- 長文の分割（1 論点 = 1 item）の動作確認
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/split_test.sql
--
-- 「違う言い回しでも内容が同じならまとまり、スコアが上がる」ことも併せて確認する。
-- =============================================================================

begin;

create or replace function pg_temp.test_vec(x double precision, y double precision)
returns vector(1536) language sql immutable as $$
  select ('[' || x || ',' || y || ',' || repeat('0,', 1533) || '0]')::vector(1536);
$$;

create or replace function pg_temp.check(label text, actual anyelement, expected anyelement)
returns void language plpgsql as $$
begin
  if actual is not distinct from expected then
    raise notice 'PASS  %  (= %)', label, actual;
  else
    raise exception 'FAIL  %  expected=% actual=%', label, expected, actual;
  end if;
end;
$$;

insert into public.apps (name, slug) values ('分割テスト', 'test-app-split')
on conflict (slug) do nothing;

create temp view t_app as select id from public.apps where slug = 'test-app-split';

-- -----------------------------------------------------------------------------
-- 1. 3 つの論点が混ざった長文を分割する
-- -----------------------------------------------------------------------------
insert into public.feedback_items (app_id, source_type, external_id, raw_text, source_meta)
select id, 'slack', 'C_SPLIT:3001',
       '検索が遅くて5秒くらい待たされます。あと申請履歴をCSVで出せると助かります。'
       '通知メールの文面も少し事務的すぎる気がします。',
       '{"channel_id":"C_SPLIT","permalink":"https://example.slack.com/p1"}'::jsonb
from t_app;

select public.split_feedback_item(
  (select id from public.feedback_items where external_id = 'C_SPLIT:3001'),
  '[
    {"text":"検索が遅くて5秒くらい待たされます",
     "summary":"検索が遅い","priority":"high","category":"bug"},
    {"text":"申請履歴をCSVで出せると助かります",
     "summary":"申請履歴のCSVエクスポート要望","priority":"medium","category":"feature_request"},
    {"text":"通知メールの文面も少し事務的すぎる",
     "summary":"通知メールの文面が事務的","priority":"low","category":"ux"}
  ]'::jsonb);

select pg_temp.check(
  '3 件の子ができる',
  (select count(*)::int from public.feedback_items i join t_app a on i.app_id = a.id
    where i.parent_item_id is not null),
  3);

select pg_temp.check(
  '親は status=split になり一覧から外れる',
  (select status::text from public.feedback_items where external_id = 'C_SPLIT:3001'),
  'split');

select pg_temp.check(
  '子の external_id は親 + 通し番号',
  (select string_agg(external_id, ',' order by segment_index)
     from public.feedback_items where parent_item_id =
       (select id from public.feedback_items where external_id = 'C_SPLIT:3001')),
  'C_SPLIT:3001#1,C_SPLIT:3001#2,C_SPLIT:3001#3');

select pg_temp.check(
  '子ごとに優先度が分かれる',
  (select string_agg(priority::text, ',' order by segment_index)
     from public.feedback_items where parent_item_id =
       (select id from public.feedback_items where external_id = 'C_SPLIT:3001')),
  'high,medium,low');

select pg_temp.check(
  '子ごとにカテゴリが分かれる',
  (select string_agg(category::text, ',' order by segment_index)
     from public.feedback_items where parent_item_id =
       (select id from public.feedback_items where external_id = 'C_SPLIT:3001')),
  'bug,feature_request,ux');

-- permalink 等の付帯情報は子に引き継がれる（ダッシュボードから元発言に飛べる）
select pg_temp.check(
  'permalink が子に引き継がれる',
  (select source_meta ->> 'permalink' from public.feedback_items
    where external_id = 'C_SPLIT:3001#2'),
  'https://example.slack.com/p1');

select pg_temp.check(
  '原文が子に保持される（分割ミス時に戻れる）',
  (select (source_meta ->> 'original_text') like '検索が遅くて%通知メール%'
     from public.feedback_items where external_id = 'C_SPLIT:3001#3'),
  true);

select pg_temp.check(
  '子は埋め込み待ち（pending）で作られる',
  (select count(*)::int from public.feedback_items
    where parent_item_id = (select id from public.feedback_items where external_id = 'C_SPLIT:3001')
      and processing_state = 'pending'),
  3);

-- -----------------------------------------------------------------------------
-- 2. 二重実行しても子が増えない（再処理でありうる）
-- -----------------------------------------------------------------------------
select public.split_feedback_item(
  (select id from public.feedback_items where external_id = 'C_SPLIT:3001'),
  '[{"text":"a","summary":"a","priority":"low","category":"other"},
    {"text":"b","summary":"b","priority":"low","category":"other"}]'::jsonb);

select pg_temp.check(
  '二重実行しても子は 3 件のまま',
  (select count(*)::int from public.feedback_items i join t_app a on i.app_id = a.id
    where i.parent_item_id is not null),
  3);

-- -----------------------------------------------------------------------------
-- 3. 別の投稿の「言い回しが違うが同じ内容」がクラスタに合流し、スコアが上がる
-- -----------------------------------------------------------------------------
-- 分割した子にベクトルを与えてクラスタリング（実運用では要約を埋め込む）
update public.feedback_items set embedding = pg_temp.test_vec(1, 0)
where external_id = 'C_SPLIT:3001#1';                    -- 検索が遅い
update public.feedback_items set embedding = pg_temp.test_vec(0, 1)
where external_id = 'C_SPLIT:3001#2';                    -- CSV 要望
update public.feedback_items set embedding = pg_temp.test_vec(-1, 0)
where external_id = 'C_SPLIT:3001#3';                    -- メール文面

select public.assign_item_to_cluster(id) from public.feedback_items
where external_id in ('C_SPLIT:3001#1', 'C_SPLIT:3001#2', 'C_SPLIT:3001#3');

select pg_temp.check(
  '論点ごとに別クラスタになる',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  3);

select pg_temp.check(
  '分割直後は全クラスタ 1 件ずつ',
  (select max(item_count) from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

-- 別の人が別の言い方で「検索が遅い」と言う（ベクトルはほぼ同じ向き = 要約が似ている想定）
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, embedding)
select id, 'slack', 'C_SPLIT:3002', '検索結果がなかなか出てこないんだけど',
       '検索の応答が遅い', 'high', 'bug', pg_temp.test_vec(0.99, 0.141)
from t_app;

select public.assign_item_to_cluster(id) from public.feedback_items
where external_id = 'C_SPLIT:3002';

select pg_temp.check(
  '言い回しが違っても同じクラスタに合流する',
  (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3002'),
  (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3001#1'));

select pg_temp.check(
  'クラスタ数は増えない',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  3);

select pg_temp.check(
  '合流した分 item_count が上がる',
  (select item_count from public.feedback_clusters
    where id = (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3002')),
  2);

-- スコアが上がっていること: 2件クラスタ = 100 * 2/2 * 1.2(high) = 120
select pg_temp.check(
  '合流でスコアが上がる',
  (select score from public.feedback_clusters
    where id = (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3002')),
  120.0000::numeric);

-- 1 件だけのクラスタは相対的に下がる: 100 * 1/2 * 1.0(medium) = 50
select pg_temp.check(
  '1件クラスタは相対的に下がる',
  (select score from public.feedback_clusters
    where id = (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3001#2')),
  50.0000::numeric);

select pg_temp.check(
  'スコア降順の先頭は合流したクラスタ',
  (select c.id from public.feedback_clusters c join t_app a on c.app_id = a.id
    order by c.score desc limit 1),
  (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3002'));

-- -----------------------------------------------------------------------------
-- 4. 分割の取り消し
-- -----------------------------------------------------------------------------
select public.unsplit_feedback_item(
  (select id from public.feedback_items where external_id = 'C_SPLIT:3001'));

select pg_temp.check(
  '取り消しで子が消える',
  (select count(*)::int from public.feedback_items i join t_app a on i.app_id = a.id
    where i.parent_item_id is not null),
  0);

select pg_temp.check(
  '取り消しで親が再処理待ちに戻る',
  (select processing_state from public.feedback_items where external_id = 'C_SPLIT:3001'),
  'pending');

select pg_temp.check(
  '子が抜けた分クラスタの集計が締め直される',
  (select item_count from public.feedback_clusters
    where id = (select cluster_id from public.feedback_items where external_id = 'C_SPLIT:3002')),
  1);

-- 空になったクラスタ（CSV 要望・メール文面）は掃除され、検索クラスタだけが残る
select pg_temp.check(
  '空クラスタは掃除される',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

rollback;
