// ---------------------------------------------------------------------------
// Web アプリ（リポジトリ直下）を Capacitor の webDir へ写す。
// 配信物はあくまで ../ が正で、こちらは写しただけのもの。両者を二重管理しない。
// ---------------------------------------------------------------------------
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE = join(HERE, '..');
const WEB = join(NATIVE, '..');
const OUT = join(NATIVE, 'www');

// アプリの実体だけを写す。Cloudflare 向けの設定（_redirects / functions）や
// 開発用のファイルはネイティブでは使わない。
const ENTRIES = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons'];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const entry of ENTRIES) {
  await cp(join(WEB, entry), join(OUT, entry), { recursive: true });
}

// Service Worker はネイティブでは登録しない。アプリの中身は .ipa に同梱されており、
// 更新は入れ直しで行うため、キャッシュ層を挟む意味が無いうえ、
// controllerchange による読み直しが再生を切る事故のもとになる。
const indexPath = join(OUT, 'index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace(
  '<body>',
  '<body>\n<script>window.__PODFLOW_NATIVE__ = true;</script>',
));

console.log(`www/ を作り直しました（${ENTRIES.join(', ')}）`);
