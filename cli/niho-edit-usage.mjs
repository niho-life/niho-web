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
niho-edit --origin <https-origin> --site <site-id> page-release-set-plan --json <items-file|-> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> page-release-set-apply --json <plan-file|->
niho-edit --origin <https-origin> --site <site-id> page-release-set-status --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> breakpoints-read
niho-edit --origin <https-origin> --site <site-id> breakpoints-save --json <settings-snapshot-file|->
niho-edit --studio --origin <studio-origin> --site <site-id> site-seo-read
niho-edit --studio --origin <studio-origin> --site <site-id> site-seo-save --json <settings-snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> styles read
niho-edit --origin <https-origin> --site <site-id> styles edit --json <edit-request-file|->
niho-edit --origin <https-origin> --site <site-id> styles publish --json <publish-request-file|->
niho-edit --origin <https-origin> --site <site-id> pages-catalog
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
niho-edit --origin <https-origin> --site <site-id> cms-status --operation-id <uuid-v4>
niho-edit --studio --origin <studio-origin> --site <site-id> cms-discover
niho-edit --studio --origin <studio-origin> --site <site-id> cms-v2 <cms.operation> --json <input-file|-> [--operation-id <uuid-v4>]
Use --studio with existing cms-* commands for a Studio-native site.
niho-edit --origin <https-origin> --site <site-id> assets-list [--search <text>] [--kind <kind>] [--provider <provider>] [--limit <number>] [--cursor <cursor>] [--folder-id <id>] [--recent]
niho-edit --origin <https-origin> --site <site-id> assets-usages <provider> <asset-id>
niho-edit --origin <https-origin> --site <site-id> assets-resolve --json <references-file|->
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
For a page release set, items-file contains 1 to 50 items: { "items": [{ "target": { "siteId", "pageId", "locale" }, "expectedVersion", "componentsVersion?", "presentationVersion?" }, ...] }.
The plan is bound to the changed targets and versions. Results report each page as released, conflict, or pending.
Apply the same saved plan again after a timeout to resume unfinished pages without republishing completed pages, then query page-release-set-status with its operation ID.
lint は指定したページ、または catalog にある全ページの問題をJSONで表示します。問題があれば終了コード1、なければ0です。normalize analyze と plan はローカルで実行します。apply は版照合付きで適用し、状態を記録します。色の置換と表示幅の変更には --approve が必要です。resume は未確定のページ操作を再試行し、undo は適用済みの変更を戻します。verify は現在の文書を読み直して描画入力を比較します。`;

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
