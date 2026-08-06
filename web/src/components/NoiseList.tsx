import { useState } from "react";
import { SourceIcon } from "./Badges";
import { formatDate } from "./ItemRow";
import type { FeedbackItem } from "../lib/types";

interface Props {
  items: FeedbackItem[];
  onRestore: (itemId: string) => Promise<void>;
}

/**
 * ノイズ判定された投稿の一覧。
 * 既定では畳んでおき、誤判定を見つけたらワンクリックでフィードバックに戻せるようにする。
 * 判定理由と確信度を出すのは、閾値をどう動かすか決める材料にするため。
 */
export function NoiseList({ items, onRestore }: Props) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-slate-600 hover:bg-slate-50"
      >
        <span className={"text-slate-400 transition-transform " + (open ? "rotate-90" : "")}>
          ▶
        </span>
        ノイズ判定
        <span className="text-xs font-normal text-slate-500">
          {items.length} 件 ／ フィードバックではないと判定された投稿
        </span>
      </button>

      {open && (
        <ul className="border-t border-slate-200 bg-slate-50/60">
          {items.map((item) => (
            <NoiseRow key={item.id} item={item} onRestore={onRestore} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoiseRow({ item, onRestore }: { item: FeedbackItem; onRestore: Props["onRestore"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRestore(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "復帰に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <SourceIcon value={item.source_type} />
            <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
            {item.triage_reason && (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600">
                {item.triage_reason}
              </span>
            )}
            {item.triage_confidence !== null && (
              <span className="text-[11px] text-slate-400">
                確信度 {item.triage_confidence.toFixed(2)}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm text-slate-600">{item.raw_text}</p>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>

        <button
          onClick={restore}
          disabled={busy}
          className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? "戻しています…" : "フィードバックに戻す"}
        </button>
      </div>
    </li>
  );
}
