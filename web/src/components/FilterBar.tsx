import {
  CATEGORIES,
  CATEGORY_LABEL,
  EMPTY_FILTERS,
  PRIORITIES,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  SOURCE_TYPES,
  STATUS_LABEL,
  STATUSES,
  type Filters,
} from "../lib/types";

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
  resultCount: number;
}

export function FilterBar({ filters, onChange, resultCount }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <Select
        label="カテゴリ"
        value={filters.category}
        onChange={(v) => set("category", v as Filters["category"])}
        options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
      />
      <Select
        label="優先度"
        value={filters.priority}
        onChange={(v) => set("priority", v as Filters["priority"])}
        options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
      />
      <Select
        label="ソース"
        value={filters.source_type}
        onChange={(v) => set("source_type", v as Filters["source_type"])}
        options={SOURCE_TYPES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
      />
      <Select
        label="ステータス"
        value={filters.status}
        onChange={(v) => set("status", v as Filters["status"])}
        options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
      />

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        キーワード
        <input
          type="search"
          value={filters.query}
          onChange={(e) => set("query", e.target.value)}
          placeholder="要約・本文を検索"
          className="w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </label>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-xs text-slate-500">{resultCount} 件のクラスタ</span>
        {dirty && (
          <button
            onClick={() => onChange(EMPTY_FILTERS)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            条件をクリア
          </button>
        )}
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-600">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      >
        <option value="all">すべて</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
