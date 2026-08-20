// ---------------------------------------------------------------------------
// RSSフィードの中継（Cloudflare Pages Functions）
//
// 配信元の多くはCORSヘッダーを付けないため、ブラウザから直接は取得できない。
// アプリと同じオリジンで動くこの関数を経由すればCORSの問題が起きず、
// 公開プロキシのようなサイズ上限やレート制限も無い。
//
// アプリからは `./api/feed?url=...` という相対パスで呼ぶ。
// ホスト名がコードに一切入らないので、配布先を変えても書き換え不要。
// ---------------------------------------------------------------------------

export async function onRequestGet({ request }) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return new Response('missing ?url=', { status: 400 });

  // 第三者のページから踏み台として呼ばれるのを防ぐ。
  // このヘッダーを送らない古いブラウザのために、無い場合は通す。
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return new Response('forbidden', { status: 403 });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('invalid url', { status: 400 });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return new Response('unsupported scheme', { status: 400 });
  }

  const upstream = await fetch(parsed.toString(), {
    headers: {
      // 配信元によってはUAが無いと弾かれる
      'user-agent': 'podcast-pwa/1.0',
      accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
    },
    // 同じフィードへの連続アクセスはCloudflare側のキャッシュで受ける
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  // ボディはストリームのまま返すので、フィードが大きくてもメモリ上限に当たらない
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/xml',
      'cache-control': 'public, max-age=300',
    },
  });
}
