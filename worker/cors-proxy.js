// ---------------------------------------------------------------------------
// 自前のCORSプロキシ（Cloudflare Workers 用）
//
// 無料の公開CORSプロキシはレスポンスサイズ上限やレート制限があり、エピソード数の多い
// 番組のRSS（数MB）で 413 やタイムアウトになる。これを自分のアカウントに置けば
// その制限が無くなり、外部サービスの停止にも左右されなくなる。
//
// これは https://podcast-proxy.lovepowerdash.workers.dev にデプロイしてある内容そのもの。
// ダッシュボードのエディタに貼り付けて使うため、スマホからでも扱える長さに収めてある。
//
// - 踏み台にされないよう、許可したオリジンからのリクエストだけ通す
// - ローカル開発から使う場合は `http://localhost:8080` を許可条件に足す
// - ボディはストリームのまま中継するので、フィードが大きくてもメモリ上限に当たらない
// ---------------------------------------------------------------------------
const ALLOWED_ORIGIN = 'https://lovepowerdash.github.io';

export default {
  async fetch(req) {
    const o = req.headers.get('origin') === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
    const u = new URL(req.url).searchParams.get('url');
    if (!o || !u) return new Response('no', { status: 403 });
    const r = await fetch(u, { headers: { 'user-agent': 'podcast-pwa' }, cf: { cacheTtl: 300, cacheEverything: true } });
    return new Response(r.body, { status: r.status, headers: { 'access-control-allow-origin': o, 'content-type': 'application/xml' } });
  },
};
