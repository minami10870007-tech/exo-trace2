// テスト用の「ローカル Supabase」：PostgreSQL ＋ PostgREST（Supabase と同じ API サーバー）＋ 認証（GoTrue 互換の最小実装）。
//   前提：PostgreSQL 15 以上がローカルで動いていること（接続先は環境変数 PG_ADMIN_URL、既定 postgresql://postgres:postgres@127.0.0.1:5432/postgres）
//   PostgREST は環境変数 POSTGREST_BIN か PATH 上の postgrest を使い、無ければ ~/.cache/exo-trace にダウンロードする。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = process.env.PG_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const POSTGREST_VERSION = 'v12.2.3';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
export function signJwt(payload, secret) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

function dbUrl(db) {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + db;
  return u.toString();
}

/** psql を実行して結果（タブ区切り・ヘッダーなし）を返す */
export function psql(db, sql, { file } = {}) {
  const args = [dbUrl(db), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'];
  if (file) args.push('-f', file); else args.push('-c', sql);
  return execFileSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function postgrestBin() {
  if (process.env.POSTGREST_BIN) return process.env.POSTGREST_BIN;
  try { execFileSync('postgrest', ['--version'], { stdio: 'ignore' }); return 'postgrest'; } catch { /* 無ければ取得 */ }
  const dir = join(homedir(), '.cache', 'exo-trace');
  const bin = join(dir, 'postgrest');
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const url = `https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-linux-static-x64.tar.xz`;
    execFileSync('sh', ['-c', `curl -sSL "${url}" | tar -xJ -C "${dir}"`], { stdio: 'inherit' });
  }
  return bin;
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * ローカル Supabase を起動する。
 *   users: [{ email, password, allowed }]（allowed=true なら exo.app_user に登録）
 *   today: 業務日付の固定値（exo.today）。accessTtl: アクセストークンの有効秒数
 */
export async function startSupabase({ db = 'exo_test', users = [], today = '2026-10-04', accessTtl = 3600, log = false } = {}) {
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const anonKey = signJwt({ role: 'anon', iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 365 }, jwtSecret);

  // データベース作成 → Supabase の前提（shim）→ 本番と同じ schema.sql
  psql('postgres', `drop database if exists ${db} with (force)`);
  psql('postgres', `create database ${db}`);
  psql(db, '', { file: join(here, 'shim.sql') });
  psql(db, '', { file: join(here, '..', 'schema.sql') });
  if (today) psql(db, `alter database ${db} set exo.today = '${today}'`);
  const accounts = new Map();
  for (const u of users) {
    accounts.set(u.email.toLowerCase(), { id: crypto.randomUUID(), email: u.email.toLowerCase(), password: u.password });
    if (u.allowed) psql(db, `select exo.allow_user('${u.email.toLowerCase()}')`);
  }

  // PostgREST
  const restPort = await freePort();
  const conf = join(tmpdir(), `postgrest-${db}-${restPort}.conf`);
  writeFileSync(conf, [
    `db-uri = "${dbUrl(db).replace('postgres:postgres@', 'authenticator:authenticator@')}"`,
    'db-schemas = "public"', 'db-anon-role = "anon"', `jwt-secret = "${jwtSecret}"`,
    'server-host = "127.0.0.1"', `server-port = ${restPort}`, 'db-pool = 5', 'log-level = "error"',
  ].join('\n'));
  const rest = spawn(postgrestBin(), [conf], { stdio: ['ignore', log ? 'inherit' : 'ignore', log ? 'inherit' : 'ignore'] });
  const restUrl = `http://127.0.0.1:${restPort}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(restUrl + '/')).status < 500) break; } catch { /* 起動待ち */ }
    if (i > 100) throw new Error('PostgREST が起動しません');
    await new Promise((r) => setTimeout(r, 100));
  }

  // 認証（/auth/v1）と API（/rest/v1 → PostgREST）を受ける入口。Supabase と同じく apikey ヘッダー必須・CORS 対応
  const refreshTokens = new Map(); // refresh_token → email
  const issue = (acc) => {
    const now = Math.floor(Date.now() / 1000);
    const access = signJwt({ sub: acc.id, email: acc.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + accessTtl }, jwtSecret);
    const refresh = crypto.randomBytes(16).toString('hex');
    refreshTokens.set(refresh, acc.email);
    return { access_token: access, token_type: 'bearer', expires_in: accessTtl, expires_at: now + accessTtl, refresh_token: refresh,
      user: { id: acc.id, aud: 'authenticated', role: 'authenticated', email: acc.email } };
  };
  const stats = { token: 0, refresh: 0, rpc: 0 };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, prefer',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
  const send = (res, status, body) => {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const gateway = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.apikey !== anonKey) { send(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(raw.toString() || '{}'); } catch { /* 不正 */ }
      if (url.searchParams.get('grant_type') === 'password') {
        stats.token++;
        const acc = accounts.get(String(body.email || '').toLowerCase());
        if (!acc || acc.password !== body.password) { send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }); return; }
        send(res, 200, issue(acc));
        return;
      }
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        stats.refresh++;
        const email = refreshTokens.get(body.refresh_token);
        if (!email) { send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }); return; }
        refreshTokens.delete(body.refresh_token);
        send(res, 200, issue(accounts.get(email)));
        return;
      }
      send(res, 400, { code: 400, error_code: 'validation_failed', msg: 'unsupported_grant_type' });
      return;
    }
    if (url.pathname === '/auth/v1/logout' && req.method === 'POST') { send(res, 204); return; }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (url.pathname.startsWith('/rest/v1/rpc/')) stats.rpc++;
      const headers = { 'Content-Type': req.headers['content-type'] || 'application/json', Accept: req.headers.accept || 'application/json' };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      for (const h of ['prefer', 'accept-profile', 'content-profile']) if (req.headers[h]) headers[h] = req.headers[h];
      const r = await fetch(restUrl + url.pathname.slice('/rest/v1'.length) + url.search,
        { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
      res.writeHead(r.status, { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    send(res, 404, { message: 'Not Found' });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${gateway.address().port}`;

  /** RPC を呼ぶ（テスト用）。成功なら値、失敗なら Error（status, code 付き）を投げる */
  async function rpc(token, fn, p) {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(p === undefined ? {} : { p }) });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw Object.assign(new Error((data && data.message) || 'HTTP ' + r.status), { status: r.status, code: data && data.code });
    return data;
  }
  async function signIn(email, password) {
    const r = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.msg || 'login failed');
    return data.access_token;
  }

  return {
    url, anonKey, jwtSecret, db, stats, rpc, signIn,
    sql: (q) => psql(db, q),
    close: () => { gateway.close(); rest.kill(); },
  };
}
