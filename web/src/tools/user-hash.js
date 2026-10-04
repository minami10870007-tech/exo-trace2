'use strict';
const ITERATIONS = 600000; // PBKDF2-SHA256 の反復回数（Netlify Function 側と同じ形式で記録）
const $ = (id) => document.getElementById(id);
let seq = 0;
let lastList = '';

function addUser(email) {
  const n = ++seq;
  const div = document.createElement('div');
  div.className = 'user';
  div.innerHTML = `<div class="user-head"><span>利用者 ${n}</span><button type="button" class="btn btn-ghost remove" aria-label="利用者 ${n} を削除">削除</button></div>
    <div class="field"><label for="em${n}">メールアドレス</label><input id="em${n}" class="em" type="email" inputmode="email" autocomplete="off" placeholder="taro@example.com"></div>
    <div class="field"><label for="pw${n}">パスワード（12文字以上）</label>
      <div class="pw"><input id="pw${n}" class="pwd" type="text" autocomplete="new-password" spellcheck="false"><button type="button" class="btn gen-pw">自動作成</button></div>
      <div class="hint" id="h${n}"></div></div>`;
  if (email) div.querySelector('.em').value = email;
  $('users').appendChild(div);
  updateRemove();
  return div;
}
function updateRemove() {
  const rows = $('users').querySelectorAll('.user');
  rows.forEach((r) => { r.querySelector('.remove').hidden = rows.length === 1; });
}
function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function entryFor(email, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `${email}:pbkdf2-sha256:${ITERATIONS}:${hex(salt)}:${hex(bits)}`;
}

function validate() {
  let ok = true;
  const seen = new Set();
  const users = [];
  $('users').querySelectorAll('.user').forEach((u) => {
    const em = u.querySelector('.em'), pw = u.querySelector('.pwd'), hint = u.querySelector('.hint');
    const email = em.value.trim().toLowerCase(), password = pw.value;
    let err = '';
    if (!/^[^\s@:;]+@[^\s@:;]+\.[^\s@:;]+$/.test(email)) err = 'メールアドレスの形式を確認してください。';
    else if (seen.has(email)) err = '同じメールアドレスが2回入力されています。';
    else if (password.length < 12) err = 'パスワードを12文字以上にしてください（「自動作成」も使えます）。';
    hint.textContent = err;
    hint.className = 'hint' + (err ? ' ng' : '');
    if (err) ok = false;
    seen.add(email);
    users.push({ email, password });
  });
  return ok ? users : null;
}

async function generate(e) {
  e.preventDefault();
  const users = validate();
  if (!users) { $('msg').textContent = '入力内容を確認してください。'; $('msg').className = 'msg ng'; return; }
  if (!window.crypto || !crypto.subtle) { $('msg').textContent = 'このブラウザでは計算できません。最新の Chrome / Safari / Edge で開いてください。'; $('msg').className = 'msg ng'; return; }
  const btn = $('gen');
  btn.disabled = true;
  $('msg').textContent = '計算中です（1人あたり数秒かかります）…';
  $('msg').className = 'msg';
  try {
    const entries = [];
    for (const u of users) entries.push(await entryFor(u.email, u.password));
    const existing = $('existing').value.split(';').map((s) => s.trim()).filter(Boolean)
      .filter((s) => !users.some((u) => s.toLowerCase().startsWith(u.email + ':')));
    $('result').value = existing.concat(entries).join(';');
    $('exampleBadge').hidden = true;
    $('list').innerHTML = '';
    users.forEach((u) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = u.email;
      const b = document.createElement('td'); b.className = 'mono'; b.textContent = u.password;
      tr.append(a, b);
      $('list').appendChild(tr);
    });
    lastList = users.map((u) => `${u.email}\t${u.password}`).join('\n');
    $('copyResult').disabled = false;
    $('copyList').disabled = false;
    $('msg').textContent = `${users.length} 人分の文字列を作りました。右の値をコピーして Netlify に貼ってください。`;
    $('msg').className = 'msg ok';
  } catch (err) {
    $('msg').textContent = '計算に失敗しました：' + err.message;
    $('msg').className = 'msg ng';
  } finally {
    btn.disabled = false;
  }
}

async function copy(text, btn) {
  const label = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'コピーしました'; }
  catch (e) { $('result').select(); btn.textContent = '選択しました（Ctrl+C / ⌘C でコピー）'; }
  setTimeout(() => { btn.textContent = label; }, 2500);
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('.gen-pw')) { const inp = t.closest('.pw').querySelector('.pwd'); inp.value = randomPassword(); inp.dispatchEvent(new Event('input')); }
  if (t.closest('.remove')) { t.closest('.user').remove(); updateRemove(); }
});
$('add').addEventListener('click', () => addUser().querySelector('.em').focus());
$('form').addEventListener('submit', generate);
$('copyResult').addEventListener('click', (e) => copy($('result').value, e.currentTarget));
$('copyList').addEventListener('click', (e) => copy(lastList, e.currentTarget));
addUser();
