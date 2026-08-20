# Podcast PWA

個人利用向けのポッドキャスト再生 PWA。ビルド不要の静的サイト（素の HTML / CSS / ES Modules）で、
GitHub Pages などの無料枠にそのまま置いて iPhone のホーム画面から使うことを想定している。

## 実装済みの要件

| 要件 | 実装 |
|---|---|
| エピソード一覧 | 番組ごとに一覧表示（タイトル / 公開日 / 再生時間 / 既読・未読） |
| **極めて少ない手数での並び替え** | 一覧上部に**常時固定**したトグルを 1 タップで昇順⇄降順が反転（メニューを開く操作なし）。番組ごとに設定を保存 |
| バックグラウンド再生 | `<audio>` + Media Session API。ロック画面から再生 / 一時停止 / 15秒シーク |
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

- `CORS_PROXIES` — RSS 取得に使う公開 CORS プロキシ。上から順に試し、失敗したら次へフォールバックする。
  停止・仕様変更のリスクがあるため、動かなくなったらここを書き換える
- `FEED_CACHE_TTL_SEC` — フィードキャッシュの有効期限（既定 900 秒 = 15 分）
- `SEEK_SECONDS`、`PLAYBACK_RATES`、`READ_RATIO`（既読とみなす再生割合）

iTunes Search API は CORS 許可済みのためプロキシを通さず直接 fetch している。

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
