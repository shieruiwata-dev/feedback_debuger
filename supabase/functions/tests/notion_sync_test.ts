/**
 * notion-sync の結合テスト
 *   deno test --allow-all --config supabase/functions/deno.json \
 *     supabase/functions/tests/notion_sync_test.ts
 *
 * Notion の API と PostgREST の両方をスタブに差し替え、
 * Edge Function を子プロセスとして起動して HTTP レベルで確認する。
 *
 * 本物の Notion には繋がないので、確かめられるのは
 * 「こちらが何をどの順で送るか」まで。相手の受け取り方は docs/NOTION.md の
 * 手順（dry_run → 1 件同期）で実際のワークスペースに対して確認すること。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const STUB_PORT = 9913;
const FUNCTION_PORT = 8000;
const DATABASE_ID = "dddddddddddddddddddddddddddddddd";
const CLUSTER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ITEM_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface StubOptions {
  /** notion_sync_queue が返すクラスタ。既定は未同期 1 件 */
  queue?: Array<Record<string, unknown>>;
  /** Notion のデータベースのプロパティ定義 */
  schema?: Record<string, { type: string }>;
  /** ページ更新で 404 を返す（Notion 側で消された状況） */
  pageMissing?: boolean;
  /** プロパティ更新で 400 を返す（セレクトの選択肢が無い等） */
  rejectProperties?: boolean;
  orphans?: Array<{ page_id: string }>;
}

const DEFAULT_SCHEMA = {
  "論点": { type: "title" },
  "スコア": { type: "number" },
  "件数": { type: "number" },
  "優先度": { type: "select" },
  "種別": { type: "select" },
  "最終更新": { type: "date" },
  "担当": { type: "people" },
  "ステータス": { type: "status" },
};

const DEFAULT_CLUSTER = {
  cluster_id: CLUSTER_ID,
  app_id: "11111111-1111-4111-8111-111111111111",
  app_name: "マイサポ",
  summary: "入力内容が保存されず失われる",
  priority: "urgent",
  category: "bug",
  status: "new",
  item_count: 2,
  score: "150.0000",
  notion_page_id: null,
  created_at: "2026-08-12T01:00:00Z",
  updated_at: "2026-08-12T02:00:00Z",
};

const ITEMS = [
  {
    item_id: ITEM_A,
    raw_text: "そもそも保存もできてないっぽいです。入れた内容がどこにも残ってない。",
    summary: "入力内容が保存されない",
    source_type: "slack",
    permalink: "https://example.slack.com/archives/C1/p1",
    author: "佐藤",
    created_at: "2026-08-12T01:00:00Z",
  },
  {
    item_id: ITEM_B,
    raw_text: "記録つけて画面閉じたら中身が全部消えてたらしいです。",
    summary: "記録が保存されず消える",
    source_type: "slack",
    permalink: "https://example.slack.com/archives/C1/p2",
    author: "鈴木",
    created_at: "2026-08-12T01:30:00Z",
  },
];

function startStub(recorded: Recorded[], opts: StubOptions = {}) {
  return Deno.serve({ port: STUB_PORT, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.method === "GET" ? null : await req.json().catch(() => null);
    recorded.push({ method: req.method, path: url.pathname, body });

    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });

    // --- Notion API --------------------------------------------------------
    if (url.pathname === `/notion/databases/${DATABASE_ID}`) {
      return reply({ properties: opts.schema ?? DEFAULT_SCHEMA });
    }

    if (url.pathname === "/notion/pages" && req.method === "POST") {
      if (opts.rejectProperties && hasSelect(body)) {
        return reply({ code: "validation_error", message: "選択肢がありません" }, 400);
      }
      return reply({ id: "page-new" });
    }

    if (url.pathname.startsWith("/notion/pages/") && req.method === "PATCH") {
      if (opts.pageMissing) {
        return reply({ code: "object_not_found", message: "見つかりません" }, 404);
      }
      if (opts.rejectProperties && hasSelect(body)) {
        return reply({ code: "validation_error", message: "選択肢がありません" }, 400);
      }
      return reply({ id: url.pathname.split("/").at(-1) });
    }

    if (url.pathname.endsWith("/children") && req.method === "PATCH") {
      const children = (body as { children?: unknown[] })?.children ?? [];
      return reply({ results: children.map((_, i) => ({ id: `block-${i + 1}` })) });
    }

    // --- PostgREST ---------------------------------------------------------
    if (url.pathname === "/rest/v1/rpc/notion_sync_queue") {
      return reply(opts.queue ?? [DEFAULT_CLUSTER]);
    }
    if (url.pathname === "/rest/v1/rpc/notion_pending_items") {
      return reply(ITEMS);
    }
    if (url.pathname === "/rest/v1/notion_orphan_pages") {
      return reply(opts.orphans ?? []);
    }
    if (url.pathname === "/rest/v1/app_settings") {
      const key = url.searchParams.get("key") ?? "";
      if (key.includes("property_map")) {
        return reply({
          value: {
            score: "スコア",
            item_count: "件数",
            priority: "優先度",
            category: "種別",
            app_name: "アプリ",
            last_updated: "最終更新",
          },
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      return reply(null);
    }

    return new Response("not found", { status: 404 });
  });
}

function hasSelect(body: unknown): boolean {
  const props = (body as { properties?: Record<string, unknown> })?.properties ?? {};
  return Object.values(props).some((v) => v !== null && typeof v === "object" && "select" in v!);
}

function resolveEntrypoint(): { path: string; useConfig: boolean } {
  const bundleDir = Deno.env.get("FN_BUNDLE_DIR");
  if (!bundleDir) {
    return {
      path: new URL("../notion-sync/index.ts", import.meta.url).pathname,
      useConfig: true,
    };
  }
  return { path: `${Deno.cwd()}/${bundleDir}/notion-sync.ts`, useConfig: false };
}

async function startFunction(env: Record<string, string> = {}) {
  const resolved = resolveEntrypoint();
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      ...(resolved.useConfig
        ? ["--config", new URL("../deno.json", import.meta.url).pathname]
        : []),
      resolved.path,
    ],
    env: {
      SUPABASE_URL: `http://localhost:${STUB_PORT}`,
      SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
      NOTION_API_BASE_URL: `http://localhost:${STUB_PORT}/notion`,
      NOTION_TOKEN: "ntn_stub",
      NOTION_DATABASE_ID: DATABASE_ID,
      ENABLE_NOTION_SYNC: "true",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://localhost:${FUNCTION_PORT}/`, { method: "OPTIONS" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return proc;
}

async function stopFunction(proc: Deno.ChildProcess) {
  try {
    proc.kill("SIGKILL");
  } catch { /* already gone */ }
  await proc.status;
  await proc.stdout.cancel();
  await proc.stderr.cancel();
}

const call = (body: unknown) =>
  fetch(`http://localhost:${FUNCTION_PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const notionCalls = (r: Recorded[]) => r.filter((x) => x.path.startsWith("/notion"));
const rpcCalls = (r: Recorded[], name: string) =>
  r.filter((x) => x.path === `/rest/v1/rpc/${name}`);

// =============================================================================

Deno.test("dry_run は書き込まずにプロパティ一覧だけ返す", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded);
  const fn = await startFunction();

  try {
    const res = await call({ dry_run: true });
    const body = await res.json();

    assertEquals(res.status, 200);
    assertEquals(body.title_property, "論点");
    assert(body.properties.includes("スコア (number)"));

    // 疎通確認なので、読み取り以外は一切叩かない
    const writes = notionCalls(recorded).filter((c) => c.method !== "GET");
    assertEquals(writes, []);
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("未同期のクラスタはページを作り、本文に元投稿を並べる", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded);
  const fn = await startFunction();

  try {
    const res = await call({});
    const body = await res.json();

    assertEquals(res.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.synced, 1);
    assertEquals(body.results[0].action, "created");
    assertEquals(body.results[0].items_appended, 2);

    // ページ作成: タイトルと数値・セレクトが載っている
    const create = recorded.find((c) => c.path === "/notion/pages");
    const props = (create?.body as { properties: Record<string, unknown> }).properties;
    assertEquals(
      (props["論点"] as { title: Array<{ text: { content: string } }> }).title[0].text.content,
      "入力内容が保存されず失われる",
    );
    assertEquals(props["スコア"], { number: 150 });
    assertEquals(props["件数"], { number: 2 });
    assertEquals(props["優先度"], { select: { name: "urgent" } });

    // 人が使う列（担当・ステータス）には触れない
    assert(!("担当" in props));
    assert(!("ステータス" in props));

    // 本文: item ごとに 1 ブロック、Slack へのリンク付き
    const append = recorded.find((c) => c.path.endsWith("/children"));
    const children = (append?.body as { children: Array<Record<string, never>> }).children;
    assertEquals(children.length, 2);
    assertStringIncludesDeep(children[0], "そもそも保存もできてない");
    assertStringIncludesDeep(children[0], "https://example.slack.com/archives/C1/p1");
    assertStringIncludesDeep(children[1], "鈴木");

    // 追記したブロックを item に紐づけて、次回の二重追記を防ぐ
    const marks = rpcCalls(recorded, "mark_item_notion_block");
    assertEquals(marks.length, 2);
    assertEquals((marks[0].body as { p_item_id: string }).p_item_id, ITEM_A);
    assertEquals((marks[0].body as { p_block_id: string }).p_block_id, "block-1");

    // 同期済みの記録
    const synced = rpcCalls(recorded, "mark_cluster_notion_synced");
    assertEquals((synced[0].body as { p_page_id: string }).p_page_id, "page-new");
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("同期済みのクラスタはページを作り直さず更新する", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, {
    queue: [{ ...DEFAULT_CLUSTER, notion_page_id: "page-existing" }],
  });
  const fn = await startFunction();

  try {
    const body = await (await call({})).json();

    assertEquals(body.results[0].action, "updated");
    assertEquals(recorded.filter((c) => c.path === "/notion/pages").length, 0);
    assert(recorded.some((c) => c.path === "/notion/pages/page-existing" && c.method === "PATCH"));
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("Notion 側でページが消されていたら作り直す", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, {
    queue: [{ ...DEFAULT_CLUSTER, notion_page_id: "page-deleted" }],
    pageMissing: true,
  });
  const fn = await startFunction();

  try {
    const body = await (await call({})).json();

    assertEquals(body.ok, true);
    assertEquals(body.results[0].action, "recreated");
    // 古いブロック ID は無効になるので item 側の目印も消す
    assertEquals(rpcCalls(recorded, "clear_cluster_notion_page").length, 1);
    assert(recorded.some((c) => c.path === "/notion/pages" && c.method === "POST"));
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("セレクトが拒否されたら、その項目を落として残りを書く", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, { rejectProperties: true });
  const fn = await startFunction();

  try {
    const body = await (await call({})).json();

    // 論点が Notion に載らないほうが困るので、欠けても作りきる
    assertEquals(body.ok, true);
    assertEquals(body.results[0].action, "created");

    const creates = recorded.filter((c) => c.path === "/notion/pages");
    assertEquals(creates.length, 2); // 1 回目が 400、2 回目で通す

    const retried = (creates[1].body as { properties: Record<string, unknown> }).properties;
    assert(!("優先度" in retried));
    assert("論点" in retried);
    assertEquals(retried["スコア"], { number: 150 });
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("property_map と噛み合わない項目は報告する", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, {
    schema: { "Name": { type: "title" }, "Count": { type: "number" } },
  });
  const fn = await startFunction();

  try {
    const body = await (await call({})).json();

    assertEquals(body.ok, true);
    // 設定ミスに気づけるよう、噛み合わなかった項目を返す
    assert(body.skipped_properties.length > 0);
    assert(body.skipped_properties.some((s: string) => s.includes("スコア")));

    const props = (recorded.find((c) => c.path === "/notion/pages")
      ?.body as { properties: Record<string, unknown> }).properties;
    assert("Name" in props);
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("削除されたクラスタのページはアーカイブする", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, {
    queue: [],
    orphans: [{ page_id: "page-orphan" }],
  });
  const fn = await startFunction();

  try {
    const body = await (await call({})).json();

    assertEquals(body.archived, 1);
    const archive = recorded.find((c) => c.path === "/notion/pages/page-orphan");
    assertEquals((archive?.body as { archived: boolean }).archived, true);
    assertEquals(rpcCalls(recorded, "mark_notion_orphan_archived").length, 1);
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

Deno.test("ENABLE_NOTION_SYNC が false なら何もしない", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded);
  const fn = await startFunction({ ENABLE_NOTION_SYNC: "false" });

  try {
    const res = await call({});
    assertEquals(res.status, 409);
    await res.body?.cancel();
    assertEquals(notionCalls(recorded), []);
  } finally {
    await stopFunction(fn);
    await stub.shutdown();
  }
});

/** ブロックは入れ子が深いので、JSON 全体に文字列が含まれるかで確認する */
function assertStringIncludesDeep(value: unknown, needle: string) {
  assert(
    JSON.stringify(value).includes(needle),
    `${needle} が見つからない: ${JSON.stringify(value).slice(0, 200)}`,
  );
}
