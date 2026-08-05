import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * 環境変数が無い場合はモックデータで動くようにしてある。
 * artifact / ローカルで UI を先に固めてから Supabase を繋ぐ開発フローのため。
 */
export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

/** Supabase 未設定時に client を触ろうとしたら明示的に落とす */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      "Supabase が未設定です。web/.env に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください。",
    );
  }
  return supabase;
}
