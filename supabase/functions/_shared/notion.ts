import { env, envBool, envInt, requireEnv } from "./env.ts";
import type { Category, Priority } from "./types.ts";

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
