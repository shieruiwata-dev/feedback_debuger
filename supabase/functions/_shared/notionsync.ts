import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envInt, requireEnv } from "./env.ts";
import {
  appendBlocks,
  archivePage,
  buildProperties,
  type ClusterForNotion,
  createPage,
  fetchSchema,
  type ItemForNotion,
  itemBlock,
  type LabelMaps,
  NotionError,
  type NotionSchema,
  type PropertyMap,
  updatePage,
} from "./notion.ts";

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
