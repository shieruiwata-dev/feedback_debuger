import { useState } from "react";
import { CategoryBadge, PriorityBadge, StatusBadge } from "./Badges";
import { ItemRow } from "./ItemRow";
import { StatusSelect } from "./StatusSelect";
import type { Cluster, FeedbackItem, Status } from "../lib/types";

interface Props {
  cluster: Cluster;
  items: FeedbackItem[];
  /** 同一アプリ内の最大スコア。スコアバーの幅計算に使う */
  maxScore: number;
  onStatusChange: (status: Status) => Promise<void>;
}

export function ClusterCard({ cluster, items, maxScore, onStatusChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const barWidth = maxScore > 0 ? Math.max(2, (cluster.score / maxScore) * 100) : 0;

  return (
    <li className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex w-full cursor-pointer items-start gap-4 p-4 text-left hover:bg-slate-50"
      >
        <div className="w-16 shrink-0 text-center">
          <div className="text-xl font-semibold tabular-nums text-slate-900">
            {formatScore(cluster.score)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">score</div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-slate-800" style={{ width: `${barWidth}%` }} />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">
            {cluster.representative_summary ?? "(要約なし)"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PriorityBadge value={cluster.priority} />
            <CategoryBadge value={cluster.category} />
            <StatusBadge value={cluster.status} />
            <span className="text-xs text-slate-500">{cluster.item_count} 件の意見</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <StatusSelect value={cluster.status} onChange={onStatusChange} />
          <span
            className={"text-slate-400 transition-transform " + (expanded ? "rotate-90" : "")}
            aria-hidden="true"
          >
            ▶
          </span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-200 bg-slate-50/60">
          {items.length === 0
            ? (
              <p className="px-4 py-3 text-sm text-slate-500">
                このクラスタに該当する意見がフィルタ条件に一致しませんでした。
              </p>
            )
            : <ul>{items.map((item) => <ItemRow key={item.id} item={item} />)}</ul>}
        </div>
      )}
    </li>
  );
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}
