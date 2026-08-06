import { useState } from "react";
import { CLUSTER_STATUSES, STATUS_LABEL, type Status } from "../lib/types";

interface Props {
  value: Status;
  onChange: (status: Status) => Promise<void>;
  disabled?: boolean;
}

/** ステータス変更セレクト。保存中は操作を止め、失敗したら元の値に戻す。 */
export function StatusSelect({ value, onChange, disabled }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (next: Status) => {
    if (next === value) return;
    setSaving(true);
    setError(null);
    try {
      await onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={value}
        disabled={disabled || saving}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation();
          void handle(e.target.value as Status);
        }}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-50 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        aria-label="ステータス"
      >
        {CLUSTER_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {saving && <span className="text-xs text-slate-400">保存中…</span>}
      {error && <span className="text-xs text-red-600" title={error}>失敗</span>}
    </span>
  );
}
