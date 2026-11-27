# 公開生成物と配信

Studio-native site の公開出力を、編集・書込みを持つ Studio Worker と read-only の公開 Worker に分けます。公開操作が作った HTML と manifest を R2 に保存し、公開 Worker は D1 の現在の manifest pointer と R2 の生成物を読んで返します。

## 現在の縦切り

- 固定ページを公開すると、版付き R2 正本の digest を照合して HTML とサイト共通の SEO 出力を生成し、HTML・sitemap・robots.txt・llms.txt・llms-full.txt と manifest を内容 hash 付きの R2 key で保存します。[ページ正本と操作](studio-managed-sites.md#ページ正本と操作)
- 1ページ公開の結果には公開 URL と SEO 警告を含めます。Studio は URL と警告の件数・先頭3件を表示し、`niho-edit --studio publish` の JSON 応答は警告一覧を保持します。
- slashの有無だけが異なる公開URLは正規routeへ `301` で転送し、query stringを保ちます。HTMLを入力にする単独の検査関数は [公開HTMLのSEO検査](managed-html-seo-checks.md) を参照してください。
- `managed_site_publication_state` の manifest pointer は D1 の version を条件に更新します。pointer が変わっていた公開は `409` になり、保存済みの古い manifest で新しい公開を上書きしません。
- `managed_page_publications` に HTML key、digest、manifest key、path、Content-Type、CSP を保存します。復元公開は新しく作ったページ revision をmanifestにも記録し、ページpointer・公開版・HTML digestを照合します。
- SEO出力は現在の公開route集合から生成します。公開Workerはdiscovery fileを返す前にmanifestと現在の公開route集合を照合し、ずれがあれば `503` で閉じます。これにより公開を外したページのURLや本文が sitemap / llms に残り続けません。
- 検証hostまたはサイト全体をnoindexにしたhostは、`robots.txt` で全体を拒否し、sitemapとllmsの一覧を空にして返します。noindex応答にも本文に対応する ETag を付けます。
- `managed_site_hosts` は hostname と path prefix を site に結び付けます。verification host には `noindex=1` を保存し、200・304・307・404・503 の全応答に `X-Robots-Tag: noindex, nofollow` を付けます。
- HTML は `Cache-Control: no-cache` と digest の ETag を返します。検証hostもETag再検証を使います。
- 公開画像は、許可済みメディア origin の JPEG / PNG / WebP / AVIF に限り、HTML に `width=auto,format=auto` の画像 URL を出します。Cloudflare は client hints、または User-Agent の幅区分から縮小幅を選び、対応形式に応じて AVIF / WebP を返します。GIF と許可外 origin は変換しません。[独自ドメインの切替と切戻し](site-domain-cutover-runbook.md)
- 公開 Worker は host 対応表と公開 manifest pointer を isolate 内で最大5秒保持します。返却前にはD1で現在のmanifest pointer・公開page・visibility・host登録を照合します。HTML artifactはhost origin・site ID・manifest publication ID・本文digestを含むCache API keyで再利用し、NIHO接続先の解決応答はcacheしません。
- `studio/public-sites.wrangler.json` が公開 Worker の entry point です。Studio と同じ D1/R2 bindings を読みます。Worker のコードにはD1/R2書込み操作を置きません。Cloudflare binding自体のread-only権限は別途強制できません。
- `studio:build` は公開 Worker 用 `dist/public-sites` に `/_niho/` の hash 付きランタイムだけを生成します。公開 Worker はそのパスの許可形式だけを静的 asset binding 経由で返します。Studio の dashboard asset は公開配信用 directory に入りません。

`PUBLIC_SITES_PREVIEW_ORIGIN` を Studio Worker に設定すると、新規 managed site の hostname/path prefix が `noindex=1` で登録されます。公開 Worker 側にも同じ origin を設定すると、D1 障害時を含む未登録hostのエラー応答にも noindex を付けます。公開hostの割当ては Cloudflare の Custom Domain/Route と合わせて行います。

## 未完了の接続

- CMS bindingを持つページは、公開時生成にまだ含めません。#490 で一覧・詳細ページの依存を確定した後に追加します。
- manifest の更新は CAS で競合を拒否します。最新manifestと下書きから数回再生成する自動retryは未実装です。
- 翻訳は #485、既存redirectの取込みと95 URLの受入は #489 に残ります。styleの公開は新しく生成するHTMLに反映し、既存ページをまとめて再生成する共通経路は #527 に接続します。埋め込み・計測の実サイト受入は #486 に残ります。
- 既存の `/s/<slug>/` origin は従来の配信経路を維持します。新しい公開 Worker へ切り替えるhostは、完全なmanifestの受入後に割り当てます。

この状態では、公開ページ1枚の静的生成・配信とverification hostのnoindexまでを確認できます。#510 の完了条件ではありません。
