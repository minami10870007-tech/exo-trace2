// web/src → web/dist。CSS/JS にコンテンツハッシュを付けて長期キャッシュ可能にする（Netlify の build command）。
// 依存パッケージなし（Node 18+ 標準のみ）。
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'assets'), { recursive: true });

// 簡易ミニファイ：コメントと連続空白の除去（文字列・正規表現を壊さない範囲に限定）
const minifyCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '\n').replace(/\n+/g, '\n').trim();
const minifyJs = (s) => s.replace(/^\s*\/\/(?!\s*@).*$/gm, '').replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '').replace(/^\s+/gm, '').replace(/\n{2,}/g, '\n');

let html = readFileSync(join(src, 'index.html'), 'utf8');
for (const [file, minify] of [['styles.css', minifyCss], ['app.js', minifyJs]]) {
  const body = minify(readFileSync(join(src, file), 'utf8'));
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
  const [name, ext] = file.split('.');
  const out = `${name}.${hash}.${ext}`;
  writeFileSync(join(dist, 'assets', out), body);
  html = html.replace(`/assets/${file}`, `/assets/${out}`);
}
writeFileSync(join(dist, 'index.html'), html);
for (const f of ['icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'manifest.webmanifest']) {
  cpSync(join(src, f), join(dist, f));
}
// 利用者登録ページ（ブラウザ内で EXO_USERS の文字列を作る。外部送信なし）
cpSync(join(src, 'tools'), join(dist, 'tools'), { recursive: true });
writeFileSync(join(dist, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log('built →', dist);
