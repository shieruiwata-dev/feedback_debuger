import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyWithDify } from "./dify.ts";
import { embedText } from "./embeddings.ts";

export interface EnrichResult {
  item_id: string;
  status: "done" | "failed" | "skipped";
  cluster_id?: string | null;
  error?: string;
}

/**
 * 1 件の feedback_item を仕上げる:
 *   1. Dify で分類（priority / category / summary）と埋め込み生成を並列実行
 *   2. 結果を feedback_items に書き戻す
 *   3. assign_item_to_cluster() でクラスタ紐付け（or 新規作成）+ スコア再計算
 *
 * 分類と埋め込みは独立なので Promise.allSettled で並列に投げる。
 * 片方だけ失敗した場合も、取れた方は保存して次回の再処理に引き継ぐ。
 */
export async function enrichItem(
  db: SupabaseClient,
  itemId: string,
): Promise<EnrichResult> {
  const { data: item, error: loadError } = await db
    .from("feedback_items")
    .select("id, app_id, raw_text, summary, priority, category, embedding, apps(name)")
    .eq("id", itemId)
    .single();

  if (loadError) throw loadError;

  // 二重処理防止。既に done なら何もしない。
  await db.from("feedback_items")
    .update({ processing_state: "processing", processing_error: null })
    .eq("id", itemId);

  const appName = (item as { apps?: { name?: string } }).apps?.name ?? "";
  const rawText = item.raw_text as string;

  const [classifyRes, embedRes] = await Promise.allSettled([
    classifyWithDify(rawText, appName),
    embedText(rawText),
  ]);

  const update: Record<string, unknown> = {};
  const errors: string[] = [];

  if (classifyRes.status === "fulfilled") {
    update.summary = classifyRes.value.summary;
    update.priority = classifyRes.value.priority;
    update.category = classifyRes.value.category;
  } else {
    errors.push(`classify: ${errorMessage(classifyRes.reason)}`);
  }

  if (embedRes.status === "fulfilled") {
    // pgvector は文字列リテラル "[0.1,0.2,...]" 形式を受け付ける
    update.embedding = JSON.stringify(embedRes.value);
  } else {
    errors.push(`embedding: ${errorMessage(embedRes.reason)}`);
  }

  if (Object.keys(update).length > 0) {
    const { error } = await db.from("feedback_items").update(update).eq("id", itemId);
    if (error) errors.push(`update: ${error.message}`);
  }

  // 埋め込みが取れていなければクラスタリングまで進めない
  if (embedRes.status !== "fulfilled" || errors.length > 0) {
    await db.from("feedback_items").update({
      processing_state: "failed",
      processing_error: errors.join(" / ").slice(0, 1000),
    }).eq("id", itemId);

    return { item_id: itemId, status: "failed", error: errors.join(" / ") };
  }

  const { data: clusterId, error: clusterError } = await db
    .rpc("assign_item_to_cluster", { p_item_id: itemId });

  if (clusterError) {
    await db.from("feedback_items").update({
      processing_state: "failed",
      processing_error: `cluster: ${clusterError.message}`.slice(0, 1000),
    }).eq("id", itemId);
    return { item_id: itemId, status: "failed", error: clusterError.message };
  }

  await db.from("feedback_items").update({
    processing_state: "done",
    processing_error: null,
    processed_at: new Date().toISOString(),
  }).eq("id", itemId);

  return { item_id: itemId, status: "done", cluster_id: clusterId as string | null };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
