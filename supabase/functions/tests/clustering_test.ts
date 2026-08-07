/**
 * LLM 照合方式のクラスタリング（埋め込みを使わない経路）のテスト
 *   deno test --allow-env supabase/functions/tests/
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  type CandidateCluster,
  formatCandidates,
  resolveMatch,
} from "../_shared/clustering.ts";
import { __testing } from "../_shared/dify.ts";

const { normalizeClassification } = __testing;

const candidates: CandidateCluster[] = [
  { cluster_id: "aaa", summary: "検索の応答が遅い", item_count: 12 },
  { cluster_id: "bbb", summary: "申請履歴のCSVエクスポート", item_count: 8 },
  { cluster_id: "ccc", summary: "通知メールの文面が事務的", item_count: 2 },
];

// =============================================================================
// LLM に渡す候補一覧
// =============================================================================
Deno.test("候補は番号と件数つきで渡す", () => {
  assertEquals(
    formatCandidates(candidates),
    "1. 検索の応答が遅い（12件）\n2. 申請履歴のCSVエクスポート（8件）\n3. 通知メールの文面が事務的（2件）",
  );
});

Deno.test("候補が無いときも空文字ではなく明示する", () => {
  // 空文字だとプロンプトの該当箇所が消えて、LLM が指示を読み違えることがある
  assertEquals(formatCandidates([]), "（まだ登録された論点はありません）");
});

// =============================================================================
// 番号 → cluster_id の解決
// =============================================================================
Deno.test("番号を cluster_id に戻せる", () => {
  assertEquals(resolveMatch(1, candidates), "aaa");
  assertEquals(resolveMatch(2, candidates), "bbb");
  assertEquals(resolveMatch(3, candidates), "ccc");
});

Deno.test("該当なしは新規クラスタ（null）", () => {
  assertEquals(resolveMatch(null, candidates), null);
});

Deno.test("範囲外の番号は新規クラスタに倒す", () => {
  // 存在しないクラスタに紐付けるより、新規を作る方が実害が小さい。
  // 誤った合流は気づきにくく、あとから分離するのは難しい
  assertEquals(resolveMatch(0, candidates), null);
  assertEquals(resolveMatch(4, candidates), null);
  assertEquals(resolveMatch(-1, candidates), null);
  assertEquals(resolveMatch(99, candidates), null);
});

Deno.test("候補が空なら常に新規クラスタ", () => {
  assertEquals(resolveMatch(1, []), null);
});

Deno.test("整数でない番号は新規クラスタに倒す", () => {
  assertEquals(resolveMatch(1.5, candidates), null);
  assertEquals(resolveMatch(NaN, candidates), null);
});

// =============================================================================
// LLM 出力の match 欄
// =============================================================================
Deno.test("match の表記ゆれを吸収する", () => {
  const parse = (match: unknown) =>
    normalizeClassification(
      { issues: [{ summary: "検索が遅い", priority: "high", category: "bug", match }] },
      "原文",
    ).issues[0].match;

  assertEquals(parse(1), 1);
  assertEquals(parse("2"), 2);
  assertEquals(parse(null), null);
  assertEquals(parse("null"), null);
  assertEquals(parse("none"), null);
  assertEquals(parse("なし"), null);
  assertEquals(parse(""), null);
  assertEquals(parse(0), null);
  assertEquals(parse(undefined), null);
  assertEquals(parse("該当なし"), null);
});

Deno.test("match_id という名前で返ってきても読める", () => {
  const result = normalizeClassification(
    { issues: [{ summary: "A", priority: "low", category: "ux", match_id: 3 }] },
    "原文",
  );
  assertEquals(result.issues[0].match, 3);
});

Deno.test("契約: 分割と突き合わせを同時に返す形式を読める", () => {
  // 3 論点のうち 1 つ目は既存に合流、残り 2 つは新規、という現実的なケース
  const llmOutput = `{
  "is_feedback": true,
  "confidence": 0.95,
  "noise_reason": null,
  "issues": [
    {"text":"検索が遅い","summary":"検索の応答が遅い","priority":"high","category":"bug","match":1},
    {"text":"CSVが欲しい","summary":"申請履歴のCSVエクスポート","priority":"medium","category":"feature_request","match":2},
    {"text":"通知が多すぎる","summary":"通知の頻度が多い","priority":"low","category":"ux","match":null}
  ]
}`;

  const result = normalizeClassification({ result: llmOutput }, "原文");

  assertEquals(result.issues.length, 3);
  assertEquals(result.issues.map((i) => i.match), [1, 2, null]);
  assertEquals(result.issues.map((i) => resolveMatch(i.match, candidates)), [
    "aaa",
    "bbb",
    null,
  ]);
});

Deno.test("match が無い出力（埋め込み方式のワークフロー）でも壊れない", () => {
  const result = normalizeClassification(
    { issues: [{ summary: "検索が遅い", priority: "high", category: "bug" }] },
    "原文",
  );
  assertEquals(result.issues[0].match, null);
});
