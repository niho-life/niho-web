#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { createPageEditingApiClient, EditingApiClientError, isEditingApiVersion, parseEditingPageDocumentEnvelope } from "../dist/editing-client.js";
import { EDITING_OPERATIONS } from "../dist/editing-api.js";
import { editingLocalizationConflictBody, EDITING_LOCALIZATION_INPUT_BYTES } from "../dist/editing-localization.js";
import { parseAssetUploadResult } from "../dist/assets.js";
import { parseBreakpointSettings } from "../dist/style-model.js";
import { SERVICE_CLIENT_ID } from "./operations.mjs";

const USAGE = `niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> release-plan <page-id> --locale <locale> --action <publish|rollback> (--json <snapshot-file|-> | --expected-version <version>) [--revision <number>]
niho-edit --origin <https-origin> --site <site-id> release <page-id> --locale <locale> --json <plan-file|-> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> page-release-set-plan --json <items-file|-> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> page-release-set-apply --json <plan-file|->
niho-edit --origin <https-origin> --site <site-id> page-release-set-status --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> breakpoints-read
niho-edit --origin <https-origin> --site <site-id> breakpoints-save --json <settings-snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> pages-catalog
niho-edit --origin <https-origin> --site <site-id> page-change-prepare --expected-version <version> --json <change-file|->
niho-edit --origin <https-origin> --site <site-id> page-change-apply --json <plan-file|->
niho-edit --origin <https-origin> --site <site-id> cms-schema
niho-edit --origin <https-origin> --site <site-id> cms-list <collection-id>
niho-edit --origin <https-origin> --site <site-id> cms-read <collection-id> <item-id>
niho-edit --origin <https-origin> --site <site-id> cms-create <collection-id> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> cms-save <collection-id> <item-id> --json <item-snapshot|-> --operation-id <uuid-v4>
niho-edit cms-diff --base <item-snapshot> --json <edited-item-snapshot>
niho-edit --origin <https-origin> --site <site-id> cms-publish-plan <collection-id> <item-id> --expected-version <version> --operation-id <uuid-v4> [--redirect <true|false>]
niho-edit --origin <https-origin> --site <site-id> cms-publish --json <publish-plan|->
niho-edit --origin <https-origin> --site <site-id> cms-status --operation-id <uuid-v4>
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
For a page release set, items-file contains 1 to 50 items: { "items": [{ "target": { "siteId", "pageId", "locale" }, "expectedVersion", "componentsVersion?", "presentationVersion?" }, ...] }.
The plan is bound to the changed targets and versions. Results report each page as released, conflict, or pending.
Apply the same saved plan again after a timeout to resume unfinished pages without republishing completed pages, then query page-release-set-status with its operation ID.`;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_CHANGE_BYTES = 16 * 1024;
const MAX_ASSET_UPLOAD_BYTES = 50 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CMS_COLLECTION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/u;
const CMS_ITEM_ID = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}$/u;
const RESERVED_CMS_IDS = new Set(["__proto__", "constructor", "prototype"]);
function validCmsCollectionId(value) { return typeof value === "string" && CMS_COLLECTION_ID.test(value) && !RESERVED_CMS_IDS.has(value); }
function validCmsItemId(value) { return typeof value === "string" && CMS_ITEM_ID.test(value) && value !== "." && value !== ".." && !RESERVED_CMS_IDS.has(value); }

class CliError extends Error {
  constructor(readonlyCode, status = null) { super(readonlyCode); this.code = readonlyCode; this.status = status; }
}

function argsFromCli() {
  try {
    return parseArgs({ allowPositionals: true, options: {
      origin: { type: "string" }, site: { type: "string" }, locale: { type: "string" }, json: { type: "string" }, action: { type: "string" },
      "expected-version": { type: "string" }, "components-version": { type: "string" }, "presentation-version": { type: "string" },
      revision: { type: "string" }, "operation-id": { type: "string" }, redirect: { type: "string" }, base: { type: "string" }, help: { type: "boolean", short: "h" },
      name: { type: "string" }, "mime-type": { type: "string" }, provider: { type: "string" }, search: { type: "string" }, kind: { type: "string" }, "upload-origin": { type: "string" },
      "folder-id": { type: "string" }, cursor: { type: "string" }, limit: { type: "string" }, recent: { type: "boolean" }
    } });
  } catch { throw new CliError("invalid_arguments"); }
}
function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && value === url.origin) return url.origin;
  } catch { /* The URL parser message is not part of the CLI contract. */ }
  throw new CliError("invalid_origin");
}
async function readJson(stream, maximumBytes = MAX_INPUT_BYTES) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > maximumBytes) throw new CliError("input_too_large");
      chunks.push(chunk);
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("invalid_json_input");
    return value;
  } catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
}
async function inputSnapshot(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const source = await readJson(path === "-" ? process.stdin : createReadStream(path));
  const snapshotKeys = Object.keys(source);
  if (!snapshotKeys.includes("document") || !snapshotKeys.includes("version") || snapshotKeys.some((key) => !["document", "version", "componentsVersion", "presentationVersion"].includes(key))
    || !isEditingApiVersion(source.version) || source.componentsVersion !== undefined && !isEditingApiVersion(source.componentsVersion)
    || source.presentationVersion !== undefined && !isEditingApiVersion(source.presentationVersion)) throw new CliError("invalid_snapshot");
  let document;
  try { document = parseEditingPageDocumentEnvelope(source.document); } catch { throw new CliError("invalid_document"); }
  return { document, version: source.version,
    ...(source.componentsVersion === undefined ? {} : { componentsVersion: source.componentsVersion }),
    ...(source.presentationVersion === undefined ? {} : { presentationVersion: source.presentationVersion }) };
}
async function inputPlan(path, target) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const plan = await readJson(path === "-" ? process.stdin : createReadStream(path));
  const allowed = ["target", "expectedVersion", "action", "revision", "componentsVersion", "presentationVersion", "confirmationToken", "domain", "changes", "url", "affected"];
  if (Object.keys(plan).some((key) => !allowed.includes(key)) || !plan.target || typeof plan.target !== "object" || Array.isArray(plan.target)
    || Object.keys(plan.target).sort().join(",") !== "locale,pageId,siteId"
    || plan.target.siteId !== target.siteId || plan.target.pageId !== target.pageId || plan.target.locale !== target.locale
    || !isEditingApiVersion(plan.expectedVersion) || (plan.action !== "publish" && plan.action !== "rollback")
    || !isEditingApiVersion(plan.confirmationToken) || typeof plan.domain !== "string" || !Array.isArray(plan.changes)) throw new CliError("invalid_release_plan");
  if (plan.action === "publish" && plan.revision !== undefined || plan.action === "rollback" && (!Number.isSafeInteger(plan.revision) || plan.revision < 1)) throw new CliError("invalid_release_plan");
  return plan;
}
function emit(result, status = null, code = 0, operation = null) {
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify({ apiVersion: "v1", httpStatus: status, operation, result })}\n`);
}
function emitSnapshot(document, version, componentsVersion, presentationVersion) {
  process.stdout.write(`${JSON.stringify({ document, version, ...(componentsVersion === undefined ? {} : { componentsVersion }), ...(presentationVersion === undefined ? {} : { presentationVersion }) })}\n`);
}
async function inputBreakpointSnapshot(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const source = await readJson(path === "-" ? process.stdin : createReadStream(path));
  if (Object.keys(source).sort().join(",") !== "settings,version" || !isEditingApiVersion(source.version)) throw new CliError("invalid_settings_snapshot");
  let settings;
  try { settings = parseBreakpointSettings(source.settings); } catch { throw new CliError("invalid_settings_snapshot"); }
  return { settings, version: source.version };
}
async function inputPageManagementJson(path, maximumBytes) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > maximumBytes) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  return readJson(path === "-" ? process.stdin : createReadStream(path), maximumBytes);
}
async function inputPageReleaseSet(path, siteId) {
  const source = await inputPageManagementJson(path, MAX_INPUT_BYTES);
  if (Object.keys(source).sort().join(",") !== "items" || !Array.isArray(source.items) || source.items.length < 1 || source.items.length > 50) throw new CliError("invalid_page_release_set");
  const seen = new Set();
  for (const item of source.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["target", "expectedVersion", "componentsVersion", "presentationVersion"].includes(key))
      || !item.target || typeof item.target !== "object" || Array.isArray(item.target)
      || Object.keys(item.target).sort().join(",") !== "locale,pageId,siteId" || item.target.siteId !== siteId
      || !IDENTIFIER.test(item.target.pageId ?? "") || !LOCALE.test(item.target.locale ?? "") || !isEditingApiVersion(item.expectedVersion)
      || item.componentsVersion !== undefined && !isEditingApiVersion(item.componentsVersion)
      || item.presentationVersion !== undefined && !isEditingApiVersion(item.presentationVersion)) throw new CliError("invalid_page_release_set");
    const key = `${item.target.pageId}\u0000${item.target.locale}`;
    if (seen.has(key)) throw new CliError("invalid_page_release_set");
    seen.add(key);
  }
  return source.items;
}
async function inputPageReleaseSetPlan(path, siteId) {
  const plan = await inputPageManagementJson(path, MAX_INPUT_BYTES);
  if (Object.keys(plan).sort().join(",") !== "confirmationToken,domain,items,operationId,siteId"
    || plan.siteId !== siteId || !OPERATION_ID.test(plan.operationId ?? "") || typeof plan.domain !== "string"
    || !isEditingApiVersion(plan.confirmationToken) || !Array.isArray(plan.items)) throw new CliError("invalid_page_release_set_plan");
  return plan;
}
async function inputCmsSnapshot(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const source = await readJson(path === "-" ? process.stdin : createReadStream(path));
  if (!["values,version", "id,values,version"].includes(Object.keys(source).sort().join(",")) || !isEditingApiVersion(source.version)
    || source.id !== undefined && !validCmsItemId(source.id)
    || !source.values || typeof source.values !== "object" || Array.isArray(source.values)) throw new CliError("invalid_cms_snapshot");
  return { ...(source.id === undefined ? {} : { id: source.id }), version: source.version, values: source.values };
}
async function inputCmsPublishPlan(path, siteId) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const plan = await readJson(path === "-" ? process.stdin : createReadStream(path));
  const expectedKeys = plan.redirect === undefined ? "confirmationToken,expectedVersion,item,operationId,target" : "confirmationToken,expectedVersion,item,operationId,redirect,target";
  if (Object.keys(plan).sort().join(",") !== expectedKeys
    || !plan.target || typeof plan.target !== "object" || Array.isArray(plan.target)
    || Object.keys(plan.target).sort().join(",") !== "collectionId,itemId,siteId" || plan.target.siteId !== siteId
    || !validCmsCollectionId(plan.target.collectionId) || !validCmsItemId(plan.target.itemId)
    || !isEditingApiVersion(plan.expectedVersion) || !isEditingApiVersion(plan.confirmationToken) || !OPERATION_ID.test(plan.operationId ?? "")
    || plan.redirect !== undefined && typeof plan.redirect !== "boolean"
    || !plan.item || typeof plan.item !== "object" || Array.isArray(plan.item)) throw new CliError("invalid_cms_publish_plan");
  return plan;
}
function validAssetProvider(value) { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value); }
function validAssetId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value) && value !== "." && value !== ".."; }
async function inputAssetUpdate(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > 16 * 1024) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const value = await readJson(path === "-" ? process.stdin : createReadStream(path), 16 * 1024);
  if (Object.keys(value).sort().join(",") !== "changes,version" || !isEditingApiVersion(value.version)
    || !value.changes || typeof value.changes !== "object" || Array.isArray(value.changes)) throw new CliError("invalid_asset_update");
  return { version: value.version, changes: value.changes };
}
async function inputAssetReferences(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > 256 * 1024) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const value = await readJson(path === "-" ? process.stdin : createReadStream(path), 256 * 1024);
  if (Object.keys(value).sort().join(",") !== "references" || !Array.isArray(value.references) || value.references.length > 5000) throw new CliError("invalid_asset_references");
  return value.references;
}
function assertCommandOptions(values, allowed) {
  const shared = ["origin", "site", "help"];
  if (Object.keys(values).some((key) => !shared.includes(key) && !allowed.includes(key))) throw new CliError("invalid_arguments");
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function apiCall(run) {
  try { return await run(); }
  catch (error) {
    if (error instanceof EditingApiClientError) {
      if (error.code === "redirect_response") throw new CliError("access_redirect", error.status);
      throw new CliError(error.code, error.status);
    }
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new CliError("transport_error");
    throw error;
  }
}

async function runLocalization(client, operation, values, positionals) {
  const { id, method } = operation;
  const itemTarget = ["localization.items.read", "localization.items.command", "localization.items.translate", "localization.preview"].includes(id);
  const hasCursor = id === "localization.items.list" || id === "localization.preview";
  const argumentCount = id === "localization.preview" ? 2 : Number(itemTarget || id === "localization.jobs.read");
  assertCommandOptions(values, method === "GET" ? (hasCursor ? ["cursor"] : []) : ["json"]);
  if (positionals.length !== argumentCount) throw new CliError("invalid_arguments");
  const [target, previewId] = positionals;
  let input = itemTarget ? { itemKey: target } : {};
  if (id === "localization.jobs.read") input.jobId = target;
  if (id === "localization.preview") input.previewId = previewId;
  if (hasCursor) input.cursor = values.cursor ?? null;
  if (method !== "GET") {
    if (!values.json) throw new CliError("missing_json_input");
    const data = await readJson(values.json === "-" ? process.stdin : createReadStream(values.json), EDITING_LOCALIZATION_INPUT_BYTES);
    if (itemTarget && Object.hasOwn(data, "itemKey")) throw new CliError("invalid_json_input");
    input = { ...data, ...input };
  }

  let result;
  try { result = await apiCall(() => client.executeLocalization(id, input, AbortSignal.timeout(30_000))); }
  catch (error) {
    if (error instanceof TypeError) throw new CliError(method === "GET" ? "invalid_arguments" : "invalid_json_input");
    throw error;
  }
  if (result.status === "conflict") {
    emit(editingLocalizationConflictBody(result), 409, 1, id);
    return;
  }
  emit(result, 200, 0, id);
}

async function main() {
  const { values, positionals } = argsFromCli();
  if (values.help) { process.stdout.write(`${USAGE}\n`); return; }
  const [command, pageId, ...extra] = positionals;
  if (command === "cms-diff") {
    assertCommandOptions(values, ["base", "json"]);
    if (pageId !== undefined || extra.length) throw new CliError("invalid_arguments");
    const [base, edited] = await Promise.all([inputCmsSnapshot(values.base), inputCmsSnapshot(values.json)]);
    if (base.version !== edited.version || base.id !== undefined && edited.id !== undefined && base.id !== edited.id) throw new CliError("snapshot_target_mismatch");
    const keys = [...new Set([...Object.keys(base.values), ...Object.keys(edited.values)])].sort();
    const changes = keys.filter((key) => stableJson(base.values[key]) !== stableJson(edited.values[key]) || Object.hasOwn(base.values, key) !== Object.hasOwn(edited.values, key))
      .map((field) => ({ field, beforePresent: Object.hasOwn(base.values, field), afterPresent: Object.hasOwn(edited.values, field),
        ...(Object.hasOwn(base.values, field) ? { before: base.values[field] } : {}), ...(Object.hasOwn(edited.values, field) ? { after: edited.values[field] } : {}) }));
    process.stdout.write(`${JSON.stringify({ id: edited.id ?? base.id ?? null, version: base.version, changes })}\n`); return;
  }
  const baseOrigin = origin(values.origin);
  if (!IDENTIFIER.test(values.site ?? "")) throw new CliError("invalid_site");
  const token = process.env.NIHO_EDIT_TOKEN;
  if (typeof token !== "string" || !token || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) throw new CliError("missing_token");
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  const hasAccessCredentials = accessClientId !== undefined || accessClientSecret !== undefined;
  if (hasAccessCredentials && (!SERVICE_CLIENT_ID.test(accessClientId ?? "") || !/^[\x21-\x7e]{1,512}$/u.test(accessClientSecret ?? ""))) {
    throw new CliError("invalid_access_credentials");
  }
  const accessHeaders = hasAccessCredentials ? {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret
  } : {};
  const client = createPageEditingApiClient({ origin: baseOrigin, siteId: values.site, credentials: "omit", headers: {
    Authorization: `Bearer ${token}`,
    ...accessHeaders
  } });

  if (command?.startsWith("localization-")) {
    const operation = EDITING_OPERATIONS.find((entry) => entry.id.startsWith("localization.") && entry.id.replaceAll(".", "-") === command);
    if (!operation) throw new CliError("invalid_arguments");
    await runLocalization(client, operation, values, positionals.slice(1));
    return;
  }

  if (command === "assets-list") {
    assertCommandOptions(values, ["search", "kind", "provider", "limit", "cursor", "folder-id", "recent"]);
    if (pageId !== undefined || extra.length) throw new CliError("invalid_arguments");
    const limit = values.limit === undefined ? 60 : Number(values.limit), kind = values.kind ?? "all";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !["all", "image", "video", "pdf", "other"].includes(kind)
      || values.provider !== undefined && !validAssetProvider(values.provider) || values["folder-id"] !== undefined && !validAssetId(values["folder-id"]) || values.recent !== undefined && typeof values.recent !== "boolean") throw new CliError("invalid_arguments");
    const result = await apiCall(() => client.listAssets({ search: values.search ?? "", kind, folderId: values["folder-id"] ?? null, limit,
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }), ...(values.provider === undefined ? {} : { provider: values.provider }),
      ...(values.recent === undefined ? {} : { recent: values.recent }) }, AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }

  if (command === "assets-usages") {
    assertCommandOptions(values, []);
    if (!validAssetProvider(pageId) || extra.length !== 1 || !validAssetId(extra[0])) throw new CliError("invalid_arguments");
    const usages = await apiCall(() => client.listAssetUsages({ provider: pageId, id: extra[0] }, AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify(usages)}\n`); return;
  }

  if (command === "assets-resolve") {
    assertCommandOptions(values, ["json"]);
    if (pageId !== undefined || extra.length) throw new CliError("invalid_arguments");
    const references = await inputAssetReferences(values.json);
    const assets = await apiCall(() => client.resolveAssets(references, AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify(assets)}\n`); return;
  }

  if (command === "assets-update") {
    assertCommandOptions(values, ["json"]);
    if (!validAssetProvider(pageId) || extra.length !== 1 || !validAssetId(extra[0])) throw new CliError("invalid_arguments");
    const snapshot = await inputAssetUpdate(values.json);
    const result = await apiCall(() => client.updateAsset({ provider: pageId, id: extra[0] }, snapshot.version, snapshot.changes, AbortSignal.timeout(30_000)));
    const conflict = result.status === "conflict" || result.status === "rejected";
    emit(result, conflict ? 409 : 200, conflict ? 1 : 0, "assets.update"); return;
  }

  if (command === "assets-upload") {
    assertCommandOptions(values, ["mime-type", "provider", "name", "folder-id", "upload-origin"]);
    if (typeof pageId !== "string" || pageId === "-" || extra.length || typeof values["mime-type"] !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/u.test(values["mime-type"])
      || !validAssetProvider(values.provider) || values["folder-id"] !== undefined && !validAssetId(values["folder-id"])) throw new CliError("invalid_arguments");
    const fileStat = await stat(pageId).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size < 1) throw new CliError("invalid_upload_file");
    if (fileStat.size > MAX_ASSET_UPLOAD_BYTES) throw new CliError("input_too_large");
    const bytes = await readFile(pageId);
    const mimeType = values["mime-type"], name = values.name ?? basename(pageId);
    if (!name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) throw new CliError("invalid_arguments");
    const intent = await apiCall(() => client.createAssetUploadIntent({ name, mimeType, bytes: bytes.byteLength, folderId: values["folder-id"] ?? null, provider: values.provider }, AbortSignal.timeout(30_000)));
    const uploadUrl = new URL(intent.uploadUrl);
    const configuredUploadOrigin = values["upload-origin"] ?? process.env.NIHO_EDIT_UPLOAD_ORIGIN;
    const trustedUploadOrigin = configuredUploadOrigin === undefined ? baseOrigin : origin(configuredUploadOrigin);
    if (uploadUrl.origin !== baseOrigin && uploadUrl.origin !== trustedUploadOrigin || uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.search || uploadUrl.hash) throw new CliError("invalid_upload_intent");
    let uploaded;
    try {
      const response = await fetch(intent.uploadUrl, { method: "PUT", credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${intent.uploadToken}`, "Content-Type": mimeType,
          ...(uploadUrl.origin === baseOrigin ? accessHeaders : {}) }, body: new Uint8Array(bytes) });
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new CliError("upload_rejected", response.status);
      const body = await response.json();
      if (!response.ok) throw new CliError("upload_rejected", response.status);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "asset") throw new CliError("invalid_upload_response", response.status);
      uploaded = parseAssetUploadResult({ status: "uploaded", asset: body.asset }, values.site);
      if (uploaded.status !== "uploaded" || uploaded.asset.id.toLowerCase() !== intent.assetId.toLowerCase() || uploaded.asset.bytes !== bytes.byteLength || uploaded.asset.mimeType !== mimeType || uploaded.asset.provider !== values.provider) throw new CliError("invalid_upload_response", response.status);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("upload_failed");
    }
    emit(uploaded, 201, 0, "assets.upload"); return;
  }

  if (command === "assets-delete" || command === "assets-restore") {
    assertCommandOptions(values, ["expected-version"]);
    if (!validAssetProvider(pageId) || extra.length !== 1 || !validAssetId(extra[0]) || !isEditingApiVersion(values["expected-version"])) throw new CliError("invalid_arguments");
    const run = command === "assets-delete" ? () => client.deleteAsset({ provider: pageId, id: extra[0] }, values["expected-version"], AbortSignal.timeout(30_000))
      : () => client.restoreAsset({ provider: pageId, id: extra[0] }, values["expected-version"], AbortSignal.timeout(30_000));
    const result = await apiCall(run), failed = result.status === "conflict" || result.status === "in-use" || result.status === "rejected";
    emit(result, failed ? 409 : 200, failed ? 1 : 0, command === "assets-delete" ? "assets.delete" : "assets.restore"); return;
  }

  if (command === "cms-schema") {
    assertCommandOptions(values, []);
    if (pageId !== undefined || extra.length) throw new CliError("invalid_arguments");
    process.stdout.write(`${JSON.stringify(await apiCall(() => client.readCmsSchema(AbortSignal.timeout(30_000))))}\n`); return;
  }

  if (command === "cms-list") {
    assertCommandOptions(values, []);
    if (!validCmsCollectionId(pageId) || extra.length) throw new CliError("invalid_arguments");
    process.stdout.write(`${JSON.stringify(await apiCall(() => client.listCmsItems(pageId, AbortSignal.timeout(30_000))))}\n`); return;
  }

  if (command === "cms-read") {
    assertCommandOptions(values, []);
    if (!validCmsCollectionId(pageId) || extra.length !== 1 || !validCmsItemId(extra[0])) throw new CliError("invalid_arguments");
    const item = await apiCall(() => client.readCmsItem({ siteId: values.site, collectionId: pageId, itemId: extra[0] }, AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify({ id: item.id, version: item.version, values: item.values })}\n`); return;
  }

  if (command === "cms-create") {
    assertCommandOptions(values, ["operation-id"]);
    if (!validCmsCollectionId(pageId) || extra.length || !OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_arguments");
    const item = await apiCall(() => client.createCmsItem(pageId, values["operation-id"], AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify({ id: item.id, version: item.version, values: item.values })}\n`); return;
  }

  if (command === "cms-save") {
    assertCommandOptions(values, ["json", "operation-id"]);
    if (!validCmsCollectionId(pageId) || extra.length !== 1 || !validCmsItemId(extra[0]) || !OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_arguments");
    const snapshot = await inputCmsSnapshot(values.json);
    if (snapshot.id !== undefined && snapshot.id !== extra[0]) throw new CliError("snapshot_target_mismatch");
    const result = await apiCall(() => client.saveCmsItem({ siteId: values.site, collectionId: pageId, itemId: extra[0] }, snapshot.version, values["operation-id"], snapshot.values, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") { process.stderr.write("version_conflict\n"); process.exitCode = 1; return; }
    process.stdout.write(`${JSON.stringify({ id: result.item.id, version: result.item.version, values: result.item.values })}\n`); return;
  }

  if (command === "cms-publish-plan") {
    assertCommandOptions(values, ["expected-version", "operation-id", "redirect"]);
    if (!validCmsCollectionId(pageId) || extra.length !== 1 || !validCmsItemId(extra[0])
      || !isEditingApiVersion(values["expected-version"]) || !OPERATION_ID.test(values["operation-id"] ?? "")
      || values.redirect !== undefined && values.redirect !== "true" && values.redirect !== "false") throw new CliError("invalid_arguments");
    const plan = await apiCall(() => client.prepareCmsPublish({ siteId: values.site, collectionId: pageId, itemId: extra[0] }, values["expected-version"], values["operation-id"], AbortSignal.timeout(30_000),
      values.redirect === undefined ? undefined : values.redirect === "true"));
    process.stdout.write(`${JSON.stringify(plan)}\n`); return;
  }

  if (command === "cms-publish") {
    assertCommandOptions(values, ["json"]);
    if (pageId !== undefined || extra.length) throw new CliError("invalid_arguments");
    const plan = await inputCmsPublishPlan(values.json, values.site);
    const result = await apiCall(() => client.publishCmsItem(plan, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") { emit({ error: "version_conflict" }, 409, 1, "cms.publish"); return; }
    emit(result, 200, 0, "cms.publish"); return;
  }

  if (command === "cms-status") {
    assertCommandOptions(values, ["operation-id"]);
    if (pageId !== undefined || extra.length || !OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_arguments");
    process.stdout.write(`${JSON.stringify(await apiCall(() => client.cmsOperationStatus(values["operation-id"], AbortSignal.timeout(30_000))))}\n`); return;
  }

  if (command === "page-release-set-plan") {
    assertCommandOptions(values, ["json", "operation-id"]);
    if (pageId !== undefined || extra.length || !OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_arguments");
    const items = await inputPageReleaseSet(values.json, values.site);
    const plan = await apiCall(() => client.preparePageReleaseSet(items, AbortSignal.timeout(30_000), values["operation-id"]));
    process.stdout.write(`${JSON.stringify(plan)}\n`); return;
  }

  if (command === "page-release-set-apply") {
    assertCommandOptions(values, ["json"]);
    if (pageId !== undefined || extra.length) throw new CliError("invalid_arguments");
    const plan = await inputPageReleaseSetPlan(values.json, values.site);
    const result = await apiCall(() => client.publishPageReleaseSet(plan, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") { emit({ error: "version_conflict" }, 409, 1, "pages.release-set"); return; }
    emit(result, 200, 0, "pages.release-set"); return;
  }

  if (command === "page-release-set-status") {
    assertCommandOptions(values, ["operation-id"]);
    if (pageId !== undefined || extra.length || !OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_arguments");
    process.stdout.write(`${JSON.stringify(await apiCall(() => client.pageReleaseSetStatus(values["operation-id"], AbortSignal.timeout(30_000))))}\n`); return;
  }

  if (command === "discover") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.json !== undefined || values.action !== undefined
      || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const body = await apiCall(() => client.discover(AbortSignal.timeout(30_000)));
    emit(body, 200, 0, "discover"); return;
  }

  if (command === "breakpoints-read") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.json !== undefined || values.action !== undefined
      || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const snapshot = await apiCall(() => client.readBreakpointSettings(AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify(snapshot)}\n`); return;
  }

  if (command === "breakpoints-save") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.action !== undefined || values["expected-version"] !== undefined
      || values["components-version"] !== undefined || values["presentation-version"] !== undefined || values.revision !== undefined || values["operation-id"] !== undefined) {
      throw new CliError("invalid_arguments");
    }
    const snapshot = await inputBreakpointSnapshot(values.json);
    const result = await apiCall(() => client.saveBreakpointSettings(snapshot.version, snapshot.settings, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") { emit({ error: "version_conflict" }, 409, 1, "site.breakpoints.save"); return; }
    emit(result, 200, 0, "site.breakpoints.save"); return;
  }

  if (command === "pages-catalog") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.json !== undefined || values.action !== undefined
      || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    process.stdout.write(`${JSON.stringify(await apiCall(() => client.readPageCatalog(AbortSignal.timeout(30_000))))}\n`); return;
  }

  if (command === "page-change-prepare") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.action !== undefined || values["components-version"] !== undefined
      || values["presentation-version"] !== undefined || values.revision !== undefined || values["operation-id"] !== undefined
      || !isEditingApiVersion(values["expected-version"])) throw new CliError("invalid_arguments");
    const change = await inputPageManagementJson(values.json, MAX_PAGE_CHANGE_BYTES);
    const plan = await apiCall(() => client.preparePageChange(change, values["expected-version"], AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify(plan)}\n`); return;
  }

  if (command === "page-change-apply") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.action !== undefined || values["expected-version"] !== undefined
      || values["components-version"] !== undefined || values["presentation-version"] !== undefined || values.revision !== undefined || values["operation-id"] !== undefined) {
      throw new CliError("invalid_arguments");
    }
    const plan = await inputPageManagementJson(values.json, MAX_INPUT_BYTES);
    const result = await apiCall(() => client.applyPageChange(plan, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") { emit({ error: "version_conflict" }, 409, 1, "pages.change-apply"); return; }
    emit(result, 200, 0, "pages.change-apply"); return;
  }

  if (!["read", "save", "release-plan", "release"].includes(command) || extra.length || !IDENTIFIER.test(pageId ?? "") || !LOCALE.test(values.locale ?? "")) throw new CliError("invalid_arguments");
  const target = { siteId: values.site, pageId, locale: values.locale };
  if (command === "read") {
    if (values.json !== undefined || values.action !== undefined || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const snapshot = await apiCall(() => client.read(target, AbortSignal.timeout(30_000)));
    emitSnapshot(snapshot.document, snapshot.version, snapshot.componentsVersion, snapshot.presentationVersion); return;
  }
  if (command === "save") {
    if (values.action !== undefined || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const snapshot = await inputSnapshot(values.json);
    if (snapshot.document.siteId !== values.site || snapshot.document.pageId !== pageId || snapshot.document.locale !== values.locale) throw new CliError("snapshot_target_mismatch");
    const result = await apiCall(() => client.save(target, snapshot.version, snapshot.document, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") throw new CliError("version_conflict", 409);
    emitSnapshot(result.document, result.version, snapshot.componentsVersion, snapshot.presentationVersion); return;
  }
  if (command === "release-plan") {
    if (values["operation-id"] !== undefined || !["publish", "rollback"].includes(values.action ?? "")) throw new CliError("invalid_arguments");
    let expectedVersion = values["expected-version"], componentsVersion = values["components-version"], presentationVersion = values["presentation-version"];
    if (values.json !== undefined) {
      if (expectedVersion !== undefined || componentsVersion !== undefined || presentationVersion !== undefined) throw new CliError("invalid_arguments");
      const snapshot = await inputSnapshot(values.json);
      if (snapshot.document.siteId !== target.siteId || snapshot.document.pageId !== pageId || snapshot.document.locale !== values.locale) throw new CliError("snapshot_target_mismatch");
      expectedVersion = snapshot.version;
      componentsVersion = snapshot.componentsVersion;
      presentationVersion = snapshot.presentationVersion;
    }
    if (!isEditingApiVersion(expectedVersion) || componentsVersion !== undefined && !isEditingApiVersion(componentsVersion)
      || presentationVersion !== undefined && !isEditingApiVersion(presentationVersion)) throw new CliError("invalid_arguments");
    const revision = values.revision === undefined ? undefined : Number(values.revision);
    if (values.action === "publish" && revision !== undefined || values.action === "rollback" && (!Number.isSafeInteger(revision) || revision < 1)) throw new CliError("invalid_arguments");
    const plan = await apiCall(() => client.prepareRelease(target, {
      expectedVersion, action: values.action, ...(revision === undefined ? {} : { revision }),
      ...(componentsVersion === undefined ? {} : { componentsVersion }), ...(presentationVersion === undefined ? {} : { presentationVersion })
    }, AbortSignal.timeout(30_000)));
    process.stdout.write(`${JSON.stringify(plan)}\n`); return;
  }
  if (values.action !== undefined || values["expected-version"] !== undefined || values["components-version"] !== undefined
    || values["presentation-version"] !== undefined || values.revision !== undefined) throw new CliError("invalid_arguments");
  if (!OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_operation_id");
  const plan = await inputPlan(values.json, target);
  const result = await apiCall(() => client.release(target, plan, values["operation-id"], AbortSignal.timeout(30_000)));
  if (result.status === "conflict") throw new CliError("version_conflict", 409);
  emit(result, 200, 0, "release");
}

main().catch((error) => {
  emit({ error: error instanceof CliError ? error.code : "unexpected_error" }, error instanceof CliError ? error.status : null, 1);
});
