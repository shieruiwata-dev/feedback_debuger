/**
 * Notion のプロパティ組み立てテスト
 *   deno test --allow-env --config supabase/functions/deno.json supabase/functions/tests/
 *
 * Notion 側のデータベースは別の人が作るため、名前も型もこちらの想定どおりとは限らない。
 * 「噛み合わなかったときに落ちずに読み飛ばす」ことが要件なので、そこを重点的に確認する。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildProperties,
  type ClusterForNotion,
  type ItemForNotion,
  itemBlock,
  type NotionSchema,
  titlePropertyName,
  toPropertyValue,
  __testing,
} from "../_shared/notion.ts";

function schemaOf(defs: Record<string, string>): NotionSchema {
  return new Map(Object.entries(defs).map(([name, type]) => [name, { name, type }]));
}

const CLUSTER: ClusterForNotion = {
  cluster_id: "11111111-1111-1111-1111-111111111111",
  app_name: "マイサポ",
  summary: "入力内容が保存されず失われる",
  priority: "urgent",
  category: "bug",
  item_count: 3,
  score: "150.0000",
  updated_at: "2026-08-12T02:00:00.000Z",
  notion_page_id: null,
};

const FULL_MAP = {
  score: "スコア",
  item_count: "件数",
  priority: "優先度",
  category: "種別",
  app_name: "アプリ",
  last_updated: "最終更新",
};

Deno.test("想定どおりのスキーマなら全項目を書く", () => {
  const schema = schemaOf({
    "論点": "title",
    "スコア": "number",
    "件数": "number",
    "優先度": "select",
    "種別": "select",
    "アプリ": "rich_text",
    "最終更新": "date",
  });

  const { properties, skipped } = buildProperties(CLUSTER, schema, FULL_MAP);

  assertEquals(skipped, []);
  assertEquals(
    (properties["論点"] as { title: Array<{ text: { content: string } }> }).title[0].text.content,
    "入力内容が保存されず失われる",
  );
  // numeric は Postgres から文字列で来るので数値に直す
  assertEquals(properties["スコア"], { number: 150 });
  assertEquals(properties["件数"], { number: 3 });
  assertEquals(properties["優先度"], { select: { name: "urgent" } });
  assertEquals(properties["最終更新"], { date: { start: "2026-08-12T02:00:00.000Z" } });
});

Deno.test("タイトルは名前ではなく型で探す", () => {
  const schema = schemaOf({ "Issue name": "title", "件数": "number" });
  assertEquals(titlePropertyName(schema), "Issue name");

  const { properties } = buildProperties(CLUSTER, schema, FULL_MAP);
  assert("Issue name" in properties);
});

Deno.test("Notion に無いプロパティは飛ばして、あるものだけ書く", () => {
  const schema = schemaOf({ "論点": "title", "件数": "number" });

  const { properties, skipped } = buildProperties(CLUSTER, schema, FULL_MAP);

  assertEquals(Object.keys(properties).sort(), ["件数", "論点"]);
  // 何が噛み合わなかったかは呼び出し元に報告する（設定ミスの発見用）
  // score / priority / category / app_name / last_updated の 5 つ
  assertEquals(skipped.length, 5);
  assert(skipped.some((s) => s.includes("スコア")));
});

Deno.test("こちらから書けない型は飛ばす", () => {
  const schema = schemaOf({
    "論点": "title",
    "スコア": "rollup", // 集計列。API から値を入れられない
    "件数": "formula",
    "優先度": "select",
  });

  const { properties, skipped } = buildProperties(CLUSTER, schema, FULL_MAP);

  assertEquals(Object.keys(properties).sort(), ["優先度", "論点"]);
  assert(skipped.some((s) => s.includes("rollup")));
  assert(skipped.some((s) => s.includes("formula")));
});

Deno.test("title 型のプロパティが無ければ報告する（同期自体は止めない）", () => {
  const schema = schemaOf({ "件数": "number" });

  const { properties, skipped } = buildProperties(CLUSTER, schema, FULL_MAP);

  assertEquals(properties, { "件数": { number: 3 } });
  assert(skipped.some((s) => s.startsWith("title")));
});

Deno.test("優先度・種別は読み替え表を通す", () => {
  const schema = schemaOf({ "論点": "title", "優先度": "select", "種別": "select" });

  const { properties } = buildProperties(CLUSTER, schema, FULL_MAP, {
    priority: { urgent: "緊急", high: "高", medium: "中", low: "低" },
    category: { bug: "不具合", feature_request: "要望", ux: "使いにくさ", other: "その他" },
  });

  assertEquals(properties["優先度"], { select: { name: "緊急" } });
  assertEquals(properties["種別"], { select: { name: "不具合" } });
});

Deno.test("property_map で null にした項目は書かない", () => {
  const schema = schemaOf({ "論点": "title", "スコア": "number", "件数": "number" });

  const { properties, skipped } = buildProperties(CLUSTER, schema, {
    ...FULL_MAP,
    score: null,
  });

  assert(!("スコア" in properties));
  // 意図して外したものは「噛み合わなかった」報告に混ぜない
  assert(!skipped.some((s) => s.includes("スコア")));
});

Deno.test("要約が無くてもタイトルを空にしない", () => {
  const schema = schemaOf({ "論点": "title" });
  const { properties } = buildProperties({ ...CLUSTER, summary: null }, schema, FULL_MAP);

  const title = (properties["論点"] as { title: Array<{ text: { content: string } }> }).title;
  assertEquals(title[0].text.content, "(要約なし)");
});

Deno.test("2000 字を超えるテキストは分割する（Notion の上限）", () => {
  const long = "あ".repeat(4500);
  const chunks = __testing.chunkText(long);

  assertEquals(chunks.length, 3);
  assertEquals(chunks[0].length, 2000);
  assertEquals(chunks[2].length, 500);
  assertEquals(chunks.join(""), long);

  const schema = schemaOf({ "論点": "title" });
  const { properties } = buildProperties({ ...CLUSTER, summary: long }, schema, FULL_MAP);
  assertEquals((properties["論点"] as { title: unknown[] }).title.length, 3);
});

Deno.test("空文字は書き込まない（Notion 側の既存値を消さないため）", () => {
  assertEquals(toPropertyValue("rich_text", ""), null);
  assertEquals(toPropertyValue("number", null), null);
  assertEquals(toPropertyValue("select", undefined), null);
  // 0 件・スコア 0・false は「値が無い」ではないので書き込む
  assertEquals(toPropertyValue("number", 0), { number: 0 });
  assertEquals(toPropertyValue("checkbox", false), { checkbox: false });
});

const ITEM: ItemForNotion = {
  item_id: "22222222-2222-2222-2222-222222222222",
  raw_text: "記録つけて画面閉じたら中身が全部消えてた",
  summary: "記録が保存されない",
  source_type: "slack",
  permalink: "https://example.slack.com/archives/C1/p1",
  author: "田中",
  created_at: "2026-08-12T02:00:00.000Z",
};

Deno.test("元投稿のブロックに本文と Slack へのリンクが入る", () => {
  const block = itemBlock(ITEM) as {
    type: string;
    callout: {
      rich_text: Array<{ text: { content: string } }>;
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string; link: unknown } }> } }>;
    };
  };

  assertEquals(block.type, "callout");
  assertEquals(block.callout.rich_text[0].text.content, ITEM.raw_text);

  const meta = block.callout.children[0].paragraph.rich_text;
  assert(meta.some((t) => t.text.content.includes("田中")));
  assert(meta.some((t) => t.text.content.includes("2026-08-12")));
  assertEquals(meta.at(-1)?.text.link, { url: ITEM.permalink });
});

Deno.test("permalink が無い投稿でもブロックは作れる", () => {
  const block = itemBlock({ ...ITEM, permalink: null, author: null, source_type: "form" }) as {
    callout: {
      icon: { emoji: string };
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>;
    };
  };

  assertEquals(block.callout.icon.emoji, "📝");
  const meta = block.callout.children[0].paragraph.rich_text;
  assertEquals(meta[0].text.content, "2026-08-12");
});
