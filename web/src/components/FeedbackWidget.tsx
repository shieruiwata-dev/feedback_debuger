import { useState } from "react";

interface Props {
  /** apps.slug。例: <FeedbackWidget appSlug="mysupport" /> */
  appSlug: string;
  /** 送信先。未指定なら VITE_FEEDBACK_ENDPOINT を使う */
  endpoint?: string;
  title?: string;
  placeholder?: string;
  /** 返信先メールの入力欄を出すか */
  askEmail?: boolean;
  /** 送信完了後に呼ばれる */
  onSubmitted?: () => void;
  className?: string;
}

type State = "idle" | "sending" | "sent" | "error";

/**
 * 各アプリのサイトに差し込む汎用フィードバックフォーム。
 *
 *   <FeedbackWidget appSlug="mysupport" />
 *
 * 依存は React のみ。Supabase JS Client も使わない（anon キーを配布せずに済むよう、
 * 公開 Edge Function に素の fetch で投げる）。
 */
export function FeedbackWidget({
  appSlug,
  endpoint,
  title = "ご意見・ご要望",
  placeholder = "気づいた点や困っていることを自由にお書きください",
  askEmail = true,
  onSubmitted,
  className = "",
}: Props) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  const url = endpoint ?? (import.meta.env.VITE_FEEDBACK_ENDPOINT as string | undefined);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;

    if (!url) {
      setState("error");
      setError("送信先が設定されていません（VITE_FEEDBACK_ENDPOINT）");
      return;
    }

    setState("sending");
    setError(null);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_slug: appSlug,
          message: message.trim(),
          email: email.trim() || undefined,
          page_url: typeof window !== "undefined" ? window.location.href : undefined,
          _hp: honeypot,
        }),
      });

      if (res.status === 429) {
        throw new Error("送信が集中しています。しばらく待ってからお試しください。");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `送信に失敗しました (${res.status})`);
      }

      setState("sent");
      setMessage("");
      setEmail("");
      onSubmitted?.();
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    }
  };

  if (state === "sent") {
    return (
      <div className={`rounded-lg border border-emerald-200 bg-emerald-50 p-4 ${className}`}>
        <p className="text-sm text-emerald-800">
          ご意見ありがとうございました。担当者が確認します。
        </p>
        <button
          type="button"
          onClick={() => setState("idle")}
          className="mt-2 text-xs text-emerald-700 underline underline-offset-2"
        >
          続けて投稿する
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className={`space-y-3 rounded-lg border border-slate-200 bg-white p-4 ${className}`}
    >
      <h2 className="text-sm font-medium text-slate-900">{title}</h2>

      <textarea
        required
        rows={4}
        maxLength={5000}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />

      {askEmail && (
        <label className="block text-xs text-slate-600">
          返信先メールアドレス（任意）
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>
      )}

      {/* ハニーポット: 人間には見えない。ボットが埋めるとサーバー側で破棄される */}
      <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden opacity-0">
        <label>
          この欄は入力しないでください
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={state === "sending" || !message.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {state === "sending" ? "送信中…" : "送信"}
        </button>
        <span className="text-xs text-slate-400">{message.length} / 5000</span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
