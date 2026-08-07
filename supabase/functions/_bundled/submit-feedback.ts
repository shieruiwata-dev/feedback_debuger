/**
 * submit-feedback — 1 ファイル版（自動生成 / 手で編集しないこと）
 *
 * Supabase ダッシュボードの Edge Functions エディタに貼り付けて使う。
 * 元のソースは supabase/functions/submit-feedback/index.ts と supabase/functions/_shared/ にあり、
 * このファイルは scripts/build-single-file-functions.mjs が生成する。
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// ===========================================================================
// _shared/env.ts
// ===========================================================================
/**
 * 環境変数アクセサ。
 * Edge Function は起動時に env を読むので、モジュールトップで required を呼ばず
 * 各ハンドラ内で解決する（未設定の関数があっても他の関数は動くようにするため）。
 */

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? undefined : v;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

export function envBool(name: string, fallback = false): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envList(name: string): string[] {
  const v = env(name);
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** AI 分類・埋め込み・クラスタリングを走らせるか（実装順序 step 2〜4 では false で運用する） */
export const aiEnrichmentEnabled = () => envBool("ENABLE_AI_ENRICHMENT", false);

// ===========================================================================
// _shared/types.ts
// ===========================================================================
/** 全アダプタが最終的にこの形に正規化してから DB に投げる */
export interface NormalizedFeedback {
  app_id: string;
  source_type: SourceType;
  raw_text: string;
  source_meta: Record<string, unknown>;
  external_id: string | null;
}

export type SourceType = "slack" | "form" | "email";
export type Priority = "urgent" | "high" | "medium" | "low";
export type Category = "bug" | "feature_request" | "ux" | "other";
export type Status =
  | "new" | "reviewing" | "adopted" | "done" | "rejected"
  /** フィードバックではないと判定された */
  | "ignored"
  /** 論点ごとに分割された原文。一覧には出さず、子が実体になる */
  | "split";

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
export const CATEGORIES: Category[] = ["bug", "feature_request", "ux", "other"];

/** 分割後の 1 論点 */
export interface ClassifiedIssue {
  /** 原文から抜き出した該当箇所。取れなければ要約で代用する */
  text: string;
  summary: string;
  priority: Priority;
  category: Category;
  /**
   * 既存クラスタの候補一覧のうち、同じ論点だと LLM が判断した番号（1 始まり）。
   * 該当なしなら null。CLUSTERING_STRATEGY=llm のときだけ使う。
   */
  match: number | null;
}

export interface Classification {
  priority: Priority;
  category: Category;
  summary: string;
  /**
   * 論点ごとの分割結果。
   * 1 件なら分割しない。2 件以上なら feedback_items を分けて作る。
   * Dify が items を返さない場合は、上の priority/category/summary から 1 件を組み立てる。
   */
  issues: ClassifiedIssue[];
  /** フィードバックとして扱うべきか（Slack の雑談・通知を除くための判定） */
  is_feedback: boolean;
  /** is_feedback の確信度 0〜1。低いものはノイズ判定を採用しない */
  confidence: number;
  /** ノイズと判定した理由。ダッシュボードに出して閾値調整の材料にする */
  noise_reason: string | null;
}

export interface IngestResult {
  status: "inserted" | "duplicate" | "ignored" | "restored";
  item_id?: string;
  reason?: string;
}

/** 取り込み元アダプタが判定済みの選別ヒント */
export interface TriageHint {
  /** 明示マーク（#fb / 📮 リアクション）が付いている = AI 判定を飛ばして必ず取り込む */
  forced?: boolean;
  /** 判定の根拠。feedback_items.triage_reason に残す */
  reason?: string;
}

// ===========================================================================
// _shared/http.ts
// ===========================================================================
/**
 * CORS。フォームウィジェットは他ドメインの自社サイトから叩かれるため、
 * FORM_ALLOWED_ORIGINS（カンマ区切り）で許可オリジンを制御する。
 * 未設定なら "*"（開発中の利便性優先。本番では必ず設定すること）。
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = envList("FORM_ALLOWED_ORIGINS");
  let allowOrigin = "*";

  if (allowed.length > 0) {
    allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(req.headers.get("origin")) });
}

/** リクエスト元 IP。Supabase Edge Runtime は x-forwarded-for を付与する。 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * バックグラウンド実行。Edge Runtime の waitUntil があればそれを使い、
 * 無ければ単に fire-and-forget する（レスポンスを待たせないため）。
 */
export function runBackground(task: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } })
    .EdgeRuntime;
  const guarded = task.catch((err) => {
    console.error("background task failed:", err);
  });
  if (runtime?.waitUntil) runtime.waitUntil(guarded);
}

// ===========================================================================
// _shared/dify.ts
// ===========================================================================
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
  /**
   * 既存クラスタの候補一覧（番号付きテキスト）。
   * CLUSTERING_STRATEGY=llm のときに渡す。埋め込み方式のときは空文字で、
   * ワークフロー側は「該当なし」として match: null を返す。
   */
  existingIssues = "",
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
      inputs: {
        feedback_text: rawText.slice(0, 8000),
        app_name: appName,
        existing_issues: existingIssues.slice(0, 8000),
      },
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
    match: coerceMatch(fallback["match"] ?? fallback["match_id"]),
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
      match: coerceMatch(v["match"] ?? v["match_id"] ?? v["existing"]),
    }));

  return issues.length > 0 ? issues : single();
}

/**
 * 既存論点との一致番号。
 * LLM は null / "null" / 0 / "3" などを混ぜて返してくるので正規化する。
 * 数値として読めないものは「該当なし」に倒す（誤った合流は気づきにくいため）。
 */
function coerceMatch(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "" || trimmed === "null" || trimmed === "none" || trimmed === "なし") {
      return null;
    }
    const n = Number.parseInt(trimmed, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
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

// ===========================================================================
// _shared/embeddings.ts
// ===========================================================================
/**
 * 埋め込みベクトル生成。
 *
 * 【なぜ Dify 単独ではないか】
 * Dify は「アプリ（チャット/ワークフロー）実行 API」は公開しているが、
 * 任意テキストをベクトル化する汎用 embeddings エンドポイントは公開していない
 * （埋め込みは Knowledge/RAG の内部処理として使われる）。
 * そのため既定では OpenAI の embeddings API を直接叩く構成にし、
 * Dify のワークフローからベクトル配列を返す運用にも切り替えられるようにしてある。
 *
 * EMBEDDING_PROVIDER:
 *   "openai"        … OpenAI /v1/embeddings（既定, text-embedding-3-small = 1536 次元）
 *   "dify_workflow" … Dify ワークフローの出力 `embedding`（数値配列 or JSON 文字列）
 */
export type EmbeddingProvider = "openai" | "dify_workflow";

export const EMBEDDING_DIMENSIONS = () => envInt("EMBEDDING_DIMENSIONS", 1536);

export async function embedText(text: string): Promise<number[]> {
  const provider = (env("EMBEDDING_PROVIDER") ?? "openai") as EmbeddingProvider;
  const input = text.trim().slice(0, 8000);

  const vector = provider === "dify_workflow"
    ? await embedViaDifyWorkflow(input)
    : await embedViaOpenAI(input);

  const expected = EMBEDDING_DIMENSIONS();
  if (vector.length !== expected) {
    throw new Error(
      `embedding dimension mismatch: got ${vector.length}, expected ${expected}. ` +
        `feedback_items.embedding の vector(N) と EMBEDDING_DIMENSIONS を揃えてください`,
    );
  }
  return vector;
}

async function embedViaOpenAI(input: string): Promise<number[]> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = env("EMBEDDING_MODEL") ?? "text-embedding-3-small";
  const baseUrl = env("OPENAI_API_BASE_URL") ?? "https://api.openai.com/v1";

  const res = await fetchWithTimeout(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input, dimensions: EMBEDDING_DIMENSIONS() }),
  }, envInt("EMBEDDING_TIMEOUT_MS", 20_000));

  if (!res.ok) {
    throw new Error(`openai embeddings failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("openai embeddings: unexpected response shape");
  return vector as number[];
}

async function embedViaDifyWorkflow(input: string): Promise<number[]> {
  const baseUrl = env("DIFY_API_BASE_URL") ?? "https://api.dify.ai/v1";
  const apiKey = requireEnv("DIFY_EMBEDDING_API_KEY");

  const res = await fetchWithTimeout(`${baseUrl}/workflows/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: { feedback_text: input },
      response_mode: "blocking",
      user: "feedback-debugger",
    }),
  }, envInt("EMBEDDING_TIMEOUT_MS", 20_000));

  if (!res.ok) {
    throw new Error(`dify embedding failed: ${res.status} ${await res.text()}`);
  }

  const outputs = (await res.json())?.data?.outputs ?? {};
  const raw = outputs["embedding"] ?? outputs["result"];

  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as number[];
  }
  throw new Error("dify embedding: unexpected output shape (expected number[])");
}

// ===========================================================================
// _shared/supabase.ts
// ===========================================================================
/**
 * service_role クライアント。
 * 取り込みアダプタは RLS を通さずに書き込むため、必ずこちらを使う。
 * ユーザー由来の JWT は載せない（Authorization ヘッダを引き回さない）。
 */
export function serviceClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** slug から app_id を引く */
export async function resolveAppBySlug(
  db: SupabaseClient,
  slug: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db
    .from("apps")
    .select("id, name")
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/** ソース識別子（Slack チャンネル ID 等）から app_id を逆引きする */
export async function resolveAppBySource(
  db: SupabaseClient,
  sourceType: string,
  identifier: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("feedback_sources")
    .select("app_id")
    .eq("source_type", sourceType)
    .ilike("source_identifier", identifier)
    .maybeSingle();

  if (error) throw error;
  return data?.app_id ?? null;
}

// ===========================================================================
// _shared/triage.ts
// ===========================================================================
/**
 * フィードバック選別（トリアージ）
 *
 * Slack のチャンネルにはフィードバック以外の情報も流れてくるため、3 層で選別する。
 *
 *   層 0（このファイル・insert 前・ゼロコスト）
 *     - 明示マーク（"#fb" 等）があれば、以降の判定を全部飛ばして確実に取り込む
 *     - 定型ノイズ（「了解です」「👍」URL だけ 等）は insert せず捨てる
 *   層 1（enrich.ts・insert 後・Dify）
 *     - AI が is_feedback を返す。ノイズなら status='ignored' にして一覧から外す
 *     - 「確信度が閾値以上のときだけ落とす」ので、迷ったものは残る（フェイルオープン）
 *   層 2（人・あとから）
 *     - Slack で 📮 リアクションを付ければ、過去の投稿でも拾い上げられる
 *     - ダッシュボードのノイズ欄から「フィードバックに戻す」で復帰できる
 *
 * 層 0 だけが投げ捨てで不可逆。だから条件は「誰が見てもフィードバックでない」ものに限り、
 * 迷う判定はすべて層 1 に回して DB に残す方針にしている。
 */

export interface NoiseVerdict {
  noise: boolean;
  reason?: string;
}

/** 明示マークの既定値。テキストに含まれていれば無条件で取り込む */
export const defaultMarkers = () => {
  const configured = envList("SLACK_FEEDBACK_MARKERS");
  return configured.length > 0
    ? configured
    : ["#fb", "#feedback", "#フィードバック", "#要望", "#不具合"];
};

/** 明示マークとして扱う絵文字リアクション名（Slack の emoji name。コロンなし） */
export const feedbackReactions = () => {
  const configured = envList("SLACK_FEEDBACK_REACTIONS");
  return configured.length > 0 ? configured : ["inbox_tray", "memo", "mega"];
};

/** AI トリアージを掛けるソース種別。フォームは定義上フィードバックなので既定では掛けない */
export const aiTriageSourceTypes = (): SourceType[] => {
  const configured = envList("AI_TRIAGE_SOURCE_TYPES");
  const list = configured.length > 0 ? configured : ["slack"];
  return list.filter((s): s is SourceType =>
    s === "slack" || s === "form" || s === "email"
  );
};

export const aiTriageEnabled = () => envBool("ENABLE_AI_TRIAGE", true);

export function shouldAiTriage(sourceType: SourceType): boolean {
  return aiTriageEnabled() && aiTriageSourceTypes().includes(sourceType);
}

/**
 * 明示マークを探し、見つかったらテキストから取り除いて返す。
 * マーク自体は本文ではないので、要約や埋め込みに混ぜたくない。
 */
export function extractMarker(
  text: string,
  markers: string[] = defaultMarkers(),
): { marked: boolean; marker?: string; text: string } {
  const lower = text.toLowerCase();

  for (const marker of markers) {
    const idx = lower.indexOf(marker.toLowerCase());
    if (idx === -1) continue;

    const stripped = (text.slice(0, idx) + text.slice(idx + marker.length))
      .replace(/\s{2,}/g, " ")
      .trim();

    // マークを消したら何も残らない場合は原文を残す（"#fb" だけの投稿）
    return { marked: true, marker, text: stripped.length > 0 ? stripped : text.trim() };
  }

  return { marked: false, text };
}

/** ノイズ判定のためにメンション・URL・装飾を落とした「中身」を取り出す */
export function coreContent(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[^\s]+/g, " ")
    .replace(/#[^\s]+/g, " ")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

/** 相槌・定型返事だけの投稿（本文が実質ゼロ） */
const ACK_PATTERN =
  /^(?:了解|了解です|承知|承知しました|把握|把握しました|確認|確認します|確認しました|対応します|対応しました|完了|完了です|なるほど|同じく|わかりました|分かりました|ありがとう|ありがとうございます|ありがとうございました|感謝|助かります|助かりました|お疲れ|お疲れです|お疲れ様|お疲れ様です|おつ|よろしく|よろしくお願いします|お願いします|ok|okay|lgtm|sgtm|nice|good|great|thanks|thank you|thx|done|fyi|同上|以上|はい|いいえ)$/i;

export interface NoiseOptions {
  /** 中身がこの文字数未満なら情報量が無いとみなす */
  minLength?: number;
  /** 追加のノイズ判定正規表現（NOISE_PATTERNS で設定） */
  extraPatterns?: RegExp[];
}

/**
 * insert 前に落とす「誰が見てもフィードバックでない」投稿の判定。
 * 判断に迷う余地があるものはここでは落とさず、AI トリアージ（層 1）に回す。
 */
export function looksLikeNoise(
  text: string,
  options: NoiseOptions = {},
): NoiseVerdict {
  const minLength = options.minLength ?? envInt("NOISE_MIN_LENGTH", 6);
  const patterns = options.extraPatterns ?? configuredNoisePatterns();

  const trimmed = text.trim();
  if (trimmed.length === 0) return { noise: true, reason: "empty" };

  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return { noise: true, reason: `matched_pattern:${pattern.source.slice(0, 40)}` };
    }
  }

  const core = coreContent(trimmed);

  if (core.length === 0) {
    // URL だけ / 絵文字だけ / メンションだけ
    if (/https?:\/\//.test(trimmed)) return { noise: true, reason: "url_only" };
    return { noise: true, reason: "no_text_content" };
  }

  if (ACK_PATTERN.test(core.replace(/\s+/g, ""))) {
    return { noise: true, reason: "acknowledgement" };
  }

  if (core.replace(/\s+/g, "").length < minLength) {
    return { noise: true, reason: "too_short" };
  }

  return { noise: false };
}

/**
 * NOISE_PATTERNS に設定した正規表現。
 * 自動投稿の定型文（デプロイ通知、CI の結果、監視アラート等）を落とすのに使う。
 *   NOISE_PATTERNS='^\[Deploy\],^Build #\d+,^\[ALERT\]'
 */
function configuredNoisePatterns(): RegExp[] {
  return envList("NOISE_PATTERNS").flatMap((source) => {
    try {
      return [new RegExp(source, "i")];
    } catch {
      console.warn(`invalid NOISE_PATTERNS entry, ignored: ${source}`);
      return [];
    }
  });
}

/** AI がノイズと言っても、この確信度未満なら残す（取りこぼしを避けるため） */
export function minTriageConfidence(fallback = 0.7): number {
  const raw = env("AI_TRIAGE_MIN_CONFIDENCE");
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// ===========================================================================
// _shared/clustering.ts
// ===========================================================================
/**
 * クラスタリング方式の切り替え。
 *
 *   embedding … 要約をベクトル化し、pgvector の最近傍で合流先を決める（従来）
 *   llm       … 既存クラスタの要約一覧を LLM に見せて、同じ論点かを判断させる
 *
 * llm 方式は埋め込み API を持たない環境（Dify だけで完結させたい場合）向け。
 * 照合は分類と同じ Dify 呼び出しに同居させるので、API 呼び出し回数は増えない。
 *
 * 既定は、埋め込みの鍵があれば embedding、無ければ llm。
 * 設定漏れで黙って壊れるより、動く方に倒す。
 */
export type ClusteringStrategy = "embedding" | "llm";

export function clusteringStrategy(): ClusteringStrategy {
  const explicit = env("CLUSTERING_STRATEGY");
  if (explicit === "embedding" || explicit === "llm") return explicit;
  return env("OPENAI_API_KEY") ? "embedding" : "llm";
}

export interface CandidateCluster {
  cluster_id: string;
  summary: string;
  item_count: number;
}

/**
 * LLM に突き合わせさせる既存クラスタを取ってくる。
 * 全件を渡すとクラスタが増えるほどプロンプトが膨らむので、Postgres 側で絞る。
 */
export async function fetchCandidates(
  db: SupabaseClient,
  appId: string,
  query: string,
): Promise<CandidateCluster[]> {
  const { data, error } = await db.rpc("candidate_clusters", {
    p_app_id: appId,
    p_query: query.slice(0, 500),
    p_limit: envInt("LLM_CLUSTER_CANDIDATES", 40),
  });

  if (error) {
    // 候補が取れなくても取り込みは続ける。全部が新規クラスタになるだけで、データは失わない
    console.error("candidate_clusters failed, continuing without candidates:", error.message);
    return [];
  }

  return (data ?? []) as CandidateCluster[];
}

/**
 * 候補を LLM に渡すテキストにする。
 *
 *   1. 検索の応答が遅い（12件）
 *   2. 申請履歴のCSVエクスポート（8件）
 *
 * 番号で答えさせるのは、UUID を書き写させると誤りが混ざるため。
 * 件数を添えるのは、大きなクラスタへの合流を選びやすくする手がかりになるため。
 */
export function formatCandidates(candidates: CandidateCluster[]): string {
  if (candidates.length === 0) return "（まだ登録された論点はありません）";

  return candidates
    .map((c, i) => `${i + 1}. ${c.summary}（${c.item_count}件）`)
    .join("\n");
}

/**
 * LLM が返した番号を cluster_id に戻す。
 *
 * 範囲外の番号や欠番は「該当なし」として扱う。
 * 存在しないクラスタに紐付けるより、新規クラスタを作る方が実害が小さい
 * （後から人手で束ねられるが、誤った合流は気づきにくい）。
 */
export function resolveMatch(
  match: number | null,
  candidates: CandidateCluster[],
): string | null {
  if (match === null || !Number.isInteger(match)) return null;
  if (match < 1 || match > candidates.length) {
    console.warn(`llm returned out-of-range match: ${match} (candidates=${candidates.length})`);
    return null;
  }
  return candidates[match - 1].cluster_id;
}

// ===========================================================================
// _shared/spam.ts
// ===========================================================================
/**
 * スパム対策レイヤー。
 * 現時点で有効なのは (1) レートリミット と (2) ハニーポット。
 * CAPTCHA は本タスクの範囲外だが、あとから差し込めるように検証インターフェースだけ用意し、
 * 環境変数 CAPTCHA_PROVIDER をセットすれば有効化される形にしてある。
 */

export interface SpamCheckResult {
  ok: boolean;
  reason?: string;
  /** 利用者にはスパム判定であることを悟らせず、成功として返したい場合に立てる */
  silentDrop?: boolean;
}

/**
 * IP + アプリ単位のレートリミット。
 * Postgres の check_rate_limit() で数えるので、追加インフラ（Redis 等）は不要。
 * 既定: 同一 IP から 60 秒に 5 件、1 時間に 30 件。
 */
export async function checkRateLimit(
  db: SupabaseClient,
  ip: string,
  appSlug: string,
): Promise<SpamCheckResult> {
  const windows: Array<{ key: string; seconds: number; max: number }> = [
    {
      key: `form:${appSlug}:ip:${ip}:short`,
      seconds: envInt("FORM_RATE_LIMIT_SHORT_WINDOW_SEC", 60),
      max: envInt("FORM_RATE_LIMIT_SHORT_MAX", 5),
    },
    {
      key: `form:${appSlug}:ip:${ip}:long`,
      seconds: envInt("FORM_RATE_LIMIT_LONG_WINDOW_SEC", 3600),
      max: envInt("FORM_RATE_LIMIT_LONG_MAX", 30),
    },
  ];

  for (const w of windows) {
    const { data, error } = await db.rpc("check_rate_limit", {
      p_bucket_key: w.key,
      p_window_seconds: w.seconds,
      p_max_hits: w.max,
    });

    if (error) {
      // レートリミッタが落ちても投稿自体は通す（可用性優先）。ログには残す。
      console.error("check_rate_limit failed, allowing request:", error.message);
      return { ok: true };
    }

    if (data === false) {
      return { ok: false, reason: "rate_limited" };
    }
  }

  return { ok: true };
}

/**
 * ハニーポット。ウィジェットが視覚的に隠しフィールド `_hp` を出し、
 * 人間は空のまま送るが、素朴なボットは埋めてしまう。
 * 埋まっていた場合は 200 を返しつつ捨てる（ボットに検知を悟らせない）。
 */
export function checkHoneypot(body: Record<string, unknown>): SpamCheckResult {
  const hp = body["_hp"];
  if (typeof hp === "string" && hp.trim().length > 0) {
    return { ok: false, reason: "honeypot", silentDrop: true };
  }
  return { ok: true };
}

/**
 * CAPTCHA 検証（拡張ポイント）。
 * CAPTCHA_PROVIDER 未設定なら常に ok。設定時のみトークン検証を行う。
 *   CAPTCHA_PROVIDER=turnstile  + CAPTCHA_SECRET_KEY
 *   CAPTCHA_PROVIDER=recaptcha  + CAPTCHA_SECRET_KEY
 */
export async function checkCaptcha(
  token: unknown,
  ip: string,
): Promise<SpamCheckResult> {
  const provider = env("CAPTCHA_PROVIDER");
  if (!provider) return { ok: true };

  const secret = env("CAPTCHA_SECRET_KEY");
  if (!secret) {
    console.error("CAPTCHA_PROVIDER set but CAPTCHA_SECRET_KEY missing");
    return { ok: true };
  }

  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "captcha_missing" };
  }

  const endpoint = provider === "recaptcha"
    ? "https://www.google.com/recaptcha/api/siteverify"
    : "https://challenges.cloudflare.com/turnstile/v0/siteverify";

  try {
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    form.set("remoteip", ip);

    const res = await fetchWithTimeout(endpoint, { method: "POST", body: form }, 8_000);
    const body = await res.json();
    return body?.success ? { ok: true } : { ok: false, reason: "captcha_failed" };
  } catch (err) {
    console.error("captcha verification error:", err);
    return { ok: false, reason: "captcha_error" };
  }
}

// ===========================================================================
// _shared/enrich.ts
// ===========================================================================
export interface EnrichResult {
  item_id: string;
  status: "done" | "failed" | "ignored" | "split";
  cluster_id?: string | null;
  /** 分割した場合の子の件数 */
  split_into?: number;
  error?: string;
}

/**
 * 1 件の feedback_item を仕上げる。
 *
 *   1. Dify で分類（priority / category / summary / is_feedback / issues）
 *   2. フィードバックでないと判定されたら status='ignored' にして打ち切る
 *   3. 論点が 2 つ以上なら、論点ごとの子 item に分割して各子を仕上げる
 *   4. 埋め込みを生成する
 *   5. assign_item_to_cluster() でクラスタ紐付け + スコア再計算
 *
 * 分割で作られた子は分類済み（親の 1 回の Dify 呼び出しの結果を持つ）なので、
 * 子に対してこの関数を呼んでも分類はやり直さず 4 以降だけを行う。
 * Dify の呼び出しは投稿 1 件につき 1 回のままに保たれる。
 */
export async function enrichItem(
  db: SupabaseClient,
  itemId: string,
): Promise<EnrichResult> {
  const { data: item, error: loadError } = await db
    .from("feedback_items")
    .select(
      "id, app_id, source_type, raw_text, summary, priority, category, is_feedback, triage_reason, parent_item_id, apps(name)",
    )
    .eq("id", itemId)
    .single();

  if (loadError) throw loadError;

  await db.from("feedback_items")
    .update({ processing_state: "processing", processing_error: null })
    .eq("id", itemId);

  const rawText = item.raw_text as string;

  // 分割で生まれた子は分類済み。ここを飛ばしてクラスタリングへ直行する。
  // llm 方式の子は親の処理内で既にクラスタへ載っているので、再処理で来た分だけがここに来る。
  if (isPreClassified(item)) {
    if (clusteringStrategy() === "llm") {
      return await matchAndCluster(
        db,
        itemId,
        item.app_id as string,
        item.summary as string,
        (item.priority as string) ?? "",
      );
    }
    return await embedAndCluster(db, itemId, rawText, item.summary as string | null);
  }

  const appName = (item as { apps?: { name?: string } }).apps?.name ?? "";
  const sourceType = item.source_type as SourceType;
  // 明示マーク済み（#fb / 📮 リアクション / 人手で復帰）は AI 判定で落とさない
  const forced = item.is_feedback === true;

  // --- 1. 分類（llm 方式では既存クラスタとの突き合わせも同じ呼び出しで行う）----
  const strategy = clusteringStrategy();
  let candidates: CandidateCluster[] = [];
  if (strategy === "llm") {
    candidates = await fetchCandidates(db, item.app_id as string, rawText);
  }

  let classification;
  try {
    classification = await classifyWithDify(
      rawText,
      appName,
      strategy === "llm" ? formatCandidates(candidates) : "",
    );
  } catch (err) {
    return await markFailed(db, itemId, `classify: ${errorMessage(err)}`);
  }

  // --- 2. トリアージ -------------------------------------------------------
  const triageApplies = !forced && shouldAiTriage(sourceType);
  const threshold = await resolveThreshold(db);
  const confidentlyNoise = !classification.is_feedback &&
    classification.confidence >= threshold;

  if (triageApplies && confidentlyNoise) {
    // 要約と分類は保存しておく（ノイズ欄で内容を確認して復帰判断できるようにする）
    await db.from("feedback_items").update({
      summary: classification.summary,
      priority: classification.priority,
      category: classification.category,
    }).eq("id", itemId);

    const reason = `ai:${classification.noise_reason ?? "フィードバックではないと判定"}`;
    const { error } = await db.rpc("mark_item_as_noise", {
      p_item_id: itemId,
      p_reason: reason,
      p_confidence: classification.confidence,
    });

    if (error) return await markFailed(db, itemId, `triage: ${error.message}`);

    console.info(`item ${itemId} marked as noise: ${reason}`);
    return { item_id: itemId, status: "ignored" };
  }

  // --- 3. 論点が複数あれば分割 ---------------------------------------------
  if (classification.issues.length > 1) {
    return await splitAndEnrich(db, itemId, classification.issues, candidates);
  }

  // --- 4-5. 単一論点はその場で仕上げる -------------------------------------
  const update: Record<string, unknown> = {
    summary: classification.summary,
    priority: classification.priority,
    category: classification.category,
    is_feedback: true,
  };

  if (!forced) {
    update.triage_confidence = classification.confidence;
    update.triage_reason = classification.is_feedback
      ? "ai:feedback"
      // ノイズ寄りだが確信度が閾値未満で残したケース。閾値調整の材料になる
      : `ai_low_confidence:${classification.noise_reason ?? "判定不能"}`;
  }

  const { error: updateError } = await db
    .from("feedback_items").update(update).eq("id", itemId);
  if (updateError) {
    return await markFailed(db, itemId, `update: ${updateError.message}`);
  }

  if (strategy === "llm") {
    const clusterId = resolveMatch(classification.issues[0].match, candidates);
    return await attachAndFinish(db, itemId, clusterId);
  }

  return await embedAndCluster(db, itemId, rawText, classification.summary);
}

/**
 * 論点ごとに子 item を作り、それぞれを仕上げる。
 * 親は status='split' になって一覧から外れる（原文は残る）。
 */
async function splitAndEnrich(
  db: SupabaseClient,
  parentId: string,
  issues: ClassifiedIssue[],
  candidates: CandidateCluster[],
): Promise<EnrichResult> {
  const { data: children, error } = await db.rpc("split_feedback_item", {
    p_parent_id: parentId,
    p_segments: issues.map((i) => ({
      text: i.text,
      summary: i.summary,
      priority: i.priority,
      category: i.category,
    })),
  });

  if (error) return await markFailed(db, parentId, `split: ${error.message}`);

  const rows = (children ?? []) as Array<{ id: string }>;
  console.info(`item ${parentId} split into ${rows.length} issues`);

  // 子はクラスタリングまで進める。1 件失敗しても他は続行する
  // （失敗した子は processing_state='failed' で残り、再処理バッチが拾う）
  const strategy = clusteringStrategy();
  for (const [i, child] of rows.entries()) {
    try {
      if (strategy === "llm") {
        // 親の 1 回の分類で得た突き合わせ結果をそのまま使う。子ごとに Dify を呼び直さない
        const clusterId = resolveMatch(issues[i]?.match ?? null, candidates);
        await attachAndFinish(db, child.id, clusterId);
      } else {
        await enrichItem(db, child.id);
      }
    } catch (err) {
      console.error(`child ${child.id} enrichment failed:`, err);
    }
  }

  return { item_id: parentId, status: "split", split_into: rows.length };
}

/**
 * 埋め込みを作ってクラスタに載せる。
 *
 * ベクトル化するのは既定で「要約」。
 * 同じ内容が違う言い回しで届いたときにまとめたいので、
 * 前置きや敬語や周辺文脈が混ざった原文より、
 * 論点だけに正規化された要約の方が距離が安定する。
 * EMBEDDING_SOURCE=raw_text にすれば原文を使う挙動に戻せる。
 */
async function embedAndCluster(
  db: SupabaseClient,
  itemId: string,
  rawText: string,
  summary: string | null,
): Promise<EnrichResult> {
  const useSummary = (env("EMBEDDING_SOURCE") ?? "summary") === "summary";
  const target = useSummary && summary && summary.trim().length > 0 ? summary : rawText;

  let embedding: number[];
  try {
    embedding = await embedText(target);
  } catch (err) {
    return await markFailed(db, itemId, `embedding: ${errorMessage(err)}`);
  }

  const { error: updateError } = await db.from("feedback_items")
    // pgvector は文字列リテラル "[0.1,0.2,...]" 形式を受け付ける
    .update({ embedding: JSON.stringify(embedding) })
    .eq("id", itemId);

  if (updateError) {
    return await markFailed(db, itemId, `update: ${updateError.message}`);
  }

  const { data: clusterId, error: clusterError } = await db
    .rpc("assign_item_to_cluster", { p_item_id: itemId });

  if (clusterError) {
    return await markFailed(db, itemId, `cluster: ${clusterError.message}`);
  }

  await db.from("feedback_items").update({
    processing_state: "done",
    processing_error: null,
    processed_at: new Date().toISOString(),
  }).eq("id", itemId);

  return { item_id: itemId, status: "done", cluster_id: clusterId as string | null };
}

/**
 * 再処理で来た「分類済みだがクラスタ未割り当て」の item を、
 * 既存クラスタと突き合わせて載せる（llm 方式）。
 * 分類はやり直さず、突き合わせだけを Dify に聞く。
 */
async function matchAndCluster(
  db: SupabaseClient,
  itemId: string,
  appId: string,
  summary: string,
  _priority: string,
): Promise<EnrichResult> {
  const candidates = await fetchCandidates(db, appId, summary);

  // 候補が無ければ問い合わせるまでもなく新規クラスタ
  if (candidates.length === 0) {
    return await attachAndFinish(db, itemId, null);
  }

  let match: number | null = null;
  try {
    const result = await classifyWithDify(summary, "", formatCandidates(candidates));
    match = result.issues[0]?.match ?? null;
  } catch (err) {
    return await markFailed(db, itemId, `match: ${errorMessage(err)}`);
  }

  return await attachAndFinish(db, itemId, resolveMatch(match, candidates));
}

/** クラスタに載せて処理済みにする（埋め込みを使わない経路） */
async function attachAndFinish(
  db: SupabaseClient,
  itemId: string,
  clusterId: string | null,
): Promise<EnrichResult> {
  const { data, error } = await db.rpc("attach_item_to_cluster", {
    p_item_id: itemId,
    p_cluster_id: clusterId,
  });

  if (error) return await markFailed(db, itemId, `cluster: ${error.message}`);

  await db.from("feedback_items").update({
    processing_state: "done",
    processing_error: null,
    processed_at: new Date().toISOString(),
  }).eq("id", itemId);

  return { item_id: itemId, status: "done", cluster_id: data as string | null };
}

/** 分割で作られた子（分類済み）かどうか */
function isPreClassified(item: Record<string, unknown>): boolean {
  return item.parent_item_id !== null &&
    typeof item.summary === "string" &&
    typeof item.priority === "string" &&
    typeof item.category === "string";
}

/**
 * ノイズ判定を採用する確信度の下限。
 * app_settings を優先し、無ければ環境変数 → 既定値 0.7。
 * SQL 1 文で運用中に変えられるようにしてある。
 */
async function resolveThreshold(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "triage.min_confidence")
    .maybeSingle();

  if (error || data?.value === undefined || data?.value === null) {
    return minTriageConfidence();
  }

  const n = typeof data.value === "number"
    ? data.value
    : Number.parseFloat(String(data.value));

  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : minTriageConfidence();
}

async function markFailed(
  db: SupabaseClient,
  itemId: string,
  message: string,
): Promise<EnrichResult> {
  await db.from("feedback_items").update({
    processing_state: "failed",
    processing_error: message.slice(0, 1000),
  }).eq("id", itemId);

  console.error(`enrich failed for ${itemId}: ${message}`);
  return { item_id: itemId, status: "failed", error: message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// _shared/ingest.ts
// ===========================================================================
/**
 * 正規化済みフィードバックを 1 件取り込む。全アダプタ共通の入口。
 *
 * - 明示マーク（#fb / 📮 リアクション）が付いていれば選別を全部飛ばして取り込む
 * - 定型ノイズ（相槌・URL だけ・自動通知の定型文）は insert せずに捨てる
 * - external_id による重複排除（Slack のリトライ対策）
 * - ENABLE_AI_ENRICHMENT が false の間は「受信→正規化→そのまま insert」だけで止まる
 * - true なら分類 / トリアージ / 埋め込み / クラスタリングをバックグラウンドで走らせる。
 *   Slack Events API は 3 秒以内の 200 応答を要求するため、同期では実行しない。
 */
export async function ingestFeedback(
  db: SupabaseClient,
  payload: NormalizedFeedback,
  hint: TriageHint = {},
): Promise<IngestResult> {
  const text = payload.raw_text.trim();
  if (text.length === 0) {
    return { status: "ignored", reason: "empty_text" };
  }

  // --- 層 0: insert 前の選別 ------------------------------------------------
  // 明示マークがあれば無条件で通す
  if (!hint.forced && preInsertFilterEnabled(payload.source_type)) {
    const verdict = looksLikeNoise(text);
    if (verdict.noise) {
      console.info(`dropped before insert (${verdict.reason}): ${text.slice(0, 60)}`);
      return { status: "ignored", reason: `heuristic:${verdict.reason}` };
    }
  }

  const { data, error } = await db
    .from("feedback_items")
    .insert({
      app_id: payload.app_id,
      source_type: payload.source_type,
      raw_text: text,
      source_meta: payload.source_meta,
      external_id: payload.external_id,
      processing_state: aiEnrichmentEnabled() ? "pending" : "skipped",
      // 明示マーク済みは AI トリアージの対象外にする（enrich.ts がこの値を見る）
      is_feedback: hint.forced ? true : null,
      triage_reason: hint.reason ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation → external_id が既に取り込み済み
    if (error.code === "23505") {
      // 明示マークが後から付いた場合は、既存行を復帰させる（📮 の付け直し経路）
      if (hint.forced && payload.external_id) {
        return await restoreExisting(db, payload, hint);
      }
      return { status: "duplicate", reason: "external_id_exists" };
    }
    throw error;
  }

  const itemId = data.id as string;

  if (aiEnrichmentEnabled()) {
    runBackground(enrichItem(db, itemId));
  }

  return { status: "inserted", item_id: itemId };
}

/**
 * 既に取り込み済みの item に明示マークが付いたときの処理。
 * ノイズ判定で外していたものを一覧に戻し、再エンリッチメントの対象にする。
 */
async function restoreExisting(
  db: SupabaseClient,
  payload: NormalizedFeedback,
  hint: TriageHint,
): Promise<IngestResult> {
  const { data: existing, error } = await db
    .from("feedback_items")
    .select("id, status")
    .eq("source_type", payload.source_type)
    .eq("external_id", payload.external_id!)
    .maybeSingle();

  if (error || !existing) {
    return { status: "duplicate", reason: "external_id_exists" };
  }

  const itemId = existing.id as string;

  // ノイズ判定されていなければ触らない（トリアージ済みの正常な重複）
  if (existing.status !== "ignored") {
    return { status: "duplicate", item_id: itemId, reason: "already_visible" };
  }

  const { error: restoreError } = await db
    .rpc("restore_feedback_item", { p_item_id: itemId });

  if (restoreError) throw restoreError;

  await db.from("feedback_items")
    .update({ triage_reason: hint.reason ?? "manual_restore" })
    .eq("id", itemId);

  if (aiEnrichmentEnabled()) {
    runBackground(enrichItem(db, itemId));
  }

  return { status: "restored", item_id: itemId };
}

/**
 * insert 前フィルタを掛けるソース種別。
 * フォームは「意見を書くための入力欄」なので、短い投稿でも捨てない。
 */
function preInsertFilterEnabled(sourceType: string): boolean {
  if (!envBool("ENABLE_PREINSERT_NOISE_FILTER", true)) return false;
  return sourceType === "slack";
}

// ===========================================================================
// submit-feedback/index.ts
// ===========================================================================
/**
 * フィードバックフォーム受信アダプタ（公開エンドポイント）
 *
 * エンドポイント: POST /functions/v1/submit-feedback
 *
 * リクエスト:
 *   {
 *     "app_slug":  "mysupport",       // 必須。apps.slug
 *     "message":   "……",              // 必須。本文
 *     "email":     "user@example.com",// 任意。返信先
 *     "page_url":  "https://…",       // 任意。送信元ページ
 *     "metadata":  { ... },           // 任意。アプリ側が付けたい任意情報
 *     "_hp":       "",                // ハニーポット（人間は空）
 *     "captcha_token": "…"            // CAPTCHA 有効時のみ
 *   }
 *
 * レスポンス: { "ok": true, "status": "inserted" | "duplicate" }
 *
 * 公開エンドポイントなので JWT 検証は無効でデプロイする:
 *   supabase functions deploy submit-feedback --no-verify-jwt
 */

const MAX_MESSAGE_LENGTH = 5000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const headers = corsHeaders(req.headers.get("origin"));

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, { status: 400, headers });
  }

  const appSlug = typeof body.app_slug === "string" ? body.app_slug.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!appSlug) {
    return json({ error: "app_slug is required" }, { status: 400, headers });
  }
  if (!message) {
    return json({ error: "message is required" }, { status: 400, headers });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return json(
      { error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer` },
      { status: 400, headers },
    );
  }

  // ハニーポットは DB を触る前に判定する（ボットに DB 負荷をかけない）
  const honeypot = checkHoneypot(body);
  if (!honeypot.ok) {
    console.info("dropped by honeypot");
    return json({ ok: true, status: "inserted" }, { headers });
  }

  const ip = clientIp(req);
  const db = serviceClient();

  const rate = await checkRateLimit(db, ip, appSlug);
  if (!rate.ok) {
    return json(
      { error: "too many requests", retry_after: 60 },
      { status: 429, headers: { ...headers, "Retry-After": "60" } },
    );
  }

  const captcha = await checkCaptcha(body.captcha_token, ip);
  if (!captcha.ok) {
    return json({ error: "captcha verification failed" }, { status: 400, headers });
  }

  const app = await resolveAppBySlug(db, appSlug);
  if (!app) {
    return json({ error: "unknown app_slug" }, { status: 404, headers });
  }

  const result = await ingestFeedback(db, {
    app_id: app.id,
    source_type: "form",
    raw_text: message,
    // フォームには Slack の message_ts のような自然キーが無いので、こちらで採番する。
    // 同一内容の連投は別件として扱う（意図的な重複投稿もありうるため）。
    external_id: `form:${crypto.randomUUID()}`,
    source_meta: {
      submitter_email: typeof body.email === "string" ? body.email.slice(0, 320) : null,
      page_url: typeof body.page_url === "string" ? body.page_url.slice(0, 2000) : null,
      user_agent: req.headers.get("user-agent"),
      referer: req.headers.get("referer"),
      client_metadata: isPlainObject(body.metadata) ? body.metadata : {},
    },
  });

  if (result.status === "ignored") {
    return json({ error: result.reason ?? "ignored" }, { status: 400, headers });
  }

  return json({ ok: true, status: result.status }, { headers });
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
