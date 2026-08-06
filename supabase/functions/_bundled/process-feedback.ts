/**
 * process-feedback — 1 ファイル版（自動生成 / 手で編集しないこと）
 *
 * Supabase ダッシュボードの Edge Functions エディタに貼り付けて使う。
 * 元のソースは supabase/functions/process-feedback/index.ts と supabase/functions/_shared/ にあり、
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
export type Status = "new" | "reviewing" | "adopted" | "done" | "rejected" | "ignored";

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
export const CATEGORIES: Category[] = ["bug", "feature_request", "ux", "other"];

export interface Classification {
  priority: Priority;
  category: Category;
  summary: string;
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
// _shared/enrich.ts
// ===========================================================================
export interface EnrichResult {
  item_id: string;
  status: "done" | "failed" | "ignored";
  cluster_id?: string | null;
  error?: string;
}

/**
 * 1 件の feedback_item を仕上げる。
 *
 *   1. Dify で分類（priority / category / summary / is_feedback / confidence）
 *   2. フィードバックでないと判定されたら status='ignored' にして打ち切る
 *   3. 埋め込みを生成する
 *   4. assign_item_to_cluster() でクラスタ紐付け + スコア再計算
 *
 * 分類と埋め込みは以前は並列に投げていたが、トリアージを入れたので直列にした。
 * ノイズと分かった時点で打ち切れば、そのぶんの埋め込み API 呼び出しがまるごと不要になる。
 * 雑多なチャンネルではノイズの方が多数になるため、直列化の遅延より節約が効く
 * （どちらもバックグラウンド実行なのでユーザー体験には影響しない）。
 */
export async function enrichItem(
  db: SupabaseClient,
  itemId: string,
): Promise<EnrichResult> {
  const { data: item, error: loadError } = await db
    .from("feedback_items")
    .select(
      "id, app_id, source_type, raw_text, is_feedback, triage_reason, apps(name)",
    )
    .eq("id", itemId)
    .single();

  if (loadError) throw loadError;

  await db.from("feedback_items")
    .update({ processing_state: "processing", processing_error: null })
    .eq("id", itemId);

  const appName = (item as { apps?: { name?: string } }).apps?.name ?? "";
  const rawText = item.raw_text as string;
  const sourceType = item.source_type as SourceType;
  // 明示マーク済み（#fb / 📮 リアクション / 人手で復帰）は AI 判定で落とさない
  const forced = item.is_feedback === true;

  // --- 1. 分類 -------------------------------------------------------------
  let classification;
  try {
    classification = await classifyWithDify(rawText, appName);
  } catch (err) {
    return await markFailed(db, itemId, `classify: ${errorMessage(err)}`);
  }

  const update: Record<string, unknown> = {
    summary: classification.summary,
    priority: classification.priority,
    category: classification.category,
  };

  // --- 2. トリアージ -------------------------------------------------------
  const triageApplies = !forced && shouldAiTriage(sourceType);
  const threshold = await resolveThreshold(db);
  const confidentlyNoise = !classification.is_feedback &&
    classification.confidence >= threshold;

  if (triageApplies && confidentlyNoise) {
    // 要約と分類は保存しておく（ノイズ欄で内容を確認して復帰判断できるようにする）
    await db.from("feedback_items").update(update).eq("id", itemId);

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

  // フィードバックと判定された（または判定を飛ばした）ことを記録する
  update.is_feedback = true;
  if (!forced) {
    update.triage_confidence = classification.confidence;
    update.triage_reason = classification.is_feedback
      ? "ai:feedback"
      // ノイズ寄りだが確信度が閾値未満で残したケース。閾値調整の材料になる
      : `ai_low_confidence:${classification.noise_reason ?? "判定不能"}`;
  }

  // --- 3. 埋め込み ---------------------------------------------------------
  try {
    // pgvector は文字列リテラル "[0.1,0.2,...]" 形式を受け付ける
    update.embedding = JSON.stringify(await embedText(rawText));
  } catch (err) {
    await db.from("feedback_items").update(update).eq("id", itemId);
    return await markFailed(db, itemId, `embedding: ${errorMessage(err)}`);
  }

  const { error: updateError } = await db
    .from("feedback_items").update(update).eq("id", itemId);
  if (updateError) {
    return await markFailed(db, itemId, `update: ${updateError.message}`);
  }

  // --- 4. クラスタリング ---------------------------------------------------
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
// process-feedback/index.ts
// ===========================================================================
/**
 * AI エンリッチメントの実行 / 再実行
 *
 * エンドポイント: POST /functions/v1/process-feedback
 *   { "item_id": "<uuid>" }                      … 単体を処理
 *   { "mode": "pending", "limit": 20 }           … pending/failed を古い順にまとめて処理
 *   { "mode": "rescore", "app_id": "<uuid>" }    … スコアだけ再計算（重み変更後などに使う）
 *
 * 通常の取り込み経路では ingest.ts がバックグラウンドで enrichItem() を呼ぶので、
 * この関数は「Dify 障害でこぼれた分の回収」と「設定変更後の一括再計算」が主用途。
 * pg_cron から数分おきに mode=pending で叩く運用を想定している（docs/SETUP.md 参照）。
 *
 * JWT 検証は有効のままデプロイし、service_role キーで呼び出すこと。
 */

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, { status: 400 });
  }

  const db = serviceClient();

  try {
    if (typeof body.item_id === "string") {
      const result = await enrichItem(db, body.item_id);
      return json({ ok: result.status !== "failed", results: [result] });
    }

    if (body.mode === "rescore") {
      const appIds = typeof body.app_id === "string"
        ? [body.app_id]
        : await allAppIds(db);

      for (const appId of appIds) {
        const { error } = await db.rpc("recalculate_app_scores", { p_app_id: appId });
        if (error) throw error;
      }
      return json({ ok: true, rescored_apps: appIds.length });
    }

    // 既定: pending / failed の回収
    const limit = Math.min(
      typeof body.limit === "number" ? body.limit : envInt("REPROCESS_BATCH_SIZE", 20),
      100,
    );

    const { data: items, error } = await db
      .from("feedback_items")
      .select("id")
      .in("processing_state", ["pending", "failed"])
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw error;

    const results = [];
    for (const item of items ?? []) {
      // Dify / 埋め込み API のレート制限を踏まないよう直列に回す
      try {
        results.push(await enrichItem(db, item.id as string));
      } catch (err) {
        results.push({
          item_id: item.id as string,
          status: "failed" as const,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return json({
      ok: true,
      processed: results.length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (err) {
    console.error("process-feedback error:", err);
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});

async function allAppIds(db: ReturnType<typeof serviceClient>): Promise<string[]> {
  const { data, error } = await db.from("apps").select("id");
  if (error) throw error;
  return (data ?? []).map((a) => a.id as string);
}
