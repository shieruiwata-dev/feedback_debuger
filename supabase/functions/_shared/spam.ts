import type { SupabaseClient } from "@supabase/supabase-js";
import { env, envInt } from "./env.ts";
import { fetchWithTimeout } from "./dify.ts";

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
