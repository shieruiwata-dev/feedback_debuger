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
import { json } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { enrichItem } from "../_shared/enrich.ts";
import { envInt } from "../_shared/env.ts";

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
