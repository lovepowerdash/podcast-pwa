// 中継（Cloudflare Pages Functions）の差分抽出の検証。
// ブラウザ側のテストでは通らない部分なので、単体で確かめる。
//   実行: node test/function.mjs
import { extractNewItems, onRequestGet } from '../functions/api/feed.js';

const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures.push(name);
};

const item = (n, guid) => `    <item>
      <title>第${n}回</title>
      <guid>${guid}</guid>
      <enclosure url="https://audio.test/${guid}.mp3" type="audio/mpeg"/>
    </item>`;

// 実際のフィードと同じく新しい回から並べる
const feed = (guids) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>テスト番組</title>
  <description>説明</description>
${guids.map((g, i) => item(guids.length - i, g)).join('\n')}
</channel></rss>`;

const validators = new Headers({ etag: '"abc"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' });

// --- 目印より新しい回だけを返す
{
  const res = extractNewItems(feed(['ep-5', 'ep-4', 'ep-3', 'ep-2', 'ep-1']), 'ep-3', validators);
  const body = await res.text();
  check('差分だけを返す', (body.match(/<item[\s>]/g) || []).length === 2, `${(body.match(/<item[\s>]/g) || []).length}件`);
  check('新しい回が含まれる', body.includes('ep-5') && body.includes('ep-4'));
  check('既知の回は含まれない', !body.includes('ep-3') && !body.includes('ep-2'));
  check('差分であることを伝える', res.headers.get('x-feed-partial') === '1');
  check('番組名を添える', body.includes('<title>テスト番組</title>'));
  check('更新確認用の印を引き継ぐ', res.headers.get('x-feed-etag') === '"abc"'
    && res.headers.get('x-feed-modified') === 'Mon, 01 Jan 2024 00:00:00 GMT');
}

// --- 新着が無い場合
{
  const res = extractNewItems(feed(['ep-3', 'ep-2', 'ep-1']), 'ep-3', validators);
  const body = await res.text();
  check('新着が無ければ item は空', !body.includes('<item'), body.includes('<item') ? '含まれている' : '');
}

// --- 目印が見つからない場合は全体に委ねる
{
  const res = extractNewItems(feed(['ep-3', 'ep-2', 'ep-1']), 'ep-999', validators);
  check('目印が無ければ差分にしない', res === null);
}

// --- 音声URLを目印にした場合（guidを持たないフィード向け）
{
  const res = extractNewItems(feed(['ep-3', 'ep-2', 'ep-1']), 'https://audio.test/ep-2.mp3', validators);
  const body = await res.text();
  check('音声URLでも目印になる', (body.match(/<item[\s>]/g) || []).length === 1 && body.includes('ep-3'));
}

// --- 実体参照つきの guid でも目印になる
// 端末は解析済みの文字列（&amp; が & に戻ったもの）を送ってくるので、
// 書かれているままの形にも直して探さないと、毎回フィード全体を送ることになる。
{
  const escaped = feed(['ep-3', 'ep-2', 'ep-1']).replace(/ep-2/g, 'https://ex.test/e?id=2&amp;s=1');
  const res = extractNewItems(escaped, 'https://ex.test/e?id=2&s=1', validators);
  check('実体参照つきの guid でも目印になる', res !== null
    && (await res.text()).match(/<item[\s>]/g).length === 1);
}

// --- 目印が見つからなくても、中継は全体を返す（本文の二度読みで落ちない）
// ここが落ちると端末には 500 だけが届き、引っ張って更新しても新着が出てこない。
{
  const body = feed(['ep-3', 'ep-2', 'ep-1']);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { etag: '"v2"' } });
  const url = `https://app.test/api/feed?url=${encodeURIComponent('https://ex.test/feed.xml')}&after=${encodeURIComponent('ep-999')}`;
  let res = null;
  let crashed = '';
  try {
    res = await onRequestGet({ request: new Request(url) });
  } catch (err) {
    crashed = err.message;
  }
  check('目印が無くても中継は落ちない', res !== null, crashed);
  if (res) {
    check('目印が無ければ全体を返す', res.status === 200
      && res.headers.get('x-feed-partial') === null
      && (await res.text()).includes('ep-1'));
    check('全体を返すときも更新確認用の印を引き継ぐ', res.headers.get('x-feed-etag') === '"v2"');
  }
}

console.log(failures.length ? `\n=== ${failures.length} 件の失敗 ===` : '\n=== 中継の検証: すべて成功 ===');
process.exit(failures.length ? 1 : 0);
