#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { createPageEditingApiClient, EditingApiClientError, isEditingApiVersion, parseEditingPageDocumentEnvelope } from "../dist/editing-client.js";
import { EDITING_OPERATIONS } from "../dist/editing-api.js";
import { editingLocalizationConflictBody, EDITING_LOCALIZATION_INPUT_BYTES } from "../dist/editing-localization.js";
import { parseAssetUploadResult } from "../dist/assets.js";
import { editDocumentById } from "../dist/editor-model.js";
import { PAGE_OPERATION_LIMIT, changedPageNodeIds, editingOperationProblem, parsePageOperation } from "../dist/editing-page-operations.js";
import { diffDocuments } from "../dist/history.js";
import { parseBreakpointSettings } from "../dist/style-model.js";
import { inspectPageDocument, PageInspectError, parsePageInspectQuery } from "../dist/page-inspect.js";
import { SERVICE_CLIENT_ID } from "./operations.mjs";

const USAGE = `niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> outline <page-id> --locale <locale> [--node <id>] [--depth <n>]
niho-edit --origin <https-origin> --site <site-id> find <page-id> --locale <locale> (--text <text> | --name <name> | --tag <tag> | --style <property=value> | --uses-token <name> | --block <id> | --node <id>)
niho-edit --origin <https-origin> --site <site-id> find --url <public-url> --locale <locale> --node <data-nw-node>
niho-edit --origin <https-origin> --site <site-id> get <page-id> <node-id> --locale <locale> [--effective-style]
niho-edit --origin <https-origin> --site <site-id> apply <page-id> --locale <locale> --ops <file|-> [--dry-run] [--expected-version <version>] [--operation-id <uuid-v4>]
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
  constructor(readonlyCode, status = null, details = undefined) { super(readonlyCode); this.code = readonlyCode; this.status = status; this.details = details; }
}

function argsFromCli() {
  try {
    return parseArgs({ allowPositionals: true, options: {
      origin: { type: "string" }, site: { type: "string" }, locale: { type: "string" }, json: { type: "string" }, action: { type: "string" },
      "expected-version": { type: "string" }, "components-version": { type: "string" }, "presentation-version": { type: "string" },
      revision: { type: "string" }, "operation-id": { type: "string" }, redirect: { type: "string" }, base: { type: "string" }, help: { type: "boolean", short: "h" },
      name: { type: "string" }, "mime-type": { type: "string" }, provider: { type: "string" }, search: { type: "string" }, kind: { type: "string" }, "upload-origin": { type: "string" },
      "folder-id": { type: "string" }, cursor: { type: "string" }, limit: { type: "string" }, recent: { type: "boolean" },
      ops: { type: "string" }, "dry-run": { type: "boolean" },
      "node": { type: "string" }, "depth": { type: "string" }, "text": { type: "string" },
      "tag": { type: "string" }, "style": { type: "string" }, "uses-token": { type: "string" }, "block": { type: "string" },
      "url": { type: "string" }, "effective-style": { type: "boolean" }
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
async function readJsonValue(stream, maximumBytes = MAX_INPUT_BYTES) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > maximumBytes) throw new CliError("input_too_large");
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
}
async function readJson(stream, maximumBytes = MAX_INPUT_BYTES) {
  const value = await readJsonValue(stream, maximumBytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("invalid_json_input");
  return value;
}
async function inputSnapshot(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const source = await readJson(path === "-" ? process.stdin : createReadStream(path));
  const snapshotKeys = Object.keys(source);
  if (!snapshotKeys.includes("document") || !snapshotKeys.includes("version") || snapshotKeys.some((key) => !["document", "version", "componentsVersion", "presentationVersion", "stylesVersion"].includes(key))
    || !isEditingApiVersion(source.version) || source.componentsVersion !== undefined && !isEditingApiVersion(source.componentsVersion)
    || source.presentationVersion !== undefined && !isEditingApiVersion(source.presentationVersion)
    || source.stylesVersion !== undefined && !isEditingApiVersion(source.stylesVersion)) throw new CliError("invalid_snapshot");
  let document;
  try { document = parseEditingPageDocumentEnvelope(source.document); } catch { throw new CliError("invalid_document"); }
  return { document, version: source.version,
    ...(source.componentsVersion === undefined ? {} : { componentsVersion: source.componentsVersion }),
    ...(source.presentationVersion === undefined ? {} : { presentationVersion: source.presentationVersion }),
    ...(source.stylesVersion === undefined ? {} : { stylesVersion: source.stylesVersion }) };
}
function operationNodeId(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return undefined;
  const candidates = [operation.nodeId, operation.node?.id, operation.nodes?.[0]?.id, operation.parentId];
  return candidates.find((value) => typeof value === "string" && IDENTIFIER.test(value));
}
async function inputPageOperations(path) {
  if (!path) throw new CliError("missing_json_input");
  if (path !== "-") {
    try { if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliError("input_too_large"); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError("invalid_json_input"); }
  }
  const source = await readJsonValue(path === "-" ? process.stdin : createReadStream(path));
  if (!Array.isArray(source) || source.length < 1 || source.length > PAGE_OPERATION_LIMIT) throw new CliError("invalid_operations", 400);
  const operations = [];
  for (let index = 0; index < source.length; index++) {
    try { operations.push(parsePageOperation(source[index], `$operations[${index}]`)); }
    catch (error) {
      const problem = editingOperationProblem(error, index);
      throw new CliError("invalid_operation", 400, { index, reason: problem.reason.slice(0, 400), ...(operationNodeId(source[index]) ? { nodeId: operationNodeId(source[index]) } : {}) });
    }
  }
  return operations;
}
function operationFailureDetails(details, operations) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const index = Number.isSafeInteger(details.index) && details.index >= 0 && details.index < operations.length ? details.index : undefined;
  return {
    ...(index === undefined ? {} : { index }),
    ...(typeof details.reason === "string" ? { reason: details.reason.slice(0, 400) } : {}),
    ...(index === undefined || !operationNodeId(operations[index]) ? {} : { nodeId: operationNodeId(operations[index]) })
  };
}
function applyPageOperationsLocally(document, operations) {
  const before = document;
  let after = structuredClone(document);
  for (let index = 0; index < operations.length; index++) {
    try { after = editDocumentById(after, operations[index]); }
    catch (error) {
      const problem = editingOperationProblem(error, index);
      throw new CliError("validation_failed", 422, { index, reason: problem.reason.slice(0, 400), ...(operationNodeId(operations[index]) ? { nodeId: operationNodeId(operations[index]) } : {}) });
    }
  }
  try { after = parseEditingPageDocumentEnvelope(after); }
  catch (error) {
    const index = operations.length - 1, problem = editingOperationProblem(error, index);
    throw new CliError("validation_failed", 422, { index, reason: problem.reason.slice(0, 400), ...(operationNodeId(operations[index]) ? { nodeId: operationNodeId(operations[index]) } : {}) });
  }
  return { document: after, diff: diffDocuments(before, after), touched: changedPageNodeIds(before, after) };
}
const FALLBACK_VALIDATION_NOTICE = "事前検証はローカル文書だけで行いました。ホストのtrusted contextを含まないため、保存時の最終検証はホストが行います。";
async function runPageApply(client, pageId, extra, values) {
  assertCommandOptions(values, ["locale", "ops", "dry-run", "expected-version", "operation-id"]);
  if (!IDENTIFIER.test(pageId ?? "") || extra.length || !LOCALE.test(values.locale ?? "")
    || values["dry-run"] !== undefined && typeof values["dry-run"] !== "boolean"
    || values["expected-version"] !== undefined && !isEditingApiVersion(values["expected-version"])
    || values["operation-id"] !== undefined && !OPERATION_ID.test(values["operation-id"])) throw new CliError("invalid_arguments");
  const operations = await inputPageOperations(values.ops);
  const target = { siteId: values.site, pageId, locale: values.locale };
  const discovery = await apiCall(() => client.discover(AbortSignal.timeout(30_000)));
  const supportsApply = discovery.operations.some((operation) => operation.id === "pages.apply");
  if (!supportsApply && values["operation-id"] !== undefined) throw new CliError("operation_id_requires_pages_apply");
  const snapshot = await apiCall(() => client.read(target, AbortSignal.timeout(30_000)));
  const baseVersion = values["expected-version"] ?? snapshot.version;
  if (!isEditingApiVersion(baseVersion)) throw new CliError("invalid_arguments");
  const dryRun = values["dry-run"] === true;
  if (supportsApply) {
    const operationId = values["operation-id"] ?? randomUUID();
    const input = { baseVersion, operationId, operations, ...(dryRun ? { dryRun: true } : {}) };
    let result;
    try { result = await apiCall(() => client.applyOperations(target, input, AbortSignal.timeout(30_000))); }
    catch (error) {
      if (error instanceof CliError) throw new CliError(error.code, error.status, { ...operationFailureDetails(error.details, operations), operationId, baseVersion });
      throw error;
    }
    if (result.status === "conflict") {
      emit({ error: "version_conflict", baseVersion, operationId }, 409, 1, "pages.apply"); return;
    }
    if (result.status === "valid") {
      emit({ status: "valid", baseVersion, operationId, diff: result.diff, touched: result.touched, validation: "host" }, 200, 0, "pages.apply"); return;
    }
    const diff = diffDocuments(snapshot.document, result.document);
    emit({ status: "applied", baseVersion, operationId, version: result.version, revision: result.revision,
      diff, touched: changedPageNodeIds(snapshot.document, result.document), validation: "host" }, 200, 0, "pages.apply"); return;
  }
  if (values["expected-version"] !== undefined && baseVersion !== snapshot.version) {
    emit({ error: "version_conflict", baseVersion, currentVersion: snapshot.version }, 409, 1, "pages.save"); return;
  }
  const local = applyPageOperationsLocally(snapshot.document, operations);
  if (dryRun) {
    emit({ status: "valid", baseVersion, diff: local.diff, touched: local.touched, validation: "local-untrusted", warning: FALLBACK_VALIDATION_NOTICE }, 200, 0, "pages.read"); return;
  }
  const saved = await apiCall(() => client.save(target, baseVersion, local.document, AbortSignal.timeout(30_000)));
  if (saved.status === "conflict") { emit({ error: "version_conflict", baseVersion }, 409, 1, "pages.save"); return; }
  emit({ status: "saved", baseVersion, version: saved.version, diff: diffDocuments(snapshot.document, saved.document),
    touched: changedPageNodeIds(snapshot.document, saved.document), validation: "host-on-save", warning: FALLBACK_VALIDATION_NOTICE }, 200, 0, "pages.save");
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
function emitSnapshot(document, version, componentsVersion, presentationVersion, stylesVersion) {
  process.stdout.write(`${JSON.stringify({ document, version, ...(componentsVersion === undefined ? {} : { componentsVersion }), ...(presentationVersion === undefined ? {} : { presentationVersion }), ...(stylesVersion === undefined ? {} : { stylesVersion }) })}\n`);
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
      if (error.code === "redirect_response") throw new CliError("access_redirect", error.status, error.details);
      throw new CliError(error.code, error.status, error.details);
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

function normalizedPublicPath(value) {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}
async function pageIdFromPublicUrl(client, value, locale) {
  let publicUrl;
  try {
    publicUrl = new URL(value);
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new Error("invalid public URL");
  } catch { throw new CliError("invalid_public_url"); }
  const catalog = await apiCall(() => client.readPageCatalog(AbortSignal.timeout(30_000)));
  let route;
  try { route = normalizedPublicPath(decodeURIComponent(publicUrl.pathname)); }
  catch { throw new CliError("invalid_public_url"); }
  const candidates = catalog.pages.filter((page) => page.locale === locale && typeof page.path === "string"
    && normalizedPublicPath(page.path.startsWith("/") ? page.path : "/" + page.path) === route);
  if (candidates.length !== 1) throw new CliError("page_not_found", 404);
  return candidates[0].pageId;
}
async function runPageInspection(client, command, pageId, extra, values) {
  const allowed = ["locale", "node", "depth", "text", "name", "tag", "style", "uses-token", "block", "url", "limit", "cursor", "effective-style"];
  assertCommandOptions(values, allowed);
  if (!LOCALE.test(values.locale ?? "")) throw new CliError("invalid_arguments");
  let targetPageId = pageId;
  let query;
  if (command === "outline") {
    if (!IDENTIFIER.test(pageId ?? "") || extra.length || values.url !== undefined || values.text !== undefined || values.name !== undefined
      || values.tag !== undefined || values.style !== undefined || values["uses-token"] !== undefined || values.block !== undefined || values["effective-style"] !== undefined) {
      throw new CliError("invalid_arguments");
    }
    query = { view: "outline", ...(values.node === undefined ? {} : { node: values.node }),
      ...(values.depth === undefined ? {} : { depth: values.depth }), ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }) };
  } else if (command === "find") {
    if (extra.length || values.depth !== undefined || values["effective-style"] !== undefined) throw new CliError("invalid_arguments");
    if (values.url !== undefined) {
      if (pageId !== undefined || values.node === undefined) throw new CliError("invalid_arguments");
      targetPageId = await pageIdFromPublicUrl(client, values.url, values.locale);
    } else if (!IDENTIFIER.test(pageId ?? "")) throw new CliError("invalid_arguments");
    query = { view: "find", ...(values.text === undefined ? {} : { text: values.text }), ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.tag === undefined ? {} : { tag: values.tag }), ...(values.style === undefined ? {} : { style: values.style }),
      ...(values["uses-token"] === undefined ? {} : { usesToken: values["uses-token"] }), ...(values.block === undefined ? {} : { block: values.block }),
      ...(values.node === undefined ? {} : { node: values.node }), ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }) };
  } else {
    if (!IDENTIFIER.test(pageId ?? "") || extra.length !== 1 || !IDENTIFIER.test(extra[0]) || values.node !== undefined || values.depth !== undefined
      || values.text !== undefined || values.name !== undefined || values.tag !== undefined || values.style !== undefined || values["uses-token"] !== undefined
      || values.block !== undefined || values.url !== undefined) throw new CliError("invalid_arguments");
    const effective = values["effective-style"] === true;
    if (values["effective-style"] !== undefined && typeof values["effective-style"] !== "boolean" || effective && (values.limit !== undefined || values.cursor !== undefined)) throw new CliError("invalid_arguments");
    query = effective ? { view: "effectiveStyle", node: extra[0] } : { view: "subtree", node: extra[0],
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }), ...(values.cursor === undefined ? {} : { cursor: values.cursor }) };
  }
  const parsed = parsePageInspectQuery(query);
  if (!parsed) throw new CliError("invalid_arguments");
  const target = { siteId: values.site, pageId: targetPageId, locale: values.locale };
  const discovery = await apiCall(() => client.discover(AbortSignal.timeout(30_000)));
  if (discovery.operations.some((operation) => operation.id === "pages.inspect")) {
    const result = await apiCall(() => client.inspectPage(target, parsed, AbortSignal.timeout(30_000)));
    process.stdout.write(JSON.stringify(result) + "\n"); return;
  }
  const snapshot = await apiCall(() => client.read(target, AbortSignal.timeout(30_000)));
  let projected;
  try { projected = inspectPageDocument(snapshot.document, parsed); }
  catch (error) {
    if (error instanceof PageInspectError) throw new CliError(error.code, error.code === "node_not_found" ? 404 : error.code === "result_too_large" ? 413 : 400);
    throw error;
  }
  process.stdout.write(JSON.stringify({ ...projected, version: snapshot.version,
    ...(snapshot.componentsVersion === undefined ? {} : { componentsVersion: snapshot.componentsVersion }),
    ...(snapshot.presentationVersion === undefined ? {} : { presentationVersion: snapshot.presentationVersion }),
    ...(snapshot.stylesVersion === undefined ? {} : { stylesVersion: snapshot.stylesVersion }) }) + "\n");
}

async function main() {
  const { values, positionals } = argsFromCli();
  if (values.help) { process.stdout.write(`${USAGE}\n`); return; }
  const [command, pageId, ...extra] = positionals;
  if (command !== "apply" && (values.ops !== undefined || values["dry-run"] !== undefined)) throw new CliError("invalid_arguments");
  if (!["outline", "find", "get"].includes(command) && ["node", "depth", "text", "tag", "style", "uses-token", "block", "url", "effective-style"].some((key) => values[key] !== undefined)) throw new CliError("invalid_arguments");
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

  if (["outline", "find", "get"].includes(command)) {
    await runPageInspection(client, command, pageId, extra, values);
    return;
  }
  if (command === "apply") { await runPageApply(client, pageId, extra, values); return; }
  if (!["read", "save", "release-plan", "release"].includes(command) || extra.length || !IDENTIFIER.test(pageId ?? "") || !LOCALE.test(values.locale ?? "")) throw new CliError("invalid_arguments");
  const target = { siteId: values.site, pageId, locale: values.locale };
  if (command === "read") {
    if (values.json !== undefined || values.action !== undefined || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const snapshot = await apiCall(() => client.read(target, AbortSignal.timeout(30_000)));
    emitSnapshot(snapshot.document, snapshot.version, snapshot.componentsVersion, snapshot.presentationVersion, snapshot.stylesVersion); return;
  }
  if (command === "save") {
    if (values.action !== undefined || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const snapshot = await inputSnapshot(values.json);
    if (snapshot.document.siteId !== values.site || snapshot.document.pageId !== pageId || snapshot.document.locale !== values.locale) throw new CliError("snapshot_target_mismatch");
    const result = await apiCall(() => client.save(target, snapshot.version, snapshot.document, AbortSignal.timeout(30_000)));
    if (result.status === "conflict") throw new CliError("version_conflict", 409);
    emitSnapshot(result.document, result.version, snapshot.componentsVersion, snapshot.presentationVersion, snapshot.stylesVersion); return;
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
  const details = error instanceof CliError ? error.details : undefined;
  const result = { error: error instanceof CliError ? error.code : "unexpected_error",
    ...(details && Number.isSafeInteger(details.index) && details.index >= 0 ? { index: details.index } : {}),
    ...(details && typeof details.reason === "string" ? { reason: details.reason.slice(0, 400) } : {}),
    ...(details && typeof details.nodeId === "string" && IDENTIFIER.test(details.nodeId) ? { nodeId: details.nodeId } : {}),
    ...(details && typeof details.operationId === "string" && OPERATION_ID.test(details.operationId) ? { operationId: details.operationId } : {}),
    ...(details && typeof details.baseVersion === "string" && isEditingApiVersion(details.baseVersion) ? { baseVersion: details.baseVersion } : {}) };
  emit(result, error instanceof CliError ? error.status : null, 1);
});
