/**
 * Slack Events API 受信アダプタ
 *
 * エンドポイント: POST /functions/v1/slack-events
 *
 * 処理の流れ
 *   1. 署名検証（必須。失敗は 401）
 *   2. url_verification なら challenge を返す
 *   3. message / reaction_added イベントを共通フォーマットへ正規化
 *   4. channel ID から feedback_sources を逆引きして app_id を決定
 *      → 登録の無いチャンネルのメッセージは黙って捨てる（誤取り込み防止）
 *   5. ingestFeedback() に渡す
 *
 * チャンネルにはフィードバック以外の情報も流れてくるため、選別は 3 層で行う。
 *   層 0: 明示マーク（"#fb" 等）で強制取り込み / 定型ノイズは insert せず破棄
 *   層 1: Dify の is_feedback 判定（enrich.ts）で status='ignored' に落とす
 *   層 2: 📮 リアクションで過去の投稿を後から拾い上げる（この関数の reaction_added）
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
import { extractMarker, feedbackReactions } from "../_shared/triage.ts";
import {
  fetchMessage,
  fetchPermalink,
  fetchUserName,
  isIngestableMessage,
  type SlackMessageEvent,
  type SlackReactionEvent,
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

  const event = payload.event as { type?: string } | undefined;

  // --- 📮 リアクションによる「あとから拾う」経路 ----------------------------
  if (event?.type === "reaction_added") {
    const reaction = event as SlackReactionEvent;
    if (!feedbackReactions().includes(reaction.reaction ?? "")) {
      return json({ ok: true, skipped: "not_a_feedback_reaction" });
    }
    if (reaction.item?.type !== "message" || !reaction.item.channel || !reaction.item.ts) {
      return json({ ok: true, skipped: "unsupported_reaction_target" });
    }

    runBackground(handleReaction(reaction, payload));
    return json({ ok: true });
  }

  // --- 通常のメッセージ経路 ------------------------------------------------
  const message = event as SlackMessageEvent | undefined;
  if (!message || !isIngestableMessage(message)) {
    return json({ ok: true, skipped: "not_ingestable" });
  }

  // Slack のリトライは重複 insert を招くが、external_id の unique 制約で吸収される。
  // ここでは即座に 200 を返しつつ、取り込みはバックグラウンドで完了させる。
  runBackground(handleMessage(message, payload));

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

  const plainText = slackTextToPlain(event.text!);
  // "#fb" などの明示マークが付いていれば、選別を飛ばして必ず取り込む。
  // マーク自体は本文ではないので、要約と埋め込みに混ざらないよう取り除く。
  const marker = extractMarker(plainText);

  const messageTs = event.ts!;
  const [permalink, userName] = await Promise.all([
    fetchPermalink(channel, messageTs),
    event.user ? fetchUserName(event.user) : Promise.resolve(null),
  ]);

  const result = await ingestFeedback(db, {
    app_id: appId,
    source_type: "slack",
    raw_text: marker.text,
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
  }, marker.marked ? { forced: true, reason: `marker:${marker.marker}` } : {});

  console.info("slack ingest:", JSON.stringify(result));
}

/**
 * 📮 リアクションが付いた投稿を拾い上げる。
 * まだ取り込んでいなければ新規取り込み、
 * ノイズ判定で外していたなら一覧に復帰させる（ingestFeedback 側で分岐する）。
 */
async function handleReaction(
  reaction: SlackReactionEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = serviceClient();
  const channel = reaction.item!.channel!;
  const messageTs = reaction.item!.ts!;

  const appId = await resolveAppBySource(db, "slack", channel);
  if (!appId) {
    console.info(`no feedback_source registered for slack channel ${channel}; skipping`);
    return;
  }

  const message = await fetchMessage(channel, messageTs);
  if (!message || !message.text || message.text.trim().length === 0) {
    console.info(`could not fetch reacted message ${channel}:${messageTs}`);
    return;
  }
  if (message.bot_id) {
    console.info("reacted message is from a bot; skipping");
    return;
  }

  const marker = extractMarker(slackTextToPlain(message.text));
  const [permalink, userName] = await Promise.all([
    fetchPermalink(channel, messageTs),
    message.user ? fetchUserName(message.user) : Promise.resolve(null),
  ]);

  const result = await ingestFeedback(db, {
    app_id: appId,
    source_type: "slack",
    raw_text: marker.text,
    external_id: `${channel}:${messageTs}`,
    source_meta: {
      channel_id: channel,
      message_ts: messageTs,
      thread_ts: message.thread_ts ?? null,
      slack_user_id: message.user ?? null,
      slack_user_name: userName,
      permalink,
      team_id: payload.team_id ?? null,
      // 誰がフィードバックとして拾ったかを残す
      flagged_by: reaction.user ?? null,
      flagged_with: reaction.reaction ?? null,
    },
  }, { forced: true, reason: `reaction:${reaction.reaction}` });

  console.info("slack reaction ingest:", JSON.stringify(result));
}
