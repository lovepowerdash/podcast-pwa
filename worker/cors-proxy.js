// ---------------------------------------------------------------------------
// 自前のCORSプロキシ（Cloudflare Workers 用）
//
// 無料の公開CORSプロキシはレスポンスサイズ上限やレート制限があり、エピソード数の多い
// 番組のRSS（数MB）で 413 やタイムアウトになる。これを自分のアカウントに置けば
// その制限が無くなり、外部サービスの停止にも左右されなくなる。
//
// 使い方は README の「自前のCORSプロキシを立てる」を参照。
// ---------------------------------------------------------------------------

// このプロキシを使ってよいオリジン。第三者に踏み台として使われないよう絞っておく。
const ALLOWED_ORIGINS = [
  'https://lovepowerdash.github.io',
  'http://localhost:8080',
];

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    }
    if (request.method !== 'GET') {
      return new Response('GET only', { status: 405, headers: corsHeaders(allowed) });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return new Response('missing ?url=', { status: 400, headers: corsHeaders(allowed) });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('invalid url', { status: 400, headers: corsHeaders(allowed) });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return new Response('unsupported scheme', { status: 400, headers: corsHeaders(allowed) });
    }

    const upstream = await fetch(parsed.toString(), {
      headers: {
        // RSS配信元によってはUAが無いと弾かれる
        'user-agent': 'podcast-pwa/1.0 (+https://github.com/lovepowerdash/podcast-pwa)',
        accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
      },
      // 同じフィードへの連続アクセスはCloudflare側のキャッシュで受ける
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    // ボディはストリームのまま返すので、フィードが大きくてもメモリ上限に当たらない
    const headers = new Headers(corsHeaders(allowed));
    headers.set('content-type', upstream.headers.get('content-type') || 'application/xml');
    headers.set('cache-control', 'public, max-age=300');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
