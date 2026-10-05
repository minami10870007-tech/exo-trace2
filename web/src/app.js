/* EXO-TRACE フロントエンド（Netlify 配信）。データと業務処理は Supabase（認証＋データベース関数 RPC）。
 *   接続先（Supabase の URL と公開用 anon キー）は /api/config（Netlify Function）から読む。
 * CSP（script-src 'self' / style-src 'self'）に合わせ、インラインのイベント属性・style 属性は使わない。 */
'use strict';

const PAGES = [
  { id: 'dashboard', label: 'ダッシュボード', short: 'ホーム', icon: 'home', grp: '概要' },
  { id: 'receipt', label: '入荷登録', short: '入荷', icon: 'inbox', grp: '日々の業務' },
  { id: 'inspect', label: '受入検品・ロット', mid: '検品・ロット', short: '検品', icon: 'check', grp: '日々の業務' },
  { id: 'shipment', label: '出荷登録', short: '出荷', icon: 'truck', grp: '日々の業務' },
  { id: 'return', label: '返品登録', short: '返品', icon: 'undo', grp: '日々の業務' },
  { id: 'inventory', label: '在庫照会', short: '在庫', icon: 'box', grp: '照会・追跡' },
  { id: 'traceLot', label: 'ロット追跡', short: '追跡', icon: 'search', grp: '照会・追跡' },
  { id: 'traceCustomer', label: '顧客追跡', short: '顧客', icon: 'user', grp: '照会・追跡' },
  { id: 'recall', label: '回収管理', short: '回収', icon: 'alert', grp: '品質' },
  { id: 'master', label: 'マスタ設定', mid: 'マスタ', short: 'マスタ', icon: 'gear', grp: '設定' },
];
const BOTTOM = ['dashboard', 'receipt', 'inspect', 'shipment', 'traceLot'];
const STORE_KEY = 'exo-trace-auth';
const MSG_EXPIRED = 'ログインの有効期限が切れました。もう一度ログインしてください。';
const MSG_OFFLINE = '通信できませんでした。電波状況を確認して、もう一度お試しください。';

const S = { sb: null, sess: null, user: '', cfg: null, M: null, page: '', inspectFilter: 'QUARANTINE,HOLD', masterTable: 'm_product',
  inventory: [], returnLine: null, pending: 0 };

// ======================================================================
// 共通
// ======================================================================
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('ja-JP'));
const icon = (name, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const code = (type, v) => ((S.cfg && S.cfg.codes[type]) || {})[v] || v || '';
const active = (rows) => rows.filter((r) => String(r.is_active) !== 'false');
const badge = (status, label) => `<span class="badge b-${esc(status)}">${esc(label || status)}</span>`;
const ALERT_STATUS = new Set(['RECALLED', 'HOLD', 'EXPIRED', 'REJECTED']);
const rowAlert = (status) => (ALERT_STATUS.has(status) ? ' class="is-alert"' : '');
const mono = (v) => `<span class="mono">${esc(v)}</span>`;
const nw = (v) => `<span class="nowrap">${esc(v)}</span>`;
/** 電話番号・メールアドレスをタップで発信・送信できるリンクにする */
const telLink = (v) => (v ? `<a href="tel:${esc(String(v).replace(/[^0-9+]/g, ''))}">${esc(v)}</a>` : '');
const mailLink = (v) => (v ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : '');
const joinNw = (arr, sep) => arr.filter((v) => v !== '' && v !== null && v !== undefined).map(nw).join(sep || '・');

function storage(read, value) {
  try {
    if (read) return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (value) localStorage.setItem(STORE_KEY, JSON.stringify(value)); else localStorage.removeItem(STORE_KEY);
  } catch (e) { /* プライベートモード等では保存しない */ }
  return null;
}

function progress(delta) {
  S.pending = Math.max(0, S.pending + delta);
  $('progress').classList.toggle('on', S.pending > 0);
}

// ----------------------------------------------------------------------
// Supabase 接続（認証 /auth/v1 ＋ データベース関数 /rest/v1/rpc）
// ----------------------------------------------------------------------
const nowSec = () => Math.floor(Date.now() / 1000);

/** 接続設定（Supabase の URL と公開用キー）を読む */
async function loadConfig() {
  let res, data = {};
  try {
    res = await fetch('/api/config', { cache: 'no-store' });
    data = await res.json();
  } catch (e) {
    throw new Error(res ? '接続設定を読み込めませんでした（' + res.status + '）。' : MSG_OFFLINE);
  }
  if (!res.ok || !data.supabaseUrl || !data.supabaseKey) throw new Error(data.message || '接続設定を読み込めませんでした。');
  S.sb = { url: data.supabaseUrl, key: data.supabaseKey };
}

async function sbFetch(path, body, token) {
  let res;
  try {
    res = await fetch(S.sb.url + path, {
      method: 'POST',
      // 公開用キーは apikey ヘッダーで送る（新形式の publishable キーは JWT ではないため Authorization には入れない）
      headers: Object.assign({ apikey: S.sb.key, 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(MSG_OFFLINE);
  }
  let data = {};
  try { const text = await res.text(); data = text ? JSON.parse(text) : {}; } catch (e) { /* 空応答 */ }
  return { res, data };
}

/** Supabase Auth のエラーを日本語にする */
function authMessage(res, data) {
  const code = data.error_code || data.error || '';
  if (code === 'invalid_credentials' || (code === 'invalid_grant' && /credentials/i.test(data.error_description || ''))) {
    return 'メールアドレスまたはパスワードが正しくありません。';
  }
  if (code === 'email_not_confirmed') return 'このアカウントはまだ有効になっていません。管理者に連絡してください。';
  if (code === 'user_banned') return 'このアカウントは利用停止されています。管理者に連絡してください。';
  if (code === 'validation_failed' || code === 'email_address_invalid') return 'メールアドレスの形式が正しくありません。';
  if (res.status === 429 || code === 'over_request_rate_limit') return 'ログインの試行回数が多すぎます。しばらく待ってからお試しください。';
  if (res.status >= 500) return 'ログインサーバーに接続できません。しばらくしてから再度お試しください。（' + res.status + '）';
  return 'ログインできませんでした（' + (data.msg || data.error_description || data.message || res.status) + '）。';
}

/** persist=false のときは保存しない（ログイン直後、利用権限を確認してから保存する） */
function setSession(data, persist) {
  S.sess = { access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: Number(data.expires_at) || nowSec() + Number(data.expires_in || 3600), user: (data.user && data.user.email) || S.user };
  S.user = S.sess.user;
  if (persist !== false) storage(false, S.sess);
}

/**
 * アクセストークンを更新する。同時に呼ばれても1回だけ実行（リフレッシュトークンは1回限り有効のため）。
 * 戻り値：true＝更新できた／false＝セッションが無効（再ログインが必要）。一時的な障害は例外。
 */
let refreshing = null;
function refreshSession() {
  if (!refreshing) {
    refreshing = (async () => {
      if (!S.sess || !S.sess.refresh_token) return false;
      // 別のタブが先に更新していれば、その新しいトークンを使う（古いリフレッシュトークンを再利用しない）
      const stored = storage(true);
      if (stored && stored.refresh_token && stored.user === S.sess.user && stored.refresh_token !== S.sess.refresh_token) {
        S.sess = stored;
        if (stored.expires_at > nowSec() + 60) return true;
      }
      const cur = S.sess;
      const { res, data } = await sbFetch('/auth/v1/token?grant_type=refresh_token', { refresh_token: cur.refresh_token });
      if (S.sess !== cur) return !!S.sess; // 更新中にログアウト・切り替えされた：結果は保存しない
      if (res.ok && data.access_token) { setSession(data); return true; }
      if ([400, 401, 403].includes(res.status)) return false;
      throw new Error('サーバーに接続できません。しばらくしてから再度お試しください。（' + res.status + '）');
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** 有効なアクセストークンを用意する。sentToken を指定したら、そのトークンが拒否された前提で更新する */
async function ensureSession(sentToken) {
  if (!S.sess) throw new Error(MSG_EXPIRED);
  if (sentToken ? S.sess.access_token !== sentToken : S.sess.expires_at >= nowSec() + 60) return; // 更新不要・別の呼び出しで更新済み
  if (!(await refreshSession())) {
    if (S.sess) logout(MSG_EXPIRED);
    throw new Error(MSG_EXPIRED);
  }
}

/** 画面の関数名（camelCase）と引数 → データベース関数（snake_case）と引数オブジェクト p */
const RPC_ARGS = { getLots: ['statuses'], getRecentShipments: ['limit'], getShipmentByNo: ['no'], saveMaster: ['table', 'data'],
  saveSalesRule: ['regulatoryClass', 'customerType', 'allowed'], cancelShipment: ['shipmentId', 'reason'], traceLot: ['query'],
  traceCustomer: ['customerId', 'from', 'to'], reextractRecall: ['recallId'], closeRecall: ['recallId'] };

function rpcError(res, data) {
  if (data.code === 'P0001' && data.message) return new Error(data.message); // 業務エラー（入力チェック等）
  if (data.code === 'PGRST202' || res.status === 404) {
    return new Error('データベースの準備ができていません。Supabase の SQL Editor で supabase/schema.sql を実行してください。');
  }
  if (data.code === '57014') return new Error('処理に時間がかかりすぎたため中断しました。少し待ってから、もう一度お試しください。');
  return new Error('サーバーでエラーが発生しました（' + (data.code || res.status) + '）。時間をおいて再度お試しください。');
}

async function api(fn, ...args) {
  const p = RPC_ARGS[fn] ? Object.fromEntries(RPC_ARGS[fn].map((k, i) => [k, args[i] === undefined ? null : args[i]])) : (args[0] || {});
  const path = '/rest/v1/rpc/' + fn.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  progress(1);
  try {
    await ensureSession();
    const sent = S.sess.access_token;
    let { res, data } = await sbFetch(path, { p }, sent);
    if (res.status === 401) {
      await ensureSession(sent);
      ({ res, data } = await sbFetch(path, { p }, S.sess.access_token));
    }
    if (res.status === 401) { logout(MSG_EXPIRED); throw new Error(MSG_EXPIRED); }
    // 利用者登録が無い・停止された（データベース関数 exo.require_user のエラー）→ ログアウト
    if (res.status === 403 && /利用権限|ログインしてください/.test(data.message || '')) { logout(data.message); throw new Error(data.message); }
    if (res.status === 403) throw new Error('この操作を行う権限がありません。管理者に連絡してください。');
    if (!res.ok) throw rpcError(res, data);
    return data;
  } finally {
    progress(-1);
  }
}

/** 画面に出す文言から内部の規則番号（BR-10 など）を除く */
const userText = (t) => String(t || '').replace(/（BR-\d+）/g, '');

function alertBox(id, text, kind, noScroll) {
  $(id).innerHTML = text ? `<div class="alert alert-${kind || 'ok'}" role="${kind === 'ng' ? 'alert' : 'status'}">${esc(userText(text))}</div>` : '';
  // 結果・エラーは見える位置まで移動する（長いフォームやダイアログで、固定ボタンの下に隠れないように）
  if (text && !noScroll) $(id).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** ラベルの文字（「任意」などの補足を除く） */
function labelOf(el) {
  const lab = el.id && document.querySelector(`label[for="${el.id}"]`);
  if (!lab) return el.getAttribute('aria-label') || '';
  return [...lab.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
}

/**
 * 必須項目の入力チェック。未入力の欄に印を付けて最初の欄へ移動し、何が足りないかを表示する。
 * extra: 追加で未入力として扱う要素。問題がなければ true
 */
function checkRequired(container, msgId, extra) {
  const missing = [];
  container.querySelectorAll('[required]').forEach((el) => {
    if (el.closest('[hidden]') || el.disabled) return;
    if (String(el.value || '').trim()) el.removeAttribute('aria-invalid'); else missing.push(el);
  });
  (extra || []).forEach((el) => { if (!missing.includes(el)) missing.push(el); });
  if (!missing.length) return true;
  missing.forEach((el) => el.setAttribute('aria-invalid', 'true'));
  alertBox(msgId, '未入力の項目があります：' + [...new Set(missing.map(labelOf))].join('、'), 'ng', true);
  missing[0].focus(); // フォーカスした欄が見える位置へ（上下の固定表示は scroll-padding で避ける）
  return false;
}

function toast(text, kind, action) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'ng' ? ' toast-ng' : '');
  const span = document.createElement('span');
  span.textContent = userText(text);
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.remove(); action.run(); });
    el.appendChild(b);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 7000 : kind === 'ng' ? 6000 : 3500);
}

/** ボタンを処理中表示にして二重送信を防ぐ */
async function busy(btn, fn) {
  if (btn && btn.dataset.busy === '1') return undefined;
  if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
  try { return await fn(); } finally { if (btn) { btn.dataset.busy = ''; btn.disabled = false; } }
}

function options(rows, valueKey, labelFn, placeholder) {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    rows.map((r) => `<option value="${esc(r[valueKey])}">${esc(labelFn(r))}</option>`).join('');
}

/** タブの状態（選択中だけを Tab キーで止まる位置にし、表示先のパネルと関連付ける） */
function syncTabs(list) {
  list.querySelectorAll('[role="tab"]').forEach((b) => {
    const sel = b.getAttribute('aria-selected') === 'true';
    b.tabIndex = sel ? 0 : -1;
    b.setAttribute('aria-controls', list.dataset.panel);
  });
}

function scrollFade(el) {
  const update = () => {
    el.classList.toggle('fade-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    el.classList.toggle('fade-l', el.scrollLeft > 2);
  };
  const sel = el.querySelector('[aria-selected="true"]');
  if (sel) {
    const l = sel.offsetLeft, r = l + sel.offsetWidth;
    if (r > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = r - el.clientWidth + 24;
    else if (l < el.scrollLeft) el.scrollLeft = l - 8;
  }
  if (!el.dataset.fade) { el.dataset.fade = '1'; el.addEventListener('scroll', update, { passive: true }); window.addEventListener('resize', update); }
  update();
}

function empty(text, ic) { return `<div class="empty">${icon(ic || 'box')}${esc(text)}</div>`; }

/**
 * レスポンシブ表。headers: [{ label, cls }]、cells: 文字列 または { html, cls }。
 * 768px 未満では各行がカードになり、data-label が見出しとして表示される。
 */
function table(headers, rows, opt) {
  opt = opt || {};
  if (!rows.length) return empty(opt.empty || 'データがありません', opt.emptyIcon);
  const hs = headers.map((h) => (typeof h === 'string' ? { label: h } : h));
  const statusIdx = hs.findIndex((h) => /(^|\s)status(\s|$)/.test(h.cls || ''));
  const cellHtml = (c) => (c !== null && typeof c === 'object' ? c.html : esc(c));
  return `<div class="table-wrap"><table class="rtable${hs.length > 5 ? ' wide-table' : ''}"><thead><tr>` +
    hs.map((h) => `<th scope="col" class="${h.cls || ''}">${esc(h.label)}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r) => `<tr${r.attrs || ''}>` + r.cells.map((c, i) => {
      const h = hs[i] || {};
      const isObj = c !== null && typeof c === 'object';
      const content = isObj ? c.html : esc(c);
      const cls = [h.cls, isObj ? c.cls : '', content === '' ? 'blank' : ''].filter(Boolean).join(' ');
      // カード表示では状態バッジを1行目（主項目の右）に出す
      const extra = /(^|\s)primary(\s|$)/.test(h.cls || '') && statusIdx >= 0 && r.cells[statusIdx] !== '' ? `<div class="card-status">${cellHtml(r.cells[statusIdx])}</div>` : '';
      return `<td class="${cls}" data-label="${esc(h.label)}">${content === '' ? '' : '<div class="v">' + content + '</div>' + extra}</td>`;
    }).join('') + '</tr>').join('') + '</tbody></table></div>';
}
const num = (v) => ({ html: esc(typeof v === 'number' ? fmt(v) : v) });
/** 残日数：90日以内は警告色、期限切れは赤 */
const days = (d) => ({ html: esc(d === null || d === undefined ? '' : d), cls: d === null || d === undefined ? '' : d < 0 ? 'is-danger' : d <= 90 ? 'is-warn' : '' });
const html = (h, cls) => ({ html: h, cls });

/** 確認・入力ダイアログ。input 指定時は入力値（キャンセル時 null）を返す */
function ask(o) {
  return new Promise((resolve) => {
    const dlg = $('dialog');
    $('dialogTitle').textContent = o.title;
    $('dialogBody').textContent = o.body || '';
    $('dialogBody').hidden = !o.body;
    $('dialogInputWrap').hidden = !o.input;
    $('dialogInputLabel').textContent = o.input || '';
    $('dialogInput').value = '';
    $('dialogInput').removeAttribute('aria-invalid');
    $('dialogInputErr').textContent = '';
    const ok = $('dialogOk');
    ok.textContent = o.okText || 'OK';
    $('dialogForm').querySelector('button[value="cancel"]').hidden = !!o.noCancel;
    ok.className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
    const form = $('dialogForm');
    const onSubmit = (e) => {
      if (o.input && e.submitter && e.submitter.value === 'ok' && !$('dialogInput').value.trim()) {
        e.preventDefault();
        $('dialogInput').setAttribute('aria-invalid', 'true');
        $('dialogInputErr').textContent = o.input + 'を入力してください。';
        $('dialogInput').focus();
      }
    };
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      form.removeEventListener('submit', onSubmit);
      const yes = dlg.returnValue === 'ok';
      resolve(o.input ? (yes ? $('dialogInput').value.trim() : null) : yes);
    });
    dlg.returnValue = '';
    dlg.showModal();
    (o.input ? $('dialogInput') : ok).focus();
  });
}

// ======================================================================
// 認証・起動
// ======================================================================
function showLogin(message, canRetry) {
  $('retryBtn').hidden = !canRetry;
  closeSheet();
  if ($('dialog').open) $('dialog').close();
  if ($('masterDialog').open) $('masterDialog').close();
  if ($('guideDialog').open) { G_STATE.navigating = true; $('guideDialog').removeEventListener('close', onGuideClosed); $('guideDialog').close(); $('guideDialog').addEventListener('close', onGuideClosed); }
  $('app').hidden = true;
  $('login').hidden = false;
  alertBox('loginMsg', message || '', 'ng');
  if (S.user && !$('loginEmail').value) $('loginEmail').value = S.user;
  setTimeout(() => $(S.user ? 'loginPassword' : 'loginEmail').focus(), 0);
}

/** この画面だけログイン画面に戻す（保存されたセッションには触れない。別のタブの状態変化を受けたとき用） */
function endLocal(message) {
  S.sess = null;
  clearScreens();
  showLogin(message);
}

function logout(message) {
  const sess = S.sess;
  S.sess = null;
  storage(false, S.user ? { user: S.user } : null); // 次回ログイン用にメールアドレスだけ残す
  // サーバー側のセッションも無効化（失敗しても画面はログアウトする）
  if (sess && S.sb) sbFetch('/auth/v1/logout?scope=local', undefined, sess.access_token).catch(() => {});
  clearScreens();
  showLogin(typeof message === 'string' ? message : '');
}

/** 前の利用者の入力内容・表示結果を消す（共用端末で別の人がログインする場合に備える） */
function clearScreens() {
  document.querySelectorAll('#app form').forEach((f) => f.reset());
  ['dashKpis', 'dashBody', 'rcMsg', 'insMsg', 'insBody', 'shLines', 'shMsg', 'shRecent', 'rtShipment', 'rtMsg', 'invBody', 'tlBody', 'tcBody',
    'rcLots', 'rclFormMsg', 'rclList', 'msList'].forEach((id) => { if ($(id)) $(id).innerHTML = ''; });
  $('rtForm').hidden = true;
  showResume(false);
  delete $('rcExp').dataset.manual;
  Object.assign(S, { cfg: null, M: null, inventory: [], returnLine: null, inspectFilter: 'QUARANTINE,HOLD', masterTable: 'm_product' });
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

async function login(e) {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('[type="submit"]');
  await busy(btn, async () => {
    alertBox('loginMsg', '');
    try {
      if (!S.sb) await loadConfig();
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      if (!checkRequired($('loginForm'), 'loginMsg')) return;
      const { res, data } = await sbFetch('/auth/v1/token?grant_type=password', { email, password });
      if (!res.ok || !data.access_token) {
        const msg = authMessage(res, data);
        if (/正しくありません/.test(msg)) { $('loginPassword').setAttribute('aria-invalid', 'true'); $('loginPassword').select(); }
        if (/形式/.test(msg)) { $('loginEmail').setAttribute('aria-invalid', 'true'); $('loginEmail').focus(); }
        throw new Error(msg);
      }
      const old = S.sess;
      if (old) sbFetch('/auth/v1/logout?scope=local', undefined, old.access_token).catch(() => {}); // 前のセッションは無効化
      if (S.user && S.user.toLowerCase() !== email.toLowerCase()) clearScreens();
      S.user = email;
      setSession(data, false);
      $('loginPassword').value = '';
      await boot();
    } catch (err) {
      alertBox('loginMsg', err.message, 'ng');
    }
  });
}

async function boot() {
  try {
    S.cfg = await api('getConfig'); // 利用権限の確認を兼ねる（権限がなければログイン画面に戻る）
    todayCheckedAt = Date.now();
  } catch (err) {
    // 通信障害など：セッションは残したまま、再接続できるようにする
    if (S.sess) showLogin(err.message, true);
    return;
  }
  storage(false, S.sess); // 利用権限を確認できたセッションだけを保存する
  $('login').hidden = true;
  $('app').hidden = false;
  renderNav();
  $('whoSide').textContent = S.user;
  $('whoSheet').textContent = S.user;
  try {
    await reloadMasters();
    ['rcDate', 'shDate'].forEach((id) => { $(id).value = S.cfg.today; });
    if (!$('shLines').children.length) addLine();
    route();
    // 初めてログインした人には、ステップ形式のガイドを自動で表示する
    if (!(S.cfg.prefs && S.cfg.prefs.guideDone)) openGuide(0);
    G_STATE.opener = null;
  } catch (err) {
    if (S.sess) toast(err.message, 'ng');
  }
}

/** 日付が変わっていたら、入力欄の既定の日付（当日）を新しい日付にする（端末を開いたまま翌日に使う場合） */
let todayCheckedAt = 0;
async function refreshToday() {
  if (!S.sess || !S.cfg || $('app').hidden || Date.now() - todayCheckedAt < 5 * 60 * 1000) return;
  todayCheckedAt = Date.now();
  try {
    const cfg = await api('getConfig');
    const old = S.cfg.today;
    if (cfg.today === old) return;
    S.cfg.today = cfg.today;
    ['rcDate', 'shDate', 'rtDate'].forEach((id) => { if ($(id).value === old) $(id).value = cfg.today; });
    toast('日付が変わったため、入力欄の日付を ' + cfg.today + ' にしました');
    if (S.page === 'dashboard') loadDashboard().catch(() => {});
  } catch (e) { /* 次の機会に確認する */ }
}

/** 再接続（通信障害・設定の読み込み失敗からの復帰） */
async function retry(btn) {
  await busy(btn, async () => {
    alertBox('loginMsg', '');
    try {
      if (!S.sb) await loadConfig();
    } catch (err) {
      showLogin(err.message, true);
      return;
    }
    if (S.sess) await boot(); else showLogin('');
  });
}

function renderNav() {
  let grp = '';
  $('sideNav').innerHTML = PAGES.map((p) => {
    const head = p.grp !== grp ? `<div class="grp">${esc((grp = p.grp))}</div>` : '';
    return head + `<button type="button" data-action="go" data-page="${p.id}" aria-label="${esc(p.label)}" title="${esc(p.label)}">${icon(p.icon)}<span class="lbl-long">${esc(p.label)}</span><span class="lbl-short" aria-hidden="true">${esc(p.short)}</span></button>`;
  }).join('');
  $('bottomNav').innerHTML = BOTTOM.map((id) => {
    const p = PAGES.find((x) => x.id === id);
    return `<button type="button" data-action="go" data-page="${p.id}">${icon(p.icon)}<span>${esc(p.short)}</span></button>`;
  }).join('') + `<button type="button" data-action="openSheet" id="moreBtn" aria-haspopup="dialog">${icon('menu')}<span>メニュー</span></button>`;
  $('sheetNav').innerHTML = PAGES.filter((p) => !BOTTOM.includes(p.id)).map((p) =>
    `<button type="button" data-action="go" data-page="${p.id}">${icon(p.icon)}<span>${esc(p.mid || p.label)}</span></button>`).join('');
}

function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  showPage(page.id);
}

function showPage(id) {
  const page = PAGES.find((p) => p.id === id);
  S.page = id;
  PAGES.forEach((p) => { $('page-' + p.id).hidden = p.id !== id; });
  document.querySelectorAll('[data-action="go"]').forEach((b) => {
    if (b.dataset.page === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const inBottom = BOTTOM.includes(id);
  const more = $('moreBtn');
  if (more) { if (inBottom) more.removeAttribute('aria-current'); else more.setAttribute('aria-current', 'page'); }
  $('pageTitle').textContent = page.label;
  document.title = page.label + '｜EXO-TRACE';
  closeSheet();
  $('toasts').innerHTML = '';
  window.scrollTo(0, 0);
  const loaders = { dashboard: loadDashboard, inspect: loadInspect, shipment: loadShipmentPage, inventory: loadInventory, return: loadReturnRecent, traceLot: loadTraceRecent,
    recall: loadRecalls, master: loadMaster };
  if (loaders[id]) loaders[id]().catch((e) => toast(e.message, 'ng'));
  if (id === 'receipt' || id === 'shipment') renderPrereq();
}

function go(id) {
  if (location.hash === '#/' + id) showPage(id); else location.hash = '#/' + id;
}

function openSheet() {
  $('sheetBackdrop').hidden = false;
  $('moreSheet').hidden = false;
  const cur = $('sheetNav').querySelector('[aria-current="page"]') || $('sheetNav').querySelector('button');
  if (cur) cur.focus();
}
function closeSheet() {
  if ($('moreSheet').hidden) return;
  $('sheetBackdrop').hidden = true;
  $('moreSheet').hidden = true;
}

async function reloadMasters() {
  S.M = await api('getMasters');
  const prod = active(S.M.products);
  $('rcSupplier').innerHTML = options(active(S.M.suppliers), 'id', (r) => r.supplier_code + '　' + r.name, '選択してください');
  $('rcProduct').innerHTML = options(prod, 'id', (r) => r.product_code + '　' + r.name, '選択してください');
  $('shCustomer').innerHTML = options(active(S.M.customers), 'id', (r) => r.customer_code + '　' + r.name + '（' + code('customer_type', r.customer_type) + '）', '選択してください');
  $('tcCustomer').innerHTML = options(S.M.customers, 'id', (r) => r.customer_code + '　' + r.name, '選択してください');
  fillReceiptLocations();
  renderPrereq();
  document.querySelectorAll('.slProd').forEach((sel) => {
    const v = sel.value;
    sel.innerHTML = options(prod, 'id', (r) => r.product_code + '　' + r.name, '商品を選択');
    sel.value = v;
  });
}


// ======================================================================
// はじめてガイド（初回ログイン時に自動表示。右上の「?」からいつでも開ける）
// ======================================================================
const GUIDE = [
  { icon: 'home', title: 'EXO-TRACE へようこそ',
    body: '仕入れたエクソソームを「ロット」ごとに管理し、どのロットを・いつ・どのお客様に販売したかを、すぐに調べられるようにするシステムです。\n\nこのガイドでは、使い始めるまでの準備（7つ）を順番にご案内します。目安は 10分ほどです。各ステップの「画面を開く」で、実際の画面に移動できます。' },
  { key: 'suppliers', icon: 'gear', page: 'master', table: 'm_supplier', title: '仕入先を登録する', short: '仕入先の登録',
    body: '「マスタ設定」の「仕入先」タブで「新規登録」を押し、エクソソームの仕入先（メーカー・卸）を登録します。\n\nコードは英数字とハイフンで付けます（例：S001）。' },
  { key: 'products', icon: 'box', page: 'master', table: 'm_product', title: '商品を登録する', short: '商品の登録',
    body: '「商品」タブで、取り扱う商品を登録します。\n\n・保管温度区分（-80℃など）：入庫できる保管場所が決まります\n・有効期間（日）：製造日から使用期限を自動計算します\n・規制区分：販売できる顧客の種類が決まります' },
  { key: 'customers', icon: 'user', page: 'master', table: 'm_customer', title: '顧客を登録する', short: '顧客の登録',
    body: '「顧客」タブで販売先を登録します。\n\n医療機関の場合は医療機関コードが必須です。メールアドレス・電話番号は、回収が必要になったときの連絡先として使います。' },
  { key: 'rules', icon: 'check', page: 'master', table: 'rules', title: '販売できる組合せを確認する', short: '販売可否ルールの確認',
    body: '「販売可否ルール」タブで、商品の規制区分 × 顧客区分ごとに「出荷してよいか」を決めます。\n\n最初の設定は仮のものです。法令上の区分を確認して見直したら、下のチェックを入れてください。' },
  { key: 'lots', icon: 'inbox', page: 'receipt', title: '入荷を登録する', short: '入荷の登録',
    body: '商品が届いたら「入荷登録」で、仕入先ロット番号・使用期限（または製造日）・数量を入力します。\n\n社内ロット番号が自動で付き、ロットは「検品待ち」になります。' },
  { key: 'released', icon: 'check', page: 'inspect', title: '検品して合格にする', short: '検品',
    body: '「検品・ロット」で COA（試験成績書）を確認し、判定を「合格」にします。\n\n合格したロットだけが出荷できます。問題があれば「保留」「不合格」にします。' },
  { key: 'shipments', icon: 'truck', page: 'shipment', title: '出荷を登録する', short: '出荷の登録',
    body: '「出荷登録」で顧客と商品・数量を選びます。使用期限の近いロットから自動で割り当てるので、ロットを選ぶ必要はありません。\n\n出荷すると「どのロットを誰に売ったか」が記録されます。' },
  { icon: 'search', page: 'traceLot', title: '準備が整いました', short: 'まとめ',
    body: '日々の業務は「入荷 → 検品 → 出荷」の繰り返しです。\n\n・ロット追跡：ロット番号から、販売先と連絡先を一覧できます\n・返品登録：返品された商品を、出荷番号から受け付けます（「メニュー」内）\n・回収管理：問題のあるロットを選ぶと、対象のお客様を自動で抽出します（「メニュー」内）\n\nこのガイドは、画面右上の「?」からいつでも開けます。' },
];
const SETUP_STEPS = GUIDE.map((g, i) => ({ g, i })).filter((x) => x.g.key);
const LAST = GUIDE.length - 1;
const G_STATE = { step: 0, justDone: '', opener: null, navigating: false };

/** 準備の進み具合（サーバーの登録状況。販売可否ルールは誰かが「確認した」と記録したら完了） */
function setupState() {
  return (S.cfg && S.cfg.setup) || {};
}
function setupDone(st) { return SETUP_STEPS.every((x) => st[x.g.key]); }
function firstTodo(st) { const x = SETUP_STEPS.find((y) => !st[y.g.key]); return x ? x.i : -1; }

function renderGuide() {
  const i = G_STATE.step, g = GUIDE[i], st = setupState();
  const done = setupDone(st), todo = firstTodo(st);
  const n = SETUP_STEPS.findIndex((x) => x.i === i);
  const remaining = SETUP_STEPS.filter((x) => !st[x.g.key]);
  $('guideCount').textContent = n >= 0 ? `準備 ${n + 1} / ${SETUP_STEPS.length}` : i === 0 ? 'はじめに' : 'まとめ';
  $('guideBar').style.width = Math.round((SETUP_STEPS.filter((x) => st[x.g.key]).length / SETUP_STEPS.length) * 100) + '%';
  $('guideIcon').innerHTML = icon(i === LAST && !done ? 'flag' : g.icon);
  // 最後のステップは、準備が終わっているかで内容を変える
  if (i === LAST && !done) {
    $('guideTitle').textContent = `あと ${remaining.length} つの準備があります`;
    $('guideBody').textContent = '次の準備が残っています。上から順に進めると、入荷から出荷までが使えるようになります。\n\n' + remaining.map((x) => '・' + x.g.title).join('\n');
  } else {
    $('guideTitle').textContent = g.title;
    $('guideBody').textContent = g.body;
  }
  let status = G_STATE.justDone ? `<div class="guide-done-banner" role="status">${icon('check')}<span>${esc(G_STATE.justDone)}</span></div>` : '';
  G_STATE.justDone = '';
  $('guideAfter').innerHTML = g.key === 'rules'
    ? `<label class="check guide-rules"><input type="checkbox" id="guideRulesChk"${st.rules ? ' checked' : ''}><span>販売可否ルールを確認した</span></label>` : '';
  if (g.key === 'rules') {
    status += st.rules ? `<span class="guide-state done">${icon('check')}このステップは完了しています</span>` : `<span class="guide-state todo">${icon('flag')}まだ確認していません</span>`;
  } else if (g.key) {
    status += st[g.key] ? `<span class="guide-state done">${icon('check')}このステップは完了しています</span>`
      : `<span class="guide-state todo">${icon('flag')}まだ登録がありません</span>`;
  } else if (i === 0 && done) {
    status += `<span class="guide-state done">${icon('check')}準備はすべて完了しています</span>`;
  }
  $('guideStatus').innerHTML = status;
  const page = g.page && PAGES.find((p) => p.id === g.page);
  $('guideGo').hidden = !page || (i === LAST && !done);
  if (page) $('guideGo').textContent = `「${g.table === 'rules' ? '販売可否ルール' : g.table ? MASTER[g.table].label + 'の登録' : page.label}」の画面を開く`;
  // 未完了のステップでは「画面を開く」を主ボタンにする（「次へ」で作業を飛ばさないように）
  const work = g.key && !st[g.key] && g.key !== 'rules';
  $('guideGo').className = 'btn btn-block ' + (work ? 'btn-primary' : 'btn-secondary');
  $('guidePrev').hidden = i === 0;
  $('guideNext').textContent = i === LAST ? (done ? 'はじめる' : `次の準備へ（${GUIDE[todo].short}）`)
    : i === 0 ? (done ? '次へ' : todo > 1 ? `続きから（${GUIDE[todo].short}）` : 'はじめる') : '次へ';
  $('guideNext').className = 'btn ' + (work ? 'btn-secondary' : 'btn-primary');
  $('guideNext').dataset.jump = i === LAST && !done ? String(todo) : i === 0 && !done && todo > 1 ? String(todo) : '';
  $('guideSkip').hidden = i === LAST && done;
  $('guideDots').innerHTML = GUIDE.map((x, j) => `<li class="${j === i ? 'cur' : x.key && st[x.key] ? 'done' : ''}"></li>`).join('');
}

/** ガイドを開く。step を省略すると、準備の途中なら次にやるステップから */
function openGuide(step) {
  if (step === undefined) { const t = firstTodo(setupState()); step = t >= 0 ? t : 0; }
  G_STATE.step = Math.max(0, Math.min(LAST, step));
  if (!$('guideDialog').open) G_STATE.opener = document.activeElement;
  G_STATE.navigating = false;
  showResume(false);
  closeSheet();
  renderGuide();
  if (!$('guideDialog').open) $('guideDialog').showModal();
  $('guideNext').focus();
}

function closeGuide() {
  if ($('guideDialog').open) $('guideDialog').close();
}

/** ガイドを閉じたとき：「見た」と記録し（次回から自動では開かない）、元の場所にフォーカスを戻す */
function onGuideClosed() {
  if (S.cfg && !(S.cfg.prefs && S.cfg.prefs.guideDone)) {
    S.cfg.prefs = Object.assign({}, S.cfg.prefs, { guideDone: true });
    api('saveUserPrefs', { guideDone: true }).catch(() => {});
  }
  if (G_STATE.navigating) return;
  const o = G_STATE.opener;
  (o && o.isConnected && o.offsetParent !== null ? o : $('main')).focus({ preventScroll: true });
}

function guideNext() {
  const jump = $('guideNext').dataset.jump;
  if (jump) { G_STATE.step = Number(jump); renderGuide(); $('guideNext').focus(); return; }
  if (G_STATE.step >= LAST) { closeGuide(); return; }
  G_STATE.step++;
  renderGuide();
  $('guideNext').focus();
}

/** ステップの画面を開き、画面上部に「ガイドに戻る」を出す */
function guideGo() {
  const g = GUIDE[G_STATE.step];
  G_STATE.navigating = true;
  closeGuide();
  if (g.table) S.masterTable = g.table;
  go(g.page);
  if (!g.key) return; // まとめ・はじめには画面を開くだけ（戻る案内は出さない）
  setResume(false);
  showResume(true);
  $('main').focus({ preventScroll: true });
}

function showResume(on) {
  $('guideResume').hidden = !on;
  document.body.classList.toggle('has-resume', on);
}

function setResume(done) {
  const g = GUIDE[G_STATE.step];
  $('guideResume').classList.toggle('is-done', done);
  $('guideResumeText').textContent = done ? `✓ 完了：${g.short}` : `ガイド：${g.short}`;
  $('guideResumeText').title = done ? `「${g.title}」が完了しました` : g.title;
  $('guideResumeBtn').textContent = done ? '次のステップへ' : 'ガイドに戻る';
}

/** 登録・判定・出荷などの後：ガイドの途中なら完了を確認して表示を更新する */
async function guideAfterAction() {
  if (!S.cfg) return;
  try { S.cfg.setup = await api('getSetup'); } catch (e) { return; }
  if ($('guideResume').hidden) return;
  const g = GUIDE[G_STATE.step];
  if (g.key && setupState()[g.key]) setResume(true);
}

/** 「ガイドに戻る」：終わっていれば完了を伝えて次のステップへ */
async function guideResume(btn) {
  await busy(btn, async () => {
    try { S.cfg.setup = await api('getSetup'); } catch (e) { /* 取れなくてもガイドは開く */ }
    const g = GUIDE[G_STATE.step];
    const finished = g.key && setupState()[g.key];
    if (finished) {
      const next = firstTodo(setupState());
      G_STATE.justDone = `「${g.title}」が完了しました。` + (next >= 0 ? `次は「${GUIDE[next].title}」です。` : 'これで準備はすべて完了です。');
      openGuide(next >= 0 ? next : LAST);
    } else {
      openGuide(G_STATE.step);
    }
  });
}

async function saveRulesChecked(chk) {
  chk.disabled = true;
  try {
    S.cfg.prefs = await api('saveUserPrefs', { rulesChecked: chk.checked });
    S.cfg.setup = await api('getSetup');
    if (chk.checked) G_STATE.justDone = '販売可否ルールの確認を記録しました。';
    renderGuide();
  } catch (err) {
    chk.checked = !chk.checked;
    toast(err.message, 'ng');
  } finally {
    chk.disabled = false;
  }
}

/** ダッシュボード「はじめにやること」 */
function setupCard() {
  const st = setupState();
  if (!S.cfg || setupDone(st) || (S.cfg.prefs && S.cfg.prefs.checklistHidden)) return '';
  const done = SETUP_STEPS.filter((x) => st[x.g.key]).length;
  const next = firstTodo(st);
  return `<section class="card setup-card" aria-labelledby="setupTitle"><div class="card-head"><div>
      <h2 class="card-title" id="setupTitle">はじめにやること</h2><p class="card-sub">${done} / ${SETUP_STEPS.length} 完了・上から順に進めると、入荷から出荷までが使えるようになります。</p></div></div>
    <div class="meter" aria-hidden="true"><i data-w="${Math.round((done / SETUP_STEPS.length) * 100)}"></i></div>
    <ol class="setup-list">${SETUP_STEPS.map(({ g, i }, n) => `<li class="${st[g.key] ? 'done' : i === next ? 'next' : ''}">
      <span class="setup-mark" aria-hidden="true">${st[g.key] ? icon('check') : n + 1}</span>
      <div class="grow"><div class="setup-t">${esc(g.title)}</div><div class="setup-s">${st[g.key] ? '完了' : i === next ? '次はここから' : '未完了'}</div></div>
      ${st[g.key] ? '' : `<button type="button" class="btn ${i === next ? 'btn-primary' : 'btn-secondary'} btn-sm" data-action="guideStep" data-step="${i}" aria-label="${esc(g.title)}の手順を見る">手順を見る</button>`}</li>`).join('')}</ol>
    <div class="setup-foot"><button type="button" class="btn btn-secondary btn-sm" data-action="guideStep" data-step="0">ガイドを最初から見る</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="hideSetup">このカードを非表示</button></div></section>`;
}

/** 入荷・出荷の画面：前提（マスタ・合格ロット）が足りないときの案内 */
function renderPrereq() {
  if (!S.M || !S.cfg) return;
  const none = (rows) => !active(rows).length;
  const need = (labels) => labels.filter(Boolean).join('・');
  const box = (text, btns) => `<div class="alert alert-info prereq" role="status"><div class="alert-text">${esc(text)}<div class="alert-actions">${btns}</div></div></div>`;
  const masterBtn = (table, label) => `<button type="button" class="btn btn-secondary btn-sm" data-action="goMaster" data-table="${table}">${esc(label)}を登録する</button>`;
  const rcNeed = need([none(S.M.suppliers) && '仕入先', none(S.M.products) && '商品']);
  $('rcPre').innerHTML = rcNeed ? box(`入荷を登録するには、先に ${rcNeed} を「マスタ設定」で登録してください。`,
    (none(S.M.suppliers) ? masterBtn('m_supplier', '仕入先') : '') + (none(S.M.products) ? masterBtn('m_product', '商品') : '')) : '';
  const shNeed = need([none(S.M.customers) && '顧客', none(S.M.products) && '商品']);
  $('shPre').innerHTML = shNeed ? box(`出荷を登録するには、先に ${shNeed} を「マスタ設定」で登録してください。`,
    (none(S.M.customers) ? masterBtn('m_customer', '顧客') : '') + (none(S.M.products) ? masterBtn('m_product', '商品') : ''))
    : !setupState().released ? box('まだ検品で合格にしたロットがありません。入荷を登録し、「検品・ロット」で合格にすると出荷できます。',
      '<button type="button" class="btn btn-secondary btn-sm" data-action="go" data-page="receipt">入荷登録へ</button><button type="button" class="btn btn-secondary btn-sm" data-action="go" data-page="inspect">検品へ</button>') : '';
}

// ======================================================================
// ダッシュボード
// ======================================================================
async function loadDashboard() {
  const d = await api('getDashboard');
  d.recalls.forEach(recallTotals);
  const kpi = (label, n, page, level) =>
    `<button type="button" class="kpi ${n ? (level ? 'is-' + level : '') : 'is-zero'}" data-action="go" data-page="${page}"><span>${esc(label)}${icon('chev', 'kpi-go')}</span><b>${n}</b></button>`;
  $('dashKpis').innerHTML = kpi('検品待ち', d.quarantine.length, 'inspect', 'warn') + kpi('保留中', d.hold.length, 'inspect', 'warn') +
    kpi('期限90日以内', d.expiringSoon.length, 'inventory', 'warn') + kpi('期限切れ在庫', d.expired.length, 'inventory', 'alert') +
    kpi('発注点以下', d.lowStock.length, 'inventory', 'warn') + kpi('対応中の回収', d.recalls.length, 'recall', 'alert');

  const lotRows = (list) => list.map((l) => ({ attrs: ` class="clickable${ALERT_STATUS.has(l.status) ? ' is-alert' : ''}" data-action="traceLotNo" data-lot="${esc(l.lot_no)}" tabindex="0" aria-label="${esc(l.lot_no)} を追跡"`, cells: [html(mono(l.lot_no)), l.product, l.expires_on,
    days(l.daysLeft), html(badge(l.status, l.statusLabel)), num(l.stock)] }));
  const lotHead = [{ label: 'ロット', cls: 'primary' }, { label: '商品', cls: 'wide' }, { label: '使用期限', cls: 'nowrap' }, { label: '残日数', cls: 'num' },
    { label: '状態', cls: 'status' }, { label: '在庫', cls: 'num' }];
  const recalls = d.recalls.length ? '<ul class="list">' + d.recalls.map((r) => `<li><div class="grow"><span class="eyebrow">${esc(r.recall_no)}</span><div class="t">${esc(r.title)}</div>
      <div class="s">${r.activeTargets ? `対象顧客 ${r.activeTargets}件・連絡済 ${r.contactedRate}%・回収 ${fmt(r.doneQty)} / ${fmt(r.shippedQty)}` : '出荷実績のある顧客なし'}</div>
      <div class="meter"><i data-w="${r.recoveredRate}"></i></div></div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="go" data-page="recall">開く</button></li>`).join('') + '</ul>'
    : empty('対応中の回収案件はありません', 'check');
  const lc = d.lastCheck;
  const mismatch = lc && lc.mismatches && lc.mismatches.length ? `<div class="alert alert-ng span-full" role="alert">在庫数と在庫移動履歴が一致しない在庫が ${lc.mismatches.length} 件あります（日次チェック ${esc(lc.ran_at)}）。\n` +
    lc.mismatches.slice(0, 5).map((m) => `${esc(m.lot_no)}／${esc(m.location)}：在庫 ${fmt(m.on_hand)}・履歴合計 ${fmt(m.movement_total)}`).join('\n') +
    (lc.mismatches.length > 5 ? '\nほか ' + (lc.mismatches.length - 5) + ' 件' : '') + '\n管理者に確認してください。</div>' : '';
  const stale = d.checkStale ? `<div class="alert alert-warn span-full" role="status">日次チェック（期限切れの判定・在庫の照合）が24時間以上実行されていません${lc ? `（最終 ${esc(lc.ran_at)}）` : ''}。\nSupabase の「Integrations」→「Cron」に exo-trace-daily-check があるか、管理者に確認を依頼してください。</div>` : '';
  if (S.cfg) S.cfg.setup = d.setup;
  $('dashSetup').innerHTML = setupCard();
  $('dashKpis').hidden = !setupState().lots; // まだロットが1件も無いときは「0」ばかりの表示を出さない
  $('dashSetup').querySelectorAll('.meter i').forEach((i) => { i.style.width = Math.min(100, Number(i.dataset.w) || 0) + '%'; });
  $('dashBody').innerHTML = mismatch + stale +
    `<div class="card"><h2 class="card-title">対応中の回収案件</h2>${recalls}</div>` +
    `<div class="card"><h2 class="card-title">発注点以下の商品</h2>${table([{ label: '商品', cls: 'primary' }, { label: '引当可能在庫', cls: 'num' }, { label: '発注点', cls: 'num' }],
      d.lowStock.map((x) => ({ cells: [html(esc(x.product)), num(x.available), num(x.reorderPoint)] })), { empty: '発注点を下回る商品はありません', emptyIcon: 'check' })}</div>` +
    `<div class="card span-full"><h2 class="card-title">使用期限90日以内の在庫</h2>${table(lotHead, lotRows(d.expiringSoon), { empty: '該当するロットはありません', emptyIcon: 'check' })}</div>` +
    `<div class="card span-full"><h2 class="card-title">期限切れ在庫</h2><p class="card-sub">廃棄または仕入先返品で処分してください。</p>${table(lotHead, lotRows(d.expired), { empty: '期限切れの在庫はありません', emptyIcon: 'check' })}</div>`;
  $('dashBody').querySelectorAll('.meter i').forEach((i) => { i.style.width = Math.min(100, Number(i.dataset.w) || 0) + '%'; });
}

// ======================================================================
// 入荷
// ======================================================================
function fillReceiptLocations() {
  const p = S.M.products.find((x) => String(x.id) === $('rcProduct').value);
  $('rcProductInfo').innerHTML = p ? joinNw([p.name, '保管 ' + code('storage_class', p.storage_class), '有効期間 ' + p.shelf_life_days + '日']) : '';
  const locs = active(S.M.locations).filter((l) => String(l.is_quarantine) !== 'true' && (!p || l.storage_class === p.storage_class));
  $('rcLoc').innerHTML = options(locs, 'id', (l) => l.name + '（' + l.location_code + '）', locs.length ? '選択してください' : '該当する保管場所がありません');
  if (locs.length === 1) $('rcLoc').value = locs[0].id;
}

function autoExpiry() {
  const p = S.M.products.find((x) => String(x.id) === $('rcProduct').value);
  const mfg = $('rcMfg').value;
  if (p && mfg && !$('rcExp').dataset.manual) {
    const d = new Date(mfg + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + Number(p.shelf_life_days || 0));
    $('rcExp').value = d.toISOString().slice(0, 10);
  }
}

async function submitReceipt(e) {
  e.preventDefault();
  if (!checkRequired($('receiptForm'), 'rcMsg')) return;
  await busy(e.submitter, async () => {
    alertBox('rcMsg', '');
    try {
      const r = await api('registerReceipt', { supplierId: $('rcSupplier').value, productId: $('rcProduct').value, supplierLotNo: $('rcSupLot').value,
        receiptDate: $('rcDate').value, manufacturedOn: $('rcMfg').value, expiresOn: $('rcExp').value, quantity: $('rcQty').value,
        unitPrice: $('rcPrice').value, arrivalTemp: $('rcTemp').value, locationId: $('rcLoc').value });
      alertBox('rcMsg', `入荷を登録しました。\n入荷番号 ${r.receiptNo}／社内ロット番号 ${r.lotNo}（検品待ち）` + (r.warning ? '\n⚠ ' + r.warning : ''), r.warning ? 'warn' : 'ok');
      toast('入荷を登録しました（' + r.lotNo + '）');
      ['rcSupLot', 'rcMfg', 'rcExp', 'rcQty', 'rcPrice', 'rcTemp'].forEach((id) => { $(id).value = ''; });
      delete $('rcExp').dataset.manual;
      guideAfterAction();
    } catch (err) {
      alertBox('rcMsg', err.message, 'ng');
    }
  });
}

// ======================================================================
// 検品・ロット
// ======================================================================
const NEXT = { QUARANTINE: ['RELEASED', 'HOLD', 'REJECTED'], RELEASED: ['HOLD'], HOLD: ['RELEASED', 'QUARANTINE', 'REJECTED'] };

async function loadInspect() {
  const f = S.inspectFilter;
  document.querySelectorAll('#insFilter button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.filter === f)));
  scrollFade($('insFilter'));
  syncTabs($('insFilter'));
  // 読み込み中は古いカードを操作できないようにする（入力途中の内容が置き換わらないように）
  $('insBody').classList.add('is-loading');
  $('insBody').setAttribute('aria-busy', 'true');
  let lots;
  try { lots = await api('getLots', f ? f.split(',') : []); } finally { $('insBody').classList.remove('is-loading'); $('insBody').removeAttribute('aria-busy'); }
  if (S.inspectFilter !== f) return; // 読み込み中に別の絞り込みに切り替えられた
  $('insBody').innerHTML = lots.length ? lots.map((l) => {
    const nexts = NEXT[l.status] || [];
    const action = nexts.length ? `<div class="lot-action">
        <div class="field"><label for="to_${l.id}">判定</label><select id="to_${l.id}" class="insTo" data-id="${l.id}"><option value="">選択してください</option>${nexts.map((s) => `<option value="${s}">${esc(code('lot_status', s))}</option>`).join('')}</select></div>
        <div class="field"><label for="rs_${l.id}">理由 <span class="opt" id="rso_${l.id}">合格時は任意</span></label><input id="rs_${l.id}" class="insReason" data-id="${l.id}" autocomplete="off"></div>
        <label class="check" id="coaw_${l.id}" hidden><input type="checkbox" id="coa_${l.id}" class="insCoa" data-id="${l.id}"><span>COA（試験成績書）を確認した</span></label>
        <div class="field-hint" id="insHint_${l.id}">判定を選択してください。</div>
        <button type="button" class="btn btn-primary" data-action="changeStatus" data-id="${l.id}" id="insBtn_${l.id}" disabled aria-describedby="insHint_${l.id}">判定を登録</button></div>` : '';
    return `<article class="card lot-card"><div class="lot-head"><div><div class="lot-no">${esc(l.lot_no)}</div>
        <div class="card-sub">${joinNw([l.product, l.supplier])}</div></div>${badge(l.status, l.statusLabel)}</div>
      <dl class="lot-meta"><div><dt>仕入先ロット</dt><dd class="mono">${esc(l.supplier_lot_no)}</dd></div><div><dt>使用期限</dt><dd>${esc(l.expires_on)}</dd></div>
        <div><dt>在庫</dt><dd>${fmt(l.stock)}</dd></div><div><dt>初回入荷</dt><dd>${esc(l.received_on)}</dd></div></dl>
      ${l.status_reason ? `<p class="note">理由：${esc(l.status_reason)}</p>` : ''}${action}</article>`;
  }).join('') : `<div class="card">${empty(f === 'QUARANTINE,HOLD' ? '検品待ち・保留中のロットはありません' : '対象のロットはありません', 'check')}
      <div class="empty-actions"><button type="button" class="btn btn-secondary btn-sm" data-action="go" data-page="receipt">入荷を登録する</button>
      <button type="button" class="btn btn-secondary btn-sm" data-action="go" data-page="shipment">出荷登録へ</button></div></div>`;
}

const ACTION_LABEL = { RELEASED: '合格にする', HOLD: '保留にする', REJECTED: '不合格にする', QUARANTINE: '検品待ちに戻す' };
/** 判定・理由・COA の入力に応じて実行ボタンの文言と可否を切り替える */
function updateInspectAction(id) {
  const to = $('to_' + id).value;
  const reason = $('rs_' + id).value.trim();
  const coa = $('coa_' + id).checked;
  $('coaw_' + id).hidden = to !== 'RELEASED';
  $('rso_' + id).textContent = to === 'RELEASED' ? '任意' : '必須';
  const btn = $('insBtn_' + id);
  const ready = to && (to === 'RELEASED' ? coa : !!reason);
  btn.disabled = !ready;
  btn.className = 'btn ' + (to === 'REJECTED' ? 'btn-danger' : 'btn-primary');
  btn.textContent = to ? ACTION_LABEL[to] : '判定を登録';
  $('insHint_' + id).textContent = !to ? '判定を選択してください。' : ready ? '' : (to === 'RELEASED' ? 'COA（試験成績書）を確認したら、チェックを入れてください。' : '理由を入力してください。');
}

async function changeStatus(btn) {
  const id = btn.dataset.id;
  const to = $('to_' + id).value;
  if (to === 'REJECTED' || to === 'HOLD') {
    const card = btn.closest('.lot-card');
    const lotNo = card ? card.querySelector('.lot-no').textContent : '';
    const ok = await ask(to === 'REJECTED'
      ? { title: `ロット ${lotNo} を不合格にしますか？`, body: '不合格にすると元に戻せません。このロットの在庫は出荷できなくなります。', okText: '不合格にする', danger: true }
      : { title: `ロット ${lotNo} を保留にしますか？`, body: '保留中は出荷できません。確認が済んだら「合格」に戻せます。', okText: '保留にする' });
    if (!ok) return;
  }
  await busy(btn, async () => {
    alertBox('insMsg', '');
    try {
      const r = await api('changeLotStatus', { lotId: id, to: $('to_' + id).value, reason: $('rs_' + id).value, coaConfirmed: $('coa_' + id).checked });
      toast(`ロット ${r.lot_no} を「${r.statusLabel}」にしました`);
      guideAfterAction();
      await loadInspect();
    } catch (err) {
      alertBox('insMsg', err.message, 'ng');
      $('insMsg').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

// ======================================================================
// 出荷
// ======================================================================
let lineSeq = 0;
function addLine() {
  const n = ++lineSeq;
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<div class="field field-product"><label for="slp${n}">商品</label><select class="slProd" id="slp${n}">${options(active(S.M ? S.M.products : []), 'id', (r) => r.product_code + '　' + r.name, '商品を選択')}</select></div>
    <div class="field"><label for="slq${n}">数量</label><input class="slQty" id="slq${n}" type="number" inputmode="numeric" min="1" step="1" aria-describedby="sla${n}"><div class="line-avail" id="sla${n}" aria-live="polite"></div></div>
    <div class="field"><label for="slr${n}">単価（円・税抜）</label><input class="slPrice" id="slr${n}" type="number" inputmode="decimal" min="0" step="0.01"></div>
    <button type="button" class="btn btn-ghost btn-sm line-remove" data-action="removeLine" aria-label="この明細を削除">${icon('x')}削除</button>`;
  $('shLines').appendChild(div);
}

async function submitShipment(e) {
  e.preventDefault();
  const lineEls = [...$('shLines').querySelectorAll('.line')];
  const lines = lineEls.map((l) => ({ productId: l.querySelector('.slProd').value,
    quantity: l.querySelector('.slQty').value, unitPrice: l.querySelector('.slPrice').value }));
  // 明細：商品を選んだ行は数量必須。1行も無ければ最初の行の商品を未入力扱い
  const extra = [];
  lineEls.filter((l) => l.querySelector('.slProd').value).forEach((l) => {
    if (!l.querySelector('.slQty').value.trim()) extra.push(l.querySelector('.slQty'));
    if (!l.querySelector('.slPrice').value.trim()) extra.push(l.querySelector('.slPrice'));
  });
  if (!lines.some((l) => l.productId) && lineEls[0]) extra.unshift(lineEls[0].querySelector('.slProd'));
  if (!checkRequired($('shipForm'), 'shMsg', extra)) return;
  // 引当可能数を超える明細（同じ商品の合計で判定）
  const want = {};
  lines.filter((l) => l.productId).forEach((l) => { want[l.productId] = (want[l.productId] || 0) + Number(l.quantity); });
  const shortP = Object.keys(want).find((pid) => { const n = availFor(pid); return n !== null && S.inventory.length && want[pid] > n; });
  if (shortP) {
    const el = lineEls.find((l) => l.querySelector('.slProd').value === shortP).querySelector('.slQty');
    el.setAttribute('aria-invalid', 'true');
    alertBox('shMsg', `「${(S.M.products.find((p) => String(p.id) === shortP) || {}).name}」の数量が引当可能数（${fmt(availFor(shortP))}）を超えています。`, 'ng', true);
    el.focus();
    return;
  }
  const cust = S.M.customers.find((c) => String(c.id) === $('shCustomer').value);
  const filled = lines.filter((l) => l.productId);
  const prodName = (id) => (S.M.products.find((p) => String(p.id) === String(id)) || {}).name || '';
  const total = filled.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0);
  const detail = filled.map((l) => `・${prodName(l.productId)}　${fmt(l.quantity)} × ${fmt(l.unitPrice)}円`).join('\n');
  const zero = filled.some((l) => Number(l.unitPrice) === 0) ? '\n\n⚠ 単価 0円 の明細があります。' : '';
  if (cust && filled.length && !(await ask({ title: '出荷を確定しますか？', body: `${cust.name} へ出荷します（出荷日 ${$('shDate').value}）。\n${detail}\n合計 ${fmt(total)}円（税抜）${zero}\n\n確定すると在庫が引き落とされます。`, okText: '出荷を確定' }))) return;
  await busy(e.submitter, async () => {
    alertBox('shMsg', '');
    try {
      const s = await api('createShipment', { customerId: $('shCustomer').value, shippedOn: $('shDate').value, note: $('shNote').value, lines });
      $('shMsg').innerHTML = `<div class="alert alert-ok" role="status">出荷を確定しました。出荷番号 ${esc(s.shipment_no)}（${esc(s.customer)}）</div>` +
        table([{ label: '商品', cls: 'primary' }, 'ロット', { label: '使用期限', cls: 'nowrap' }, { label: '数量', cls: 'num' }, { label: '単価', cls: 'num' }],
          s.lines.map((l) => ({ cells: [html(esc(l.product)), html(mono(l.lot_no)), l.expires_on, num(l.quantity), num(l.unit_price)] })));
      $('shMsg').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      guideAfterAction();
      $('shLines').innerHTML = '';
      addLine();
      $('shNote').value = '';
      await loadShipmentPage();
    } catch (err) {
      alertBox('shMsg', err.message, 'ng');
    }
  });
}

/** 出荷画面：明細ごとの引当可能数を出せるよう在庫を読む */
async function loadShipmentPage() {
  await Promise.all([loadRecentShipments(), loadInventory().catch(() => {})]);
  document.querySelectorAll('#shLines .line').forEach(updateLineAvail);
}

/** 明細の「引当可能 N」表示（当日時点の目安。最終判定はサーバー） */
function availFor(productId) {
  const p = S.M && S.M.products.find((x) => String(x.id) === String(productId));
  if (!p) return null;
  return S.inventory.filter((r) => r.allocatable && r.product_code === p.product_code).reduce((a, r) => a + r.qty, 0);
}
function updateLineAvail(line) {
  const pid = line.querySelector('.slProd').value;
  const out = line.querySelector('.line-avail');
  const n = pid ? availFor(pid) : null;
  const qty = Number(line.querySelector('.slQty').value || 0);
  out.textContent = n === null ? '' : `引当可能 ${fmt(n)}`;
  out.classList.toggle('short', n !== null && qty > n);
}

async function loadRecentShipments() {
  const list = await api('getRecentShipments', 30);
  $('shRecent').innerHTML = table([{ label: '出荷番号', cls: 'primary' }, { label: '出荷日', cls: 'nowrap' }, { label: '顧客', cls: 'wide' }, { label: '明細', cls: 'wide' },
    { label: '金額（円）', cls: 'num' }, { label: '状態', cls: 'status' }, { label: '', cls: 'actions' }],
    list.map((s) => ({ cells: [html(mono(s.shipment_no)), s.shipped_on, s.customer,
      html(s.lines.map((l) => `<div class="li"><span>${esc(l.product)}</span><span class="li-sub"><span class="mono">${esc(l.lot_no)}</span> × ${l.quantity}${l.returned ? `（返品 ${l.returned}）` : ''}</span></div>`).join('')),
      num(s.amount), html(s.status === 'SHIPPED' ? badge('ok', '出荷済') : badge('ng', '取消')),
      s.status === 'SHIPPED' ? html(`<button type="button" class="btn btn-danger-text btn-sm" data-action="cancelShip" data-id="${s.id}" data-no="${esc(s.shipment_no)}">出荷を取消</button>`) : ''] })),
    { empty: 'まだ出荷はありません', emptyIcon: 'truck' });
}

async function cancelShip(btn) {
  const reason = await ask({ title: `出荷 ${btn.dataset.no} を取消しますか？`, body: '在庫に戻ります。返品が登録されている出荷は取消できません。', input: '取消理由', okText: '取消する', danger: true });
  if (!reason) return;
  await busy(btn, async () => {
    try {
      await api('cancelShipment', btn.dataset.id, reason);
      toast('出荷 ' + btn.dataset.no + ' を取消しました');
      await loadShipmentPage();
    } catch (err) { toast(err.message, 'ng'); }
  });
}

// ======================================================================
// 返品
// ======================================================================
async function findShipmentForReturn(e, keepMsg) {
  if (e) e.preventDefault();
  if (!keepMsg) alertBox('rtFindMsg', '');
  alertBox('rtMsg', '');
  if (!$('rtShipNo').value.trim()) {
    $('rtShipNo').setAttribute('aria-invalid', 'true');
    alertBox('rtFindMsg', '出荷番号を入力するか、下の「最近の出荷」から選んでください。', 'ng');
    $('rtShipNo').focus();
    return;
  }
  $('rtForm').hidden = true;
  S.returnLine = null;
  const btn = e && e.submitter;
  await busy(btn, async () => {
    try {
      const s = await api('getShipmentByNo', $('rtShipNo').value);
      $('rtShipment').innerHTML = `<p class="card-sub"><b class="mono">${esc(s.shipment_no)}</b>・${joinNw([s.shipped_on, s.customer])} ${s.status !== 'SHIPPED' ? badge('ng', '取消済') : ''}</p>` +
        table([{ label: '商品', cls: 'primary' }, { label: 'ロット', cls: 'wide' }, { label: 'ロット状態', cls: 'status' }, { label: '出荷数', cls: 'num' }, { label: '返品済', cls: 'num' }, { label: '返品可能', cls: 'num' }, { label: '', cls: 'actions' }],
          s.lines.map((l) => ({ attrs: rowAlert(l.lot_status_code), cells: [html(esc(l.product)), html(mono(l.lot_no)), html(badge(l.lot_status_code, l.lot_status)), num(l.quantity), num(l.returned), num(l.returnable),
            l.returnable > 0 ? html(`<button type="button" class="btn btn-secondary btn-sm" data-action="selectReturnLine" data-id="${l.id}" data-max="${l.returnable}" data-label="${esc(l.product + '／' + l.lot_no)}" data-recall="${l.in_open_recall ? 1 : ''}" data-storage="${esc(l.storage_class)}">この明細を返品</button>`) : ''] })));
      $('rtRecent').innerHTML = '';
    } catch (err) {
      $('rtShipment').innerHTML = '';
      alertBox('rtFindMsg', err.message, 'ng');
    }
  });
}

/** ロット追跡：最近入荷したロットをすぐ選べるようにする */
async function loadTraceRecent() {
  if ($('tlBody').querySelector('.lot-card')) return;
  const lots = (await api('getLots', [])).sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)) || b.id - a.id).slice(0, 8);
  if ($('tlQuery').value.trim()) return; // 読み込み中に検索された
  $('tlRecent').innerHTML = lots.length ? `<h3 class="section-title">最近のロット</h3><div class="recent-chips">${lots.map((l) =>
    `<button type="button" class="btn btn-secondary btn-sm" data-action="traceLotNo" data-lot="${esc(l.lot_no)}">${esc(l.lot_no)}</button>`).join('')}</div>` : '';
}

/** 返品画面：最近の出荷から選べるようにする */
async function loadReturnRecent() {
  // 表示中の出荷があれば最新の状態で出し直す（回収などでロットの状態が変わっている場合があるため）
  if ($('rtShipment').innerHTML && $('rtShipNo').value.trim()) { alertBox('rtFindMsg', ''); await findShipmentForReturn(null, false); return; }
  const list = (await api('getRecentShipments', 10)).filter((s) => s.status === 'SHIPPED');
  $('rtRecent').innerHTML = `<h3 class="section-title">最近の出荷</h3>` + table([{ label: '出荷番号', cls: 'primary' }, { label: '出荷日', cls: 'nowrap' }, { label: '顧客', cls: 'wide' }, { label: '', cls: 'actions' }],
    list.map((s) => ({ cells: [html(mono(s.shipment_no) + `<div class="card-sub">${esc(s.lines.map((l) => l.product + " ×" + l.quantity).join("、"))}</div>`), s.shipped_on, s.customer,
      html(`<button type="button" class="btn btn-secondary btn-sm" data-action="pickReturnShipment" data-no="${esc(s.shipment_no)}">この出荷を選ぶ</button>`)] })),
    { empty: '返品できる出荷はありません', emptyIcon: 'truck' });
}

function selectReturnLine(btn) {
  S.returnLine = btn.dataset.id;
  document.querySelectorAll('#rtShipment tr.is-selected').forEach((tr) => tr.classList.remove('is-selected'));
  document.querySelectorAll('#rtShipment [data-action="selectReturnLine"]').forEach((b) => { b.textContent = 'この明細を返品'; b.disabled = false; });
  btn.closest('tr').classList.add('is-selected');
  btn.textContent = '選択中';
  btn.disabled = true;
  $('rtForm').hidden = false;
  $('rtLineInfo').innerHTML = joinNw(btn.dataset.label.split('／').concat(['返品可能 ' + btn.dataset.max]));
  $('rtQty').max = btn.dataset.max;
  $('rtQty').value = '';
  $('rtQtyHint').textContent = `最大 ${btn.dataset.max}`;
  $('rtDate').value = S.cfg.today;
  // 商品と同じ温度区分の保管場所だけを選べるようにする（1か所だけなら自動で選ぶ）
  const locs = active(S.M.locations).filter((l) => l.storage_class === btn.dataset.storage);
  const fill = (id, list) => {
    $(id).innerHTML = options(list, 'id', (l) => l.name, list.length ? '選択してください' : '該当する保管場所がありません');
    if (list.length === 1) $(id).value = list[0].id;
  };
  fill('rtQLoc', locs.filter((l) => String(l.is_quarantine) === 'true'));
  fill('rtRLoc', locs.filter((l) => String(l.is_quarantine) !== 'true'));
  const recall = btn.dataset.recall === '1';
  $('rtDisp').value = recall ? 'DISPOSE' : '';
  $('rtDisp').disabled = recall;
  $('rtRLocWrap').hidden = true;
  if (recall) $('rtLineInfo').innerHTML += '・' + nw('回収中のため回収品として登録（処置は廃棄）');
  $('rtForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('rtQty').focus({ preventScroll: true }), 300);
}

async function submitReturn(e) {
  e.preventDefault();
  if (!checkRequired($('rtForm'), 'rtMsg')) return;
  await busy(e.submitter, async () => {
    alertBox('rtMsg', '');
    try {
      const r = await api('registerReturn', { shipmentLineId: S.returnLine, quantity: $('rtQty').value, returnedOn: $('rtDate').value, reason: $('rtReason').value,
        quarantineLocationId: $('rtQLoc').value, disposition: $('rtDisp').value, restockLocationId: $('rtRLoc').value });
      alertBox('rtFindMsg', `返品を登録しました。返品番号 ${r.returnNo}／処置：${r.disposition === 'RESTOCK' ? '在庫に戻す' : '廃棄'}${r.recall ? '（回収品として計上）' : ''}`);
      $('rtReason').value = '';
      await findShipmentForReturn(null, true);
      $('rtFindMsg').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      alertBox('rtMsg', err.message, 'ng');
    }
  });
}

// ======================================================================
// 在庫
// ======================================================================
async function loadInventory() {
  S.inventory = (await api('getInventory')).sort((a, b) => (a.daysLeft ?? 99999) - (b.daysLeft ?? 99999));
  renderInventory();
}

function renderInventory() {
  const q = $('invFilter').value.trim().toUpperCase();
  const avail = $('invAvail').checked;
  const rows = S.inventory.filter((r) => (!avail || r.allocatable) &&
    (!q || [r.product, r.product_code, r.lot_no, r.supplier_lot_no].some((v) => String(v || '').toUpperCase().includes(q))));
  $('invBody').innerHTML = table([{ label: 'ロット', cls: 'primary' }, { label: '商品', cls: 'wide' }, '仕入先ロット', { label: '保管場所', cls: 'wide' }, { label: '使用期限', cls: 'nowrap' },
    { label: '残日数', cls: 'num' }, { label: '状態', cls: 'status' }, { label: '数量', cls: 'num' }],
    rows.map((r) => ({ attrs: ` class="clickable${ALERT_STATUS.has(r.status) ? ' is-alert' : ''}" data-action="traceLotNo" data-lot="${esc(r.lot_no)}" tabindex="0" aria-label="${esc(r.lot_no)} を追跡"`,
      cells: [html(mono(r.lot_no)), r.product, html(mono(r.supplier_lot_no)),
      html(esc(r.location) + (r.quarantine ? ' ' + badge('warn', '隔離') : '')), r.expires_on, days(r.daysLeft),
      html(badge(r.status, r.statusLabel) + ' ' + (r.allocatable ? badge('ok', '出荷できる') : badge('', '出荷不可' + (r.reason && r.reason !== r.statusLabel ? '（' + r.reason + '）' : '')))), num(r.qty)] })),
    { empty: S.inventory.length ? '条件に一致する在庫はありません' : '在庫はありません' });
}

// ======================================================================
// ロット追跡
// ======================================================================
const MOVE_LABEL = { RECEIPT: '入荷', SHIPMENT: '出荷', CANCEL: '出荷取消', RETURN: '返品受入', TRANSFER_IN: '移動入', TRANSFER_OUT: '移動出', DISPOSE: '廃棄', ADJUST: '調整', SUPPLIER_RETURN: '仕入先返品' };

async function searchLot(e) {
  e.preventDefault();
  if (!$('tlQuery').value.trim()) {
    $('tlQuery').setAttribute('aria-invalid', 'true');
    $('tlBody').innerHTML = '<div class="alert alert-ng" role="alert">ロット番号を入力するか、下の「最近のロット」から選んでください。</div>';
    $('tlQuery').focus();
    return;
  }
  $('tlRecent').innerHTML = '';
  await busy(e.submitter, async () => {
    try {
      const lots = await api('traceLot', $('tlQuery').value);
      const fold = lots.length > 1; // 複数見つかったときは、見出しだけを並べて開いて見る
      $('tlBody').innerHTML = (lots.length ? `<p class="result-count" role="status">${lots.length}件見つかりました${lots.length >= 20 ? '（先頭20件。番号をもう少し詳しく入れると絞り込めます）' : ''}</p>` : '') + (lots.length ? lots.map((l) => {
        const net = l.shipments.reduce((s, x) => s + x.net, 0);
        const customers = new Set(l.shipments.filter((s) => s.net > 0).map((s) => s.customer_code)).size;
        const head = `<div class="lot-head"><div><div class="lot-no">${esc(l.lot_no)}</div>
            <div class="card-sub">${joinNw([l.product, l.supplier, '仕入先ロット ' + l.supplier_lot_no])}</div>
            ${fold ? `<div class="fold-hint">${icon('chev')}<span class="lbl-open">詳しく見る（販売先 ${customers}件・手元 ${fmt(net)}）</span><span class="lbl-close">閉じる</span></div>` : ''}</div>${badge(l.status, l.statusLabel)}</div>`;
        return `<article class="card lot-card">${fold ? `<details class="lot-fold"><summary>${head}</summary>` : head}
          <div class="stat-row"><div class="stat hl"><b>${fmt(net)}</b><span>顧客の手元</span></div><div class="stat"><b>${customers}</b><span>保有顧客数</span></div>
            <div class="stat"><b>${fmt(l.stock)}</b><span>現在庫</span></div><div class="stat"><b>${esc(l.daysLeft)}</b><span>期限まで（日）</span></div></div>
          <dl class="lot-meta"><div><dt>製造日</dt><dd>${esc(l.manufactured_on || '—')}</dd></div><div><dt>使用期限</dt><dd>${esc(l.expires_on)}</dd></div>
            <div><dt>初回入荷</dt><dd>${esc(l.received_on)}</dd></div><div><dt>原価単価</dt><dd>${fmt(l.unit_cost)} 円</dd></div></dl>
          <div class="chips">${Object.keys(l.movementTotals).filter((k) => !k.startsWith('TRANSFER_')).map((k) => `<span class="chip">${esc(MOVE_LABEL[k] || k)} ${fmt(l.movementTotals[k])}</span>`).join('')}</div>
          <h3 class="section-title">販売先</h3>
          ${table([{ label: '顧客', cls: 'primary' }, { label: '連絡先', cls: 'wide' }, '出荷番号', { label: '出荷日', cls: 'nowrap' }, { label: '状態', cls: 'status' },
            { label: '出荷', cls: 'num' }, { label: '返品', cls: 'num' }, { label: '回収', cls: 'num' }, { label: '手元', cls: 'num' }],
            l.shipments.map((s) => ({ cells: [html(`${esc(s.customer)}<div class="card-sub">${esc(s.customer_code)}</div>`),
              html([telLink(s.phone), mailLink(s.email)].filter(Boolean).map((v) => `<span class="contact">${v}</span>`).join('')), html(mono(s.shipment_no)), s.shipped_on,
              html(s.status === 'SHIPPED' ? badge('ok', '出荷済') : badge('ng', '取消')), num(s.quantity), num(s.returned), num(s.recalled), num(s.net)] })),
            { empty: '出荷実績はありません', emptyIcon: 'truck' })}
          <h3 class="section-title">保管場所別在庫</h3>
          ${l.inventory.length ? `<div class="chips">${l.inventory.map((i) => `<span class="chip">${esc(i.location)}：${fmt(i.qty)}</span>`).join('')}</div>` : '<p class="note">在庫はありません</p>'}
          <h3 class="section-title">ステータス履歴</h3>
          <ul class="timeline">${l.history.map((h) => `<li><b>${esc(code('lot_status', h.from_status) || '登録')} → ${esc(code('lot_status', h.to_status))}</b>　${esc(h.reason)}
            <div class="s">${esc(h.changed_at)}・${esc(h.changed_by)}</div></li>`).join('')}</ul>${fold ? '</details>' : ''}</article>`;
      }).join('') : `<div class="card">${empty('該当するロットはありません', 'search')}</div>`);
    } catch (err) {
      $('tlBody').innerHTML = `<div class="alert alert-ng" role="alert">${esc(err.message)}</div>`;
    }
  });
}

// ======================================================================
// 顧客追跡
// ======================================================================
async function searchCustomer(e) {
  e.preventDefault();
  await busy(e.submitter, async () => {
    try {
      const r = await api('traceCustomer', $('tcCustomer').value, $('tcFrom').value, $('tcTo').value);
      const c = r.customer;
      const total = r.rows.reduce((s, x) => s + x.net, 0);
      $('tcBody').innerHTML = `<div class="card"><div class="card-head"><div><h2 class="card-title">${esc(c.name)}</h2>
          <p class="card-sub">${joinNw([c.customer_code, code('customer_type', c.customer_type), c.address, c.phone, c.email])}</p></div>
          <span class="badge b-CONTACTED">手元 ${fmt(total)}</span></div>
        ${table([{ label: 'ロット', cls: 'primary' }, { label: '商品', cls: 'wide' }, { label: '出荷日', cls: 'nowrap' }, '出荷番号', { label: '使用期限', cls: 'nowrap' },
          { label: 'ロット状態', cls: 'status' }, { label: '出荷', cls: 'num' }, { label: '返品', cls: 'num' }, { label: '手元', cls: 'num' }],
          r.rows.map((x) => ({ attrs: rowAlert(x.lot_status), cells: [html(mono(x.lot_no)), x.product, x.shipped_on, html(mono(x.shipment_no)),
            x.expires_on, html(badge(x.lot_status, x.lot_status_label)), num(x.quantity), num(x.returned), num(x.net)] })),
          { empty: '出荷実績はありません', emptyIcon: 'truck' })}</div>`;
    } catch (err) {
      $('tcBody').innerHTML = `<div class="alert alert-ng" role="alert">${esc(err.message)}</div>`;
    }
  });
}

// ======================================================================
// 回収
// ======================================================================
const RECALL_STATUS = { OPEN: '登録', IN_PROGRESS: '対応中', CLOSED: '完了' };

async function loadRecalls() {
  const [lots, recalls] = await Promise.all([api('getLots', ['QUARANTINE', 'RELEASED', 'HOLD', 'REJECTED', 'EXPIRED']), api('listRecalls')]);
  $('rcLots').innerHTML = lots.length ? lots.map((l) => `<label class="check"><input type="checkbox" value="${l.id}"><span><b class="mono">${esc(l.lot_no)}</b>
      <small>${joinNw([l.product, l.statusLabel, '期限 ' + l.expires_on])}</small></span></label>`).join('') : '<p class="note">対象にできるロットがありません。</p>';
  $('rclList').innerHTML = recalls.length ? recalls.map(renderRecall).join('') : `<div class="card">${empty('回収案件はありません', 'check')}</div>`;
  $('rclList').querySelectorAll('.meter i').forEach((i) => { i.style.width = Math.min(100, Number(i.dataset.w) || 0) + '%'; });
}

function recallTotals(r) {
  const act = r.targets.filter((t) => Number(t.shipped_qty) > 0);
  r.activeTargets = act.length;
  r.shippedQty = act.reduce((a, t) => a + Number(t.shipped_qty), 0);
  r.doneQty = act.reduce((a, t) => a + Math.min(Number(t.shipped_qty), Number(t.recovered_qty) + Number(t.unrecoverable_qty)), 0);
  r.openTargets = r.targets.filter((t) => t.status !== 'RECOVERED' && t.status !== 'CLOSED').length;
  r.uncontacted = r.targets.filter((t) => t.status === 'NOT_CONTACTED').length;
  return r;
}

function renderRecall(r) {
  recallTotals(r);
  const ed = r.status !== 'CLOSED';
  const targets = r.targets.length ? r.targets.map((t) => {
    const editable = ed && t.status !== 'RECOVERED' && t.status !== 'CLOSED';
    const open = t.status === 'NOT_CONTACTED';
    const form = ed ? `<details class="target-edit"${open ? ' open' : ''}><summary>進捗を更新</summary><div class="target-grid">
        <div class="field f-date"><label for="cd_${t.id}">連絡日</label><input type="date" id="cd_${t.id}" value="${esc(t.contacted_on)}"></div>
        <div class="field"><label for="cm_${t.id}">連絡方法</label><select id="cm_${t.id}">${['', '電話', 'メール', '訪問'].map((m) => `<option value="${m}"${m === t.contact_method ? ' selected' : ''}>${m || '未選択'}</option>`).join('')}</select></div>
        <div class="field"><label for="un_${t.id}">回収不能数</label><input type="number" inputmode="numeric" min="0" id="un_${t.id}" value="${esc(t.unrecoverable_qty)}"></div>
        ${editable ? `<div class="field f-status"><label for="st_${t.id}">状態</label><select id="st_${t.id}"><option value="">変更しない</option><option value="CONTACTED">連絡済にする</option><option value="CLOSED">クローズする</option></select></div>` : ''}
        <div class="field span-reason"><label for="cr_${t.id}">クローズ理由 <span class="opt">クローズ時必須</span></label><input id="cr_${t.id}" value="${esc(t.close_reason)}" autocomplete="off" maxlength="500"></div>
        <button type="button" class="btn btn-secondary span-save" data-action="saveTarget" data-id="${t.id}">保存</button>
      </div></details>` : (t.close_reason ? `<p class="note">クローズ理由：${esc(t.close_reason)}</p>` : '');
    return `<div class="target"><div class="target-head"><div><div class="t">${esc(t.customer)}</div>
        <div class="s">${[t.contact_name ? nw(t.contact_name) : '', telLink(t.phone), mailLink(t.email)].filter(Boolean).join('・') || '連絡先未登録'}</div></div>${badge(t.status, t.statusLabel)}</div>
      <div class="target-nums"><span class="nowrap">ロット <b class="mono">${esc(t.lot_no)}</b></span><span>手元 <b>${fmt(t.shipped_qty)}</b></span><span>回収 <b>${fmt(t.recovered_qty)}</b></span>${ed ? '' : `<span>回収不能 <b>${fmt(t.unrecoverable_qty)}</b></span>`}</div>
      ${form}</div>`;
  }).join('') : empty('対象顧客はいません（出荷実績なし）', 'check');
  const rate = (v) => (r.activeTargets ? v + '%' : '—');
  return `<article class="card"><div class="card-head"><div><span class="eyebrow">${esc(r.recall_no)}</span><h2 class="card-title">${esc(r.title)}</h2>
      <p class="card-sub">${joinNw(['クラス' + r.severity, '開始 ' + r.started_on, r.closed_on ? '完了 ' + r.closed_on : '', '対象ロット ' + r.lots.join(', ')])}</p></div>
      ${badge(r.status, RECALL_STATUS[r.status] || r.status)}</div>
    <p class="note">${esc(r.reason)}</p>
    <div class="stat-row three"><div class="stat"><b>${rate(r.contactedRate)}</b><span>連絡済率</span></div><div class="stat${r.activeTargets && r.recoveredRate >= 100 ? ' hl' : ''}"><b>${rate(r.recoveredRate)}</b><span>回収率</span></div>
      <div class="stat"><b>${fmt(r.remainingStock)}</b><span>残在庫</span></div></div>
    ${r.activeTargets ? `<div class="meter-row"><div class="meter"><i data-w="${r.recoveredRate}"></i></div><span>回収 ${fmt(r.doneQty)} / ${fmt(r.shippedQty)}</span></div>` : ''}
    <h3 class="section-title">対象顧客</h3>${targets}
    ${ed ? `<p class="note">回収品の受入は「返品登録」で行うと回収数に自動で反映されます。</p>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-action="reextract" data-id="${r.id}">${icon('refresh')}対象を再抽出</button>
      <button type="button" class="btn ${r.openTargets ? 'btn-secondary' : 'btn-primary'}" data-action="closeRecall" data-id="${r.id}" data-open="${r.openTargets}" data-left="${r.shippedQty - r.doneQty}" data-uncontacted="${r.uncontacted}">回収を完了</button></div>` : ''}</article>`;
}

async function submitRecall(e) {
  e.preventDefault();
  const lotIds = [...$('rcLots').querySelectorAll('input:checked')].map((i) => i.value);
  alertBox('rclFormMsg', '');
  if (!checkRequired($('recallForm'), 'rclFormMsg')) return;
  if (!lotIds.length) { alertBox('rclFormMsg', '対象ロットを1件以上選択してください。', 'ng'); return; }
  if (!(await ask({ title: '回収を開始しますか？', body: `選択した ${lotIds.length} ロットを回収対象にし、出荷を停止します。`, okText: '回収を開始', danger: true }))) return;
  await busy(e.submitter, async () => {
    try {
      const r = await api('createRecall', { title: $('rcTitle').value, reason: $('rcReason').value, severity: $('rcSev').value, lotIds });
      toast(`回収案件 ${r.recall_no} を登録しました（対象顧客 ${r.targets.filter((t) => Number(t.shipped_qty) > 0).length} 件）`);
      $('recallForm').reset();
      $('rcNew').open = false;
      await loadRecalls();
    } catch (err) {
      alertBox('rclFormMsg', err.message, 'ng');
    }
  });
}

async function saveTarget(btn) {
  const id = btn.dataset.id;
  const st = $('st_' + id);
  await busy(btn, async () => {
    try {
      await api('updateRecallTarget', { targetId: id, contactedOn: $('cd_' + id).value, contactMethod: $('cm_' + id).value,
        unrecoverableQty: $('un_' + id).value, status: st ? st.value : '', closeReason: $('cr_' + id).value });
      toast('保存しました');
      await loadRecalls();
    } catch (err) { toast(err.message, 'ng'); }
  });
}

async function reextract(btn) {
  await busy(btn, async () => {
    try { await api('reextractRecall', btn.dataset.id); toast('対象顧客を再抽出しました'); await loadRecalls(); } catch (err) { toast(err.message, 'ng'); }
  });
}

async function closeRecall(btn) {
  const open = Number(btn.dataset.open || 0);
  const body = open ? `未完了の対象顧客が ${open} 件（未回収 ${btn.dataset.left}・未連絡 ${btn.dataset.uncontacted} 件）残っているため、まだ完了できません。\n\n各顧客について、回収品を「返品登録」で受け入れる（自動で「回収済」になります）か、回収できない場合は「進捗を更新」で回収不能数を入れるかクローズしてください。`
    : '完了後は対象顧客の進捗を変更できません。';
  if (open) { await ask({ title: '回収はまだ完了できません', body, okText: 'わかりました', noCancel: true }); return; }
  if (!(await ask({ title: '回収を完了しますか？', body, okText: '完了にする' }))) return;
  await busy(btn, async () => {
    try {
      const r = await api('closeRecall', btn.dataset.id);
      toast('回収案件を完了しました' + (r.warning ? '（' + r.warning + '）' : ''), r.warning ? 'ng' : '');
      await loadRecalls();
    } catch (err) { toast(err.message, 'ng'); }
  });
}

// ======================================================================
// マスタ
// ======================================================================
const MASTER = {
  m_product: { key: 'products', label: '商品', fields: [['product_code', '商品コード'], ['name', '商品名'], ['storage_class', '保管温度区分', 'code:storage_class'],
    ['shelf_life_days', '有効期間（日）', 'number'], ['min_remaining_days', '最低出荷残期間（日）', 'number'], ['regulatory_class', '規制区分', 'code:regulatory_class'],
    ['list_price', '標準売価（円・税抜）', 'number'], ['reorder_point', '発注点', 'number'], ['is_active', '有効', 'bool']] },
  m_customer: { key: 'customers', label: '顧客', fields: [['customer_code', '顧客コード'], ['name', '顧客名'], ['customer_type', '顧客区分', 'code:customer_type'],
    ['medical_inst_code', '医療機関コード'], ['address', '住所'], ['contact_name', '担当者名'], ['phone', '電話番号', 'tel'], ['email', 'メール（回収連絡先）', 'email'], ['is_active', '有効', 'bool']] },
  m_supplier: { key: 'suppliers', label: '仕入先', fields: [['supplier_code', '仕入先コード'], ['name', '仕入先名'], ['contact_name', '担当者名'], ['phone', '電話番号', 'tel'],
    ['email', 'メール', 'email'], ['is_active', '有効', 'bool']] },
  m_location: { key: 'locations', label: '保管場所', fields: [['location_code', '保管場所コード'], ['name', '保管場所名'], ['storage_class', '保管温度区分', 'code:storage_class'],
    ['temp_min', '許容温度下限（℃）', 'number'], ['temp_max', '許容温度上限（℃）', 'number'], ['is_quarantine', '隔離保管場所（返品・保留用）', 'bool'], ['is_active', '有効', 'bool']] },
};
/** 顧客区分が「医療機関」なら医療機関コードを必須にする（ラベルの「任意」も切り替える） */
function syncMedicalCode() {
  const type = $('mf_customer_type'), codeEl = $('mf_medical_inst_code');
  if (!type || !codeEl) return;
  const req = type.value === 'MEDICAL';
  codeEl.required = req;
  const opt = document.querySelector('label[for="mf_medical_inst_code"] .opt');
  if (opt) opt.textContent = req ? '必須' : '任意';
  if (!req) codeEl.removeAttribute('aria-invalid');
}

/** サーバーのエラー文言から、原因の入力欄を特定して印を付ける */
const MASTER_ERR_FIELD = [[/医療機関コード/, 'medical_inst_code'], [/住所/, 'address'], [/許容温度/, 'temp_min'], [/有効期間/, 'shelf_life_days'],
  [/最低出荷残期間/, 'min_remaining_days'], [/標準売価/, 'list_price'], [/発注点/, 'reorder_point'], [/保管温度区分/, 'storage_class'],
  [/規制区分/, 'regulatory_class'], [/顧客区分/, 'customer_type'], [/コード/, '_code']];
function markMasterError(message) {
  const hit = MASTER_ERR_FIELD.find(([re]) => re.test(message));
  if (!hit) return;
  const el = hit[1] === '_code' ? $('masterFields').querySelector('input[id$="_code"]:not(#mf_medical_inst_code)') : $('mf_' + hit[1]);
  if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
}

/** マスタの必須項目（コード以外）と入力のヒント */
const MASTER_REQUIRED = ['name', 'storage_class', 'shelf_life_days', 'regulatory_class', 'customer_type', 'address', 'temp_min', 'temp_max'];
const MASTER_HINTS = { supplier_code: '英数字とハイフン（例：S001）', product_code: '英数字とハイフン（例：EXO-UC50）', customer_code: '英数字とハイフン（例：C001）',
  location_code: '英数字とハイフン（例：L-M80-02）', shelf_life_days: '製造日からの日数。入荷時に使用期限を自動計算します',
  min_remaining_days: '使用期限まで、この日数以上残っているロットだけを出荷します（未入力なら90日）', regulatory_class: '販売できる顧客区分は「販売可否ルール」で決まります',
  medical_inst_code: '顧客区分が「医療機関」の場合は必須', 'm_customer.email': '回収が必要になったときの連絡先になります' };
const LIST_COLS = { m_product: ['product_code', 'name', 'storage_class', 'regulatory_class', 'list_price', 'is_active'],
  m_customer: ['customer_code', 'name', 'customer_type', 'contact_name', 'email', 'is_active'],
  m_supplier: ['supplier_code', 'name', 'contact_name', 'phone', 'is_active'],
  m_location: ['location_code', 'name', 'storage_class', 'temp_min', 'temp_max', 'is_quarantine', 'is_active'] };

async function loadMaster() {
  const t = S.masterTable;
  document.querySelectorAll('#msTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.table === t)));
  scrollFade($('msTabs'));
  syncTabs($('msTabs'));
  $('msNew').hidden = t === 'rules';
  if (t === 'rules') { renderRules(); return; }
  const def = MASTER[t];
  const cols = LIST_COLS[t].map((k) => def.fields.find((f) => f[0] === k));
  const listLabel = { is_active: '状態', is_quarantine: '用途' };
  $('msList').innerHTML = table(cols.map(([k, label, type], i) => ({ label: listLabel[k] || label, cls: i === 0 ? 'primary' : k === 'name' ? 'wide' : type === 'number' ? 'num' : '' })),
    S.M[def.key].map((r) => ({ attrs: ` class="clickable" data-action="editMaster" data-id="${esc(r.id)}" tabindex="0"`,
      cells: cols.map(([k, , type], i) => {
        if (type === 'bool') return html(k === 'is_quarantine' ? (String(r[k]) === 'true' ? badge('warn', '隔離（返品・保留）') : badge('', '通常')) : String(r[k]) === 'true' ? badge('ok', '有効') : badge('', '無効'));
        const v = type && type.startsWith('code:') ? code(type.slice(5), r[k]) : r[k];
        return i === 0 ? html(mono(v)) : type === 'number' ? num(v === '' || v === undefined ? '' : Number(v)) : v;
      }) })),
    { empty: def.label + 'が登録されていません。「新規登録」から登録してください。', emptyIcon: 'gear' });
}

function renderRules() {
  const rc = S.cfg.codes.regulatory_class, ct = S.cfg.codes.customer_type;
  const allowed = (r, c) => { const rule = S.M.salesRules.find((x) => x.regulatory_class === r && x.customer_type === c); return !!rule && String(rule.allowed) === 'true'; };
  const cards = '<div class="rules-cards">' + Object.keys(rc).map((r) => `<section class="rules-card"><h3>${esc(rc[r])}</h3><p class="rules-card-sub">販売できる顧客区分にチェック</p>` +
    Object.keys(ct).map((c) => `<label class="check"><span>${esc(ct[c])}</span><input type="checkbox" class="ruleChk" data-rc="${r}" data-ct="${c}"${allowed(r, c) ? ' checked' : ''}></label>`).join('') +
    '</section>').join('') + '</div>';
  const rulesOk = setupState().rules;
  const confirm = `<div class="rules-confirm">${rulesOk ? `<span class="guide-state done">${icon('check')}販売可否ルールは確認済みです</span>`
      : `<button type="button" class="btn btn-primary" data-action="confirmRules">販売可否ルールを確認した</button>`}</div>`;
  $('msList').innerHTML = `<div><p class="note rules-note">チェックありの組合せのみ出荷できます。チェックを変えると即時に保存されます。初期値は仮設定のため、法的区分の確認後に必ず見直してください。</p>
    ${cards}<div class="table-wrap rules-matrix"><table class="matrix"><thead><tr><th scope="col">規制区分＼顧客区分</th>${Object.keys(ct).map((c) => `<th scope="col">${esc(ct[c])}</th>`).join('')}</tr></thead><tbody>` +
    Object.keys(rc).map((r) => `<tr><th scope="row">${esc(rc[r])}</th>` + Object.keys(ct).map((c) => {
      const rule = S.M.salesRules.find((x) => x.regulatory_class === r && x.customer_type === c);
      return `<td><label><input type="checkbox" class="ruleChk" data-rc="${r}" data-ct="${c}" aria-label="${esc(rc[r])} を ${esc(ct[c])} に販売可"${rule && String(rule.allowed) === 'true' ? ' checked' : ''}></label></td>`;
    }).join('') + '</tr>').join('') + '</tbody></table></div>' + confirm + '</div>';
}

function editMaster(id) {
  const t = S.masterTable, def = MASTER[t];
  const r = id ? S.M[def.key].find((x) => String(x.id) === String(id)) : { is_active: true, min_remaining_days: 90 };
  $('masterTitle').textContent = def.label + (id ? 'の編集' : 'の新規登録');
  $('masterForm').dataset.id = id || '';
  alertBox('masterMsg', '');
  const isCode = (k) => k.endsWith('_code') && k !== 'medical_inst_code';
  $('masterFields').innerHTML = def.fields.map(([k, label, type]) => {
    const v = r[k] === undefined || r[k] === null ? '' : r[k];
    if (type === 'bool') return `<label class="check"><input type="checkbox" id="mf_${k}"${String(v) === 'true' ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    const req = isCode(k) || MASTER_REQUIRED.includes(k);
    const lab = `<label for="mf_${k}">${esc(label)}${req ? '' : ' <span class="opt">任意</span>'}</label>`;
    const hintText = MASTER_HINTS[t + '.' + k] || MASTER_HINTS[k];
    const hint = hintText ? `<div class="field-hint" id="mfh_${k}">${esc(hintText)}</div>` : '';
    const common = `id="mf_${k}"${req ? ' required' : ''}${hint ? ` aria-describedby="mfh_${k}"` : ''}`;
    if (type && type.startsWith('code:')) {
      const codes = S.cfg.codes[type.slice(5)];
      return `<div class="field">${lab}<select ${common}><option value="">選択してください</option>${Object.keys(codes).map((c) => `<option value="${c}"${c === v ? ' selected' : ''}>${esc(codes[c])}</option>`).join('')}</select>${hint}</div>`;
    }
    const attrs = type === 'number' ? ' type="number" inputmode="decimal" step="any"' : type === 'email' ? ' type="email" inputmode="email"' : type === 'tel' ? ' type="tel" inputmode="tel"' : '';
    return `<div class="field">${lab}<input ${common}${attrs}${isCode(k) ? ' autocapitalize="characters"' : ''} value="${esc(v)}" autocomplete="off">${hint}</div>`;
  }).join('');
  syncMedicalCode();
  $('masterDialog').showModal();
  const first = $('masterFields').querySelector('input, select');
  if (first) first.focus();
}

async function saveMasterForm(e) {
  if (!e.submitter || e.submitter.value !== 'save') return; // キャンセル・閉じるはそのまま閉じる
  e.preventDefault();
  const t = S.masterTable, data = { id: $('masterForm').dataset.id || null };
  if (!checkRequired($('masterFields'), 'masterMsg')) return;
  MASTER[t].fields.forEach(([k, , type]) => { data[k] = type === 'bool' ? $('mf_' + k).checked : $('mf_' + k).value; });
  await busy(e.submitter, async () => {
    try {
      await api('saveMaster', t, data);
      $('masterDialog').close();
      toast(MASTER[t].label + 'を保存しました');
      guideAfterAction();
      await reloadMasters();
      await loadMaster();
    } catch (err) {
      alertBox('masterMsg', err.message, 'ng');
      markMasterError(err.message);
    }
  });
}

async function saveRule(chk, isUndo) {
  const { rc, ct } = chk.dataset;
  const value = chk.checked;
  document.querySelectorAll(`.ruleChk[data-rc="${rc}"][data-ct="${ct}"]`).forEach((c) => { c.checked = value; c.disabled = true; });
  try {
    await api('saveSalesRule', rc, ct, value);
    S.M = await api('getMasters');
    const label = `${code('regulatory_class', rc)} → ${code('customer_type', ct)}：${value ? '販売可' : '販売不可'}`;
    toast((isUndo ? '元に戻しました：' : '保存しました：') + label, '', isUndo ? null : { label: '取り消す', run: () => {
      const c = document.querySelector(`.ruleChk[data-rc="${rc}"][data-ct="${ct}"]`);
      if (c) { c.checked = !value; saveRule(c, true); }
    } });
  } catch (err) {
    document.querySelectorAll(`.ruleChk[data-rc="${rc}"][data-ct="${ct}"]`).forEach((c) => { c.checked = !value; });
    toast(err.message, 'ng');
  } finally {
    document.querySelectorAll(`.ruleChk[data-rc="${rc}"][data-ct="${ct}"]`).forEach((c) => { c.disabled = false; });
  }
}

// ======================================================================
// イベント
// ======================================================================
const ACTIONS = {
  go: (el) => go(el.dataset.page),
  openSheet, closeSheet,
  logout: () => logout(''),
  retry,
  guideOpen: () => openGuide(),
  guideStep: (el) => openGuide(Number(el.dataset.step)),
  guideNext,
  togglePw: (el) => {
    const show = $('loginPassword').type === 'password';
    $('loginPassword').type = show ? 'text' : 'password';
    el.textContent = show ? '隠す' : '表示';
    el.setAttribute('aria-pressed', String(show));
  },
  goMaster: (el) => { S.masterTable = el.dataset.table; go('master'); },
  pickReturnShipment: (el) => { $('rtShipNo').value = el.dataset.no; $('rtShipNo').removeAttribute('aria-invalid'); findShipmentForReturn(null, false); },
  traceLotNo: (el) => { go('traceLot'); $('tlQuery').value = el.dataset.lot; $('tlQuery').removeAttribute('aria-invalid'); $('tlSearch').requestSubmit(); },
  confirmRules: async (el) => busy(el, async () => {
    try {
      S.cfg.prefs = await api('saveUserPrefs', { rulesChecked: true });
      toast('販売可否ルールの確認を記録しました');
      await guideAfterAction();
      renderRules();
    } catch (err) { toast(err.message, 'ng'); }
  }),
  guidePrev: () => { if (G_STATE.step > 0) { G_STATE.step--; renderGuide(); (G_STATE.step === 0 ? $('guideNext') : $('guidePrev')).focus(); } },
  guideClose: closeGuide,
  guideGo,
  guideResume,
  guideResumeClose: () => { showResume(false); $('main').focus({ preventScroll: true }); },
  hideSetup: async (el) => busy(el, async () => {
    try {
      S.cfg.prefs = await api('saveUserPrefs', { checklistHidden: true });
      $('main').focus({ preventScroll: true });
      toast('「はじめにやること」を非表示にしました（右上の「?」からガイドを開けます）');
      await loadDashboard();
    } catch (err) { toast(err.message, 'ng'); }
  }),
  reload: async (el) => busy(el, async () => {
    try { await reloadMasters(); showPage(S.page); toast('最新の情報に更新しました'); } catch (err) { toast(err.message, 'ng'); }
  }),
  addLine, removeLine: (el) => { el.closest('.line').remove(); if (!$('shLines').children.length) addLine(); },
  changeStatus, cancelShip, selectReturnLine, cancelReturn: () => { $('rtForm').hidden = true; },
  saveTarget, reextract, closeRecall,
  newMaster: () => editMaster(null),
  editMaster: (el) => editMaster(el.dataset.id),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  // タブ（絞り込み・マスタの種類）：← → で移動して選ぶ
  const tab = e.target.closest && e.target.closest('[role="tab"]');
  if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    e.preventDefault();
    next.focus();
    next.click();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-action]')) { e.preventDefault(); ACTIONS[e.target.dataset.action](e.target); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.getAttribute && t.getAttribute('aria-invalid') === 'true' && String(t.value || '').trim()) t.removeAttribute('aria-invalid');
  if (t.id === 'guideRulesChk') { saveRulesChecked(t); return; }
  if (t.id === 'mf_customer_type') syncMedicalCode();
  if (t.classList.contains('slProd')) {
    const p = S.M.products.find((x) => String(x.id) === t.value);
    t.closest('.line').querySelector('.slPrice').value = p ? p.list_price : '';
    updateLineAvail(t.closest('.line'));
  } else if (t.classList.contains('ruleChk')) {
    saveRule(t);
  } else if (t.id === 'rcProduct') {
    fillReceiptLocations(); autoExpiry();
  } else if (t.id === 'rcMfg') {
    autoExpiry();
  } else if (t.classList.contains('insTo') || t.classList.contains('insCoa')) {
    updateInspectAction(t.dataset.id);
  } else if (t.id === 'rtDisp') {
    $('rtRLocWrap').hidden = t.value !== 'RESTOCK';
  } else if (t.id === 'invAvail') {
    renderInventory();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true' && String(e.target.value || '').trim()) e.target.removeAttribute('aria-invalid');
  if (e.target.id === 'rcExp') e.target.dataset.manual = '1';
  if (e.target.id === 'invFilter') renderInventory();
  if (e.target.classList.contains('slQty')) updateLineAvail(e.target.closest('.line'));
  if (e.target.classList.contains('insReason')) updateInspectAction(e.target.dataset.id);
});

document.addEventListener('DOMContentLoaded', async () => {
  $('loginForm').addEventListener('submit', login);
  $('receiptForm').addEventListener('submit', submitReceipt);
  $('shipForm').addEventListener('submit', submitShipment);
  $('rtSearch').addEventListener('submit', (e) => findShipmentForReturn(e, false));
  $('rtForm').addEventListener('submit', submitReturn);
  $('tlSearch').addEventListener('submit', searchLot);
  $('tcSearch').addEventListener('submit', searchCustomer);
  $('recallForm').addEventListener('submit', submitRecall);
  $('masterForm').addEventListener('submit', saveMasterForm);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  // ガイドは閉じ方（はじめる・あとで見る・Esc）にかかわらず「見た」と記録する
  $('guideDialog').addEventListener('close', onGuideClosed);
  $('guideDialog').addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (G_STATE.step < LAST) { G_STATE.step++; renderGuide(); } }
    if (e.key === 'ArrowLeft') { e.preventDefault(); ACTIONS.guidePrev(); }
  });
  $('insFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (b) { S.inspectFilter = b.dataset.filter; loadInspect().catch((err) => toast(err.message, 'ng')); }
  });
  $('msTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-table]');
    if (b) { S.masterTable = b.dataset.table; loadMaster().catch((err) => toast(err.message, 'ng')); }
  });
  window.addEventListener('hashchange', () => { if (S.sess && !$('app').hidden) route(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshToday(); });
  window.addEventListener('focus', refreshToday);
  window.addEventListener('online', () => { if (!$('retryBtn').hidden) retry($('retryBtn')); });
  // 別のタブでのログアウト・トークン更新を反映する
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY) return;
    const saved = storage(true);
    if (!S.sess) return;
    if (!saved || !saved.refresh_token) endLocal('別の画面でログアウトしたため、この画面もログアウトしました。');
    else if (saved.user !== S.sess.user) endLocal('別の画面で別のアカウント（' + saved.user + '）がログインしたため、この画面はログアウトしました。');
    else S.sess = saved;
  });

  try { localStorage.removeItem('exo-trace-session'); } catch (e) { /* 旧版（Apps Script 連携）のログイン情報 */ }
  const saved = storage(true);
  if (saved && saved.refresh_token) { S.sess = saved; S.user = saved.user || ''; }
  try {
    await loadConfig();
  } catch (err) {
    showLogin(err.message, true);
    return;
  }
  if (saved && saved.refresh_token) {
    S.sess = saved;
    S.user = saved.user || '';
    boot();
  } else {
    if (saved && saved.user) S.user = saved.user;
    showLogin('');
  }
});
