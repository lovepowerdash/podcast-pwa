// エンドツーエンドのスモークテスト。iTunes Search API と RSS はモックし、
// 音声だけは Range リクエストに対応したローカルサーバーから実際に配信して再生させる。
//   実行: node test/smoke.mjs   （要: playwright + Chromium）
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FX = join(HERE, 'fixtures');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.startsWith('/art/')) {
    // 番組画像。Service Worker 経由の取得も実際に通す必要があるため、実体を返す
    const buf = readFileSync(`${ROOT}/icons/icon-192.png`);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length });
    res.end(buf);
    return;
  }
  if (p.startsWith('/__audio/')) {
    const buf = readFileSync(`${FX}/tone.wav`);
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1] || 0);
      const end = range[2] ? Number(range[2]) : buf.length - 1;
      res.writeHead(206, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'content-length': end - start + 1,
      });
      res.end(buf.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': buf.length });
      res.end(buf);
    }
    return;
  }
  try {
    const file = join(ROOT, normalize(p));
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    // 本番の _redirects と同じ扱い。実体の無いパスは index.html を返す
    if (!extname(p)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(readFileSync(join(ROOT, 'index.html')));
      return;
    }
    res.writeHead(404); res.end('nf');
  }
}).listen(8099);

const fail = [];
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
// net::ERR_FAILED はテストが意図的に abort した経路のもの（フォールバック検証）なので除く
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('net::ERR_FAILED')) fail.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => fail.push(`pageerror: ${e.message}`));

await page.route('https://itunes.apple.com/search*', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ resultCount: 1, results: [{ collectionName: 'テスト番組', artistName: 'テスト作者', feedUrl: 'https://feed.test/rss.xml', trackCount: 3, artworkUrl100: 'http://127.0.0.1:8099/art/100x100bb.jpg' }] }),
}));
// 同一オリジンの中継は Pages Functions 側の処理で、この静的サーバーには無い。
// 既定では失敗させ、公開プロキシへのフォールバックを検証する（専用の検証は後段にある）
await page.route('**/api/feed*', (route) => route.abort('failed'));
// 全経路を同時に投げるので、モックしないプロキシは実ネットワークに出る前に失敗させる
await page.route('**podcast-proxy.lovepowerdash.workers.dev**', (route) => route.abort('failed'));
await page.route('**api.codetabs.com**', (route) => route.abort('failed'));
await page.route('**corsproxy.io**', (route) => route.abort('failed'));
// 配信元が直接fetchを許可していない状況（大半のRSS）を再現する
await page.route('https://feed.test/rss.xml', (route) => route.abort('failed'));
await page.route('**api.allorigins.win**', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));

/** 番組の操作メニューから項目を選ぶ（0=最新のエピソードを取得, 1=全て未再生に戻す） */
const showMenu = async (index) => {
  await page.click('#show-menu');
  await page.waitForSelector('#sheet:not([hidden])');
  await page.click(`#sheet-items button >> nth=${index}`);
};

/** 設定が実際に保存されるまで待つ。書き込みの完了前に再読み込みすると失われるため */
const waitForFollow = (field, value) => page.waitForFunction(
  ([f, v]) => new Promise((resolve) => {
    const req = indexedDB.open('podcast_pwa_db');
    req.onsuccess = () => {
      const get = req.result.transaction('follows').objectStore('follows').getAll();
      get.onsuccess = () => resolve(get.result.some((row) => row[f] === v));
    };
  }),
  [field, value],
  { timeout: 5000 },
);

const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fail.push(name); };

await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
check('ホームの空状態', (await page.textContent('#home-list')).includes('フォロー中の番組はまだありません'));
check('ブラウザで開いた空状態では追加の案内を出す',
  (await page.textContent('#home-list')).includes('ホーム画面に追加すると便利です'));

// Android などインストール可能な環境では、案内の代わりにボタンを出す
await page.evaluate(() => {
  const event = new Event('beforeinstallprompt');
  event.prompt = () => { window.__installPrompted = true; };
  window.dispatchEvent(event);
});
await page.waitForSelector('#install');
check('インストール可能ならボタンを出す', await page.isVisible('#install'));
await page.click('#install');
check('ボタンから追加の確認を呼び出す', await page.evaluate(() => window.__installPrompted === true));
await page.reload({ waitUntil: 'networkidle' });

// ホーム画面から起動している場合は案内を出さない（iOSは navigator.standalone で判定する）
await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
await page.reload({ waitUntil: 'networkidle' });
check('ホーム画面から起動していれば案内を出さない',
  !(await page.textContent('#home-list')).includes('ホーム画面に追加すると便利です'));

// --- 検索 → フォロー
await page.click('a[href="/search"]');
await page.fill('#search-input', 'テスト');
await page.click('.searchbar__btn');
await page.waitForSelector('[data-follow]');
check('iTunes検索結果の表示', (await page.textContent('#search-list')).includes('テスト番組'));
check('検索結果にも番組画像が出る',
  (await page.getAttribute('#search-list .row__art', 'src')) === 'http://127.0.0.1:8099/art/200x200bb.jpg',
  await page.getAttribute('#search-list .row__art', 'src'));
await page.click('[data-follow]');

// --- エピソード一覧
await page.waitForSelector('[data-episode]');
check('エピソード一覧の件数', (await page.locator('[data-episode]').count()) === 3, `${await page.locator('[data-episode]').count()}件`);
const titles = async () => page.locator('.ep__title').allTextContents();
let t = await titles();
check('既定は公開日の降順（新しい順）', t[0].includes('第3回'), t.join(' | '));
check('並び替えラベル', (await page.textContent('#sort-label')) === '公開日 新しい順');
check('再生時間の表示（HH:MM:SS / 秒 / MM:SS）', (await page.locator('.ep__meta').first().textContent()).includes('32分'), await page.locator('.ep__meta').first().textContent());

// --- 1タップで並び替え反転
await page.click('#sort-toggle');
t = await titles();
check('1タップで昇順に反転', t[0].includes('第1回'), t.join(' | '));
check('反転後のラベル', (await page.textContent('#sort-label')) === '公開日 古い順');
await waitForFollow('sortOrder', 'asc');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-episode]');
check('並び順が番組ごとに永続化される', (await page.textContent('#sort-label')) === '公開日 古い順');

// --- 再生
await page.click('[data-episode] >> nth=0');
await page.waitForSelector('#mini:not([hidden])');
check('ミニプレイヤーの出現', (await page.textContent('#mini-title')).includes('第1回'));
check('再生開始後も一覧に留まる', page.url().includes('/show?feed='));
await page.waitForFunction(() => document.getElementById('audio').currentTime > 1.5, null, { timeout: 8000 });
check('音声が進んでいる', await page.evaluate(() => !document.getElementById('audio').paused));
check('Media Session メタデータ', await page.evaluate(() => navigator.mediaSession?.metadata?.title?.includes('第1回') && navigator.mediaSession.metadata.artist === 'テスト番組'));
check('artwork は未設定', await page.evaluate(() => (navigator.mediaSession?.metadata?.artwork || []).length === 0));

// --- フルプレイヤー
await page.click('.mini__tap');
await page.waitForSelector('#player:not([hidden])');
check('フルプレイヤーへ拡大', (await page.textContent('#player-title')).includes('第1回'));
await page.click('#player-fwd');
check('15秒スキップ', await page.evaluate(() => document.getElementById('audio').currentTime > 15), await page.evaluate(() => `t=${document.getElementById('audio').currentTime.toFixed(1)} dur=${document.getElementById('audio').duration}`));
await page.click('#player-rate');
check('再生速度の切り替え', (await page.textContent('#player-rate')) === '1.25x');
await page.click('#player-close');
await page.waitForSelector('#player', { state: 'hidden' });
check('閉じると元の画面へ戻る', page.url().includes('/show?feed='));

// --- 永続化
await page.click('#mini-toggle'); // 一時停止 → 位置を確定保存
await page.waitForTimeout(400);
const saved = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('podcast_pwa_db');
  req.onsuccess = () => {
    const db = req.result;
    const store = db.transaction('episodes').objectStore('episodes');
    const idx = store.index('feedUrl').getAll('https://feed.test/rss.xml');
    idx.onsuccess = () => resolve(idx.result);
  };
}));
check('episodesストアへ保存（feedUrlインデックス経由）', saved.length === 1 && saved[0].position > 1, JSON.stringify(saved[0] && { id: saved[0].episodeId, pos: Math.round(saved[0].position) }));
check('episodeId の生成規則（guidあり）', saved[0]?.episodeId === 'https://feed.test/rss.xml::ep-1', saved[0]?.episodeId);
const ids = await page.evaluate(() => window.__ids || null);
const cache = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('podcast_pwa_db');
  req.onsuccess = () => {
    const s = req.result.transaction('feedCache').objectStore('feedCache').get('https://feed.test/rss.xml');
    s.onsuccess = () => resolve(s.result);
  };
}));
check('feedCache に TTL 付きで保存', cache?.ttl === 900 && cache.rawEpisodes.length === 3);
const noGuid = cache.rawEpisodes.find((e) => e.title.includes('第2回'));
check('episodeId の生成規則（guidなし → audioUrlのハッシュ）', /^https:\/\/feed\.test\/rss\.xml::[a-z0-9]+$/.test(noGuid.episodeId) && !noGuid.episodeId.includes('ep-'), noGuid.episodeId);

// --- 既読化
await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = a.duration - 0.2; return a.play(); });
await page.waitForTimeout(1500);
const read = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('podcast_pwa_db');
  req.onsuccess = () => {
    const s = req.result.transaction('episodes').objectStore('episodes').getAll();
    s.onsuccess = () => resolve(s.result);
  };
}));
check('最後まで再生すると既読になる', read.some((r) => r.isRead === true));

// --- 終わったら一覧の次の回へ自動で送る
await page.waitForFunction(() => document.getElementById('mini-title').textContent.includes('第2回'), null, { timeout: 8000 }).catch(() => {});
check('終了後に次の回を自動再生する', (await page.textContent('#mini-title')).includes('第2回'), await page.textContent('#mini-title'));
check('自動送り後も再生が続いている', await page.evaluate(() => !document.getElementById('audio').paused));

// --- iOSでは末尾までシークすると ended が発火せず pause で終わることがある。その場合も送る
await page.evaluate(() => {
  const a = document.getElementById('audio');
  a.currentTime = a.duration - 0.2;
  a.pause();
});
await page.waitForFunction(() => document.getElementById('mini-title').textContent.includes('第3回'), null, { timeout: 8000 }).catch(() => {});
check('endedが発火しなくても終端で停止したら次へ送る', (await page.textContent('#mini-title')).includes('第3回'), await page.textContent('#mini-title'));

// --- 最初の回からこの回までをまとめて再生済みにする
await page.click('#filter-toggle'); // いったん未再生のみにして対象件数を確かめやすくする
await page.click('#filter-toggle');
await page.click('[data-menu] >> nth=2'); // 昇順の3件目 = 第3回まで
await page.waitForSelector('#sheet:not([hidden])');
check('操作メニューに対象の回が出る', (await page.textContent('#sheet-title')).includes('第3回'));
page.once('dialog', (d) => d.accept());
await page.click('#sheet-items button >> nth=0');
await page.waitForTimeout(400);
check('選ぶとメニューが閉じる', await page.isHidden('#sheet'));
const marked = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('podcast_pwa_db');
  req.onsuccess = () => {
    const s = req.result.transaction('episodes').objectStore('episodes').getAll();
    s.onsuccess = () => resolve(s.result.filter((r) => r.isRead).length);
  };
}));
check('この回までをまとめて再生済みにする', marked === 3, `${marked}件`);
check('一覧の表示にも反映される', (await page.locator('.ep.is-read').count()) === 3, `${await page.locator('.ep.is-read').count()}件`);
check('取り消しボタンが出る', await page.isVisible('.toast__action'));
await page.click('.toast__action');
await page.waitForTimeout(400);
check('取り消すと元の状態に戻る', (await page.locator('.ep.is-read').count()) === 2, `${await page.locator('.ep.is-read').count()}件`);

// --- 番組まるごと未再生に戻す
page.once('dialog', (d) => d.accept());
await showMenu(1);
await page.waitForTimeout(400);
check('全て未再生に戻す', (await page.locator('.ep.is-read').count()) === 0, `${await page.locator('.ep.is-read').count()}件`);
check('戻す対象が無ければ何もしない', await (async () => {
  // 確認ダイアログを出さずに通知だけ出すのが期待動作（dialogを待ち受けない）
  await showMenu(1);
  await page.waitForTimeout(300);
  return (await page.textContent('#toast')).includes('戻す回はありません');
})());
// 以降のフィルタ検証のために、第1回と第2回を再生済みへ戻す
await page.click('[data-menu] >> nth=1');
await page.waitForSelector('#sheet:not([hidden])');
page.once('dialog', (d) => d.accept());
await page.click('#sheet-items button >> nth=0');
await page.waitForTimeout(400);

// --- 再生済みを隠すフィルタ
check('フィルタの初期ラベル', (await page.textContent('#filter-label')) === 'すべて表示');
await page.click('#filter-toggle');
await page.waitForTimeout(200);
check('再生済みを隠すと一覧から消える', !(await page.textContent('#episode-list')).includes('第1回'), (await page.locator('.ep__title').allTextContents()).join(' | '));
check('フィルタのラベルが切り替わる', (await page.textContent('#filter-label')) === '未再生のみ');
await waitForFollow('hideRead', true);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-episode]');
check('フィルタ設定が番組ごとに永続化される', (await page.textContent('#filter-label')) === '未再生のみ');
check('再読み込み後も再生済みは隠れている', !(await page.textContent('#episode-list')).includes('第1回'));
await page.click('#filter-toggle');
await page.waitForTimeout(200);
check('フィルタを戻すと全件表示に戻る', (await page.locator('[data-episode]').count()) === 3);

// --- 同一オリジンの中継が使える場合はそれで取得できる
await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));
await page.unroute('**api.allorigins.win**');
await page.route('**api.allorigins.win**', (route) => route.abort('failed'));
await showMenu(0);
await page.waitForTimeout(1200);
check('同一オリジンの中継でフィードを取得できる', (await page.locator('[data-episode]').count()) === 3);
await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => route.abort('failed'));
await page.unroute('**api.allorigins.win**');
await page.route('**api.allorigins.win**', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));

// --- 配信元がCORSを許可している場合はプロキシを通さず直接取得する
await page.unroute('https://feed.test/rss.xml');
await page.route('https://feed.test/rss.xml', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));
await page.unroute('**api.allorigins.win**');
await page.route('**api.allorigins.win**', (route) => route.abort('failed'));
await showMenu(0);
await page.waitForTimeout(1200);
check('CORS許可済みフィードは直接取得できる', (await page.locator('[data-episode]').count()) === 3);

// --- 全経路が失敗したら再試行ボタンを出す
await page.unroute('https://feed.test/rss.xml');
await page.route('https://feed.test/rss.xml', (route) => route.abort('failed'));
await page.route('**api.codetabs.com**', (route) => route.abort('failed'));
await page.route('**corsproxy.io**', (route) => route.abort('failed'));
await showMenu(0);
await page.waitForSelector('#episode-retry');
check('全経路失敗時に理由と再試行ボタンを表示', (await page.textContent('#episode-list')).includes('フィードを取得できませんでした'));

// --- 経路が1つでも復活すれば、再試行で取得できる
await page.unroute('**api.allorigins.win**');
await page.route('**api.allorigins.win**', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));
await page.click('#episode-retry');
await page.waitForSelector('[data-episode]', { timeout: 10000 });
check('経路が復活すれば再試行で取得できる', (await page.locator('[data-episode]').count()) === 3);

// --- フォロー中一覧の番組画像
await page.click('a[href="/"]');
await page.waitForSelector('.row__art');
check('フォロー中一覧に番組画像が出る',
  (await page.getAttribute('.row__art', 'src')) === 'http://127.0.0.1:8099/art/200x200bb.jpg',
  await page.getAttribute('.row__art', 'src'));

// 同じ内容なら描き直さない（画像が読み込み直されてちらつくため）
await page.evaluate(() => { document.querySelector('.row__art').dataset.kept = '1'; });
await page.click('a[href="/search"]');
await page.waitForSelector('#screen-search:not([hidden])');
await page.goBack();
await page.waitForSelector('#screen-home:not([hidden])');
check('内容が同じなら一覧を描き直さない',
  await page.evaluate(() => document.querySelector('.row__art')?.dataset.kept === '1'));

// 画像URLを持たない古いフォローを、番組名からの再検索で補完する
await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('podcast_pwa_db');
  req.onsuccess = () => {
    const store = req.result.transaction('follows', 'readwrite').objectStore('follows');
    const get = store.get('https://feed.test/rss.xml');
    get.onsuccess = () => { store.put({ ...get.result, artworkUrl: '' }); resolve(); };
  };
}));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => {
  const img = document.querySelector('.row__art');
  return img && img.getAttribute('src');
}, null, { timeout: 8000 });
check('画像URLが無いフォローは後から補完される',
  (await page.getAttribute('.row__art', 'src')) === 'http://127.0.0.1:8099/art/200x200bb.jpg');

// --- 版の表示と診断記録
await page.waitForSelector('#version');
check('ホームに版が表示される', /\d{4}-\d{2}-\d{2}/.test(await page.textContent('#version')), await page.textContent('#version'));
page.once('dialog', (d) => d.dismiss());
await page.click('#version');

// --- 開いたときに、フィードが新しくなっていたときだけ自動で更新する
const openShowFromHome = async () => {
  if (!(await page.isVisible('#screen-home'))) await page.click('#screen-show a[href="/"]');
  await page.waitForSelector('.row__main');
  await page.click('.row__main');
  await page.waitForSelector('[data-episode]');
};

// 配信元が「変わっていない」と答えた場合（本文なしの204）
await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => route.fulfill({ status: 204 }));
await openShowFromHome();
await page.waitForTimeout(900);
check('更新が無ければ一覧はそのまま', (await page.locator('[data-episode]').count()) === 3,
  `${await page.locator('[data-episode]').count()}件`);

// 1本増えたフィードを返す場合
const grownFeed = readFileSync(`${FX}/feed.xml`, 'utf8').replace('</channel>', `
    <item>
      <title>第4回 あたらしく増えた回</title>
      <guid>ep-4</guid>
      <pubDate>Mon, 26 Feb 2024 09:00:00 +0900</pubDate>
      <itunes:duration>20:00</itunes:duration>
      <enclosure url="http://localhost:8099/__audio/ep4.wav" type="audio/wav" length="1000"/>
    </item>
  </channel>`);
await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: grownFeed }));
await openShowFromHome();
await page.waitForFunction(() => document.querySelectorAll('[data-episode]').length === 4, null, { timeout: 8000 }).catch(() => {});
check('新しい回があれば自動で取り込む', (await page.locator('[data-episode]').count()) === 4,
  `${await page.locator('[data-episode]').count()}件`);
check('新着があったことを知らせる', (await page.textContent('#toast')).includes('新しいエピソードが 1 件'),
  await page.textContent('#toast'));
// 中継が差分だけを返す場合（増えた回だけ受け取って手持ちに足す）
const partialItem = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>テスト番組</title>
    <item>
      <title>第5回 差分で届いた回</title>
      <guid>ep-5</guid>
      <pubDate>Mon, 04 Mar 2024 09:00:00 +0900</pubDate>
      <itunes:duration>15:00</itunes:duration>
      <enclosure url="http://localhost:8099/__audio/ep5.wav" type="audio/wav" length="1000"/>
    </item>
</channel></rss>`;
let askedAfter = null;
await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => {
  askedAfter = new URL(route.request().url()).searchParams.get('after');
  route.fulfill({
    status: 200,
    contentType: 'application/xml',
    headers: { 'x-feed-partial': '1' },
    body: partialItem,
  });
});
await openShowFromHome();
await page.waitForFunction(() => document.querySelectorAll('[data-episode]').length === 5, null, { timeout: 8000 }).catch(() => {});
check('手持ちの最新回を目印として送る', askedAfter === 'ep-4', String(askedAfter));
check('差分だけ受け取って手持ちに足す', (await page.locator('[data-episode]').count()) === 5,
  `${await page.locator('[data-episode]').count()}件`);
check('差分でも新着件数を知らせる', (await page.textContent('#toast')).includes('新しいエピソードが 1 件'),
  await page.textContent('#toast'));

// 差分が空（新着なし）なら何も起きない
await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/xml',
  headers: { 'x-feed-partial': '1' },
  body: '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>テスト番組</title></channel></rss>',
}));
await openShowFromHome();
await page.waitForTimeout(900);
check('差分が空なら一覧は変わらない', (await page.locator('[data-episode]').count()) === 5,
  `${await page.locator('[data-episode]').count()}件`);

await page.unroute('**/api/feed*');
await page.route('**/api/feed*', (route) => route.abort('failed'));

// --- 画面は中身が揃ってから出す（組み立ての過程を見せない）
if (!(await page.isVisible('#screen-home'))) await page.click('#screen-show a[href="/"]');
await page.waitForSelector('#screen-home:not([hidden])');
await page.evaluate(() => { window.__staged = null; });
await page.evaluate(() => {
  // 一覧画面が出た瞬間に、中身がすでに入っているかを見る
  const target = document.getElementById('screen-show');
  new MutationObserver(() => {
    if (!target.hidden && window.__staged === null) {
      window.__staged = document.querySelectorAll('[data-episode]').length;
    }
  }).observe(target, { attributes: true, attributeFilter: ['hidden'] });
});
await page.click('.row__main');
await page.waitForSelector('[data-episode]');
check('画面が出た時点で一覧が入っている', await page.evaluate(() => window.__staged > 0),
  `出現時の件数: ${await page.evaluate(() => window.__staged)}`);

// --- URLの形と、直接開いたときの挙動
if (!(await page.isVisible('#screen-home'))) await page.click('#screen-show a[href="/"]');
check('ホームのURLに余計な印が付かない', new URL(page.url()).pathname === '/', page.url());
await page.click('a[href="/search"]');
check('画面ごとに普通のパスになる', new URL(page.url()).pathname === '/search', page.url());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#screen-search:not([hidden])');
check('その画面で再読み込みしても開ける', await page.isVisible('#screen-search'));
await page.goBack();
await page.waitForSelector('#screen-home:not([hidden])');
check('戻る操作で前の画面に戻れる', await page.isVisible('#screen-home'));

// エピソード一覧を直接開く（共有されたURLから来た場合）
const showUrl = `http://localhost:8099/show?feed=${encodeURIComponent('https://feed.test/rss.xml')}`;
await page.goto(showUrl, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-episode]');
check('エピソード一覧のURLを直接開ける', (await page.locator('[data-episode]').count()) > 0);

// --- 使い方
if (!(await page.isVisible('#screen-home'))) await page.click('#screen-show a[href="/"]');
await page.click('a[href="/help"]');
await page.waitForSelector('#help:not([hidden])');
const helpText = await page.textContent('.help__body');
check('使い方に主な操作が載っている',
  ['番組を追加', '並び替え', '未再生のみ', '次の回へ自動', 'ここまで再生済み', 'ロック画面', 'ホーム画面に追加']
    .every((word) => helpText.includes(word)));
await page.click('#help-close');
await page.waitForSelector('#help', { state: 'hidden' });
check('使い方を閉じるとホームに戻る', await page.isVisible('#screen-home'));

// --- ダブルタップ拡大の抑止
check('touch-action で拡大を止めている（縦スクロールのみ許可）',
  await page.evaluate(() => getComputedStyle(document.body).touchAction === 'pan-y'),
  await page.evaluate(() => getComputedStyle(document.body).touchAction));
check('シークバーは自前で操作を受け取る',
  await page.evaluate(() => getComputedStyle(document.getElementById('player-seek')).touchAction === 'none'));
check('viewport で拡大を禁止している',
  (await page.getAttribute('meta[name=viewport]', 'content')).includes('user-scalable=no'));

// --- Service Worker / manifest
check('Service Worker 登録', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
const manifest = await (await page.request.get('http://localhost:8099/manifest.webmanifest')).json();
check('manifest の display=standalone', manifest.display === 'standalone' && manifest.start_url === '/');
check('説明文にアプリ名より前の呼び名が残っていない',
  !(await page.getAttribute('meta[name=description]', 'content')).includes('PWA')
  && !manifest.description.includes('PWA'),
  await page.getAttribute('meta[name=description]', 'content'));
check('共有時のプレビュー用の情報がある',
  (await page.getAttribute('meta[property="og:title"]', 'content')) === 'podflow'
  && (await page.getAttribute('meta[property="og:image"]', 'content')).endsWith('/icons/icon-512.png'));
check('アプリ名が manifest と title で揃っている',
  manifest.name === 'podflow' && (await page.title()) === 'podflow', `${manifest.name} / ${await page.title()}`);

await browser.close();
server.close();
console.log(fail.length ? `\n=== ${fail.length} 件の失敗 ===\n` + fail.join('\n') : '\n=== すべて成功 ===');
process.exit(fail.length ? 1 : 0);
