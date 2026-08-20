# Podcast PWA

個人利用向けのポッドキャスト再生 PWA。ビルド不要の静的サイト（素の HTML / CSS / ES Modules）で、
Cloudflare Pages の無料枠にそのまま置いて iPhone のホーム画面から使うことを想定している。

## 実装済みの要件

| 要件 | 実装 |
|---|---|
| エピソード一覧 | 番組ごとに一覧表示（タイトル / 公開日 / 再生時間 / 既読・未読） |
| **極めて少ない手数での並び替え** | 一覧上部に**常時固定**したトグルを 1 タップで昇順⇄降順が反転（メニューを開く操作なし）。番組ごとに設定を保存 |
| バックグラウンド再生 | `<audio>` + Media Session API。ロック画面から再生 / 一時停止 / 15秒シーク |
| 連続再生 | エピソードが終わると一覧の次の回へ自動で送る（フィルタで隠れている回は飛ばす）。ロック画面のスキップボタンでも前後の回へ移動できる |
| 一括で再生済みにする | 各行の ✓✓ を押すと「最初の回からこの回まで」をまとめて再生済みにする。他のアプリから乗り換えたときに続きから始められるようにするため |
| 全て未再生に戻す | エピソード一覧の右上（↺）で番組まるごと未再生に戻す |
| 再生済みフィルタ | 一覧上部のトグルを1タップで「すべて表示 / 未再生のみ」を切り替え。番組ごとに保存 |
| フィード取得の冗長化 | 直接取得と公開プロキシ3種を同時に投げ、最初に成功したものを採用。全滅時は経路ごとの理由と再試行ボタンを表示 |
| iPhone (Safari/PWA) | standalone 表示、セーフエリア対応、初回再生は必ずタップイベント内で `play()` |

意図的に実装していないもの: プッシュ通知 / ダウンロード・オフライン再生（ストリーミングのみ）/ 番組アートワーク表示。

## 画面

```
ホーム ⇄ 番組検索
ホーム → エピソード一覧（← で戻る）
ミニプレイヤーは全画面共通で下部固定 → タップでフルプレイヤー
```

## 現在の稼働構成

- ホスティング: Cloudflare Pages（無料枠）。URL にアカウント名が入らない
- フィード取得: `functions/api/feed.js`（Pages Functions）。アプリと同じオリジンで動くため
  CORS の問題が起きず、公開プロキシのようなサイズ上限もない。アプリからは `./api/feed?url=`
  という相対パスで呼ぶので、コードのどこにもホスト名が入らない
- iPhone 実機で確認済み: フィード取得 / 並び替え / 再生 / 既読・再生位置の保存 /
  連続再生 / バックグラウンド再生 / ロック画面操作 / ホーム画面に追加しての standalone 起動

## デプロイ（Cloudflare Pages）

ビルド不要。リポジトリ直下がそのまま公開ディレクトリで、`functions/` は自動で認識される。

1. https://dash.cloudflare.com/ → Workers & Pages → Create → **Pages** → Connect to Git
2. リポジトリを選ぶ（非公開リポジトリでも無料枠でビルドできる）
3. ビルド設定
   - Framework preset: **None**
   - Build command: **空欄**
   - Build output directory: **`/`**
4. Save and Deploy → `https://<プロジェクト名>.pages.dev` が公開 URL
5. iPhone の Safari で開き、共有 → **ホーム画面に追加**（PWA として standalone 起動する）

push するたびに自動で再デプロイされる。

Service Worker と Media Session は HTTPS でのみ動く。ローカル確認は `localhost` なら可。
ただし `./api/feed` は Pages Functions なので、素の静的サーバーでは動かない
（`npx wrangler pages dev .` を使うか、公開プロキシへのフォールバックで確認する）。

```bash
npm start   # http://localhost:8080 で配信（中継は動かない）
```

## 設定の差し替え

外部サービスに依存する値は `js/config.js` の 1 箇所に集約してある。

- `FEED_SOURCES` — RSS の取得経路。全経路を同時に投げ、最初に成功したものを採用する。
  同一オリジンの中継 → 直接取得 → 公開 CORS プロキシ 3 種。公開プロキシは中継が使えない
  ときの保険で、エピソード数の多い番組（RSS が数 MB）ではサイズ上限に当たって失敗する
- `FEED_FETCH_TIMEOUT_MS` — 1 経路あたりの上限時間（既定 40 秒）。同時に投げるのでこれが最大待ち時間になる
- `FEED_CACHE_TTL_SEC` — フィードキャッシュの有効期限（既定 900 秒 = 15 分）
- `APP_VERSION` — ホーム画面下部に出る版。配信するたびに更新する
- ホーム画面左上の歯車から中継の URL を入れると、その端末だけ最優先で使える
  （動作確認用の逃げ道。恒久的な設定は `FEED_SOURCES` 側で行う）

iTunes Search API は CORS 許可済みのためプロキシを通さず直接 fetch している。

## データ構造（IndexedDB: `podcast_pwa_db`）

| ストア | keyPath | 用途 |
|---|---|---|
| `follows` | `feedUrl` | フォロー中の番組。`title` / `sortOrder` / `hideRead` / `followedAt` |
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
functions/api/feed.js RSSフィードの中継（Cloudflare Pages Functions）
test/smoke.mjs        Playwright によるエンドツーエンドのスモークテスト
```

## 実機での切り分け

開発者コンソールが使えない端末で原因を追うための仕掛けを入れてある。

- ホーム画面の一番下に**版**（`js/config.js` の `APP_VERSION`）を表示する。
  端末に新しいコードが届いているかはここで判断する
- その版をタップすると、再生まわりのイベント記録（`play` / `pause` / `ended` /
  `advance` / `play-rejected` など、時刻と再生位置つき）を表示する
- Service Worker は同一オリジンの取得を `cache: 'no-cache'` で行う。
  ホスティングが付ける `max-age` により、素直に取得すると十数分ぶん古いコードが
  返って原因の切り分けができなくなるため

## テスト

iTunes Search API と RSS をモックし、音声だけは Range 対応のローカルサーバーから実際に再生させて、
検索 → フォロー → 並び替え → 再生 → 進捗保存 → 既読化までを通しで検証する。

```bash
npm install   # playwright
npx playwright install chromium
npm test
```

一括操作はどちらも、実行前に対象件数を確認し、実行後に「取り消す」ボタン付きの通知を出す。
取り消しは変更前の状態（既読かどうかと再生位置）をそのまま書き戻すので、元通りになる。

## 設計時の未確定事項について決めたこと

- **フォロー後の遷移先**: そのままエピソード一覧へ移動する（`js/app.js` の `data-follow` ハンドラ）
- **連続再生の順番**: 一覧の表示順（並び替えとフィルタを適用した後の順番）に従う。
  再生開始時にその順番をキューとして `player` に渡し、各要素に再開位置を持たせている。
  `ended` ハンドラ内では DB の読み取りを待てない（待つと iOS で自動再生が途切れる）ため
- **feedCache の TTL**: 900 秒（`js/config.js`）

## iOS 上の注意点

- 音声はユーザー操作を起点にしないと再生できないため、`player.play()` はタップハンドラ内から
  同期的に呼ぶこと（`await` を挟むと再生がブロックされる）。再生位置の復元も、描画時に読み込み済みの
  状態から同期的に渡している
- Media Session の `artwork` は表示不具合の報告があるため最初から設定していない
- 曲の切り替え時に `audio.load()` を呼んではいけない。ユーザー操作で得た再生許可が外れて
  自動送りの `play()` が拒否されることがある。`src` の代入だけで読み込みは始まる
- `ended` は必ずしも発火しない。末尾までシークした場合などは `pause` で終わることがあるため、
  連続再生は `ended` だけに頼らず「終端に達した状態での停止」からも次へ送る
  （二重に送らないよう、送り済みの episodeId を覚えておく）
- それでも自動再生が拒否された場合は理由をトーストで出す（黙って止まらないようにするため）。
  メタデータは次の回のままなので、ロック画面の再生ボタンでそのまま続けられる
- 拡大は3つ重ねて止めている。単独ではどれも取りこぼすため。
  1. `touch-action: pan-y`（縦スクロールだけ許可し、ダブルタップとピンチを塞ぐ）
  2. viewport の `maximum-scale=1, user-scalable=no`（Safari は無視するが standalone 起動では効く）
  3. iOS 独自の `gesturestart` などを `preventDefault` する
  横方向にドラッグするシークバーだけは `touch-action: none` にして自前で操作を受け取る
- iOS 17.4 以降、EU 域内では PWA の standalone 起動が廃止されている（日本は対象外）
- Service Worker / IndexedDB のストレージは Chrome より制限が厳しく、長期間未使用だと破棄されうる
- Service Worker はネットワーク優先にしてある。加えて `index.html` の先頭で現行以外の
  キャッシュを削除してからアプリを読み込むため、古い Service Worker が残っていても
  次回の読み込みで最新のコードに入れ替わる（キャッシュ優先の旧版で更新が届かなくなった経験による）
