/**
 * 取り込みアダプタの結合テスト
 *   deno test --allow-all supabase/functions/tests/integration_test.ts
 *
 * 実際の Edge Function を子プロセスとして起動し、Supabase(PostgREST) の代わりに
 * スタブサーバーを立てて HTTP レベルで検証する。
 * Dify / 埋め込み API は ENABLE_AI_ENRICHMENT=false で呼ばれないようにしてある
 * （分類・クラスタリングのロジックは supabase/tests/*.sql 側で検証する）。
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const STUB_PORT = 9911;
const FUNCTION_PORT = 8000;
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLACK_SECRET = "test_signing_secret";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** スタブが返す既存 item の状態（重複・復帰の分岐を作るのに使う） */
interface StubState {
  duplicate?: boolean;
  /** 既存 item の status。'ignored' なら復帰経路に入る */
  existingStatus?: string;
  /** conversations.history が返すメッセージ */
  reactedMessage?: Record<string, unknown> | null;
}

/** PostgREST のうち、本コードが実際に叩く経路だけを模したスタブ */
function startStub(recorded: Recorded[], opts: StubState = {}) {
  return Deno.serve({ port: STUB_PORT, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    recorded.push({ method: req.method, path: url.pathname + url.search, body });

    const wantsObject = (req.headers.get("accept") ?? "").includes("pgrst.object");
    const reply = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/rest/v1/apps") {
      const row = { id: APP_ID, name: "マイサポ" };
      if (url.searchParams.get("slug") === "eq.unknown-app") {
        return wantsObject
          ? new Response(null, { status: 204 })
          : reply([]);
      }
      return reply(wantsObject ? row : [row]);
    }

    if (url.pathname === "/rest/v1/feedback_sources") {
      const row = { app_id: APP_ID };
      return reply(wantsObject ? row : [row]);
    }

    if (url.pathname === "/rest/v1/rpc/check_rate_limit") {
      return reply(true);
    }

    // --- Slack Web API のスタブ ---------------------------------------------
    if (url.pathname === "/api/conversations.history") {
      if (opts.reactedMessage === null) return reply({ ok: false, error: "not_found" });
      return reply({ ok: true, messages: [opts.reactedMessage] });
    }
    if (url.pathname === "/api/chat.getPermalink") {
      return reply({ ok: true, permalink: "https://example.slack.com/archives/C1/p1" });
    }
    if (url.pathname === "/api/users.info") {
      return reply({ ok: true, user: { real_name: "佐藤" } });
    }

    if (url.pathname === "/rest/v1/rpc/restore_feedback_item") {
      return reply({ id: "22222222-2222-4222-8222-222222222222", status: "new" });
    }

    if (url.pathname === "/rest/v1/feedback_items" && req.method === "GET") {
      // 復帰経路が既存行を引くための応答
      const row = {
        id: "22222222-2222-4222-8222-222222222222",
        status: opts.existingStatus ?? "new",
      };
      return reply(wantsObject ? row : [row]);
    }

    if (url.pathname === "/rest/v1/feedback_items") {
      if (opts.duplicate) {
        return new Response(
          JSON.stringify({
            code: "23505",
            message: "duplicate key value violates unique constraint",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      const row = { id: "11111111-1111-4111-8111-111111111111" };
      return reply(wantsObject ? row : [row]);
    }

    return new Response("not found", { status: 404 });
  });
}

async function startFunction(entrypoint: string, env: Record<string, string> = {}) {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      new URL(entrypoint, import.meta.url).pathname,
    ],
    env: {
      SUPABASE_URL: `http://localhost:${STUB_PORT}`,
      SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
      SLACK_SIGNING_SECRET: SLACK_SECRET,
      SLACK_BOT_TOKEN: "xoxb-stub-token",
      SLACK_API_BASE_URL: `http://localhost:${STUB_PORT}/api`,
      ENABLE_AI_ENRICHMENT: "false",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // 起動待ち
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://localhost:${FUNCTION_PORT}/`, { method: "OPTIONS" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return cmd;
}

async function stopFunction(proc: Deno.ChildProcess) {
  try {
    proc.kill("SIGKILL");
  } catch { /* already gone */ }
  await proc.status;
  await proc.stdout.cancel();
  await proc.stderr.cancel();
}

const call = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${FUNCTION_PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// =============================================================================
// submit-feedback
// =============================================================================
Deno.test("submit-feedback: 取り込みアダプタとして正しく動く", async (t) => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded);
  const proc = await startFunction("../submit-feedback/index.ts");

  try {
    await t.step("正常系: 共通フォーマットに正規化して insert する", async () => {
      recorded.length = 0;
      const res = await call({
        app_slug: "mysupport",
        message: "検索が遅いです",
        email: "user@example.com",
        page_url: "https://mysupport.example.com/search",
      });

      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, status: "inserted" });

      const insert = recorded.find((r) => r.path.startsWith("/rest/v1/feedback_items"));
      const row = insert!.body as Record<string, unknown>;
      assertEquals(row.app_id, APP_ID);
      assertEquals(row.source_type, "form");
      assertEquals(row.raw_text, "検索が遅いです");
      // AI 無効時は enrichment を走らせない
      assertEquals(row.processing_state, "skipped");

      const meta = row.source_meta as Record<string, unknown>;
      assertEquals(meta.submitter_email, "user@example.com");
      assertEquals(meta.page_url, "https://mysupport.example.com/search");
      assertStringIncludes(String(row.external_id), "form:");
    });

    await t.step("app_slug が無ければ 400", async () => {
      const res = await call({ message: "本文だけ" });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("本文が空なら 400", async () => {
      const res = await call({ app_slug: "mysupport", message: "   " });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("5000 文字を超える本文は 400", async () => {
      const res = await call({ app_slug: "mysupport", message: "あ".repeat(5001) });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("未登録の app_slug は 404", async () => {
      const res = await call({ app_slug: "unknown-app", message: "本文" });
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });

    await t.step("ハニーポットが埋まっていたら DB に触れず握りつぶす", async () => {
      recorded.length = 0;
      const res = await call({
        app_slug: "mysupport",
        message: "スパム投稿",
        _hp: "bot が埋めた値",
      });

      // ボットに検知を悟らせないため 200 を返す
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, status: "inserted" });
      assertEquals(recorded.length, 0);
    });

    await t.step("不正な JSON は 400", async () => {
      const res = await call("{壊れた");
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("GET は 405", async () => {
      const res = await fetch(`http://localhost:${FUNCTION_PORT}/`);
      assertEquals(res.status, 405);
      await res.body?.cancel();
    });

    await t.step("CORS プリフライトに応答する", async () => {
      const res = await fetch(`http://localhost:${FUNCTION_PORT}/`, { method: "OPTIONS" });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("access-control-allow-origin"), "*");
      await res.body?.cancel();
    });
  } finally {
    await stopFunction(proc);
    await stub.shutdown();
  }
});

// =============================================================================
// slack-events
// =============================================================================
Deno.test("slack-events: 署名検証と正規化", async (t) => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded);
  const proc = await startFunction("../slack-events/index.ts");

  const sign = async (body: string, ts: string) => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SLACK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${ts}:${body}`),
    );
    return "v0=" +
      Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  const send = async (payload: unknown, tamper = false) => {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await sign(tamper ? body + "x" : body, ts);
    return call(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signature,
    });
  };

  try {
    await t.step("署名が不正なら 401（DB に触らない）", async () => {
      recorded.length = 0;
      const res = await send({ type: "event_callback" }, true);
      assertEquals(res.status, 401);
      assertEquals(recorded.length, 0);
      await res.body?.cancel();
    });

    await t.step("署名ヘッダが無ければ 401", async () => {
      const res = await call({ type: "event_callback" });
      assertEquals(res.status, 401);
      await res.body?.cancel();
    });

    await t.step("url_verification に challenge を返す", async () => {
      const res = await send({ type: "url_verification", challenge: "abc123" });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { challenge: "abc123" });
    });

    await t.step("message イベントを共通フォーマットに正規化して insert する", async () => {
      recorded.length = 0;
      const res = await send({
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          channel: "C0BKRLGJQ3Z",
          user: "U999",
          text: "<@U111|sato> 検索が遅いです <https://example.com|詳細>",
          ts: "1754300000.000100",
        },
      });

      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });

      // 取り込みはバックグラウンドで走るので少し待つ
      await new Promise((r) => setTimeout(r, 500));

      const insert = recorded.find((r) =>
        r.method === "POST" && r.path.startsWith("/rest/v1/feedback_items")
      );
      const row = insert!.body as Record<string, unknown>;
      assertEquals(row.app_id, APP_ID);
      assertEquals(row.source_type, "slack");
      // Slack 記法がプレーンテキストに変換されている
      assertEquals(row.raw_text, "@sato 検索が遅いです 詳細 (https://example.com)");
      // 重複排除キー
      assertEquals(row.external_id, "C0BKRLGJQ3Z:1754300000.000100");

      const meta = row.source_meta as Record<string, unknown>;
      assertEquals(meta.channel_id, "C0BKRLGJQ3Z");
      assertEquals(meta.message_ts, "1754300000.000100");
      assertEquals(meta.slack_user_id, "U999");
      assertEquals(meta.team_id, "T123");
    });

    await t.step("bot の発言は取り込まない", async () => {
      recorded.length = 0;
      const res = await send({
        type: "event_callback",
        event: {
          type: "message",
          bot_id: "B123",
          channel: "C0BKRLGJQ3Z",
          user: "U999",
          text: "bot の投稿",
          ts: "1754300000.000200",
        },
      });

      assertEquals((await res.json()).skipped, "not_ingestable");
      await new Promise((r) => setTimeout(r, 200));
      assertEquals(recorded.length, 0);
    });

    await t.step("編集イベントは取り込まない", async () => {
      const res = await send({
        type: "event_callback",
        event: {
          type: "message",
          subtype: "message_changed",
          channel: "C0BKRLGJQ3Z",
          user: "U999",
          text: "編集後のテキスト",
          ts: "1754300000.000300",
        },
      });
      assertEquals((await res.json()).skipped, "not_ingestable");
    });
  } finally {
    await stopFunction(proc);
    await stub.shutdown();
  }
});

// =============================================================================
// 重複排除
// =============================================================================
Deno.test("submit-feedback: unique 制約違反は duplicate として扱う", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, { duplicate: true });
  const proc = await startFunction("../submit-feedback/index.ts");

  try {
    const res = await call({ app_slug: "mysupport", message: "重複する投稿" });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true, status: "duplicate" });
  } finally {
    await stopFunction(proc);
    await stub.shutdown();
  }
});

// =============================================================================
// フィードバック選別（ノイズ除去）
// =============================================================================
Deno.test("slack-events: ノイズは insert せずに捨てる", async (t) => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded);
  const proc = await startFunction("../slack-events/index.ts");

  const sendMessage = async (text: string) => {
    recorded.length = 0;
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        channel: "C0BKRLGJQ3Z",
        user: "U999",
        text,
        ts: `1754300000.${Math.abs(hashCode(text))}`,
      },
    };
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await call(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await signSlack(body, ts),
    });
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 400));
    return recorded.find((r) =>
      r.method === "POST" && r.path.startsWith("/rest/v1/feedback_items")
    );
  };

  try {
    await t.step("相槌だけの投稿は DB に届かない", async () => {
      assertEquals(await sendMessage("了解です！"), undefined);
      assertEquals(await sendMessage("ありがとうございます"), undefined);
      assertEquals(await sendMessage("👍"), undefined);
    });

    await t.step("URL だけの自動通知は DB に届かない", async () => {
      assertEquals(await sendMessage("https://ci.example.com/builds/4821"), undefined);
    });

    await t.step("具体的な不満はきちんと取り込む", async () => {
      const insert = await sendMessage("検索が遅くて5秒くらい待たされます");
      const row = insert!.body as Record<string, unknown>;
      assertEquals(row.raw_text, "検索が遅くて5秒くらい待たされます");
      // AI 判定に委ねるので、この時点では未判定
      assertEquals(row.is_feedback, null);
    });

    await t.step("#fb マークが付いていれば短い投稿でも取り込む", async () => {
      // マーク無しなら相槌として落ちる文面
      assertEquals(await sendMessage("重いです"), undefined);

      const insert = await sendMessage("#fb 重いです");
      const row = insert!.body as Record<string, unknown>;
      // マークは本文から取り除かれる（要約と埋め込みに混ぜない）
      assertEquals(row.raw_text, "重いです");
      // 明示マーク済みは AI トリアージの対象外にする
      assertEquals(row.is_feedback, true);
      assertEquals(row.triage_reason, "marker:#fb");
    });
  } finally {
    await stopFunction(proc);
    await stub.shutdown();
  }
});

// =============================================================================
// 📮 リアクションによる「あとから拾う」経路
// =============================================================================
Deno.test("slack-events: リアクションで過去の投稿を拾い上げる", async (t) => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, {
    reactedMessage: {
      ts: "1754200000.000100",
      user: "U777",
      text: "この画面、前からこうだったっけ",
    },
  });
  const proc = await startFunction("../slack-events/index.ts");

  const react = async (reaction: string) => {
    recorded.length = 0;
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "reaction_added",
        reaction,
        user: "U100",
        item: { type: "message", channel: "C0BKRLGJQ3Z", ts: "1754200000.000100" },
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await call(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await signSlack(body, ts),
    });
    const json = await res.json();
    await new Promise((r) => setTimeout(r, 500));
    return json;
  };

  try {
    await t.step("対象外の絵文字は無視する", async () => {
      const json = await react("thumbsup");
      assertEquals(json.skipped, "not_a_feedback_reaction");
      assertEquals(
        recorded.filter((r) => r.path.startsWith("/rest/v1/feedback_items")).length,
        0,
      );
    });

    await t.step("📮 が付いたら元メッセージを取得して取り込む", async () => {
      const json = await react("inbox_tray");
      assertEquals(json, { ok: true });

      const insert = recorded.find((r) =>
        r.method === "POST" && r.path.startsWith("/rest/v1/feedback_items")
      );
      const row = insert!.body as Record<string, unknown>;
      assertEquals(row.raw_text, "この画面、前からこうだったっけ");
      assertEquals(row.external_id, "C0BKRLGJQ3Z:1754200000.000100");
      // リアクションは明示マークなので AI 判定を飛ばす
      assertEquals(row.is_feedback, true);
      assertEquals(row.triage_reason, "reaction:inbox_tray");

      // 誰が拾ったかを残す
      const meta = row.source_meta as Record<string, unknown>;
      assertEquals(meta.flagged_by, "U100");
      assertEquals(meta.flagged_with, "inbox_tray");
    });
  } finally {
    await stopFunction(proc);
    await stub.shutdown();
  }
});

Deno.test("slack-events: ノイズ判定済みの投稿に📮が付いたら復帰させる", async () => {
  const recorded: Recorded[] = [];
  const stub = startStub(recorded, {
    // 既に取り込み済み（unique 違反）かつノイズ判定されている状態
    duplicate: true,
    existingStatus: "ignored",
    reactedMessage: {
      ts: "1754200000.000200",
      user: "U777",
      text: "検索の速度が気になる",
    },
  });
  const proc = await startFunction("../slack-events/index.ts");

  try {
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "reaction_added",
        reaction: "inbox_tray",
        user: "U100",
        item: { type: "message", channel: "C0BKRLGJQ3Z", ts: "1754200000.000200" },
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await call(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await signSlack(body, ts),
    });
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 600));

    // ノイズ判定を取り消す RPC が呼ばれる
    const restore = recorded.find((r) =>
      r.path.startsWith("/rest/v1/rpc/restore_feedback_item")
    );
    assertEquals(
      (restore!.body as Record<string, unknown>).p_item_id,
      "22222222-2222-4222-8222-222222222222",
    );
  } finally {
    await stopFunction(proc);
    await stub.shutdown();
  }
});

// --- ヘルパ -----------------------------------------------------------------
async function signSlack(body: string, ts: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${ts}:${body}`),
  );
  return "v0=" +
    Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** external_id を投稿ごとに変えるための簡易ハッシュ */
function hashCode(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
