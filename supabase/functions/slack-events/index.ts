/**
 * Slack Events API 受信アダプタ
 *
 * エンドポイント: POST /functions/v1/slack-events
 *
 * 処理の流れ
 *   1. 署名検証（必須。失敗は 401）
 *   2. url_verification なら challenge を返す
 *   3. message イベントを共通フォーマットへ正規化
 *   4. channel ID から feedback_sources を逆引きして app_id を決定
 *      → 登録の無いチャンネルのメッセージは黙って捨てる（誤取り込み防止）
 *   5. ingestFeedback() に渡す
 *
 * Slack は 3 秒以内に 200 を返さないとリトライしてくるため、
 * 重い処理（Dify 呼び出し）は ingest 側でバックグラウンド化している。
 *
 * デプロイ時は JWT 検証を無効化すること:
 *   supabase functions deploy slack-events --no-verify-jwt
 */
import { requireEnv } from "../_shared/env.ts";
import { json, runBackground } from "../_shared/http.ts";
import { resolveAppBySource, serviceClient } from "../_shared/supabase.ts";
import { ingestFeedback } from "../_shared/ingest.ts";
import {
  fetchPermalink,
  fetchUserName,
  isIngestableMessage,
  type SlackMessageEvent,
  slackTextToPlain,
  verifySlackSignature,
} from "../_shared/slack.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  const rawBody = await req.text();

  const verified = await verifySlackSignature(
    rawBody,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    requireEnv("SLACK_SIGNING_SECRET"),
  );

  if (!verified.ok) {
    console.warn("slack signature rejected:", verified.reason);
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid json" }, { status: 400 });
  }

  // Event Subscriptions の URL 検証
  if (payload.type === "url_verification") {
    return json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") {
    return json({ ok: true, skipped: "unsupported_payload_type" });
  }

  const event = payload.event as SlackMessageEvent | undefined;
  if (!event || !isIngestableMessage(event)) {
    return json({ ok: true, skipped: "not_ingestable" });
  }

  // Slack のリトライは重複 insert を招くが、external_id の unique 制約で吸収される。
  // ここでは即座に 200 を返しつつ、取り込みはバックグラウンドで完了させる。
  runBackground(handleMessage(event, payload));

  return json({ ok: true });
});

async function handleMessage(
  event: SlackMessageEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = serviceClient();
  const channel = event.channel!;

  const appId = await resolveAppBySource(db, "slack", channel);
  if (!appId) {
    console.info(`no feedback_source registered for slack channel ${channel}; skipping`);
    return;
  }

  const messageTs = event.ts!;
  const [permalink, userName] = await Promise.all([
    fetchPermalink(channel, messageTs),
    event.user ? fetchUserName(event.user) : Promise.resolve(null),
  ]);

  const result = await ingestFeedback(db, {
    app_id: appId,
    source_type: "slack",
    raw_text: slackTextToPlain(event.text!),
    external_id: `${channel}:${messageTs}`,
    source_meta: {
      channel_id: channel,
      message_ts: messageTs,
      thread_ts: event.thread_ts ?? null,
      slack_user_id: event.user ?? null,
      slack_user_name: userName,
      permalink,
      team_id: payload.team_id ?? null,
      has_files: Array.isArray(event.files) && event.files.length > 0,
    },
  });

  console.info("slack ingest:", JSON.stringify(result));
}
