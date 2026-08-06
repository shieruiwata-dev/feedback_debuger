/**
 * Edge Function の「1 ファイル版」を生成する
 *
 *   node scripts/build-single-file-functions.mjs
 *
 * なぜ必要か:
 *   Supabase CLI を使わず、ダッシュボードの Edge Functions エディタに貼り付けて
 *   デプロイしたい場合、`../_shared/*.ts` のような相対 import は解決できない。
 *   また import map（supabase/functions/deno.json）も効かないので、
 *   `@supabase/supabase-js` は `npm:` 指定に書き換える必要がある。
 *
 *   そこで _shared のモジュールを依存順に連結し、
 *   外部依存だけを残した 1 ファイルを supabase/functions/_bundled/ に出力する。
 *   `_` 始まりのディレクトリは Supabase CLI がデプロイ対象から除外するので、
 *   CLI 運用に切り替えても邪魔にならない。
 *
 * 生成物は手で編集しないこと。ロジックを変えたら _shared 側を直して再生成する。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = join(root, "supabase", "functions");
const outDir = join(functionsDir, "_bundled");

/** 連結順序。const の初期化順が壊れないよう、依存される側を先に置く */
const SHARED_ORDER = [
  "env.ts",
  "types.ts",
  "http.ts",
  "dify.ts",
  "embeddings.ts",
  "supabase.ts",
  "triage.ts",
  "slack.ts",
  "spam.ts",
  "enrich.ts",
  "ingest.ts",
];

/** 関数ごとに必要な _shared モジュール（未使用のコードを混ぜないため明示する） */
const FUNCTIONS = {
  "slack-events": ["env", "types", "http", "dify", "embeddings", "supabase", "triage", "slack", "enrich", "ingest"],
  "submit-feedback": ["env", "types", "http", "dify", "embeddings", "supabase", "triage", "spam", "enrich", "ingest"],
  "process-feedback": ["env", "types", "http", "dify", "embeddings", "supabase", "triage", "enrich"],
};

const SUPABASE_IMPORT =
  'import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";';

/** 相対 import と @supabase/supabase-js の import を落とす（複数行にまたがるものも含む） */
function stripImports(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+"(?:\.\.?\/)[^"]*";[ \t]*\r?\n/gm, "")
    .replace(/^import\s+[\s\S]*?from\s+"@supabase\/supabase-js";[ \t]*\r?\n/gm, "");
}

function banner(name) {
  return `// ${"=".repeat(75)}\n// ${name}\n// ${"=".repeat(75)}\n`;
}

const header = (fnName) =>
  `/**
 * ${fnName} — 1 ファイル版（自動生成 / 手で編集しないこと）
 *
 * Supabase ダッシュボードの Edge Functions エディタに貼り付けて使う。
 * 元のソースは supabase/functions/${fnName}/index.ts と supabase/functions/_shared/ にあり、
 * このファイルは scripts/build-single-file-functions.mjs が生成する。
 */
${SUPABASE_IMPORT}

`;

await mkdir(outDir, { recursive: true });

for (const [fnName, modules] of Object.entries(FUNCTIONS)) {
  const parts = [header(fnName)];

  for (const mod of modules) {
    const file = SHARED_ORDER.find((f) => f === `${mod}.ts`);
    if (!file) throw new Error(`unknown shared module: ${mod}`);
    const source = await readFile(join(functionsDir, "_shared", file), "utf8");
    parts.push(banner(`_shared/${file}`) + stripImports(source).trim() + "\n\n");
  }

  const entry = await readFile(join(functionsDir, fnName, "index.ts"), "utf8");
  parts.push(banner(`${fnName}/index.ts`) + stripImports(entry).trim() + "\n");

  const outPath = join(outDir, `${fnName}.ts`);
  await writeFile(outPath, parts.join(""));
  console.log(`generated ${outPath}`);
}
