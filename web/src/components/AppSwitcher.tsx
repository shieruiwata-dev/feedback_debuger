import type { App } from "../lib/types";

interface Props {
  apps: App[];
  selectedAppId: string | null;
  onSelect: (appId: string) => void;
}

/**
 * アプリ切り替え。
 * apps テーブルから動的に生成する。4 件以下ならタブ、それ以上はドロップダウンに切り替える
 * （タブが折り返して読みづらくなるため）。
 */
export function AppSwitcher({ apps, selectedAppId, onSelect }: Props) {
  if (apps.length === 0) {
    return <p className="text-sm text-slate-500">アプリが登録されていません</p>;
  }

  if (apps.length > 4) {
    return (
      <label className="flex items-center gap-2 text-sm">
        <span className="text-slate-600">アプリ</span>
        <select
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          value={selectedAppId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
        >
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div role="tablist" aria-label="アプリ切り替え" className="flex flex-wrap gap-1">
      {apps.map((app) => {
        const active = app.id === selectedAppId;
        return (
          <button
            key={app.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(app.id)}
            className={
              "rounded-md px-3 py-1.5 text-sm font-medium transition " +
              (active
                ? "bg-slate-900 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100")
            }
          >
            {app.name}
          </button>
        );
      })}
    </div>
  );
}
