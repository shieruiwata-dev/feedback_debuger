import { env, envBool, envInt, envList } from "./env.ts";
import type { SourceType } from "./types.ts";

/**
 * フィードバック選別（トリアージ）
 *
 * Slack のチャンネルにはフィードバック以外の情報も流れてくるため、3 層で選別する。
 *
 *   層 0（このファイル・insert 前・ゼロコスト）
 *     - 明示マーク（"#fb" 等）があれば、以降の判定を全部飛ばして確実に取り込む
 *     - 定型ノイズ（「了解です」「👍」URL だけ 等）は insert せず捨てる
 *   層 1（enrich.ts・insert 後・Dify）
 *     - AI が is_feedback を返す。ノイズなら status='ignored' にして一覧から外す
 *     - 「確信度が閾値以上のときだけ落とす」ので、迷ったものは残る（フェイルオープン）
 *   層 2（人・あとから）
 *     - Slack で 📮 リアクションを付ければ、過去の投稿でも拾い上げられる
 *     - ダッシュボードのノイズ欄から「フィードバックに戻す」で復帰できる
 *
 * 層 0 だけが投げ捨てで不可逆。だから条件は「誰が見てもフィードバックでない」ものに限り、
 * 迷う判定はすべて層 1 に回して DB に残す方針にしている。
 */

export interface NoiseVerdict {
  noise: boolean;
  reason?: string;
}

/** 明示マークの既定値。テキストに含まれていれば無条件で取り込む */
export const defaultMarkers = () => {
  const configured = envList("SLACK_FEEDBACK_MARKERS");
  return configured.length > 0
    ? configured
    : ["#fb", "#feedback", "#フィードバック", "#要望", "#不具合"];
};

/** 明示マークとして扱う絵文字リアクション名（Slack の emoji name。コロンなし） */
export const feedbackReactions = () => {
  const configured = envList("SLACK_FEEDBACK_REACTIONS");
  return configured.length > 0 ? configured : ["inbox_tray", "memo", "mega"];
};

/** AI トリアージを掛けるソース種別。フォームは定義上フィードバックなので既定では掛けない */
export const aiTriageSourceTypes = (): SourceType[] => {
  const configured = envList("AI_TRIAGE_SOURCE_TYPES");
  const list = configured.length > 0 ? configured : ["slack"];
  return list.filter((s): s is SourceType =>
    s === "slack" || s === "form" || s === "email"
  );
};

export const aiTriageEnabled = () => envBool("ENABLE_AI_TRIAGE", true);

export function shouldAiTriage(sourceType: SourceType): boolean {
  return aiTriageEnabled() && aiTriageSourceTypes().includes(sourceType);
}

/**
 * 明示マークを探し、見つかったらテキストから取り除いて返す。
 * マーク自体は本文ではないので、要約や埋め込みに混ぜたくない。
 */
export function extractMarker(
  text: string,
  markers: string[] = defaultMarkers(),
): { marked: boolean; marker?: string; text: string } {
  const lower = text.toLowerCase();

  for (const marker of markers) {
    const idx = lower.indexOf(marker.toLowerCase());
    if (idx === -1) continue;

    const stripped = (text.slice(0, idx) + text.slice(idx + marker.length))
      .replace(/\s{2,}/g, " ")
      .trim();

    // マークを消したら何も残らない場合は原文を残す（"#fb" だけの投稿）
    return { marked: true, marker, text: stripped.length > 0 ? stripped : text.trim() };
  }

  return { marked: false, text };
}

/** ノイズ判定のためにメンション・URL・装飾を落とした「中身」を取り出す */
export function coreContent(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[^\s]+/g, " ")
    .replace(/#[^\s]+/g, " ")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

/** 相槌・定型返事だけの投稿（本文が実質ゼロ） */
const ACK_PATTERN =
  /^(?:了解|了解です|承知|承知しました|把握|把握しました|確認|確認します|確認しました|対応します|対応しました|完了|完了です|なるほど|同じく|わかりました|分かりました|ありがとう|ありがとうございます|ありがとうございました|感謝|助かります|助かりました|お疲れ|お疲れです|お疲れ様|お疲れ様です|おつ|よろしく|よろしくお願いします|お願いします|ok|okay|lgtm|sgtm|nice|good|great|thanks|thank you|thx|done|fyi|同上|以上|はい|いいえ)$/i;

export interface NoiseOptions {
  /** 中身がこの文字数未満なら情報量が無いとみなす */
  minLength?: number;
  /** 追加のノイズ判定正規表現（NOISE_PATTERNS で設定） */
  extraPatterns?: RegExp[];
}

/**
 * insert 前に落とす「誰が見てもフィードバックでない」投稿の判定。
 * 判断に迷う余地があるものはここでは落とさず、AI トリアージ（層 1）に回す。
 */
export function looksLikeNoise(
  text: string,
  options: NoiseOptions = {},
): NoiseVerdict {
  const minLength = options.minLength ?? envInt("NOISE_MIN_LENGTH", 6);
  const patterns = options.extraPatterns ?? configuredNoisePatterns();

  const trimmed = text.trim();
  if (trimmed.length === 0) return { noise: true, reason: "empty" };

  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return { noise: true, reason: `matched_pattern:${pattern.source.slice(0, 40)}` };
    }
  }

  const core = coreContent(trimmed);

  if (core.length === 0) {
    // URL だけ / 絵文字だけ / メンションだけ
    if (/https?:\/\//.test(trimmed)) return { noise: true, reason: "url_only" };
    return { noise: true, reason: "no_text_content" };
  }

  if (ACK_PATTERN.test(core.replace(/\s+/g, ""))) {
    return { noise: true, reason: "acknowledgement" };
  }

  if (core.replace(/\s+/g, "").length < minLength) {
    return { noise: true, reason: "too_short" };
  }

  return { noise: false };
}

/**
 * NOISE_PATTERNS に設定した正規表現。
 * 自動投稿の定型文（デプロイ通知、CI の結果、監視アラート等）を落とすのに使う。
 *   NOISE_PATTERNS='^\[Deploy\],^Build #\d+,^\[ALERT\]'
 */
function configuredNoisePatterns(): RegExp[] {
  return envList("NOISE_PATTERNS").flatMap((source) => {
    try {
      return [new RegExp(source, "i")];
    } catch {
      console.warn(`invalid NOISE_PATTERNS entry, ignored: ${source}`);
      return [];
    }
  });
}

/** AI がノイズと言っても、この確信度未満なら残す（取りこぼしを避けるため） */
export function minTriageConfidence(fallback = 0.7): number {
  const raw = env("AI_TRIAGE_MIN_CONFIDENCE");
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
