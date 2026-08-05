import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./components/Login";
import { WidgetDemo } from "./pages/WidgetDemo";
import { isSupabaseConfigured, supabase } from "./lib/supabase";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(isSupabaseConfigured);

  // ?widget-demo=1 で埋め込みフォームの単体確認ができる（ルーターは導入しない）
  const widgetDemo = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("widget-demo");

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  if (widgetDemo) return <WidgetDemo />;

  // Supabase 未設定時はモックデータでダッシュボードを表示する（UI 先行開発用）
  if (!isSupabaseConfigured) return <Dashboard />;

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        読み込み中…
      </div>
    );
  }

  if (!session) return <Login />;

  return <Dashboard onSignOut={() => void supabase?.auth.signOut()} />;
}
