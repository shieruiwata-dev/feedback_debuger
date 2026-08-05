import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.ts";

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
