#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPageEditingApiClient, EditingApiClientError, isEditingApiVersion, parseEditingPageDocumentEnvelope } from "../dist/editing-client.js";
import { parseBreakpointSettings } from "../dist/style-model.js";

const USAGE = `niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> release-plan <page-id> --locale <locale> --action <publish|rollback> (--json <snapshot-file|-> | --expected-version <version>) [--revision <number>]
niho-edit --origin <https-origin> --site <site-id> release <page-id> --locale <locale> --json <plan-file|-> --operation-id <uuid-v4>
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
niho-edit --origin <https-origin> --site <site-id> cms-publish-plan <collection-id> <item-id> --expected-version <version> --operation-id <uuid-v4>
niho-edit --origin <https-origin> --site <site-id> cms-publish --json <publish-plan|->
niho-edit --origin <https-origin> --site <site-id> cms-status --operation-id <uuid-v4>

Set NIHO_EDIT_TOKEN to a short-lived bearer token. read returns { document, version }.
Edit document while keeping version, then pass the snapshot to save for version-checked persistence.
Review the release plan before applying it. Keep and reuse the same operation ID when retrying a release.`;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_CHANGE_BYTES = 16 * 1024;
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
      revision: { type: "string" }, "operation-id": { type: "string" }, base: { type: "string" }, help: { type: "boolean", short: "h" }
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
  if (Object.keys(plan).sort().join(",") !== "confirmationToken,expectedVersion,item,operationId,target"
    || !plan.target || typeof plan.target !== "object" || Array.isArray(plan.target)
    || Object.keys(plan.target).sort().join(",") !== "collectionId,itemId,siteId" || plan.target.siteId !== siteId
    || !validCmsCollectionId(plan.target.collectionId) || !validCmsItemId(plan.target.itemId)
    || !isEditingApiVersion(plan.expectedVersion) || !isEditingApiVersion(plan.confirmationToken) || !OPERATION_ID.test(plan.operationId ?? "")
    || !plan.item || typeof plan.item !== "object" || Array.isArray(plan.item)) throw new CliError("invalid_cms_publish_plan");
  return plan;
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
    if (error instanceof EditingApiClientError) throw new CliError(error.code, error.status);
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new CliError("transport_error");
    throw error;
  }
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
  const client = createPageEditingApiClient({ origin: baseOrigin, siteId: values.site, credentials: "omit", headers: { Authorization: `Bearer ${token}` } });

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
    assertCommandOptions(values, ["expected-version", "operation-id"]);
    if (!validCmsCollectionId(pageId) || extra.length !== 1 || !validCmsItemId(extra[0])
      || !isEditingApiVersion(values["expected-version"]) || !OPERATION_ID.test(values["operation-id"] ?? "")) throw new CliError("invalid_arguments");
    const plan = await apiCall(() => client.prepareCmsPublish({ siteId: values.site, collectionId: pageId, itemId: extra[0] }, values["expected-version"], values["operation-id"], AbortSignal.timeout(30_000)));
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
