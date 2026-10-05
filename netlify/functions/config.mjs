// GET /api/config → 画面が Supabase に接続するための設定（プロジェクト URL と公開用 anon キー）を返す。
//   値は Netlify の環境変数から読む（環境変数を変えたら再デプロイすると反映される）。
//   SUPABASE_URL      … Supabase の Project URL（例 https://abcdefgh.supabase.co）
//   SUPABASE_ANON_KEY … Supabase の公開用キー（anon / publishable）。ブラウザに渡る前提のキーで、
//                       データの保護はデータベース側（ログイン必須の関数＋利用者登録）で行う。
//   ※ Netlify の Supabase 連携（拡張機能）で作られる SUPABASE_DATABASE_URL でも動く。
const env = (key) => String(globalThis.Netlify?.env?.get(key) ?? process.env[key] ?? '').trim();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** キーの種類：anon（公開用）/ secret（秘密。ブラウザに渡してはいけない）/ ''（不明） */
export function keyKind(key) {
  if (key.startsWith('sb_publishable_')) return 'anon';
  if (key.startsWith('sb_secret_')) return 'secret';
  try {
    const role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8')).role;
    return role === 'anon' ? 'anon' : role === 'service_role' ? 'secret' : '';
  } catch {
    return '';
  }
}

export default async (req) => {
  if (req.method !== 'GET') return json({ message: 'Method Not Allowed' }, 405);
  const url = (env('SUPABASE_URL') || env('SUPABASE_DATABASE_URL')).replace(/\/+$/, '');
  const key = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    return json({ message: 'Supabase の接続設定がありません。Netlify の環境変数 SUPABASE_URL と SUPABASE_ANON_KEY を設定してから、再デプロイしてください。' }, 500);
  }
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    return json({ message: '環境変数 SUPABASE_URL の形式が正しくありません（例：https://abcdefgh.supabase.co。末尾に /rest/v1 などは付けません）。' }, 500);
  }
  const kind = keyKind(key);
  if (kind === 'secret') {
    return json({ message: '環境変数 SUPABASE_ANON_KEY に秘密のキー（service_role / secret）が入っています。安全のため接続を止めました。公開用の anon（publishable）キーに差し替えてください。' }, 500);
  }
  if (kind !== 'anon') {
    return json({ message: '環境変数 SUPABASE_ANON_KEY の値が正しくありません。Supabase の「Project Settings → API Keys」にある anon（publishable）キーを貼り付けてください。' }, 500);
  }
  return json({ supabaseUrl: url, supabaseKey: key });
};

export const config = { path: '/api/config' };
