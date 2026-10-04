// EXO-TRACE API（Netlify Functions v2）
//   POST /api  { action: "login", email, password }        → { token, user, exp }
//   POST /api  { fn, args }  + Authorization: Bearer <token> → Apps Script の同名関数の結果
//
// 環境変数（Netlify の Site configuration > Environment variables）
//   GAS_URL         Apps Script ウェブアプリの URL（…/exec）
//   GAS_SECRET      Apps Script のスクリプトプロパティ API_SECRET と同じ値
//   SESSION_SECRET  セッショントークン署名用のランダム文字列（32文字以上）
//   EXO_USERS       利用者一覧（セミコロン区切り）。次のどちらかの形式
//                     "メール:ソルト:ハッシュ"                         … scripts/hash-password.mjs（scrypt）で作成
//                     "メール:pbkdf2-sha256:反復回数:ソルト:ハッシュ"  … ブラウザの登録ページ（tools/user-hash.html）で作成
import crypto from 'node:crypto';

const TOKEN_TTL_SEC = 12 * 60 * 60;
const ALLOWED_FUNCTIONS = new Set([
  'getConfig', 'getMasters', 'getDashboard', 'getLots', 'getInventory', 'getRecentShipments', 'getShipmentByNo',
  'saveMaster', 'saveSalesRule', 'registerReceipt', 'changeLotStatus', 'createShipment', 'cancelShipment', 'registerReturn',
  'traceLot', 'traceCustomer', 'createRecall', 'listRecalls', 'reextractRecall', 'updateRecallTarget', 'closeRecall',
]);

const env = (key) => (globalThis.Netlify?.env?.get(key) ?? process.env[key] ?? '');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', env('SESSION_SECRET')).update(body).digest());
  return body + '.' + mac;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', env('SESSION_SECRET')).update(body).digest());
  const a = Buffer.from(mac || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function findUser(email) {
  return env('EXO_USERS').split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const parts = entry.split(':');
    const mail = (parts[0] || '').trim().toLowerCase();
    if (parts[1] === 'pbkdf2-sha256') return { email: mail, algo: 'pbkdf2', iterations: Number(parts[2]), salt: parts[3], hash: parts[4] };
    return { email: mail, algo: 'scrypt', salt: parts[1], hash: parts[2] };
  }).find((u) => u.email === email);
}

const MAX_PBKDF2_ITERATIONS = 5000000;

function checkPassword(user, password) {
  // 存在しないユーザーでも同じ計算を行い、応答時間から登録有無を推測されないようにする
  const salt = Buffer.from(user?.salt || '00000000000000000000000000000000', 'hex');
  let derived;
  if (user && user.algo === 'pbkdf2') {
    if (!(user.iterations >= 100000 && user.iterations <= MAX_PBKDF2_ITERATIONS)) return false;
    derived = crypto.pbkdf2Sync(String(password), salt, user.iterations, 32, 'sha256');
  } else {
    derived = crypto.scryptSync(String(password), salt, 32);
  }
  const stored = Buffer.from(user?.hash || '', 'hex');
  return !!user && stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

async function callGas(fn, args, user) {
  const res = await fetch(env('GAS_URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script はプリフライト不要の text/plain で受ける
    body: JSON.stringify({ secret: env('GAS_SECRET'), user, fn, args }),
    redirect: 'follow',
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: 'Apps Script から不正な応答がありました（GAS_URL とデプロイ設定を確認してください）。' };
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ message: 'Method Not Allowed' }, 405);
  for (const key of ['GAS_URL', 'GAS_SECRET', 'SESSION_SECRET', 'EXO_USERS']) {
    if (!env(key)) return json({ message: 'サーバー設定が不足しています（環境変数 ' + key + '）。' }, 500);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ message: 'リクエストが不正です。' }, 400);
  }

  if (body.action === 'login') {
    const email = String(body.email || '').trim().toLowerCase();
    const user = findUser(email);
    if (!checkPassword(user, body.password || '')) {
      await new Promise((r) => setTimeout(r, 400));
      return json({ message: 'メールアドレスまたはパスワードが正しくありません。' }, 401);
    }
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
    return json({ token: sign({ sub: user.email, exp }), user: user.email, exp });
  }

  const session = verify((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!session) return json({ message: 'ログインの有効期限が切れました。もう一度ログインしてください。' }, 401);
  if (!ALLOWED_FUNCTIONS.has(body.fn)) return json({ message: '不明な処理です。' }, 400);

  try {
    const result = await callGas(body.fn, Array.isArray(body.args) ? body.args : [], session.sub);
    return result.ok ? json({ value: result.value }) : json({ message: result.message || 'エラーが発生しました。' }, 422);
  } catch (e) {
    return json({ message: 'Apps Script に接続できませんでした。時間をおいて再度お試しください。' }, 502);
  }
};

export const config = { path: '/api' };
