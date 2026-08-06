export type SourceType = "slack" | "form" | "email";
export type Priority = "urgent" | "high" | "medium" | "low";
export type Category = "bug" | "feature_request" | "ux" | "other";
export type Status =
  | "new" | "reviewing" | "adopted" | "done" | "rejected"
  /** フィードバックではないと判定された */
  | "ignored"
  /** 論点ごとに分割された原文。一覧には出さず、子が実体になる */
  | "split";

export interface App {
  id: string;
  name: string;
  slug: string;
}

export interface Cluster {
  id: string;
  app_id: string;
  representative_summary: string | null;
  category: Category | null;
  priority: Priority | null;
  item_count: number;
  score: number;
  status: Status;
  updated_at: string;
}

export interface FeedbackItem {
  id: string;
  app_id: string;
  source_type: SourceType;
  raw_text: string;
  summary: string | null;
  priority: Priority | null;
  category: Category | null;
  cluster_id: string | null;
  source_meta: Record<string, unknown>;
  status: Status;
  created_at: string;
  /** null = 未判定 / false = ノイズ判定 */
  is_feedback: boolean | null;
  /** 分割元の item。null なら分割されていない */
  parent_item_id: string | null;
  /** 分割元の中での通し番号（1 始まり） */
  segment_index: number | null;
  /** 判定理由（ai:雑談のため / heuristic:too_short / marker:#fb など） */
  triage_reason: string | null;
  triage_confidence: number | null;
}

export interface Filters {
  category: Category | "all";
  priority: Priority | "all";
  source_type: SourceType | "all";
  status: Status | "all";
  query: string;
}

export const EMPTY_FILTERS: Filters = {
  category: "all",
  priority: "all",
  source_type: "all",
  status: "all",
  query: "",
};

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
export const CATEGORIES: Category[] = ["bug", "feature_request", "ux", "other"];
/** クラスタのステータス変更で選べる値。ignored はクラスタには使わない */
export const CLUSTER_STATUSES: Status[] = ["new", "reviewing", "adopted", "done", "rejected"];
/** フィルタで選べる値（ノイズ欄を見るために ignored も含む） */
export const STATUSES: Status[] = [...CLUSTER_STATUSES, "ignored"];
export const SOURCE_TYPES: SourceType[] = ["slack", "form", "email"];

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "緊急",
  high: "高",
  medium: "中",
  low: "低",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  bug: "バグ",
  feature_request: "要望",
  ux: "UX",
  other: "その他",
};

export const STATUS_LABEL: Record<Status, string> = {
  new: "未対応",
  reviewing: "確認中",
  adopted: "採用",
  done: "完了",
  rejected: "見送り",
  ignored: "ノイズ",
  split: "分割済み",
};

export const SOURCE_LABEL: Record<SourceType, string> = {
  slack: "Slack",
  form: "フォーム",
  email: "メール",
};
