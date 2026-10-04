// Apps Script 実行環境のモック（SpreadsheetApp・LockService・Session・Utilities・MailApp）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createEnv() {
// ---------------- SpreadsheetApp モック ----------------
function makeSheet(name) {
  let maxRows = 1000, data = [];
  const cell = (r, c) => ((data[r - 1] || [])[c - 1]);
  const sheet = {
    name,
    getMaxRows: () => maxRows,
    insertRowsAfter: (_after, n) => { maxRows += n; },
    getLastRow: () => {
      for (let r = data.length; r >= 1; r--) if ((data[r - 1] || []).some(v => v !== '' && v !== undefined)) return r;
      return 0;
    },
    setFrozenRows: () => {},
    getRange: (row, col, nr = 1, nc = 1) => {
      if (row + nr - 1 > maxRows) throw new Error('範囲外: ' + name + ' row ' + (row + nr - 1) + ' > ' + maxRows);
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = cell(row + i, col + j); return v === undefined ? '' : v; })),
        setValues: vals => {
          vals.forEach((rv, i) => rv.forEach((v, j) => {
            if (!data[row + i - 1]) data[row + i - 1] = [];
            if (typeof v !== 'string') throw new Error('文字列以外の書込み: ' + name + ' ' + JSON.stringify(v));
            data[row + i - 1][col + j - 1] = v;
          }));
          return range;
        },
        setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range, setFontColor: () => range,
      };
      return range;
    },
    _data: () => data,
  };
  return sheet;
}
const sheets = {};
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n)) };
let currentUser = 'qa@example.com';
let FAKE_NOW = new Date('2026-10-04T03:00:00Z');
const mails = [];
const sandbox = {
  console,
  SpreadsheetApp: { getActive: () => ss, flush: () => {}, getUi: () => { throw new Error('no ui'); } },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Session: { getActiveUser: () => ({ getEmail: () => currentUser }), getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  MailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      const j = new Date(d.getTime() + 9 * 3600000).toISOString();
      return fmt === 'yyyy-MM-dd' ? j.slice(0, 10) : j.slice(0, 10) + ' ' + j.slice(11, 19);
    },
  },
};
// new Date() を固定（引数ありはそのまま）
const RealDate = Date;
sandbox.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FAKE_NOW.getTime()); } static now() { return FAKE_NOW.getTime(); } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'コード.gs'), 'utf8'), sandbox, { filename: 'コード.gs' });

  return { G: sandbox, sheets, mails, setNow: d => { FAKE_NOW = d; } };
}
module.exports = { createEnv };
