-- =============================================================================
-- 初期データ
--   最初の登録アプリ: マイサポ (slug: mysupport)
--   Slack フィードバック投稿チャンネル: C0BKRLGJQ3Z
--
-- 冪等にしてあるので、本番でも re-run して問題ない。
-- =============================================================================

insert into public.apps (name, slug)
values ('マイサポ', 'mysupport')
on conflict (slug) do nothing;

insert into public.feedback_sources (app_id, source_type, source_identifier)
select a.id, 'slack', 'C0BKRLGJQ3Z'
from public.apps a
where a.slug = 'mysupport'
on conflict do nothing;

-- フォーム経路は app_slug で解決するため source_identifier は表示用のラベル
insert into public.feedback_sources (app_id, source_type, source_identifier)
select a.id, 'form', 'mysupport-web-widget'
from public.apps a
where a.slug = 'mysupport'
on conflict do nothing;
