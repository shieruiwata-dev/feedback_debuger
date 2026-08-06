import {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  type Category,
  type Priority,
  type SourceType,
  type Status,
} from "../lib/types";

const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";

const PRIORITY_STYLE: Record<Priority, string> = {
  urgent: "bg-red-100 text-red-800 ring-1 ring-red-200",
  high: "bg-orange-100 text-orange-800 ring-1 ring-orange-200",
  medium: "bg-amber-100 text-amber-800 ring-1 ring-amber-200",
  low: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
};

const CATEGORY_STYLE: Record<Category, string> = {
  bug: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
  feature_request: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
  ux: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  other: "bg-slate-50 text-slate-600 ring-1 ring-slate-200",
};

const STATUS_STYLE: Record<Status, string> = {
  new: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  reviewing: "bg-yellow-50 text-yellow-800 ring-1 ring-yellow-200",
  adopted: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  done: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
  rejected: "bg-slate-50 text-slate-400 ring-1 ring-slate-200",
  ignored: "bg-slate-100 text-slate-500 ring-1 ring-slate-300",
};

export function PriorityBadge({ value }: { value: Priority | null }) {
  if (!value) return <UnknownBadge label="優先度未判定" />;
  return <span className={`${base} ${PRIORITY_STYLE[value]}`}>{PRIORITY_LABEL[value]}</span>;
}

export function CategoryBadge({ value }: { value: Category | null }) {
  if (!value) return <UnknownBadge label="分類未判定" />;
  return <span className={`${base} ${CATEGORY_STYLE[value]}`}>{CATEGORY_LABEL[value]}</span>;
}

export function StatusBadge({ value }: { value: Status }) {
  return <span className={`${base} ${STATUS_STYLE[value]}`}>{STATUS_LABEL[value]}</span>;
}

function UnknownBadge({ label }: { label: string }) {
  return (
    <span className={`${base} bg-slate-50 text-slate-400 ring-1 ring-dashed ring-slate-200`}>
      {label}
    </span>
  );
}

/** ソース種別アイコン。外部アイコンライブラリに依存しないよう inline SVG で持つ。 */
export function SourceIcon({ value }: { value: SourceType }) {
  const label = SOURCE_LABEL[value];
  const cls = "h-3.5 w-3.5 shrink-0";

  const icon = value === "slack"
    ? (
      <svg viewBox="0 0 24 24" className={cls} fill="currentColor" aria-hidden="true">
        <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Zm2-8a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 0 1 0 4H4a2 2 0 1 1 0-4h5Zm9 2a2 2 0 1 1 2 2h-2V10Zm-1 0a2 2 0 0 1-4 0V5a2 2 0 1 1 4 0v5Zm-2 8a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z" />
      </svg>
    )
    : value === "form"
    ? (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h4" strokeLinecap="round" />
      </svg>
    )
    : (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );

  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-slate-500"
      title={label}
    >
      {icon}
      {label}
    </span>
  );
}
