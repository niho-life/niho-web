#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPageEditingApiClient, EditingApiClientError, isEditingApiVersion, parseEditingPageDocumentEnvelope } from "../dist/editing-client.js";

const USAGE = `niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->
niho-edit --origin <https-origin> --site <site-id> release-plan <page-id> --locale <locale> --action <publish|rollback> (--json <snapshot-file|-> | --expected-version <version>) [--revision <number>]
niho-edit --origin <https-origin> --site <site-id> release <page-id> --locale <locale> --json <plan-file|-> --operation-id <uuid-v4>

Set NIHO_EDIT_TOKEN to a short-lived bearer token. read returns { document, version }.
Edit document while keeping version, then pass the snapshot to save for version-checked persistence.
Review the release plan before applying it. Keep and reuse the same operation ID when retrying a release.`;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class CliError extends Error {
  constructor(readonlyCode, status = null) { super(readonlyCode); this.code = readonlyCode; this.status = status; }
}

function argsFromCli() {
  try {
    return parseArgs({ allowPositionals: true, options: {
      origin: { type: "string" }, site: { type: "string" }, locale: { type: "string" }, json: { type: "string" }, action: { type: "string" },
      "expected-version": { type: "string" }, "components-version": { type: "string" }, "presentation-version": { type: "string" },
      revision: { type: "string" }, "operation-id": { type: "string" }, help: { type: "boolean", short: "h" }
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
async function readJson(stream) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_INPUT_BYTES) throw new CliError("input_too_large");
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
  const baseOrigin = origin(values.origin);
  if (!IDENTIFIER.test(values.site ?? "")) throw new CliError("invalid_site");
  const token = process.env.NIHO_EDIT_TOKEN;
  if (typeof token !== "string" || !token || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) throw new CliError("missing_token");
  const client = createPageEditingApiClient({ origin: baseOrigin, siteId: values.site, credentials: "omit", headers: { Authorization: `Bearer ${token}` } });

  if (command === "discover") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.json !== undefined || values.action !== undefined
      || values["expected-version"] !== undefined || values["components-version"] !== undefined || values["presentation-version"] !== undefined
      || values.revision !== undefined || values["operation-id"] !== undefined) throw new CliError("invalid_arguments");
    const body = await apiCall(() => client.discover(AbortSignal.timeout(30_000)));
    emit(body, 200, 0, "discover"); return;
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
