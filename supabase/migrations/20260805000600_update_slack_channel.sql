-- =============================================================================
-- マイサポの Slack 取り込みチャンネルを差し替える
--   C0BKRLGJQ3Z → C0BNDE7H21G
--
-- 20260805000400_seed.sql を直接書き換えず、差分の migration にしてある。
-- seed を書き換えると、既に古い ID を入れた DB では
-- 「古い行が残ったまま新しい行が増える」形になり、逆引きが二重になるため。
-- この形なら新規 DB でも既存 DB でも同じ結果になる。
-- =============================================================================

update public.feedback_sources
set source_identifier = 'C0BNDE7H21G'
where source_type = 'slack'
  and source_identifier = 'C0BKRLGJQ3Z';

-- 何らかの理由で slack のソース設定が無い場合に備えて補う（冪等）
insert into public.feedback_sources (app_id, source_type, source_identifier)
select a.id, 'slack', 'C0BNDE7H21G'
from public.apps a
where a.slug = 'mysupport'
  and not exists (
    select 1 from public.feedback_sources s
    where s.app_id = a.id and s.source_type = 'slack'
  );
