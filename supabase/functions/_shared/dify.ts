import { env, envInt, requireEnv } from "./env.ts";
import {
  CATEGORIES,
  type Category,
  type Classification,
  type ClassifiedIssue,
  PRIORITIES,
  type Priority,
} from "./types.ts";

const DEFAULT_BASE = "https://api.dify.ai/v1";

/**
 * Dify のワークフロー API を叩いて priority / category / summary を得る。
 *
 * 想定するワークフロー（docs/SETUP.md の step 5 に定義を記載）:
 *   入力変数: feedback_text (paragraph), app_name (text, 任意)
 *   出力変数: result … 下記 JSON を文字列で返す
 *     {"priority":"high","category":"bug","summary":"..."}
 *
 * 出力が `result` 1 本ではなく priority/category/summary の 3 変数に分かれていても
 * 拾えるようにしてある（Dify 側の作り方の揺れを吸収するため）。
 */
export async function classifyWithDify(
  rawText: string,
  appName: string,
): Promise<Classification> {
  const baseUrl = env("DIFY_API_BASE_URL") ?? DEFAULT_BASE;
  const apiKey = requireEnv("DIFY_CLASSIFY_API_KEY");
  const timeoutMs = envInt("DIFY_TIMEOUT_MS", 30_000);

  const res = await fetchWithTimeout(`${baseUrl}/workflows/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: { feedback_text: rawText.slice(0, 8000), app_name: appName },
      response_mode: "blocking",
      user: "feedback-debugger",
    }),
  }, timeoutMs);

  if (!res.ok) {
    throw new Error(`dify classify failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const outputs = body?.data?.outputs ?? {};
  return normalizeClassification(outputs, rawText);
}

function normalizeClassification(
  outputs: Record<string, unknown>,
  rawText: string,
): Classification {
  let obj: Record<string, unknown> = outputs;

  // outputs.result が JSON 文字列のパターン
  const result = outputs["result"] ?? outputs["text"] ?? outputs["output"];
  if (typeof result === "string") {
    const parsed = tryParseJson(result);
    if (parsed) obj = parsed;
  } else if (result && typeof result === "object") {
    obj = result as Record<string, unknown>;
  }

  const issues = coerceIssues(obj["issues"] ?? obj["items"], obj, rawText);

  return {
    // 分割しない場合の代表値。issues の先頭に揃えておく
    priority: issues[0].priority,
    category: issues[0].category,
    summary: issues[0].summary,
    issues,
    // is_feedback を返さない旧ワークフローとの互換のため、既定は true（取りこぼさない側に倒す）
    is_feedback: coerceBool(obj["is_feedback"] ?? obj["isFeedback"], true),
    confidence: coerceConfidence(obj["confidence"] ?? obj["is_feedback_confidence"]),
    noise_reason: coerceReason(obj["noise_reason"] ?? obj["reason"]),
  };
}

/** LLM は true / "true" / "yes" / 1 などを混ぜて返してくる */
function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "はい"].includes(norm)) return true;
    if (["false", "no", "n", "0", "いいえ"].includes(norm)) return false;
  }
  return fallback;
}

/** 確信度。取れなければ 1.0 とみなす（閾値判定で落とされないように） */
function coerceConfidence(value: unknown): number {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number.parseFloat(value)
    : NaN;

  if (!Number.isFinite(n)) return 1;
  // 0〜100 で返してくるモデルもあるので正規化する
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

function coerceReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 300) : null;
}

/**
 * 論点の配列を組み立てる。
 *
 * 1 つの投稿に複数の指摘が混ざっている場合、Dify は issues に複数返してくる。
 * issues を返さない（旧ワークフロー / 論点が 1 つ）の場合は、
 * トップレベルの priority/category/summary から 1 件を組み立てて同じ形に揃える。
 * こうしておくと、呼び出し側は「常に配列」として扱えて分岐が減る。
 */
function coerceIssues(
  raw: unknown,
  fallback: Record<string, unknown>,
  rawText: string,
): ClassifiedIssue[] {
  const single = (): ClassifiedIssue[] => [{
    text: rawText.trim(),
    summary: coerceSummary(fallback["summary"], rawText),
    priority: coerce(fallback["priority"], PRIORITIES, "medium") as Priority,
    category: coerce(fallback["category"], CATEGORIES, "other") as Category,
  }];

  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? (() => {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })()
    : null;

  if (!list || list.length === 0) return single();

  const issues = list
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      // 原文の該当箇所。取れなければ要約で代用する（本文が空になるのを防ぐ）
      text: coerceText(v["text"] ?? v["excerpt"] ?? v["quote"], v["summary"], rawText),
      summary: coerceSummary(v["summary"], rawText),
      priority: coerce(v["priority"], PRIORITIES, "medium") as Priority,
      category: coerce(v["category"], CATEGORIES, "other") as Category,
    }));

  return issues.length > 0 ? issues : single();
}

function coerceText(value: unknown, summary: unknown, rawText: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, 5000);
  }
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim().slice(0, 5000);
  }
  return rawText.trim().slice(0, 5000);
}

/** LLM の出力ゆらぎ（大文字・前後空白・"feature request" 等）を吸収する */
function coerce<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  const norm = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const hit = allowed.find((a) => a === norm);
  return hit ?? fallback;
}

function coerceSummary(value: unknown, rawText: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, 500);
  }
  // 要約が取れなかった場合は原文の先頭で代用する（クラスタ見出しが空になるのを避ける）
  return rawText.trim().slice(0, 200);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    // JSON 以外のテキストが返ってきた場合、最初の {...} を拾ってみる
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** テストからのみ参照する内部関数の公開口 */
export const __testing = { normalizeClassification };

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
