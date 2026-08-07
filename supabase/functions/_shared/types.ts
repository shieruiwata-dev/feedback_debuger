/** 全アダプタが最終的にこの形に正規化してから DB に投げる */
export interface NormalizedFeedback {
  app_id: string;
  source_type: SourceType;
  raw_text: string;
  source_meta: Record<string, unknown>;
  external_id: string | null;
}

export type SourceType = "slack" | "form" | "email";
export type Priority = "urgent" | "high" | "medium" | "low";
export type Category = "bug" | "feature_request" | "ux" | "other";
export type Status =
  | "new" | "reviewing" | "adopted" | "done" | "rejected"
  /** フィードバックではないと判定された */
  | "ignored"
  /** 論点ごとに分割された原文。一覧には出さず、子が実体になる */
  | "split";

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
export const CATEGORIES: Category[] = ["bug", "feature_request", "ux", "other"];

/** 分割後の 1 論点 */
export interface ClassifiedIssue {
  /** 原文から抜き出した該当箇所。取れなければ要約で代用する */
  text: string;
  summary: string;
  priority: Priority;
  category: Category;
  /**
   * 既存クラスタの候補一覧のうち、同じ論点だと LLM が判断した番号（1 始まり）。
   * 該当なしなら null。CLUSTERING_STRATEGY=llm のときだけ使う。
   */
  match: number | null;
}

export interface Classification {
  priority: Priority;
  category: Category;
  summary: string;
  /**
   * 論点ごとの分割結果。
   * 1 件なら分割しない。2 件以上なら feedback_items を分けて作る。
   * Dify が items を返さない場合は、上の priority/category/summary から 1 件を組み立てる。
   */
  issues: ClassifiedIssue[];
  /** フィードバックとして扱うべきか（Slack の雑談・通知を除くための判定） */
  is_feedback: boolean;
  /** is_feedback の確信度 0〜1。低いものはノイズ判定を採用しない */
  confidence: number;
  /** ノイズと判定した理由。ダッシュボードに出して閾値調整の材料にする */
  noise_reason: string | null;
}

export interface IngestResult {
  status: "inserted" | "duplicate" | "ignored" | "restored";
  item_id?: string;
  reason?: string;
}

/** 取り込み元アダプタが判定済みの選別ヒント */
export interface TriageHint {
  /** 明示マーク（#fb / 📮 リアクション）が付いている = AI 判定を飛ばして必ず取り込む */
  forced?: boolean;
  /** 判定の根拠。feedback_items.triage_reason に残す */
  reason?: string;
}
