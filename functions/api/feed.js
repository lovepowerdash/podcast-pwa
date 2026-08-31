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

/** 何本ぶんまで差分として扱うか。これを超えるなら全体を渡したほうが確実 */
const MAX_DIFF_ITEMS = 200;

/**
 * XMLの中では & < > が実体参照で書かれている。解析後の文字列（端末が送ってくる目印）を
 * そのまま探しても見つからないので、書かれているままの形にも直して両方で探す。
 */
function markerForms(after) {
  const escaped = after.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped === after ? [after] : [after, escaped];
}

/**
 * 既知の回（after）より新しい <item> だけを抜き出して返す。
 * XMLを組み立て直さず、元の item をそのまま並べるので解析結果は変わらない。
 * 目印が見つからなければ null を返し、呼び出し側が全体を返す。
 *
 * RSSは新しい回から並ぶのが通例なので、目印に当たった時点で打ち切ってよい。
 * 古い順に並ぶフィードでは古い回ばかりを拾うことになるが、端末側が手持ちと
 * 突き合わせて捨てるので、無駄な転送が起きるだけで表示は壊れない。
 *
 * 本文は呼び出し側が読み終えた文字列で受け取る。Responseを渡して中で読むと、
 * 差分にできなかったときに全体を返す道が塞がれてしまうため（本文は一度しか読めない）。
 *
 * test/function.mjs から呼べるようexportしてある。
 */
export function extractNewItems(text, after, upstreamHeaders = new Headers()) {
  const markers = markerForms(after);

  const items = [];
  let found = false;
  const pattern = /<item[\s>][\s\S]*?<\/item>/g;
  let match = pattern.exec(text);
  while (match) {
    // guid か音声URLがそのまま含まれていれば、そこから先は端末が既に持っている
    if (markers.some((marker) => match[0].includes(marker))) { found = true; break; }
    items.push(match[0]);
    if (items.length > MAX_DIFF_ITEMS) break;
    match = pattern.exec(text);
  }
  if (!found) return null;

  // 番組名は表示用に使うので、channel の title だけ添える
  const title = /<channel[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(text);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>${title ? title[1] : ''}</title>
${items.join('\n')}
</channel></rss>`;

  const headers = new Headers({
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'no-store',
    // 端末側はこの印を見て、置き換えではなく手持ちへの追加として扱う
    'x-feed-partial': '1',
  });
  copyValidators(upstreamHeaders, headers);
  return new Response(body, { status: 200, headers });
}

/** 次回の問い合わせに使う印を、本文とは別に渡す（同一オリジンなので素通しで読める） */
function copyValidators(from, to) {
  const etag = from.get('etag');
  const modified = from.get('last-modified');
  if (etag) to.set('x-feed-etag', etag);
  if (modified) to.set('x-feed-modified', modified);
  return to;
}

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

  // 差分だけを返す。RSSに部分取得の仕組みは無いので、ここで新しい回だけ切り出す。
  // 配信元との通信は全体のままだが、端末が受け取る量は増えた分だけで済む。
  //
  // 目印が見つからないこと（実体参照つきの guid、古い順に並ぶフィードなど）は珍しくない。
  // その場合は全体を返すので、本文はここで読み切っておく。読んだ本文を使い回さず
  // upstream.body を返すと「本文は一度しか読めない」で中継ごと落ち、端末には
  // エラーだけが届く（引っ張って更新しても新着が出てこない原因になる）。
  const after = params.get('after');
  if (after && upstream.ok) {
    const text = await upstream.text();
    const diff = extractNewItems(text, after, upstream.headers);
    if (diff) return diff;
    return new Response(text, { status: upstream.status, headers: outHeaders(upstream) });
  }

  // ボディはストリームのまま返すので、フィードが大きくてもメモリ上限に当たらない
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders(upstream) });
}

/** 全体をそのまま返すときの応答ヘッダー */
function outHeaders(upstream) {
  return copyValidators(upstream.headers, new Headers({
    'content-type': upstream.headers.get('content-type') || 'application/xml',
    'cache-control': 'no-store',
  }));
}
