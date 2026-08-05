/**
 * Dify 出力の正規化テスト
 *   deno test --allow-env supabase/functions/tests/
 *
 * LLM の出力は形が揺れるので、想定される崩れ方を一通り通す。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { __testing } from "../_shared/dify.ts";

const { normalizeClassification } = __testing;

Deno.test("outputs に 3 変数が分かれているパターン", () => {
  const result = normalizeClassification(
    { priority: "high", category: "bug", summary: "ログインできない" },
    "原文",
  );
  assertEquals(result, { priority: "high", category: "bug", summary: "ログインできない" });
});

Deno.test("outputs.result が JSON 文字列のパターン", () => {
  const result = normalizeClassification(
    { result: '{"priority":"urgent","category":"ux","summary":"文字が小さい"}' },
    "原文",
  );
  assertEquals(result, { priority: "urgent", category: "ux", summary: "文字が小さい" });
});

Deno.test("コードフェンス付きの JSON を剥がせる", () => {
  const result = normalizeClassification(
    { result: '```json\n{"priority":"low","category":"other","summary":"些細な指摘"}\n```' },
    "原文",
  );
  assertEquals(result.priority, "low");
  assertEquals(result.category, "other");
});

Deno.test("前後に説明文が付いていても JSON を拾う", () => {
  const result = normalizeClassification(
    { result: 'はい、分類しました: {"priority":"high","category":"bug","summary":"落ちる"} 以上です' },
    "原文",
  );
  assertEquals(result.priority, "high");
  assertEquals(result.summary, "落ちる");
});

Deno.test("表記ゆれ（大文字・スペース・ハイフン）を吸収する", () => {
  const result = normalizeClassification(
    { priority: " HIGH ", category: "Feature Request", summary: "要望" },
    "原文",
  );
  assertEquals(result.priority, "high");
  assertEquals(result.category, "feature_request");
});

Deno.test("未知の値はフォールバックする", () => {
  const result = normalizeClassification(
    { priority: "super_urgent", category: "performance", summary: "重い" },
    "原文",
  );
  assertEquals(result.priority, "medium");
  assertEquals(result.category, "other");
});

Deno.test("要約が取れなければ原文の先頭で代用する", () => {
  const result = normalizeClassification({ priority: "low" }, "  検索が遅いです  ");
  assertEquals(result.summary, "検索が遅いです");
});

Deno.test("空の outputs でも落ちずに既定値を返す", () => {
  const result = normalizeClassification({}, "原文テキスト");
  assertEquals(result, { priority: "medium", category: "other", summary: "原文テキスト" });
});

Deno.test("要約は 500 文字で打ち切る", () => {
  const long = "あ".repeat(800);
  const result = normalizeClassification({ summary: long }, "原文");
  assertEquals(result.summary.length, 500);
});
