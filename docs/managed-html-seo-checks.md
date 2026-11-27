# 公開HTMLのSEO検査

`studio/managed-html-seo-checks.ts` の `inspectManagedHtmlSeo(html, options)` は、HTML文字列から公開時の警告を返す副作用のない関数です。ネットワーク、DB、R2には接続しません。

`options` にはページの `locale`、相対URLを解決する絶対URLの `pageUrl`、同じサイトで公開済みのroute path一覧 `knownPaths` を渡します。`knownPaths` には公開URLのsite prefixを含めます。末尾slashの有無は同じrouteとして扱い、queryとfragmentはroute照合に含めません。

警告は次の3種類です。

| code | 検査内容 |
| --- | --- |
| `missing-alt` | `img` に空でない `alt` がない |
| `japanese-in-english` | localeが `en` で、script/style/commentを除いた本文に日本語文字がある |
| `broken-internal-link` | 同じoriginのHTTP(S)リンクが `knownPaths` にない |

検査対象HTMLは最大2,000,000文字、既知routeは最大10,000件です。警告は最大100件、各messageは最大1,000文字で返します。壊れたURLは文書検証の責務として無視します。検査は公開を止めず、現時点では公開処理にも接続しません。公開処理への接続は #527 の共通公開経路に合わせて行います。
