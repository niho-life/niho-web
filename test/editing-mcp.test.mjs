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
import { editDocumentById } from "@niho/web/editor-model";
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

  function request(method, params, timeoutMs = 5000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; ${stderr}`));
      }, timeoutMs);
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

  const earlyExit = await mcp.request("tools/call", {
    name: "read", arguments: { args: ["invalid page id", "--locale", locale], stdin: "x".repeat(1024 * 1024) }
  });
  assert.equal(earlyExit.error, undefined, JSON.stringify(earlyExit.error));
  assert.equal(earlyExit.result.isError, true);
  const afterEarlyExit = await mcp.request("tools/list", {});
  assert.equal(afterEarlyExit.error, undefined, JSON.stringify(afterEarlyExit.error));
  assert.deepEqual(afterEarlyExit.result.tools.map(({ name }) => name).sort(), [...NIHO_EDIT_COMMANDS].sort());
});

test("AI editing guide workflow edits and publishes text and token color on a synthetic site", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-guide-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "mock-fetch.mjs");
  const statePath = join(directory, "site-state.json");
  const previewOut = join(directory, "previews");
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const releaseOperationId = "123e4567-e89b-42d3-a456-426614174001";
  const previewUrl = `${origin}/_private-preview/opaque-id`;
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const operations = [
    { type: "text", parentId: "heading", childPath: [0], value: "ガイド経由で更新した見出し" },
    { type: "style", nodeId: "heading", breakpoint: "base", property: "color", value: { token: "brand" } }
  ];
  const editedDocument = operations.reduce((document, operation) =>
    editDocumentById(document, operation, {}, [], undefined, undefined, false), structuredClone(fixture));
  editedDocument.revision = fixture.revision + 1;
  const catalog = ["pages.inspect", "pages.read", "pages.apply", "pages.preview-intent", "pages.release-plan", "pages.release"]
    .map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const route = `${origin}/api/edit/v1/sites/${siteId}`;
  const paths = Object.fromEntries(["pages.read", "pages.inspect", "pages.apply", "pages.preview-intent", "pages.release-plan", "pages.release"]
    .map((operation) => [operation, `${route}/operations/${operation}/${pageId}`]));
  const plan = {
    target: { siteId, pageId, locale }, expectedVersion: "v2", action: "publish", confirmationToken: "confirm-v2",
    domain: origin, changes: [{ path: "h1#heading のテキスト", before: "旧見出し", after: operations[0].value }]
  };
  await writeFile(statePath, JSON.stringify({ document: fixture, version: "v1", published: false }));
  await writeFile(preload, `
import { readFile, writeFile } from "node:fs/promises";
const statePath = ${JSON.stringify(statePath)};
const origin = ${JSON.stringify(origin)};
const siteId = ${JSON.stringify(siteId)};
const pageId = ${JSON.stringify(pageId)};
const locale = ${JSON.stringify(locale)};
const route = ${JSON.stringify(route)};
const paths = ${JSON.stringify(paths)};
const catalog = ${JSON.stringify(catalog)};
const operations = ${JSON.stringify(operations)};
const editedDocument = ${JSON.stringify(editedDocument)};
const operationId = ${JSON.stringify(operationId)};
const releaseOperationId = ${JSON.stringify(releaseOperationId)};
const previewUrl = ${JSON.stringify(previewUrl)};
const expiresAt = ${JSON.stringify(expiresAt)};
const plan = ${JSON.stringify(plan)};
const state = async () => JSON.parse(await readFile(statePath, "utf8"));
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method ?? "GET").toUpperCase();
  if (url.origin !== origin) throw new Error("unexpected origin");
  if (new Headers(init.headers).get("Authorization") !== "Bearer fixture-token") throw new Error("unexpected authentication");
  if (url.pathname === new URL(route + "/capabilities").pathname && method === "GET") {
    return json({ apiVersion: "v1", siteId, operations: catalog });
  }
  if (url.pathname === new URL(paths["pages.inspect"]).pathname && method === "GET") {
    const current = await state();
    const view = url.searchParams.get("view");
    if (view === "outline") return json({ view, version: current.version, definitions: {}, items: [{ id: "heading", tag: "h1" }] });
    if (view === "find") return json({ view, version: current.version, items: [{ id: "heading" }] });
    throw new Error("unexpected inspection view");
  }
  if (url.pathname === new URL(paths["pages.read"]).pathname && method === "GET") {
    const current = await state();
    return json({ document: current.document, version: current.version });
  }
  if (url.pathname === new URL(paths["pages.apply"]).pathname && method === "POST") {
    const current = await state();
    const body = JSON.parse(init.body);
    if (body.baseVersion !== current.version || body.operationId !== operationId || JSON.stringify(body.operations) !== JSON.stringify(operations)) {
      throw new Error("unexpected apply input");
    }
    if (body.dryRun === true) {
      return json({ status: "valid", diff: [
        { path: "h1#heading のテキスト", before: "旧見出し", after: operations[0].value },
        { path: "h1#heading の見た目（共通）: color", before: "#000", after: "@brand" }
      ], touched: ["heading"] });
    }
    current.document = editedDocument;
    current.version = "v2";
    await writeFile(statePath, JSON.stringify(current));
    return json({ status: "applied", version: current.version, revision: editedDocument.revision, document: editedDocument });
  }
  if (url.pathname === new URL(paths["pages.preview-intent"]).pathname && method === "POST") {
    return json({ url: previewUrl, expiresAt });
  }
  if (url.pathname === new URL(paths["pages.release-plan"]).pathname && method === "POST") {
    const body = JSON.parse(init.body);
    if (body.expectedVersion !== plan.expectedVersion || body.action !== plan.action) throw new Error("unexpected release-plan input");
    return json({ plan });
  }
  if (url.pathname === new URL(paths["pages.release"]).pathname && method === "POST") {
    const current = await state();
    const body = JSON.parse(init.body);
    if (current.version !== plan.expectedVersion || body.expectedVersion !== plan.expectedVersion
      || body.confirmationToken !== plan.confirmationToken || body.operationId !== releaseOperationId) throw new Error("unexpected release input");
    current.published = true;
    current.publishedVersion = "v3";
    await writeFile(statePath, JSON.stringify(current));
    return json({ status: "released", operationId: releaseOperationId, version: "v3", document: current.document });
  }
  if (url.href === previewUrl && method === "GET") {
    return new Response("<!doctype html><title>synthetic preview</title><h1>ガイド経由で更新した見出し</h1>", { status: 200, headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex"
    } });
  }
  throw new Error("unexpected API request: " + method + " " + url.href);
};
`);
  const env = { ...process.env, NIHO_EDIT_TOKEN: "fixture-token",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" ") };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;

  const mcp = startMcp({ env });
  t.after(() => mcp.close());
  await mcp.initialize();

  const outline = await mcp.request("tools/call", { name: "outline", arguments: { args: [pageId, "--locale", locale, "--depth", "2"] } });
  assert.equal(outline.error, undefined, JSON.stringify(outline.error));
  assert.deepEqual(JSON.parse(outline.result.content[0].text).items.map(({ id }) => id), ["heading"]);
  const found = await mcp.request("tools/call", { name: "find", arguments: { args: [pageId, "--locale", locale, "--text", "旧見出し"] } });
  assert.equal(found.error, undefined, JSON.stringify(found.error));
  assert.deepEqual(JSON.parse(found.result.content[0].text).items.map(({ id }) => id), ["heading"]);

  const applyArgs = [pageId, "--locale", locale, "--ops", "-", "--expected-version", "v1", "--operation-id", operationId];
  const dryRun = await mcp.request("tools/call", {
    name: "apply", arguments: { args: [...applyArgs, "--dry-run"], stdin: JSON.stringify(operations) }
  });
  assert.equal(dryRun.error, undefined, JSON.stringify(dryRun.error));
  const dryOutput = JSON.parse(dryRun.result.content[0].text).result;
  assert.equal(dryOutput.status, "valid");
  assert.equal(dryOutput.validation, "host");
  assert.equal(dryOutput.diff.length, 2);
  const applied = await mcp.request("tools/call", {
    name: "apply", arguments: { args: applyArgs, stdin: JSON.stringify(operations) }
  });
  assert.equal(applied.error, undefined, JSON.stringify(applied.error));
  const appliedOutput = JSON.parse(applied.result.content[0].text).result;
  assert.equal(appliedOutput.status, "applied");
  assert.equal(appliedOutput.version, "v2");
  assert.equal(appliedOutput.diff.length, 2);

  const preview = await mcp.request("tools/call", {
    name: "preview", arguments: { args: [pageId, "--locale", locale, "--widths", "375,768,1280", "--out", previewOut] }
  }, 100_000);
  assert.equal(preview.error, undefined, JSON.stringify(preview.error));
  assert.equal(JSON.parse(preview.result.content[0].text).url, previewUrl, preview.result.content[0].text);
  const planned = await mcp.request("tools/call", {
    name: "release-plan", arguments: { args: [pageId, "--locale", locale, "--action", "publish", "--expected-version", "v2"] }
  });
  assert.equal(planned.error, undefined, JSON.stringify(planned.error));
  const reviewedPlan = JSON.parse(planned.result.content[0].text);
  assert.equal(reviewedPlan.expectedVersion, "v2");
  assert.equal(reviewedPlan.domain, origin);
  const released = await mcp.request("tools/call", {
    name: "release", arguments: { args: [pageId, "--locale", locale, "--json", "-", "--operation-id", releaseOperationId], stdin: JSON.stringify(reviewedPlan) }
  });
  assert.equal(released.error, undefined, JSON.stringify(released.error));
  assert.equal(JSON.parse(released.result.content[0].text).result.status, "released");

  const finalState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(finalState.version, "v2");
  assert.equal(finalState.published, true);
  assert.equal(finalState.publishedVersion, "v3");
  const findNode = (nodes, id) => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const foundNode = node.children ? findNode(node.children, id) : undefined;
      if (foundNode) return foundNode;
    }
    return undefined;
  };
  const heading = findNode(finalState.document.body, "heading");
  assert.equal(heading.children[0].text, operations[0].value);
  assert.deepEqual(heading.style.base.color, { token: "brand" });
});
