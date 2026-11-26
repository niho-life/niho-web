# ADR 0002: CMS とページの結び付け

Issue #377 の設計判断。

## 決定

CMS の結び付けは `PageDocument` へ追加せず、別の `CmsPageBindingsDocument` sidecar として保存する。文書は `schemaVersion` と `siteId`・`pageId`・`locale` を持つ。保存 revision は sidecar 単独では発行せず、格納する下書き page revision と公開 page revision に従う。コレクション ID・不変の `fieldId`・絞り込み・並べ替え・件数・要素 ID と対象値を宣言する。実行コード、任意 HTML、任意 URL は保持しない。

ページ版と結び付け文書は同じ下書き・公開 snapshot の一部として CAS し、公開 page publication は利用した CMS release ID と schema revision も固定する。公開表示はその snapshot 内の CMS 項目だけから解決する。ページと CMS release は個別に確認・公開し、両者をまたぐ原子切替は約束しない。編集 preview は認証済み actor と site・page・CMS item revision に固定した短命の一回限り capability を通し、下書きを公開配信へ混ぜない。

CMS のリストと詳細は同じ検証済みフィールド解決関数を使う。未知の collection / `fieldId`、対応しない値型、壊れたノード参照は保存・公開計画で拒否する。CMS schema の移行計画は全ページの結び付けを検査し、影響を表示してから適用する。過去の公開 snapshot と結び付けは変更しない。

## 理由

`PageDocument` は schemaVersion 1 の完全一致検証を行い、通常ページ・既存 renderer・ホスト API で広く使われる。CMS のデータ依存を別契約に分けると、既存文書を再解釈せずに公開 snapshot 内で結び付けの版を固定できる。ページ構造と CMS 定義の変更も別々に計画・検証できる。

## 結果

- 既存の `PageDocument` v1 と `parsePageDocument` の意味は変えない。
- Studio-native CMS を Studio の将来の CMS 正本とし、owner だけが定義変更を適用できる。editor は項目の公開を行える。
- ページの読み書き、preview、公開、履歴、AI 操作は CMS bindings 対応を明示した adapter / operation だけで有効にする。
- Studio-native ではページ文書と bindings を一緒に保存・公開する。既存ホストは従来どおり bindings なしで動く。
- CMS の素材 URL・公開可否は結び付け文書に埋め込まず、素材 manifest 契約 (#379) に委ねる。
