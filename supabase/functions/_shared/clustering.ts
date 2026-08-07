import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envInt } from "./env.ts";

/**
 * クラスタリング方式の切り替え。
 *
 *   embedding … 要約をベクトル化し、pgvector の最近傍で合流先を決める（従来）
 *   llm       … 既存クラスタの要約一覧を LLM に見せて、同じ論点かを判断させる
 *
 * llm 方式は埋め込み API を持たない環境（Dify だけで完結させたい場合）向け。
 * 照合は分類と同じ Dify 呼び出しに同居させるので、API 呼び出し回数は増えない。
 *
 * 既定は、埋め込みの鍵があれば embedding、無ければ llm。
 * 設定漏れで黙って壊れるより、動く方に倒す。
 */
export type ClusteringStrategy = "embedding" | "llm";

export function clusteringStrategy(): ClusteringStrategy {
  const explicit = env("CLUSTERING_STRATEGY");
  if (explicit === "embedding" || explicit === "llm") return explicit;
  return env("OPENAI_API_KEY") ? "embedding" : "llm";
}

export interface CandidateCluster {
  cluster_id: string;
  summary: string;
  item_count: number;
}

/**
 * LLM に突き合わせさせる既存クラスタを取ってくる。
 * 全件を渡すとクラスタが増えるほどプロンプトが膨らむので、Postgres 側で絞る。
 */
export async function fetchCandidates(
  db: SupabaseClient,
  appId: string,
  query: string,
): Promise<CandidateCluster[]> {
  const { data, error } = await db.rpc("candidate_clusters", {
    p_app_id: appId,
    p_query: query.slice(0, 500),
    p_limit: envInt("LLM_CLUSTER_CANDIDATES", 40),
  });

  if (error) {
    // 候補が取れなくても取り込みは続ける。全部が新規クラスタになるだけで、データは失わない
    console.error("candidate_clusters failed, continuing without candidates:", error.message);
    return [];
  }

  return (data ?? []) as CandidateCluster[];
}

/**
 * 候補を LLM に渡すテキストにする。
 *
 *   1. 検索の応答が遅い（12件）
 *   2. 申請履歴のCSVエクスポート（8件）
 *
 * 番号で答えさせるのは、UUID を書き写させると誤りが混ざるため。
 * 件数を添えるのは、大きなクラスタへの合流を選びやすくする手がかりになるため。
 */
export function formatCandidates(candidates: CandidateCluster[]): string {
  if (candidates.length === 0) return "（まだ登録された論点はありません）";

  return candidates
    .map((c, i) => `${i + 1}. ${c.summary}（${c.item_count}件）`)
    .join("\n");
}

/**
 * LLM が返した番号を cluster_id に戻す。
 *
 * 範囲外の番号や欠番は「該当なし」として扱う。
 * 存在しないクラスタに紐付けるより、新規クラスタを作る方が実害が小さい
 * （後から人手で束ねられるが、誤った合流は気づきにくい）。
 */
export function resolveMatch(
  match: number | null,
  candidates: CandidateCluster[],
): string | null {
  if (match === null || !Number.isInteger(match)) return null;
  if (match < 1 || match > candidates.length) {
    console.warn(`llm returned out-of-range match: ${match} (candidates=${candidates.length})`);
    return null;
  }
  return candidates[match - 1].cluster_id;
}
