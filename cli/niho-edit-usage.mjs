export const NIHO_EDIT_USAGE = `niho-edit --origin <https-origin> --site <site-id> mcp
niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> outline <page-id> --locale <locale> [--node <id>] [--depth <n>]
niho-edit --origin <https-origin> --site <site-id> find <page-id> --locale <locale> (--text <text> | --name <name> | --tag <tag> | --style <property=value> | --uses-token <name> | --block <id> | --node <id>)
niho-edit --origin <https-origin> --site <site-id> find --url <public-url> --locale <locale> --node <data-nw-node>
niho-edit --origin <https-origin> --site <site-id> get <page-id> <node-id> --locale <locale> [--effective-style]
niho-edit --origin <https-origin> --site <site-id> apply <page-id> --locale <locale> --ops <file|-> [--dry-run] [--expected-version <version>] [--operation-id <uuid-v4>]
niho-edit --origin <https-origin> --site <site-id> preview <page-id> --locale <locale> --widths 375,768,1280 [--compare published] [--out <dir>]
niho-edit --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> release-plan <page-id> --locale <locale> --action <publish|rollback> (--json <snapshot-file|-> | --expected-version <version>) [--revision <number>] [--styles-version <published-version> --site-publication-epoch <epoch>]
niho-edit --origin <https-origin> --site <site-id> release <page-id> --locale <locale> --json <plan-file|-> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> page-release-set-plan --json <items-file|-> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> page-release-set-apply --json <plan-file|->
niho-edit --origin <https-origin> --site <site-id> page-release-set-status --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> breakpoints-read
niho-edit --origin <https-origin> --site <site-id> breakpoints-save --json <settings-snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> styles-read
niho-edit --origin <https-origin> --site <site-id> styles-save --json <styles-snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> styles-release-plan --json <release-request-file|->
niho-edit --origin <https-origin> --site <site-id> styles-release --json <release-plan-file|->
niho-edit --origin <https-origin> --site <site-id> styles-migration-plan --json <migration-request-file|->
niho-edit --origin <https-origin> --site <site-id> styles-migration-apply --json <migration-plan-file|->
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
styles-read returns { sitePublicationEpoch, draft: { version, styles }, published: { stylesVersion, styles } }. For styles-save, pass { version: draft.version, styles }.
styles-release-plan input uses { expectedVersion: draft.version, expectedStylesVersion: published.stylesVersion, sitePublicationEpoch, operationId } from the latest styles-read snapshot.
For a page release set, items-file contains 1 to 50 items: { "items": [{ "target": { "siteId", "pageId", "locale" }, "expectedVersion", "componentsVersion?", "presentationVersion?" }, ...] }.
The plan is bound to the changed targets and versions. Results report each page as released, conflict, or pending.
Apply the same saved plan again after a timeout to resume unfinished pages without republishing completed pages, then query page-release-set-status with its operation ID.`;

const commandUsageLines = NIHO_EDIT_USAGE.split("\n")
  .filter((line) => line.startsWith("niho-edit "))
  .map((line) => {
    const command = line.replace(/^niho-edit\s+(?:--studio\s+)?--origin <[^>]+> --site <[^>]+>\s+/u, "").replace(/^niho-edit\s+/u, "").split(/\s/u)[0];
    return [command, line];
  })
  .filter(([command]) => command && command !== "mcp");

export const NIHO_EDIT_COMMANDS = Object.freeze([...new Set(commandUsageLines.map(([command]) => command))]);
export const NIHO_EDIT_COMMAND_USAGE = Object.freeze(Object.fromEntries(
  NIHO_EDIT_COMMANDS.map((command) => [command, commandUsageLines.filter(([name]) => name === command).map(([, line]) => line).join("\n")])
));
