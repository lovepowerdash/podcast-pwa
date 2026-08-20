# Podcast PWA

個人利用向けのポッドキャスト再生 PWA。ビルド不要の静的サイト（素の HTML / CSS / ES Modules）で、
GitHub Pages などの無料枠にそのまま置いて iPhone のホーム画面から使うことを想定している。

## 実装済みの要件

| 要件 | 実装 |
|---|---|
| エピソード一覧 | 番組ごとに一覧表示（タイトル / 公開日 / 再生時間 / 既読・未読） |
| **極めて少ない手数での並び替え** | 一覧上部に**常時固定**したトグルを 1 タップで昇順⇄降順が反転（メニューを開く操作なし）。番組ごとに設定を保存 |
| バックグラウンド再生 | `<audio>` + Media Session API。ロック画面から再生 / 一時停止 / 15秒シーク |
| フィード取得の冗長化 | 直接取得と公開プロキシ3種を同時に投げ、最初に成功したものを採用。全滅時は経路ごとの理由と再試行ボタンを表示 |
| iPhone (Safari/PWA) | standalone 表示、セーフエリア対応、初回再生は必ずタップイベント内で `play()` |

意図的に実装していないもの: プッシュ通知 / ダウンロード・オフライン再生（ストリーミングのみ）/ 番組アートワーク表示。

## 画面

```
ホーム ⇄ 番組検索
ホーム → エピソード一覧（← で戻る）
ミニプレイヤーは全画面共通で下部固定 → タップでフルプレイヤー
```

## デプロイ（GitHub Pages）

ビルド不要。リポジトリ直下がそのまま公開ディレクトリになる。

1. GitHub の **Settings → Pages** で Source に `Deploy from a branch` / `main` / `/ (root)` を選ぶ
2. `https://<ユーザー名>.github.io/podcast-pwa/` が公開 URL
3. iPhone の Safari で開き、共有 → **ホーム画面に追加**（PWA として standalone 起動する）

Service Worker と Media Session は HTTPS でのみ動く。ローカル確認は `localhost` なら可。

```bash
npm start   # http://localhost:8080 で配信
```

## 設定の差し替え

外部サービスに依存する値は `js/config.js` の 1 箇所に集約してある。

- `FEED_SOURCES` — RSS の取得経路。全経路を同時に投げ、最初に成功したものを採用する。
  「直接取得」＋公開 CORS プロキシ 3 種。動かなくなったらここを書き換える
- `FEED_FETCH_TIMEOUT_MS` — 1 経路あたりの上限時間（既定 40 秒）。同時に投げるのでこれが最大待ち時間になる
- `FEED_CACHE_TTL_SEC` — フィードキャッシュの有効期限（既定 900 秒 = 15 分）
- ホーム画面左上の歯車から自前プロキシの URL を入れると、ソースを書き換えずに最優先で使える
- `SEEK_SECONDS`、`PLAYBACK_RATES`、`READ_RATIO`（既読とみなす再生割合）

iTunes Search API は CORS 許可済みのためプロキシを通さず直接 fetch している。

### 自前の CORS プロキシを立てる（推奨）

無料の公開 CORS プロキシはレスポンスサイズ上限とレート制限がある。エピソード数の多い番組は
RSS が数 MB になるため、`413 Payload Too Large` やタイムアウトで取得に失敗する。
実際にエピソード数の多い番組（400 回超・RSS が数 MB）で、iPhone 実機から全経路が失敗することを
確認している（`corsproxy.io` は 413、`allorigins` と `codetabs` はタイムアウト、直接取得は CORS 拒否）。

`worker/cors-proxy.js` を Cloudflare Workers（無料枠）に置けばこの制限が無くなる。

1. https://dash.cloudflare.com/ → Workers & Pages → Create → Start with Hello World → Deploy
2. 作成した Worker の Edit code を開き、`worker/cors-proxy.js` の中身を貼り付けて Deploy
3. 発行された `https://<名前>.<アカウント>.workers.dev` を控える
4. アプリのホーム画面左上の歯車から `https://<名前>.workers.dev/?url=` を貼り付ける
   （端末の localStorage に保存され、`FEED_SOURCES` より優先される。再デプロイ不要）

恒久的に既定へ組み込むなら、`js/config.js` の `FEED_SOURCES` 先頭にあるコメント行を有効にする。

```js
{ name: 'my-worker', build: (url) => `https://<名前>.workers.dev/?url=${encodeURIComponent(url)}` },
```

`worker/cors-proxy.js` の `ALLOWED_ORIGINS` に自分の公開 URL を書いておくこと（第三者に
踏み台として使われないため）。レスポンスはストリームのまま中継するのでフィードのサイズ制限はない。

## データ構造（IndexedDB: `podcast_pwa_db`）

| ストア | keyPath | 用途 |
|---|---|---|
| `follows` | `feedUrl` | フォロー中の番組。`title` / `sortOrder` / `followedAt` |
| `episodes` | `episodeId` | 既読・再生位置。`feedUrl` に**インデックス**を張り番組単位で取得 |
| `feedCache` | `feedUrl` | RSS パース結果と `cachedAt` / `ttl` |

`episodeId` は `<guid>` があれば `${feedUrl}::${guid}`、無ければ `${feedUrl}::${hash(audioUrl)}`（FNV-1a）。

## ファイル構成

```
index.html            4画面ぶんのマークアップ
css/style.css
js/config.js          外部依存・調整値の集約点
js/db.js              IndexedDB アクセス層
js/api.js             iTunes Search / RSS 取得・パース
js/player.js          <audio> と Media Session
js/ui.js              表示ヘルパー
js/app.js             ルーティングと各画面の描画
sw.js                 アプリシェルのみキャッシュ（音声・フィードはキャッシュしない）
worker/cors-proxy.js  自前CORSプロキシ（Cloudflare Workers 用・任意）
test/smoke.mjs        Playwright によるエンドツーエンドのスモークテスト
```

## テスト

iTunes Search API と RSS をモックし、音声だけは Range 対応のローカルサーバーから実際に再生させて、
検索 → フォロー → 並び替え → 再生 → 進捗保存 → 既読化までを通しで検証する。

```bash
npm install   # playwright
npx playwright install chromium
npm test
```

## 設計時の未確定事項について決めたこと

- **フォロー後の遷移先**: そのままエピソード一覧へ移動する（`js/app.js` の `data-follow` ハンドラ）
- **feedCache の TTL**: 900 秒（`js/config.js`）

## iOS 上の注意点

- 音声はユーザー操作を起点にしないと再生できないため、`player.play()` はタップハンドラ内から
  同期的に呼ぶこと（`await` を挟むと再生がブロックされる）。再生位置の復元も、描画時に読み込み済みの
  状態から同期的に渡している
- Media Session の `artwork` は表示不具合の報告があるため最初から設定していない
- iOS 17.4 以降、EU 域内では PWA の standalone 起動が廃止されている（日本は対象外）
- Service Worker / IndexedDB のストレージは Chrome より制限が厳しく、長期間未使用だと破棄されうる
- Service Worker はネットワーク優先にしてある。加えて `index.html` の先頭で現行以外の
  キャッシュを削除してからアプリを読み込むため、古い Service Worker が残っていても
  次回の読み込みで最新のコードに入れ替わる（キャッシュ優先の旧版で更新が届かなくなった経験による）
