import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyWithDify } from "./dify.ts";
import { embedText } from "./embeddings.ts";
import { minTriageConfidence, shouldAiTriage } from "./triage.ts";
import type { SourceType } from "./types.ts";

export interface EnrichResult {
  item_id: string;
  status: "done" | "failed" | "ignored";
  cluster_id?: string | null;
  error?: string;
}

/**
 * 1 件の feedback_item を仕上げる。
 *
 *   1. Dify で分類（priority / category / summary / is_feedback / confidence）
 *   2. フィードバックでないと判定されたら status='ignored' にして打ち切る
 *   3. 埋め込みを生成する
 *   4. assign_item_to_cluster() でクラスタ紐付け + スコア再計算
 *
 * 分類と埋め込みは以前は並列に投げていたが、トリアージを入れたので直列にした。
 * ノイズと分かった時点で打ち切れば、そのぶんの埋め込み API 呼び出しがまるごと不要になる。
 * 雑多なチャンネルではノイズの方が多数になるため、直列化の遅延より節約が効く
 * （どちらもバックグラウンド実行なのでユーザー体験には影響しない）。
 */
export async function enrichItem(
  db: SupabaseClient,
  itemId: string,
): Promise<EnrichResult> {
  const { data: item, error: loadError } = await db
    .from("feedback_items")
    .select(
      "id, app_id, source_type, raw_text, is_feedback, triage_reason, apps(name)",
    )
    .eq("id", itemId)
    .single();

  if (loadError) throw loadError;

  await db.from("feedback_items")
    .update({ processing_state: "processing", processing_error: null })
    .eq("id", itemId);

  const appName = (item as { apps?: { name?: string } }).apps?.name ?? "";
  const rawText = item.raw_text as string;
  const sourceType = item.source_type as SourceType;
  // 明示マーク済み（#fb / 📮 リアクション / 人手で復帰）は AI 判定で落とさない
  const forced = item.is_feedback === true;

  // --- 1. 分類 -------------------------------------------------------------
  let classification;
  try {
    classification = await classifyWithDify(rawText, appName);
  } catch (err) {
    return await markFailed(db, itemId, `classify: ${errorMessage(err)}`);
  }

  const update: Record<string, unknown> = {
    summary: classification.summary,
    priority: classification.priority,
    category: classification.category,
  };

  // --- 2. トリアージ -------------------------------------------------------
  const triageApplies = !forced && shouldAiTriage(sourceType);
  const threshold = await resolveThreshold(db);
  const confidentlyNoise = !classification.is_feedback &&
    classification.confidence >= threshold;

  if (triageApplies && confidentlyNoise) {
    // 要約と分類は保存しておく（ノイズ欄で内容を確認して復帰判断できるようにする）
    await db.from("feedback_items").update(update).eq("id", itemId);

    const reason = `ai:${classification.noise_reason ?? "フィードバックではないと判定"}`;
    const { error } = await db.rpc("mark_item_as_noise", {
      p_item_id: itemId,
      p_reason: reason,
      p_confidence: classification.confidence,
    });

    if (error) return await markFailed(db, itemId, `triage: ${error.message}`);

    console.info(`item ${itemId} marked as noise: ${reason}`);
    return { item_id: itemId, status: "ignored" };
  }

  // フィードバックと判定された（または判定を飛ばした）ことを記録する
  update.is_feedback = true;
  if (!forced) {
    update.triage_confidence = classification.confidence;
    update.triage_reason = classification.is_feedback
      ? "ai:feedback"
      // ノイズ寄りだが確信度が閾値未満で残したケース。閾値調整の材料になる
      : `ai_low_confidence:${classification.noise_reason ?? "判定不能"}`;
  }

  // --- 3. 埋め込み ---------------------------------------------------------
  try {
    // pgvector は文字列リテラル "[0.1,0.2,...]" 形式を受け付ける
    update.embedding = JSON.stringify(await embedText(rawText));
  } catch (err) {
    await db.from("feedback_items").update(update).eq("id", itemId);
    return await markFailed(db, itemId, `embedding: ${errorMessage(err)}`);
  }

  const { error: updateError } = await db
    .from("feedback_items").update(update).eq("id", itemId);
  if (updateError) {
    return await markFailed(db, itemId, `update: ${updateError.message}`);
  }

  // --- 4. クラスタリング ---------------------------------------------------
  const { data: clusterId, error: clusterError } = await db
    .rpc("assign_item_to_cluster", { p_item_id: itemId });

  if (clusterError) {
    return await markFailed(db, itemId, `cluster: ${clusterError.message}`);
  }

  await db.from("feedback_items").update({
    processing_state: "done",
    processing_error: null,
    processed_at: new Date().toISOString(),
  }).eq("id", itemId);

  return { item_id: itemId, status: "done", cluster_id: clusterId as string | null };
}

/**
 * ノイズ判定を採用する確信度の下限。
 * app_settings を優先し、無ければ環境変数 → 既定値 0.7。
 * SQL 1 文で運用中に変えられるようにしてある。
 */
async function resolveThreshold(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "triage.min_confidence")
    .maybeSingle();

  if (error || data?.value === undefined || data?.value === null) {
    return minTriageConfidence();
  }

  const n = typeof data.value === "number"
    ? data.value
    : Number.parseFloat(String(data.value));

  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : minTriageConfidence();
}

async function markFailed(
  db: SupabaseClient,
  itemId: string,
  message: string,
): Promise<EnrichResult> {
  await db.from("feedback_items").update({
    processing_state: "failed",
    processing_error: message.slice(0, 1000),
  }).eq("id", itemId);

  console.error(`enrich failed for ${itemId}: ${message}`);
  return { item_id: itemId, status: "failed", error: message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
