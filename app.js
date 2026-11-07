// 石橋パスポートの会員証ページ（LIFF）
// LINEでログインした人の IDトークンを Apps Script に送り、会員かどうかの判定と記録はサーバーでする。

const CONFIG = {
  LIFF_ID: '2012391980-YlMmgFG7', // LINE Developers で作った LIFF アプリの ID（例 2001234567-AbCdEfGh）
  API_URL: 'https://script.google.com/macros/s/AKfycbxCrjEKfF7RkQqGHUPuorf23ha3mPzeB5kTIy67YyECq4RYW69lcp38_SVFxqub1albZA/exec', // Apps Script のウェブアプリの URL（https://script.google.com/macros/s/.../exec）
  PRICE: 1500,};

// LIFF_ID が空か、URL に ?demo がついているときは、LINE もサーバーも使わないお試しモードで動く
const DEMO = !CONFIG.LIFF_ID || new URLSearchParams(location.search).has('demo');

const app = document.getElementById('app');

const state = {
  phase: 'loading', // loading / ready / error
  error: '',
  user: null, // { name }
  member: null, // { name, expires, expired }
  shops: [],
  usedToday: [],
  shop: '', // 店員さんが選んだ店名
  busy: false,
  notice: '', // 合言葉や利用のエラー表示
  stamp: null, // 直前に使った { shop, time }
};

const QR_ERRORS = {
  used: 'このQRコードはもう使われています。買ったときに見せてもらったQRか、販売した人に確かめてください',
  code: 'このQRコードは使えません。販売した人に声をかけてください',
};

// ===== 起動 =====

async function start() {
  try {
    if (!DEMO) {
      await liff.init({ liffId: CONFIG.LIFF_ID });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
    }
    const code = codeFromUrl();
    const res = code ? await call('register', { code }) : await call('status');
    if (code) history.replaceState(null, '', location.pathname + (DEMO ? '?demo' : ''));
    if (!res.ok && code) {
      // QRがダメでも、会員証の画面（または買い方の説明）は出す。文字入力は無いので、QRの言葉で伝える
      state.notice = QR_ERRORS[res.error] || res.message;
      applyStatus(await call('status'));
    } else {
      applyStatus(res);
    }
  } catch (err) {
    state.phase = 'error';
    state.error = err.message || String(err);
  }
  render();
}

// 合言葉QR（https://liff.line.me/<ID>?code=XXXX）から開いたときの合言葉
function codeFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('code')) return params.get('code');
  const liffState = params.get('liff.state');
  if (liffState) return new URLSearchParams(liffState.split('?')[1] || '').get('code');
  return '';
}

function applyStatus(res) {
  if (!res.ok) {
    if (res.error === 'token' && !DEMO) {
      // IDトークンの期限切れ。ログインし直す
      liff.logout();
      liff.login({ redirectUri: location.href });
      return;
    }
    state.phase = 'error';
    state.error = res.message;
    return;
  }
  state.phase = 'ready';
  state.user = res.user;
  state.member = res.member;
  state.shops = res.shops;
  state.usedToday = res.usedToday;
  if (state.shops.indexOf(state.shop) < 0) state.shop = '';
}

// ===== サーバーとのやりとり =====

async function call(action, data) {
  if (DEMO) return demoServer(action, data || {});
  const idToken = liff.getIDToken();
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    // text/plain にすると CORS の事前確認が起きず、Apps Script にそのまま届く
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, idToken }, data)),
  });
  return res.json();
}

async function useShop() {
  const shop = state.shop;
  state.busy = true;
  state.notice = '';
  render();
  const res = await call('use', { shop }).catch(networkError);
  state.busy = false;
  if (res.ok) {
    applyStatus(res);
    state.stamp = { shop, time: timeText(new Date()) };
  } else {
    state.notice = res.message;
  }
  render();
}

function networkError() {
  return { ok: false, message: '通信できませんでした。電波のよいところでもう一度試してください' };
}

// ===== 描画 =====

function render() {
  app.replaceChildren();
  if (state.phase === 'loading') {
    app.append(el('p', 'loading', '読み込み中…'));
    return;
  }
  if (state.phase === 'error') {
    app.append(el('h1', 'title', '石橋パスポート'), el('p', 'error', state.error));
    const retry = el('button', 'btn', 'もう一度読み込む');
    retry.addEventListener('click', () => location.reload());
    app.append(retry);
    return;
  }
  if (DEMO) app.append(el('p', 'demo', 'お試しモード（LINE・サーバーにはつながっていません）'));
  if (state.member) renderCard();
  else renderRegister();
}

function renderRegister() {
  const box = el('section', 'panel');
  box.append(
    el('h1', 'title', '石橋パスポート'),
    el('p', '', `${state.user.name} さん、有料パス（${CONFIG.PRICE.toLocaleString('ja-JP')}円）を買うと、会員登録用のQRコードがもらえます。LINEのカメラで読むと、すぐ会員になれます。`),
  );
  if (state.notice) box.append(el('p', 'error', state.notice));

  const how = el('div', 'how');
  how.append(
    el('h2', '', '有料パスの買い方'),
    el('p', '', '公式LINEの「パスを購入」をタップすると、購入の手続きに進みます。'),
    el('p', '', '入金していただいた後に、パスの人専用のQRコードを送ります。そのQRコードから登録をお願いします。'),
  );
  box.append(how);
  app.append(box);
}

function renderCard() {
  const m = state.member;
  const card = el('section', 'card' + (m.expired ? ' expired' : ''));

  const head = el('div', 'card-head');
  const logo = el('div', 'logo');
  logo.innerHTML = LOGO_SVG;
  const brand = el('div', 'brand');
  brand.append(el('p', 'brand-ja', '石橋パスポート'), el('p', 'brand-en', 'ISHIBASHI PASSPORT'));
  head.append(logo, brand, el('span', 'chip', '有料パス'));

  const holder = el('div', 'card-holder');
  holder.append(el('p', 'card-small', 'MEMBER'), el('p', 'card-name', m.name));

  const foot = el('div', 'card-foot');
  const expires = el('div', '');
  expires.append(el('p', 'card-small', '有効期限'), el('p', 'card-expires', dateLabel(m.expires) + ' まで'));
  const now = el('div', 'now');
  const day = el('p', 'card-small', '');
  day.id = 'today';
  const clock = el('p', 'clock', '');
  clock.id = 'clock';
  now.append(day, clock);
  foot.append(expires, now);

  card.append(head, holder, foot);
  if (m.expired) card.append(el('p', 'expired-stamp', '有効期限切れ'));
  app.append(card);
  tick();

  if (m.expired) {
    app.append(el('p', 'note', 'この会員証は使えません。'));
    return;
  }

  const staff = el('section', 'panel staff');
  staff.append(el('h2', '', 'お店の方へ'), el('p', 'note', '時計とロゴが動いているのを確かめてから、店名を選んでバーを右へスワイプしてください。'));

  const select = document.createElement('select');
  select.className = 'shop-select';
  select.append(new Option('店名を選ぶ', ''));
  for (const shop of state.shops) {
    const used = state.usedToday.indexOf(shop) >= 0;
    const option = new Option(used ? shop + '（今日は使用済み）' : shop, shop);
    option.disabled = used;
    select.append(option);
  }
  select.value = state.shop;
  select.addEventListener('change', () => {
    state.shop = select.value;
    state.notice = '';
    render();
  });
  staff.append(select);
  staff.append(swipeBar(!state.shop || state.busy));
  if (state.notice) staff.append(el('p', 'error', state.notice));

  if (state.usedToday.length) {
    staff.append(el('p', 'note', '今日使ったお店: ' + state.usedToday.join('、')));
  }
  app.append(staff);

  if (state.stamp) app.append(stampOverlay(state.stamp));
}

// 右へスワイプしたら使用済みにするバー
function swipeBar(disabled) {
  const bar = el('div', 'swipe' + (disabled ? ' disabled' : ''));
  const label = el('span', 'swipe-label', state.busy ? '記録しています…' : disabled ? '先に店名を選んでください' : '右へスワイプで使用済み →');
  const knob = el('div', 'swipe-knob', '→');
  bar.append(label, knob);
  if (disabled) return bar;

  let startX = 0;
  let dx = 0;
  const max = () => bar.clientWidth - knob.offsetWidth - 8;
  knob.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    dx = 0;
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('dragging');
  });
  knob.addEventListener('pointermove', (e) => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    dx = Math.max(0, Math.min(max(), e.clientX - startX));
    knob.style.transform = `translateX(${dx}px)`;
  });
  const end = (e) => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    knob.releasePointerCapture(e.pointerId);
    knob.classList.remove('dragging');
    if (dx >= max() * 0.9) {
      knob.style.transform = `translateX(${max()}px)`;
      useShop();
    } else {
      knob.style.transform = '';
    }
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  return bar;
}

function stampOverlay(stamp) {
  const overlay = el('div', 'overlay');
  const box = el('div', 'stamp');
  box.append(el('p', 'stamp-mark', '使用済み'), el('p', 'stamp-shop', stamp.shop), el('p', 'stamp-time', stamp.time));
  const close = el('button', 'btn', '閉じる');
  close.addEventListener('click', () => {
    state.stamp = null;
    state.shop = '';
    render();
  });
  box.append(close);
  overlay.append(box);
  return overlay;
}

// 秒で動く時計。スクショでないことを見分けるため、毎秒書き換える
function tick() {
  const clock = document.getElementById('clock');
  if (!clock) return;
  const now = new Date();
  document.getElementById('today').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
  clock.textContent = timeText(now);
}
setInterval(tick, 1000);

// ===== 小道具 =====

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function timeText(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function dateLabel(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

const LOGO_SVG =
  '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="4"/>' +
  '<path d="M14 38 Q32 18 50 38" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>' +
  '<path d="M18 38v8M46 38v8M32 30v16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';

// ===== お試しモードのにせサーバー =====
// ?demo&code=TESTCODE で会員になれる（USEDCODE は使用済み）。?demo&member で最初から会員、?demo&expired で期限切れの会員

const demoParams = new URLSearchParams(location.search);
const demo = {
  member: demoParams.has('member') || demoParams.has('expired'),
  expired: demoParams.has('expired'),
  codes: { TESTCODE: false, USEDCODE: true },
  used: [],
};

function demoServer(action, data) {
  const fail = (error, message) => ({ ok: false, error, message });
  if (action === 'register') {
    const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!demo.member) {
      if (code.length !== 8) return fail('code', '合言葉は8文字です');
      if (!(code in demo.codes)) return fail('code', 'この合言葉は見つかりません。打ち間違いがないか確かめてください');
      if (demo.codes[code]) return fail('used', 'この合言葉はもう使われています');
      demo.codes[code] = true;
      demo.member = true;
    }
  }
  if (action === 'use') {
    if (demo.used.indexOf(data.shop) >= 0) return fail('usedToday', data.shop + ' の特典は今日はもう使いました');
    demo.used.push(data.shop);
  }
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: true,
          user: { name: 'お試しユーザー' },
          member: demo.member ? { name: 'お試しユーザー', expires: demo.expired ? '2026-04-30' : '2027-04-30', expired: demo.expired } : null,
          shops: ['石橋カレー', '喫茶まちかど', '古本ハシモト'],
          usedToday: demo.used.slice(),
        }),
      300,
    ),
  );
}

start();
