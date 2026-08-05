/**
 * Slack アダプタの純粋ロジックのテスト
 *   deno test --allow-env supabase/functions/tests/
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  isIngestableMessage,
  slackTextToPlain,
  verifySlackSignature,
} from "../_shared/slack.ts";

const SECRET = "test_signing_secret";

/** Slack と同じ手順で署名を作る（検証側の実装とは独立に組み立てる） */
async function sign(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  return "v0=" +
    Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const now = () => String(Math.floor(Date.now() / 1000));

Deno.test("正しい署名は検証を通る", async () => {
  const body = '{"type":"event_callback"}';
  const ts = now();
  const result = await verifySlackSignature(body, ts, await sign(body, ts), SECRET);
  assertEquals(result.ok, true);
});

Deno.test("ボディが改ざんされた署名は弾く", async () => {
  const ts = now();
  const signature = await sign('{"type":"event_callback"}', ts);
  const result = await verifySlackSignature('{"type":"tampered"}', ts, signature, SECRET);
  assertEquals(result.ok, false);
});

Deno.test("署名シークレットが違えば弾く", async () => {
  const body = "hello";
  const ts = now();
  const result = await verifySlackSignature(body, ts, await sign(body, ts), "wrong_secret");
  assertEquals(result.ok, false);
});

Deno.test("古いタイムスタンプはリプレイとして弾く", async () => {
  const body = "hello";
  const ts = String(Math.floor(Date.now() / 1000) - 60 * 10);
  const result = await verifySlackSignature(body, ts, await sign(body, ts), SECRET);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "stale timestamp");
});

Deno.test("署名ヘッダが無ければ弾く", async () => {
  const result = await verifySlackSignature("hello", null, null, SECRET);
  assertEquals(result.ok, false);
});

Deno.test("取り込み対象の判定", () => {
  const base = { type: "message", channel: "C1", user: "U1", text: "困っています", ts: "1.1" };

  assertEquals(isIngestableMessage(base), true);
  // Bot 発言は無限ループの元なので拾わない
  assertEquals(isIngestableMessage({ ...base, bot_id: "B1" }), false);
  // 編集・削除・入退室は無視
  assertEquals(isIngestableMessage({ ...base, subtype: "message_changed" }), false);
  assertEquals(isIngestableMessage({ ...base, subtype: "channel_join" }), false);
  // ファイル添付付き投稿は拾う
  assertEquals(isIngestableMessage({ ...base, subtype: "file_share" }), true);
  // 本文が無いものは拾わない
  assertEquals(isIngestableMessage({ ...base, text: "   " }), false);
  assertEquals(isIngestableMessage({ ...base, type: "reaction_added" }), false);
});

Deno.test("Slack 記法をプレーンテキストに寄せる", () => {
  assertEquals(slackTextToPlain("<@U123|sato> さん確認お願いします"), "@sato さん確認お願いします");
  assertEquals(slackTextToPlain("<@U123> 確認お願いします"), "@U123 確認お願いします");
  assertEquals(slackTextToPlain("<#C123|general> に投稿"), "#general に投稿");
  assertEquals(
    slackTextToPlain("詳細は <https://example.com/a|こちら> を参照"),
    "詳細は こちら (https://example.com/a) を参照",
  );
  assertEquals(slackTextToPlain("<https://example.com>"), "https://example.com");
  assertEquals(slackTextToPlain("a &amp; b &lt;tag&gt;"), "a & b <tag>");
});
