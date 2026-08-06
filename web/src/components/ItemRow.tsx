import { SourceIcon } from "./Badges";
import type { FeedbackItem } from "../lib/types";

/** source_meta は jsonb なので、表示に使う値は型を確かめてから取り出す */
function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(meta: Record<string, unknown>, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

export function ItemRow({ item }: { item: FeedbackItem }) {
  const permalink = str(item.source_meta, "permalink");
  const slackUser = str(item.source_meta, "slack_user_name") ??
    str(item.source_meta, "slack_user_id");
  const email = str(item.source_meta, "submitter_email");
  const pageUrl = str(item.source_meta, "page_url");
  const originalText = str(item.source_meta, "original_text");
  const segmentCount = num(item.source_meta, "segment_count");

  return (
    <li className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <SourceIcon value={item.source_type} />
        <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
        {item.segment_index !== null && (
          // 長文を論点ごとに分けたもの。原文はホバーで確認できる
          <span
            className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600"
            title={originalText ? `元の投稿:\n${originalText}` : undefined}
          >
            分割 {item.segment_index}
            {segmentCount !== null ? ` / ${segmentCount}` : ""}
          </span>
        )}
        {slackUser && <span>@{slackUser}</span>}
        {email && <span>{email}</span>}
        {permalink && (
          <a
            href={permalink}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sky-600 underline underline-offset-2 hover:text-sky-800"
          >
            Slack で開く
          </a>
        )}
        {pageUrl && (
          <a
            href={pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="max-w-xs truncate text-sky-600 underline underline-offset-2 hover:text-sky-800"
            title={pageUrl}
          >
            {pageUrl}
          </a>
        )}
      </div>
      <p className="whitespace-pre-wrap text-sm text-slate-800">{item.raw_text}</p>
    </li>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
