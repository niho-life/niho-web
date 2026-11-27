# 公開生成物と配信

Studio-native site の公開出力を、編集・書込みを持つ Studio Worker と read-only の公開 Worker に分けます。公開操作が作った HTML と manifest を R2 に保存し、公開 Worker は D1 の現在の manifest pointer と R2 の生成物を読んで返します。

## 現在の縦切り

- 固定ページと CMS route を公開すると、版付き R2 正本または CMS release snapshot から HTML とサイト共通の SEO 出力を生成し、HTML・sitemap・robots.txt・llms.txt と manifest を内容 hash 付きの R2 key で保存します。[ページ正本と操作](studio-managed-sites.md#ページ正本と操作)
- 公開時はサイト全体を順に再生成します。指定したページだけ下書きを使い、それ以外は公開中の版から作ります。HTMLが同じURLは既存の生成物を参照し、共通設定の再生成では sitemap の `lastmod` を維持します。
- CMS の予約公開を含む release は、CMS release pointer と公開 manifest pointer を同一 D1 batch で更新します。生成に失敗した URL があればどちらも切り替えません。
- 1ページ公開の結果には変わった URL・処理時間・SEO 警告を含めます。Studio は URL と警告の件数・先頭3件を表示し、`niho-edit --studio publish` の JSON 応答は警告一覧を保持します。
- slashの有無だけが異なる公開URLは正規routeへ `301` で転送し、query stringを保ちます。HTMLを入力にする単独の検査関数は [公開HTMLのSEO検査](managed-html-seo-checks.md) を参照してください。
- `managed_site_publication_state` の manifest pointer は D1 の version を条件に更新します。pointer が変わっていた公開は `409` になり、保存済みの古い manifest で新しい公開を上書きしません。
- `managed_page_publications` に HTML key、digest、manifest key、path、Content-Type、CSP を保存します。復元公開は新しく作ったページ revision をmanifestにも記録し、ページpointer・公開版・HTML digestを照合します。CMS binding を持つページの復元も、対象 CMS release から静的 artifact を作り直して manifest と同時に切り替えます。
- sitemap と llms.txt は、本文を読み直さず、目録のURL・タイトル・説明から作ります。
- 検証hostまたはサイト全体をnoindexにしたhostは、`robots.txt` で全体を拒否し、sitemapとllmsの一覧を空にして返します。noindex応答にも本文に対応する ETag を付けます。
- `managed_site_hosts` は hostname と path prefix を site に結び付けます。verification host には `noindex=1` を保存し、200・304・307・404・503 の全応答に `X-Robots-Tag: noindex, nofollow` を付けます。
- HTML は `Cache-Control: no-cache` と digest の ETag を返します。検証hostもETag再検証を使います。
- 公開画像は、許可済みメディア origin の JPEG / PNG / WebP / AVIF に限り、HTML に `width=auto,format=auto` の fallback URL と幅別の `srcset` を出します。`sizes` は既定で `100vw` です。幅別候補は 320〜2560 CSS px で、Client Hints を使わない iPhone などでも表示幅に応じた画像を選べます。`loading="lazy"` が明示された画像を除き、ページ内の最初の画像には `fetchpriority="high"` を付けます。それ以外の画像には指定がない場合 `loading="lazy"` と `decoding="async"` を付けます。明示された `loading` と `decoding` は保持します。GIF と許可外 origin は変換しません。[独自ドメインの切替と切戻し](site-domain-cutover-runbook.md)
- 公開HTMLの既定フォントは `system-ui` と日本語の OS フォント fallback を使います。公開 Worker の CSP は `font-src 'none'` とし、Web フォントを読み込みません。
- 公開 Worker は host 対応表と公開 manifest pointer を isolate 内で最大5秒保持します。配信は選んだ目録のルート・公開設定・生成物を使用します。HTML artifactはhost origin・site ID・manifest publication ID・本文digestを含むCache API keyで再利用し、NIHO接続先の解決応答はcacheしません。
- `studio/public-sites.wrangler.json` が公開 Worker の entry point です。Studio と同じ D1/R2 bindings を読みます。Worker のコードにはD1/R2書込み操作を置きません。Cloudflare binding自体のread-only権限は別途強制できません。
- `studio:build` は公開 Worker 用 `dist/public-sites` に `/_niho/` の hash 付きランタイムだけを生成します。公開 Worker はそのパスの許可形式だけを静的 asset binding 経由で返します。Studio の dashboard asset は公開配信用 directory に入りません。

`PUBLIC_SITES_PREVIEW_ORIGIN` を Studio Worker に設定すると、新規 managed site の hostname/path prefix が `noindex=1` で登録されます。公開 Worker 側にも同じ origin を設定すると、D1 障害時を含む未登録hostのエラー応答にも noindex を付けます。公開hostの割当ては Cloudflare の Custom Domain/Route と合わせて行います。

## TTFB の比較

`scripts/compare-public-ttfb.mjs` は、同じ route を基準 host と候補 host に順番を交互にして要求し、最初の要求と後続要求の TTFB を JSON で出します。計測は対象地域のネットワークから実行し、`--location` に地域を記録します。

```sh
node scripts/compare-public-ttfb.mjs \
  --baseline https://baseline.example \
  --candidate https://preview.example \
  --path / --path /en/ \
  --warm-samples 10 \
  --location Japan
```

最初の要求は cold isolate の proxy 値として扱います。HTTP だけでは isolate が cold だったことを確認できないため、cold 計測は対象 route がしばらく要求されていない状態から開始し、後続の反復要求を warm 値として記録します。

## 未完了の接続

- manifest の更新は CAS で競合を拒否します。最新manifestと下書きから数回再生成する自動retryは未実装です。
- 翻訳は #485、既存redirectの取込みと95 URLの受入は #489 に残ります。共通スタイルの公開でも全ページを再生成します。埋め込み・計測の実サイト受入は #486 に残ります。
- 既存の `/s/<slug>/` origin は従来の配信経路を維持します。新しい公開 Worker へ切り替えるhostは、完全なmanifestの受入後に割り当てます。

この契約は、静的ページ・CMS route の生成とmanifest pointerによる公開切替を対象にします。実サイト95 URLの受入は #489 の完了条件として別に確認します。
