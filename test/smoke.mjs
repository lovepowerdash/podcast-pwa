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
  } catch { res.writeHead(404); res.end('nf'); }
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
  body: JSON.stringify({ resultCount: 1, results: [{ collectionName: 'テスト番組', artistName: 'テスト作者', feedUrl: 'https://feed.test/rss.xml', trackCount: 3 }] }),
}));
// 全経路を同時に投げるので、モックしないプロキシは実ネットワークに出る前に失敗させる
await page.route('**podcast-proxy.lovepowerdash.workers.dev**', (route) => route.abort('failed'));
await page.route('**api.codetabs.com**', (route) => route.abort('failed'));
await page.route('**corsproxy.io**', (route) => route.abort('failed'));
// 配信元が直接fetchを許可していない状況（大半のRSS）を再現する
await page.route('https://feed.test/rss.xml', (route) => route.abort('failed'));
await page.route('**api.allorigins.win**', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));

const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fail.push(name); };

await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
check('ホームの空状態', (await page.textContent('#home-list')).includes('フォロー中の番組はまだありません'));

// --- 検索 → フォロー
await page.click('a[href="#/search"]');
await page.fill('#search-input', 'テスト');
await page.click('.searchbar__btn');
await page.waitForSelector('[data-follow]');
check('iTunes検索結果の表示', (await page.textContent('#search-list')).includes('テスト番組'));
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
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-episode]');
check('並び順が番組ごとに永続化される', (await page.textContent('#sort-label')) === '公開日 古い順');

// --- 再生
await page.click('.ep >> nth=0');
await page.waitForSelector('#mini:not([hidden])');
check('ミニプレイヤーの出現', (await page.textContent('#mini-title')).includes('第1回'));
check('再生開始後も一覧に留まる', page.url().includes('#/show/'));
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
check('閉じると元の画面へ戻る', page.url().includes('#/show/'));

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

// --- 再生済みを隠すフィルタ
check('フィルタの初期ラベル', (await page.textContent('#filter-label')) === 'すべて表示');
await page.click('#filter-toggle');
await page.waitForTimeout(200);
check('再生済みを隠すと一覧から消える', !(await page.textContent('#episode-list')).includes('第1回'), (await page.locator('.ep__title').allTextContents()).join(' | '));
check('フィルタのラベルが切り替わる', (await page.textContent('#filter-label')) === '未再生のみ');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-episode]');
check('フィルタ設定が番組ごとに永続化される', (await page.textContent('#filter-label')) === '未再生のみ');
check('再読み込み後も再生済みは隠れている', !(await page.textContent('#episode-list')).includes('第1回'));
await page.click('#filter-toggle');
await page.waitForTimeout(200);
check('フィルタを戻すと全件表示に戻る', (await page.locator('[data-episode]').count()) === 3);

// --- 配信元がCORSを許可している場合はプロキシを通さず直接取得する
await page.unroute('https://feed.test/rss.xml');
await page.route('https://feed.test/rss.xml', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));
await page.unroute('**api.allorigins.win**');
await page.route('**api.allorigins.win**', (route) => route.abort('failed'));
await page.click('#show-refresh');
await page.waitForTimeout(1200);
check('CORS許可済みフィードは直接取得できる', (await page.locator('[data-episode]').count()) === 3);

// --- 全経路が失敗したら再試行ボタンを出す
await page.unroute('https://feed.test/rss.xml');
await page.route('https://feed.test/rss.xml', (route) => route.abort('failed'));
await page.route('**api.codetabs.com**', (route) => route.abort('failed'));
await page.route('**corsproxy.io**', (route) => route.abort('failed'));
await page.click('#show-refresh');
await page.waitForSelector('#episode-retry');
check('全経路失敗時に理由と再試行ボタンを表示', (await page.textContent('#episode-list')).includes('フィードを取得できませんでした'));

// --- 自前プロキシの設定が最優先される（他の経路は全て失敗させたまま）
await page.route('https://my-proxy.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: readFileSync(`${FX}/feed.xml`, 'utf8') }));
await page.evaluate(() => localStorage.setItem('feedProxyTemplate', 'https://my-proxy.test/?url='));
await page.click('#episode-retry');
await page.waitForSelector('[data-episode]', { timeout: 10000 });
check('自前プロキシの設定が最優先で使われる', (await page.locator('[data-episode]').count()) === 3);

// --- Service Worker / manifest
check('Service Worker 登録', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
const manifest = await (await page.request.get('http://localhost:8099/manifest.webmanifest')).json();
check('manifest の display=standalone', manifest.display === 'standalone' && manifest.start_url === './');

await browser.close();
server.close();
console.log(fail.length ? `\n=== ${fail.length} 件の失敗 ===\n` + fail.join('\n') : '\n=== すべて成功 ===');
process.exit(fail.length ? 1 : 0);
