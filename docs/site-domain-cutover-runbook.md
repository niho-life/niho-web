# 独自ドメインの切替と切戻し

Studio-native site の独自ドメインを、公開配信 Worker へ割り当てる運用手順です。実際の hostname、DNS 値、Worker 名、Cloudflare の zone / account 情報はこの公開リポジトリへ記録しません。

## 前提

- #527 が完了し、鎌倉の全ページ・CMS 詳細・日英・素材が検証用 host で公開済みであること。
- `npm run studio:public:release` が成功し、検証用 `workers.dev` host から HTML と `X-Robots-Tag: noindex, nofollow` が返ること。このコマンドは検証用 Worker の配備と smoke を行い、独自ドメインや Route は作成しません。
- 検証用 host で、固定ページ・CMS 詳細・フォーム・埋め込み・計測・画像を確認すること。フォームはテストデータを使います。
- Studio の host 設定で、本番 hostname が path prefix `/`・主 host・`noindex=false` として登録されていること。検証用 host は `noindex=true` のままにします。
- 主 host を変更した後、#527 の全件公開操作で HTML と discovery files を作り直し、canonical・hreflang・sitemap が本番 hostname を指すこと。
- 作業直前に、現在の DNS record（type / name / target / proxy / TTL）と Worker の route / Custom Domain 割当てを控える。記録は非公開の運用記録に保管します。

Cloudflare の [Routes と Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/) は用途が異なります。Route は zone の proxied DNS record を使い、Custom Domain は Worker を hostname の origin にします。

## 切替

### 既存の proxied DNS record がある場合

既存サイトへすぐ戻せる状態を保つため、Route を追加します。Cloudflare は Route を既存 Custom Domain の前段で処理できるため、DNS record と旧 Worker の割当てを残せます。

1. Cloudflare Dashboard で対象 zone の Workers & Pages を開き、公開配信 Worker の Settings → Domains & Routes → Add → Route を選びます。
2. 切り替える hostname ごとに `example.com/*` のような Route を追加します。apex と `www` の両方を使う場合は別々に設定します。
3. DNS record は変更せず、Route が公開配信 Worker を指していることを確認します。
4. 後述の受入確認を行います。

### Custom Domain を使う場合

対象 hostname が Cloudflare zone 内にあり、既存 CNAME が無い場合に使います。Custom Domain の追加後、Cloudflare が DNS record と証明書を作成します。

1. 現行 DNS record と旧 Worker の割当てを非公開の運用記録に保存します。
2. Workers & Pages → 対象 Worker → Settings → Domains & Routes → Add → Custom Domain を開き、hostname を追加します。
3. Cloudflare が DNS record と証明書を作成したこと、対象 hostname が公開配信 Worker に結び付いたことを確認します。
4. 後述の受入確認を行います。

## 受入確認

運用端末で確認対象を設定し、少なくとも次を確認します。

```sh
PUBLIC_HOST=example.com
curl -fsSI "https://${PUBLIC_HOST}/"
curl -fsS "https://${PUBLIC_HOST}/" | rg -i 'canonical|hreflang'
curl -fsS "https://${PUBLIC_HOST}/robots.txt"
curl -fsS "https://${PUBLIC_HOST}/sitemap.xml" | rg -F "https://${PUBLIC_HOST}/"
```

- HTML が `200`、`Content-Type: text/html`、ETag を返し、本番 hostname に `X-Robots-Tag: noindex` が付いていない。
- canonical と hreflang が本番 hostname を指し、robots.txt と sitemap.xml が意図した内容を返す。
- 日本語・英語・CMS の代表 URL が `200`、未公開 URL が `404` を返す。
- HTML の承認済み画像 URL に `width=auto,format=auto` があり、実際に取得できる。画像の応答幅が端末に合い、`Content-Type` はブラウザーの対応形式に応じて AVIF または WebP（対応しない場合は元形式）になる。
- フォームと許可した埋め込みが動き、CSP がそれらの読み込みを許可する。

切替後の LCP / Core Web Vitals は、この runbook の受入に含めません。#527 完了後、検証用 host に鎌倉全量が出た状態で別途計測します。

## 切戻し

公開配信で 5xx、誤った canonical / sitemap、主要ページや画像の欠落、フォーム・埋め込みの障害を確認したら、Cloudflare の割当てを元に戻します。

### Route で切り替えた場合

1. Cloudflare Dashboard で今回追加した Route を削除します。
2. DNS record は変更しません。旧 Route または旧 Custom Domain が元どおり有効であることを確認します。
3. 旧サイトのトップページと主要ページが返ることを確認します。

### Custom Domain を付け替えた場合

1. 新しい公開配信 Worker から Custom Domain を削除します。
2. 非公開運用記録に保存した DNS record と旧 Worker の割当てを復元します。Cloudflare が自動作成した DNS record が残っていないことも確認します。
3. DNS の解決先、証明書、旧 Worker の割当てを確認し、旧サイトのトップページと主要ページが返ることを確認します。

切戻し後も Studio の host 登録と公開物は調査・再切替用に保持し、DNS / Worker の復元状態と混同して削除しません。原因を直し、検証用 host で受入をやり直してから再切替します。

Cloudflare の画面名や設定は変更される場合があるため、作業時は公式の [Custom Domains 手順](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) と [Routes 手順](https://developers.cloudflare.com/workers/configuration/routing/routes/) を確認します。
