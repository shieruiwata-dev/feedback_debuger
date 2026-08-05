import { isSupabaseConfigured, requireSupabase } from "./supabase";
import { mockApps, mockClusters, mockItems } from "./mockData";
import type { App, Cluster, FeedbackItem, Status } from "./types";

/**
 * データアクセス層。
 * Supabase 未設定ならモックにフォールバックするので、
 * artifact / ローカルで UI を確認 → 環境変数を入れて実データに切り替え、という流れで進められる。
 */
export const isMockMode = !isSupabaseConfigured;

/** 1 アプリあたりの取得上限。社内ツール想定でクライアント側結合しているため上限を設ける。 */
const CLUSTER_LIMIT = 500;
const ITEM_LIMIT = 3000;

// モックモード用のインメモリ状態（ステータス更新を画面上で確認できるようにする）
const mockState = {
  clusters: mockClusters.map((c) => ({ ...c })),
  items: mockItems.map((i) => ({ ...i })),
};

export async function fetchApps(): Promise<App[]> {
  if (isMockMode) return mockApps;

  const { data, error } = await requireSupabase()
    .from("apps")
    .select("id, name, slug")
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []) as App[];
}

export interface DashboardData {
  clusters: Cluster[];
  items: FeedbackItem[];
}

/**
 * 選択中アプリのクラスタと item をまとめて取得する。
 * source_type フィルタはクラスタ配下の item を見ないと判定できないため、
 * サーバー側で絞らずクライアントで結合・フィルタする方式にしている。
 */
export async function fetchDashboardData(appId: string): Promise<DashboardData> {
  if (isMockMode) {
    return {
      clusters: mockState.clusters.filter((c) => c.app_id === appId),
      items: mockState.items.filter((i) => i.app_id === appId),
    };
  }

  const db = requireSupabase();

  const [clusterRes, itemRes] = await Promise.all([
    db
      .from("feedback_clusters")
      .select(
        "id, app_id, representative_summary, category, priority, item_count, score, status, updated_at",
      )
      .eq("app_id", appId)
      .order("score", { ascending: false })
      .limit(CLUSTER_LIMIT),
    db
      .from("feedback_items")
      .select(
        "id, app_id, source_type, raw_text, summary, priority, category, cluster_id, source_meta, status, created_at",
      )
      .eq("app_id", appId)
      .order("created_at", { ascending: false })
      .limit(ITEM_LIMIT),
  ]);

  if (clusterRes.error) throw clusterRes.error;
  if (itemRes.error) throw itemRes.error;

  return {
    clusters: (clusterRes.data ?? []) as Cluster[],
    items: (itemRes.data ?? []) as FeedbackItem[],
  };
}

/** クラスタ単位のステータス更新。配下 items にも反映される（RPC 側で実施） */
export async function updateClusterStatus(
  clusterId: string,
  status: Status,
): Promise<void> {
  if (isMockMode) {
    const cluster = mockState.clusters.find((c) => c.id === clusterId);
    if (cluster) cluster.status = status;
    mockState.items
      .filter((i) => i.cluster_id === clusterId)
      .forEach((i) => (i.status = status));
    return;
  }

  const { error } = await requireSupabase().rpc("set_cluster_status", {
    p_cluster_id: clusterId,
    p_status: status,
  });

  if (error) throw error;
}

/** 未クラスタ item（AI 処理前 / 埋め込み失敗分）のステータス更新 */
export async function updateItemStatus(
  itemId: string,
  status: Status,
): Promise<void> {
  if (isMockMode) {
    const item = mockState.items.find((i) => i.id === itemId);
    if (item) item.status = status;
    return;
  }

  const { error } = await requireSupabase()
    .from("feedback_items")
    .update({ status })
    .eq("id", itemId);

  if (error) throw error;
}
