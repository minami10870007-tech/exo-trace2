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

const S = { pageHash: {}, rtNo: '', sb: null, sess: null, user: '', cfg: null, M: null, page: '', inspectFilter: 'QUARANTINE,HOLD', masterTable: 'm_product',
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
// 電話をかけるリンク。内線は番号に含めない（つなげると別の番号にかかる）
const telLink = (v) => (v ? `<a href="tel:${esc(String(v).split(/\s*[（(]?\s*(?:内線|ext\.?|#)/i)[0].replace(/[^0-9+]/g, ''))}">${esc(v)}</a>` : '');
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
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000); // 電波が弱く応答が返らないときは30秒で打ち切る
  try {
    res = await fetch(S.sb.url + path, {
      method: 'POST', signal: ctl.signal,
      // 公開用キーは apikey ヘッダーで送る（新形式の publishable キーは JWT ではないため Authorization には入れない）
      headers: Object.assign({ apikey: S.sb.key, 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(MSG_OFFLINE);
  } finally { clearTimeout(timer); }
  let data = {};
  try { const text = await res.text(); data = text ? JSON.parse(text) : {}; } catch (e) { data = { __unreadable: true }; } // 応答が途中で切れた
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
    if (S.sess) logout(MSG_EXPIRED_KEEP, true);
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

// 登録系の処理と、その入力フォーム。応答が届かずにもう一度確定しても二重に登録されないよう、
// フォームの内容を変えるまでは同じ依頼番号（requestId）を送る（サーバーは同じ番号なら前回の結果を返す）
const WRITE_FORM = { createShipment: 'shipForm', registerReceipt: 'receiptForm', registerReturn: 'rtForm', disposeStock: 'disposeForm', createRecall: 'recallForm',
  saveMaster: 'masterForm', updateRecallTarget: (p) => 'tg_' + p.targetId, changeLotStatus: (p) => 'lot_' + p.lotId,
  cancelShipment: (p) => 'cs_' + p.shipmentId, closeRecall: (p) => 'cr_' + p.recallId };
const MSG_UNSURE = '通信が途切れたため、登録できたか確認できませんでした。入力内容はそのままで、もう一度同じ操作をしてください（二重に登録されることはありません。登録済みなら、その結果を表示します）。';
/** 確認できないまま閉じようとしている入力ダイアログか（「保存されません」とは言えない） */
const unsureDialog = (id) => (id === 'masterDialog' && !!S.unsure.masterForm) || (id === 'disposeDialog' && !!S.unsure.disposeForm);
function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
S.req = {};
S.unsure = {}; // 登録できたか分からないまま終わったフォーム（再送は画面側のチェックを省いてサーバーに任せる）
S.changed = {}; // その間に内容を変えたフォーム
S.checked = {}; // 「登録されていない」と確かめ済み（画面に戻るたびに同じ案内を繰り返さない）
/** フォームの内容が変わったら、次の確定は新しい依頼として送る */
function resetRequest(formId) { delete S.req[formId]; delete S.unsure[formId]; delete S.changed[formId]; delete S.checked[formId]; }
/** 入力した欄が属するフォーム・回収対象・検品カードの依頼番号を捨てる */
function resetScopeOf(el) {
  if (!el || !el.closest) return;
  // 前回の確定が登録されたか分からない間は、内容を変えても同じ依頼として送る（前回が登録済みなら、二重に登録せずそれを知らせる）
  const reset = (sc) => { if (S.unsure[sc]) S.changed[sc] = true; else resetRequest(sc); };
  const fm = el.closest('form'); if (fm && fm.id) reset(fm.id);
  const tg = el.closest('.target'); if (tg && tg.id) reset(tg.id);
  if (el.dataset && el.dataset.id && /^(to|rs|coa)_/.test(el.id)) reset('lot_' + el.dataset.id);
}
/** 前回の確定が「登録できたか分からない」まま、内容を変えずに再送しようとしているか */
const resending = (formId) => !!(S.unsure[formId] && S.req[formId]);

/** 登録内容を整える：前後の空白を除き、空の明細を外す（サーバーが無視する違いで「内容が変わった」とならないように） */
function normPayload(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(normPayload).filter((x) => !(x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((y) => y === '' || y === null || y === undefined)));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normPayload(x)]));
  return v;
}

async function api(fn, ...args) {
  let p = RPC_ARGS[fn] ? Object.fromEntries(RPC_ARGS[fn].map((k, i) => [k, args[i] === undefined ? null : args[i]])) : (args[0] || {});
  const form = typeof WRITE_FORM[fn] === 'function' ? WRITE_FORM[fn](p) : WRITE_FORM[fn];
  if (form) p = normPayload(p);
  if (form) p.requestId = S.req[form] || (S.req[form] = newId());
  const online = navigator.onLine;
  let sent = false;
  const path = '/rest/v1/rpc/' + fn.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  progress(1);
  try {
    await ensureSession();
    const tok = S.sess.access_token;
    sent = true;
    let { res, data } = await sbFetch(path, { p }, tok);
    if (res.status === 401) {
      await ensureSession(tok);
      ({ res, data } = await sbFetch(path, { p }, S.sess.access_token));
    }
    if (res.status === 401) { logout(MSG_EXPIRED_KEEP, true); throw new Error(MSG_EXPIRED); }
    // 利用者登録が無い・停止された（データベース関数 exo.require_user のエラー）→ ログアウト
    if (res.status === 403 && /利用権限|ログインしてください/.test(data.message || '')) { logout(data.message); throw new Error(data.message); }
    if (res.status === 403) throw new Error('この操作を行う権限がありません。管理者に連絡してください。');
    if (!res.ok) throw rpcError(res, data);
    if (form && data && data.__unreadable) throw new Error(MSG_OFFLINE); // 応答の途中で切れた：登録できたか分からない
    if (form && data && data._replayed && data._same === false) { // サーバーが内容を比べて「前回と違う」と答えた
      // 前回送った内容が登録済みだった。いま画面にある（変更後の）内容は登録していないので、成功扱いにせず、そのまま残して知らせる
      resetRequest(form); // 次の確定は、いまの内容の新しい依頼として送る
      const no = data.shipment_no || data.receiptNo || data.returnNo || data.recall_no || data.lot_no || data.lotNo || '';
      // 何が登録されたかも示す（もう一度送る必要があるかを判断できるように）
      const what = Array.isArray(data.lines) ? '：' + data.lines.map((l) => `${l.product} × ${l.quantity}`).join('、') : data.lotNo ? `：ロット ${data.lotNo}` : '';
      const advice = /^lot_/.test(form) ? '判定を変える場合は、もう一度選んで登録してください。'
        : '追加で登録する場合だけ、もう一度同じ操作をしてください（前回の内容を直したい場合は、登録済みのほうを取消・処分してください）。';
      throw Object.assign(new Error(`前回送った内容（${no}${what}）は登録済みでした。いま入力中の内容は、まだ登録されていません。\n${advice}`), { replayedOther: true, result: data });
    }
    if (form) resetRequest(form); // 登録できた：次は新しい依頼
    return data;
  } catch (err) {
    // 登録の依頼を送ったあとで通信が切れた：登録されたかどうか分からないので、そう伝える（同じ依頼番号で再送すれば安全）
    if (form && online && sent && err.message === MSG_OFFLINE) {
      S.unsure[form] = true;
      throw Object.assign(new Error(MSG_UNSURE), { unsure: true });
    }
    throw err;
  } finally {
    progress(-1);
  }
}

/** 画面に出す文言から内部の規則番号（BR-10 など）を除く */
const userText = (t) => String(t || '').replace(/（BR-\d+）/g, '');

/** 要素にフォーカスを移す（キーボード・読み上げの利用者が操作の結果を見失わないように） */
function focusTo(el) {
  if (!el) return;
  if (!el.matches('a[href], button, input, select, textarea, [tabindex]')) el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

/** 結果・エラーの表示。actions: 次の操作のボタン（HTML）。noScroll: 位置とフォーカスを動かさない */
function alertBox(id, text, kind, noScroll, actions) {
  delete $(id).dataset.gone; // 別の内容で上書きしたら「選択を外しました」の印も外す
  // 伝票番号・ロット番号（例 RT-202610-0001）は途中で折り返さない
  const body = esc(userText(text || '')).replace(/[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,4}/g, (m) => `<span class="nowrap">${m}</span>`);
  $(id).innerHTML = text ? `<div class="alert alert-${kind || 'ok'}" role="${kind === 'ng' ? 'alert' : 'status'}"><div class="alert-text">${body}${actions ? `<div class="alert-actions">${actions}</div>` : ''}</div></div>` : '';
  // 結果・エラーは見える位置まで移動し、フォーカスも移す（固定ボタンの下に隠れない・見失わないように）
  if (text && !noScroll) {
    $(id).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    focusTo($(id).firstElementChild);
  }
}
const goBtn = (page, label) => `<button type="button" class="btn btn-secondary btn-sm" data-action="go" data-page="${page}">${esc(label)}</button>`;

/** 入力を直した欄の印（赤枠・「入力してください」）を消す */
function clearInvalid(el) {
  el.removeAttribute('aria-invalid');
  const f = el.closest('.field');
  const e = f && f.querySelector('.req-err');
  if (e) e.remove();
  // フォーム内の印がすべて消えたら、まとめのエラー表示も消す
  const form = el.closest('form');
  const msg = form && form.querySelector('[id$="Msg"]');
  if (msg && msg.querySelector('.alert-ng')) {
    const left = [...form.querySelectorAll('[aria-invalid="true"]')];
    if (!left.length) msg.innerHTML = '';
    else if (/^未入力の項目があります/.test(msg.textContent)) { // まだ残っている欄だけで一覧を作り直す
      const req = left.filter((x) => x.required && !String(x.value || '').trim());
      if (req.length) msg.querySelector('.alert-text').textContent = '未入力の項目があります：' + [...new Set(req.map(labelOf))].join('、');
      else msg.innerHTML = '';
    }
  }
}

/** プログラムで値を入れた欄も、入力済みなら印を消す（イベントが起きないため） */
function setValue(el, v) {
  el.value = v;
  if (el.getAttribute('aria-invalid') === 'true' && String(el.value || '').trim()) clearInvalid(el);
}
/** フォーム内の印（赤枠・欄の下のメッセージ）をすべて消す */
function clearMarks(form) {
  form.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
  form.querySelectorAll('.req-err').forEach((x) => x.remove());
}

/** 欄の下にエラーを出す（スマホで下の固定ボタンに隠れがちな、フォーム末尾のメッセージの代わりにも見えるように） */
function fieldErr(el, msg) {
  el.setAttribute('aria-invalid', 'true');
  const f = el.closest('.field'); if (!f) return;
  const old = f.querySelector('.req-err'); if (old) old.remove();
  f.insertAdjacentHTML('beforeend', `<div class="field-err req-err">${esc(msg)}</div>`);
}

/** 選べる保管場所が無いとき、欄の下に登録先への案内を出す */
function locHint(id, text) {
  const f = $(id).closest('.field'); let h = f.querySelector('.loc-hint');
  if (!text) { if (h) h.remove(); return; }
  if (!h) { h = document.createElement('div'); h.className = 'loc-hint'; f.appendChild(h); }
  h.innerHTML = `<div class="alert alert-info"><div class="alert-text">${esc(text)}<div class="alert-actions"><button type="button" class="btn btn-secondary btn-sm" data-action="goMaster" data-table="m_location">保管場所を登録する</button></div></div></div>`;
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
    if (String(el.value || '').trim()) { el.removeAttribute('aria-invalid'); const r = el.closest('.field') && el.closest('.field').querySelector('.req-err'); if (r) r.remove(); } else missing.push(el);
  });
  (extra || []).forEach((el) => { if (!missing.includes(el)) missing.push(el); });
  // 数字の欄に数字以外が入っている（見た目は入力済みなので「未入力」とは言わない）
  const bad = [...container.querySelectorAll('input')].filter((el) => el.validity && el.validity.badInput && !el.closest('[hidden]') && !el.disabled);
  if (bad.length) {
    bad.forEach((el) => {
      el.setAttribute('aria-invalid', 'true');
      const field = el.closest('.field'), old = field && field.querySelector('.req-err');
      if (old) old.remove();
      if (field) field.insertAdjacentHTML('beforeend', '<div class="field-err req-err">数字で入力してください</div>');
    });
    alertBox(msgId, '数字で入力してください：' + [...new Set(bad.map(labelOf))].join('、'), 'ng', true);
    bad[0].focus();
    return false;
  }
  if (!missing.length) return true;
  missing.forEach((el) => {
    el.setAttribute('aria-invalid', 'true');
    // 欄の下にも「入力してください」を出す（長いフォームで、まとめのメッセージが画面外でも分かるように）
    const field = el.closest('.field');
    if (field && !field.querySelector('.req-err')) field.insertAdjacentHTML('beforeend', `<div class="field-err req-err">${el.tagName === 'SELECT' ? '選択してください' : '入力してください'}</div>`);
  });
  alertBox(msgId, '未入力の項目があります：' + [...new Set(missing.map(labelOf))].join('、'), 'ng', true);
  missing[0].focus(); // フォーカスした欄が見える位置へ（上下の固定表示は scroll-padding で避ける）
  return false;
}

/** スマホでガイドの帯が見えているときは、お知らせをその下に出す（帯が2行になっても「ガイドに戻る」を隠さない） */
function placeToasts() {
  const banner = $('guideResume');
  const r = !banner.hidden && window.matchMedia('(max-width: 767.98px)').matches ? banner.getBoundingClientRect() : null;
  $('toasts').style.top = r && r.bottom > 0 ? Math.round(r.bottom + 8) + 'px' : '';
}
function toast(text, kind, action) {
  placeToasts();
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'ng' ? ' toast-ng' : kind === 'warn' ? ' toast-warn' : '');
  if (kind === 'ng') el.setAttribute('role', 'alert'); // エラーはすぐに読み上げる（フォーカス移動で読み上げが途切れないように）
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
  setTimeout(() => el.remove(), action || kind === 'warn' ? 7000 : kind === 'ng' ? 6000 : 3500); // 注意は読み切れるよう長めに
}

/** ボタンを処理中表示にして二重送信を防ぐ */
async function busy(btn, fn) {
  if (btn && btn.dataset.busy === '1') return undefined;
  if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
  try { return await fn(); } finally {
    if (btn) {
      btn.dataset.busy = ''; btn.disabled = btn.dataset.locked === '1';
      // 押したボタンを無効にした間にフォーカスが外れたままなら、ボタンに戻す（エラーで終わったときも続けて操作できるように）
      if (btn.isConnected && !btn.disabled && (!document.activeElement || document.activeElement === document.body)) btn.focus({ preventScroll: true });
    }
  }
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
    $('dialogInput').value = o.value || '';
    $('dialogInput').removeAttribute('aria-invalid');
    $('dialogInputErr').textContent = '';
    const ok = $('dialogOk');
    ok.textContent = o.okText || 'OK';
    $('dialogForm').querySelector('[data-action="dialogCancel"]').hidden = !!o.noCancel;
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
    // 取り消せない操作では、誤って Enter で実行しないよう「キャンセル」に初期フォーカス
    (o.input ? $('dialogInput') : o.danger && !o.noCancel ? $('dialogForm').querySelector('[data-action="dialogCancel"]') : ok).focus();
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
  if ($('disposeDialog').open) $('disposeDialog').close();
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

/** expired=true：有効期限切れ。入力中の内容と開いていた画面はそのまま残し、同じ人が再ログインしたら続きから使えるようにする */
function logout(message, expired) {
  const sess = S.sess;
  S.pendingDialog = expired ? captureDialog() : null;
  S.sess = null;
  storage(false, S.user ? { user: S.user } : null); // 次回ログイン用にメールアドレスだけ残す
  // サーバー側のセッションも無効化（失敗しても画面はログアウトする）
  if (sess && S.sb) sbFetch('/auth/v1/logout?scope=local', undefined, sess.access_token).catch(() => {});
  if (!expired) clearScreens();
  showLogin(typeof message === 'string' ? message : '');
}
const MSG_EXPIRED_KEEP = 'ログインの有効期限が切れました。直前の操作は保存されていません。\nもう一度ログインすると、入力中の内容のまま元の画面に戻ります。';

/** まだ保存していない入力があるか（ページを離れる・ログアウトする前の確認用） */
function hasUnsavedInput() { return unsavedScreens().length > 0; }

/** 保存していない入力がある画面の名前 */
function unsavedScreens() {
  const list = [];
  if (['rcSupLot', 'rcQty', 'rcPrice', 'rcMfg'].some((id) => $(id).value.trim()) || ($('rcExp').value && $('rcExp').dataset.manual)) list.push('入荷登録');
  if ($('shNote').value.trim() || [...document.querySelectorAll('#shLines .slQty')].some((el) => el.value.trim())) list.push('出荷登録');
  if (!$('rtForm').hidden && ($('rtQty').value || $('rtReason').value.trim())) list.push('返品登録');
  if ($('rcTitle').value.trim() || $('rcReason').value.trim() || snapshotTargetForms().some((t) => t.fields.length)) list.push('回収管理');
  if (snapshotInspect().length) list.push('受入検品');
  if ($('masterDialog').open && $('masterForm').dataset.dirty === '1') list.push('マスタ編集');
  if ($('disposeDialog').open && $('disposeForm').dataset.dirty === '1') list.push('在庫の処分');
  return list;
}

/** 開いている入力ダイアログ（マスタ編集・処分）の内容を控える（ログイン期限切れのあと続きから使えるように） */
function captureDialog() {
  if ($('masterDialog').open) {
    return { type: 'master', table: S.masterTable, id: $('masterForm').dataset.id, dirty: $('masterForm').dataset.dirty, ver: $('masterForm').dataset.ver,
      values: [...$('masterFields').querySelectorAll('input, select')].map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value]) };
  }
  if ($('disposeDialog').open) {
    const f = $('disposeForm');
    return { type: 'dispose', data: { ...f.dataset }, info: $('disposeInfo').textContent, max: $('dpQty').max, all: $('dpAll').textContent, allQty: $('dpAll').dataset.qty,
      values: ['dpKind', 'dpQty', 'dpReason'].map((id) => [id, $(id).value]) };
  }
  return null;
}
function restoreDialog(d) {
  if (!d) return;
  if (d.type === 'master') {
    S.masterTable = d.table;
    editMaster(d.id || null);
    d.values.forEach(([id, v]) => { const el = $(id); if (!el) return; if (el.type === 'checkbox') el.checked = v; else el.value = v; });
    syncMedicalCode();
    $('masterForm').dataset.dirty = d.dirty;
    $('masterForm').dataset.ver = d.ver || ''; // 期限切れ前に開いた版のまま（その間の他の人の更新は保存時に検出する）
  } else {
    const f = $('disposeForm');
    Object.assign(f.dataset, d.data);
    $('disposeInfo').textContent = d.info; $('dpQty').max = d.max; $('dpQtyHint').textContent = `最大 ${fmt(d.max)}`;
    $('dpAll').textContent = d.all; $('dpAll').dataset.qty = d.allQty;
    d.values.forEach(([id, v]) => { $(id).value = v; });
    alertBox('dpMsg', '');
    $('disposeDialog').showModal();
  }
}

/** 前の利用者の入力内容・表示結果を消す（共用端末で別の人がログインする場合に備える） */
function clearScreens() {
  S.pageHash = {};
  // 登録待ちの状態は利用者ごと：ログアウトしたら捨てる（共用端末で次の人に持ち越さない）
  S.req = {}; S.unsure = {}; S.changed = {}; S.checked = {}; S.masterSent = null; S.cancelReason = {}; S.invScope = null; S.recallJump = null;
  try { sessionStorage.removeItem('exo-return-draft'); } catch (e) { /* 何もしない */ }
  document.querySelectorAll('#app form').forEach((f) => f.reset());
  ['dashKpis', 'dashBody', 'shDone', 'invMsg', 'tcMsg', 'rtFindMsg', 'rtRecent', 'tlRecent', 'rcMsg', 'insMsg', 'insBody', 'shLines', 'shMsg', 'shRecent', 'rtShipment', 'rtMsg', 'invBody', 'tlBody', 'tcBody',
    'rcLots', 'rclFormMsg', 'rclList', 'msList'].forEach((id) => { if ($(id)) $(id).innerHTML = ''; });
  $('rtForm').hidden = true;
  showResume(false);
  delete $('rcExp').dataset.manual;
  Object.assign(S, { cfg: null, M: null, inventory: [], returnLine: null, inspectFilter: 'QUARANTINE,HOLD', masterTable: 'm_product',
    rtNo: '', returnLot: '', invPreset: '', backFocus: null, insReason: null, insFocusLot: '' });
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
      if (S.user && S.user.toLowerCase() !== email.toLowerCase()) { clearScreens(); S.pendingDialog = null; }
      S.user = email;
      setSession(data, false);
      $('loginPassword').value = '';
      await boot();
    } catch (err) {
      alertBox('loginMsg', err.message, 'ng', true);
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
  // 期限切れのときに出た古いエラー表示を消す（入力内容は残す）
  document.querySelectorAll('#app [id$="Msg"]').forEach((m) => { if (/有効期限|ログイン/.test(m.textContent)) m.innerHTML = ''; });
  $('login').hidden = true;
  $('app').hidden = false;
  renderNav();
  $('whoSide').textContent = S.user;
  $('whoSheet').textContent = S.user;
  try {
    await reloadMasters();
    ['rcDate', 'shDate'].forEach((id) => { if (!$(id).value) $(id).value = S.cfg.today; });
    setDateLimits();
    if (!$('shLines').children.length) addLine();
    route();
    // 初めてログインした人には、ステップ形式のガイドを自動で表示する
    if (!(S.cfg.prefs && S.cfg.prefs.guideDone)) openGuide(0); else focusTo($('main'));
    if (S.pendingDialog) { const d = S.pendingDialog; S.pendingDialog = null; setTimeout(() => restoreDialog(d), 300); } // 期限切れ前に開いていた入力ダイアログを戻す
    G_STATE.opener = null;
  } catch (err) {
    if (S.sess) toast(err.message, 'ng');
  }
}

/** 日付欄の入力できる範囲（サーバーの規則と同じ）：出荷日は当日〜過去90日、入荷日・返品日は当日まで */
function setDateLimits() {
  const t = S.cfg.today;
  const d = new Date(t + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 90);
  $('shDate').max = t; $('shDate').min = d.toISOString().slice(0, 10);
  $('rcDate').max = t; $('rtDate').max = t;
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
    setDateLimits();
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

/**
 * 画面の URL を変える。push=true は利用者の操作で表示が変わったとき（「戻る」で前の表示へ戻れるように履歴を積む）。
 * 画面を開いたときの読み込み（URL に合わせて表示する）では積まない。各画面の最後の URL は、メニューから開き直したときに使う
 */
function setUrl(h, push) {
  if (location.hash === h) return;
  if (push) history.pushState(null, '', h); else history.replaceState(null, '', h);
  S.lastHash = h;
  S.pageHash[(h.match(/^#\/(\w+)/) || [])[1]] = h;
}
/** 全角の英数字・記号を半角に（日本語入力のまま打ったコード・番号でも検索・登録できるように）。dash=true ならハイフン類も「-」に */
function half(v, dash = true) {
  const x = String(v || '').normalize('NFKC').trim();
  return dash ? x.replace(/[ー－―‐−–—]/g, '-') : x;
}
/** コード・番号の欄（ここに入った全角は半角に直す） */
const CODE_FIELD = /^(tlQuery|rtShipNo|rcSupLot|mf_\w*(code|phone|email)\w*)$/;

/** URL の値を読む（壊れた URL でもエラーにしない） */
function dec(v) { try { return decodeURIComponent(v); } catch (e) { return String(v).replace(/%/g, ''); } }
/** URL を開く（同じ URL ならその画面を読み込み直す） */
function goUrl(h) {
  if (location.hash === h) showPage((h.match(/^#\/(\w+)/) || [])[1]); else location.hash = h;
}

function route() {
  S.lastHash = location.hash;
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
  if (id) S.pageHash[id] = location.hash;
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  if (page.id !== id) { history.replaceState(null, '', '#/' + page.id); S.lastHash = '#/' + page.id; } // 存在しない画面の URL は残さない
  showPage(page.id);
}

function showPage(id) {
  // ブラウザの「戻る」などで画面が変わったら、開いている入力ダイアログを閉じる（裏の画面と食い違わないように）
  // 確認ダイアログ（#dialog）も閉じる。returnValue を空にして「キャンセル」扱いにし、見えない画面の操作を実行しない
  ['dialog', 'disposeDialog', 'masterDialog'].forEach((d) => { if ($(d).open) $(d).close(''); });
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
  window.scrollTo(0, 0); // 保存のお知らせ（トースト）は画面を移っても数秒は残す
  requestAnimationFrame(placeToasts); // 画面を移ったら、その画面の帯に合わせて位置を出し直す
  if (!$('app').hidden && !$('guideDialog').open && document.activeElement && !document.activeElement.closest('#guideResume')) focusTo($('main'));
  const loaders = { dashboard: loadDashboard, inspect: loadInspect, shipment: loadShipmentPage, inventory: loadInventory, return: loadReturnRecent, traceLot: loadTraceRecent, traceCustomer: loadCustomerTrace,
    recall: loadRecalls, master: loadMaster };
  guideFollowPage(id);
  const withMasters = ['master', 'shipment', 'receipt', 'traceCustomer', 'return'].includes(id); // マスタを使う画面は最新にしてから表示
  if (id === 'receipt') loaders.receipt = async () => {};
  let done = Promise.resolve();
  if (loaders[id]) {
    done = (withMasters ? freshMasters().then(() => { if (id === 'receipt' || id === 'shipment') renderPrereq(); return loaders[id](); }) : loaders[id]()).then(() => {
      // 「戻る」で一覧に戻ったら、開いた行にフォーカスを戻す
      const bf = S.backFocus;
      if (bf && bf.page === id) { S.backFocus = null; const row = document.querySelector('#page-' + id + ' ' + bf.sel); if (row) { row.focus(); row.scrollIntoView({ block: 'center' }); } }
    }).catch((e) => toast(e.message, 'ng'));
  }
  if (id === 'receipt' || id === 'shipment') renderPrereq();
  return done;
}

function go(id) {
  goUrl(S.pageHash[id] || '#/' + id); // 前に開いていた検索・出荷があれば、それを開く
}

const BEHIND_SHEET = () => [document.querySelector('.sidebar'), document.querySelector('.topbar'), $('main'), $('bottomNav'), document.querySelector('.skip-link')].filter(Boolean);
function openSheet() {
  $('sheetBackdrop').hidden = false;
  $('moreSheet').hidden = false;
  BEHIND_SHEET().forEach((x) => { x.inert = true; }); // 開いている間は、後ろの画面にフォーカスが移らないように
  const cur = $('sheetNav').querySelector('[aria-current="page"]') || $('sheetNav').querySelector('button');
  if (cur) cur.focus();
}
function closeSheet(restore) {
  if ($('moreSheet').hidden) return;
  $('sheetBackdrop').hidden = true;
  $('moreSheet').hidden = true;
  BEHIND_SHEET().forEach((x) => { x.inert = false; });
  if (restore === true) $('moreBtn').focus(); // 閉じるだけのとき（Esc・✕・外側）は「メニュー」ボタンに戻す（移動したときは画面側がフォーカスする）
}

async function reloadMasters(opts = {}) {
  const old = S.M;
  S.M = await api('getMasters');
  S.mAt = Date.now();
  const prod = active(S.M.products);
  const keep = Object.fromEntries(['rcSupplier', 'rcProduct', 'shCustomer', 'tcCustomer', 'rcLoc'].map((id) => [id, $(id).value]));
  $('rcSupplier').innerHTML = options(active(S.M.suppliers), 'id', (r) => r.supplier_code + '　' + r.name, '選択してください');
  $('rcProduct').innerHTML = options(prod, 'id', (r) => r.product_code + '　' + r.name, '選択してください');
  $('shCustomer').innerHTML = options(active(S.M.customers), 'id', (r) => r.customer_code + '　' + r.name, '選択してください');
  $('tcCustomer').innerHTML = options(S.M.customers, 'id', (r) => r.customer_code + '　' + r.name, '選択してください');
  // 選んでいた項目が他の利用者に無効にされたら、黙って空欄・別の項目にせず、外したことを知らせる
  const gone = { rcMsg: [], shMsg: [] };
  const nameOf = (list, id) => { const r = old && (old[list] || []).find((x) => String(x.id) === String(id));
    return { name: r ? (r.supplier_code || r.product_code || r.customer_code) + ' ' + r.name : '', self: !!opts.self && opts.self.key === list && String(opts.self.id) === String(id) }; }; // id は表ごとの連番なので、表の種類も比べる
  [['rcSupplier', 'suppliers', 'rcMsg'], ['rcProduct', 'products', 'rcMsg'], ['shCustomer', 'customers', 'shMsg'], ['tcCustomer', 'customers', '']].forEach(([id, list, msg]) => {
    if (!keep[id]) return;
    $(id).value = keep[id];
    if ($(id).value !== keep[id]) { $(id).value = ''; if (msg) { $(id).setAttribute('aria-invalid', 'true'); gone[msg].push(nameOf(list, keep[id])); } }
  });
  ['rcSupplier', 'rcProduct', 'shCustomer'].forEach((id) => { const o = $(id).options; if (o.length === 2 && !$(id).value && !keep[id]) $(id).value = o[1].value; });
  fillReceiptLocations();
  if (keep.rcLoc && [...$('rcLoc').options].some((o) => o.value === keep.rcLoc)) $('rcLoc').value = keep.rcLoc;
  else if (keep.rcLoc && $('rcProduct').value === keep.rcProduct) { // 選んでいた保管場所が無効にされた：別の場所に黙って入れ替えない
    $('rcLoc').value = ''; $('rcLoc').setAttribute('aria-invalid', 'true');
    const l = old && (old.locations || []).find((x) => String(x.id) === keep.rcLoc);
    // 原因を見分ける：商品の保管温度区分が変わったのか、保管場所そのものが変わったのか
    const oldP = old && (old.products || []).find((x) => String(x.id) === keep.rcProduct);
    const newP = S.M.products.find((x) => String(x.id) === keep.rcProduct);
    const prodClass = oldP && newP && oldP.storage_class !== newP.storage_class;
    gone.rcMsg.push({ name: l ? l.name + '（' + l.location_code + '）' : '保管場所', loc: true, prodClass,
      prodName: newP ? newP.product_code + ' ' + newP.name : '',
      self: !!opts.self && (prodClass ? opts.self.key === 'products' && String(opts.self.id) === keep.rcProduct
        : opts.self.key === 'locations' && String(opts.self.id) === keep.rcLoc) });
  }
  updateCustHint();
  renderPrereq();
  document.querySelectorAll('.slProd').forEach((sel) => {
    const v = sel.value;
    sel.innerHTML = options(prod, 'id', (r) => r.product_code + '　' + r.name, '商品を選択');
    sel.value = v;
    if (v && sel.value !== v) { // 無効にされた商品：選択を外し、単価・表示も消す
      sel.value = ''; sel.setAttribute('aria-invalid', 'true'); gone.shMsg.push(nameOf('products', v));
      const line = sel.closest('.line');
      line.querySelector('.slPrice').value = ''; setPriceHint(line, null);
      updateLineAvail(line);
      sel.setAttribute('aria-invalid', 'true');
    }
  });
  // 有効な商品が1つだけになったら、まだ触っていない最初の明細で選んでおく（明細を追加したときと同じ）
  const fl = $('shLines').firstElementChild;
  if (fl && prod.length === 1 && !fl.dataset.cleared && !fl.querySelector('.slProd').value && !fl.querySelector('.slQty').value) {
    const sel = fl.querySelector('.slProd'); sel.value = String(prod[0].id);
    fl.querySelector('.slPrice').value = prod[0].list_price !== null && prod[0].list_price !== undefined ? prod[0].list_price : ''; setPriceHint(fl, prod[0]); updateLineAvail(fl);
  }
  const say = (msg, list) => {
    if (!list.length) return;
    // 自分がマスタで保存した項目だけ「マスタで無効にした」、それ以外は他の利用者による変更
    const items = list.filter((x) => !x.loc), locs = list.filter((x) => x.loc);
    const mine = items.filter((x) => x.self), others = items.filter((x) => !x.self);
    const part = (xs, who) => xs.length ? `${xs.map((x) => `「${x.name}」`).join('、')}は、${who}ため選択を外しました。` : '';
    // 保管場所は無効化のほか、温度区分・隔離の変更でも選べなくなる
    const locPart = locs.map((x) => x.prodClass
      ? `商品「${x.prodName}」の保管温度区分が${x.self ? 'マスタで' : '他の利用者により'}変更されたため、保管場所「${x.name}」の選択を外しました。`
      : `保管場所「${x.name}」は、${x.self ? 'マスタの変更' : '他の利用者の変更（無効化・区分の変更）'}でこの商品に使えなくなったため選択を外しました。`).join('');
    alertBox(msg, part(mine, 'マスタで無効にした') + part(others, '他の利用者が無効にした') + locPart + '選び直してください。', 'warn', true);
    $(msg).dataset.gone = '1';
  };
  say('rcMsg', gone.rcMsg); say('shMsg', gone.shMsg);
  return gone;
}

/** 出荷明細：標準売価が未設定の商品なら、単価の下に案内を出す */
function setPriceHint(line, p) {
  const h = line.querySelector('.price-hint');
  const none = p && (p.list_price === null || p.list_price === '' || p.list_price === undefined);
  h.textContent = none ? '標準売価が未設定です。単価を入力してください。' : '';
  h.hidden = !none;
  line.querySelector('.slPrice').placeholder = none ? '要入力' : '';
}

/** 他の利用者が変えたマスタ・販売可否ルールを反映する（画面を開いたとき。30秒以内に読み込み済みなら省く） */
async function freshMasters(force) {
  if (!force && S.mAt && Date.now() - S.mAt < 30000) return null;
  return reloadMasters().catch(() => null); // 読めなくても手元の情報で続ける（外した項目の一覧を返す）
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
    body: '「販売可否」タブで、商品の規制区分 × 顧客区分ごとに「出荷してよいか」を決めます。\n\n最初の設定は仮のものです。法令上の区分を確認して見直したら、下のチェックを入れてください。' },
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
      : `<span class="guide-state todo">${icon('flag')}${g.key === 'released' ? 'まだ合格にしたロットがありません' : 'まだ登録がありません'}</span>`;
  } else if (i === 0 && done) {
    status += `<span class="guide-state done">${icon('check')}準備はすべて完了しています</span>`;
  }
  $('guideStatus').innerHTML = status;
  const page = g.page && PAGES.find((p) => p.id === g.page);
  $('guideGo').hidden = !page || (i === LAST && !done);
  if (page) $('guideGo').textContent = `「${g.table === 'rules' ? '販売可否ルール' : g.table ? MASTER[g.table].label + 'の登録' : page.label}」の画面を開く`;
  // 未完了のステップでは「画面を開く」を主ボタンにする（「次へ」で作業を飛ばさないように）
  const work = g.key && !st[g.key] && (g.key !== 'rules' || !S.rulesSeen); // ルールは画面を一度開くまでは「画面を開く」を主な操作に
  $('guideGo').className = 'btn btn-block ' + (work ? 'btn-primary' : 'btn-secondary');
  $('guidePrev').hidden = i === 0;
  document.querySelector('#guideDialog .guide-note').hidden = i === LAST && done;
  $('guideNext').textContent = i === LAST ? (done ? '完了' : `次の準備へ（${GUIDE[todo].short}）`)
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
  // まだ済んでいないステップでは「…の画面を開く」が主な操作なので、そこにフォーカスする（Enter で手順を飛ばさないように）
  const go = $('guideGo');
  (!go.hidden && go.classList.contains('btn-primary') ? go : $('guideNext')).focus();
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
  const go = $('guideGo'); // まだ済んでいないステップでは「…の画面を開く」に（Enter で手順を飛ばさないように）
  (!go.hidden && go.classList.contains('btn-primary') ? go : $('guideNext')).focus();
}

/** ステップの画面を開き、画面上部に「ガイドに戻る」を出す */
function guideGo() {
  const g = GUIDE[G_STATE.step];
  G_STATE.navigating = true;
  closeGuide();
  if (g.table) S.masterTable = g.table;
  go(g.page);
  if (!g.key) return; // まとめ・はじめには画面を開くだけ（戻る案内は出さない）
  G_STATE.doneList = [];
  setResume(false);
  showResume(true);
  $('main').focus({ preventScroll: true });
}

function showResume(on) {
  $('guideResume').hidden = !on;
  document.body.classList.toggle('has-resume', on);
  requestAnimationFrame(placeToasts);
}

function setResume(done) {
  const g = GUIDE[G_STATE.step];
  $('guideResume').classList.toggle('is-done', done);
  $('guideResumeText').textContent = done ? `完了：${g.short}` : `ガイド：${g.short}`;
  $('guideResume').querySelector('svg use').setAttribute('href', done ? '#i-check' : '#i-flag');
  $('guideResumeText').title = done ? `「${g.title}」が完了しました` : g.title;
  $('guideResumeBtn').textContent = done ? '次のステップへ' : 'ガイドに戻る';
}

/** ガイドの帯が出ている間に、画面のボタン（「検品へ進む」など）で次のステップの画面へ進んだら、帯も次のステップに合わせる */
function guideFollowPage(page) {
  if ($('guideResume').hidden || !S.cfg) return;
  const st = setupState(), g = GUIDE[G_STATE.step];
  if (!g.key || !st[g.key]) return;
  const next = firstTodo(st);
  if (next < 0 || GUIDE[next].page !== page || next === G_STATE.step) return;
  (G_STATE.doneList = G_STATE.doneList || []).push(g.short);
  G_STATE.step = next;
  setResume(false);
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
      const done = [...(G_STATE.doneList || []), g.short]; G_STATE.doneList = []; // 帯を出してから済ませたステップをまとめて伝える
      G_STATE.justDone = (done.length > 1 ? `${done.join('・')}が完了しました。` : `「${g.title}」が完了しました。`) + (next >= 0 ? `次は「${GUIDE[next].title}」です。` : 'これで準備はすべて完了です。');
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
    $('guideNext').focus();
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
  const kpi = (label, n, page, level, preset) =>
    `<button type="button" class="kpi ${n ? (level ? 'is-' + level : '') : 'is-zero'}" data-action="${preset ? 'goInv' : 'go'}" data-page="${page}"${preset ? ` data-preset="${preset}"` : ''}><span>${esc(label)}${icon('chev', 'kpi-go')}</span><b>${n}</b></button>`;
  $('dashKpis').innerHTML = kpi('検品待ち', d.quarantine.length, 'inspect', 'warn') + kpi('保留中', d.hold.length, 'inspect', 'warn') +
    kpi('期限90日以内', d.expiringSoon.length, 'inventory', 'warn', 'expiring') + kpi('処分待ちの在庫', d.toDispose.length, 'inventory', 'alert', 'dispose') +
    kpi('発注点以下', d.lowStock.length, 'inventory', 'warn', 'low') + kpi('対応中の回収', d.recalls.length, 'recall', 'alert');

  const lotRows = (list, toInv) => list.map((l) => ({ attrs: toInv
    ? ` class="clickable${ALERT_STATUS.has(l.status) ? ' is-alert' : ''}" data-action="goInv" data-preset="lots" data-q="${esc(l.lot_no)}" tabindex="0" aria-label="${esc(l.lot_no)} の在庫を開いて処分"`
    : ` class="clickable${ALERT_STATUS.has(l.status) ? ' is-alert' : ''}" data-action="traceLotNo" data-lot="${esc(l.lot_no)}" tabindex="0" aria-label="${esc(l.lot_no)} を追跡"`, cells: [html(mono(l.lot_no)), l.product, l.expires_on,
    days(l.daysLeft), html(badge(l.status, l.statusLabel)), num(l.stock)] }));
  const lotHead = [{ label: 'ロット', cls: 'primary' }, { label: '商品', cls: 'wide' }, { label: '使用期限', cls: 'nowrap' }, { label: '残日数', cls: 'num' },
    { label: '状態', cls: 'status' }, { label: '在庫', cls: 'num' }];
  const recalls = d.recalls.length ? '<ul class="list">' + d.recalls.map((r) => `<li><div class="grow"><span class="eyebrow">${esc(r.recall_no)}</span><div class="t">${esc(r.title)}</div>
      <div class="s">${r.activeTargets ? `対象顧客 ${r.activeTargets}件・連絡済 ${r.contactedRate}%・回収 ${fmt(r.recQty)} / ${fmt(r.shippedQty)}${r.unrecQty ? `（回収不能 ${fmt(r.unrecQty)}）` : ''}` : '出荷実績のある顧客なし'}</div>
      <div class="meter"><i data-w="${r.recoveredRate}"></i></div></div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="openRecall" data-id="${r.id}" aria-label="${esc(r.recall_no)} を開く">開く</button></li>`).join('') + '</ul>'
    : empty('対応中の回収案件はありません', 'check');
  const lc = d.lastCheck;
  const mismatch = lc && lc.mismatches && lc.mismatches.length ? `<div class="alert alert-ng span-full" role="alert">在庫数と在庫移動履歴が一致しない在庫が ${lc.mismatches.length} 件あります（日次チェック ${esc(lc.ran_at)}）。\n` +
    lc.mismatches.slice(0, 5).map((m) => `${esc(m.lot_no)}／${esc(m.location)}：在庫 ${fmt(m.on_hand)}・履歴合計 ${fmt(m.movement_total)}`).join('\n') +
    (lc.mismatches.length > 5 ? '\nほか ' + (lc.mismatches.length - 5) + ' 件' : '') + '\n管理者に確認してください。</div>' : '';
  const stale = d.checkStale ? `<div class="alert alert-warn span-full" role="status">日次チェック（期限切れの判定・在庫の照合）が24時間以上実行されていません${lc ? `（最終 ${esc(lc.ran_at)}）` : ''}。\nSupabase の「Integrations」→「Cron」に exo-trace-daily-check があるか、管理者に確認を依頼してください。</div>` : '';
  if (S.cfg) S.cfg.setup = d.setup;
  S.lowProducts = d.lowStock.map((x) => x.product);
  $('dashSetup').innerHTML = setupCard();
  $('dashKpis').hidden = !setupState().lots; // まだロットが1件も無いときは「0」ばかりの表示を出さない
  $('dashSetup').querySelectorAll('.meter i').forEach((i) => { i.style.width = Math.min(100, Number(i.dataset.w) || 0) + '%'; });
  if (!setupState().lots && !d.recalls.length) { // ロットが無いうちは空のカードを並べない（準備の案内に集中）
    const hidden = !$('dashSetup').innerHTML; // 「はじめにやること」を非表示にしたときも、次にやることが分かるようにする
    $('dashBody').innerHTML = mismatch + stale + (hidden ? `<div class="card span-full">${empty('まだロットがありません', 'box')}
      <p class="note center">入荷を登録すると、検品待ち・使用期限・在庫の状況がここに表示されます。</p>
      <div class="empty-actions">${(() => { const t = firstTodo(setupState()); return t >= 0 && GUIDE[t].key !== 'lots' ? `<button type="button" class="btn btn-primary btn-sm" data-action="guideStep" data-step="${t}">次の準備：${esc(GUIDE[t].short)}</button>` : goBtn('receipt', '入荷登録へ'); })()}<button type="button" class="btn btn-secondary btn-sm" data-action="guideOpen">ガイドを開く</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="showSetup">「はじめにやること」を再表示</button></div></div>` : '');
    return;
  }
  $('dashBody').innerHTML = mismatch + stale +
    `<div class="card"><h2 class="card-title">対応中の回収案件</h2>${recalls}</div>` +
    `<div class="card"><h2 class="card-title">発注点以下の商品</h2>${table([{ label: '商品', cls: 'primary' }, { label: '引当可能在庫', cls: 'num' }, { label: '発注点', cls: 'num' }],
      d.lowStock.map((x) => ({ attrs: ` class="clickable" data-action="goInv" data-preset="lots" data-q="${esc(x.product)}" tabindex="0" aria-label="${esc(x.product)} の在庫を見る"`, cells: [html(esc(x.product)), num(x.available), num(x.reorderPoint)] })), { empty: '発注点を下回る商品はありません', emptyIcon: 'check' })}</div>` +
    `<div class="card span-full"><h2 class="card-title">使用期限90日以内の在庫</h2>${table(lotHead, lotRows(d.expiringSoon), { empty: '該当するロットはありません', emptyIcon: 'check' })}</div>` +
    `<div class="card span-full"><div class="card-head"><div><h2 class="card-title">処分待ちの在庫</h2>${d.toDispose.length ? '<p class="card-sub">回収・不合格・期限切れで出荷できない在庫です。行を押すと在庫照会が開き、「処分」から廃棄・仕入先返品を記録できます。</p>' : ''}</div>
      ${d.toDispose.length ? `<button type="button" class="btn btn-secondary btn-sm" data-action="goInv" data-preset="dispose">在庫照会で処分する</button>` : ''}</div>
      ${table(lotHead, lotRows(d.toDispose, true), { empty: '処分待ちの在庫はありません', emptyIcon: 'check' })}</div>`;
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
  locHint('rcLoc', p && !locs.length ? `${code('storage_class', p.storage_class)}の保管場所が登録されていません。「マスタ設定」の「保管場所」で登録してください。` : '');
  if (locs.length === 1) setValue($('rcLoc'), locs[0].id);
}

function autoExpiry() {
  const p = S.M.products.find((x) => String(x.id) === $('rcProduct').value);
  const mfg = $('rcMfg').value;
  if (p && mfg && !$('rcExp').dataset.manual) {
    const d = new Date(mfg + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + Number(p.shelf_life_days || 0));
    setValue($('rcExp'), d.toISOString().slice(0, 10));
  }
}

async function submitReceipt(e) {
  e.preventDefault();
  if ($('rcSupLot').value) $('rcSupLot').value = half($('rcSupLot').value).toUpperCase(); // 大文字・小文字の違いで別ロットにならないように
  if (!checkRequired($('receiptForm'), 'rcMsg')) return;
  // 数量・日付の規則をまとめて確認し、問題のある欄をすべて示す
  const q = Number($('rcQty').value), d = $('rcDate').value, exp = $('rcExp').value, mfg = $('rcMfg').value;
  const probs = [];
  if (!(Number.isInteger(q) && q >= 1)) probs.push(['rcQty', '入荷数量は1以上の整数で入力してください。']);
  if ($('rcDate').max && d > $('rcDate').max) probs.push(['rcDate', '入荷日は当日以前の日付を入力してください。']);
  if (mfg && mfg > d) probs.push(['rcMfg', '製造日は入荷日以前の日付を入力してください。']);
  if (exp && exp <= d) probs.push(['rcExp', '使用期限は入荷日より後の日付を入力してください。']);
  const price = Number($('rcPrice').value);
  if (!(price >= 0)) probs.push(['rcPrice', '仕入単価は0以上で入力してください。']);
  if (probs.length) {
    probs.forEach(([id, msg]) => {
      $(id).setAttribute('aria-invalid', 'true');
      const fld = $(id).closest('.field');
      if (fld) { const old = fld.querySelector('.req-err'); if (old) old.remove(); fld.insertAdjacentHTML('beforeend', `<div class="field-err req-err">${esc(msg)}</div>`); }
    });
    alertBox('rcMsg', probs.map((x) => x[1]).join('\n'), 'ng');
    $(probs[0][0]).focus({ preventScroll: true });
    return;
  }
  // 入荷した時点で出荷できない使用期限（年の打ち間違いなど）は、登録前に確かめる
  const pr = S.M.products.find((x) => String(x.id) === $('rcProduct').value);
  const left = exp ? Math.round((new Date(exp + 'T00:00:00Z') - new Date(S.cfg.today + 'T00:00:00Z')) / 86400000) : null;
  if (pr && left !== null && left < Number(pr.min_remaining_days || 0) && !resending('receiptForm')
      && !(await ask({ title: 'このロットは出荷できません。登録しますか？', body: `使用期限 ${exp} は残り ${left} 日で、この商品の最低出荷残期間（${pr.min_remaining_days} 日）を下回ります。\n使用期限に誤りがないか確認してください。`, okText: 'このまま登録する', danger: true }))) {
    $('rcExp').focus();
    return;
  }
  await busy(e.submitter, async () => {
    alertBox('rcMsg', '');
    try {
      const r = await api('registerReceipt', { supplierId: $('rcSupplier').value, productId: $('rcProduct').value, supplierLotNo: $('rcSupLot').value,
        receiptDate: $('rcDate').value, manufacturedOn: $('rcMfg').value, expiresOn: $('rcExp').value, quantity: $('rcQty').value,
        unitPrice: $('rcPrice').value, arrivalTemp: $('rcTemp').value, locationId: $('rcLoc').value });
      alertBox('rcMsg', `入荷を登録しました。\n入荷番号 ${r.receiptNo}／社内ロット番号 ${r.lotNo}（検品待ち）` + (r.note ? '\n' + r.note : '') + (r.warning ? '\n⚠ ' + r.warning : ''), r.warning ? 'warn' : 'ok', false,
        goBtn('inspect', '検品へ進む'));
      ['rcSupLot', 'rcMfg', 'rcExp', 'rcQty', 'rcPrice', 'rcTemp'].forEach((id) => { $(id).value = ''; });
      clearMarks($('receiptForm'));
      delete $('rcExp').dataset.manual;
      guideAfterAction();
    } catch (err) {
      const field = [[/入荷数量/, 'rcQty'], [/入荷日/, 'rcDate'], [/製造日/, 'rcMfg'], [/使用期限/, 'rcExp'], [/仕入単価/, 'rcPrice'], [/仕入先ロット/, 'rcSupLot'],
        [/保管場所/, 'rcLoc'], [/到着時温度/, 'rcTemp'], [/商品/, 'rcProduct'], [/仕入先/, 'rcSupplier']].find(([re]) => re.test(err.message));
      if (/無効/.test(err.message)) { // 他の利用者が無効にした商品・仕入先：一覧を最新にして選び直してもらう
        await freshMasters(true);
        const id = field ? field[1] : 'rcProduct';
        $(id).setAttribute('aria-invalid', 'true');
        alertBox('rcMsg', err.message + '\n一覧を最新にしました。別の' + (id === 'rcSupplier' ? '仕入先' : '商品') + 'を選んでください。', 'ng', true);
        $(id).focus();
        return;
      }
      if (field) $(field[1]).setAttribute('aria-invalid', 'true');
      alertBox('rcMsg', err.message, 'ng');
    }
  });
}

// ======================================================================
// 検品・ロット
// ======================================================================
const NEXT = { QUARANTINE: ['RELEASED', 'HOLD', 'REJECTED'], RELEASED: ['HOLD'], HOLD: ['RELEASED', 'QUARANTINE', 'REJECTED'] };

/** 検品カードで入力中の判定・理由・COA（未保存）を控える／戻す。一覧を描き直しても消えないように */
function snapshotInspect(exceptId) {
  return [...$('insBody').querySelectorAll('.insTo')].filter((el) => el.dataset.id !== String(exceptId || ''))
    .map((el) => ({ id: el.dataset.id, to: el.value, reason: $('rs_' + el.dataset.id).value, coa: $('coa_' + el.dataset.id).checked }))
    .filter((x) => x.to || x.reason || x.coa);
}
function restoreInspect(snap) {
  snap.forEach((x) => {
    const sel = $('to_' + x.id);
    if (!sel || ![...sel.options].some((o) => o.value === x.to)) return;
    sel.value = x.to; $('rs_' + x.id).value = x.reason; $('coa_' + x.id).checked = x.coa;
    updateInspectAction(x.id);
  });
}

async function loadInspect(exceptId) {
  alertBox('insMsg', '', null, true);
  const snap = snapshotInspect(exceptId);
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
        <div class="field"><label for="to_${l.id}">判定</label><select id="to_${l.id}" class="insTo" data-id="${l.id}" data-status="${esc(l.status)}"><option value="">選択してください</option>${nexts.map((s) => `<option value="${s}">${esc(code('lot_status', s))}</option>`).join('')}</select></div>
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
  restoreInspect(snap);
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
  const expected = $('to_' + id).dataset.status; // 判定前の状態（通信が途切れたとき、変わったかを見分けるため）
  await busy(btn, async () => {
    alertBox('insMsg', '');
    try {
      const r = await api('changeLotStatus', { lotId: id, to: $('to_' + id).value, reason: $('rs_' + id).value, coaConfirmed: $('coa_' + id).checked,
        expectedStatus: $('to_' + id).dataset.status });
      guideAfterAction();
      await loadInspect(id);
      // 不合格にしたとき：同じ仕入先ロットの他の社内ロットの状態ごとに案内する
      const sib = r.siblings || [], by = (st) => sib.filter((x) => x.status === st).map((x) => x.lot_no).join('、');
      const notes = [by('RELEASED') && `${by('RELEASED')}（合格）は出荷できる状態です。同じ問題が疑われる場合は、保留にしてください。`,
        by('QUARANTINE') && `${by('QUARANTINE')}は検品待ちです。判定の際に同じ点を確認してください。`,
        by('HOLD') && `${by('HOLD')}は保留中です。`].filter(Boolean);
      const shippable = sib.find((x) => x.status === 'RELEASED');
      if (sib.length) S.insFocusLot = (shippable || sib[0]).lot_no;
      alertBox('insMsg', `ロット ${r.lot_no} を「${r.statusLabel}」にしました。` + (notes.length ? `\n同じ仕入先ロット「${r.supplier_lot_no}」について：` + notes.join('') : ''),
        shippable ? 'warn' : 'ok', false, r.status === 'RELEASED' ? goBtn('shipment', '出荷登録へ')
          : sib.length ? `<button type="button" class="btn btn-secondary btn-sm" data-action="insShowAll">ロット ${esc((shippable || sib[0]).lot_no)} を確認する</button>` : '');
    } catch (err) {
      // 他の利用者の変更などで状態が変わっている可能性があるので、最新の一覧に描き直す（入力中の内容は残す）
      const card0 = btn.closest('.lot-card');
      const reason0 = $('rs_' + id) ? $('rs_' + id).value : '';
      const lotNo0 = card0 ? card0.querySelector('.lot-no').textContent : '';
      await loadInspect().catch(() => {});
      if (err.unsure && $('to_' + id) && $('to_' + id).dataset.status === to) { // 通信は切れたが、判定は登録されていた
        resetRequest('lot_' + id);
        guideAfterAction();
        alertBox('insMsg', `通信が途切れましたが、ロット ${lotNo0} は「${code('lot_status', to)}」に登録されていました。`, 'ok');
        return;
      }
      if (err.unsure && !$('to_' + id)) { // 一覧から外れた：実際の状態を確かめる
        const lot = await api('traceLot', lotNo0).then((ls) => ls.find((x) => x.lot_no === lotNo0), () => null);
        if (lot && lot.status === to) {
          resetRequest('lot_' + id); guideAfterAction(); S.insFocusLot = lotNo0;
          alertBox('insMsg', `通信が途切れましたが、ロット ${lotNo0} は「${code('lot_status', to)}」に登録されていました（今の表示条件では一覧に出ません）。`, 'ok', false,
            '<button type="button" class="btn btn-secondary btn-sm" data-action="insShowAll">「すべて」で確認する</button>');
          return;
        }
        if (lot && lot.status !== expected) resetRequest('lot_' + id); // 状態が変わった：次の判定は新しい依頼
      }
      const gone = (/他の利用者/.test(err.message) || err.unsure) && !$('to_' + id);
      if (gone) { S.insFocusLot = lotNo0; S.insReason = { id, reason: reason0, to: $('to_' + id) ? '' : to }; }
      const typed = !$('rs_' + id) && reason0.trim() ? `\n入力していた理由：${reason0.trim()}` : ''; // 欄が消えても、入力した理由を写せるように
      const text = gone && err.unsure ? `通信が途切れましたが、ロット ${lotNo0} の判定は登録されていた可能性があります（一覧から外れました）。「すべて」で状態を確認してください。`
        : gone ? err.message.replace(/最新の状態を表示しました。.*$/, '') + '今の表示条件に当てはまらなくなったため、一覧から外れました。' : err.message;
      alertBox('insMsg', text + typed, 'ng', false,
        gone ? '<button type="button" class="btn btn-secondary btn-sm" data-action="insShowAll">「すべて」で確認する</button>' : '');
    }
  });
}

// ======================================================================
// 出荷
// ======================================================================
let lineSeq = 0;
function addLine(noAuto) {
  const n = ++lineSeq;
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<div class="field field-product"><label for="slp${n}">商品</label><select class="slProd" id="slp${n}">${options(active(S.M ? S.M.products : []), 'id', (r) => r.product_code + '　' + r.name, '商品を選択')}</select></div>
    <div class="field"><label for="slq${n}">数量</label><input class="slQty" id="slq${n}" type="number" inputmode="numeric" min="1" step="1" aria-describedby="sla${n}"><div class="line-avail" id="sla${n}" aria-live="polite"></div></div>
    <div class="field"><label for="slr${n}">単価（円・税抜）</label><input class="slPrice" id="slr${n}" type="number" inputmode="decimal" min="0" step="0.01" aria-describedby="slh${n}"><div class="field-hint price-hint" id="slh${n}" hidden></div></div>
    <button type="button" class="btn btn-ghost btn-sm line-remove" data-action="removeLine" aria-label="この明細を削除">${icon('x')}削除</button>`;
  const first = !$('shLines').children.length;
  $('shLines').appendChild(div);
  // 有効な商品が1つだけなら、最初の明細では選んでおく（入荷・顧客と同じ）。追加した明細は空のまま（使わなければ無視される）
  const sel = div.querySelector('.slProd');
  if (first && noAuto !== true && S.M && sel.options.length === 2) { sel.value = sel.options[1].value; const p = S.M.products.find((x) => String(x.id) === sel.value); div.querySelector('.slPrice').value = p && p.list_price !== null && p.list_price !== undefined ? p.list_price : ''; setPriceHint(div, p); updateLineAvail(div); }
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
  // 数量・単価だけ入っていて商品が空の明細は、黙って除かずに商品の選択を求める（一部だけ出荷するのを防ぐ）
  lineEls.filter((l) => !l.querySelector('.slProd').value && (l.querySelector('.slQty').value.trim() || l.querySelector('.slPrice').value.trim()))
    .forEach((l) => { if (!extra.includes(l.querySelector('.slProd'))) extra.push(l.querySelector('.slProd')); });
  $('shMsg').dataset.client = '1';
  if (!checkRequired($('shipForm'), 'shMsg', extra)) return;
  // 出荷日の範囲（当日〜過去90日）
  const sd = $('shDate');
  if (sd.value && ((sd.min && sd.value < sd.min) || (sd.max && sd.value > sd.max))) {
    sd.setAttribute('aria-invalid', 'true');
    alertBox('shMsg', `出荷日は ${sd.min} 〜 ${sd.max} の日付を入力してください。`, 'ng', true);
    sd.focus();
    return;
  }
  // 数量は1以上の整数
  const badQty = lineEls.find((l) => l.querySelector('.slProd').value && !(Number.isInteger(Number(l.querySelector('.slQty').value)) && Number(l.querySelector('.slQty').value) >= 1));
  if (badQty) {
    const el = badQty.querySelector('.slQty');
    el.setAttribute('aria-invalid', 'true');
    alertBox('shMsg', '数量は1以上の整数で入力してください。', 'ng', true);
    el.focus();
    return;
  }
  // 販売可否ルール（確認ダイアログの前に止める）。止まりそうなら、他の利用者がルールを変えていないか最新を読んでから判定する
  const again = resending('shipForm'); // 前回の確定が届いたか分からない：在庫・販売可否の判定はサーバーに任せて、そのまま送る
  if (!again && lineEls.some((l) => l.querySelector('.slProd').value && saleBlocked(l.querySelector('.slProd').value))) {
    const gone = await freshMasters(true);
    if (gone && gone.shMsg.length) { // 最新にしたら選択を外した項目がある：その案内を出して止める（他のエラーで上書きしない）
      const el = $('shipForm').querySelector('[aria-invalid="true"]'); if (el) el.focus();
      return;
    }
  }
  const ng = !again && lineEls.find((l) => l.querySelector('.slProd').value && saleBlocked(l.querySelector('.slProd').value));
  if (ng) {
    const el = ng.querySelector('.slProd');
    el.setAttribute('aria-invalid', 'true');
    alertBox('shMsg', `「${(S.M.products.find((p) => String(p.id) === el.value) || {}).name}」は、${saleBlocked(el.value)}。商品か顧客を変更してください。`, 'ng', true);
    el.focus();
    return;
  }
  // 引当可能数を超える明細（同じ商品の合計で判定）
  const want = {};
  lines.filter((l) => l.productId).forEach((l) => { want[l.productId] = (want[l.productId] || 0) + Number(l.quantity); });
  const shortP = again ? null : Object.keys(want).find((pid) => { const n = availFor(pid); return n !== null && S.inventory.length && want[pid] > n; });
  if (shortP) {
    const el = lineEls.find((l) => l.querySelector('.slProd').value === shortP).querySelector('.slQty');
    el.setAttribute('aria-invalid', 'true');
    const un = unshippableFor(shortP);
    alertBox('shMsg', `「${(S.M.products.find((p) => String(p.id) === shortP) || {}).name}」の数量が引当可能数（${fmt(availFor(shortP))}）を超えています。` +
      (un ? `\nほかに在庫 ${fmt(un.qty)} がありますが、${un.why}のため出荷できません。` : ''), 'ng', true,
      un ? `<button type="button" class="btn btn-secondary btn-sm" data-action="goInv" data-preset="lots" data-prod="${esc((S.M.products.find((p) => String(p.id) === shortP) || {}).product_code || '')}" data-label="${esc('商品 ' + ((S.M.products.find((p) => String(p.id) === shortP) || {}).name || ''))}">在庫照会で確認</button>` : '');
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
    $('shDone').innerHTML = '';
    try {
      const s = await api('createShipment', { customerId: $('shCustomer').value, shippedOn: $('shDate').value, note: $('shNote').value, lines: lines.filter((l) => l.productId) });
      alertBox('shMsg', '');
      $('shDone').innerHTML = `<div class="alert alert-ok" role="status" tabindex="-1" data-no="${esc(s.shipment_no)}"><div class="alert-text">出荷を確定しました。出荷番号 <span class="mono">${esc(s.shipment_no)}</span>（${esc(s.customer)}）
        <div class="alert-actions">${[...new Set(s.lines.map((l) => l.lot_no))].slice(0, 4).map((no) => `<button type="button" class="btn btn-secondary btn-sm" data-action="traceLotNo" data-lot="${esc(no)}">${esc(no)} を追跡</button>`).join('')}</div></div></div>` +
        table([{ label: '商品', cls: 'primary' }, 'ロット', { label: '使用期限', cls: 'nowrap' }, { label: '数量', cls: 'num' }, { label: '単価', cls: 'num' }],
          s.lines.map((l) => ({ cells: [html(esc(l.product)), html(mono(l.lot_no)), l.expires_on, num(l.quantity), num(l.unit_price)] })));
      $('shDone').scrollIntoView({ block: 'start', behavior: 'smooth' });
      focusTo($('shDone').firstElementChild);
      guideAfterAction();
      $('shLines').innerHTML = '';
      addLine();
      $('shNote').value = '';
      await loadShipmentPage();
    } catch (err) {
      $('shMsg').dataset.client = ''; $('shMsg').dataset.changed = '';
      // エラーの原因になった欄に印を付ける
      if (/^出荷日|出荷日は|出荷日を/.test(err.message)) $('shDate').setAttribute('aria-invalid', 'true');
      const m = err.message.match(/商品「(.+?)」/);
      if (m) lineEls.filter((l) => { const p = S.M.products.find((x) => String(x.id) === l.querySelector('.slProd').value); return p && p.name === m[1]; })
        .forEach((l) => l.querySelector(/販売できません/.test(err.message) ? '.slProd' : '.slQty').setAttribute('aria-invalid', 'true'));
      if (/無効/.test(err.message)) { // 他の利用者が無効にした顧客・商品：一覧を最新にして選び直してもらう
        await freshMasters(true);
        const el = /顧客/.test(err.message) ? $('shCustomer') : lineEls.map((l) => l.querySelector('.slProd')).find((x) => !x.value) || $('shCustomer');
        el.setAttribute('aria-invalid', 'true');
        alertBox('shMsg', err.message + '\n一覧を最新にしました。別の' + (/顧客/.test(err.message) ? '顧客' : '商品') + 'を選んでください。', 'ng', true);
        el.focus();
        return;
      }
      alertBox('shMsg', err.message, 'ng');
      if (err.unsure || err.replayedOther) { loadRecentShipments().catch(() => {}); return; } // 登録済みの出荷を一覧で確かめられるように。引当可能数は前回分が引かれて見えるので更新しない（再送が止まらないように）
      loadInventory().then(() => document.querySelectorAll('#shLines .line').forEach((l) => updateLineAvail(l))).catch(() => {}); // 引当可能数を最新に
    }
  });
}

/** 出荷画面：明細ごとの引当可能数を出せるよう在庫を読む */
async function loadShipmentPage() {
  await Promise.all([loadRecentShipments(), loadInventory().catch(() => {})]);
  document.querySelectorAll('#shLines .line').forEach((l) => updateLineAvail(l));
}

/** 明細の「引当可能 N」表示（当日時点の目安。最終判定はサーバー） */
function availFor(productId) {
  const p = S.M && S.M.products.find((x) => String(x.id) === String(productId));
  if (!p) return null;
  return S.inventory.filter((r) => r.allocatable && r.product_code === p.product_code).reduce((a, r) => a + r.qty, 0);
}
/** 在庫はあるが出荷できない数量と、その理由（回収中・残期間不足など） */
function unshippableFor(productId) {
  const p = S.M && S.M.products.find((x) => String(x.id) === String(productId));
  if (!p) return null;
  const rows = S.inventory.filter((r) => !r.allocatable && r.qty > 0 && r.product_code === p.product_code);
  if (!rows.length) return null;
  return { qty: rows.reduce((a, r) => a + r.qty, 0), why: [...new Set(rows.map(invReason))].join('・') };
}
/** 出荷先の顧客区分を選択欄の下に出す（販売できる商品が区分で決まるため） */
function updateCustHint() {
  const c = S.M && S.M.customers.find((x) => String(x.id) === $('shCustomer').value);
  $('shCustHint').textContent = c ? '顧客区分：' + code('customer_type', c.customer_type) : '';
}

/** 選んだ顧客に、その商品を販売できるか（販売可否ルール）。顧客未選択なら null */
function saleBlocked(productId) {
  const c = S.M && S.M.customers.find((x) => String(x.id) === $('shCustomer').value);
  const p = S.M && S.M.products.find((x) => String(x.id) === String(productId));
  if (!c || !p) return null;
  const rule = S.M.salesRules.find((r) => r.regulatory_class === p.regulatory_class && r.customer_type === c.customer_type);
  return rule && String(rule.allowed) === 'true' ? null
    : `この顧客には販売できません（${code('regulatory_class', p.regulatory_class)} → ${code('customer_type', c.customer_type)}）`;
}

function updateLineAvail(line, byUser) {
  const pid = line.querySelector('.slProd').value;
  const out = line.querySelector('.line-avail');
  const n = pid ? availFor(pid) : null;
  const qty = Number(line.querySelector('.slQty').value || 0);
  const blocked = pid ? saleBlocked(pid) : null;
  const un = pid && n !== null ? unshippableFor(pid) : null;
  out.textContent = blocked || (n === null ? '' : `引当可能 ${fmt(n)}` + (un ? `（ほかに在庫 ${fmt(un.qty)} は${un.why}のため出荷できません）` : ''));
  out.classList.toggle('short', !!blocked || (n !== null && qty > n));
  // 直したら赤い印とエラー表示を消す
  if (pid && !blocked) line.querySelector('.slProd').removeAttribute('aria-invalid'); // 商品を選び直したときだけ印を消す
  if (!(n !== null && qty > n) && qty > 0) line.querySelector('.slQty').removeAttribute('aria-invalid');
  // サーバーのエラーが出ている状態で入力を直したら、もう一度確定するよう案内する
  if (byUser && $('shMsg').dataset.client !== '1' && $('shMsg').querySelector('.alert-ng') && !$('shMsg').dataset.changed) {
    $('shMsg').dataset.changed = '1';
    $('shMsg').querySelector('.alert-text').insertAdjacentHTML('beforeend', '<div class="alert-note">入力を変更しました。内容を確認して、もう一度「出荷を確定」を押してください。</div>');
  }
  // 画面側のチェックで出したエラーだけを消す（サーバーからのエラーは次に確定するまで残す）
  if ($('shMsg').dataset.client === '1' && $('shMsg').querySelector('.alert-ng') && ![...document.querySelectorAll('#shLines [aria-invalid="true"]')].length) alertBox('shMsg', '');
}

async function loadRecentShipments() {
  const list = await api('getRecentShipments', 30);
  $('shRecent').innerHTML = table([{ label: '出荷番号', cls: 'primary' }, { label: '出荷日', cls: 'nowrap' }, { label: '顧客', cls: 'wide' }, { label: '明細', cls: 'wide' },
    { label: '金額（円）', cls: 'num' }, { label: '状態', cls: 'status' }, { label: '', cls: 'actions' }],
    list.map((s) => ({ attrs: ` data-no="${esc(s.shipment_no)}"`, cells: [html(mono(s.shipment_no)), s.shipped_on, s.customer,
      html(s.lines.map((l) => `<div class="li"><span>${esc(l.product)}</span><span class="li-sub"><span class="mono">${esc(l.lot_no)}</span> × ${l.quantity}${l.returned ? `（返品 ${l.returned}）` : ''}</span></div>`).join('')),
      num(s.amount), html(s.status === 'SHIPPED' ? badge('ok', '出荷済') : badge('ng', '取消')),
      s.status === 'SHIPPED' ? html(`<button type="button" class="btn btn-danger-text btn-sm" data-action="cancelShip" data-id="${s.id}" data-no="${esc(s.shipment_no)}">出荷を取消</button>`) : ''] })),
    { empty: 'まだ出荷はありません', emptyIcon: 'truck' });
}

async function cancelShip(btn) {
  const reason = await ask({ title: `出荷 ${btn.dataset.no} を取消しますか？`, body: '在庫に戻ります。返品が登録されている出荷は取消できません。', input: '取消理由', value: (S.cancelReason || {})[btn.dataset.no] || '', okText: '取消する', danger: true });
  if (reason) (S.cancelReason = S.cancelReason || {})[btn.dataset.no] = reason; // 通信が途切れてやり直すとき、理由を打ち直さずに済むように
  if (!reason) return;
  await busy(btn, async () => {
    try {
      await api('cancelShipment', btn.dataset.id, reason);
      toast('出荷 ' + btn.dataset.no + ' を取消しました');
      // 上部の「出荷を確定しました」がこの出荷なら、取消済みの表示に置き換える（誤解を防ぐ）
      if ($('shMsg').querySelector('.alert-ng')) alertBox('shMsg', '', null, true); // 在庫が戻ったので、前の在庫不足の表示は消す
      const done = $('shDone').firstElementChild;
      if (done && done.dataset.no === btn.dataset.no) alertBox('shDone', `出荷 ${btn.dataset.no} は取消済みです（在庫に戻しました）。`, 'warn', true);
      await loadShipmentPage();
      focusTo($('shRecent').querySelector(`tr[data-no="${CSS.escape(btn.dataset.no)}"]`) || $('shRecent')); // 取消した出荷の行へ
    } catch (err) { // 他の利用者が先に取消・返品した等：最新の一覧に描き直して、その行へ
      if (!S.sess) return; // ログアウトした（期限切れ）：ログイン画面が説明している
      const fresh = await loadShipmentPage().then(() => true, () => false);
      if (fresh && /取消され/.test(err.message)) { // 上部の「出荷を確定しました」がこの出荷なら、取消済みと分かるように
        const done = $('shDone').firstElementChild;
        if (done && done.dataset.no === btn.dataset.no) alertBox('shDone', `出荷 ${btn.dataset.no} は取消済みです（他の利用者が取消しました）。`, 'warn', true);
      }
      const row = $('shRecent').querySelector(`tr[data-no="${CSS.escape(btn.dataset.no)}"]`);
      if (err.unsure && fresh && row && !row.querySelector('[data-action="cancelShip"]')) toast(`出荷 ${btn.dataset.no} の取消は完了していました`); // 通信は切れたが取消できていた
      else if (err.unsure && fresh && row) toast(`出荷 ${btn.dataset.no} を取消できませんでした（通信が途切れました）。もう一度「出荷を取消」を押してください。`, 'ng');
      else toast(err.message + (fresh ? '（最新の状態を表示しました）' : ''), 'ng');
      focusTo(row || $('shRecent'));
    }
  });
}

// ======================================================================
// 返品
// ======================================================================
async function findShipmentForReturn(e, keepMsg, fromUrl) {
  if (e) e.preventDefault();
  $('rtShipNo').value = half($('rtShipNo').value);
  if (!keepMsg) alertBox('rtFindMsg', '');
  alertBox('rtMsg', '');
  // 入力途中の返品を閉じる前に確認する（下書きは残るので「戻る」でも戻せる）
  const confirmLeave = async () => !(!fromUrl && !keepMsg && S.rtNo && unsavedScreens().includes('返品登録'))
    || ask({ title: '入力中の返品内容を閉じますか？', body: `出荷 ${S.rtNo} の返品は、まだ登録していません。「戻る」で開き直すと、入力した内容を戻せます。`, okText: '閉じて切り替える', danger: true });
  if (!$('rtShipNo').value.trim()) {
    if (!(await confirmLeave())) { $('rtShipNo').value = S.rtNo; return; }
    // 空のまま検索したら、最近の出荷の一覧を出す
    $('rtShipment').innerHTML = ''; $('rtForm').hidden = true; S.returnLine = null; S.rtNo = '';
    setUrl('#/return', false);
    await loadReturnRecent();
    alertBox('rtFindMsg', '出荷番号を入力するか、下の「最近の出荷」から選んでください。', 'info', true);
    $('rtShipNo').focus();
    return;
  }
  const btn = e && e.submitter;
  await busy(btn, async () => {
    try {
      const asked = $('rtShipNo').value;
      const s = await api('getShipmentByNo', asked);
      if ($('rtShipNo').value !== asked) return; // 待っている間に別の番号が入力されたら、古い結果で上書きしない
      if (s.shipment_no !== S.rtNo && !(await confirmLeave())) { $('rtShipNo').value = S.rtNo; $('rtShipNo').removeAttribute('aria-invalid'); return; }
      const same = s.shipment_no === S.rtNo, keepForm = same && !keepMsg ? captureReturnForm() : null; // 同じ出荷の検索し直しでは、入力中のフォームをそのまま残す
      if (!same && fromUrl && S.rtNo && unsavedScreens().includes('返品登録')) toast(`出荷 ${S.rtNo} の入力途中の内容は、「進む」で戻せます`);
      $('rtForm').hidden = true; S.returnLine = null; S.rtNo = s.shipment_no;
      $('rtShipment').innerHTML = `<div class="ship-head"><p class="card-sub"><b class="mono">${esc(s.shipment_no)}</b>・${joinNw([s.shipped_on, s.customer])} ${s.status !== 'SHIPPED' ? badge('ng', '取消済') : ''}</p>
        <button type="button" class="btn btn-secondary btn-sm" data-action="newReturn">別の出荷を選ぶ</button></div>` +
        table([{ label: '商品', cls: 'primary' }, { label: 'ロット', cls: 'wide' }, { label: 'ロット状態', cls: 'status' }, { label: '出荷数', cls: 'num' }, { label: '返品済', cls: 'num' }, { label: '返品可能', cls: 'num' }, { label: '', cls: 'actions' }],
          s.lines.map((l) => ({ attrs: rowAlert(l.lot_status_code), cells: [html(esc(l.product)), html(mono(l.lot_no)), html(badge(l.lot_status_code, l.lot_status)), num(l.quantity), num(l.returned), num(l.returnable),
            l.returnable > 0 ? html(`<button type="button" class="btn btn-secondary btn-sm" data-action="selectReturnLine" data-id="${l.id}" data-max="${l.returnable}" data-label="${esc(l.product + '／' + l.lot_no)}" data-recall="${l.in_open_recall ? 1 : ''}" data-storage="${esc(l.storage_class)}">この明細を返品</button>`) : ''] })));
      $('rtRecent').innerHTML = '';
      // 再読み込みしても同じ出荷を開けるよう、出荷番号を URL に残す
      // 別の出荷に切り替えたときは履歴を積む（「戻る」で前の出荷に戻れるように）
      // （最近の出荷から選んだときも積むので、「戻る」で一覧に戻れる。URL に合わせて開いたときは積まない）
      const onPage = S.page === 'return'; // 待っている間に別の画面へ移っていたら、URL・フォーカスは変えない
      if (onPage) setUrl('#/return?no=' + encodeURIComponent(s.shipment_no), !fromUrl);
      $('rtShipNo').value = s.shipment_no; // 一部だけ入力された番号は、見つかった正式な番号に置き換える（下書きの保存・復元を合わせるため）
      if (!keepMsg && onPage) focusTo($('rtShipment').querySelector('.card-sub'));
      if (keepForm) restoreReturnForm(keepForm);
      else if (!fromUrl && !keepMsg) restoreReturnDraft(s.shipment_no); // 同じ出荷を選び直したら、入力途中の内容を戻す
    } catch (err) {
      if (S.rtNo && !fromUrl) { // 表示中の出荷はそのまま残す（入力途中の内容も消さない）。番号の誤りだけを知らせる
        alertBox('rtFindMsg', err.message + `\n出荷番号を確かめてください。表示中の出荷（${S.rtNo}）はそのままです。`, 'ng');
        $('rtShipNo').setAttribute('aria-invalid', 'true');
        return;
      }
      $('rtShipment').innerHTML = ''; $('rtForm').hidden = true; S.returnLine = null; S.rtNo = '';
      $('rtShipNo').setAttribute('aria-invalid', 'true');
      if (S.page === 'return') setUrl('#/return', false);
      await loadReturnRecent().catch(() => {}); // 見つからないときは最近の出荷から選べるようにする
      alertBox('rtFindMsg', /一覧から選んで/.test(err.message) ? err.message : err.message + '\n出荷番号を確かめるか、下の「最近の出荷」から選んでください。', 'ng');
    }
  });
}

/** ロット追跡：最近入荷したロットをすぐ選べるようにする */
async function loadTraceRecent() {
  // URL のとおりに表示する（「戻る」・再読み込み・他の画面からの移動）。表示中でも最新の状態で検索し直す
  const q = (location.hash.match(/[?&]q=([^&]+)/) || [])[1];
  if (q) {
    $('tlQuery').value = dec(q); $('tlQuery').removeAttribute('aria-invalid');
    await searchLot({ preventDefault() {}, submitter: null }, true);
    if ($('tlBody').querySelector('.lot-card')) return;
  } else { $('tlBody').innerHTML = ''; $('tlQuery').value = ''; }
  await renderTraceChips();
}

/** ロット追跡：「最近のロット」を出す */
async function renderTraceChips() {
  const lots = (await api('getLots', [])).sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)) || b.id - a.id).slice(0, 8);
  if ($('tlBody').querySelector('.lot-card')) return; // 読み込み中に検索された
  if (!lots.length) { $('tlRecent').innerHTML = `<div class="empty">${icon('box')}まだロットがありません</div><p class="note center">入荷を登録すると、ロットごとに入荷から販売先までを追跡できます。</p><div class="empty-actions">${goBtn('receipt', '入荷を登録する')}</div>`; return; }
  $('tlRecent').innerHTML = lots.length ? `<h3 class="section-title">最近のロット</h3><div class="recent-chips">${lots.map((l) =>
    `<button type="button" class="btn btn-secondary btn-sm" data-action="traceLotNo" data-lot="${esc(l.lot_no)}">${esc(l.lot_no)}</button>`).join('')}</div>` : '';
}

/** 返品画面：最近の出荷から選べるようにする */
/** 返品フォームの入力内容を控える／戻す（出荷を最新に描き直しても入力を失わないように） */
function captureReturnForm() {
  if ($('rtForm').hidden || !S.returnLine) return null;
  return { line: S.returnLine, values: Object.fromEntries(['rtQty', 'rtDate', 'rtReason', 'rtQLoc', 'rtDisp', 'rtRLoc'].map((id) => [id, $(id).value])) };
}
/** 返品の入力途中の内容をタブ内に保存する（再読み込みしても戻せるように） */
//   出荷ごとに持つ（別の出荷に切り替えても、前の出荷の入力途中の内容は「戻る」で戻せる）。多くなりすぎないよう直近5件まで
function readDrafts() {
  try {
    const all = JSON.parse(sessionStorage.getItem('exo-return-draft') || 'null');
    return all && all.user === S.user && all.drafts ? all.drafts : {};
  } catch (e) { return {}; }
}
function writeDraft(no, d) {
  if (!no) return;
  try {
    const drafts = readDrafts();
    delete drafts[no];
    if (d) drafts[no] = d;
    const keep = Object.fromEntries(Object.entries(drafts).slice(-5));
    sessionStorage.setItem('exo-return-draft', JSON.stringify({ user: S.user, drafts: keep }));
  } catch (e) { /* 保存できない環境では何もしない */ }
}
function saveReturnDraft() { writeDraft(S.rtNo, captureReturnForm()); }

/** タブ内に残っている、この出荷の入力途中の内容 */
function returnDraftFor(no) { return readDrafts()[no] || null; }
/** 入力途中の内容を戻す。明細がもう返品できなければ知らせて下書きを消す */
function restoreReturnDraft(no) {
  const d = returnDraftFor(no);
  if (!d || !$('rtForm').hidden) return;
  if (restoreReturnForm(d)) { toast('入力途中の返品内容を戻しました'); if (S.page === 'return') $('rtQty').focus({ preventScroll: false }); }
  else {
    writeDraft(no, null);
    toast('入力途中だった明細は、もう返品できないため内容を戻せませんでした', 'warn');
  }
}

function restoreReturnForm(saved) {
  if (!saved) return false;
  const b = $('rtShipment').querySelector(`[data-action="selectReturnLine"][data-id="${saved.line}"]`);
  if (!b) return false;
  selectReturnLine(b, true);
  Object.entries(saved.values).forEach(([id, v]) => {
    if ($(id).disabled || ($(id).tagName === 'SELECT' && v === '' && $(id).value)) return; // 自動で選んだ場所を空で上書きしない
    if ($(id).tagName !== 'SELECT' || [...$(id).options].some((o) => o.value === v)) $(id).value = v;
  });
  $('rtRLocWrap').hidden = $('rtDisp').value !== 'RESTOCK';
  return true;
}

async function loadReturnRecent() {
  const fromUrl = (location.hash.match(/[?&]no=([^&]+)/) || [])[1];
  if (fromUrl && (!$('rtShipment').innerHTML || dec(fromUrl) !== $('rtShipNo').value.trim().toUpperCase())) {
    $('rtShipNo').value = dec(fromUrl);
    await findShipmentForReturn(null, false, true);
    if (S.rtNo) restoreReturnDraft(S.rtNo); // 再読み込み・「進む」の前の入力途中の内容があれば戻す
    return;
  }
  // 表示中の出荷があれば最新の状態で出し直す（回収などでロットの状態が変わっている場合があるため）
  if (fromUrl) {
    const saved = captureReturnForm();
    alertBox('rtFindMsg', '');
    await findShipmentForReturn(null, false, true);
    restoreReturnForm(saved); // 入力途中だった明細は、まだ返品できるなら選び直して入力内容も戻す
    return;
  }
  // URL に出荷番号が無い（「戻る」で一覧に戻った）ときは、出荷の表示を閉じて最近の出荷を出す
  // （入力途中の内容は下書きに残っているので、「進む」で戻せる）
  if ($('rtShipment').innerHTML && unsavedScreens().includes('返品登録')) toast(`出荷 ${S.rtNo} の入力途中の内容は、「進む」で戻せます`);
  if (!$('rtShipment').innerHTML && !S.rtNo) { alertBox('rtFindMsg', ''); $('rtShipNo').removeAttribute('aria-invalid'); } // 前の検索のエラーを残さない
  if ($('rtShipment').innerHTML) { $('rtShipment').innerHTML = ''; $('rtForm').hidden = true; S.returnLine = null; S.rtNo = ''; $('rtShipNo').value = ''; alertBox('rtMsg', ''); alertBox('rtFindMsg', ''); }
  const list = (await api('getRecentShipments', 10)).filter((s) => s.status === 'SHIPPED');
  $('rtRecent').innerHTML = `<h3 class="section-title">最近の出荷</h3>` + table([{ label: '出荷番号', cls: 'primary' }, { label: '出荷日', cls: 'nowrap' }, { label: '顧客', cls: 'wide' }, { label: '', cls: 'actions' }],
    list.map((s) => ({ cells: [html(mono(s.shipment_no) + `<div class="card-sub">${esc(s.lines.map((l) => l.product + " ×" + l.quantity).join("、"))}</div>`), s.shipped_on, s.customer,
      html(`<button type="button" class="btn btn-secondary btn-sm" data-action="pickReturnShipment" data-no="${esc(s.shipment_no)}">この出荷を選ぶ</button>`)] })),
    { empty: '返品できる出荷はありません', emptyIcon: 'truck' });
}

/** 返品の入力をやめる：選んだ明細を元に戻し、そのボタンにフォーカスを戻す */
function cancelReturn() {
  $('rtForm').hidden = true;
  writeDraft(S.rtNo, null);
  $('rtReason').value = ''; $('rtQty').value = '';
  const sel = $('rtShipment').querySelector('[data-action="selectReturnLine"][data-id="' + S.returnLine + '"]');
  S.returnLine = null;
  $('rtShipment').querySelectorAll('tr.is-selected').forEach((tr) => tr.classList.remove('is-selected'));
  $('rtShipment').querySelectorAll('[data-action="selectReturnLine"]').forEach((b) => { b.textContent = 'この明細を返品'; b.disabled = false; });
  focusTo(sel || $('rtShipment'));
}

function selectReturnLine(btn, quiet) {
  S.returnLine = btn.dataset.id;
  document.querySelectorAll('#rtShipment tr.is-selected').forEach((tr) => tr.classList.remove('is-selected'));
  document.querySelectorAll('#rtShipment [data-action="selectReturnLine"]').forEach((b) => { b.textContent = 'この明細を返品'; b.disabled = false; });
  btn.closest('tr').classList.add('is-selected');
  S.returnLot = (btn.dataset.label.split('／')[1] || '');
  btn.textContent = '選択中';
  btn.disabled = true;
  $('rtForm').hidden = false;
  $('rtLineInfo').innerHTML = joinNw(btn.dataset.label.split('／').concat(['返品可能 ' + btn.dataset.max]));
  $('rtQty').max = btn.dataset.max;
  $('rtQty').value = '';
  $('rtReason').value = ''; // 前の明細・出荷の理由を引き継がない（下書きを戻すときは、このあと上書きする）
  $('rtQtyHint').textContent = `最大 ${btn.dataset.max}`;
  $('rtDate').value = S.cfg.today;
  // 商品と同じ温度区分の保管場所だけを選べるようにする（1か所だけなら自動で選ぶ）
  const locs = active(S.M.locations).filter((l) => l.storage_class === btn.dataset.storage);
  const fill = (id, list) => {
    $(id).innerHTML = options(list, 'id', (l) => l.name + '（' + l.location_code + '）', list.length ? '選択してください' : '該当する保管場所がありません');
    if (list.length === 1) $(id).value = list[0].id;
    locHint(id, list.length ? '' : `${code('storage_class', btn.dataset.storage)}の${id === 'rtQLoc' ? '隔離保管場所' : '保管場所'}が登録されていません。「マスタ設定」の「保管場所」で登録してください。`);
  };
  fill('rtQLoc', locs.filter((l) => String(l.is_quarantine) === 'true'));
  fill('rtRLoc', locs.filter((l) => String(l.is_quarantine) !== 'true'));
  const recall = btn.dataset.recall === '1';
  $('rtDisp').value = recall ? 'DISPOSE' : '';
  $('rtDisp').disabled = recall;
  $('rtRLocWrap').hidden = true;
  if (recall) $('rtLineInfo').innerHTML += '・' + nw('回収中のため回収品として登録（処置は廃棄）');
  $('rtForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!quiet) setTimeout(() => $('rtQty').focus({ preventScroll: true }), 300);
}

async function submitReturn(e) {
  e.preventDefault();
  if (!checkRequired($('rtForm'), 'rtMsg')) return;
  const q = Number($('rtQty').value);
  if (!Number.isInteger(q) || q < 1 || (q > Number($('rtQty').max) && !resending('rtForm'))) {
    $('rtQty').setAttribute('aria-invalid', 'true');
    alertBox('rtMsg', `返品数量は 1〜${fmt($('rtQty').max)} の整数で入力してください。`, 'ng', true);
    fieldErr($('rtQty'), `1〜${fmt($('rtQty').max)} の整数で入力してください`);
    $('rtQty').focus();
    return;
  }
  await busy(e.submitter, async () => {
    alertBox('rtMsg', '');
    try {
      const r = await api('registerReturn', { shipmentLineId: S.returnLine, quantity: $('rtQty').value, returnedOn: $('rtDate').value, reason: $('rtReason').value,
        quarantineLocationId: $('rtQLoc').value, disposition: $('rtDisp').value, restockLocationId: $('rtRLoc').value });
      const lot = S.returnLot;
      alertBox('rtFindMsg', `返品を登録しました。返品番号 ${r.returnNo}／処置：${r.disposition === 'RESTOCK' ? '在庫に戻す' : '廃棄'}${r.recall ? '（回収品として計上）' : ''}`, 'ok', true,
        `<button type="button" class="btn btn-secondary btn-sm" data-action="newReturn">別の返品を登録</button>` +
        (lot ? `<button type="button" class="btn btn-secondary btn-sm" data-action="traceLotNo" data-lot="${esc(lot)}">このロットを追跡</button>` : '') +
        (r.recall ? (r.recallId ? `<button type="button" class="btn btn-secondary btn-sm" data-action="openRecall" data-id="${r.recallId}">回収案件を開く</button>` : goBtn('recall', '回収案件を開く')) : ''));
      $('rtReason').value = '';
      writeDraft(S.rtNo, null);
      $('rtForm').hidden = true; S.returnLine = null; $('rtQty').value = ''; // 登録済みの内容はフォームに残さない（二重登録を防ぐ）
      await findShipmentForReturn(null, true, true);
      $('rtFindMsg').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      focusTo($('rtFindMsg').firstElementChild);
    } catch (err) {
      alertBox('rtMsg', err.message, 'ng');
      const avail = (err.message.match(/返品可能数（(\d+)）/) || [])[1];
      if (/取消/.test(err.message) || (avail !== undefined && Number(avail) !== Number($('rtQty').max))) { // 他の利用者の操作で出荷の状態が変わっている
        const saved = captureReturnForm();
        await findShipmentForReturn(null, true, true);
        const kept = restoreReturnForm(saved);
        if (!kept) { // 明細がもう返品できない（出荷の取消など）：入力内容は登録されていないことをはっきり伝える
          writeDraft(S.rtNo, null);
          alertBox('rtFindMsg', err.message + '\n最新の出荷内容を表示しました。入力した返品内容は登録されていません。', 'ng', false,
            '<button type="button" class="btn btn-secondary btn-sm" data-action="newReturn">別の出荷を選ぶ</button>');
          return;
        }
        alertBox('rtFindMsg', err.message + '\n最新の出荷内容を表示しました。', 'ng', true);
        if (!$('rtForm').hidden && avail !== undefined) { // 数量の欄のそばでも知らせる（スマホでは上の表示が見えないため）
          alertBox('rtMsg', `返品可能数が ${avail} に変わりました（他の利用者の返品など）。数量を確認してください。`, 'ng', true);
          fieldErr($('rtQty'), `返品可能数が ${avail} に変わりました`);
          $('rtQty').setAttribute('aria-invalid', 'true'); $('rtQty').focus();
        }
      } else if (/返品数量|返品可能数/.test(err.message)) {
        fieldErr($('rtQty'), err.message.replace(/（BR-\d+）/, '')); $('rtQty').focus();
      } else if (/返品日/.test(err.message)) {
        $('rtDate').setAttribute('aria-invalid', 'true'); $('rtDate').focus();
      }
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

/** 出荷できない理由（短い言葉で） */
function invReason(r) {
  const byStatus = { QUARANTINE: '検品前', HOLD: '保留中', REJECTED: '不合格', RECALLED: '回収中', EXPIRED: '期限切れ', VOID: '無効' };
  if (r.status !== 'RELEASED') return byStatus[r.status] || r.statusLabel;
  if (r.quarantine) return '隔離中';
  return r.reason || '期限が近い';
}

const INV_PRESETS = {
  expiring: { label: '期限90日以内', test: (r) => r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 90 && ['RELEASED', 'HOLD', 'QUARANTINE'].includes(r.status) },
  dispose: { label: '処分待ち（回収・不合格・期限切れ）', test: (r) => ['RECALLED', 'REJECTED', 'EXPIRED'].includes(r.status) || (r.daysLeft !== null && r.daysLeft < 0) },
  low: { label: '発注点以下の商品', test: (r) => (S.lowProducts || []).includes(r.product) },
};

function renderInventory() {
  const q = half($('invFilter').value, false).toUpperCase(); // 名前に「ー」を含むので、ハイフンへの置き換えはしない
  const avail = $('invAvail').checked;
  const preset = INV_PRESETS[S.invPreset];
  const sc = S.invScope;
  const chipLabel = [preset && preset.label, sc && sc.label].filter(Boolean).join('・');
  $('invPreset').innerHTML = chipLabel ? `<span class="preset-chip">絞り込み：${esc(chipLabel)}<button type="button" class="icon-btn" data-action="clearInvPreset" aria-label="絞り込みを解除">${icon('x')}</button></span>` : '';
  // 日本語入力で打った「ー」（例：BSー2409）は、英数字のあいだならハイフンとしても探す（商品名の「ー」はそのまま）
  const terms = q.split(/\s+/).filter(Boolean).map((t) => [...new Set([t, t.replace(/(?<=[A-Z0-9])ー|ー(?=[A-Z0-9])/g, '-')])]);
  // ロット番号を並べた絞り込み（回収案件の対象ロットなど）は「どれか」に一致すればよい
  const lotNos = new Set(S.inventory.map((r) => String(r.lot_no).toUpperCase()));
  const anyLot = terms.length > 1 && terms.every((alts) => alts.some((t) => lotNos.has(t)));
  const hit = (r, alts) => [r.product, r.product_code, r.lot_no, r.supplier_lot_no, r.location].some((v) => alts.some((t) => half(v, false).toUpperCase().includes(t))); // 比べる側も同じ形に（℃ など）
  const inScope = (r) => !sc || ((!sc.lots || sc.lots.includes(r.lot_no)) && (!sc.loc || String(r.location_id) === String(sc.loc)) && (!sc.prod || r.product_code === sc.prod));
  const rows = S.inventory.filter((r) => inScope(r) && (!avail || r.allocatable) && (!preset || preset.test(r)) &&
    (!terms.length || (anyLot ? terms.some((alts) => alts.includes(String(r.lot_no).toUpperCase())) : terms.every((alts) => hit(r, alts)))));
  $('invBody').innerHTML = table([{ label: 'ロット', cls: 'primary' }, { label: '商品', cls: 'wide' }, '仕入先ロット', { label: '保管場所', cls: 'wide' }, { label: '使用期限', cls: 'nowrap' },
    { label: '残日数', cls: 'num' }, { label: '状態', cls: 'status' }, { label: '数量', cls: 'num' }, { label: '', cls: 'actions' }],
    rows.map((r) => ({ attrs: ` class="clickable${ALERT_STATUS.has(r.status) ? ' is-alert' : ''}" data-action="traceLotNo" data-lot="${esc(r.lot_no)}" tabindex="0" aria-label="${esc(r.lot_no)} を追跡"`,
      cells: [html(mono(r.lot_no)), r.product, html(mono(r.supplier_lot_no)),
      html(esc(r.location) + (r.quarantine ? ' ' + badge('warn', '隔離') : '')), r.expires_on, days(r.daysLeft),
      html(`<span class="badges">${badge(r.status, r.statusLabel)}${r.allocatable ? badge('ok', '出荷できる') : badge('', '出荷不可・' + invReason(r))}</span>`), num(r.qty),
      html(`<button type="button" class="btn btn-secondary btn-sm" data-action="openDispose" data-lot-id="${r.lot_id}" data-loc-id="${r.location_id}" data-lot="${esc(r.lot_no)}" data-loc="${esc(r.location)}" data-qty="${r.qty}" data-status="${esc(r.status)}" data-ok="${r.allocatable ? 1 : ''}" aria-label="${esc(r.lot_no)}（${esc(r.location)}）を処分">処分</button>`)] })),
    { empty: S.inventory.length || preset || sc || terms.length ? 'この条件に一致する在庫はありません' : '在庫はありません' });
  if (!rows.length && (preset || sc || terms.length || avail)) {
    $('invBody').insertAdjacentHTML('beforeend', '<div class="empty-actions"><button type="button" class="btn btn-secondary btn-sm" data-action="clearInvAll">絞り込みを解除</button></div>');
  } else if (!S.inventory.length) { // まだ在庫が無い：入荷から始める
    $('invBody').insertAdjacentHTML('beforeend', `<p class="note center">入荷を登録して検品で合格にすると、ここに在庫が表示されます。</p><div class="empty-actions">${goBtn('receipt', '入荷を登録する')}</div>`);
  }
}

/** 在庫の処分（廃棄・仕入先返品）ダイアログ */
/** 処分ダイアログの在庫数まわりの表示（説明・上限・全数ボタン）をまとめて更新する */
function setDisposeStock(qty, latest) {
  const f = $('disposeForm'), n = Number(qty);
  $('disposeInfo').textContent = n <= 0 ? `ロット ${f.dataset.lot}（${f.dataset.loc}）の在庫はもうありません。`
    : `ロット ${f.dataset.lot}（${f.dataset.loc}）の在庫 ${fmt(n)}${latest ? '（最新）' : ''} から、処分した数量を記録します。記録すると在庫から差し引かれ、元に戻せません。`;
  $('dpQty').max = n;
  $('dpQtyHint').textContent = `最大 ${fmt(n)}${latest ? '（最新）' : ''}`;
  $('dpAll').textContent = `全数（${fmt(n)}）`;
  $('dpAll').dataset.qty = n;
  // 在庫が無ければ記録できないので、操作できるのは「閉じる」だけにする
  const none = n <= 0;
  $('dpAll').disabled = none;
  f.querySelector('button[value="ok"]').disabled = none;
  f.querySelector('button[value="ok"]').dataset.locked = none ? '1' : ''; // 処理後に busy() が押せる状態に戻さないように
  ['dpKind', 'dpQty', 'dpReason'].forEach((id) => { $(id).disabled = none; });
  f.querySelector('[data-action="dialogCancel"]').textContent = none ? '閉じる' : 'キャンセル';
  if (none) $('dpQty').value = '';
}

async function openDispose(btn) {
  if (btn.dataset.ok && !(await ask({ title: '出荷できる在庫を処分しますか？', body: `ロット ${btn.dataset.lot} は合格済みで出荷できる在庫です。破損などで処分する場合だけ続けてください。`, okText: '処分の記録へ進む', danger: true }))) return;
  const f = $('disposeForm');
  f.dataset.dirty = '';
  // 別の在庫の処分は別の依頼。前回が「登録できたか分からない」まま同じ在庫を開き直したときは、同じ依頼として送る（二重に記録しない）
  const key = btn.dataset.lotId + ':' + btn.dataset.locId;
  const keep = resending('disposeForm') && f.dataset.key === key; // 入力した内容もそのまま戻す（同じ依頼として送れるように）
  if (!keep) resetRequest('disposeForm');
  f.dataset.key = key;
  f.dataset.status = btn.dataset.status;
  if (!keep) f.reset();
  f.dataset.lotId = btn.dataset.lotId;
  f.dataset.locId = btn.dataset.locId;
  f.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  alertBox('dpMsg', '');
  f.dataset.lot = btn.dataset.lot;
  f.dataset.loc = btn.dataset.loc;
  setDisposeStock(btn.dataset.qty, false);
  // 回収・不合格・期限切れは全数を処分することが多いので、最初から全数を入れておく
  if (!btn.dataset.ok && !keep) $('dpQty').value = btn.dataset.qty;
  if (keep) alertBox('dpMsg', '前回の記録が届いたか確認できなかったため、同じ内容を表示しています。そのまま「処分を記録する」を押してください（二重に記録されることはありません）。', 'warn', true);
  G_STATE.disposeOpener = btn;
  $('disposeDialog').showModal();
  $('dpKind').focus();
}

/** 記録できたか分からないまま処分ダイアログを閉じた：在庫の数量を見比べて、記録できていたかを伝える */
/** 確かめられなかった保存・処分を確かめ直す（通信が戻った・画面に戻ってきたとき。ダイアログが閉じている場合だけ） */
function recheckUnsure() {
  if (!S.sess) return;
  if (S.unsure.masterForm && !S.checked.masterForm && S.masterSent && !$('masterDialog').open) checkUnsureMaster();
  if (S.unsure.disposeForm && !S.checked.disposeForm && !$('disposeDialog').open && $('disposeForm').dataset.stockAtSend) checkUnsureDispose();
}

async function checkUnsureDispose() {
  const f = $('disposeForm');
  const say = (text, kind) => { if ($('page-inventory').hidden) toast(text, kind); else alertBox('invMsg', text, kind); };
  if (!(await loadInventory().then(() => true, () => false))) {
    say(`通信できないため、ロット ${f.dataset.lot} の処分が記録されたか確認できませんでした。通信が戻ったら自動で確認します。`, 'warn');
    return;
  }
  const row = (S.inventory || []).find((r) => String(r.lot_id) === f.dataset.lotId && String(r.location_id) === f.dataset.locId);
  const before = Number(f.dataset.stockAtSend), after = row ? Number(row.qty) : 0, sent = Number(f.dataset.sentQty || 1);
  if (after <= before - sent) {
    resetRequest('disposeForm');
    say(`ロット ${f.dataset.lot} の処分は記録されていました（在庫 ${fmt(before)} → ${fmt(after)}）。`, 'ok');
  } else {
    S.checked.disposeForm = true;
    say(`ロット ${f.dataset.lot} の処分は記録されていません（在庫 ${fmt(after)}）。もう一度「処分」から記録してください（同じ内容で開きます）。`, 'warn');
  }
}

async function submitDispose(e) {
  if (!e.submitter || e.submitter.value !== 'ok') return;
  e.preventDefault();
  const f = $('disposeForm');
  if (!checkRequired(f, 'dpMsg')) return;
  if ((Number($('dpQty').value) > Number($('dpQty').max) && !resending('disposeForm')) || Number($('dpQty').value) < 1 || !Number.isInteger(Number($('dpQty').value))) {
    $('dpQty').setAttribute('aria-invalid', 'true');
    alertBox('dpMsg', `数量は 1〜${fmt($('dpQty').max)} の整数で入力してください。`, 'ng', true);
    $('dpQty').focus();
    return;
  }
  await busy(e.submitter, async () => {
    try {
      f.dataset.stockAtSend = $('dpQty').max; // 記録できたか分からなくなったとき、在庫の増減で確かめるため
      f.dataset.sentQty = $('dpQty').value;
      const r = await api('disposeStock', { lotId: f.dataset.lotId, locationId: f.dataset.locId, quantity: $('dpQty').value, kind: $('dpKind').value, reason: $('dpReason').value });
      $('disposeDialog').close();
      await loadInventory();
      alertBox('invMsg', `ロット ${r.lotNo} の ${fmt(r.quantity)} を${r.kind === 'DISPOSE' ? '廃棄' : '仕入先返品'}として記録しました。`, 'ok', false,
        f.dataset.status === 'RECALLED' ? (S.invScope && S.invScope.recall ? `<button type="button" class="btn btn-secondary btn-sm" data-action="openRecall" data-id="${S.invScope.recall}">回収管理へ戻る</button>` : goBtn('recall', '回収管理へ戻る')) : '');
    } catch (err) {
      const left = (err.message.match(/在庫（(\d+)）/) || [])[1];
      if (left !== undefined) { // 他の利用者が先に処分した等で在庫が変わっている
        setDisposeStock(left, true);
        loadInventory().catch(() => {});
        if (Number(left) === 0) {
          f.dataset.dirty = '';
          alertBox('dpMsg', '他の利用者の出荷・処分などで、このロットの在庫が 0 になりました。処分する在庫はありません。「閉じる」で戻ってください。', 'warn');
          f.querySelector('[data-action="dialogCancel"]').focus();
          return;
        }
        $('dpQty').setAttribute('aria-invalid', 'true'); // 入力した数量はそのまま残し、最新の上限（ヒント）と見比べて直せるようにする
        $('dpQty').focus();
        alertBox('dpMsg', `他の利用者の出荷・処分などで、在庫が ${fmt(left)} に減っています。数量を確認してください。`, 'ng', true);
        return;
      }
      alertBox('dpMsg', err.message, 'ng');
    }
  });
}

// ======================================================================
// ロット追跡
// ======================================================================
const MOVE_LABEL = { RECEIPT: '入荷', SHIPMENT: '出荷', CANCEL: '出荷取消', RETURN: '返品受入', TRANSFER_IN: '移動入', TRANSFER_OUT: '移動出', DISPOSE: '廃棄', ADJUST: '調整', SUPPLIER_RETURN: '仕入先返品' };

async function searchLot(e, fromUrl) {
  e.preventDefault();
  $('tlQuery').value = half($('tlQuery').value).toUpperCase();
  if (!$('tlQuery').value.trim()) {
    $('tlQuery').setAttribute('aria-invalid', 'true');
    $('tlBody').innerHTML = '<div class="alert alert-ng" role="alert">ロット番号を入力するか、上の「最近のロット」から選んでください。</div>';
    if (S.page === 'traceLot') setUrl('#/traceLot', false); // 再読み込みで前の検索が開かないように
    if (!$('tlRecent').innerHTML) renderTraceChips().catch(() => {});
    $('tlQuery').focus();
    return;
  }
  await busy(e.submitter, async () => {
    try {
      const asked = $('tlQuery').value;
      const lots = await api('traceLot', asked);
      if ($('tlQuery').value !== asked) return; // 待っている間に別の番号で検索された（古い結果で上書きしない）
      // 再読み込みしても同じ検索を出せるように URL に残す。利用者が検索したときは履歴を積む（「戻る」で前の表示へ）
      // 待っている間に別の画面へ移っていたら、URL は変えない
      if (S.page === 'traceLot') setUrl('#/traceLot?q=' + encodeURIComponent($('tlQuery').value.trim()), !fromUrl);
      const fold = lots.length > 1; // 複数見つかったときは、見出しだけを並べて開いて見る
      if (lots.length) $('tlRecent').innerHTML = ''; else if (!$('tlRecent').innerHTML) renderTraceChips().catch(() => {}); // 見つからなかったときは「最近のロット」を出す
      $('tlBody').innerHTML = (lots.length ? `<p class="as-of">${esc(nowText())} 時点<button type="button" class="btn btn-ghost btn-sm" data-action="retrace">${icon('refresh')}最新にする</button></p><p class="result-count" role="status">${lots.length}件見つかりました${lots.length >= 20 ? '（先頭20件。番号をもう少し詳しく入れると絞り込めます）' : ''}</p>` : '') + (lots.length ? lots.map((l) => {
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
          <div class="chips">${Object.keys(l.movementTotals).filter((k) => !k.startsWith('TRANSFER_')).map((k) => `<span class="chip">${esc(MOVE_LABEL[k] || k)} ${fmt(Math.abs(l.movementTotals[k]))}</span>`).join('')}</div>
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
      }).join('') : `<div class="card">${empty('該当するロットはありません', 'search')}<p class="note center">社内ロット番号・仕入先ロット番号（またはその一部）で探してください。商品名からは「在庫照会」で探せます。</p></div>`);
      focusTo($('tlBody').querySelector('.result-count') || $('tlBody').firstElementChild);
    } catch (err) {
      $('tlBody').innerHTML = `<div class="alert alert-ng" role="alert">${esc(err.message)}</div>`;
    }
  });
}

// ======================================================================
// 顧客追跡
// ======================================================================
/** 現在時刻（日本時間・ステータス履歴と同じ YYYY-MM-DD HH:MM 形式） */
const nowText = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());

/** 顧客追跡：表示中の結果があれば、開き直したときに最新の状態で出し直す */
async function loadCustomerTrace() {
  if (!S.M.customers.length) { // 顧客が未登録なら、空の選択欄だけにせず登録先を案内する
    $('tcBody').innerHTML = '';
    alertBox('tcMsg', '顧客追跡を使うには、先に顧客を「マスタ設定」で登録してください。', 'info', true,
      '<button type="button" class="btn btn-secondary btn-sm" data-action="goMaster" data-table="m_customer">顧客を登録する</button>');
    return;
  }
  // URL のとおりに表示する（「戻る」・再読み込み）。表示中でも最新の状態で出し直す
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  $('tcCustomer').value = qs.get('c') || ''; $('tcFrom').value = qs.get('from') || ''; $('tcTo').value = qs.get('to') || '';
  alertBox('tcMsg', '');
  if ($('tcCustomer').value) await searchCustomer({ preventDefault() {}, submitter: null }, true);
  else {
    $('tcBody').innerHTML = '';
    if (qs.get('c')) { alertBox('tcMsg', '指定の顧客が見つかりません。一覧から選んでください。', 'ng', true); setUrl('#/traceCustomer', false); }
  }
}

async function searchCustomer(e, fromUrl) {
  e.preventDefault();
  alertBox('tcMsg', '');
  ['tcFrom', 'tcTo'].forEach((id) => $(id).removeAttribute('aria-invalid'));
  if (!checkRequired($('tcSearch'), 'tcMsg')) return;
  if ($('tcFrom').value && $('tcTo').value && $('tcFrom').value > $('tcTo').value) {
    $('tcTo').setAttribute('aria-invalid', 'true');
    alertBox('tcMsg', '出荷日の「まで」は「から」以降の日付にしてください。', 'ng', true);
    $('tcTo').focus();
    return;
  }
  await busy(e.submitter, async () => {
    try {
      const key = () => [$('tcCustomer').value, $('tcFrom').value, $('tcTo').value].join('|'), asked = key();
      const r = await api('traceCustomer', $('tcCustomer').value, $('tcFrom').value, $('tcTo').value);
      if (key() !== asked) return; // 待っている間に条件が変わった（古い結果で上書きしない）
      const c = r.customer;
      const total = r.rows.reduce((s, x) => s + x.net, 0);
      const ranged = $('tcFrom').value || $('tcTo').value; // 期間を指定したときは、その期間の出荷分だけの集計であることを示す
      $('tcBody').innerHTML = `<div class="card"><div class="card-head"><div><h2 class="card-title">${esc(c.name)}</h2>
          <p class="card-sub">${joinNw([c.customer_code, code('customer_type', c.customer_type), c.address])}</p>
          <div class="card-sub contacts">${[telLink(c.phone), mailLink(c.email)].filter(Boolean).map((v) => `<span class="contact">${v}</span>`).join('')}</div></div>
          <span class="badge b-neutral">${ranged ? '期間内の出荷分 手元' : '手元'} ${fmt(total)}</span></div>
        <p class="as-of">${esc(nowText())} 時点<button type="button" class="btn btn-ghost btn-sm" data-action="retraceCustomer">${icon('refresh')}最新にする</button></p>
        ${table([{ label: 'ロット', cls: 'primary' }, { label: '商品', cls: 'wide' }, { label: '出荷日', cls: 'nowrap' }, '出荷番号', { label: '使用期限', cls: 'nowrap' },
          { label: 'ロット状態', cls: 'status' }, { label: '出荷', cls: 'num' }, { label: '返品', cls: 'num' }, { label: '手元', cls: 'num' }],
          r.rows.map((x) => ({ attrs: ` class="clickable${ALERT_STATUS.has(x.lot_status) ? ' is-alert' : ''}" data-action="traceLotNo" data-lot="${esc(x.lot_no)}" tabindex="0" aria-label="${esc(x.lot_no)} を追跡"`, cells: [html(mono(x.lot_no)), x.product, x.shipped_on, html(mono(x.shipment_no)),
            x.expires_on, html(badge(x.lot_status, x.lot_status_label)), num(x.quantity), num(x.returned), num(x.net)] })),
          { empty: ranged ? 'この期間の出荷実績はありません' : '出荷実績はありません', emptyIcon: 'truck' })}</div>`;
      if (S.page === 'traceCustomer') {
        const qs = new URLSearchParams({ c: $('tcCustomer').value }); // 再読み込みしても同じ検索を出せるように
        if ($('tcFrom').value) qs.set('from', $('tcFrom').value);
        if ($('tcTo').value) qs.set('to', $('tcTo').value);
        setUrl('#/traceCustomer?' + qs, !fromUrl);
        $('tcBody').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        focusTo($('tcBody').querySelector('.card-title'));
      }
    } catch (err) {
      $('tcBody').innerHTML = `<div class="alert alert-ng" role="alert">${esc(err.message)}</div>`;
    }
  });
}

// ======================================================================
// 回収
// ======================================================================
const RECALL_STATUS = { OPEN: '登録', IN_PROGRESS: '対応中', CLOSED: '完了' };

async function loadRecalls(exceptId) {
  alertBox('rclMsg', '', null, true);
  const snap = snapshotTargetForms(exceptId); // 入力中の「進捗を更新」は描き直しても残す
  const [lots, recalls0] = await Promise.all([api('getLots', ['QUARANTINE', 'RELEASED', 'HOLD', 'REJECTED', 'EXPIRED']), api('listRecalls')]);
  const recalls = [...recalls0].sort((a, b) => (a.status === 'CLOSED') - (b.status === 'CLOSED')); // 対応中の案件を先に
  const checked = new Set([...$('rcLots').querySelectorAll('input:checked')].map((i) => i.value)); // 選択中のロットは描き直しても残す
  $('rcLots').innerHTML = lots.length ? lots.map((l) => `<label class="check"><input type="checkbox" value="${l.id}" data-key="${esc(l.product_id + ':' + l.supplier + ':' + String(l.supplier_lot_no).toUpperCase())}"${checked.has(String(l.id)) ? ' checked' : ''}><span><b class="mono">${esc(l.lot_no)}</b>
      <small>${joinNw([l.product, '仕入先ロット ' + l.supplier_lot_no, l.statusLabel, '期限 ' + l.expires_on])}</small></span></label>`).join('') : '<p class="note">対象にできるロットがありません。</p>';
  $('rclList').innerHTML = recalls.length ? recalls.map(renderRecall).join('') : `<div class="card">${empty('回収案件はありません', 'check')}</div>`;
  $('rclList').querySelectorAll('.meter i').forEach((i) => { i.style.width = Math.min(100, Number(i.dataset.w) || 0) + '%'; });
  restoreTargetForms(snap);
  if (S.recallJump) { // ダッシュボードの「開く」から来た：その案件へ
    const a = $('rclList').querySelector(`article[data-id="${CSS.escape(String(S.recallJump))}"]`);
    S.recallJump = null;
    if (a) { a.scrollIntoView({ block: 'start' }); focusTo(a); }
  }
}

function recallTotals(r) {
  const act = r.targets.filter((t) => Number(t.shipped_qty) > 0);
  r.activeTargets = act.length;
  r.shippedQty = act.reduce((a, t) => a + Number(t.shipped_qty), 0);
  r.recQty = act.reduce((a, t) => a + Math.min(Number(t.shipped_qty), Number(t.recovered_qty)), 0);
  r.unrecQty = act.reduce((a, t) => a + Number(t.unrecoverable_qty), 0);
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
    const form = ed && t.status !== 'RECOVERED' && t.status !== 'CLOSED' ? `<details class="target-edit"${open ? ' open' : ''}><summary>進捗を更新</summary><div class="target-grid">
        <div class="field f-date"><label for="cd_${t.id}">連絡日</label><input type="date" id="cd_${t.id}" value="${esc(t.contacted_on)}" data-orig="${esc(t.contacted_on)}" min="${esc(r.started_on)}" max="${esc(S.cfg.today)}"></div>
        <div class="field"><label for="cm_${t.id}">連絡方法</label><select id="cm_${t.id}" data-orig="${esc(t.contact_method)}">${['', '電話', 'メール', '訪問'].map((m) => `<option value="${m}"${m === t.contact_method ? ' selected' : ''}>${m || '未選択'}</option>`).join('')}</select></div>
        <div class="field"><label for="un_${t.id}">回収不能数</label><input type="number" inputmode="numeric" min="0" id="un_${t.id}" value="${esc(t.unrecoverable_qty)}" data-orig="${esc(t.unrecoverable_qty)}"></div>
        ${editable ? `<div class="field f-status"><label for="st_${t.id}">状態</label><select id="st_${t.id}" data-orig=""><option value="">変更しない</option>${t.status === 'CONTACTED' ? '' : '<option value="CONTACTED">連絡済にする</option>'}<option value="CLOSED">クローズする</option></select></div>` : ''}
        <div class="field span-reason"><label for="cr_${t.id}">クローズ理由 <span class="opt">クローズ時必須</span></label><input id="cr_${t.id}" value="${esc(t.close_reason)}" data-orig="${esc(t.close_reason)}" autocomplete="off" maxlength="500" aria-describedby="cre_${t.id}"><div class="field-err" id="cre_${t.id}" role="alert"></div></div>
        <button type="button" class="btn btn-secondary span-save" data-action="saveTarget" data-id="${t.id}" data-ver="${esc(t.updated_at)}">保存</button>
      </div></details>` : (t.close_reason ? `<p class="note">クローズ理由：${esc(t.close_reason)}</p>` : '');
    const contacts = [t.contact_name ? esc(t.contact_name) : '', telLink(t.phone), mailLink(t.email)].filter(Boolean);
    return `<div class="target" id="tg_${t.id}"><div class="target-head"><div><div class="t">${esc(t.customer)}</div>
        <div class="s contacts">${contacts.length ? contacts.map((c) => `<span class="contact">${c}</span>`).join('') : '連絡先未登録'}</div></div>${badge(t.status, t.status === 'RECOVERED' && Number(t.unrecoverable_qty) > 0 ? (Number(t.recovered_qty) > 0 ? '対応済（一部回収不能）' : '対応済（回収不能）') : t.statusLabel)}</div>
      <div class="target-nums"><span class="nowrap">ロット <b class="mono">${esc(t.lot_no)}</b></span><span title="出荷数から通常の返品を引いた数">出荷（返品後） <b>${fmt(t.shipped_qty)}</b></span><span>回収 <b>${fmt(t.recovered_qty)}</b></span>${Number(t.unrecoverable_qty) ? `<span>回収不能 <b>${fmt(t.unrecoverable_qty)}</b></span>` : ''}<span>手元 <b>${fmt(Math.max(0, t.shipped_qty - t.recovered_qty - t.unrecoverable_qty))}</b></span>${t.contacted_on ? `<span>連絡 <b>${esc(t.contacted_on)}${t.contact_method ? '・' + esc(t.contact_method) : ''}</b></span>` : ''}</div>
      ${form}</div>`;
  }).join('') : empty('対象顧客はいません（出荷実績なし）', 'check');
  const rate = (v) => (r.activeTargets ? v + '%' : '—');
  return `<article class="card" data-id="${r.id}"><div class="card-head"><div><span class="eyebrow">${esc(r.recall_no)}</span><h2 class="card-title">${esc(r.title)}</h2>
      <p class="card-sub">${joinNw(['クラス' + r.severity, '開始 ' + r.started_on, r.closed_on ? '完了 ' + r.closed_on : ''])}<br>対象ロット <span class="lot-list">${r.lots.map(nw).join('、')}</span></p></div>
      ${badge(r.status, RECALL_STATUS[r.status] || r.status)}</div>
    <p class="note">${esc(r.reason)}</p>
    <div class="stat-row three"><div class="stat"><b>${rate(r.contactedRate)}</b><span>連絡済率</span></div><div class="stat${r.activeTargets && r.recQty >= r.shippedQty ? ' hl' : ''}"><b>${rate(r.recoveredRate)}</b><span>回収率</span></div>
      <div class="stat"><b>${fmt(r.remainingStock)}</b><span>残在庫</span></div></div>
    ${r.activeTargets ? `<div class="meter-row"><div class="meter"><i data-w="${r.recoveredRate}"></i></div><span>回収 ${fmt(r.recQty)} / ${fmt(r.shippedQty)}${r.unrecQty ? `（回収不能 ${fmt(r.unrecQty)}）` : ''}</span></div>` : ''}
    ${r.remainingStock > 0 ? `<div class="alert alert-warn" role="status"><div class="alert-text">回収対象ロットの在庫 ${fmt(r.remainingStock)} がまだ処分されていません${ed ? '（回収を完了する前に、廃棄・仕入先返品を記録してください）' : ''}。<div class="alert-actions"><button type="button" class="btn btn-secondary btn-sm" data-action="goInv" data-preset="lots" data-lots="${esc(r.lots.join(','))}" data-recall="${r.id}" data-label="${esc('回収 ' + r.recall_no + ' の対象ロット')}">在庫照会で処分する</button></div></div></div>` : ''}
    <h3 class="section-title">対象顧客</h3>${targets}
    ${ed ? `<p class="note">回収品の受入は「返品登録」で行うと回収数に自動で反映されます。</p>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-action="reextract" data-id="${r.id}">${icon('refresh')}対象を再抽出</button>
      <button type="button" class="btn ${r.openTargets || r.remainingStock > 0 ? 'btn-secondary' : 'btn-primary'}" data-action="closeRecall" data-id="${r.id}" data-targets="${r.targets.length}" data-open="${r.openTargets}" data-left="${r.shippedQty - r.doneQty}" data-uncontacted="${r.uncontacted}" data-stock="${r.remainingStock}">回収を完了</button></div>` : ''}</article>`;
}

async function submitRecall(e) {
  e.preventDefault();
  const lotIds = [...$('rcLots').querySelectorAll('input:checked')].map((i) => i.value);
  alertBox('rclFormMsg', '');
  if (!checkRequired($('recallForm'), 'rclFormMsg')) return;
  if (!lotIds.length) {
    alertBox('rclFormMsg', '対象ロットを1件以上選択してください。', 'ng', true);
    const c = $('rcLots').querySelector('input'); if (c) c.focus(); // すぐ選べるように、最初のロットへ
    return;
  }
  // 同じ仕入先ロットの別の社内ロット（分納分）は、サーバーが自動で回収対象に含める。そのことを先に伝える
  const keys = new Set([...$('rcLots').querySelectorAll('input:checked')].map((i) => i.dataset.key));
  const sibs = [...$('rcLots').querySelectorAll('input:not(:checked)')].filter((i) => keys.has(i.dataset.key)).map((i) => i.closest('label').querySelector('b').textContent);
  if (!(await ask({ title: '回収を開始しますか？', body: `選択した ${lotIds.length} ロット（${[...$('rcLots').querySelectorAll('input:checked')].map((i) => i.closest('label').querySelector('b').textContent).join('、')}）を回収対象にし、出荷を停止します。` +
    (sibs.length ? `\n\n同じ仕入先ロットの分納分（${sibs.join('、')}）も回収対象に含めます。` : ''), okText: '回収を開始', danger: true }))) return;
  await busy(e.submitter, async () => {
    try {
      const r = await api('createRecall', { title: $('rcTitle').value, reason: $('rcReason').value, severity: $('rcSev').value, lotIds });
      const nTargets = r.targets.filter((t) => Number(t.shipped_qty) > 0).length;
      const added = (r.lots || []).length - lotIds.length; // 同じ仕入先ロットの分納分（サーバーが自動で含めた）
      const createdMsg = (nTargets ? `回収案件 ${r.recall_no} を登録しました（対象顧客 ${nTargets} 件）。対象顧客に連絡し、進捗を記録してください。`
        : `回収案件 ${r.recall_no} を登録しました。出荷先の顧客はいません（対象顧客 0 件）。社内の在庫を処分してから、回収を完了してください。`)
        + (added > 0 ? `\n同じ仕入先ロットの分納分 ${added} ロットも対象に含めました。` : '');
      $('recallForm').reset();
      $('rcNew').open = false;
      await loadRecalls();
      alertBox('rclMsg', createdMsg, 'ok', true);
      focusTo($('rclList').firstElementChild);
    } catch (err) {
      alertBox('rclFormMsg', err.message, 'ng');
    }
  });
}

/** 回収対象の「進捗を更新」で入力中の内容（未保存）を控える／戻す。一覧を描き直しても消えないように */
function snapshotTargetForms(exceptId) {
  const snap = [];
  $('rclList').querySelectorAll('.target-edit').forEach((d) => {
    // 描画したときの値（data-orig）と比べて、変更された欄だけを控える
    const fields = [...d.querySelectorAll('input, select')].filter((el) => !el.id.endsWith('_' + exceptId))
      .filter((el) => el.value !== (el.dataset.orig || '')).map((el) => [el.id, el.value]);
    const save = d.querySelector('[data-action="saveTarget"]');
    // 入力を始めたときの版（ver）も控える：描き直しで新しい版に置き換わると、他の人の更新を上書きできてしまうため
    if (fields.length || (d.open && !d.querySelector('[id$="_' + exceptId + '"]'))) snap.push({ id: save.dataset.id, open: d.open, fields, ver: save.dataset.ver });
  });
  return snap;
}
function restoreTargetForms(snap) {
  snap.forEach((t) => {
    const btn = $('rclList').querySelector(`[data-action="saveTarget"][data-id="${t.id}"]`);
    if (!btn) return;
    btn.closest('details').open = t.open || t.fields.length > 0;
    t.fields.forEach(([id, v]) => { if ($(id)) $(id).value = v; });
    if (t.fields.length) btn.dataset.ver = t.ver;
  });
}

async function saveTarget(btn) {
  const id = btn.dataset.id;
  const st = $('st_' + id);
  $('cre_' + id).textContent = '';
  const cd = $('cd_' + id);
  if (cd.value && ((cd.min && cd.value < cd.min) || (cd.max && cd.value > cd.max))) {
    cd.setAttribute('aria-invalid', 'true');
    $('cre_' + id).textContent = `連絡日は ${cd.min} 〜 ${cd.max} の日付を入力してください。`;
    cd.focus();
    return;
  }
  // 連絡済にするなら連絡日が要る（後で返品日などで埋めると、実際と違う記録になるため）
  if (!cd.value && ((st && st.value === 'CONTACTED' && !cd.dataset.orig) || (cd.dataset.orig && !(st && st.value === 'CLOSED')))) {
    cd.setAttribute('aria-invalid', 'true');
    $('cre_' + id).textContent = cd.dataset.orig ? '連絡済の顧客の連絡日は消せません。日付を直す場合は、正しい連絡日を入力してください。' : '連絡済にするときは、連絡日を入力してください。';
    cd.focus();
    return;
  }
  if (st && st.value === 'CLOSED' && !$('cr_' + id).value.trim()) {
    $('cr_' + id).setAttribute('aria-invalid', 'true');
    $('cre_' + id).textContent = 'クローズするときは、理由を入力してください。';
    $('cr_' + id).focus();
    return;
  }
  await busy(btn, async () => {
    try {
      await api('updateRecallTarget', { targetId: id, contactedOn: $('cd_' + id).value, contactMethod: $('cm_' + id).value,
        unrecoverableQty: $('un_' + id).value, status: st ? st.value : '', closeReason: $('cr_' + id).value, expectedUpdatedAt: btn.dataset.ver });
      const who = $('tg_' + id) ? $('tg_' + id).querySelector('.t').textContent : '';
      $('toasts').innerHTML = '';
      toast(who ? `「${who}」の進捗を保存しました` : '保存しました');
      await loadRecalls(id);
      focusTo($('tg_' + id));
    } catch (err) {
      let msg = userText(err.message);
      if (/他の利用者/.test(err.message)) {
        // この顧客は最新の版で描き直し、入力した値だけを戻す（次の保存で上書きできる）。最新の内容も並べて見せる
        const mine = [...btn.closest('.target-edit').querySelectorAll('input, select')].filter((el) => el.value !== (el.dataset.orig || '')).map((el) => [el.id, el.value]);
        const who0 = $('tg_' + id) ? $('tg_' + id).querySelector('.t').textContent : '';
        await loadRecalls(id);
        if (!$('cre_' + id)) { // 他の利用者の返品・クローズで、この顧客はもう更新できない状態になった
          const labels = { cd_: '連絡日', cm_: '連絡方法', un_: '回収不能数', cr_: 'クローズ理由', st_: '状態' };
          const typed = mine.filter(([fid, v]) => v && labels[fid.replace(/\d+$/, '')]).map(([fid, v]) => `${labels[fid.replace(/\d+$/, '')]}：${v}`).join('・');
          const badge = $('tg_' + id) && $('tg_' + id).querySelector('.badge');
          alertBox('rclMsg', `「${who0}」は、他の利用者の操作（返品登録・クローズなど）で「${badge ? badge.textContent : '更新できない状態'}」になったため、入力した内容は保存されていません。` + (typed ? `\n入力していた内容：${typed}` : ''), 'ng', true);
          focusTo($('tg_' + id) || $('rclMsg'));
          return;
        }
        const latest = [['cd_', '連絡日'], ['cm_', '連絡方法'], ['un_', '回収不能数'], ['cr_', 'クローズ理由']]
          .map(([p, label]) => ($(p + id) ? `${label}：${$(p + id).dataset.orig || '（なし）'}` : '')).filter(Boolean).join('・');
        const d = $('cd_' + id) && $('cd_' + id).closest('details'); if (d) d.open = true;
        mine.forEach(([fid, v]) => { if ($(fid)) $(fid).value = v; });
        msg += `\n最新の内容 … ${latest}`;
      }
      if (!$('cre_' + id)) { alertBox('rclMsg', msg, 'ng'); return; }
      $('cre_' + id).textContent = msg;
      // 原因の欄に印を付けて移動する
      const field = /連絡日/.test(err.message) ? 'cd_' : /回収不能/.test(err.message) ? 'un_' : /クローズ理由/.test(err.message) ? 'cr_' : '';
      if (field && $(field + id)) { $(field + id).setAttribute('aria-invalid', 'true'); $(field + id).focus(); } else focusTo($('cre_' + id));
    }
  });
}

/** 回収案件の操作が失敗したとき（他の利用者が先に完了した等）：最新の状態に描き直して、その案件へ */
async function recallFailed(err, id) {
  if (!S.sess) return; // ログアウトした（期限切れ）：ログイン画面が説明している
  const fresh = await loadRecalls().then(() => true, () => false);
  const card = $('rclList').querySelector(`article[data-id="${CSS.escape(String(id))}"]`);
  if (err.unsure && fresh && card && !card.querySelector('[data-action="closeRecall"]') && /完了/.test(card.textContent)) toast('回収案件の完了は記録されていました');
  else toast(err.message + (fresh ? '（最新の状態を表示しました）' : ''), 'ng');
  focusTo($('rclList').querySelector(`article[data-id="${CSS.escape(String(id))}"]`) || $('rclList'));
}

async function reextract(btn) {
  await busy(btn, async () => {
    try {
      const id = btn.dataset.id;
      await api('reextractRecall', id); toast('対象顧客を再抽出しました'); await loadRecalls();
      focusTo($('rclList').querySelector(`[data-action="reextract"][data-id="${CSS.escape(id)}"]`) || $('rclList')); // 描き直したボタンへ
    } catch (err) { await recallFailed(err, btn.dataset.id); }
  });
}

async function closeRecall(btn) {
  const open = Number(btn.dataset.open || 0);
  const body = open ? `未完了の対象顧客が ${open} 件（未回収 ${btn.dataset.left}・未連絡 ${btn.dataset.uncontacted} 件）残っているため、まだ完了できません。\n\n各顧客について、回収品を「返品登録」で受け入れる（自動で「回収済」になります）か、回収できない場合は「進捗を更新」で回収不能数を入れるかクローズしてください。`
    : (Number(btn.dataset.stock) > 0 ? `回収対象ロットの在庫 ${fmt(btn.dataset.stock)} が、まだ処分されていません（在庫照会で確認できます）。在庫照会の「処分」から廃棄・仕入先返品を記録してから完了することをおすすめします。\n\n` : '') +
      (Number(btn.dataset.targets) > 0 ? '完了後は対象顧客の進捗を変更できません。' : '出荷実績のある顧客はいません。完了すると、この回収案件は終了します。');
  if (open) { await ask({ title: '回収はまだ完了できません', body, okText: 'わかりました', noCancel: true }); return; }
  if (!(await ask({ title: Number(btn.dataset.stock) > 0 ? '未処分の在庫がありますが、完了しますか？' : '回収を完了しますか？', body, okText: '完了にする', danger: true }))) return;
  await busy(btn, async () => {
    try {
      const r = await api('closeRecall', btn.dataset.id);
      $('toasts').innerHTML = '';
      toast('回収案件 ' + r.recall_no + ' を完了しました');
      await loadRecalls();
      focusTo($('rclList').querySelector(`article[data-id="${CSS.escape(btn.dataset.id)}"]`) || $('rclList').firstElementChild); // 完了した案件へ
    } catch (err) { await recallFailed(err, btn.dataset.id); }
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
// 一覧の列（先頭＝カードの見出し。名前で探すことが多いので名称を先頭にする）
const LIST_COLS = { m_product: ['name', 'product_code', 'storage_class', 'regulatory_class', 'list_price', 'is_active'],
  m_customer: ['name', 'customer_code', 'customer_type', 'contact_name', 'email', 'is_active'],
  m_supplier: ['name', 'supplier_code', 'contact_name', 'phone', 'is_active'],
  m_location: ['name', 'location_code', 'storage_class', 'temp_min', 'temp_max', 'is_quarantine', 'is_active'] };

/** 保存できたか分からないままマスタのダイアログを閉じた：最新を読み、保存されていたかを伝える */
async function checkUnsureMaster() {
  const m = S.masterSent; if (!m) return;
  if (!(await reloadMasters().then(() => true, () => false))) { // 確かめられない：決めつけずに、通信が戻ったら確かめる
    toast(`通信できないため、${MASTER[m.t].label}「${m.code}」が保存されたか確認できませんでした。通信が戻ったら自動で確認します。`, 'warn');
    return;
  }
  if (S.page === 'master') await loadMaster().catch(() => {});
  const rows = S.M[MASTER[m.t].key] || [];
  const r = m.id ? rows.find((x) => String(x.id) === String(m.id)) : rows.find((x) => String(x[m.codeKey] || '').toUpperCase() === m.code);
  const saved = r && (!m.id || String(r.updated_at) !== String(m.ver || ''));
  if (saved) {
    resetRequest('masterForm');
    toast(`${MASTER[m.t].label}「${m.code}」は保存されていました`);
    const row = $('msList').querySelector(`[data-action="editMaster"][data-id="${CSS.escape(String(r.id))}"]`);
    if (row) { row.scrollIntoView({ block: 'nearest' }); focusTo(row); }
  } else { // 保存されていない：入力内容は残してあるので、開き直せばそのまま保存できる
    S.checked.masterForm = true;
    toast(`${MASTER[m.t].label}「${m.code}」は保存されていません。もう一度${m.id ? '開いて' : '「新規登録」から'}保存してください（入力した内容のまま開きます）。`, 'warn');
  }
}

async function loadMaster() {
  const t = S.masterTable;
  if (t === 'rules') S.rulesSeen = true;
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
        return k.endsWith('_code') ? html(mono(v)) : i === 0 ? html(`<b>${esc(v)}</b>`) : type === 'number' ? (v === null || v === '' || v === undefined ? html('<span class="unset">未設定</span>') : num(Number(v))) : v;
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
  // 保存できたか分からないまま閉じた同じデータを開き直したときは、入力していた内容と同じ依頼で開く（打ち直さずに済み、二重にもならない）
  const pend = S.unsure.masterForm && S.masterSent && S.masterSent.t === t && String(S.masterSent.id || '') === String(id || '');
  let r = id ? S.M[def.key].find((x) => String(x.id) === String(id)) : { is_active: true, min_remaining_days: 90 };
  if (pend) r = Object.assign({}, r, S.masterSent.data);
  S.masterOrig = Object.assign({}, r); // 開いたときの内容（他の利用者との競合時に、自分が変えた項目を見分けるため）
  $('masterTitle').textContent = def.label + (id ? 'の編集' : 'の新規登録');
  $('masterForm').dataset.id = id || '';
  $('masterForm').dataset.dirty = '';
  if (!pend) resetRequest('masterForm'); // 開き直したら新しい依頼
  $('masterForm').dataset.ver = pend ? (S.masterSent.ver || '') : (id && r.updated_at) || ''; // 開いたときの版。保存時に他の人の更新を上書きしないか確認する
  alertBox('masterMsg', pend ? '前回の保存が届いたか確認できなかったため、同じ内容を表示しています。そのまま「保存」を押してください（二重に登録されることはありません）。' : '', 'warn', true);
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
  if (e.submitter && e.submitter.value === 'cancel' && $('masterForm').dataset.dirty === '1' && !unsureDialog('masterDialog')) {
    e.preventDefault();
    if (await ask({ title: '変更を破棄しますか？', body: '入力した内容は保存されません。', okText: '破棄して閉じる', danger: true })) $('masterDialog').close();
    return;
  }
  if (!e.submitter || e.submitter.value !== 'save') return; // 変更が無ければキャンセル・閉じるはそのまま閉じる
  e.preventDefault();
  $('masterFields').querySelectorAll('input').forEach((x) => { if (CODE_FIELD.test(x.id) && x.value) x.value = /code/.test(x.id) ? half(x.value).toUpperCase() : half(x.value); }); // コードは大文字にそろえる
  const t = S.masterTable, data = { id: $('masterForm').dataset.id || null, expected_updated_at: $('masterForm').dataset.ver || null };
  if (!checkRequired($('masterFields'), 'masterMsg')) return;
  MASTER[t].fields.forEach(([k, , type]) => { data[k] = type === 'bool' ? $('mf_' + k).checked : $('mf_' + k).value; });
  // 回収の連絡先になるメール・電話は形式を確かめる（欄の下に示す）
  const bad = [];
  if ($('mf_email') && $('mf_email').value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($('mf_email').value.trim())) bad.push(['mf_email', 'メールアドレスの形式が正しくありません（例：info@example.com）']);
  if ($('mf_phone') && $('mf_phone').value.trim() && !/^[0-9+() -]{6,}(\(?(内線|ext\.?|#) ?[0-9]+\)?)?$/i.test($('mf_phone').value.trim())) bad.push(['mf_phone', '電話番号は数字とハイフンで入力してください（例：03-1234-5678、内線は「03-1234-5678 内線12」）']);
  if (bad.length) {
    bad.forEach(([id, m]) => fieldErr($(id), m));
    alertBox('masterMsg', bad.map((b) => b[1]).join('\n'), 'ng', true);
    $(bad[0][0]).focus();
    return;
  }
  // 在庫がある商品を無効にするときは、出荷できなくなることを確かめる。在庫がある保管場所は無効にできないので、先に案内する
  if (data.id && S.masterOrig && String(S.masterOrig.is_active) === 'true' && data.is_active === false && ['m_product', 'm_location'].includes(t)) {
    await loadInventory().catch(() => {});
    const rows = (S.inventory || []).filter((r) => r.qty > 0 && (t === 'm_product' ? r.product_code === S.masterOrig.product_code : String(r.location_id) === String(data.id)));
    const qty = rows.reduce((a, r) => a + r.qty, 0);
    if (t === 'm_location' && qty > 0) {
      fieldErr($('mf_is_active'), '在庫がある保管場所は無効にできません');
      alertBox('masterMsg', `この保管場所には在庫 ${fmt(qty)} があります。出荷・処分などで在庫を 0 にしてから無効にしてください。`, 'ng', true,
        `<button type="button" class="btn btn-secondary btn-sm" data-action="goInv" data-preset="lots" data-loc="${esc(String(data.id))}" data-label="${esc('保管場所 ' + (S.masterOrig.name || ''))}">在庫照会を開く</button>`);
      $('mf_is_active').focus();
      return;
    }
    if (qty > 0 && !(await ask({ title: `${MASTER[t].label}を無効にしますか？`, body: `この${MASTER[t].label}には在庫 ${fmt(qty)} があります。無効にすると、この在庫は出荷できなくなります（在庫照会では「出荷不可」と表示されます）。`, okText: '無効にする', danger: true }))) return;
  }
  // 既存データのコードを変えるときは念のため確認する（Enter での誤保存に備える）
  const codeKey = MASTER[t].fields[0][0];
  const before = data.id && S.masterOrig ? String(S.masterOrig[codeKey] || '') : '';
  if (before && before !== String(data[codeKey]).trim() &&
      !(await ask({ title: before.toUpperCase() === String(data[codeKey]).trim().toUpperCase() ? 'コードを大文字にそろえますか？' : 'コードを変更しますか？', body: `コードを「${before}」から「${String(data[codeKey]).trim()}」に変更します。` +
        (before.toUpperCase() === String(data[codeKey]).trim().toUpperCase() ? '\n（コードは大文字にそろえて保存します）' : ''), okText: '変更して保存' }))) return;
  await busy(e.submitter, async () => {
    try {
      S.masterSent = { t, id: data.id, code: String(data[codeKey] || '').trim().toUpperCase(), ver: data.expected_updated_at, codeKey, data: Object.assign({}, data) };
      const saved = await api('saveMaster', t, data);
      $('masterDialog').close();
      toast(MASTER[t].label + 'を保存しました');
      guideAfterAction();
      await reloadMasters({ self: { key: MASTER[t].key, id: data.id || '' } });
      await loadMaster();
      // 一覧を描き直すと開いた行が消えるので、保存した行にフォーカスを戻す（キーボードで続けて操作できるように）
      const sid = (saved && saved.id) || data.id;
      const row = (sid && $('msList').querySelector(`[data-action="editMaster"][data-id="${CSS.escape(String(sid))}"]`))
        || [...$('msList').querySelectorAll('[data-action="editMaster"]')].find((r) => r.textContent.includes(String(data[codeKey] || '').trim()));
      if (row) row.scrollIntoView({ block: 'nearest' }); // スマホで下の固定メニューに隠れないように
      focusTo(row || $('msNew'));
    } catch (err) {
      if (/他の利用者が先に更新/.test(err.message)) {
        // 最新の内容を取り込む：自分が変えていない項目は最新の値に、両方が変えた項目は自分の値のまま並べて見せる
        await reloadMasters().catch(() => {});
        const cur = S.M[MASTER[t].key].find((x) => String(x.id) === String(data.id));
        $('masterForm').dataset.ver = cur ? cur.updated_at : '';
        const orig = S.masterOrig || {};
        const norm = (v) => String(v === null || v === undefined ? '' : v);
        const both = [], updated = [];
        if (cur) MASTER[t].fields.forEach(([k, label, type]) => {
          const el = $('mf_' + k); if (!el) return;
          const changedByMe = norm(data[k]) !== norm(orig[k]);
          const changedByOther = norm(cur[k]) !== norm(orig[k]);
          if (!changedByOther) return;
          const show = (v) => (type && type.startsWith('code:') ? code(type.slice(5), v) : type === 'bool' ? (String(v) === 'true' ? 'はい' : 'いいえ') : norm(v) || '空欄');
          if (!changedByMe) { if (type === 'bool') el.checked = String(cur[k]) === 'true'; else el.value = norm(cur[k]); updated.push(`${label}（${show(orig[k])}→${show(cur[k])}）`); }
          else if (norm(cur[k]) !== norm(data[k])) {
            both.push(`${label}（他の利用者：${type && type.startsWith('code:') ? code(type.slice(5), cur[k]) : norm(cur[k]) || '空欄'} ／ あなた：${type && type.startsWith('code:') ? code(type.slice(5), data[k]) : norm(data[k]) || '空欄'}）`);
            el.setAttribute('aria-invalid', 'true');
          }
        });
        S.masterOrig = Object.assign({}, cur);
        alertBox('masterMsg', 'このデータは他の利用者が先に更新しています。' + (updated.length ? `最新の内容に更新した項目：${updated.join('、')}` : '') +
          (both.length ? `\n両方が変更した項目：${both.join('、')}\n内容を確認して「保存」すると、あなたの値で保存します。` : '\n内容を確認して、もう一度「保存」してください。'), 'ng');
        syncMedicalCode();
        return;
      }
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
    // サーバーの実際の値に合わせる（通信が途切れたときは保存されている場合があるため、反対に戻すだけにしない）
    let real = !value;
    try { S.M = await api('getMasters'); const r = S.M.salesRules.find((x) => x.regulatory_class === rc && x.customer_type === ct); if (r) real = String(r.allowed) === 'true'; } catch (e2) { /* 読めなければ元に戻す */ }
    document.querySelectorAll(`.ruleChk[data-rc="${rc}"][data-ct="${ct}"]`).forEach((c) => { c.checked = real; });
    toast(real === value ? '通信が途切れましたが、保存されていました：' + `${code('regulatory_class', rc)} → ${code('customer_type', ct)}：${value ? '販売可' : '販売不可'}` : err.message, real === value ? '' : 'ng');
  } finally {
    document.querySelectorAll(`.ruleChk[data-rc="${rc}"][data-ct="${ct}"]`).forEach((c) => { c.disabled = false; });
    if (document.activeElement === document.body && chk.isConnected) chk.focus(); // 保存中に外れたフォーカスを戻す
  }
}

// ======================================================================
// イベント
// ======================================================================
const ACTIONS = {
  go: (el) => { if (el.dataset.page === 'inventory') { S.invPreset = ''; S.invScope = null; $('invFilter').value = ''; alertBox('invMsg', ''); } go(el.dataset.page); },
  openSheet, closeSheet: () => closeSheet(true),
  logout: async () => {
    closeSheet();
    if (hasUnsavedInput() && !(await ask({ title: 'ログアウトしますか？', body: `保存していない入力内容があります（${unsavedScreens().join('・')}）。ログアウトすると消えます。`, okText: 'ログアウトする', danger: true }))) return;
    logout('');
  },
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
  openDispose,
  insShowAll: () => {
    S.inspectFilter = '';
    loadInspect().then(() => {
      const card = [...$('insBody').querySelectorAll('.lot-card')].find((c) => c.querySelector('.lot-no').textContent === S.insFocusLot);
      if (card) {
        // 入力していた理由（と判定）を戻す
        const r = S.insReason; S.insReason = null;
        if (r && $('rs_' + r.id) && !$('rs_' + r.id).value) {
          $('rs_' + r.id).value = r.reason;
          const sel = $('to_' + r.id);
          if (sel && r.to && [...sel.options].some((o) => o.value === r.to)) { sel.value = r.to; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        card.scrollIntoView({ block: 'center' }); focusTo(card);
      }
    }).catch((err) => toast(err.message, 'ng'));
  },
  disposeAll: (el) => { $('dpQty').value = el.dataset.qty; $('dpQty').removeAttribute('aria-invalid'); $('disposeForm').dataset.dirty = '1'; },
  dialogCancel: async (el) => {
    const dlg = el.closest('dialog');
    const form = dlg.querySelector('form');
    if (form && form.dataset.dirty === '1' && dlg.id !== 'dialog' && !unsureDialog(dlg.id)) {
      if (!(await ask({ title: '入力内容を破棄しますか？', body: '入力した内容は保存されません。', okText: '破棄して閉じる', danger: true }))) return;
    }
    dlg.close('cancel');
  },
  goInv: (el) => {
    if (el.matches('tr')) S.backFocus = { page: S.page, sel: `tr[data-action="goInv"][data-q="${CSS.escape(el.dataset.q || '')}"]` };
    S.invPreset = el.dataset.preset === 'lots' ? '' : el.dataset.preset;
    // 対象をはっきり決めた絞り込み（回収の対象ロット・保管場所・商品）。文字の部分一致で別のものまで出さないように
    S.invScope = el.dataset.lots || el.dataset.loc || el.dataset.prod
      ? { lots: el.dataset.lots ? el.dataset.lots.split(',') : null, loc: el.dataset.loc || null, prod: el.dataset.prod || null, label: el.dataset.label || '', recall: el.dataset.recall || null } : null;
    // 回収案件から来たときは、「戻る」でその案件のボタンに戻れるように
    if (el.dataset.recall) S.backFocus = { page: 'recall', sel: `article[data-id="${CSS.escape(el.dataset.recall)}"] [data-action="goInv"]` };
    // アプリが案内したボタンなので、開いているマスタ編集は確認なしで閉じる
    if ($('masterDialog').open) { $('masterForm').dataset.dirty = ''; $('masterDialog').close('cancel'); }
    alertBox('invMsg', '');
    $('invFilter').value = S.invScope ? '' : el.dataset.q || '';
    $('invAvail').checked = false;
    go('inventory');
  },
  openRecall: (el) => { S.recallJump = el.dataset.id; go('recall'); }, // 選んだ回収案件まで移動して開く
  retrace: () => $('tlSearch').requestSubmit(),
  retraceCustomer: () => $('tcSearch').requestSubmit(),
  clearInvAll: () => { S.invPreset = ''; S.invScope = null; $('invFilter').value = ''; $('invAvail').checked = false; alertBox('invMsg', ''); renderInventory(); focusTo($('invFilter')); },
  clearInvPreset: () => { S.invPreset = ''; S.invScope = null; renderInventory(); focusTo($('invFilter')); },
  newReturn: async () => {
    if (unsavedScreens().includes('返品登録') && !(await ask({ title: '入力中の返品内容を閉じますか？', body: `出荷 ${S.rtNo} の返品は、まだ登録していません。「戻る」で開き直すと、入力した内容を戻せます。`, okText: '閉じる', danger: true }))) return;
    $('rtShipNo').value = ''; $('rtShipNo').removeAttribute('aria-invalid'); $('rtShipment').innerHTML = ''; alertBox('rtFindMsg', ''); alertBox('rtMsg', ''); $('rtForm').hidden = true; S.returnLine = null; S.rtNo = '';
    setUrl('#/return', true); // 「戻る」で直前の出荷に戻れるように（入力途中の内容は下書きに残る）
    loadReturnRecent().then(() => focusTo($('rtShipNo'))).catch((err) => toast(err.message, 'ng'));
  },
  pickReturnShipment: (el) => { $('rtShipNo').value = el.dataset.no; $('rtShipNo').removeAttribute('aria-invalid'); alertBox('rtFindMsg', ''); findShipmentForReturn(null, false); },
  traceLotNo: (el) => {
    if (el.matches('tr')) S.backFocus = { page: S.page, sel: `tr[data-action="traceLotNo"][data-lot="${CSS.escape(el.dataset.lot)}"]` }; goUrl('#/traceLot?q=' + encodeURIComponent(el.dataset.lot)); },
  confirmRules: async (el) => busy(el, async () => {
    try {
      S.cfg.prefs = await api('saveUserPrefs', { rulesChecked: true });
      toast('販売可否ルールの確認を記録しました');
      await guideAfterAction();
      renderRules();
      focusTo($('msList').querySelector('.rules-confirm .guide-state'));
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
  showSetup: async (el) => busy(el, async () => {
    try {
      S.cfg.prefs = await api('saveUserPrefs', { checklistHidden: false });
      await loadDashboard();
      focusTo($('setupTitle') || $('main'));
    } catch (err) { toast(err.message, 'ng'); }
  }),
  reload: async (el) => busy(el, async () => {
    try { await reloadMasters(); await showPage(S.page); toast('最新の情報に更新しました'); } catch (err) { toast(err.message, 'ng'); }
  }),
  addLine, removeLine: (el) => {
    const line = el.closest('.line'), prev = line.previousElementSibling;
    line.remove();
    if (S.unsure.shipForm) S.changed.shipForm = true; else resetRequest('shipForm'); // 明細が変わった（確認待ちの間は同じ依頼のまま）
    if (!$('shLines').children.length) { addLine(true); $('shLines').firstElementChild.dataset.cleared = '1'; } // 自分で消したので、自動では選び直さない
    // 削除したあとのフォーカス：前の明細の商品、無ければ最初の明細の商品
    (prev || $('shLines').firstElementChild).querySelector('.slProd').focus();
    setTimeout(clearGoneNotice, 0);
  },
  changeStatus, cancelShip, selectReturnLine: async (el) => {
    // 入力中の明細から別の明細に切り替えるときは確認する（数量・理由は消える）
    if (S.returnLine && S.returnLine !== el.dataset.id && unsavedScreens().includes('返品登録')
      && !(await ask({ title: '入力中の返品内容を破棄しますか？', body: '別の明細を選ぶと、入力した数量・理由は消えます。', okText: '破棄して選ぶ', danger: true }))) return;
    selectReturnLine(el);
  }, cancelReturn: async () => {
    if (unsavedScreens().includes('返品登録') && !(await ask({ title: '入力中の返品内容を破棄しますか？', body: '入力した数量・理由は消えます。', okText: '破棄する', danger: true }))) return;
    cancelReturn();
  },
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
  if (e.key === 'Escape' && !$('moreSheet').hidden) closeSheet(true);
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
/** 「選択を外しました」の案内は、外した欄をすべて選び直したら消す */
function clearGoneNotice() {
  [['shMsg', 'shipForm'], ['rcMsg', 'receiptForm']].forEach(([m, f]) => {
    if ($(m).dataset.gone === '1' && !$(f).querySelector('[aria-invalid="true"]')) { alertBox(m, ''); $(m).dataset.gone = ''; }
  });
}

document.addEventListener('change', (e) => {
  const t = e.target;
  resetScopeOf(t);
  setTimeout(clearGoneNotice, 0);
  if (t.id && CODE_FIELD.test(t.id) && t.value && half(t.value) !== t.value) t.value = half(t.value);
  if (t.getAttribute && t.getAttribute('aria-invalid') === 'true' && (String(t.value || '').trim() || !t.required)) clearInvalid(t);
  if (t.id === 'guideRulesChk') { saveRulesChecked(t); return; }
  if (t.id === 'mf_customer_type') syncMedicalCode();
  if (t.classList.contains('slProd')) {
    const p = S.M.products.find((x) => String(x.id) === t.value);
    const pr = t.closest('.line').querySelector('.slPrice');
    setValue(pr, p && p.list_price !== null && p.list_price !== undefined ? p.list_price : '');
    setPriceHint(t.closest('.line'), p);
    updateLineAvail(t.closest('.line'), true);
  } else if (t.classList.contains('ruleChk')) {
    saveRule(t);
  } else if (t.id === 'shCustomer') {
    updateCustHint();
    document.querySelectorAll('#shLines .line').forEach((l) => updateLineAvail(l, true));
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
  resetScopeOf(e.target); // 内容を変えたら別の依頼
  if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true' && (String(e.target.value || '').trim() || !e.target.required)) clearInvalid(e.target);
  if (e.target.id === 'rcExp') e.target.dataset.manual = '1';
  if (e.target.id === 'invFilter') renderInventory();
  if (e.target.closest && e.target.closest('#rtForm')) saveReturnDraft();
  // 数量を返品可能数の範囲に直したら、上に出ていた「超えています」の表示も消す
  if (e.target.id === 'rtQty' && /返品可能数/.test($('rtFindMsg').textContent) && Number(e.target.value) >= 1 && Number(e.target.value) <= Number(e.target.max)) alertBox('rtFindMsg', '');
  if (e.target.classList.contains('slQty')) updateLineAvail(e.target.closest('.line'), true);
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
  $('disposeForm').addEventListener('submit', submitDispose);
  $('disposeForm').addEventListener('input', () => { $('disposeForm').dataset.dirty = '1'; });
  $('disposeDialog').addEventListener('cancel', async (e) => {
    if ($('disposeForm').dataset.dirty !== '1' || unsureDialog('disposeDialog')) return; // 確認できないまま閉じるときは、閉じたあとで結果を確かめる
    e.preventDefault();
    if (await ask({ title: '入力内容を破棄しますか？', body: '入力した内容は保存されません。', okText: '破棄して閉じる', danger: true })) $('disposeDialog').close();
  });
  $('disposeDialog').addEventListener('close', () => {
    if (S.unsure.disposeForm) { checkUnsureDispose(); return; } // どの閉じ方でも、記録できていたかを確かめて伝える
    if (G_STATE.disposeOpener && G_STATE.disposeOpener.isConnected) focusTo(G_STATE.disposeOpener);
    else if (!$('page-inventory').hidden) focusTo($('invMsg').firstElementChild || $('invBody')); // 行が消えていたら一覧へ
  });
  $('masterDialog').addEventListener('close', () => { if (S.unsure.masterForm) checkUnsureMaster(); });
  // マスタ編集：変更があるのに閉じようとしたら確認する
  $('masterFields').addEventListener('input', () => { $('masterForm').dataset.dirty = '1'; });
  $('masterFields').addEventListener('change', () => { $('masterForm').dataset.dirty = '1'; });
  $('masterDialog').addEventListener('cancel', async (e) => {
    if ($('masterForm').dataset.dirty !== '1' || unsureDialog('masterDialog')) return;
    e.preventDefault();
    if (await ask({ title: '変更を破棄しますか？', body: '入力した内容は保存されません。', okText: '破棄して閉じる', danger: true })) $('masterDialog').close();
  });
  $('sheetBackdrop').addEventListener('click', () => closeSheet(true));
  // 画面の向きを変えて広くなったら、スマホ用のメニューは閉じる（横のメニューが出るため）
  matchMedia('(min-width: 768px)').addEventListener('change', (ev) => {
    if (ev.matches && !$('moreSheet').hidden) { closeSheet(false); if (!document.activeElement || document.activeElement === document.body) focusTo($('main')); }
  });
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
  window.addEventListener('hashchange', async () => {
    if (!S.sess || $('app').hidden) return;
    // 入力途中のダイアログ（マスタ編集・処分）があるときに「戻る」が押されたら、元の画面に戻して確認する
    const dirty = ($('masterDialog').open && $('masterForm').dataset.dirty === '1' && !unsureDialog('masterDialog')) || ($('disposeDialog').open && $('disposeForm').dataset.dirty === '1' && !unsureDialog('disposeDialog'));
    if (dirty) {
      const target = location.hash;
      history.pushState(null, '', S.lastHash || '#/dashboard');
      if (!(await ask({ title: '入力内容を破棄しますか？', body: '入力した内容は保存されません。', okText: '破棄して移動する', danger: true }))) return;
      ['masterDialog', 'disposeDialog'].forEach((d) => { if ($(d).open) $(d).close('cancel'); });
      location.hash = target;
      return;
    }
    route();
  });
  // 返品の入力途中でページを閉じる・再読み込みするときは確認する
  window.addEventListener('beforeunload', (e) => {
    if (!S.sess || $('app').hidden) return;
    if (hasUnsavedInput()) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshToday(); recheckUnsure(); } });
  window.addEventListener('focus', () => { refreshToday(); recheckUnsure(); });
  window.addEventListener('online', () => {
    recheckUnsure();
    if (!$('retryBtn').hidden) retry($('retryBtn'));
  });
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
