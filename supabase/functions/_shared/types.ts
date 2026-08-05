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
export type Status = "new" | "reviewing" | "adopted" | "done" | "rejected";

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
export const CATEGORIES: Category[] = ["bug", "feature_request", "ux", "other"];

export interface Classification {
  priority: Priority;
  category: Category;
  summary: string;
}

export interface IngestResult {
  status: "inserted" | "duplicate" | "ignored";
  item_id?: string;
  reason?: string;
}
