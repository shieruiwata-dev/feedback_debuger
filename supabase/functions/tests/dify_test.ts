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
  assertEquals(result.priority, "high");
  assertEquals(result.category, "bug");
  assertEquals(result.summary, "ログインできない");
  // is_feedback を返さない旧ワークフローとの互換: 取りこぼさない側に倒す
  assertEquals(result.is_feedback, true);
  assertEquals(result.confidence, 1);
  assertEquals(result.noise_reason, null);
  // 論点が 1 つなら分割しない
  assertEquals(result.issues.length, 1);
});

Deno.test("outputs.result が JSON 文字列のパターン", () => {
  const result = normalizeClassification(
    { result: '{"priority":"urgent","category":"ux","summary":"文字が小さい"}' },
    "原文",
  );
  assertEquals(result.priority, "urgent");
  assertEquals(result.category, "ux");
  assertEquals(result.summary, "文字が小さい");
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
  assertEquals(result.priority, "medium");
  assertEquals(result.category, "other");
  assertEquals(result.summary, "原文テキスト");
  assertEquals(result.is_feedback, true);
});

Deno.test("要約は 500 文字で打ち切る", () => {
  const long = "あ".repeat(800);
  const result = normalizeClassification({ summary: long }, "原文");
  assertEquals(result.summary.length, 500);
});

// =============================================================================
// トリアージ（is_feedback / confidence / noise_reason）
// =============================================================================
Deno.test("ノイズ判定を読み取る", () => {
  const result = normalizeClassification({
    result: JSON.stringify({
      is_feedback: false,
      confidence: 0.93,
      noise_reason: "社内の予定調整の連絡",
      priority: "low",
      category: "other",
      summary: "定例の時間変更",
    }),
  }, "原文");

  assertEquals(result.is_feedback, false);
  assertEquals(result.confidence, 0.93);
  assertEquals(result.noise_reason, "社内の予定調整の連絡");
});

Deno.test("is_feedback の表記ゆれを吸収する", () => {
  assertEquals(normalizeClassification({ is_feedback: "false" }, "x").is_feedback, false);
  assertEquals(normalizeClassification({ is_feedback: "No" }, "x").is_feedback, false);
  assertEquals(normalizeClassification({ is_feedback: "いいえ" }, "x").is_feedback, false);
  assertEquals(normalizeClassification({ is_feedback: 0 }, "x").is_feedback, false);
  assertEquals(normalizeClassification({ is_feedback: "true" }, "x").is_feedback, true);
  assertEquals(normalizeClassification({ is_feedback: "yes" }, "x").is_feedback, true);
  assertEquals(normalizeClassification({ isFeedback: false }, "x").is_feedback, false);
});

Deno.test("確信度を 0〜1 に正規化する", () => {
  // 0〜100 で返してくるモデルがある
  assertEquals(normalizeClassification({ confidence: 85 }, "x").confidence, 0.85);
  assertEquals(normalizeClassification({ confidence: "0.4" }, "x").confidence, 0.4);
  // 範囲外はクランプする
  assertEquals(normalizeClassification({ confidence: -1 }, "x").confidence, 0);
  assertEquals(normalizeClassification({ confidence: 500 }, "x").confidence, 1);
});

Deno.test("確信度が取れなければ 1.0 とみなす", () => {
  // 閾値判定で「確信度不足」として扱われないようにする
  assertEquals(normalizeClassification({ is_feedback: false }, "x").confidence, 1);
});

Deno.test("is_feedback が無ければフィードバック扱い（取りこぼし防止）", () => {
  const result = normalizeClassification({ priority: "high", category: "bug" }, "落ちます");
  assertEquals(result.is_feedback, true);
});

// =============================================================================
// 長文の分割（issues）
// =============================================================================
Deno.test("issues が無ければ 1 論点として扱う", () => {
  const result = normalizeClassification(
    { priority: "high", category: "bug", summary: "落ちる" },
    "アプリが落ちます",
  );
  assertEquals(result.issues.length, 1);
  assertEquals(result.issues[0].summary, "落ちる");
  assertEquals(result.issues[0].text, "アプリが落ちます");
});

Deno.test("複数の論点を分割して読み取る", () => {
  const result = normalizeClassification({
    result: JSON.stringify({
      is_feedback: true,
      issues: [
        { text: "検索が遅くて5秒待たされます", summary: "検索が遅い",
          priority: "high", category: "bug" },
        { text: "CSVで出せると助かります", summary: "CSVエクスポート要望",
          priority: "medium", category: "feature_request" },
        { text: "通知メールの文面が事務的", summary: "メール文面のトーン",
          priority: "low", category: "ux" },
      ],
    }),
  }, "原文");

  assertEquals(result.issues.length, 3);
  assertEquals(result.issues.map((i) => i.priority), ["high", "medium", "low"]);
  assertEquals(result.issues.map((i) => i.category), ["bug", "feature_request", "ux"]);
  assertEquals(result.issues[0].text, "検索が遅くて5秒待たされます");
  // トップレベルの代表値は先頭の論点に揃う
  assertEquals(result.summary, "検索が遅い");
  assertEquals(result.priority, "high");
});

Deno.test("items という名前で返ってきても読める", () => {
  const result = normalizeClassification({
    items: [
      { summary: "A", priority: "low", category: "ux" },
      { summary: "B", priority: "urgent", category: "bug" },
    ],
  }, "原文");
  assertEquals(result.issues.length, 2);
  assertEquals(result.issues[1].priority, "urgent");
});

Deno.test("論点ごとの表記ゆれも吸収する", () => {
  const result = normalizeClassification({
    issues: [{ summary: "要望", priority: " HIGH ", category: "Feature Request" }],
  }, "原文");
  assertEquals(result.issues[0].priority, "high");
  assertEquals(result.issues[0].category, "feature_request");
});

Deno.test("text が無ければ要約で代用する（本文が空になるのを防ぐ）", () => {
  const result = normalizeClassification({
    issues: [
      { summary: "検索が遅い", priority: "high", category: "bug" },
      { summary: "CSVが欲しい", priority: "low", category: "feature_request" },
    ],
  }, "原文全体");
  assertEquals(result.issues[0].text, "検索が遅い");
  assertEquals(result.issues[1].text, "CSVが欲しい");
});

Deno.test("issues が空配列なら単一論点にフォールバックする", () => {
  const result = normalizeClassification(
    { issues: [], priority: "low", category: "other", summary: "些細" },
    "原文",
  );
  assertEquals(result.issues.length, 1);
  assertEquals(result.issues[0].summary, "些細");
});

Deno.test("issues が JSON 文字列で来ても読める", () => {
  const result = normalizeClassification({
    issues: '[{"summary":"A","priority":"low","category":"ux"},' +
      '{"summary":"B","priority":"high","category":"bug"}]',
  }, "原文");
  assertEquals(result.issues.length, 2);
});

Deno.test("ノイズ判定は分割より優先される（issues があっても is_feedback=false は保たれる）", () => {
  const result = normalizeClassification({
    result: JSON.stringify({
      is_feedback: false,
      confidence: 0.9,
      noise_reason: "予定調整の連絡",
      issues: [{ summary: "15時に変更", priority: "low", category: "other" }],
    }),
  }, "原文");
  assertEquals(result.is_feedback, false);
  assertEquals(result.confidence, 0.9);
});
