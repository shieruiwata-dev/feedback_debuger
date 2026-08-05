import { envList } from "./env.ts";

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
