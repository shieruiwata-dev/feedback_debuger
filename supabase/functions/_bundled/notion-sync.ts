/**
 * notion-sync — 1 ファイル版（自動生成 / 手で編集しないこと）
 *
 * Supabase ダッシュボードの Edge Functions エディタに貼り付けて使う。
 * 元のソースは supabase/functions/notion-sync/index.ts と supabase/functions/_shared/ にあり、
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
// _shared/notion.ts
// ===========================================================================
/**
 * Notion 連携
 *
 * 集計結果（クラスタ＝論点）を Notion のデータベースに書き出す。
 * ダッシュボードを別に建てず、チームが既に使っている Notion をそのまま画面にする。
 *
 * 設計の前提:
 *   - 片方向（Supabase → Notion）。Notion 側で人が入れた値は上書きしない
 *   - 書き込むプロパティは property_map に列挙されたものだけ
 *   - Notion のデータベースは別の人が作るので、プロパティ名も型も分からない。
 *     そこで毎回スキーマを読み、「存在して、型が扱えるもの」だけを書く。
 *     名前が違えば黙って読み飛ばす（同期全体を止めない）
 *
 * API バージョンは 2022-06-28 に固定している。
 * これ以降のバージョンは parent の指定方法（database_id → data_source_id）が変わるため、
 * 上げるときは createPage() も合わせて直すこと。
 */

const DEFAULT_API_BASE = "https://api.notion.com/v1";
const DEFAULT_VERSION = "2022-06-28";

/** テストでスタブに向けるための差し替え口。本番では未設定にする */
const apiBase = () => env("NOTION_API_BASE_URL") ?? DEFAULT_API_BASE;

/** rich_text 1 要素あたりの文字数上限（Notion の制約） */
const TEXT_CHUNK = 2000;

export const notionSyncEnabled = () => envBool("ENABLE_NOTION_SYNC", false);

export interface NotionPropertySchema {
  name: string;
  type: string;
}

/** プロパティ名 → 型。データベースのスキーマを読んで作る */
export type NotionSchema = Map<string, NotionPropertySchema>;

export interface ClusterForNotion {
  cluster_id: string;
  app_name: string | null;
  summary: string | null;
  priority: Priority | null;
  category: Category | null;
  item_count: number;
  score: number | string;
  updated_at: string;
  notion_page_id: string | null;
}

export interface ItemForNotion {
  item_id: string;
  raw_text: string;
  summary: string | null;
  source_type: string;
  permalink: string | null;
  author: string | null;
  created_at: string;
}

/** app_settings の notion.property_map。値が null / 空の項目は書き込まない */
export interface PropertyMap {
  score?: string | null;
  item_count?: string | null;
  priority?: string | null;
  category?: string | null;
  app_name?: string | null;
  last_updated?: string | null;
  source_url?: string | null;
}

export interface LabelMaps {
  priority?: Record<string, string>;
  category?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------

/** Notion は平均 3 リクエスト/秒。連続で叩くので毎回少し待つ */
const MIN_INTERVAL_MS = 350;
let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NotionError";
  }

  /** ページが Notion 側で消された / ゴミ箱に入れられた */
  get isMissing(): boolean {
    return this.status === 404 || this.code === "object_not_found";
  }
}

async function notionFetch(
  path: string,
  init: { method: string; body?: unknown },
  attempt = 0,
): Promise<Record<string, unknown>> {
  await throttle();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), envInt("NOTION_TIMEOUT_MS", 20_000));

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: init.method,
      headers: {
        "Authorization": `Bearer ${requireEnv("NOTION_TOKEN")}`,
        "Notion-Version": env("NOTION_VERSION") ?? DEFAULT_VERSION,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number.parseFloat(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.max(retryAfter, 1) * 1000));
    return await notionFetch(path, init, attempt + 1);
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // JSON でない応答（プロキシのエラーページ等）はそのまま本文を見せる
  }

  if (!res.ok) {
    throw new NotionError(
      typeof body.message === "string" ? body.message : text.slice(0, 300),
      res.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }

  return body;
}

// -----------------------------------------------------------------------------
// スキーマ
// -----------------------------------------------------------------------------

/**
 * データベースのプロパティ一覧を読む。
 * 名前も型も相手任せなので、書き込み前に必ずこれで確かめる。
 */
export async function fetchSchema(databaseId: string): Promise<NotionSchema> {
  const body = await notionFetch(`/databases/${databaseId}`, { method: "GET" });
  const props = (body.properties ?? {}) as Record<string, { type?: string }>;

  const schema: NotionSchema = new Map();
  for (const [name, def] of Object.entries(props)) {
    if (typeof def?.type === "string") schema.set(name, { name, type: def.type });
  }
  return schema;
}

/** type=title のプロパティ名を探す。タイトルは名前が何であれ 1 つだけ存在する */
export function titlePropertyName(schema: NotionSchema): string | null {
  for (const [name, def] of schema) {
    if (def.type === "title") return name;
  }
  return null;
}

// -----------------------------------------------------------------------------
// 値の組み立て
// -----------------------------------------------------------------------------

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TEXT_CHUNK) {
    chunks.push(text.slice(i, i + TEXT_CHUNK));
  }
  return chunks.length > 0 ? chunks : [""];
}

function richText(text: string, link?: string | null) {
  return chunkText(text).map((content) => ({
    type: "text",
    text: { content, link: link ? { url: link } : null },
  }));
}

/**
 * Notion のプロパティ型に合わせて値を包む。
 * 扱えない型（rollup / formula / relation など、こちらから書けないもの）は null を返す。
 */
export function toPropertyValue(type: string, value: unknown): unknown | null {
  if (value === null || value === undefined || value === "") return null;

  switch (type) {
    case "title":
      return { title: richText(String(value)) };
    case "rich_text":
      return { rich_text: richText(String(value)) };
    case "number": {
      const n = typeof value === "number" ? value : Number.parseFloat(String(value));
      return Number.isFinite(n) ? { number: n } : null;
    }
    case "select":
      return { select: { name: String(value).slice(0, 100) } };
    case "status":
      // status のオプションは API から新規作成できない。
      // 既存の名前と一致しなければ Notion 側が 400 を返すので、呼び出し元で握りつぶす。
      return { status: { name: String(value).slice(0, 100) } };
    case "multi_select":
      return {
        multi_select: (Array.isArray(value) ? value : [value])
          .map((v) => ({ name: String(v).slice(0, 100) })),
      };
    case "date":
      return { date: { start: String(value) } };
    case "url":
      return { url: String(value) };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "email":
      return { email: String(value) };
    case "phone_number":
      return { phone_number: String(value) };
    default:
      // people / files / relation / rollup / formula / created_time など
      return null;
  }
}

/**
 * クラスタ 1 件分のプロパティを組み立てる。
 *
 * property_map に書かれていても、その名前のプロパティが Notion 側に無ければ飛ばす。
 * 「相手のデータベースを壊さない」ことを優先し、こちらの都合で列を作りにいかない。
 */
export function buildProperties(
  cluster: ClusterForNotion,
  schema: NotionSchema,
  map: PropertyMap,
  labels: LabelMaps = {},
): { properties: Record<string, unknown>; skipped: string[] } {
  const properties: Record<string, unknown> = {};
  const skipped: string[] = [];

  const title = titlePropertyName(schema);
  if (title) {
    properties[title] = {
      title: richText(cluster.summary ?? "(要約なし)"),
    };
  } else {
    skipped.push("title(型が title のプロパティが見つからない)");
  }

  const entries: Array<[keyof PropertyMap, unknown]> = [
    ["score", typeof cluster.score === "string" ? Number.parseFloat(cluster.score) : cluster.score],
    ["item_count", cluster.item_count],
    ["priority", cluster.priority ? labels.priority?.[cluster.priority] ?? cluster.priority : null],
    ["category", cluster.category ? labels.category?.[cluster.category] ?? cluster.category : null],
    ["app_name", cluster.app_name],
    ["last_updated", cluster.updated_at],
  ];

  for (const [key, raw] of entries) {
    const propName = map[key];
    if (!propName) continue;

    const def = schema.get(propName);
    if (!def) {
      skipped.push(`${key} → "${propName}"(Notion に無い)`);
      continue;
    }
    if (def.type === "title") continue; // タイトルは上で入れている

    const packed = toPropertyValue(def.type, raw);
    if (packed === null) {
      skipped.push(`${key} → "${propName}"(型 ${def.type} には書けない)`);
      continue;
    }
    properties[propName] = packed;
  }

  return { properties, skipped };
}

/** 元投稿 1 件 = ページ本文のブロック 1 つ。item と 1 対 1 で対応させて追記漏れを防ぐ */
export function itemBlock(item: ItemForNotion) {
  const text = item.raw_text.trim();
  const meta: string[] = [];
  if (item.author) meta.push(item.author);
  meta.push(new Date(item.created_at).toISOString().slice(0, 10));

  const children: unknown[] = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: item.permalink
          ? [
            ...richText(`${meta.join(" / ")} — `),
            ...richText("Slack で開く", item.permalink),
          ]
          : richText(meta.join(" / ")),
        color: "gray",
      },
    },
  ];

  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: richText(text),
      icon: { type: "emoji", emoji: item.source_type === "slack" ? "💬" : "📝" },
      color: "gray_background",
      children,
    },
  };
}

// -----------------------------------------------------------------------------
// 書き込み
// -----------------------------------------------------------------------------

export async function createPage(
  databaseId: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const body = await notionFetch("/pages", {
    method: "POST",
    body: { parent: { database_id: databaseId }, properties },
  });
  return String(body.id);
}

export async function updatePage(
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await notionFetch(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
}

export async function archivePage(pageId: string): Promise<void> {
  await notionFetch(`/pages/${pageId}`, { method: "PATCH", body: { archived: true } });
}

/**
 * ページ本文にブロックを足す。
 * 戻り値は投入順に並んだブロック ID。item と対応づけて記録する。
 */
export async function appendBlocks(
  pageId: string,
  blocks: unknown[],
): Promise<string[]> {
  if (blocks.length === 0) return [];
  const body = await notionFetch(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: { children: blocks },
  });
  const results = (body.results ?? []) as Array<{ id?: string }>;
  return results.map((b) => String(b.id));
}

export const __testing = { chunkText, richText };

// ===========================================================================
// _shared/notionsync.ts
// ===========================================================================
/**
 * Notion への差分同期
 *
 *   1. 削除済みクラスタのページをアーカイブする
 *   2. 未同期・更新ありのクラスタを順に処理する
 *        ページが無ければ作る / あればプロパティを貼り直す
 *        本文に未追記の元投稿を足す
 *
 * 1 クラスタの失敗で全体を止めない。失敗は結果に積んで次へ進む。
 * 同期の記録（notion_synced_at）は全部成功したときだけ付けるので、
 * こぼれたクラスタは次回の実行で再び拾われる。
 */

export interface SyncResult {
  cluster_id: string;
  summary: string | null;
  action: "created" | "updated" | "recreated" | "failed";
  items_appended: number;
  error?: string;
}

export interface SyncReport {
  ok: boolean;
  synced: number;
  failed: number;
  archived: number;
  /** property_map と Notion のスキーマが噛み合っていない箇所。設定ミスの発見用 */
  skipped_properties: string[];
  results: SyncResult[];
}

/** プロパティ書き込みで 400 が出たときに落とす型（相手の設定に依存して失敗しやすいもの） */
const FRAGILE_TYPES = ["select", "status", "multi_select"];

export async function syncToNotion(
  db: SupabaseClient,
  opts: { limit?: number; appId?: string | null } = {},
): Promise<SyncReport> {
  const databaseId = requireEnv("NOTION_DATABASE_ID");
  const limit = Math.min(opts.limit ?? envInt("NOTION_SYNC_BATCH_SIZE", 25), 100);

  const [schema, map, labels] = await Promise.all([
    fetchSchema(databaseId),
    loadPropertyMap(db),
    loadLabelMaps(db),
  ]);

  const archived = await archiveOrphans(db);

  const { data: queue, error } = await db.rpc("notion_sync_queue", {
    p_limit: limit,
    p_app_id: opts.appId ?? null,
  });
  if (error) throw error;

  const results: SyncResult[] = [];
  const skipped = new Set<string>();

  for (const row of (queue ?? []) as ClusterForNotion[]) {
    const { properties, skipped: missing } = buildProperties(row, schema, map, labels);
    missing.forEach((m) => skipped.add(m));

    try {
      results.push(await syncCluster(db, databaseId, row, properties, schema));
    } catch (err) {
      results.push({
        cluster_id: row.cluster_id,
        summary: row.summary,
        action: "failed",
        items_appended: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failed = results.filter((r) => r.action === "failed").length;

  return {
    ok: failed === 0,
    synced: results.length - failed,
    failed,
    archived,
    skipped_properties: [...skipped],
    results,
  };
}

async function syncCluster(
  db: SupabaseClient,
  databaseId: string,
  row: ClusterForNotion,
  properties: Record<string, unknown>,
  schema: NotionSchema,
): Promise<SyncResult> {
  let pageId = row.notion_page_id;
  let action: SyncResult["action"] = pageId ? "updated" : "created";

  if (pageId) {
    try {
      await writeProperties(schema, properties, (p) => updatePage(pageId as string, p));
    } catch (err) {
      // Notion 側でページが消された場合は作り直す。
      // 本文のブロック ID も無効になるので、item 側の目印も一緒に消す。
      if (err instanceof NotionError && err.isMissing) {
        await db.rpc("clear_cluster_notion_page", { p_cluster_id: row.cluster_id });
        pageId = null;
        action = "recreated";
      } else {
        throw err;
      }
    }
  }

  if (!pageId) {
    pageId = await writeProperties(
      schema,
      properties,
      (p) => createPage(databaseId, p),
    );
  }

  const appended = await appendPendingItems(db, pageId, row.cluster_id);

  // キューから読んだ時点の updated_at を渡す。
  // 書き出し中にクラスタが変わっていた場合は印が進まず、次回もう一度送られる。
  const { error } = await db.rpc("mark_cluster_notion_synced", {
    p_cluster_id: row.cluster_id,
    p_page_id: pageId,
    p_seen_updated_at: row.updated_at,
  });
  if (error) throw error;

  return { cluster_id: row.cluster_id, summary: row.summary, action, items_appended: appended };
}

/**
 * プロパティを書く。400 が返ったら「相手のデータベースが受け付けない値」なので、
 * セレクト系を落として本質的な情報（タイトル・件数・スコア）だけでも通す。
 *
 * ここで諦めると論点そのものが Notion に載らないため、
 * 「一部欠けても載せる」を選んでいる。欠けた項目は skipped_properties で報告する。
 */
async function writeProperties<T>(
  schema: NotionSchema,
  properties: Record<string, unknown>,
  write: (p: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  try {
    return await write(properties);
  } catch (err) {
    if (!(err instanceof NotionError) || err.status !== 400) throw err;

    const reduced: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      const type = schema.get(name)?.type;
      if (type && FRAGILE_TYPES.includes(type)) continue;
      reduced[name] = value;
    }

    console.warn(
      `notion: プロパティの一部が拒否されたので落として再送する: ${err.message}`,
    );
    return await write(reduced);
  }
}

async function appendPendingItems(
  db: SupabaseClient,
  pageId: string,
  clusterId: string,
): Promise<number> {
  const { data, error } = await db.rpc("notion_pending_items", {
    p_cluster_id: clusterId,
    p_limit: envInt("NOTION_ITEMS_PER_SYNC", 20),
  });
  if (error) throw error;

  const items = (data ?? []) as ItemForNotion[];
  if (items.length === 0) return 0;

  const blockIds = await appendBlocks(pageId, items.map(itemBlock));

  // 返ってきた ID は投入順。数が合わないときは対応づけできないので記録しない
  // （次回もう一度追記されるより、取り違えて別の投稿に紐づくほうが厄介なため）。
  if (blockIds.length !== items.length) {
    console.warn(
      `notion: 追記したブロック数が合わない (${blockIds.length}/${items.length})。cluster=${clusterId}`,
    );
    return items.length;
  }

  for (let i = 0; i < items.length; i++) {
    const { error: markError } = await db.rpc("mark_item_notion_block", {
      p_item_id: items[i].item_id,
      p_block_id: blockIds[i],
    });
    if (markError) throw markError;
  }

  return items.length;
}

/** 削除されたクラスタのページを Notion のゴミ箱へ移す */
async function archiveOrphans(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from("notion_orphan_pages")
    .select("page_id")
    .is("archived_at", null)
    .limit(20);
  if (error) throw error;

  let count = 0;
  for (const row of (data ?? []) as Array<{ page_id: string }>) {
    try {
      await archivePage(row.page_id);
    } catch (err) {
      // 既に手で消されている場合は成功扱いにして記録を閉じる
      if (!(err instanceof NotionError && err.isMissing)) {
        console.warn(`notion: ページのアーカイブに失敗 ${row.page_id}: ${err}`);
        continue;
      }
    }
    await db.rpc("mark_notion_orphan_archived", { p_page_id: row.page_id });
    count++;
  }
  return count;
}

// -----------------------------------------------------------------------------
// 設定の読み込み
// -----------------------------------------------------------------------------

const DEFAULT_MAP: PropertyMap = {
  score: "スコア",
  item_count: "件数",
  priority: "優先度",
  category: "種別",
  app_name: "アプリ",
  last_updated: "最終更新",
};

async function loadPropertyMap(db: SupabaseClient): Promise<PropertyMap> {
  const raw = await readSetting(db, "notion.property_map");
  const fromEnv = env("NOTION_PROPERTY_MAP");

  if (fromEnv) {
    try {
      return { ...DEFAULT_MAP, ...JSON.parse(fromEnv) };
    } catch {
      console.warn("NOTION_PROPERTY_MAP が JSON として読めないので無視する");
    }
  }
  return raw && typeof raw === "object" ? { ...DEFAULT_MAP, ...raw } : DEFAULT_MAP;
}

async function loadLabelMaps(db: SupabaseClient): Promise<LabelMaps> {
  const [priority, category] = await Promise.all([
    readSetting(db, "notion.priority_labels"),
    readSetting(db, "notion.category_labels"),
  ]);
  return {
    priority: (priority ?? undefined) as Record<string, string> | undefined,
    category: (category ?? undefined) as Record<string, string> | undefined,
  };
}

async function readSetting(
  db: SupabaseClient,
  key: string,
): Promise<Record<string, string> | null> {
  const { data, error } = await db
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.warn(`app_settings ${key} の読み込みに失敗: ${error.message}`);
    return null;
  }
  const value = data?.value;
  return value && typeof value === "object" ? value as Record<string, string> : null;
}

// ===========================================================================
// notion-sync/index.ts
// ===========================================================================
/**
 * Notion への書き出し
 *
 * エンドポイント: POST /functions/v1/notion-sync
 *   {}                                  … 未同期・更新ありのクラスタをまとめて処理
 *   { "limit": 50 }                     … 1 回で処理する上限（既定 25、最大 100）
 *   { "app_id": "<uuid>" }              … 対象アプリを絞る
 *   { "dry_run": true }                 … 接続とプロパティ対応の確認だけ行う
 *
 * pg_cron から数分おきに叩く運用を想定している（docs/NOTION.md 参照）。
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

  if (!notionSyncEnabled()) {
    return json(
      { error: "ENABLE_NOTION_SYNC が true ではないため同期しない" },
      { status: 409 },
    );
  }

  try {
    // 疎通確認。トークンとデータベース ID が正しいか、
    // プロパティの対応が取れているかだけを見て、書き込みはしない。
    if (body.dry_run === true) {
      const databaseId = requireEnv("NOTION_DATABASE_ID");
      const schema = await fetchSchema(databaseId);
      return json({
        ok: true,
        dry_run: true,
        title_property: titlePropertyName(schema),
        properties: [...schema.values()].map((p) => `${p.name} (${p.type})`),
      });
    }

    const report = await syncToNotion(serviceClient(), {
      limit: typeof body.limit === "number" ? body.limit : undefined,
      appId: typeof body.app_id === "string" ? body.app_id : null,
    });

    return json(report, { status: report.ok ? 200 : 207 });
  } catch (err) {
    console.error("notion-sync error:", err);
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
