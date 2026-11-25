import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EDITING_OPERATIONS } from "@niho/web/editing-api";
import { NIHO_EDIT_COMMANDS } from "../cli/niho-edit-usage.mjs";

const fixture = JSON.parse(await readFile(new URL("../examples/page.json", import.meta.url), "utf8"));
const cli = fileURLToPath(new URL("../cli/niho-edit.mjs", import.meta.url));
const origin = "https://site.example";
const siteId = fixture.siteId;
const pageId = fixture.pageId;
const locale = fixture.locale;

function startMcp({ env }) {
  const child = spawn(process.execPath, [cli, "--origin", origin, "--site", siteId, "mcp"], {
    env, stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let nextId = 1;
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  });
  child.once("close", (code) => {
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({ error: { code, message: stderr || "MCP server closed before replying" } });
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; ${stderr}`));
      }, 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    child,
    async initialize() {
      const response = await request("initialize", {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "niho-edit-test", version: "1.0.0" }
      });
      assert.equal(response.error, undefined, JSON.stringify(response.error ?? stderr));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return response;
    },
    request,
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await once(child, "close");
    }
  };
}

function runCli(args, env, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdin.end(stdin);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("niho-edit MCP mirrors the CLI command list and output, and fixes the configured target", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "mock-fetch.mjs");
  const expectedUrl = `${origin}/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const discoveryUrl = `${origin}/api/edit/v1/sites/${siteId}/capabilities`;
  const applyUrl = `${origin}/api/edit/v1/sites/${siteId}/operations/pages.apply/${pageId}?locale=${encodeURIComponent(locale)}`;
  const studioDiscoveryUrl = `${origin}/api/edit/v2/sites/${siteId}/capabilities`;
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const operations = [
    { type: "text", parentId: "heading", childPath: [0], value: "Updated through MCP" },
    { type: "style", nodeId: "heading", breakpoint: "base", property: "color", value: { token: "brand" } }
  ];
  const catalog = ["pages.read", "pages.apply"].map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const apiResponse = { document: fixture, version: "v1" };
  const studioResponse = { contractVersion: 2, siteId, schemaRevision: "initial", operations: ["cms.items.save"] };
  const validApply = { status: "valid", diff: [
    { path: "h1#heading のテキスト", before: "旧見出し", after: "Updated through MCP" },
    { path: "h1#heading の見た目（共通）: color", before: "#000", after: "@brand" }
  ], touched: ["heading"] };
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === ${JSON.stringify(expectedUrl)} && init.method === "GET") {
      return new Response(${JSON.stringify(JSON.stringify(apiResponse))}, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target === ${JSON.stringify(discoveryUrl)} && init.method === "GET") {
      return new Response(${JSON.stringify(JSON.stringify({ apiVersion: "v1", siteId, operations: catalog }))}, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target === ${JSON.stringify(studioDiscoveryUrl)} && init.method === "GET") {
      const headers = new Headers(init.headers);
      if (headers.get("Authorization") !== null || headers.get("cf-access-token") !== "fixture-token" || headers.get("X-Studio-CMS-Version") !== "2") throw new Error("unexpected Studio authentication");
      return new Response(${JSON.stringify(JSON.stringify(studioResponse))}, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target === ${JSON.stringify(applyUrl)} && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body) !== ${JSON.stringify(JSON.stringify({ baseVersion: "v1", operationId, operations, dryRun: true }))}) throw new Error("unexpected apply input");
      return new Response(${JSON.stringify(JSON.stringify(validApply))}, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected API request");
  };\n`);
  const env = { ...process.env, NIHO_EDIT_TOKEN: "fixture-token",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" ") };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;

  const mcp = startMcp({ env });
  t.after(() => mcp.close());
  await mcp.initialize();
  const listed = await mcp.request("tools/list", {});
  assert.equal(listed.error, undefined, JSON.stringify(listed.error));
  assert.deepEqual(listed.result.tools.map(({ name }) => name).sort(), [...NIHO_EDIT_COMMANDS].sort());

  const toolResult = await mcp.request("tools/call", {
    name: "read", arguments: { args: [pageId, "--locale", locale] }
  });
  assert.equal(toolResult.error, undefined, JSON.stringify(toolResult.error));
  assert.equal(toolResult.result.isError, undefined);
  const directResult = await runCli(["--origin", origin, "--site", siteId, "read", pageId, "--locale", locale], env);
  assert.equal(directResult.exitCode, 0, directResult.stderr);
  assert.equal(toolResult.result.content[0].text, directResult.stdout);

  const applyArgs = [pageId, "--locale", locale, "--ops", "-", "--dry-run", "--expected-version", "v1", "--operation-id", operationId];
  const applyToolResult = await mcp.request("tools/call", {
    name: "apply", arguments: { args: applyArgs, stdin: JSON.stringify(operations) }
  });
  assert.equal(applyToolResult.error, undefined, JSON.stringify(applyToolResult.error));
  assert.equal(applyToolResult.result.isError, undefined);
  const directApply = await runCli(["--origin", origin, "--site", siteId, "apply", ...applyArgs], env, JSON.stringify(operations));
  assert.equal(directApply.exitCode, 0, directApply.stderr);
  assert.equal(applyToolResult.result.content[0].text, directApply.stdout);
  assert.deepEqual(JSON.parse(applyToolResult.result.content[0].text).result.diff, validApply.diff);

  const cmsToolResult = await mcp.request("tools/call", { name: "cms-discover", arguments: { args: ["--studio"] } });
  assert.equal(cmsToolResult.error, undefined, JSON.stringify(cmsToolResult.error));
  assert.equal(cmsToolResult.result.isError, undefined);
  const directCmsResult = await runCli(["--origin", origin, "--site", siteId, "cms-discover", "--studio"], env);
  assert.equal(directCmsResult.exitCode, 0, directCmsResult.stderr);
  assert.equal(cmsToolResult.result.content[0].text, directCmsResult.stdout);

  const redirected = await mcp.request("tools/call", {
    name: "read", arguments: { args: [pageId, "--locale", locale, "--origin", "https://other.example"] }
  });
  assert.equal(redirected.error, undefined, JSON.stringify(redirected.error));
  assert.equal(redirected.result.isError, true);
  assert.equal(redirected.result.content[0].text, "{\"error\":\"invalid_arguments\"}\n");
});
