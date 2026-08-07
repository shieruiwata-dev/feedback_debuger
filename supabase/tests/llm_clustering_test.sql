-- =============================================================================
-- LLM 照合方式のクラスタリング（埋め込みを使わない経路）の動作確認
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/llm_clustering_test.sql
-- =============================================================================

begin;

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

insert into public.apps (name, slug) values ('LLM照合テスト', 'test-app-llm')
on conflict (slug) do nothing;

create temp view t_app as select id from public.apps where slug = 'test-app-llm';

-- -----------------------------------------------------------------------------
-- 1. 埋め込みが無くても新規クラスタを作れる
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category)
select id, 'slack', 'C_LLM:1', '検索が遅くて5秒待たされます',
       '検索の応答が遅い', 'high', 'bug'
from t_app;

select public.attach_item_to_cluster(
  (select id from public.feedback_items where external_id = 'C_LLM:1'), null);

select pg_temp.check(
  '埋め込み無しで新規クラスタができる',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

select pg_temp.check(
  '代表ベクトルは空のまま（埋め込みを使わないので）',
  (select representative_embedding is null
     from public.feedback_clusters c join t_app a on c.app_id = a.id),
  true);

select pg_temp.check(
  '代表要約が入る',
  (select representative_summary from public.feedback_clusters c join t_app a on c.app_id = a.id),
  '検索の応答が遅い');

-- -----------------------------------------------------------------------------
-- 2. LLM が「同じ論点」と判断した先へ合流し、スコアが上がる
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category)
select id, 'slack', 'C_LLM:2', '検索結果がなかなか出てこないんだけど',
       '検索の応答が遅い', 'medium', 'bug'
from t_app;

select public.attach_item_to_cluster(
  (select id from public.feedback_items where external_id = 'C_LLM:2'),
  (select cluster_id from public.feedback_items where external_id = 'C_LLM:1'));

select pg_temp.check(
  '言い回しが違っても同じクラスタに入る',
  (select cluster_id from public.feedback_items where external_id = 'C_LLM:2'),
  (select cluster_id from public.feedback_items where external_id = 'C_LLM:1'));

select pg_temp.check(
  'クラスタ数は増えない',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

select pg_temp.check(
  '合流で件数が上がる',
  (select item_count from public.feedback_clusters c join t_app a on c.app_id = a.id),
  2);

select pg_temp.check(
  'クラスタ優先度は最高値を採用',
  (select priority::text from public.feedback_clusters c join t_app a on c.app_id = a.id),
  'high');

-- -----------------------------------------------------------------------------
-- 3. 別の論点は別クラスタになり、スコアで差がつく
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category)
select id, 'slack', 'C_LLM:3', 'CSVで出力したい', '申請履歴のCSVエクスポート', 'medium', 'feature_request'
from t_app;

select public.attach_item_to_cluster(
  (select id from public.feedback_items where external_id = 'C_LLM:3'), null);

select pg_temp.check(
  '別論点は別クラスタ',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  2);

-- 2件 high = 100 * 2/2 * 1.2 = 120 / 1件 medium = 100 * 1/2 * 1.0 = 50
select pg_temp.check(
  '合流したクラスタのスコアが高い',
  (select score from public.feedback_clusters
    where id = (select cluster_id from public.feedback_items where external_id = 'C_LLM:1')),
  120.0000::numeric);

select pg_temp.check(
  '1件クラスタのスコアは低い',
  (select score from public.feedback_clusters
    where id = (select cluster_id from public.feedback_items where external_id = 'C_LLM:3')),
  50.0000::numeric);

-- -----------------------------------------------------------------------------
-- 4. 他アプリのクラスタを指定されても紐付けない（LLM 出力を鵜呑みにしない）
-- -----------------------------------------------------------------------------
insert into public.apps (name, slug) values ('別アプリ', 'test-app-llm-other')
on conflict (slug) do nothing;

insert into public.feedback_clusters (app_id, representative_summary, item_count, score)
select id, '別アプリの論点', 1, 0 from public.apps where slug = 'test-app-llm-other';

insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category)
select id, 'slack', 'C_LLM:4', 'ログインできません', 'ログインできない', 'urgent', 'bug'
from t_app;

select public.attach_item_to_cluster(
  (select id from public.feedback_items where external_id = 'C_LLM:4'),
  (select c.id from public.feedback_clusters c
     join public.apps a on a.id = c.app_id where a.slug = 'test-app-llm-other'));

select pg_temp.check(
  '他アプリのクラスタには入れず、新規クラスタを作る',
  (select c.app_id from public.feedback_clusters c
     where c.id = (select cluster_id from public.feedback_items where external_id = 'C_LLM:4')),
  (select id from t_app));

-- -----------------------------------------------------------------------------
-- 5. 候補の絞り込み
-- -----------------------------------------------------------------------------
select pg_temp.check(
  '候補に既存クラスタが並ぶ',
  (select count(*)::int from public.candidate_clusters(
     (select id from t_app), '検索が遅い', 40)),
  3);

-- 文字列が近いものが上位に来る
select pg_temp.check(
  '文字列が近い論点が候補の先頭に来る',
  (select summary from public.candidate_clusters(
     (select id from t_app), '検索の応答が遅い', 40) limit 1),
  '検索の応答が遅い');

-- 語が重ならなくても、件数の多いクラスタは候補に残る
select pg_temp.check(
  '語が重ならなくても主要クラスタは候補に残る',
  (select bool_or(summary = '検索の応答が遅い')
     from public.candidate_clusters((select id from t_app), 'まったく無関係な文字列', 40)),
  true);

select pg_temp.check(
  '候補は上限件数を超えない',
  (select count(*)::int <= 2 from public.candidate_clusters(
     (select id from t_app), '検索', 2)),
  true);

rollback;
