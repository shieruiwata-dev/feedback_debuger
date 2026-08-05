import type { App, Cluster, FeedbackItem } from "./types";

/**
 * Supabase 未接続時に UI を確認するためのモックデータ。
 * 本番ビルドでも import されるが、VITE_SUPABASE_URL が設定されていれば参照されない。
 */

const APP_ID = "11111111-1111-4111-8111-111111111111";

export const mockApps: App[] = [
  { id: APP_ID, name: "マイサポ", slug: "mysupport" },
  { id: "22222222-2222-4222-8222-222222222222", name: "サンプルアプリ", slug: "sample-app" },
];

export const mockClusters: Cluster[] = [
  {
    id: "c1000000-0000-4000-8000-000000000001",
    app_id: APP_ID,
    representative_summary: "ログイン後にホーム画面が真っ白になり操作できない",
    category: "bug",
    priority: "urgent",
    item_count: 12,
    score: 150,
    status: "reviewing",
    updated_at: "2026-08-04T09:12:00Z",
  },
  {
    id: "c1000000-0000-4000-8000-000000000002",
    app_id: APP_ID,
    representative_summary: "申請履歴を CSV でエクスポートしたい",
    category: "feature_request",
    priority: "high",
    item_count: 8,
    score: 80,
    status: "new",
    updated_at: "2026-08-04T08:40:00Z",
  },
  {
    id: "c1000000-0000-4000-8000-000000000003",
    app_id: APP_ID,
    representative_summary: "スマホで入力フォームの文字が小さくて読みづらい",
    category: "ux",
    priority: "medium",
    item_count: 5,
    score: 41.6667,
    status: "new",
    updated_at: "2026-08-03T15:02:00Z",
  },
  {
    id: "c1000000-0000-4000-8000-000000000004",
    app_id: APP_ID,
    representative_summary: "通知メールの文面が事務的すぎるという指摘",
    category: "other",
    priority: "low",
    item_count: 2,
    score: 11.6667,
    status: "done",
    updated_at: "2026-08-01T11:30:00Z",
  },
];

export const mockItems: FeedbackItem[] = [
  {
    id: "i1000000-0000-4000-8000-000000000001",
    app_id: APP_ID,
    source_type: "slack",
    raw_text: "お客様から連絡。ログインしたあとホームが真っ白のまま何も出ないとのこと。iPhone の Safari です。",
    summary: "ログイン後にホーム画面が白紙になる（iOS Safari）",
    priority: "urgent",
    category: "bug",
    cluster_id: "c1000000-0000-4000-8000-000000000001",
    source_meta: {
      channel_id: "C0BKRLGJQ3Z",
      slack_user_name: "sato",
      permalink: "https://example.slack.com/archives/C0BKRLGJQ3Z/p1754300000000100",
    },
    status: "reviewing",
    created_at: "2026-08-04T09:12:00Z",
  },
  {
    id: "i1000000-0000-4000-8000-000000000002",
    app_id: APP_ID,
    source_type: "form",
    raw_text: "ログインしても画面が表示されません。何度やっても同じです。",
    summary: "ログイン後に画面が表示されない",
    priority: "urgent",
    category: "bug",
    cluster_id: "c1000000-0000-4000-8000-000000000001",
    source_meta: {
      submitter_email: "user@example.com",
      page_url: "https://mysupport.example.com/login",
    },
    status: "reviewing",
    created_at: "2026-08-04T08:55:00Z",
  },
  {
    id: "i1000000-0000-4000-8000-000000000003",
    app_id: APP_ID,
    source_type: "slack",
    raw_text: "申請の一覧を CSV で落とせると経理側の突合がラクになる、という要望をもらいました。",
    summary: "申請一覧の CSV エクスポート要望",
    priority: "high",
    category: "feature_request",
    cluster_id: "c1000000-0000-4000-8000-000000000002",
    source_meta: {
      channel_id: "C0BKRLGJQ3Z",
      slack_user_name: "tanaka",
      permalink: "https://example.slack.com/archives/C0BKRLGJQ3Z/p1754290000000200",
    },
    status: "new",
    created_at: "2026-08-04T08:40:00Z",
  },
  {
    id: "i1000000-0000-4000-8000-000000000004",
    app_id: APP_ID,
    source_type: "form",
    raw_text: "スマホだと入力欄の文字が小さくて、入力ミスに気づけません。",
    summary: "モバイルでフォームの文字が小さい",
    priority: "medium",
    category: "ux",
    cluster_id: "c1000000-0000-4000-8000-000000000003",
    source_meta: { page_url: "https://mysupport.example.com/apply" },
    status: "new",
    created_at: "2026-08-03T15:02:00Z",
  },
  {
    id: "i1000000-0000-4000-8000-000000000005",
    app_id: APP_ID,
    source_type: "slack",
    raw_text: "通知メールの文面、もう少し柔らかくできないかという声がありました。",
    summary: "通知メール文面のトーン改善要望",
    priority: "low",
    category: "other",
    cluster_id: "c1000000-0000-4000-8000-000000000004",
    source_meta: { channel_id: "C0BKRLGJQ3Z", slack_user_name: "yamada" },
    status: "done",
    created_at: "2026-08-01T11:30:00Z",
  },
  {
    // AI エンリッチメントが走る前の状態（step 2〜4 の見え方）
    id: "i1000000-0000-4000-8000-000000000006",
    app_id: APP_ID,
    source_type: "form",
    raw_text: "検索が遅いです。5秒くらい待たされます。",
    summary: null,
    priority: null,
    category: null,
    cluster_id: null,
    source_meta: { page_url: "https://mysupport.example.com/search" },
    status: "new",
    created_at: "2026-08-05T02:10:00Z",
  },
];
