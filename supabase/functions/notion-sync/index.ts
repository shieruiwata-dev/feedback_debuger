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
import { json } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { syncToNotion } from "../_shared/notionsync.ts";
import { fetchSchema, notionSyncEnabled, titlePropertyName } from "../_shared/notion.ts";
import { requireEnv } from "../_shared/env.ts";

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
