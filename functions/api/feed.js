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
  const params = new URL(request.url).searchParams;
  const target = params.get('url');
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

  // 更新の有無だけを確かめるための条件付き取得。
  // 変わっていなければ配信元が本文なしの304を返すので、数MBのフィードを落とさずに済む。
  const headers = {
    // 配信元によってはUAが無いと弾かれる
    'user-agent': 'podflow/1.0',
    accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  };
  const etag = params.get('etag');
  const modified = params.get('modified');
  if (etag) headers['if-none-match'] = etag;
  if (modified) headers['if-modified-since'] = modified;

  const upstream = await fetch(parsed.toString(), {
    headers,
    // 条件付きで問い合わせるときは、Cloudflare側のキャッシュを挟むと判定が狂う
    cf: etag || modified ? { cacheTtl: 0 } : { cacheTtl: 300, cacheEverything: true },
  });

  // 変更なし。ブラウザのキャッシュ機構と紛れないよう、304ではなく204で返す
  if (upstream.status === 304) return new Response(null, { status: 204 });

  // 次回の問い合わせに使う印を、本文とは別に渡す（同一オリジンなので素通しで読める）
  const out = new Headers({
    'content-type': upstream.headers.get('content-type') || 'application/xml',
    'cache-control': 'no-store',
  });
  const upstreamEtag = upstream.headers.get('etag');
  const upstreamModified = upstream.headers.get('last-modified');
  if (upstreamEtag) out.set('x-feed-etag', upstreamEtag);
  if (upstreamModified) out.set('x-feed-modified', upstreamModified);

  // ボディはストリームのまま返すので、フィードが大きくてもメモリ上限に当たらない
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
