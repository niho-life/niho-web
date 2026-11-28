export const NIHO_EDIT_USAGE = `niho-edit --origin <https-origin> --site <site-id> mcp
niho-edit --origin <https-origin> --site <site-id> discover
niho-edit [--studio] --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> outline <page-id> --locale <locale> [--node <id>] [--depth <n>]
niho-edit --origin <https-origin> --site <site-id> find <page-id> --locale <locale> (--text <text> | --name <name> | --tag <tag> | --style <property=value> | --uses-token <name> | --block <id> | --node <id>)
niho-edit --origin <https-origin> --site <site-id> find --url <public-url> --locale <locale> --node <data-nw-node>
niho-edit --origin <https-origin> --site <site-id> get <page-id> <node-id> --locale <locale> [--effective-style]
niho-edit --origin <https-origin> --site <site-id> apply <page-id> --locale <locale> [--ops <file|->] [--cms-bindings <file|->] [--dry-run] [--expected-version <version>] [--operation-id <uuid-v4>]
niho-edit --studio --origin <https-origin> --site <site-id> apply <page-id> --locale <locale> [--ops <file|->] [--cms-bindings <file|->] [--dry-run] [--expected-version <version>] [--operation-id <uuid-v4>]
niho-edit --origin <https-origin> --site <site-id> lint <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> lint all
niho-edit normalize analyze --json <入力ファイル|->
niho-edit normalize plan --json <入力ファイル|->
niho-edit [--studio] --origin <https-origin> --site <site-id> normalize apply --json <計画ファイル> --checkpoint <記録ファイル> [--approve <提案ID> ...]
niho-edit [--studio] --origin <https-origin> --site <site-id> normalize resume --json <記録ファイル>
niho-edit [--studio] --origin <https-origin> --site <site-id> normalize undo --json <記録ファイル>
niho-edit [--studio] --origin <https-origin> --site <site-id> normalize verify --json <記録ファイル>
niho-edit --origin <https-origin> --site <site-id> preview <page-id> --locale <locale> --widths 375,768,1280 [--compare published] [--out <dir>]
niho-edit [--studio] --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->
niho-edit [--studio] --origin <https-origin> --site <site-id> release-plan <page-id> --locale <locale> --action <publish|rollback> (--json <snapshot-file|-> | --expected-version <version>) [--revision <number>]
niho-edit [--studio] --origin <https-origin> --site <site-id> release <page-id> --locale <locale> --json <plan-file|-> --operation-id <uuid-v4>
niho-edit [--studio] --origin <https-origin> --site <site-id> publish <page-id> --locale <locale> (--expected-version <version> | --json <snapshot-file|->)
niho-edit --studio --origin <studio-origin> --site <site-id> publish <page-id> <page-id> [...] --locale <locale>
niho-edit --studio --origin <studio-origin> --site <site-id> changes
niho-edit --studio --origin <studio-origin> --site <site-id> pull [dir]
niho-edit --studio --origin <studio-origin> --site <site-id> check [dir] [--all] [--html <out-dir>]
niho-edit --studio --origin <studio-origin> --site <site-id> push [dir]
niho-edit --studio --origin <studio-origin> --site <site-id> site-history
niho-edit --studio --origin <studio-origin> --site <site-id> rollback <release-id>
niho-edit --studio --origin <studio-origin> --site <site-id> publish --site
niho-edit --studio --origin <studio-origin> --site <site-id> publish --changed
niho-edit --studio --origin <studio-origin> --site <site-id> publish --all
niho-edit [--studio] --origin <https-origin> --site <site-id> history <page-id> --locale <locale> [--cursor <cursor>]
niho-edit [--studio] --origin <https-origin> --site <site-id> restore <page-id> <revision> --locale <locale> (--expected-version <version> | --json <snapshot-file|->)
niho-edit --origin <https-origin> --site <site-id> page-release-set-plan --json <items-file|-> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> page-release-set-apply --json <plan-file|->
niho-edit --origin <https-origin> --site <site-id> page-release-set-status --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> breakpoints-read
niho-edit --origin <https-origin> --site <site-id> breakpoints-save --json <settings-snapshot-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> site-seo-read
niho-edit --studio --origin <studio-origin> --site <site-id> site-seo-save --json <settings-snapshot-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> site-public-read
niho-edit --studio --origin <studio-origin> --site <site-id> site-public-save --json <public-settings-snapshot-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> site-redirects-read
niho-edit --studio --origin <studio-origin> --site <site-id> site-redirects-save --json <redirect-snapshot-file|->
niho-edit [--studio] --origin <https-origin> --site <site-id> styles read
niho-edit [--studio] --origin <https-origin> --site <site-id> styles edit --json <edit-request-file|->
niho-edit [--studio] --origin <https-origin> --site <site-id> styles publish --json <publish-request-file|->
niho-edit [--studio] --origin <https-origin> --site <site-id> pages-catalog
niho-edit --studio --origin <studio-origin> --site <site-id> page-change --expected-version <version> --json <change-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> page-embed-register <page-id> --locale <locale> --json <embed-file|->
niho-edit --origin <https-origin> --site <site-id> page-change-prepare --expected-version <version> --json <change-file|->
niho-edit --origin <https-origin> --site <site-id> page-change-apply --json <plan-file|->
niho-edit --origin <https-origin> --site <site-id> cms-schema
niho-edit --studio --origin <studio-origin> --site <site-id> cms-schema-plan --json <schema-draft-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> cms-schema-apply --json <schema-plan-file|-> [--confirm-data-loss]
niho-edit --origin <https-origin> --site <site-id> cms-list <collection-id>
niho-edit --origin <https-origin> --site <site-id> cms-read <collection-id> <item-id>
niho-edit --origin <https-origin> --site <site-id> cms-create <collection-id> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> cms-save <collection-id> <item-id> --json <item-snapshot|-> --operation-id <uuid-v4>
niho-edit cms-diff --base <item-snapshot> --json <edited-item-snapshot>
niho-edit --origin <https-origin> --site <site-id> cms-publish-plan <collection-id> <item-id> --expected-version <version> --operation-id <uuid-v4> [--redirect <true|false>]
niho-edit --origin <https-origin> --site <site-id> cms-publish --json <publish-plan|->
niho-edit --studio --origin <studio-origin> --site <site-id> cms-publish <collection-id> <item-id> --expected-version <version> --operation-id <uuid-v4> [--redirect <true|false>]
niho-edit --origin <https-origin> --site <site-id> cms-status --operation-id <uuid-v4>
niho-edit --studio --origin <studio-origin> --site <site-id> cms-discover
niho-edit --studio --origin <studio-origin> --site <site-id> cms-v2 <cms.operation> --json <input-file|-> [--operation-id <uuid-v4>]
Use --studio with existing cms-* commands for a Studio-native site.
niho-edit --origin <https-origin> --site <site-id> assets-list [--search <text>] [--kind <kind>] [--provider <provider>] [--limit <number>] [--cursor <cursor>] [--folder-id <id>] [--recent]
niho-edit --origin <https-origin> --site <site-id> assets-usages <provider> <asset-id>
niho-edit --origin <https-origin> --site <site-id> assets-resolve --json <references-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> assets-resolve --json <references-file|->
niho-edit --origin <https-origin> --site <site-id> assets-update <provider> <asset-id> --json <update-file|->
niho-edit --origin <https-origin> --site <site-id> assets-upload <file> --mime-type <mime> --provider <provider> [--name <name>] [--folder-id <id>] [--upload-origin <https-origin>]
niho-edit --origin <https-origin> --site <site-id> assets-delete <provider> <asset-id> --expected-version <version>
niho-edit --origin <https-origin> --site <site-id> assets-restore <provider> <asset-id> --expected-version <version>
niho-edit --origin <https-origin> --site <site-id> localization-overview
niho-edit --origin <https-origin> --site <site-id> localization-items-list [--cursor <cursor>]
niho-edit --origin <https-origin> --site <site-id> localization-items-read <item-key>
niho-edit --origin <https-origin> --site <site-id> localization-items-command <item-key> --json <input-file|->
niho-edit --origin <https-origin> --site <site-id> localization-items-translate <item-key> --json <input-file|->
niho-edit --origin <https-origin> --site <site-id> localization-jobs-read <job-id>
niho-edit --origin <https-origin> --site <site-id> localization-catalog-advance --json <input-file|->
niho-edit --origin <https-origin> --site <site-id> localization-preview <item-key> <preview-id> [--cursor <cursor>]
niho-edit --origin <https-origin> --site <site-id> localization-release-read
niho-edit --origin <https-origin> --site <site-id> localization-release-prepare --json <input-file|->
niho-edit --origin <https-origin> --site <site-id> localization-release-apply --json <input-file|->
niho-edit --origin <https-origin> --site <site-id> localization-settings-save --json <input-file|->

Set NIHO_EDIT_TOKEN to a short-lived bearer token. read returns { document, version }.
Edit document while keeping version, then pass the snapshot to save for version-checked persistence.
Review the release plan before applying it. Keep and reuse the same operation ID when retrying a release.
styles read returns { draft: { version, styles }, published: { version, styles } }. styles edit accepts { expectedVersion, edits }; rename rewrites references atomically and a referenced delete reports usages. styles publish accepts { expectedDraftVersion, expectedPublishedVersion }.
site-seo-read returns { settings, version } with the version shared by the site's public settings. Edit its settings object and pass the snapshot to site-seo-save; the write uses version checking. The SEO fields include site name, description, default OGP image, verification tags, organization data, robots policy, and GA4 measurement ID.
site-public-read は独自ドメインと許可 origin を個別の版付きで返します。編集した snapshot を site-public-save に渡します。
page-embed-register には { "src": "NIHOで発行した埋め込みURL" } を渡します。結果の refId をページの ManagedEmbed ブロックに設定して保存します。
site-redirects-read returns { redirects, version }. Edit the redirects array and pass the snapshot to site-redirects-save; the write uses version checking. Each entry is { locale, fromPath, toPath }; paths are site-local and each fromPath can appear once. Invalid paths, duplicates, and redirect loops are rejected.
For a page release set, items-file contains 1 to 50 items: { "items": [{ "target": { "siteId", "pageId", "locale" }, "expectedVersion", "componentsVersion?", "presentationVersion?" }, ...] }.
The plan is bound to the changed targets and versions. Results report each page as released, conflict, or pending.
Apply the same saved plan again after a timeout to resume unfinished pages without republishing completed pages, then query page-release-set-status with its operation ID.
pull はサイトを dir（既定は .）へ書き出します。pages/<locale>/<page-id>.json、cms/<collection-id>/<item-id>.json、site/seo.json・redirects.json・public.json・styles.json を編集し、版と操作 ID を持つ .niho/ は触りません。check はサーバーに問い合わせず、変わったファイル（--all で全ファイル）を検証し、--html で本文の参考描画も書きます。push は変わったファイルだけを版照合付きで下書きに保存します（公開しません）。競合したファイルは保存せず報告し、ほかのファイルの保存は続けます。公開は publish --changed です。
lint は指定したページ、または catalog にある全ページの問題をJSONで表示します。問題があれば終了コード1、なければ0です。normalize analyze と plan はローカルで実行します。apply は版照合付きで適用し、状態を記録します。色の置換と表示幅の変更には --approve が必要です。resume は未確定のページ操作を再試行し、undo は適用済みの変更を戻します。verify は現在の文書を読み直して描画入力を比較します。

Studio 内サイトの GUI 操作と niho-edit --studio の対応
  GUI 操作                                  CLI コマンド
  ページの一覧・作成・URL・公開状態           pages-catalog → page-change
  ページの読取・下書き編集・CMS ブロック設定  read → apply / save
  ページの公開・版履歴・復元                  publish <page-id> / history / restore
  未公開変更の一覧・一括公開                  changes → publish --changed
  サイト全体の公開履歴・復元                  site-history / rollback <release-id>
  共通設定の公開                              publish --site
  全ページ再生成（移行・コード変更時のみ）    publish --all
  NIHO フォームの接続                        page-embed-register → apply / save
  独自ドメイン・noindex・許可 origin           site-public-read → site-public-save
  サイト共通 SEO                             site-seo-read → site-seo-save
  サイト共通スタイル                         styles read / edit / publish
  旧 URL の転送                              site-redirects-read → site-redirects-save
  CMS の項目一覧・作成・編集・公開            cms-list / cms-create / cms-read / cms-save / cms-publish
  CMS のプレビュー・公開予約・取下げ・ごみ箱  cms-v2（操作は cms-discover で確認）
  CMS の定義を編集                           cms-schema / cms-schema-plan / cms-schema-apply
  CMS の翻訳と locale 公開                   localization-* または cms-v2

素材ライブラリは、Studio 内サイトの GUI では提供していません。サイト共通スタイルは、Studio GUI と \`niho-edit --studio styles\` で共通操作を使います。
Studio-native site の未公開変更は GUI と CLI 共通の一覧です。`;

const commandUsageLines = NIHO_EDIT_USAGE.split("\n")
  .filter((line) => line.startsWith("niho-edit "))
  .map((line) => {
    const command = line.replace(/^niho-edit\s+(?:(?:--studio|\[--studio\])\s+)?--origin <[^>]+> --site <[^>]+>\s+/u, "").replace(/^niho-edit\s+/u, "").split(/\s/u)[0];
    return [command, line];
  })
  .filter(([command]) => command && !["mcp", "normalize"].includes(command));

export const NIHO_EDIT_COMMANDS = Object.freeze([...new Set(commandUsageLines.map(([command]) => command))]);
export const NIHO_EDIT_COMMAND_USAGE = Object.freeze(Object.fromEntries(
  NIHO_EDIT_COMMANDS.map((command) => [command, commandUsageLines.filter(([name]) => name === command).map(([, line]) => line).join("\n")])
));
