-- =============================================================================
-- クラスタリング / スコアリングの動作確認用スクリプト
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/clustering_test.sql
--
-- migration 適用済みの DB に対して実行し、最後に全チェックが PASS することを確認する。
-- 埋め込みは外部 API を呼ばず、先頭 2 次元だけを使ったテスト用ベクトルで代用する。
-- 実行後は作成したテスト用アプリごと片付ける。
-- =============================================================================

begin;

-- 先頭 2 次元だけ値を持つ 1536 次元ベクトルを作る（テスト専用ヘルパ）
create or replace function pg_temp.test_vec(x double precision, y double precision)
returns vector(1536)
language sql
immutable
as $$
  select ('[' || x || ',' || y || ',' || repeat('0,', 1533) || '0]')::vector(1536);
$$;

create or replace function pg_temp.check(label text, actual anyelement, expected anyelement)
returns void
language plpgsql
as $$
begin
  if actual is not distinct from expected then
    raise notice 'PASS  %  (= %)', label, actual;
  else
    raise exception 'FAIL  %  expected=% actual=%', label, expected, actual;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- テスト用アプリ
-- -----------------------------------------------------------------------------
insert into public.apps (name, slug) values ('テストアプリ', 'test-app-clustering')
on conflict (slug) do nothing;

create temp view t_app as select id from public.apps where slug = 'test-app-clustering';

-- -----------------------------------------------------------------------------
-- 1. 1 件目 → 新規クラスタが作られる
-- -----------------------------------------------------------------------------
with app as (select id from t_app)
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, embedding)
select app.id, 'slack', 'C_TEST:1001.0001', 'ログイン後に画面が白いままです',
       'ログイン後に画面が白い', 'urgent', 'bug', pg_temp.test_vec(1, 0)
from app;

select public.assign_item_to_cluster(id) from public.feedback_items
where external_id = 'C_TEST:1001.0001';

select pg_temp.check(
  '1件目で新規クラスタが1つできる',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

select pg_temp.check(
  '1件目のクラスタ item_count',
  (select item_count from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

-- -----------------------------------------------------------------------------
-- 2. 類似 (cos ≈ 0.99) の 2 件目 → 既存クラスタに吸収される
-- -----------------------------------------------------------------------------
with app as (select id from t_app)
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, embedding)
select app.id, 'form', 'form:test-0002', 'ログインしても真っ白で何も出ません',
       'ログイン後に真っ白', 'medium', 'bug', pg_temp.test_vec(0.99, 0.141)
from app;

select public.assign_item_to_cluster(id) from public.feedback_items
where external_id = 'form:test-0002';

select pg_temp.check(
  '類似itemを吸収してもクラスタ数は1のまま',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

select pg_temp.check(
  '吸収後の item_count',
  (select item_count from public.feedback_clusters c join t_app a on c.app_id = a.id),
  2);

-- 優先度はクラスタ内の最高値（urgent > medium）になる
select pg_temp.check(
  'クラスタ優先度は最高値を採用',
  (select priority::text from public.feedback_clusters c join t_app a on c.app_id = a.id),
  'urgent');

-- representative_summary は最初の要約を維持する
select pg_temp.check(
  '代表要約は初回の値を維持',
  (select representative_summary from public.feedback_clusters c join t_app a on c.app_id = a.id),
  'ログイン後に画面が白い');

-- -----------------------------------------------------------------------------
-- 3. 非類似 (cos = 0) の 3 件目 → 新規クラスタ
-- -----------------------------------------------------------------------------
with app as (select id from t_app)
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, embedding)
select app.id, 'slack', 'C_TEST:1003.0003', 'CSV でエクスポートしたい',
       'CSV エクスポート要望', 'medium', 'feature_request', pg_temp.test_vec(0, 1)
from app;

select public.assign_item_to_cluster(id) from public.feedback_items
where external_id = 'C_TEST:1003.0003';

select pg_temp.check(
  '非類似itemで新規クラスタが増える',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  2);

-- -----------------------------------------------------------------------------
-- 4. 採用スコア
--    最大クラスタ(2件)=100 として比例スケール × priority_weight
--      cluster A: 100 * 2/2 * 1.5 (urgent) = 150
--      cluster B: 100 * 1/2 * 1.0 (medium) = 50
-- -----------------------------------------------------------------------------
select pg_temp.check(
  'urgent 2件クラスタのスコア',
  (select score from public.feedback_clusters c join t_app a on c.app_id = a.id
    where c.category = 'bug'),
  150.0000::numeric);

select pg_temp.check(
  'medium 1件クラスタのスコア',
  (select score from public.feedback_clusters c join t_app a on c.app_id = a.id
    where c.category = 'feature_request'),
  50.0000::numeric);

-- スコア降順が「支持の多い順」になっている
select pg_temp.check(
  'スコア降順の先頭は件数の多いクラスタ',
  (select c.category::text from public.feedback_clusters c join t_app a on c.app_id = a.id
    order by c.score desc limit 1),
  'bug');

-- -----------------------------------------------------------------------------
-- 5. 重心更新: representative_embedding が所属 item の平均になっている
-- -----------------------------------------------------------------------------
select pg_temp.check(
  '代表ベクトルは所属itemの重心',
  (select round((c.representative_embedding <-> pg_temp.test_vec(0.995, 0.0705))::numeric, 6)
     from public.feedback_clusters c join t_app a on c.app_id = a.id
    where c.category = 'bug'),
  0.000000::numeric);

-- -----------------------------------------------------------------------------
-- 6. 重複排除: 同じ external_id は 2 度入らない
-- -----------------------------------------------------------------------------
do $$
declare
  v_app uuid;
begin
  select id into v_app from public.apps where slug = 'test-app-clustering';
  begin
    insert into public.feedback_items (app_id, source_type, external_id, raw_text)
    values (v_app, 'slack', 'C_TEST:1001.0001', '重複投稿');
    raise exception 'FAIL  重複 external_id が insert できてしまった';
  exception when unique_violation then
    raise notice 'PASS  重複 external_id は unique 制約で弾かれる';
  end;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. クラスタ単位のステータス更新が配下 item に伝播する
-- -----------------------------------------------------------------------------
select public.set_cluster_status(c.id, 'adopted')
from public.feedback_clusters c join t_app a on c.app_id = a.id
where c.category = 'bug';

select pg_temp.check(
  'ステータスが配下itemに伝播する',
  (select count(*)::int from public.feedback_items i
     join t_app a on i.app_id = a.id
    where i.status = 'adopted'),
  2);

-- -----------------------------------------------------------------------------
-- 8. 優先度重みを変えて再計算すると score が追随する
-- -----------------------------------------------------------------------------
update public.app_settings
set value = '{"urgent": 2.0, "high": 1.2, "medium": 1.0, "low": 0.7}'::jsonb
where key = 'scoring.priority_weights';

select public.recalculate_app_scores(id) from t_app;

select pg_temp.check(
  '重み変更後にスコアが再計算される',
  (select score from public.feedback_clusters c join t_app a on c.app_id = a.id
    where c.category = 'bug'),
  200.0000::numeric);

-- -----------------------------------------------------------------------------
-- 9. レートリミット: 上限を超えたら false
-- -----------------------------------------------------------------------------
select pg_temp.check('レートリミット 1回目', public.check_rate_limit('test:ip', 60, 2), true);
select pg_temp.check('レートリミット 2回目', public.check_rate_limit('test:ip', 60, 2), true);
select pg_temp.check('レートリミット 3回目は拒否', public.check_rate_limit('test:ip', 60, 2), false);

-- -----------------------------------------------------------------------------
-- 10. item を消したらクラスタの集計が追随し、空クラスタは掃除される
-- -----------------------------------------------------------------------------
delete from public.feedback_items i
using t_app a
where i.app_id = a.id and i.category = 'feature_request';

select public.refresh_cluster_aggregates(c.id)
from public.feedback_clusters c join t_app a on c.app_id = a.id
where c.category = 'feature_request';

select pg_temp.check(
  '空になったクラスタは削除される',
  (select count(*)::int from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

rollback;  -- テストデータを残さない
