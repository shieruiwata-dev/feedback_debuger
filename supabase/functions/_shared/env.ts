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
