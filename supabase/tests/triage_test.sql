-- =============================================================================
-- フィードバック選別（トリアージ）の動作確認
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/triage_test.sql
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

insert into public.apps (name, slug) values ('トリアージテスト', 'test-app-triage')
on conflict (slug) do nothing;

create temp view t_app as select id from public.apps where slug = 'test-app-triage';

-- -----------------------------------------------------------------------------
-- 1. status に 'ignored' を入れられる
-- -----------------------------------------------------------------------------
insert into public.feedback_items (app_id, source_type, external_id, raw_text, embedding)
select id, 'slack', 'C_TRI:2001', '明日の定例は15時からでお願いします',
       pg_temp.test_vec(1, 0)
from t_app;

select public.mark_item_as_noise(
  (select id from public.feedback_items where external_id = 'C_TRI:2001'),
  'ai:社内の予定調整の連絡',
  0.95);

select pg_temp.check(
  'ノイズ判定で status=ignored になる',
  (select status::text from public.feedback_items where external_id = 'C_TRI:2001'),
  'ignored');

select pg_temp.check(
  'ノイズ判定で is_feedback=false が記録される',
  (select is_feedback from public.feedback_items where external_id = 'C_TRI:2001'),
  false);

select pg_temp.check(
  '判定理由が残る',
  (select triage_reason from public.feedback_items where external_id = 'C_TRI:2001'),
  'ai:社内の予定調整の連絡');

select pg_temp.check(
  '確信度が残る',
  (select triage_confidence from public.feedback_items where external_id = 'C_TRI:2001'),
  0.95::numeric);

-- -----------------------------------------------------------------------------
-- 2. 明示マーク済み（is_feedback = true）は AI 判定で落とせない
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, is_feedback, triage_reason)
select id, 'slack', 'C_TRI:2002', '重いです', true, 'marker:#fb'
from t_app;

select public.mark_item_as_noise(
  (select id from public.feedback_items where external_id = 'C_TRI:2002'),
  'ai:短すぎて判断不能',
  0.99);

select pg_temp.check(
  '明示マーク済みはノイズ判定から保護される',
  (select status::text from public.feedback_items where external_id = 'C_TRI:2002'),
  'new');

select pg_temp.check(
  '明示マークの理由も上書きされない',
  (select triage_reason from public.feedback_items where external_id = 'C_TRI:2002'),
  'marker:#fb');

-- -----------------------------------------------------------------------------
-- 3. 人手による復帰
-- -----------------------------------------------------------------------------
select public.restore_feedback_item(
  (select id from public.feedback_items where external_id = 'C_TRI:2001'));

select pg_temp.check(
  '復帰で status=new に戻る',
  (select status::text from public.feedback_items where external_id = 'C_TRI:2001'),
  'new');

select pg_temp.check(
  '復帰で is_feedback=true になる（再判定で落とされない）',
  (select is_feedback from public.feedback_items where external_id = 'C_TRI:2001'),
  true);

select pg_temp.check(
  '復帰で再処理キューに戻る',
  (select processing_state from public.feedback_items where external_id = 'C_TRI:2001'),
  'pending');

-- -----------------------------------------------------------------------------
-- 4. クラスタに載ったあとでノイズ判定された場合、集計とスコアが締め直される
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, embedding)
select id, 'slack', 'C_TRI:2003', 'ログインできません', 'ログイン不可', 'urgent', 'bug',
       pg_temp.test_vec(0, 1)
from t_app;

insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, embedding)
select id, 'slack', 'C_TRI:2004', 'ログインが通らない', 'ログイン不可', 'high', 'bug',
       pg_temp.test_vec(0.01, 0.9999)
from t_app;

select public.assign_item_to_cluster(id) from public.feedback_items
where external_id in ('C_TRI:2003', 'C_TRI:2004');

select pg_temp.check(
  'クラスタに 2 件入っている',
  (select item_count from public.feedback_clusters c join t_app a on c.app_id = a.id),
  2);

-- 1 件をノイズ判定で外す
select public.mark_item_as_noise(
  (select id from public.feedback_items where external_id = 'C_TRI:2004'),
  'ai:誤って取り込まれた',
  0.9);

select pg_temp.check(
  'ノイズにした item はクラスタから外れる',
  (select cluster_id from public.feedback_items where external_id = 'C_TRI:2004'),
  null::uuid);

select pg_temp.check(
  'クラスタの件数が締め直される',
  (select item_count from public.feedback_clusters c join t_app a on c.app_id = a.id),
  1);

select pg_temp.check(
  '残った item の優先度がクラスタ代表値になる',
  (select priority::text from public.feedback_clusters c join t_app a on c.app_id = a.id),
  'urgent');

-- -----------------------------------------------------------------------------
-- 5. 設定値が入っている
-- -----------------------------------------------------------------------------
select pg_temp.check(
  'ノイズ判定の確信度閾値が設定されている',
  (select (value #>> '{}')::numeric from public.app_settings where key = 'triage.min_confidence'),
  0.7::numeric);

rollback;
