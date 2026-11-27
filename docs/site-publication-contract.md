# 公開生成物と配信

Studio-native site の公開出力を、編集・書込みを持つ Studio Worker と read-only の公開 Worker に分けます。公開操作が作った HTML と manifest を R2 に保存し、公開 Worker は D1 の現在の manifest pointer と R2 の生成物を読んで返します。

## 現在の縦切り

- 固定ページを公開すると、版付き R2 正本の digest を照合して HTML を生成し、HTML と manifest を内容 hash 付きの R2 key で保存します。[ページ正本と操作](studio-managed-sites.md#ページ正本と操作)
- `managed_site_publication_state` の manifest pointer は D1 の version を条件に更新します。pointer が変わっていた公開は `409` になり、保存済みの古い manifest で新しい公開を上書きしません。
- `managed_page_publications` に HTML key、digest、manifest key、path、Content-Type、CSP を保存します。読み出し時はmanifest・publication・現在のページpointerの対応と、HTML digestを照合します。
- `managed_site_hosts` は hostname と path prefix を site に結び付けます。verification host には `noindex=1` を保存し、200・304・307・404・503 の全応答に `X-Robots-Tag: noindex, nofollow` を付けます。
- HTML は `Cache-Control: no-cache` と digest の ETag を返します。検証hostもETag再検証を使います。
- `studio/public-sites.wrangler.json` が公開 Worker の entry point です。Studio と同じ D1/R2 bindings を読みます。Worker のコードにはD1/R2書込み操作を置きません。Cloudflare binding自体のread-only権限は別途強制できません。

`PUBLIC_SITES_PREVIEW_ORIGIN` を Studio Worker に設定すると、新規 managed site の hostname/path prefix が `noindex=1` で登録されます。公開 Worker 側にも同じ origin を設定すると、D1 障害時を含む未登録hostのエラー応答にも noindex を付けます。公開hostの割当ては Cloudflare の Custom Domain/Route と合わせて行います。

## 未完了の接続

- CMS bindingを持つページは、公開時生成にまだ含めません。#490 で一覧・詳細ページの依存を確定した後に追加します。
- manifest の更新は CAS で競合を拒否します。最新manifestと下書きから数回再生成する自動retryは未実装です。
- 翻訳・埋め込み・計測・サイト全体SEO出力・全ページのstyle再生成は、それぞれ #485、#486、#489、#483 と残りの #510 作業で接続します。
- 既存の `/s/<slug>/` origin は従来の配信経路を維持します。新しい公開 Worker へ切り替えるhostは、完全なmanifestの受入後に割り当てます。

この状態では、公開ページ1枚の静的生成・配信とverification hostのnoindexまでを確認できます。#510 の完了条件ではありません。
