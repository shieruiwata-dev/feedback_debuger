import type { SupabaseClient } from "@supabase/supabase-js";
import type { IngestResult, NormalizedFeedback, TriageHint } from "./types.ts";
import { aiEnrichmentEnabled, envBool } from "./env.ts";
import { runBackground } from "./http.ts";
import { enrichItem } from "./enrich.ts";
import { looksLikeNoise } from "./triage.ts";

/**
 * 正規化済みフィードバックを 1 件取り込む。全アダプタ共通の入口。
 *
 * - 明示マーク（#fb / 📮 リアクション）が付いていれば選別を全部飛ばして取り込む
 * - 定型ノイズ（相槌・URL だけ・自動通知の定型文）は insert せずに捨てる
 * - external_id による重複排除（Slack のリトライ対策）
 * - ENABLE_AI_ENRICHMENT が false の間は「受信→正規化→そのまま insert」だけで止まる
 * - true なら分類 / トリアージ / 埋め込み / クラスタリングをバックグラウンドで走らせる。
 *   Slack Events API は 3 秒以内の 200 応答を要求するため、同期では実行しない。
 */
export async function ingestFeedback(
  db: SupabaseClient,
  payload: NormalizedFeedback,
  hint: TriageHint = {},
): Promise<IngestResult> {
  const text = payload.raw_text.trim();
  if (text.length === 0) {
    return { status: "ignored", reason: "empty_text" };
  }

  // --- 層 0: insert 前の選別 ------------------------------------------------
  // 明示マークがあれば無条件で通す
  if (!hint.forced && preInsertFilterEnabled(payload.source_type)) {
    const verdict = looksLikeNoise(text);
    if (verdict.noise) {
      console.info(`dropped before insert (${verdict.reason}): ${text.slice(0, 60)}`);
      return { status: "ignored", reason: `heuristic:${verdict.reason}` };
    }
  }

  const { data, error } = await db
    .from("feedback_items")
    .insert({
      app_id: payload.app_id,
      source_type: payload.source_type,
      raw_text: text,
      source_meta: payload.source_meta,
      external_id: payload.external_id,
      processing_state: aiEnrichmentEnabled() ? "pending" : "skipped",
      // 明示マーク済みは AI トリアージの対象外にする（enrich.ts がこの値を見る）
      is_feedback: hint.forced ? true : null,
      triage_reason: hint.reason ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation → external_id が既に取り込み済み
    if (error.code === "23505") {
      // 明示マークが後から付いた場合は、既存行を復帰させる（📮 の付け直し経路）
      if (hint.forced && payload.external_id) {
        return await restoreExisting(db, payload, hint);
      }
      return { status: "duplicate", reason: "external_id_exists" };
    }
    throw error;
  }

  const itemId = data.id as string;

  if (aiEnrichmentEnabled()) {
    runBackground(enrichItem(db, itemId));
  }

  return { status: "inserted", item_id: itemId };
}

/**
 * 既に取り込み済みの item に明示マークが付いたときの処理。
 * ノイズ判定で外していたものを一覧に戻し、再エンリッチメントの対象にする。
 */
async function restoreExisting(
  db: SupabaseClient,
  payload: NormalizedFeedback,
  hint: TriageHint,
): Promise<IngestResult> {
  const { data: existing, error } = await db
    .from("feedback_items")
    .select("id, status")
    .eq("source_type", payload.source_type)
    .eq("external_id", payload.external_id!)
    .maybeSingle();

  if (error || !existing) {
    return { status: "duplicate", reason: "external_id_exists" };
  }

  const itemId = existing.id as string;

  // ノイズ判定されていなければ触らない（トリアージ済みの正常な重複）
  if (existing.status !== "ignored") {
    return { status: "duplicate", item_id: itemId, reason: "already_visible" };
  }

  const { error: restoreError } = await db
    .rpc("restore_feedback_item", { p_item_id: itemId });

  if (restoreError) throw restoreError;

  await db.from("feedback_items")
    .update({ triage_reason: hint.reason ?? "manual_restore" })
    .eq("id", itemId);

  if (aiEnrichmentEnabled()) {
    runBackground(enrichItem(db, itemId));
  }

  return { status: "restored", item_id: itemId };
}

/**
 * insert 前フィルタを掛けるソース種別。
 * フォームは「意見を書くための入力欄」なので、短い投稿でも捨てない。
 */
function preInsertFilterEnabled(sourceType: string): boolean {
  if (!envBool("ENABLE_PREINSERT_NOISE_FILTER", true)) return false;
  return sourceType === "slack";
}
