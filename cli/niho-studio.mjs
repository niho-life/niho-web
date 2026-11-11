#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { parseArgs } from "node:util";
import { API_PREFIX, API_VERSION, SERVICE_CLIENT_ID, SCOPE_ID, resolveOperation } from "./operations.mjs";

const USAGE = `niho-studio --origin <https-origin> --project <project-id> --site <site-id> discover
niho-studio --origin <https-origin> --project <project-id> --site <site-id> request <operation> [args...] [--json <file|->]

Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the environment. Use --json - to read a JSON object from stdin.`;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

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

async function readObject(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("JSON size limit exceeded");
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value;
}

async function inputBody(path, action) {
  let input = {};
  if (path !== undefined) {
    try { input = await readObject(path === "-" ? process.stdin : createReadStream(path), MAX_INPUT_BYTES); }
    catch { throw new InputError("invalid_json_input"); }
  }
  if (action === undefined) return JSON.stringify(input);
  if (Object.hasOwn(input, "action") && input.action !== action) throw new InputError("invalid_action");
  return JSON.stringify({ ...input, action });
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

  let url, method, body;
  if (command === "discover") {
    if (id !== undefined || values.json !== undefined) throw new InputError("invalid_arguments");
    url = `${base}/capabilities`;
    method = "GET";
  } else if (command === "request") {
    const operation = resolveOperation(id, args);
    if (!operation) throw new InputError("invalid_operation");
    method = operation.spec.method;
    if (method === "GET" && values.json !== undefined) throw new InputError("unexpected_json_input");
    url = `${base}/operations/${[id, ...args].join("/")}`;
    if (method !== "GET") body = await inputBody(values.json, operation.spec.action);
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
  const operationId = header && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(header) ? header : null;
  let result;
  try {
    if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Expected JSON response");
    }
    result = await readObject(response.body, MAX_RESPONSE_BYTES);
  } catch {
    const error = response.status === 401 ? "authentication_required" : response.status === 403 ? "forbidden" : "invalid_response";
    write({ error }, response.status, 1, operationId);
    return;
  }
  write(result, response.status, response.ok ? 0 : 1, operationId);
}

main().catch((error) => {
  if (error instanceof InputError) write({ error: error.message }, null, 2);
  else write({ error: "cli_error" }, null, 1);
});
