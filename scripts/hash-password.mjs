// 利用者の登録用文字列を作る: node scripts/hash-password.mjs taro@example.com 'パスワード'
// 出力された "メール:ソルト:ハッシュ" を Netlify の環境変数 EXO_USERS にセミコロン区切りで並べる。
import crypto from 'node:crypto';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('使い方: node scripts/hash-password.mjs <メールアドレス> <パスワード>');
  process.exit(1);
}
if (password.length < 12) {
  console.error('パスワードは12文字以上にしてください。');
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32);
console.log(`${email.trim().toLowerCase()}:${salt.toString('hex')}:${hash.toString('hex')}`);
