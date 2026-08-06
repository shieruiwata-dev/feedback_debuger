import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSwitcher } from "../components/AppSwitcher";
import { FilterBar } from "../components/FilterBar";
import { ClusterCard } from "../components/ClusterCard";
import { ItemRow } from "../components/ItemRow";
import { StatusSelect } from "../components/StatusSelect";
import { NoiseList } from "../components/NoiseList";
import {
  fetchApps,
  fetchDashboardData,
  isMockMode,
  restoreItemAsFeedback,
  updateClusterStatus,
  updateItemStatus,
} from "../lib/api";
import {
  EMPTY_FILTERS,
  type App,
  type Cluster,
  type FeedbackItem,
  type Filters,
  type Status,
} from "../lib/types";

const SELECTED_APP_KEY = "fbdbg.selectedAppId";

export function Dashboard({ onSignOut }: { onSignOut?: () => void }) {
  const [apps, setApps] = useState<App[]>([]);
  const [appId, setAppId] = useState<string | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // アプリ一覧の取得（初回のみ）
  useEffect(() => {
    let cancelled = false;
    fetchApps()
      .then((list) => {
        if (cancelled) return;
        setApps(list);
        const remembered = localStorage.getItem(SELECTED_APP_KEY);
        const initial = list.find((a) => a.id === remembered)?.id ?? list[0]?.id ?? null;
        setAppId(initial);
        if (list.length === 0) setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (targetAppId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDashboardData(targetAppId);
      setClusters(data.clusters);
      setItems(data.items);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 選択アプリが変わったら再取得
  useEffect(() => {
    if (!appId) return;
    localStorage.setItem(SELECTED_APP_KEY, appId);
    void load(appId);
  }, [appId, load]);

  const itemsByCluster = useMemo(() => {
    const map = new Map<string, FeedbackItem[]>();
    for (const item of items) {
      if (!item.cluster_id) continue;
      const list = map.get(item.cluster_id);
      if (list) list.push(item);
      else map.set(item.cluster_id, [item]);
    }
    return map;
  }, [items]);

  const itemMatchesFilters = useCallback(
    (item: FeedbackItem) => {
      if (filters.source_type !== "all" && item.source_type !== filters.source_type) return false;
      if (filters.query) {
        const q = filters.query.toLowerCase();
        const haystack = `${item.raw_text} ${item.summary ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    },
    [filters.source_type, filters.query],
  );

  /**
   * クラスタの表示判定。
   * category / priority / status はクラスタの集計値で判定し、
   * source_type とキーワードは「配下 item に 1 件でも該当があるか」で判定する
   * （クラスタ自体はソース種別を持たないため）。
   */
  const visibleClusters = useMemo(() => {
    return clusters
      .filter((cluster) => {
        if (filters.category !== "all" && cluster.category !== filters.category) return false;
        if (filters.priority !== "all" && cluster.priority !== filters.priority) return false;
        if (filters.status !== "all" && cluster.status !== filters.status) return false;

        const needsItemMatch = filters.source_type !== "all" || filters.query !== "";
        if (!needsItemMatch) return true;

        const summaryHit = filters.source_type === "all" && filters.query !== "" &&
          (cluster.representative_summary ?? "").toLowerCase().includes(filters.query.toLowerCase());

        return summaryHit || (itemsByCluster.get(cluster.id) ?? []).some(itemMatchesFilters);
      })
      .sort((a, b) => b.score - a.score);
  }, [clusters, filters, itemsByCluster, itemMatchesFilters]);

  /**
   * まだクラスタに入っていない item（AI 処理前 / 埋め込み失敗分）。
   * ノイズ判定されたものは本編に混ぜず、専用の欄に分ける。
   */
  const unclusteredItems = useMemo(() => {
    return items.filter((item) => {
      if (item.cluster_id) return false;
      // ノイズと、分割された原文（実体は子）は本編に出さない
      if (item.status === "ignored" || item.status === "split") return false;
      if (filters.category !== "all" && item.category !== filters.category) return false;
      if (filters.priority !== "all" && item.priority !== filters.priority) return false;
      if (filters.status !== "all" && item.status !== filters.status) return false;
      return itemMatchesFilters(item);
    });
  }, [items, filters, itemMatchesFilters]);

  /** ノイズ判定された item（誤判定を戻せるように別枠で出す） */
  const ignoredItems = useMemo(() => {
    // ステータスフィルタで別の状態を指定しているときはノイズ欄を出さない
    if (filters.status !== "all" && filters.status !== "ignored") return [];
    return items.filter((item) => item.status === "ignored" && itemMatchesFilters(item));
  }, [items, filters.status, itemMatchesFilters]);

  const maxScore = useMemo(
    () => visibleClusters.reduce((max, c) => Math.max(max, c.score), 0),
    [visibleClusters],
  );

  const handleClusterStatus = async (clusterId: string, status: Status) => {
    await updateClusterStatus(clusterId, status);
    setClusters((prev) => prev.map((c) => (c.id === clusterId ? { ...c, status } : c)));
    setItems((prev) =>
      prev.map((i) => (i.cluster_id === clusterId ? { ...i, status } : i))
    );
  };

  const handleItemStatus = async (itemId: string, status: Status) => {
    await updateItemStatus(itemId, status);
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, status } : i)));
  };

  const handleRestore = async (itemId: string) => {
    await restoreItemAsFeedback(itemId);
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, status: "new" as Status, is_feedback: true, triage_reason: "manual_restore" }
          : i
      )
    );
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <h1 className="text-base font-semibold text-slate-900">フィードバックデバッガー</h1>
          <AppSwitcher apps={apps} selectedAppId={appId} onSelect={setAppId} />
          <div className="ml-auto flex items-center gap-3">
            {isMockMode && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                title="VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定のため、モックデータを表示しています"
              >
                モックデータ表示中
              </span>
            )}
            <button
              onClick={() => appId && void load(appId)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              再読み込み
            </button>
            {onSignOut && (
              <button
                onClick={onSignOut}
                className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-800"
              >
                ログアウト
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          resultCount={visibleClusters.length}
        />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            読み込みに失敗しました: {error}
          </div>
        )}

        {loading
          ? <p className="py-12 text-center text-sm text-slate-500">読み込み中…</p>
          : (
            <>
              {visibleClusters.length === 0
                ? (
                  <p className="rounded-lg border border-dashed border-slate-300 bg-white py-12 text-center text-sm text-slate-500">
                    条件に一致するクラスタはありません。
                  </p>
                )
                : (
                  <ul className="space-y-2">
                    {visibleClusters.map((cluster) => (
                      <ClusterCard
                        key={cluster.id}
                        cluster={cluster}
                        items={(itemsByCluster.get(cluster.id) ?? []).filter(itemMatchesFilters)}
                        maxScore={maxScore}
                        onStatusChange={(status) => handleClusterStatus(cluster.id, status)}
                      />
                    ))}
                  </ul>
                )}

              {unclusteredItems.length > 0 && (
                <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
                  <h2 className="border-b border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700">
                    未クラスタの意見
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {unclusteredItems.length} 件 ／ AI 処理前、または埋め込み生成に失敗した分
                    </span>
                  </h2>
                  <ul>
                    {unclusteredItems.map((item) => (
                      <div key={item.id} className="relative">
                        <div className="absolute right-4 top-3 z-10">
                          <StatusSelect
                            value={item.status}
                            onChange={(status) => handleItemStatus(item.id, status)}
                          />
                        </div>
                        <ItemRow item={item} />
                      </div>
                    ))}
                  </ul>
                </section>
              )}

              <NoiseList items={ignoredItems} onRestore={handleRestore} />
            </>
          )}
      </main>
    </div>
  );
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
