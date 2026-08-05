import { FeedbackWidget } from "../components/FeedbackWidget";

/**
 * 埋め込みフォームの単体確認用ページ（?widget-demo=1）。
 * 各アプリのサイトに差し込む前に、見た目と送信の挙動をここで確認する。
 */
export function WidgetDemo() {
  const endpoint = import.meta.env.VITE_FEEDBACK_ENDPOINT as string | undefined;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">FeedbackWidget プレビュー</h1>
          <p className="mt-1 text-sm text-slate-500">
            各アプリのサイトには <code className="rounded bg-slate-200 px-1">
              {'<FeedbackWidget appSlug="mysupport" />'}
            </code> を差し込むだけで使えます。
          </p>
          {!endpoint && (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              VITE_FEEDBACK_ENDPOINT が未設定です。送信は失敗しますが、表示の確認はできます。
            </p>
          )}
        </div>

        <FeedbackWidget appSlug="mysupport" />
      </div>
    </div>
  );
}
