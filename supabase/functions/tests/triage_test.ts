/**
 * フィードバック選別のテスト
 *   deno test --allow-env supabase/functions/tests/
 *
 * 層 0（insert 前の破棄）は不可逆なので、
 * 「落とすべきもの」と同じくらい「落としてはいけないもの」を厚く確認する。
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { coreContent, extractMarker, looksLikeNoise } from "../_shared/triage.ts";

const MARKERS = ["#fb", "#feedback", "#フィードバック", "#要望", "#不具合"];

// =============================================================================
// 明示マーク
// =============================================================================
Deno.test("明示マークを検出して本文から取り除く", () => {
  const r = extractMarker("#fb 検索が遅いです", MARKERS);
  assertEquals(r.marked, true);
  assertEquals(r.marker, "#fb");
  assertEquals(r.text, "検索が遅いです");
});

Deno.test("マークが文末にあっても検出する", () => {
  const r = extractMarker("検索が遅いです #要望", MARKERS);
  assertEquals(r.marked, true);
  assertEquals(r.text, "検索が遅いです");
});

Deno.test("マークの大文字小文字を区別しない", () => {
  const r = extractMarker("#FB 直してほしい", MARKERS);
  assertEquals(r.marked, true);
  assertEquals(r.text, "直してほしい");
});

Deno.test("マークだけの投稿では原文を残す（本文が消えるのを防ぐ）", () => {
  const r = extractMarker("#fb", MARKERS);
  assertEquals(r.marked, true);
  assertEquals(r.text, "#fb");
});

Deno.test("マークが無ければ本文を変えない", () => {
  const r = extractMarker("検索が遅いです", MARKERS);
  assertEquals(r.marked, false);
  assertEquals(r.text, "検索が遅いです");
});

// =============================================================================
// ノイズ判定: 落とすもの
// =============================================================================
Deno.test("相槌だけの投稿はノイズ", () => {
  for (const text of [
    "了解です",
    "ありがとうございます！",
    "お疲れ様です",
    "確認しました",
    "OK",
    "LGTM",
    "thanks!",
    "はい",
  ]) {
    const v = looksLikeNoise(text, { minLength: 6, extraPatterns: [] });
    assert(v.noise, `"${text}" はノイズとして落とされるべき`);
  }
});

Deno.test("URL だけ / 絵文字だけ / メンションだけはノイズ", () => {
  const cases: Array<[string, string]> = [
    ["https://example.com/deploy/1234", "url_only"],
    ["👍", "no_text_content"],
    ["🎉🎉🎉", "no_text_content"],
    ["@sato", "no_text_content"],
  ];
  for (const [text, reason] of cases) {
    const v = looksLikeNoise(text, { minLength: 6, extraPatterns: [] });
    assert(v.noise, `"${text}" はノイズとして落とされるべき`);
    assertEquals(v.reason, reason);
  }
});

Deno.test("空文字はノイズ", () => {
  assertEquals(looksLikeNoise("   ", { extraPatterns: [] }).reason, "empty");
});

Deno.test("NOISE_PATTERNS で自動通知の定型文を落とせる", () => {
  const patterns = [/^\[Deploy\]/i, /^Build #\d+/i];
  const v = looksLikeNoise("[Deploy] production に v1.2.3 をリリースしました", {
    extraPatterns: patterns,
  });
  assert(v.noise);
  assert(v.reason?.startsWith("matched_pattern:"));

  const v2 = looksLikeNoise("Build #482 failed on main", { extraPatterns: patterns });
  assert(v2.noise);
});

// =============================================================================
// ノイズ判定: 落としてはいけないもの
// =============================================================================
Deno.test("短くても具体的な不満は残す", () => {
  for (const text of [
    "検索が遅いです",
    "ログインできません",
    "CSV 出力が欲しい",
    "文字が小さくて読めない",
    "保存ボタンが効かない",
  ]) {
    const v = looksLikeNoise(text, { minLength: 6, extraPatterns: [] });
    assertFalse(v.noise, `"${text}" は残すべき（reason=${v.reason}）`);
  }
});

Deno.test("相槌に続けて中身がある投稿は残す", () => {
  const v = looksLikeNoise("ありがとうございます。ただ検索が遅いのが気になります", {
    minLength: 6,
    extraPatterns: [],
  });
  assertFalse(v.noise);
});

Deno.test("URL と一緒に本文がある投稿は残す", () => {
  const v = looksLikeNoise("この画面が固まります https://mysupport.example.com/apply", {
    minLength: 6,
    extraPatterns: [],
  });
  assertFalse(v.noise);
});

Deno.test("メンション付きの報告は残す", () => {
  const v = looksLikeNoise("@sato お客様からログインできないと連絡がありました", {
    minLength: 6,
    extraPatterns: [],
  });
  assertFalse(v.noise);
});

// =============================================================================
// coreContent
// =============================================================================
Deno.test("coreContent は装飾を落として中身だけ残す", () => {
  assertEquals(
    coreContent("@sato :tada: 検索が遅い！ https://example.com #fb"),
    "検索が遅い",
  );
  assertEquals(coreContent("👍👍👍"), "");
  assertEquals(coreContent("https://example.com"), "");
});
