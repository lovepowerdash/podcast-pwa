// 中継（Cloudflare Pages Functions）の差分抽出の検証。
// ブラウザ側のテストでは通らない部分なので、単体で確かめる。
//   実行: node test/function.mjs
import { extractNewItems } from '../functions/api/feed.js';

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

const upstream = (body) => new Response(body, { headers: { etag: '"abc"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } });

// --- 目印より新しい回だけを返す
{
  const res = await extractNewItems(upstream(feed(['ep-5', 'ep-4', 'ep-3', 'ep-2', 'ep-1'])), 'ep-3');
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
  const res = await extractNewItems(upstream(feed(['ep-3', 'ep-2', 'ep-1'])), 'ep-3');
  const body = await res.text();
  check('新着が無ければ item は空', !body.includes('<item'), body.includes('<item') ? '含まれている' : '');
}

// --- 目印が見つからない場合は全体に委ねる
{
  const res = await extractNewItems(upstream(feed(['ep-3', 'ep-2', 'ep-1'])), 'ep-999');
  check('目印が無ければ差分にしない', res === null);
}

// --- 音声URLを目印にした場合（guidを持たないフィード向け）
{
  const res = await extractNewItems(upstream(feed(['ep-3', 'ep-2', 'ep-1'])), 'https://audio.test/ep-2.mp3');
  const body = await res.text();
  check('音声URLでも目印になる', (body.match(/<item[\s>]/g) || []).length === 1 && body.includes('ep-3'));
}

console.log(failures.length ? `\n=== ${failures.length} 件の失敗 ===` : '\n=== 中継の検証: すべて成功 ===');
process.exit(failures.length ? 1 : 0);
