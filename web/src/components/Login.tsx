import { useState } from "react";
import { requireSupabase } from "../lib/supabase";

type Mode = "password" | "magic_link";

/**
 * 社内ユーザー向けログイン。
 * Supabase Auth の signup は無効化しておき（supabase/config.toml）、
 * ユーザーは管理画面から招待する運用を想定している。
 */
export function Login() {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const auth = requireSupabase().auth;

      if (mode === "password") {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error) throw error;
        // 成功時は onAuthStateChange が発火して App 側が画面を切り替える
      } else {
        const { error } = await auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        setMessage("ログイン用リンクをメールで送信しました。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">フィードバックデバッガー</h1>
          <p className="mt-1 text-sm text-slate-500">社内アカウントでログインしてください。</p>
        </div>

        <label className="block text-sm">
          <span className="text-slate-600">メールアドレス</span>
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>

        {mode === "password" && (
          <label className="block text-sm">
            <span className="text-slate-600">パスワード</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? "処理中…" : mode === "password" ? "ログイン" : "ログインリンクを送る"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "password" ? "magic_link" : "password");
            setError(null);
            setMessage(null);
          }}
          className="w-full text-xs text-slate-500 underline underline-offset-2 hover:text-slate-800"
        >
          {mode === "password"
            ? "パスワードを使わずメールリンクでログイン"
            : "パスワードでログイン"}
        </button>

        {message && <p className="text-sm text-emerald-700">{message}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </div>
  );
}
