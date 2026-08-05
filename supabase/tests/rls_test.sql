-- =============================================================================
-- RLS ポリシーの動作確認
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
--
-- anon / authenticated それぞれに切り替えて、許可・禁止が意図通りかを確認する。
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

-- 検査対象のデータを service_role 相当（テーブル所有者）で用意する
insert into public.apps (name, slug) values ('RLSテスト', 'test-app-rls')
on conflict (slug) do nothing;

insert into public.feedback_items (app_id, source_type, raw_text)
select id, 'slack', 'RLS テスト用の既存フィードバック' from public.apps where slug = 'test-app-rls';

-- -----------------------------------------------------------------------------
-- anon: INSERT だけできる
-- -----------------------------------------------------------------------------
set local role anon;

do $$
declare v_app uuid;
begin
  select id into v_app from public.apps where slug = 'test-app-rls';
  raise exception 'FAIL  anon が apps を読めてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  anon は apps を読めない';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  anon は apps を読めない (%)', sqlerrm;
end;
$$;

do $$
begin
  perform 1 from public.feedback_items limit 1;
  raise exception 'FAIL  anon が feedback_items を読めてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  anon は feedback_items を読めない';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  anon は feedback_items を読めない (%)', sqlerrm;
end;
$$;

reset role;
-- anon は apps を読めないので、テスト側で app_id を先に控えておく
create temp table t_ids as select id as app_id from public.apps where slug = 'test-app-rls';
grant select on t_ids to anon, authenticated;
set local role anon;

-- form の insert は通る
insert into public.feedback_items (app_id, source_type, raw_text, source_meta)
select app_id, 'form', 'anon から投稿したフィードバック', '{"page_url":"https://example.com"}'::jsonb
from t_ids;

-- slack を騙った insert はポリシーで弾かれる
do $$
begin
  insert into public.feedback_items (app_id, source_type, raw_text)
  select app_id, 'slack', 'anon が slack を騙った投稿' from t_ids;
  raise exception 'FAIL  anon が source_type=slack で insert できてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  anon の source_type=slack は拒否される';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  anon の source_type=slack は拒否される (%)', sqlerrm;
end;
$$;

-- UPDATE / DELETE は権限そのものが無い
do $$
begin
  update public.feedback_items set status = 'done';
  raise exception 'FAIL  anon が update できてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  anon は update できない';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  anon は update できない (%)', sqlerrm;
end;
$$;

do $$
begin
  delete from public.feedback_items;
  raise exception 'FAIL  anon が delete できてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  anon は delete できない';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  anon は delete できない (%)', sqlerrm;
end;
$$;

reset role;

-- -----------------------------------------------------------------------------
-- authenticated: 読める / status だけ更新できる / insert はできない
-- -----------------------------------------------------------------------------
set local role authenticated;

select pg_temp.check(
  'authenticated は feedback_items を読める',
  (select count(*)::int > 0 from public.feedback_items),
  true);

select pg_temp.check(
  'authenticated は apps を読める',
  (select count(*)::int > 0 from public.apps),
  true);

-- status の更新は通る
update public.feedback_items set status = 'reviewing'
where raw_text = 'RLS テスト用の既存フィードバック';

select pg_temp.check(
  'authenticated は status を更新できる',
  (select status::text from public.feedback_items where raw_text = 'RLS テスト用の既存フィードバック'),
  'reviewing');

-- status 以外の列は列レベル GRANT が無いので更新できない
do $$
begin
  update public.feedback_items set raw_text = '改ざん';
  raise exception 'FAIL  authenticated が raw_text を更新できてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  authenticated は status 以外を更新できない';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  authenticated は status 以外を更新できない (%)', sqlerrm;
end;
$$;

do $$
declare v_app uuid;
begin
  select id into v_app from public.apps where slug = 'test-app-rls';
  insert into public.feedback_items (app_id, source_type, raw_text)
  values (v_app, 'form', 'authenticated からの直接投稿');
  raise exception 'FAIL  authenticated が insert できてしまった';
exception
  when insufficient_privilege then raise notice 'PASS  authenticated は insert できない';
  when others then
    if sqlerrm like '%FAIL%' then raise; end if;
    raise notice 'PASS  authenticated は insert できない (%)', sqlerrm;
end;
$$;

reset role;

rollback;
