#!/usr/bin/env node
import { createReadStream, openAsBlob } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { DRAFT_RECOVERY_MAX_INPUT_BYTES, DRAFT_RECOVERY_MAX_OUTPUT_BYTES, API_PREFIX, API_VERSION, OPERATION_KEY_HEADER, SERVICE_CLIENT_ID, SCOPE_ID, UUID_V4, normalizeOperationKey, resolveOperation } from "./operations.mjs";

const USAGE = `niho-studio --origin <https-origin> --project <project-id> --site <site-id> discover
niho-studio --origin <https-origin> --project <project-id> --site <site-id> request <operation> [args...] [--json <file|->] [--operation-id <UUIDv4>]
niho-studio --origin <https-origin> --project <project-id> --site <site-id> upload <upload-operation> --file <image> --upload-origin <https-origin> --json <file|-> [--operation-id <UUIDv4>]
niho-studio --origin <https-origin> --project <project-id> --site <site-id> status <UUIDv4>

Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the environment. Use --json - to read a JSON object from stdin.`;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

class InputError extends Error {}

function write(result, httpStatus = null, exitCode = 0, operationId = null) {
  process.exitCode = exitCode;
  process.stdout.write(`${JSON.stringify({ apiVersion: API_VERSION, httpStatus, operationId, result })}\n`);
}

function argumentsFromCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        origin: { type: "string" },
        project: { type: "string" },
        site: { type: "string" },
        json: { type: "string" },
        file: { type: "string" },
        "upload-origin": { type: "string" },
        "operation-id": { type: "string" },
        help: { type: "boolean", short: "h" }
      }
    });
  } catch {
    throw new InputError("invalid_arguments");
  }
}

function studioOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && (value === url.origin || value === `${url.origin}/`)) return url.origin;
  } catch { /* URL parser details are not part of the output. */ }
  throw new InputError("invalid_origin");
}

async function readJson(stream, limit, array = false) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("JSON size limit exceeded");
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (value === null || typeof value !== "object" || Array.isArray(value) !== array) throw new Error("Unexpected JSON result shape");
  return value;
}

async function inputBody(path, action, maximumBytes = MAX_INPUT_BYTES) {
  let input = {};
  if (path !== undefined) {
    try { input = await readJson(path === "-" ? process.stdin : createReadStream(path), maximumBytes); }
    catch { throw new InputError("invalid_json_input"); }
  }
  if (action === undefined) return JSON.stringify(input);
  if (Object.hasOwn(input, "action") && input.action !== action) throw new InputError("invalid_action");
  return JSON.stringify({ ...input, action });
}

async function uploadInput(values, kind) {
  if (!values.file || values.json === undefined || !values["upload-origin"]) throw new InputError("invalid_upload_arguments");
  const origin = studioOrigin(values["upload-origin"]);
  const metadata = JSON.parse(await inputBody(values.json));
  if (!IMAGE_TYPES.has(metadata.mimeType)) throw new InputError("invalid_image_type");
  let file;
  try { file = await openAsBlob(values.file, { type: metadata.mimeType }); }
  catch { throw new InputError("invalid_image_file"); }
  if (!file.size || file.size > MAX_UPLOAD_BYTES || (metadata.bytes !== undefined && metadata.bytes !== file.size)) {
    throw new InputError("invalid_image_size");
  }
  const body = JSON.stringify({ name: basename(values.file), ...metadata, bytes: file.size });
  return { kind, origin, file, body };
}

async function uploadFile(upload, intent, studio, operationId) {
  let destination;
  try {
    destination = new URL(intent.uploadUrl);
    const prefix = `/internal/studio/${upload.kind}-upload/`;
    const assetId = upload.kind === "asset" ? intent.assetId : intent.uploadId;
    if (destination.origin !== upload.origin || destination.username || destination.password || destination.search || destination.hash
      || typeof assetId !== "string" || !UUID_V4.test(assetId) || destination.pathname !== `${prefix}${assetId}`
      || typeof intent.uploadToken !== "string" || !/^[A-Za-z0-9_.-]{1,4096}$/u.test(intent.uploadToken)) throw new Error("Invalid upload intent");
  } catch {
    return write({ error: "invalid_upload_intent" }, null, 1, operationId);
  }
  let response;
  try {
    // The site receives only its one-use upload token. Origin is the value
    // expected by the site's upload contract, separate from Studio authentication.
    response = await fetch(destination.href, {
      method: "PUT", credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${intent.uploadToken}`, Origin: studio, "Content-Type": upload.file.type },
      body: upload.file
    });
  } catch {
    return write({ error: "upload_transport_error" }, null, 1, operationId);
  }
  if (!response.ok || !response.body || response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => {});
    return write({ error: "upload_failed" }, response.status, 1, operationId);
  }
  try {
    const result = await readJson(response.body, MAX_RESPONSE_BYTES);
    write(result, response.status, 0, operationId);
  } catch {
    write({ error: "invalid_upload_response" }, response.status, 1, operationId);
  }
}

async function main() {
  const { values, positionals } = argumentsFromCommandLine();
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [command, id, ...args] = positionals;
  const origin = studioOrigin(values.origin);
  if (!SCOPE_ID.test(values.project ?? "") || !SCOPE_ID.test(values.site ?? "")) throw new InputError("invalid_scope");
  const base = `${origin}${API_PREFIX}/projects/${values.project}/sites/${values.site}`;

  let url, method, body, upload;
  const operationKey = normalizeOperationKey(values["operation-id"]);
  if (values["operation-id"] !== undefined) {
    if (command !== "request" && command !== "upload") throw new InputError("invalid_arguments");
    if (!operationKey) throw new InputError("invalid_operation_id");
  }
  if (command !== "upload" && (values.file !== undefined || values["upload-origin"] !== undefined)) throw new InputError("invalid_arguments");
  if (command === "discover") {
    if (id !== undefined || values.json !== undefined) throw new InputError("invalid_arguments");
    url = `${base}/capabilities`;
    method = "GET";
  } else if (command === "status") {
    if (args.length !== 0 || values.json !== undefined) throw new InputError("invalid_arguments");
    const key = normalizeOperationKey(id);
    if (!key) throw new InputError("invalid_operation_id");
    url = `${base}/operation-status/${key}`;
    method = "GET";
  } else if (command === "request" || command === "upload") {
    const operation = resolveOperation(id, args);
    if (!operation) throw new InputError("invalid_operation");
    method = operation.spec.method;
    if (method === "GET" && values.json !== undefined) throw new InputError("unexpected_json_input");
    url = `${base}/operations/${[id, ...args].join("/")}`;
    if (command === "upload") {
      if (!operation.spec.upload) throw new InputError("invalid_upload_operation");
      upload = await uploadInput(values, operation.spec.upload);
      body = upload.body;
    } else {
      if (operation.spec.upload) throw new InputError("use_upload_command");
      if (method !== "GET") body = await inputBody(values.json, operation.spec.action, id === "pages.draft-resolve" ? DRAFT_RECOVERY_MAX_INPUT_BYTES : undefined);
    }
  } else {
    throw new InputError("invalid_arguments");
  }

  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!SERVICE_CLIENT_ID.test(clientId ?? "") || !/^[\x21-\x7e]{1,512}$/u.test(clientSecret ?? "")) throw new InputError("invalid_access_credentials");
  const headers = {
    Accept: "application/json",
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
    ...(operationKey === null ? {} : { [OPERATION_KEY_HEADER]: operationKey }),
    ...(body === undefined ? {} : { "Content-Type": "application/json" })
  };
  let response;
  try {
    response = await fetch(url, {
      method, body, headers, credentials: "omit", redirect: "manual",
      cache: "no-store", signal: AbortSignal.timeout(45_000)
    });
  } catch {
    write({ error: "transport_error" }, null, 1);
    return;
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    write({ error: "access_redirect" }, response.status, 1);
    return;
  }
  const header = response.headers.get("X-Studio-Operation-Id");
  const operationId = header && UUID_V4.test(header) ? header : null;
  let result;
  try {
    if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Expected JSON response");
    }
    result = await readJson(response.body, id === "pages.draft-conflict" ? DRAFT_RECOVERY_MAX_OUTPUT_BYTES : MAX_RESPONSE_BYTES, response.ok && id === "assets.usages");
  } catch {
    const error = response.status === 401 ? "authentication_required" : response.status === 403 ? "forbidden" : "invalid_response";
    write({ error }, response.status, 1, operationId);
    return;
  }
  if (upload) {
    if (!response.ok) {
      const error = response.status === 409 && result.error === "duplicate_operation" ? "duplicate_operation" : "upload_intent_failed";
      return write({ error }, response.status, 1, operationId);
    }
    return uploadFile(upload, result, origin, operationId);
  }
  write(result, response.status, response.ok ? 0 : 1, operationId);
}

main().catch((error) => {
  if (error instanceof InputError) write({ error: error.message }, null, 2);
  else write({ error: "cli_error" }, null, 1);
});
