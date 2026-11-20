#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPageEditingApiClient, EditingApiClientError, isEditingApiVersion, parseEditingPageDocumentEnvelope } from "../dist/editing-client.js";

const USAGE = `niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->

Set NIHO_EDIT_TOKEN to a short-lived bearer token. read returns { document, version }.
Edit document while keeping version, then pass the snapshot to save for version-checked persistence.`;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

class CliError extends Error {
  constructor(readonlyCode, status = null) { super(readonlyCode); this.code = readonlyCode; this.status = status; }
}

function argsFromCli() {
  try {
    return parseArgs({ allowPositionals: true, options: {
      origin: { type: "string" }, site: { type: "string" }, locale: { type: "string" }, json: { type: "string" }, help: { type: "boolean", short: "h" }
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
  if (Object.keys(source).sort().join(",") !== "document,version" || !isEditingApiVersion(source.version)) throw new CliError("invalid_snapshot");
  let document;
  try { document = parseEditingPageDocumentEnvelope(source.document); } catch { throw new CliError("invalid_document"); }
  return { document, version: source.version };
}
function emit(result, status = null, code = 0, operation = null) {
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify({ apiVersion: "v1", httpStatus: status, operation, result })}\n`);
}
function emitSnapshot(document, version) {
  process.stdout.write(`${JSON.stringify({ document, version })}\n`);
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
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.json !== undefined) throw new CliError("invalid_arguments");
    const body = await apiCall(() => client.discover(AbortSignal.timeout(30_000)));
    emit(body, 200, 0, "discover"); return;
  }

  if (command !== "read" && command !== "save" || extra.length || !IDENTIFIER.test(pageId ?? "") || !LOCALE.test(values.locale ?? "")) throw new CliError("invalid_arguments");
  if (command === "read") {
    if (values.json !== undefined) throw new CliError("invalid_arguments");
    const snapshot = await apiCall(() => client.read({ siteId: values.site, pageId, locale: values.locale }, AbortSignal.timeout(30_000)));
    emitSnapshot(snapshot.document, snapshot.version); return;
  }

  const snapshot = await inputSnapshot(values.json);
  if (snapshot.document.siteId !== values.site || snapshot.document.pageId !== pageId || snapshot.document.locale !== values.locale) throw new CliError("snapshot_target_mismatch");
  const result = await apiCall(() => client.save({ siteId: values.site, pageId, locale: values.locale }, snapshot.version, snapshot.document, AbortSignal.timeout(30_000)));
  if (result.status === "conflict") throw new CliError("version_conflict", 409);
  emitSnapshot(result.document, result.version);
}

main().catch((error) => {
  emit({ error: error instanceof CliError ? error.code : "unexpected_error" }, error instanceof CliError ? error.status : null, 1);
});
