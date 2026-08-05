import { SourceIcon } from "./Badges";
import type { FeedbackItem } from "../lib/types";

/** source_meta は jsonb なので、表示に使う値は型を確かめてから取り出す */
function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function ItemRow({ item }: { item: FeedbackItem }) {
  const permalink = str(item.source_meta, "permalink");
  const slackUser = str(item.source_meta, "slack_user_name") ??
    str(item.source_meta, "slack_user_id");
  const email = str(item.source_meta, "submitter_email");
  const pageUrl = str(item.source_meta, "page_url");

  return (
    <li className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <SourceIcon value={item.source_type} />
        <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
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
