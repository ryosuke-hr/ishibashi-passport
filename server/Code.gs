// 石橋パスポートのサーバー（Google Apps Script）
// スプレッドシートの「拡張機能 > Apps Script」に貼り付けて、ウェブアプリとしてデプロイする。
//
// スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）:
//   LINE_CHANNEL_ID  LINEログインチャネルのチャネルID
//   LIFF_URL         https://liff.line.me/<LIFF ID>
//   PASS_MONTHS      有料パスの有効期間の月数（省略すると 3）。登録した日の Nか月後の同じ日の終わりまで使える
//   SHOPS            参加店の名前をカンマ区切りで（例 石橋カレー,喫茶まちかど,古本ハシモト）

const TZ = 'Asia/Tokyo';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい I O 0 1 は使わない
const CODE_LENGTH = 8;

const SHEETS = {
  codes: ['合言葉', '状態', '使った人', '使った人のID', '使った日時', 'QR'],
  members: ['LINEのユーザーID', '名前', '登録日時', '有効期限', '合言葉'],
  uses: ['LINEのユーザーID', '名前', '店名', '日付', '時刻'],
};

// ===== 入口 =====

// 会員証ページからは text/plain の POST で JSON が届く（CORS の事前確認を起こさないため）
function doPost(e) {
  let result;
  try {
    const req = JSON.parse(e.postData.contents);
    const user = verifyIdToken(req.idToken);
    if (req.action === 'status') result = status(user);
    else if (req.action === 'register') result = register(user, req.code);
    else if (req.action === 'use') result = useShop(user, req.shop);
    else result = { ok: false, error: 'unknown', message: '不明な操作です' };
  } catch (err) {
    result = err.userError
      ? { ok: false, error: err.userError, message: err.message }
      : { ok: false, error: 'server', message: 'サーバーでエラーが起きました: ' + err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('石橋パスポートのサーバーは動いています');
}

// ===== 操作 =====

function status(user) {
  const member = findMember(user.id);
  return {
    ok: true,
    user: { name: user.name },
    member: member ? memberView(member) : null,
    shops: shopList(),
    usedToday: member ? usedShopsToday(user.id) : [],
  };
}

function register(user, rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) throw userError('code', '合言葉は8文字です');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const existing = findMember(user.id);
    if (existing) return status(user); // もう会員なら何もしない（合言葉は消費しない）

    const sheet = sheetOf('codes');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 && row[0] === code);
    if (index < 0) throw userError('code', 'この合言葉は見つかりません。打ち間違いがないか確かめてください');
    if (rows[index][1] !== '未使用') throw userError('used', 'この合言葉はもう使われています');

    const now = nowText();
    sheet.getRange(index + 1, 2, 1, 4).setValues([['使用済み', user.name, user.id, now]]);
    sheetOf('members').appendRow([user.id, user.name, now, expiresText(new Date()), code]);
  } finally {
    lock.releaseLock();
  }
  return status(user);
}

function useShop(user, shop) {
  if (shopList().indexOf(shop) < 0) throw userError('shop', '店名を選び直してください');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = findMember(user.id);
    if (!member) throw userError('notMember', '会員登録がまだです');
    if (isExpired(member)) throw userError('expired', '有効期限が切れています');
    if (usedShopsToday(user.id).indexOf(shop) >= 0) throw userError('usedToday', shop + ' の特典は今日はもう使いました');

    const now = new Date();
    sheetOf('uses').appendRow([
      user.id,
      user.name,
      shop,
      Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
      Utilities.formatDate(now, TZ, 'HH:mm:ss'),
    ]);
  } finally {
    lock.releaseLock();
  }
  return status(user);
}

// ===== 合言葉の発行（Apps Script の画面から手で実行する） =====

function makeCodes() {
  const sheet = sheetOf('codes');
  const liffUrl = prop('LIFF_URL');
  const taken = new Set(sheet.getDataRange().getValues().map((row) => row[0]));
  const rows = [];
  while (rows.length < 50) {
    const code = randomCode();
    if (taken.has(code)) continue;
    taken.add(code);
    const url = liffUrl + '?code=' + code;
    rows.push([code, '未使用', '', '', '', '=IMAGE("https://quickchart.io/qr?size=300&text=' + encodeURIComponent(url) + '")']);
  }
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setRowHeights(start, rows.length, 120);
  sheet.setColumnWidth(6, 120);
}

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
}

// ===== LINE の本人確認 =====

// 会員証ページから届いた IDトークンを LINE に送って、本物かどうかと誰のものかを確かめる
function verifyIdToken(idToken) {
  if (!idToken) throw userError('token', 'LINEにログインし直してください');
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop('LINE_CHANNEL_ID') },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw userError('token', 'LINEにログインし直してください');
  const body = JSON.parse(res.getContentText());
  return { id: body.sub, name: body.name || '名前なし' };
}

// ===== シートの読み書き =====

function sheetOf(name) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.appendRow(SHEETS[name]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findMember(userId) {
  const rows = sheetOf('members').getDataRange().getValues();
  for (let i = rows.length - 1; i > 0; i--) {
    if (rows[i][0] === userId) return { name: rows[i][1], expires: dateText(rows[i][3]) };
  }
  return null;
}

function usedShopsToday(userId) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return sheetOf('uses')
    .getDataRange()
    .getValues()
    .filter((row, i) => i > 0 && row[0] === userId && dateText(row[3]) === today)
    .map((row) => row[2]);
}

function memberView(member) {
  return { name: member.name, expires: member.expires, expired: isExpired(member) };
}

function isExpired(member) {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') > member.expires;
}

// シートが日付を Date に変えてしまうことがあるので、文字列にそろえる
function dateText(value) {
  return value instanceof Date ? Utilities.formatDate(value, TZ, 'yyyy-MM-dd') : String(value);
}

function nowText() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

// 登録日の Nか月後の同じ日。その月に同じ日が無ければ月末（11月30日 + 3か月 → 2月28日）
function expiresText(registered) {
  const months = Number(PropertiesService.getScriptProperties().getProperty('PASS_MONTHS')) || 3;
  const [y, m, d] = Utilities.formatDate(registered, TZ, 'yyyy-M-d').split('-').map(Number);
  const lastDay = new Date(y, m - 1 + months + 1, 0).getDate();
  const expires = new Date(y, m - 1 + months, Math.min(d, lastDay));
  return Utilities.formatDate(expires, TZ, 'yyyy-MM-dd');
}

function shopList() {
  return prop('SHOPS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function prop(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('スクリプトプロパティ ' + key + ' が設定されていません');
  return value;
}

function userError(code, message) {
  const err = new Error(message);
  err.userError = code;
  return err;
}
