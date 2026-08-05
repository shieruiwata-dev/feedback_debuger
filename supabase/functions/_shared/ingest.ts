import type { SupabaseClient } from "@supabase/supabase-js";
import type { IngestResult, NormalizedFeedback } from "./types.ts";
import { aiEnrichmentEnabled } from "./env.ts";
import { runBackground } from "./http.ts";
import { enrichItem } from "./enrich.ts";

/**
 * 正規化済みフィードバックを 1 件取り込む。全アダプタ共通の入口。
 *
 * - external_id による重複排除（Slack のリトライ・メールの再送対策）
 * - ENABLE_AI_ENRICHMENT が false の間は「受信→正規化→そのまま insert」だけで止まる
 *   （実装順序 step 2〜4 の最小構成）
 * - true なら分類 / 埋め込み / クラスタリングをバックグラウンドで走らせる。
 *   Slack Events API は 3 秒以内の 200 応答を要求するため、同期では実行しない。
 */
export async function ingestFeedback(
  db: SupabaseClient,
  payload: NormalizedFeedback,
): Promise<IngestResult> {
  const text = payload.raw_text.trim();
  if (text.length === 0) {
    return { status: "ignored", reason: "empty_text" };
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
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation → external_id が既に取り込み済み
    if (error.code === "23505") {
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
