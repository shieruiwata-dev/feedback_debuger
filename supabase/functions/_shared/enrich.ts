import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyWithDify } from "./dify.ts";
import { embedText } from "./embeddings.ts";
import { minTriageConfidence, shouldAiTriage } from "./triage.ts";
import {
  type CandidateCluster,
  clusteringStrategy,
  fetchCandidates,
  formatCandidates,
  resolveMatch,
} from "./clustering.ts";
import { env } from "./env.ts";
import type { ClassifiedIssue, SourceType } from "./types.ts";

export interface EnrichResult {
  item_id: string;
  status: "done" | "failed" | "ignored" | "split";
  cluster_id?: string | null;
  /** 分割した場合の子の件数 */
  split_into?: number;
  error?: string;
}

/**
 * 1 件の feedback_item を仕上げる。
 *
 *   1. Dify で分類（priority / category / summary / is_feedback / issues）
 *   2. フィードバックでないと判定されたら status='ignored' にして打ち切る
 *   3. 論点が 2 つ以上なら、論点ごとの子 item に分割して各子を仕上げる
 *   4. 埋め込みを生成する
 *   5. assign_item_to_cluster() でクラスタ紐付け + スコア再計算
 *
 * 分割で作られた子は分類済み（親の 1 回の Dify 呼び出しの結果を持つ）なので、
 * 子に対してこの関数を呼んでも分類はやり直さず 4 以降だけを行う。
 * Dify の呼び出しは投稿 1 件につき 1 回のままに保たれる。
 */
export async function enrichItem(
  db: SupabaseClient,
  itemId: string,
): Promise<EnrichResult> {
  const { data: item, error: loadError } = await db
    .from("feedback_items")
    .select(
      "id, app_id, source_type, raw_text, summary, priority, category, is_feedback, triage_reason, parent_item_id, apps(name)",
    )
    .eq("id", itemId)
    .single();

  if (loadError) throw loadError;

  await db.from("feedback_items")
    .update({ processing_state: "processing", processing_error: null })
    .eq("id", itemId);

  const rawText = item.raw_text as string;

  // 分割で生まれた子は分類済み。ここを飛ばしてクラスタリングへ直行する。
  // llm 方式の子は親の処理内で既にクラスタへ載っているので、再処理で来た分だけがここに来る。
  if (isPreClassified(item)) {
    if (clusteringStrategy() === "llm") {
      return await matchAndCluster(
        db,
        itemId,
        item.app_id as string,
        item.summary as string,
        (item.priority as string) ?? "",
      );
    }
    return await embedAndCluster(db, itemId, rawText, item.summary as string | null);
  }

  const appName = (item as { apps?: { name?: string } }).apps?.name ?? "";
  const sourceType = item.source_type as SourceType;
  // 明示マーク済み（#fb / 📮 リアクション / 人手で復帰）は AI 判定で落とさない
  const forced = item.is_feedback === true;

  // --- 1. 分類（llm 方式では既存クラスタとの突き合わせも同じ呼び出しで行う）----
  const strategy = clusteringStrategy();
  let candidates: CandidateCluster[] = [];
  if (strategy === "llm") {
    candidates = await fetchCandidates(db, item.app_id as string, rawText);
  }

  let classification;
  try {
    classification = await classifyWithDify(
      rawText,
      appName,
      strategy === "llm" ? formatCandidates(candidates) : "",
    );
  } catch (err) {
    return await markFailed(db, itemId, `classify: ${errorMessage(err)}`);
  }

  // --- 2. トリアージ -------------------------------------------------------
  const triageApplies = !forced && shouldAiTriage(sourceType);
  const threshold = await resolveThreshold(db);
  const confidentlyNoise = !classification.is_feedback &&
    classification.confidence >= threshold;

  if (triageApplies && confidentlyNoise) {
    // 要約と分類は保存しておく（ノイズ欄で内容を確認して復帰判断できるようにする）
    await db.from("feedback_items").update({
      summary: classification.summary,
      priority: classification.priority,
      category: classification.category,
    }).eq("id", itemId);

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

  // --- 3. 論点が複数あれば分割 ---------------------------------------------
  if (classification.issues.length > 1) {
    return await splitAndEnrich(db, itemId, classification.issues, candidates);
  }

  // --- 4-5. 単一論点はその場で仕上げる -------------------------------------
  const update: Record<string, unknown> = {
    summary: classification.summary,
    priority: classification.priority,
    category: classification.category,
    is_feedback: true,
  };

  if (!forced) {
    update.triage_confidence = classification.confidence;
    update.triage_reason = classification.is_feedback
      ? "ai:feedback"
      // ノイズ寄りだが確信度が閾値未満で残したケース。閾値調整の材料になる
      : `ai_low_confidence:${classification.noise_reason ?? "判定不能"}`;
  }

  const { error: updateError } = await db
    .from("feedback_items").update(update).eq("id", itemId);
  if (updateError) {
    return await markFailed(db, itemId, `update: ${updateError.message}`);
  }

  if (strategy === "llm") {
    const clusterId = resolveMatch(classification.issues[0].match, candidates);
    return await attachAndFinish(db, itemId, clusterId);
  }

  return await embedAndCluster(db, itemId, rawText, classification.summary);
}

/**
 * 論点ごとに子 item を作り、それぞれを仕上げる。
 * 親は status='split' になって一覧から外れる（原文は残る）。
 */
async function splitAndEnrich(
  db: SupabaseClient,
  parentId: string,
  issues: ClassifiedIssue[],
  candidates: CandidateCluster[],
): Promise<EnrichResult> {
  const { data: children, error } = await db.rpc("split_feedback_item", {
    p_parent_id: parentId,
    p_segments: issues.map((i) => ({
      text: i.text,
      summary: i.summary,
      priority: i.priority,
      category: i.category,
    })),
  });

  if (error) return await markFailed(db, parentId, `split: ${error.message}`);

  const rows = (children ?? []) as Array<{ id: string }>;
  console.info(`item ${parentId} split into ${rows.length} issues`);

  // 子はクラスタリングまで進める。1 件失敗しても他は続行する
  // （失敗した子は processing_state='failed' で残り、再処理バッチが拾う）
  const strategy = clusteringStrategy();
  for (const [i, child] of rows.entries()) {
    try {
      if (strategy === "llm") {
        // 親の 1 回の分類で得た突き合わせ結果をそのまま使う。子ごとに Dify を呼び直さない
        const clusterId = resolveMatch(issues[i]?.match ?? null, candidates);
        await attachAndFinish(db, child.id, clusterId);
      } else {
        await enrichItem(db, child.id);
      }
    } catch (err) {
      console.error(`child ${child.id} enrichment failed:`, err);
    }
  }

  return { item_id: parentId, status: "split", split_into: rows.length };
}

/**
 * 埋め込みを作ってクラスタに載せる。
 *
 * ベクトル化するのは既定で「要約」。
 * 同じ内容が違う言い回しで届いたときにまとめたいので、
 * 前置きや敬語や周辺文脈が混ざった原文より、
 * 論点だけに正規化された要約の方が距離が安定する。
 * EMBEDDING_SOURCE=raw_text にすれば原文を使う挙動に戻せる。
 */
async function embedAndCluster(
  db: SupabaseClient,
  itemId: string,
  rawText: string,
  summary: string | null,
): Promise<EnrichResult> {
  const useSummary = (env("EMBEDDING_SOURCE") ?? "summary") === "summary";
  const target = useSummary && summary && summary.trim().length > 0 ? summary : rawText;

  let embedding: number[];
  try {
    embedding = await embedText(target);
  } catch (err) {
    return await markFailed(db, itemId, `embedding: ${errorMessage(err)}`);
  }

  const { error: updateError } = await db.from("feedback_items")
    // pgvector は文字列リテラル "[0.1,0.2,...]" 形式を受け付ける
    .update({ embedding: JSON.stringify(embedding) })
    .eq("id", itemId);

  if (updateError) {
    return await markFailed(db, itemId, `update: ${updateError.message}`);
  }

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
 * 再処理で来た「分類済みだがクラスタ未割り当て」の item を、
 * 既存クラスタと突き合わせて載せる（llm 方式）。
 * 分類はやり直さず、突き合わせだけを Dify に聞く。
 */
async function matchAndCluster(
  db: SupabaseClient,
  itemId: string,
  appId: string,
  summary: string,
  _priority: string,
): Promise<EnrichResult> {
  const candidates = await fetchCandidates(db, appId, summary);

  // 候補が無ければ問い合わせるまでもなく新規クラスタ
  if (candidates.length === 0) {
    return await attachAndFinish(db, itemId, null);
  }

  let match: number | null = null;
  try {
    const result = await classifyWithDify(summary, "", formatCandidates(candidates));
    match = result.issues[0]?.match ?? null;
  } catch (err) {
    return await markFailed(db, itemId, `match: ${errorMessage(err)}`);
  }

  return await attachAndFinish(db, itemId, resolveMatch(match, candidates));
}

/** クラスタに載せて処理済みにする（埋め込みを使わない経路） */
async function attachAndFinish(
  db: SupabaseClient,
  itemId: string,
  clusterId: string | null,
): Promise<EnrichResult> {
  const { data, error } = await db.rpc("attach_item_to_cluster", {
    p_item_id: itemId,
    p_cluster_id: clusterId,
  });

  if (error) return await markFailed(db, itemId, `cluster: ${error.message}`);

  await db.from("feedback_items").update({
    processing_state: "done",
    processing_error: null,
    processed_at: new Date().toISOString(),
  }).eq("id", itemId);

  return { item_id: itemId, status: "done", cluster_id: data as string | null };
}

/** 分割で作られた子（分類済み）かどうか */
function isPreClassified(item: Record<string, unknown>): boolean {
  return item.parent_item_id !== null &&
    typeof item.summary === "string" &&
    typeof item.priority === "string" &&
    typeof item.category === "string";
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
