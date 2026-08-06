import { env } from "./env.ts";
import { fetchWithTimeout } from "./dify.ts";

/**
 * Slack のリクエスト署名検証。
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * - 署名は「生のリクエストボディ」に対して計算するので、JSON.parse する前に検証する。
 * - タイムスタンプが 5 分以上ずれていたらリプレイとみなして弾く。
 */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!timestamp || !signature) {
    return { ok: false, reason: "missing signature headers" };
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid timestamp" };

  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > 60 * 5) return { ok: false, reason: "stale timestamp" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );

  const expected = "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return timingSafeEqual(expected, signature)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/** 文字列長でリークしないよう、長さ違いも含め定数時間で比較する */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
  files?: unknown[];
}

/** 取り込み対象のメッセージか判定する */
export function isIngestableMessage(event: SlackMessageEvent): boolean {
  if (event.type !== "message") return false;
  if (event.bot_id) return false;                       // Bot の発言は拾わない（無限ループ防止）
  if (!event.user) return false;
  if (!event.channel) return false;
  if (!event.text || event.text.trim().length === 0) return false;

  // 編集・削除・入退室などの subtype は無視。ファイル添付付き投稿だけ許可する。
  if (event.subtype && event.subtype !== "file_share") return false;

  return true;
}

/** Slack メッセージ本文の記法を素のテキストに寄せる */
export function slackTextToPlain(text: string): string {
  return text
    // <@U123|name> / <@U123> → @name
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id, name) => `@${name ?? id}`)
    // <#C123|general> → #general
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id, name) => `#${name ?? id}`)
    // <https://example.com|表示名> → 表示名 (https://example.com)
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** ダッシュボードから元発言へ飛べるようにパーマリンクを取得する（取れなくても致命的ではない） */
export async function fetchPermalink(
  channel: string,
  messageTs: string,
): Promise<string | null> {
  const token = env("SLACK_BOT_TOKEN");
  if (!token) return null;

  try {
    const url = new URL(`${slackApiBase()}/chat.getPermalink`);
    url.searchParams.set("channel", channel);
    url.searchParams.set("message_ts", messageTs);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    }, 5_000);

    const body = await res.json();
    return body?.ok ? (body.permalink as string) : null;
  } catch (err) {
    console.warn("chat.getPermalink failed:", err);
    return null;
  }
}

/**
 * Slack Web API のベース URL。
 * 既定は本番。SLACK_API_BASE_URL で差し替えられるようにしてあるのは、
 * 社内プロキシ経由にする場合と、テストでスタブに向ける場合のため。
 */
function slackApiBase(): string {
  return env("SLACK_API_BASE_URL") ?? "https://slack.com/api";
}

export interface SlackReactionEvent {
  type: string;
  reaction?: string;
  user?: string;
  item?: { type?: string; channel?: string; ts?: string };
}

/**
 * リアクションが付いた元メッセージを取り出す。
 * 「あとから拾う」経路（📮 を付けてフィードバック扱いにする）で使う。
 * conversations.history に latest=ts, inclusive=true, limit=1 を渡すとその 1 件が返る。
 */
export async function fetchMessage(
  channel: string,
  ts: string,
): Promise<SlackMessageEvent | null> {
  const token = env("SLACK_BOT_TOKEN");
  if (!token) {
    console.warn("SLACK_BOT_TOKEN not set; cannot fetch reacted message");
    return null;
  }

  try {
    const url = new URL(`${slackApiBase()}/conversations.history`);
    url.searchParams.set("channel", channel);
    url.searchParams.set("latest", ts);
    url.searchParams.set("oldest", ts);
    url.searchParams.set("inclusive", "true");
    url.searchParams.set("limit", "1");

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    }, 8_000);

    const body = await res.json();
    if (!body?.ok) {
      console.warn("conversations.history failed:", body?.error);
      return null;
    }

    const message = body.messages?.[0];
    if (!message || message.ts !== ts) return null;

    return { ...message, type: "message", channel } as SlackMessageEvent;
  } catch (err) {
    console.warn("conversations.history error:", err);
    return null;
  }
}

/** 投稿者の表示名を取得する（取れなければ user id のまま） */
export async function fetchUserName(userId: string): Promise<string | null> {
  const token = env("SLACK_BOT_TOKEN");
  if (!token) return null;

  try {
    const url = new URL(`${slackApiBase()}/users.info`);
    url.searchParams.set("user", userId);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    }, 5_000);

    const body = await res.json();
    if (!body?.ok) return null;
    return body.user?.profile?.display_name || body.user?.real_name || null;
  } catch (err) {
    console.warn("users.info failed:", err);
    return null;
  }
}
