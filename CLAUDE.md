# 石橋パスポート（`ishibashi/`）

石橋商店街の新入生向けパスポートの、有料パス会員証ページ（LIFF）とサーバー（Google Apps Script）。仕様書は Claude Docs の「石橋パスポート 仕様書(試験版)」。あいさつメッセージ・リッチメニュー・配信・スタンプ（ショップカード）は公式LINEの標準機能で作るので、ここにコードは無い。

`lp/` は一般向けの紹介ページ（https://ryosuke-hr.github.io/ishibashi-passport/lp/ ）。JavaScript なしの `index.html` + `style.css` だけ。友だち追加リンクは `https://lin.ee/rHQqpm2`、`qr.svg` はそのリンクの QR（`npx -y qrcode@1.5.4 -t svg -e M -m 1 -o qr.svg <URL>` で作った）。

## Running

リポジトリのルートから動かす（`.claude/launch.json` の `ishibashi`）。`app.js` の `CONFIG.LIFF_ID` が空か、URL に `?demo` があると、LINE もサーバーも使わないお試しモードになる。会員登録は QR（`?code=`）だけで、合言葉を打ち込む欄は無い。お試しでは `?demo&code=TESTCODE` で登録、`?demo&code=USEDCODE` で「もう使われています」、`?demo&member` で最初から会員、`?demo&expired` で期限切れの画面。

```bash
npx -y http-server@14.1.1 ishibashi -p 8040 -c-1
```

## 設定手順（本番）

1. スプレッドシートを作り、拡張機能 > Apps Script に `server/Code.gs` を貼る。プロジェクトの設定でタイムゾーンを東京にし、スクリプトプロパティに `LINE_CHANNEL_ID`・`LIFF_URL`・`PASS_EXPIRES`・`SHOPS` を入れる（中身は `Code.gs` の先頭）。
2. デプロイ > 新しいデプロイ > ウェブアプリ（実行ユーザー「自分」、アクセス「全員」）。出てきた URL を `CONFIG.API_URL` に入れる。コードを直したら「デプロイを管理」で同じデプロイの新バージョンにする（URL が変わらない）。
3. LINE Developers で公式LINEと同じプロバイダーに LINEログインチャネルを作り、LIFF アプリ（サイズ Full、スコープ `openid` `profile`、エンドポイントは公開した `index.html` の URL）を足す。チャネルは「公開済み」にする。LIFF ID を `CONFIG.LIFF_ID` に入れる。
4. Apps Script で `makeCodes` を実行すると、codes シートに合言葉と QR が50個並ぶ。
5. 公式LINEのリッチメニュー「有料パス」のリンクを `https://liff.line.me/<LIFF ID>` にする。

## Architecture

- ページは `liff.getIDToken()` の IDトークンを毎回サーバーに送り、サーバーは LINE の `/oauth2/v2.1/verify` で本人確認してから判定する。会員かどうか・1店1日1回の判定はサーバーだけがする（ページは表示だけ）。
- リクエストは `text/plain` の POST で `{ action, idToken, ... }`。`action` は `status` / `register`（`code`）/ `use`（`shop`）。どれも成功すると `status` と同じ形 `{ ok, user, member, shops, usedToday }` を返し、失敗は `{ ok: false, error, message }`。`error: 'token'` ならページがログインし直す。
- 合言葉は8文字（`I O 0 1` を使わない）。QR は `LIFF_URL?code=XXXX` で、ページは `code` か `liff.state` の中から拾って `register` する。登録と利用は `LockService` で順番に処理し、同じ合言葉の取り合いを防ぐ。
- シートは `codes` / `members` / `uses`。無ければ見出し付きで自動で作る。店の一覧はスクリプトプロパティ `SHOPS` だけが正で、ページはサーバーから受け取る。
- 時計は毎秒 `#clock` の文字だけ書き換え、ロゴの回転とカードの光は CSS アニメーション。それ以外は `render()` で全部描き直す。保存するものが無いので `localStorage` は使わない。
- LIFF SDK（`static.line-scdn.net`）だけは外部から読む（「外部ライブラリなし」の例外）。
