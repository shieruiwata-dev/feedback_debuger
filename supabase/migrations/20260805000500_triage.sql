-- =============================================================================
-- フィードバック選別（トリアージ）
--
-- Slack のチャンネルにはフィードバック以外の情報（雑談・障害通知・自動投稿）も
-- 流れてくるため、「フィードバックと取れるものだけ」を一覧に上げる仕組みを足す。
--
--   * status に 'ignored' を追加。ノイズ判定された item はここに落ち、
--     ダッシュボードの本編には出さないが DB には残す（誤判定を戻せるようにするため）
--   * is_feedback / triage_reason / triage_confidence で判定の根拠を残す
--   * restore_feedback_item() で人手による復帰を 1 クリックにする
-- =============================================================================

-- -----------------------------------------------------------------------------
-- status に 'ignored' を追加
-- -----------------------------------------------------------------------------
alter domain public.status_t drop constraint status_t_check;
alter domain public.status_t add constraint status_t_check
  check (value in ('new', 'reviewing', 'adopted', 'done', 'rejected', 'ignored'));

comment on domain public.status_t is
  'ignored = フィードバックではないと判定されたもの。一覧からは外すが削除はしない';

-- -----------------------------------------------------------------------------
-- 判定結果の記録
-- -----------------------------------------------------------------------------
alter table public.feedback_items
  add column is_feedback        boolean,
  add column triage_reason      text,
  add column triage_confidence  numeric(3, 2);

comment on column public.feedback_items.is_feedback is
  'null = 未判定 / true = フィードバック / false = ノイズ。'
  '明示マーク（#fb や 📮 リアクション）が付いたものは AI 判定を通さず true 固定';
comment on column public.feedback_items.triage_reason is
  '判定理由。heuristic:too_short / ai:雑談のため / marker:#fb / reaction:inbox_tray など';
comment on column public.feedback_items.triage_confidence is
  'AI 判定の確信度 0.00〜1.00。閾値未満のノイズ判定は採用しない（取りこぼし防止）';

-- ノイズを除いた一覧の引きが主経路になるので、その形に索引を張る
create index feedback_items_app_visible_idx
  on public.feedback_items (app_id, created_at desc)
  where status <> 'ignored';

-- ノイズ欄（復帰候補）の引き
create index feedback_items_ignored_idx
  on public.feedback_items (app_id, created_at desc)
  where status = 'ignored';

-- -----------------------------------------------------------------------------
-- チューニング用の設定値
-- -----------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  -- AI がノイズと判定しても、この確信度未満なら残す（フェイルオープン）
  ('triage.min_confidence', '0.7'::jsonb),
  -- AI トリアージを掛けるソース種別。フォームは定義上フィードバックなので既定では掛けない
  ('triage.ai_source_types', '["slack"]'::jsonb)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 人手による復帰
--   ノイズ判定を取り消し、再処理キューに戻す。
--   authenticated には status 列しか UPDATE 権限が無いので、
--   security definer の関数で必要な列だけまとめて書き換える。
-- -----------------------------------------------------------------------------
create or replace function public.restore_feedback_item(p_item_id uuid)
returns public.feedback_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.feedback_items%rowtype;
begin
  update public.feedback_items
  set status           = 'new',
      is_feedback      = true,
      triage_reason    = 'manual_restore',
      -- 分類も埋め込みもやり直させる（ノイズ判定時に打ち切っている可能性があるため）
      processing_state = 'pending',
      processing_error = null
  where id = p_item_id
  returning * into v_row;

  if not found then
    raise exception 'feedback_item % not found', p_item_id;
  end if;

  return v_row;
end;
$$;

comment on function public.restore_feedback_item(uuid) is
  'ノイズ判定を人手で取り消す。status を new に戻し、再エンリッチメントの対象にする';

-- -----------------------------------------------------------------------------
-- ノイズ判定を「あとから」適用する
--   明示マーク済み（is_feedback = true）の item は対象外にする。
-- -----------------------------------------------------------------------------
create or replace function public.mark_item_as_noise(
  p_item_id    uuid,
  p_reason     text,
  p_confidence numeric default null
)
returns public.feedback_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      public.feedback_items%rowtype;
  v_old_cluster uuid;
  v_app_id      uuid;
begin
  select cluster_id, app_id into v_old_cluster, v_app_id
  from public.feedback_items where id = p_item_id;

  update public.feedback_items
  set status            = 'ignored',
      is_feedback       = false,
      triage_reason     = left(p_reason, 500),
      triage_confidence = p_confidence,
      -- ノイズはクラスタに載せない
      cluster_id        = null,
      processing_state  = 'done',
      processed_at      = now()
  where id = p_item_id
    -- 明示マークされたものは AI 判定で落とさない
    and coalesce(is_feedback, false) = false
  returning * into v_row;

  if not found then
    -- 既にマーク済み（= 保護対象）だった場合は現在値をそのまま返す
    select * into v_row from public.feedback_items where id = p_item_id;
    return v_row;
  end if;

  -- 再処理でクラスタから抜いた場合は、抜けた先の集計とスコアを締め直す
  if v_old_cluster is not null then
    perform public.refresh_cluster_aggregates(v_old_cluster);
    perform public.recalculate_app_scores(v_app_id);
  end if;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 権限
-- -----------------------------------------------------------------------------
revoke execute on function public.mark_item_as_noise(uuid, text, numeric)
  from public, anon, authenticated;

grant execute on function public.restore_feedback_item(uuid) to authenticated;
