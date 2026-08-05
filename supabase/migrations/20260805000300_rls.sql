-- =============================================================================
-- RLS ポリシー
--
-- 方針
--   * 読み取りは社内認証ユーザー（authenticated ロール）のみ。
--   * anon には feedback_items の INSERT だけを許可する。SELECT/UPDATE/DELETE は一切無し。
--     → 「他人のデータを読めない」ではなく「自分が入れたデータすら読み返せない」形にする。
--   * 実運用のフォーム送信は Edge Function (submit-feedback) 経由を推奨する。
--     こちらは service_role で動き、レートリミットと app_slug 解決を通す。
--     anon INSERT ポリシーは要件で明示されているためフォールバックとして用意するが、
--     使うには app_id を知っている必要がある（anon は apps を読めない）。
--   * rate_limit_hits と app_settings の書き込みは service_role のみ。
-- =============================================================================

alter table public.apps              enable row level security;
alter table public.feedback_sources  enable row level security;
alter table public.feedback_items    enable row level security;
alter table public.feedback_clusters enable row level security;
alter table public.app_settings      enable row level security;
alter table public.rate_limit_hits   enable row level security;

-- Supabase はデフォルトで anon / authenticated に広い GRANT を与えるため、一度落としてから配り直す
revoke all on public.apps, public.feedback_sources, public.feedback_items,
              public.feedback_clusters, public.app_settings, public.rate_limit_hits
  from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 社内認証ユーザー（読み取り + トリアージ操作）
-- -----------------------------------------------------------------------------
grant select on public.apps, public.feedback_sources, public.feedback_items,
                public.feedback_clusters, public.app_settings
  to authenticated;

grant update (status) on public.feedback_items    to authenticated;
grant update (status) on public.feedback_clusters to authenticated;

create policy "authenticated_read_apps"
  on public.apps for select to authenticated using (true);

create policy "authenticated_read_sources"
  on public.feedback_sources for select to authenticated using (true);

create policy "authenticated_read_items"
  on public.feedback_items for select to authenticated using (true);

create policy "authenticated_read_clusters"
  on public.feedback_clusters for select to authenticated using (true);

create policy "authenticated_read_settings"
  on public.app_settings for select to authenticated using (true);

-- ステータス変更のみ（列レベル GRANT で status 以外は書けない）
create policy "authenticated_update_item_status"
  on public.feedback_items for update to authenticated
  using (true) with check (true);

create policy "authenticated_update_cluster_status"
  on public.feedback_clusters for update to authenticated
  using (true) with check (true);

-- -----------------------------------------------------------------------------
-- anon（フォーム投稿のフォールバック経路）: INSERT のみ
-- -----------------------------------------------------------------------------
grant insert (app_id, source_type, raw_text, source_meta) on public.feedback_items to anon;

create policy "anon_insert_form_feedback_only"
  on public.feedback_items for insert to anon
  with check (
    source_type = 'form'
    -- AI が埋める列を anon が詐称できないようにする
    and summary    is null
    and priority   is null
    and category   is null
    and embedding  is null
    and cluster_id is null
    and external_id is null
    -- 本文の長さを制限（巨大ペイロードによる DoS 抑止）
    and length(btrim(raw_text)) between 1 and 5000
  );

-- -----------------------------------------------------------------------------
-- 関数の実行権限
-- -----------------------------------------------------------------------------
revoke execute on function public.assign_item_to_cluster(uuid, double precision) from public, anon, authenticated;
revoke execute on function public.recalculate_app_scores(uuid)                   from public, anon, authenticated;
revoke execute on function public.refresh_cluster_aggregates(uuid)               from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, int, int)               from public, anon, authenticated;
revoke execute on function public.find_similar_cluster(uuid, vector)             from public, anon;

grant execute on function public.set_cluster_status(uuid, text) to authenticated;
grant execute on function public.priority_rank(text)            to authenticated;
