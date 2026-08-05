import { env, envInt, requireEnv } from "./env.ts";
import { fetchWithTimeout } from "./dify.ts";

/**
 * 埋め込みベクトル生成。
 *
 * 【なぜ Dify 単独ではないか】
 * Dify は「アプリ（チャット/ワークフロー）実行 API」は公開しているが、
 * 任意テキストをベクトル化する汎用 embeddings エンドポイントは公開していない
 * （埋め込みは Knowledge/RAG の内部処理として使われる）。
 * そのため既定では OpenAI の embeddings API を直接叩く構成にし、
 * Dify のワークフローからベクトル配列を返す運用にも切り替えられるようにしてある。
 *
 * EMBEDDING_PROVIDER:
 *   "openai"        … OpenAI /v1/embeddings（既定, text-embedding-3-small = 1536 次元）
 *   "dify_workflow" … Dify ワークフローの出力 `embedding`（数値配列 or JSON 文字列）
 */
export type EmbeddingProvider = "openai" | "dify_workflow";

export const EMBEDDING_DIMENSIONS = () => envInt("EMBEDDING_DIMENSIONS", 1536);

export async function embedText(text: string): Promise<number[]> {
  const provider = (env("EMBEDDING_PROVIDER") ?? "openai") as EmbeddingProvider;
  const input = text.trim().slice(0, 8000);

  const vector = provider === "dify_workflow"
    ? await embedViaDifyWorkflow(input)
    : await embedViaOpenAI(input);

  const expected = EMBEDDING_DIMENSIONS();
  if (vector.length !== expected) {
    throw new Error(
      `embedding dimension mismatch: got ${vector.length}, expected ${expected}. ` +
        `feedback_items.embedding の vector(N) と EMBEDDING_DIMENSIONS を揃えてください`,
    );
  }
  return vector;
}

async function embedViaOpenAI(input: string): Promise<number[]> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = env("EMBEDDING_MODEL") ?? "text-embedding-3-small";
  const baseUrl = env("OPENAI_API_BASE_URL") ?? "https://api.openai.com/v1";

  const res = await fetchWithTimeout(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input, dimensions: EMBEDDING_DIMENSIONS() }),
  }, envInt("EMBEDDING_TIMEOUT_MS", 20_000));

  if (!res.ok) {
    throw new Error(`openai embeddings failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("openai embeddings: unexpected response shape");
  return vector as number[];
}

async function embedViaDifyWorkflow(input: string): Promise<number[]> {
  const baseUrl = env("DIFY_API_BASE_URL") ?? "https://api.dify.ai/v1";
  const apiKey = requireEnv("DIFY_EMBEDDING_API_KEY");

  const res = await fetchWithTimeout(`${baseUrl}/workflows/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: { feedback_text: input },
      response_mode: "blocking",
      user: "feedback-debugger",
    }),
  }, envInt("EMBEDDING_TIMEOUT_MS", 20_000));

  if (!res.ok) {
    throw new Error(`dify embedding failed: ${res.status} ${await res.text()}`);
  }

  const outputs = (await res.json())?.data?.outputs ?? {};
  const raw = outputs["embedding"] ?? outputs["result"];

  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as number[];
  }
  throw new Error("dify embedding: unexpected output shape (expected number[])");
}
