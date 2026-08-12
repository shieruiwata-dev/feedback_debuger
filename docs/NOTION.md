# Notion に結果を出す

集計した論点を Notion のデータベースに書き出す手順。
ダッシュボードを別に建てず、チームが既に使っている Notion をそのまま画面にする。

**書き出す単位は「論点」で、Slack の投稿 1 件ずつではない。**
言い回しの違う同じ意見はまとめられ、1 ページに集約されて件数が積み上がる。

```
Slack の投稿  →  ノイズ除去  →  論点ごとに分割  →  同じ内容をまとめる  →  Notion のページ
                                                        ↑ ここまでが Supabase + Dify
```

---

## Notion 側でやること（Notion の担当者向け）

### 1. データベースを作る

任意の名前で構わない。プロパティは次を用意する。

| プロパティ名 | 型 | 用途 |
|---|---|---|
| （タイトル） | タイトル | 論点の要約が入る。**名前は何でもよい** |
| スコア | 数値 | 件数と重大さから算出した採用スコア |
| 件数 | 数値 | 何人がその論点を言ったか |
| 優先度 | セレクト | `urgent` / `high` / `medium` / `low` |
| 種別 | セレクト | `bug` / `feature_request` / `ux` / `other` |
| アプリ | テキスト | 対象プロダクト名 |
| 最終更新 | 日付 | 最後に内容が動いた時刻 |

**名前を変えても動く。** 対応表（`app_settings` の `notion.property_map`）を書き換えれば合わせられる。
プロパティが無ければその項目は黙って飛ばされるので、いらないものは作らなくてよい。

**ステータス・担当者・期日などは自由に足してよい。**
同期はここに挙げた項目しか書き込まないので、人が入れた値が上書きされることはない。

> セレクトの選択肢は空のままで構わない。API から値を入れると自動で追加される。
> ただし型を「ステータス」にした場合は自動追加されないので、選択肢を先に作っておくこと。

### 2. インテグレーションを作る

1. https://www.notion.so/profile/integrations を開く
2. 「新しいインテグレーション」→ 名前は `フィードバックデバッガー` など
3. ワークスペースを選ぶ
4. 権限は **コンテンツを読み取る / 更新する / 挿入する** の 3 つ
5. 作成後に表示される **内部インテグレーションシークレット**（`ntn_` で始まる）を控える

### 3. データベースに接続する

**この手順を飛ばすと、トークンが正しくても「見つかりません」になる。**

1. 作ったデータベースのページを開く
2. 右上の **…** → **接続** → 作ったインテグレーションを選ぶ

### 4. 渡すもの

- インテグレーションのシークレット（`ntn_...`）
- データベース ID

データベース ID は URL から取る。

```
https://www.notion.so/  workspace  /  1a2b3c4d5e6f7890abcdef1234567890  ?v=...
                                       ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                                       この 32 桁
```

---

## Supabase 側でやること

### 1. SQL を流す

SQL Editor に貼って実行する。

```
supabase/migrations/20260805000900_notion_sync.sql
```

論点ごとに「Notion のどのページか」「最後に送ったのはいつか」を覚える列と、
差分だけを引くための関数が入る。

### 2. Secrets を追加する

Edge Functions → Secrets

| Name | Value |
|---|---|
| `NOTION_TOKEN` | `ntn_...`（Notion の担当者からもらったもの） |
| `NOTION_DATABASE_ID` | 32 桁の ID |
| `ENABLE_NOTION_SYNC` | `true` |

### 3. 関数をデプロイする

Edge Functions → Deploy a new function → 名前は **`notion-sync`**。
中身は次のファイルの全文を貼る。

```
supabase/functions/_bundled/notion-sync.ts
```

### 4. 疎通確認（書き込みはしない）

いきなり本番のデータベースに書き込む前に、繋がるかどうかだけを見る。
SQL Editor で実行する。

```sql
select net.http_post(
  url     := 'https://<プロジェクト>.supabase.co/functions/v1/notion-sync',
  headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer <service_role キー>'
  ),
  body    := '{"dry_run": true}'::jsonb
);
```

数秒待ってから結果を見る。

```sql
select status_code, content
from net._http_response
order by created desc limit 1;
```

成功すると、Notion のデータベースにあるプロパティの一覧が返る。

```json
{
  "ok": true,
  "dry_run": true,
  "title_property": "論点",
  "properties": ["論点 (title)", "スコア (number)", "件数 (number)", ...]
}
```

**ここでよくある失敗**

| 返ってくるもの | 原因 |
|---|---|
| `Could not find database` | データベースにインテグレーションを接続していない（Notion 側の手順 3） |
| `API token is invalid` | トークンの写し間違い |
| `ENABLE_NOTION_SYNC が true ではない` | Secrets の設定漏れ |

### 5. 実際に書き出す

`dry_run` を外して同じ手順で叩く。

```sql
select net.http_post(
  url     := 'https://<プロジェクト>.supabase.co/functions/v1/notion-sync',
  headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer <service_role キー>'
  ),
  body    := '{"limit": 5}'::jsonb
);
```

まず 5 件だけ送って、Notion 側の見え方を確認する。結果はこう返る。

```json
{
  "ok": true,
  "synced": 2,
  "failed": 0,
  "archived": 0,
  "skipped_properties": [],
  "results": [
    { "cluster_id": "...", "summary": "入力内容が保存されず失われる",
      "action": "created", "items_appended": 2 }
  ]
}
```

**`skipped_properties` は必ず見ること。** ここに何か入っていたら、
`property_map` と Notion のプロパティ名が噛み合っていない。

```json
"skipped_properties": ["score → \"スコア\"(Notion に無い)"]
```

この場合は名前を合わせる。Notion 側を直すか、こちらの対応表を直す。

```sql
update public.app_settings
set value = jsonb_set(value, '{score}', '"Score"')
where key = 'notion.property_map';
```

### 6. 定期実行にする

問題なく書き出せたら、10 分おきに自動で回す。

```sql
select cron.schedule(
  'notion-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://<プロジェクト>.supabase.co/functions/v1/notion-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <service_role キー>'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

止めるとき:

```sql
select cron.unschedule('notion-sync');
```

---

## 設定

`app_settings` テーブルで変えられる。SQL Editor から更新する。

| キー | 既定値 | 意味 |
|---|---|---|
| `notion.property_map` | 上の表のとおり | 項目 → Notion のプロパティ名 |
| `notion.min_item_count` | `1` | この件数未満の論点は Notion に出さない |
| `notion.priority_labels` | 英語のまま | 優先度の表示名 |
| `notion.category_labels` | 英語のまま | 種別の表示名 |

**1 件だけの意見で Notion を埋めたくない場合**

```sql
update public.app_settings set value = '2'::jsonb where key = 'notion.min_item_count';
```

2 人以上が言った論点だけが上がるようになる。
下限に満たない論点も Supabase には残っているので、後から誰かが同じことを言えば
件数が 2 になった時点で Notion に現れる。

**日本語で表示したい場合**

```sql
update public.app_settings
set value = '{"urgent":"緊急","high":"高","medium":"中","low":"低"}'::jsonb
where key = 'notion.priority_labels';

update public.app_settings
set value = '{"bug":"不具合","feature_request":"要望","ux":"使いにくさ","other":"その他"}'::jsonb
where key = 'notion.category_labels';
```

Notion 側のセレクトの選択肢もこの名前に合わせること
（型が「セレクト」なら自動で追加される。「ステータス」の場合は手で作る）。

---

## 動きかた

### 何が起きるか

- **新しい論点** … ページを作り、元の投稿を本文に並べる
- **既存の論点に合流** … そのページの件数とスコアを更新し、本文に投稿を 1 件足す
- **論点が消えた** … ページをゴミ箱に移す（完全削除はしない）

ページの本文は、元の Slack 投稿が 1 件 1 ブロックで並ぶ。
投稿者名・日付と、Slack の元発言へのリンクが付く。

### 同じものを二重に送らない仕組み

- クラスタ側は `updated_at` と `notion_synced_at` を比べ、変わったものだけ送る
- 投稿側は `notion_block_id` を持ち、まだ本文に書いていないものだけ追記する

書き出している最中にその論点が更新された場合は「同期済み」の印を進めないので、
次の実行でもう一度送られる。**取りこぼすより二度送るほうを選んでいる。**

### 壊れにくくしてあること

- **Notion に無いプロパティは飛ばす。** 名前が違っても同期全体は止まらず、
  `skipped_properties` で報告する
- **セレクトの選択肢が無くて拒否された場合、その項目だけ落として書き込む。**
  論点そのものが Notion に載らないほうが困るため
- **Notion 側でページを消した場合は作り直す。** 消したままにしたい論点は、
  ページではなく Supabase 側で扱う（`set_cluster_status` で `rejected` にする）

---

## 制約

**リアルタイムではない**
定期実行の間隔ぶん遅れる。10 分おきなら最大 10 分。

**Notion で編集しても Supabase には戻らない**
片方向。ステータスや担当者は Notion 側を正として運用する。
こちらは論点・件数・スコア・元投稿しか書かない。

**ノイズと判定された投稿は Notion に出ない**
拾い直したいときは Slack でその投稿に 📮 を付ける。次の取り込みで強制的に拾われる。

**同じ論点のページを人が分割・統合しても追随しない**
まとめ方を変えたい場合は Supabase 側のクラスタを直す。

---

## 確認用のクエリ

**まだ Notion に送っていないもの**

```sql
select summary, item_count, score, notion_page_id
from public.notion_sync_queue(50);
```

**Notion に出ている論点の一覧**

```sql
select representative_summary as 論点, item_count as 件数, score as スコア,
       notion_synced_at as 最終同期
from public.feedback_clusters
where notion_page_id is not null
order by score desc;
```

**同期が止まっていないか**

```sql
select count(*) as 未同期の件数
from public.notion_sync_queue(1000);
```

定期実行が動いていれば、ここは普段 0 か数件で推移する。
数十件が溜まり続けている場合は `net._http_response` を見てエラーを確認する。
