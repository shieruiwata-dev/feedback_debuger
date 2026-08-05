import { env, envInt, requireEnv } from "./env.ts";
import { CATEGORIES, type Category, type Classification, PRIORITIES, type Priority } from "./types.ts";

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

  return {
    priority: coerce(obj["priority"], PRIORITIES, "medium") as Priority,
    category: coerce(obj["category"], CATEGORIES, "other") as Category,
    summary: coerceSummary(obj["summary"], rawText),
  };
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
