#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { EDITING_API_ERRORS, EDITING_OPERATIONS } from "../dist/editing-api.js";

const USAGE = `niho-edit --origin <https-origin> --site <site-id> discover
niho-edit --origin <https-origin> --site <site-id> read <page-id> --locale <locale>
niho-edit --origin <https-origin> --site <site-id> save <page-id> --locale <locale> --json <snapshot-file|->

Set NIHO_EDIT_TOKEN to a short-lived bearer token. read returns { document, version }.
Edit document while keeping version, then pass the snapshot to save for version-checked persistence.`;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
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
function pageDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("invalid_document");
  const allowed = new Set(["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "textStyles", "body"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.schemaVersion !== 1
    || !IDENTIFIER.test(value.siteId ?? "") || !IDENTIFIER.test(value.pageId ?? "") || !LOCALE.test(value.locale ?? "")
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.title !== "string"
    || value.meta !== undefined && (!value.meta || typeof value.meta !== "object" || Array.isArray(value.meta))
    || !value.tokens || typeof value.tokens !== "object" || Array.isArray(value.tokens)
    || value.textStyles !== undefined && (!value.textStyles || typeof value.textStyles !== "object" || Array.isArray(value.textStyles))
    || !Array.isArray(value.body)) throw new CliError("invalid_document");
  return value;
}
function pageVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
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
  if (Object.keys(source).sort().join(",") !== "document,version" || !pageVersion(source.version)) throw new CliError("invalid_snapshot");
  const document = pageDocument(source.document);
  return { document, version: source.version };
}
async function responseJson(response) {
  if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new CliError("invalid_response", response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("invalid_response", response.status);
  const chunks = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new CliError("response_too_large", response.status); }
    chunks.push(chunk.value);
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    return value;
  } catch { throw new CliError("invalid_response", response.status); }
}
function emit(result, status = null, code = 0, operation = null) {
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify({ apiVersion: "v1", httpStatus: status, operation, result })}\n`);
}
function emitSnapshot(document, version) {
  process.stdout.write(`${JSON.stringify({ document, version })}\n`);
}
async function send(url, method, token, body) {
  try {
    return await fetch(url, {
      method, credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch { throw new CliError("transport_error"); }
}

async function main() {
  const { values, positionals } = argsFromCli();
  if (values.help) { process.stdout.write(`${USAGE}\n`); return; }
  const [command, pageId, ...extra] = positionals;
  const baseOrigin = origin(values.origin);
  if (!IDENTIFIER.test(values.site ?? "")) throw new CliError("invalid_site");
  const token = process.env.NIHO_EDIT_TOKEN;
  if (typeof token !== "string" || !token || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) throw new CliError("missing_token");
  const sitePath = `/api/edit/v1/sites/${encodeURIComponent(values.site)}`;

  if (command === "discover") {
    if (pageId !== undefined || extra.length || values.locale !== undefined || values.json !== undefined) throw new CliError("invalid_arguments");
    const response = await send(`${baseOrigin}${sitePath}/capabilities`, "GET", token);
    const body = await responseJson(response);
    if (!response.ok) throw new CliError(EDITING_API_ERRORS.includes(body.error) ? body.error : "request_failed", response.status);
    if (body.apiVersion !== "v1" || body.siteId !== values.site || !Array.isArray(body.operations)
      || body.operations.some((item) => !item || typeof item !== "object" || !EDITING_OPERATIONS.some((spec) => spec.id === item.id)
        || !item.inputSchema || !item.resultSchema || !Array.isArray(item.errors))) throw new CliError("invalid_discovery", response.status);
    emit(body, response.status, 0, "discover"); return;
  }

  if (command !== "read" && command !== "save" || extra.length || !IDENTIFIER.test(pageId ?? "") || !LOCALE.test(values.locale ?? "")) throw new CliError("invalid_arguments");
  const query = `?locale=${encodeURIComponent(values.locale)}`;
  const pageRoute = `${sitePath}/operations`;
  if (command === "read") {
    if (values.json !== undefined) throw new CliError("invalid_arguments");
    const response = await send(`${baseOrigin}${pageRoute}/pages.read/${encodeURIComponent(pageId)}${query}`, "GET", token);
    const body = await responseJson(response);
    if (!response.ok) throw new CliError(EDITING_API_ERRORS.includes(body.error) ? body.error : "request_failed", response.status);
    let document;
    try { document = pageDocument(body.document); } catch { throw new CliError("invalid_response", response.status); }
    if (document.siteId !== values.site || document.pageId !== pageId || document.locale !== values.locale || !pageVersion(body.version)) throw new CliError("invalid_response", response.status);
    emitSnapshot(document, body.version); return;
  }

  const snapshot = await inputSnapshot(values.json);
  if (snapshot.document.siteId !== values.site || snapshot.document.pageId !== pageId || snapshot.document.locale !== values.locale) throw new CliError("snapshot_target_mismatch");
  const response = await send(`${baseOrigin}${pageRoute}/pages.save/${encodeURIComponent(pageId)}${query}`, "PUT", token,
    { expectedVersion: snapshot.version, document: snapshot.document });
  const body = await responseJson(response);
  if (!response.ok) throw new CliError(EDITING_API_ERRORS.includes(body.error) ? body.error : "request_failed", response.status);
  if (body.status !== "saved" || !pageVersion(body.version)) throw new CliError("invalid_response", response.status);
  let savedDocument;
  try { savedDocument = pageDocument(body.document); } catch { throw new CliError("invalid_response", response.status); }
  if (savedDocument.siteId !== values.site || savedDocument.pageId !== pageId || savedDocument.locale !== values.locale) throw new CliError("invalid_response", response.status);
  emitSnapshot(savedDocument, body.version);
}

main().catch((error) => {
  emit({ error: error instanceof CliError ? error.code : "unexpected_error" }, error instanceof CliError ? error.status : null, 1);
});
