-- =============================================================================
-- Notion 同期の差分検出まわりの動作確認
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/notion_sync_test.sql
--
-- ここで確かめたいのは「何を送るか」ではなく「いつ送るか」。
-- 送りすぎ（毎回全件が要同期になる）と送り漏れ（変わったのに拾われない）は
-- どちらも本番でしか気づきにくいので、SQL の側で押さえておく。
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

insert into public.apps (name, slug) values ('Notion同期テスト', 'test-app-notion')
on conflict (slug) do nothing;

create temp view t_app as select id from public.apps where slug = 'test-app-notion';

create temp view t_queue as
  select * from public.notion_sync_queue(50, (select id from t_app));

-- -----------------------------------------------------------------------------
-- 1. 新しくできたクラスタは同期対象になる
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category)
select id, 'slack', 'C_NT:1', '入れた内容がどこにも残ってない',
       '入力内容が保存されない', 'urgent', 'bug'
from t_app;

select public.attach_item_to_cluster(
  (select id from public.feedback_items where external_id = 'C_NT:1'), null);

select pg_temp.check('新規クラスタは同期対象', (select count(*)::int from t_queue), 1);

select pg_temp.check(
  '要約・優先度・件数が引ける',
  (select summary || '/' || priority || '/' || item_count from t_queue),
  '入力内容が保存されない/urgent/1');

-- -----------------------------------------------------------------------------
-- 2. 同期済みにすると対象から外れる
-- -----------------------------------------------------------------------------
select pg_temp.check(
  '同期済みの印が付く',
  (select public.mark_cluster_notion_synced(cluster_id, 'page-1', updated_at) from t_queue),
  true);

select pg_temp.check('同期済みは対象外', (select count(*)::int from t_queue), 0);

-- -----------------------------------------------------------------------------
-- 3. 件数が増えたら再び対象になる
--    refresh_cluster_aggregates が updated_at を進めることの確認
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category, cluster_id)
select a.id, 'slack', 'C_NT:2', '記録つけて画面閉じたら中身が全部消えてた',
       '記録が保存されず消える', 'urgent', 'bug',
       (select c.id from public.feedback_clusters c join t_app t on c.app_id = t.id limit 1)
from t_app a;

select public.refresh_cluster_aggregates(
  (select c.id from public.feedback_clusters c join t_app t on c.app_id = t.id limit 1));

select pg_temp.check('件数が変われば再同期対象', (select count(*)::int from t_queue), 1);
select pg_temp.check('件数が反映される', (select item_count from t_queue), 2);

-- ページ ID は保持したまま（作り直しではなく更新になる）
select pg_temp.check(
  'ページ ID は残る', (select notion_page_id from t_queue), 'page-1');

-- -----------------------------------------------------------------------------
-- 4. 中身が変わっていなければ、集計を回しても対象にならない
--
--    recalculate_app_scores は同一 app の全クラスタを update するので、
--    無条件に updated_at を進めると 1 件取り込むたびに全件が再送になる。
-- -----------------------------------------------------------------------------
select public.mark_cluster_notion_synced(
  (select cluster_id from t_queue), 'page-1', (select updated_at from t_queue));

select public.refresh_cluster_aggregates(
  (select c.id from public.feedback_clusters c join t_app t on c.app_id = t.id limit 1));
select public.recalculate_app_scores((select id from t_app));

select pg_temp.check(
  '変化が無ければ再同期しない', (select count(*)::int from t_queue), 0);

-- -----------------------------------------------------------------------------
-- 5. スコアが動いたときは対象になる
-- -----------------------------------------------------------------------------
update public.app_settings
set value = '{"urgent":9.0,"high":1.2,"medium":1.0,"low":0.7}'::jsonb
where key = 'scoring.priority_weights';

select public.recalculate_app_scores((select id from t_app));

select pg_temp.check('スコアが変われば再同期対象', (select count(*)::int from t_queue), 1);

update public.app_settings
set value = '{"urgent":1.5,"high":1.2,"medium":1.0,"low":0.7}'::jsonb
where key = 'scoring.priority_weights';

-- -----------------------------------------------------------------------------
-- 6. 本文へ未追記の item だけが引ける
-- -----------------------------------------------------------------------------
select pg_temp.check(
  '未追記の item は 2 件',
  (select count(*)::int from public.notion_pending_items(
     (select cluster_id from t_queue), 20)),
  2);

select public.mark_item_notion_block(
  (select id from public.feedback_items where external_id = 'C_NT:1'), 'block-1');

select pg_temp.check(
  '追記済みは引かれない',
  (select count(*)::int from public.notion_pending_items(
     (select cluster_id from t_queue), 20)),
  1);

select pg_temp.check(
  '残るのは未追記のほう',
  (select summary from public.notion_pending_items(
     (select cluster_id from t_queue), 20)),
  '記録が保存されず消える');

-- -----------------------------------------------------------------------------
-- 7. 下限件数の設定で絞れる
-- -----------------------------------------------------------------------------
insert into public.feedback_items
  (app_id, source_type, external_id, raw_text, summary, priority, category)
select id, 'slack', 'C_NT:3', 'ボタンの文字が小さい', '文字が小さい', 'low', 'ux'
from t_app;

select public.attach_item_to_cluster(
  (select id from public.feedback_items where external_id = 'C_NT:3'), null);

select pg_temp.check('1 件のクラスタも既定では対象', (select count(*)::int from t_queue), 2);

update public.app_settings set value = '2'::jsonb where key = 'notion.min_item_count';

select pg_temp.check(
  '下限 2 なら 1 件のクラスタは出ない', (select count(*)::int from t_queue), 1);

update public.app_settings set value = '1'::jsonb where key = 'notion.min_item_count';

-- -----------------------------------------------------------------------------
-- 8. クラスタが消えたら、ページのアーカイブ待ちに積まれる
-- -----------------------------------------------------------------------------
select public.mark_cluster_notion_synced(
  (select c.id from public.feedback_clusters c join t_app t on c.app_id = t.id
    where c.item_count = 1 limit 1),
  'page-orphan', null);

-- item を外して空にすると refresh_cluster_aggregates がクラスタを削除する
update public.feedback_items set cluster_id = null where external_id = 'C_NT:3';
select public.refresh_cluster_aggregates(
  (select c.id from public.feedback_clusters c join t_app t on c.app_id = t.id
    where c.notion_page_id = 'page-orphan' limit 1));

select pg_temp.check(
  '削除されたクラスタのページが控えられる',
  (select count(*)::int from public.notion_orphan_pages
    where page_id = 'page-orphan' and archived_at is null),
  1);

select public.mark_notion_orphan_archived('page-orphan');

select pg_temp.check(
  'アーカイブ済みは再処理されない',
  (select count(*)::int from public.notion_orphan_pages
    where page_id = 'page-orphan' and archived_at is null),
  0);

-- -----------------------------------------------------------------------------
-- 9. Notion 側でページが消された場合の作り直し
-- -----------------------------------------------------------------------------
select public.clear_cluster_notion_page((select cluster_id from t_queue));

select pg_temp.check(
  'ページ ID を消すと未同期に戻る', (select notion_page_id from t_queue), null::text);

select pg_temp.check(
  'ブロックの目印も消えて全件追記し直しになる',
  (select count(*)::int from public.notion_pending_items(
     (select cluster_id from t_queue), 20)),
  2);

-- -----------------------------------------------------------------------------
-- 10. 権限: 画面（anon / authenticated）からは触れない
-- -----------------------------------------------------------------------------
select pg_temp.check(
  'notion_sync_queue は authenticated から実行できない',
  has_function_privilege('authenticated', 'public.notion_sync_queue(int, uuid)', 'execute'),
  false);

select pg_temp.check(
  'mark_cluster_notion_synced は anon から実行できない',
  has_function_privilege('anon', 'public.mark_cluster_notion_synced(uuid, text, timestamptz)', 'execute'),
  false);

select pg_temp.check(
  'notion_orphan_pages は authenticated から読めない',
  has_table_privilege('authenticated', 'public.notion_orphan_pages', 'select'),
  false);

rollback;
