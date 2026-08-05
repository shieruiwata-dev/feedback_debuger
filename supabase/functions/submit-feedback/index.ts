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
import { clientIp, corsHeaders, json, preflight } from "../_shared/http.ts";
import { resolveAppBySlug, serviceClient } from "../_shared/supabase.ts";
import { ingestFeedback } from "../_shared/ingest.ts";
import { checkCaptcha, checkHoneypot, checkRateLimit } from "../_shared/spam.ts";

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
