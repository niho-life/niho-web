import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { EDITING_OPERATIONS } from "@niho/web/editing-api";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const command = fileURLToPath(new URL("../cli/niho-edit.mjs", import.meta.url));
const origin = "https://site.example", siteId = fixture.siteId, pageId = fixture.pageId, locale = fixture.locale;
const playwrightAvailable = (() => { try { import.meta.resolve("playwright"); return true; } catch { return false; } })();

function run(args, { status = 200, result, expectedMethod, expectedUrl, expectedBody, stdin, assertInputBeforeTimeout = false,
  accessClientId = null, accessClientSecret = null, env = {}, token = "fixture-token", location = null, studio = false, operationKey = null } = {}) {
  const timeoutGuard = assertInputBeforeTimeout ? `let stdinEnded = false;
    process.stdin.once("end", () => { stdinEnded = true; });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms) => { if (!stdinEnded) throw new Error("timeout started before stdin completed"); return originalTimeout(ms); };
  ` : "";
  const source = `${timeoutGuard}globalThis.fetch = async (url, init) => {
    if (String(url) !== ${JSON.stringify(expectedUrl)}) throw new Error("unexpected URL");
    if (init.method !== ${JSON.stringify(expectedMethod)}) throw new Error("unexpected method");
    if (init.redirect !== "manual" || init.credentials !== "omit") throw new Error("unsafe API fetch defaults");
    const headers = new Headers(init.headers);
    if (headers.get("Authorization") !== ${JSON.stringify(studio ? null : "Bearer fixture-token")}) throw new Error("missing authorization");
    if (headers.get("cf-access-token") !== ${JSON.stringify(studio && !accessClientId ? token : null)}) throw new Error("unexpected Access token");
    if (headers.get("X-Studio-CMS-Version") !== ${JSON.stringify(studio ? "2" : null)}) throw new Error("unexpected CMS version");
    if (headers.get("X-Studio-Operation-Key") !== ${JSON.stringify(operationKey)}) throw new Error("unexpected operation key");
    if (headers.get("CF-Access-Client-Id") !== ${JSON.stringify(accessClientId)} || headers.get("CF-Access-Client-Secret") !== ${JSON.stringify(accessClientSecret)}) throw new Error("unexpected Access credentials");
    const body = init.body ? JSON.parse(init.body) : null;
    if (JSON.stringify(body) !== ${JSON.stringify(JSON.stringify(expectedBody ?? null))}) throw new Error("unexpected body");
    return new Response(${JSON.stringify(JSON.stringify(result ?? {}))}, { status: ${status}, headers: { "Content-Type": "application/json", ...${JSON.stringify(location ? { Location: location } : {})} } });
  };`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  return new Promise((resolve, reject) => {
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].includes(key)));
    if (token === null) delete childEnv.NIHO_EDIT_TOKEN;
    else childEnv.NIHO_EDIT_TOKEN = token;
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, ["--import", preload, command, "--origin", origin, "--site", siteId, ...args], {
      env: childEnv, stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(stdin ?? "");
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runSequence(args, requests, { env = {}, token = "fixture-token", stdin = "" } = {}) {
  const source = [
    "const expected = " + JSON.stringify(requests) + "; let index = 0;",
    "globalThis.fetch = async (url, init) => {",
    "  const request = expected[index++];",
    "  if (!request || String(url) !== request.url || init.method !== request.method) throw new Error('unexpected request');",
    "  if (init.redirect !== 'manual' || init.credentials !== 'omit') throw new Error('unsafe API fetch defaults');",
    "  const headers = new Headers(init.headers);",
    "  if (headers.get('Authorization') !== 'Bearer fixture-token') throw new Error('missing authorization');",
    "  if (init.body && JSON.stringify(JSON.parse(init.body)) !== JSON.stringify(request.body ?? null)) throw new Error('unexpected request body');",
    "  return new Response(JSON.stringify(request.result ?? {}), { status: request.status ?? 200, headers: { 'Content-Type': 'application/json' } });",
    "};",
    "process.on('beforeExit', () => { if (index !== expected.length) throw new Error('not all expected requests were made'); });"
  ].join("\n");
  const preload = "data:text/javascript," + encodeURIComponent(source);
  return new Promise((resolve, reject) => {
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].includes(key)));
    if (token === null) delete childEnv.NIHO_EDIT_TOKEN;
    else childEnv.NIHO_EDIT_TOKEN = token;
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, ["--import", preload, command, "--origin", origin, "--site", siteId, ...args], {
      env: childEnv, stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(stdin);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runUpload(args, { uploadUrl, expectedBytes, asset, name = "sea.png", trustedUploadOrigin = origin, accessClientId = null, accessClientSecret = null }) {
  const source = `let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (calls === 1) {
        if (String(url) !== ${JSON.stringify(`${origin}/api/edit/v1/sites/${siteId}/operations/assets.upload-intent`)} || init.method !== "POST") throw new Error("unexpected intent request");
        const headers = new Headers(init.headers);
        if (headers.get("Authorization") !== "Bearer fixture-token") throw new Error("missing editing token");
        if (headers.get("CF-Access-Client-Id") !== ${JSON.stringify(accessClientId)} || headers.get("CF-Access-Client-Secret") !== ${JSON.stringify(accessClientSecret)}) throw new Error("missing API Access credentials");
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== ${JSON.stringify(JSON.stringify({ name, mimeType: "image/png", bytes: expectedBytes.length, folderId: null, provider: "kamakura-upload" }))}) throw new Error("invalid upload metadata");
        return new Response(JSON.stringify({ uploadUrl: ${JSON.stringify(uploadUrl)}, uploadToken: "short-lived", assetId: ${JSON.stringify(asset.id)} }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (calls !== 2 || String(url) !== ${JSON.stringify(uploadUrl)} || init.method !== "PUT" || init.credentials !== "omit" || init.redirect !== "error") throw new Error("unexpected upload PUT");
      const headers = new Headers(init.headers);
      if (headers.get("Authorization") !== "Bearer short-lived" || headers.get("Content-Type") !== "image/png") throw new Error("unsafe upload headers");
      const sameOriginAccess = new URL(${JSON.stringify(uploadUrl)}).origin === ${JSON.stringify(origin)};
      if (headers.get("CF-Access-Client-Id") !== (sameOriginAccess ? ${JSON.stringify(accessClientId)} : null)
        || headers.get("CF-Access-Client-Secret") !== (sameOriginAccess ? ${JSON.stringify(accessClientSecret)} : null)) throw new Error("Access credentials crossed origins");
      if (!Buffer.from(init.body).equals(Buffer.from(${JSON.stringify(Buffer.from(expectedBytes).toString("base64"))}, "base64"))) throw new Error("upload bytes differ");
      return new Response(JSON.stringify({ asset: ${JSON.stringify(asset)} }), { status: 201, headers: { "Content-Type": "application/json" } });
    };
    process.on("beforeExit", () => { if (calls !== ${new URL(uploadUrl).origin === origin || new URL(uploadUrl).origin === trustedUploadOrigin ? 2 : 1}) throw new Error("unexpected upload request count"); });`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  return new Promise((resolve, reject) => {
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].includes(key)));
    childEnv.NIHO_EDIT_TOKEN = "fixture-token";
    if (accessClientId !== null) childEnv.CF_ACCESS_CLIENT_ID = accessClientId;
    if (accessClientSecret !== null) childEnv.CF_ACCESS_CLIENT_SECRET = accessClientSecret;
    const child = spawn(process.execPath, ["--import", preload, command, "--origin", origin, "--site", siteId, ...args], {
      env: { ...childEnv, NIHO_EDIT_UPLOAD_ORIGIN: trustedUploadOrigin }, stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end("");
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("niho-edit reads a page over the host API without Studio or a browser", async () => {
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${path}`, result: { document: fixture, version: "v1" }
  });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { document: fixture, version: "v1" });
  assert.deepEqual(EDITING_OPERATIONS.filter(({ id }) => !id.startsWith("localization.")).map(({ id }) => id), ["pages.inspect", "pages.read", "pages.save", "pages.apply", "pages.preview-intent", "pages.release-plan", "pages.release", "pages.release-set-plan", "pages.release-set", "pages.release-set-status", "pages.catalog", "pages.change-prepare", "pages.change-apply",
    "cms.schema", "cms.list", "cms.read", "cms.create", "cms.save", "cms.publish-plan", "cms.publish", "cms.operation-status", "site.breakpoints.read", "site.breakpoints.save",
    "assets.list", "assets.usages", "assets.resolve", "assets.update", "assets.upload-intent", "assets.delete", "assets.restore"]);
});

test("niho-edit preview returns private URLs when the optional browser is unavailable", { skip: playwrightAvailable }, async () => {
  const previewUrl = "https://site.example/_private-preview/opaque-id";
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const discoverUrl = `${origin}/api/edit/v1/sites/${siteId}/capabilities`;
  const catalogUrl = `${origin}/api/edit/v1/sites/${siteId}/operations/pages.catalog`;
  const intentUrl = `${origin}/api/edit/v1/sites/${siteId}/operations/pages.preview-intent/${pageId}?locale=${encodeURIComponent(locale)}`;
  const previewOperation = EDITING_OPERATIONS.find(({ id }) => id === "pages.preview-intent");
  const catalogOperation = EDITING_OPERATIONS.find(({ id }) => id === "pages.catalog");
  const result = await runSequence(["preview", pageId, "--locale", locale, "--widths", "375,768,1280", "--compare", "published"], [
    { method: "GET", url: discoverUrl, result: { apiVersion: "v1", siteId, operations: [previewOperation, catalogOperation] } },
    { method: "GET", url: catalogUrl, result: { version: "catalog-v1", pages: [{ siteId, pageId, locale, title: "Home", path: "/home", kind: "page", visibility: "public", published: true }] } },
    { method: "POST", url: intentUrl, body: {}, result: { url: previewUrl, expiresAt } }
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { url: previewUrl, expiresAt, publishedUrl: `${origin}/home` });
});

test("niho-edit outline uses pages.inspect when the host exposes it", async () => {
  const discoverUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const inspectUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.inspect/" + pageId + "?locale=" + encodeURIComponent(locale) + "&view=outline&limit=1000&depth=1";
  const operation = EDITING_OPERATIONS.find(({ id }) => id === "pages.inspect");
  const result = await runSequence(["outline", pageId, "--locale", locale, "--depth", "1"], [
    { method: "GET", url: discoverUrl, result: { apiVersion: "v1", siteId, operations: [operation] } },
    { method: "GET", url: inspectUrl, result: { view: "outline", version: "v1", definitions: {}, items: [{ id: "hero" }] } }
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { view: "outline", version: "v1", definitions: {}, items: [{ id: "hero" }] });
});

test("niho-edit apply accepts text, token style, add and move operations", async () => {
  const operations = [
    { type: "text", parentId: "heading", childPath: [0], value: "A clearer heading" },
    { type: "style", nodeId: "heading", breakpoint: "base", property: "color", value: { token: "brand" } },
    { type: "add", parentId: "hero", index: 2, node: { type: "element", id: "new-block", tag: "p", children: [{ type: "text", text: "Added" }] } },
    { type: "move", nodeId: "link", parentId: "hero", index: 0 }
  ];
  const operationId = "123e4567-e89b-42d3-a456-426614174000", query = `?locale=${encodeURIComponent(locale)}`;
  const discoveryUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const readUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.read/" + pageId + query;
  const applyUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.apply/" + pageId + query;
  const catalog = ["pages.read", "pages.apply"].map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const result = await runSequence(["apply", pageId, "--locale", locale, "--ops", "-", "--operation-id", operationId, "--expected-version", "v1", "--dry-run"], [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } },
    { method: "GET", url: readUrl, result: { document: fixture, version: "v1" } },
    { method: "POST", url: applyUrl, body: { baseVersion: "v1", operationId, operations, dryRun: true }, result: {
      status: "valid", diff: [
        { path: "h1#heading のテキスト", before: "旧見出し", after: "A clearer heading" },
        { path: "h1#heading の見た目（共通）: color", before: "#000", after: "@brand" },
        { path: "p#new-block を追加", before: "（なし）", after: "Added" },
        { path: "a#link の位置", before: "section#hero の 3 番目", after: "section#hero の 1 番目" }
      ], touched: ["heading", "new-block", "link"]
    } }
  ], { stdin: JSON.stringify(operations) });
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout).result;
  assert.equal(output.status, "valid");
  assert.equal(output.diff.length, 4);
  assert.deepEqual(output.touched, ["heading", "new-block", "link"]);
});

test("niho-edit apply uses pages.apply and its dry-run diff matches the saved document", async () => {
  const operations = [{ type: "title", value: "Updated by CLI" }], operationId = "123e4567-e89b-42d3-a456-426614174000";
  const operationsJson = JSON.stringify(operations), query = `?locale=${encodeURIComponent(locale)}`;
  const discoveryUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const readUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.read/" + pageId + query;
  const applyUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.apply/" + pageId + query;
  const catalog = ["pages.read", "pages.save", "pages.apply"].map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const changed = { ...fixture, title: "Updated by CLI", revision: fixture.revision + 1 };
  const diff = [{ path: "ページタイトル", before: fixture.title, after: changed.title }];
  const prefix = ["apply", pageId, "--locale", locale, "--ops", "-", "--operation-id", operationId, "--expected-version", "v1"];
  const dryRun = await runSequence([...prefix, "--dry-run"], [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } },
    { method: "GET", url: readUrl, result: { document: fixture, version: "v1" } },
    { method: "POST", url: applyUrl, body: { baseVersion: "v1", operationId, operations, dryRun: true }, result: { status: "valid", diff, touched: [] } }
  ], { stdin: operationsJson });
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  const dryResult = JSON.parse(dryRun.stdout).result;
  assert.equal(dryResult.status, "valid");
  assert.equal(dryResult.validation, "host");
  assert.deepEqual(dryResult.diff, diff);

  const applied = await runSequence(prefix, [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } },
    { method: "GET", url: readUrl, result: { document: fixture, version: "v1" } },
    { method: "POST", url: applyUrl, body: { baseVersion: "v1", operationId, operations }, result: { status: "applied", version: "v2", revision: changed.revision, document: changed } }
  ], { stdin: operationsJson });
  assert.equal(applied.exitCode, 0, applied.stderr);
  const appliedResult = JSON.parse(applied.stdout).result;
  assert.equal(appliedResult.status, "applied");
  assert.equal(appliedResult.operationId, operationId);
  assert.deepEqual(appliedResult.diff, dryResult.diff);
});

test("niho-edit apply requires an explicit base version when the operation ID is fixed", async () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const discoveryUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const catalog = ["pages.read", "pages.apply"].map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const result = await runSequence(["apply", pageId, "--locale", locale, "--ops", "-", "--operation-id", operationId], [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } }
  ], { stdin: JSON.stringify([{ type: "title", value: "Stable retry" }]) });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 400, operation: null,
    result: { error: "operation_id_requires_expected_version" } });
});

test("niho-edit apply uses pages.read and pages.save when pages.apply is unavailable", async () => {
  const operations = [{ type: "title", value: "Saved by fallback" }], operationsJson = JSON.stringify(operations);
  const query = `?locale=${encodeURIComponent(locale)}`;
  const discoveryUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const readUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.read/" + pageId + query;
  const saveUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.save/" + pageId + query;
  const catalog = ["pages.read", "pages.save"].map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const withComponentInstance = { ...fixture, body: [...fixture.body, { type: "instance", id: "shared-header", component: "shared-header" }] };
  const changed = { ...withComponentInstance, title: "Saved by fallback", revision: fixture.revision + 1 };
  const result = await runSequence(["apply", pageId, "--locale", locale, "--ops", "-"], [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } },
    { method: "GET", url: readUrl, result: { document: withComponentInstance, version: "v1" } },
    { method: "PUT", url: saveUrl, body: { expectedVersion: "v1", document: { ...changed, revision: fixture.revision } },
      result: { status: "saved", version: "v2", document: changed } }
  ], { stdin: operationsJson });
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout).result;
  assert.equal(output.status, "saved");
  assert.equal(output.validation, "host-on-save");
  assert.match(output.warning, /trusted context/u);
  assert.deepEqual(output.diff, [{ path: "ページタイトル", before: withComponentInstance.title, after: changed.title }]);

  const dryRun = await runSequence(["apply", pageId, "--locale", locale, "--ops", "-", "--dry-run"], [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } },
    { method: "GET", url: readUrl, result: { document: withComponentInstance, version: "v1" } }
  ], { stdin: operationsJson });
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  const dryOutput = JSON.parse(dryRun.stdout).result;
  assert.equal(dryOutput.status, "valid");
  assert.equal(dryOutput.validation, "local-untrusted");
  assert.match(dryOutput.warning, /最終検証はホスト/u);
  assert.deepEqual(dryOutput.diff, output.diff);
  assert.deepEqual(dryOutput.touched, output.touched);
});

test("niho-edit apply reports the failed operation index, reason and target node", async () => {
  const operations = [{ type: "text", parentId: "heading", childPath: [0], value: "Changed" }], operationId = "123e4567-e89b-42d3-a456-426614174000";
  const query = `?locale=${encodeURIComponent(locale)}`;
  const discoveryUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const readUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.read/" + pageId + query;
  const applyUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.apply/" + pageId + query;
  const catalog = ["pages.read", "pages.apply"].map((id) => EDITING_OPERATIONS.find((operation) => operation.id === id));
  const result = await runSequence(["apply", pageId, "--locale", locale, "--ops", "-", "--operation-id", operationId, "--expected-version", "v1"], [
    { method: "GET", url: discoveryUrl, result: { apiVersion: "v1", siteId, operations: catalog } },
    { method: "GET", url: readUrl, result: { document: fixture, version: "v1" } },
    { method: "POST", url: applyUrl, body: { baseVersion: "v1", operationId, operations }, status: 422,
      result: { error: "validation_failed", index: 0, reason: "text path not found" } }
  ], { stdin: JSON.stringify(operations) });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 422, operation: null,
    result: { error: "validation_failed", index: 0, reason: "text path not found", nodeId: "heading", operationId, baseVersion: "v1" } });
});

test("niho-edit falls back to pages.read and resolves public URLs through pages.catalog", async () => {
  const catalogUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.catalog";
  const discoverUrl = origin + "/api/edit/v1/sites/" + siteId + "/capabilities";
  const readUrl = origin + "/api/edit/v1/sites/" + siteId + "/operations/pages.read/" + pageId + "?locale=" + encodeURIComponent(locale);
  const result = await runSequence(["find", "--url", "https://public.example/", "--locale", locale, "--node", "heading"], [
    { method: "GET", url: catalogUrl, result: { version: "catalog-v1", pages: [{ siteId, pageId, locale, title: "Home", path: "/" }] } },
    { method: "GET", url: discoverUrl, result: { apiVersion: "v1", siteId, operations: [EDITING_OPERATIONS.find(({ id }) => id === "pages.read")] } },
    { method: "GET", url: readUrl, result: { document: fixture, version: "v1", stylesVersion: "styles-v1" } }
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.view, "find");
  assert.equal(output.version, "v1");
  assert.equal(output.stylesVersion, "styles-v1");
  assert.deepEqual(output.items.map(({ id }) => id), ["heading"]);
});

test("niho-edit sends Cloudflare Access service credentials and keeps host bearer auth", async () => {
  const accessClientId = `${"a".repeat(32)}.access`, accessClientSecret = "fixture-access-secret";
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${path}`, result: { document: fixture, version: "v1" },
    accessClientId, accessClientSecret, env: { CF_ACCESS_CLIENT_ID: accessClientId, CF_ACCESS_CLIENT_SECRET: accessClientSecret }
  });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { document: fixture, version: "v1" });
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-access-secret/u);
});

test("niho-edit rejects partial Access service credentials without making a request", async () => {
  const accessClientId = `${"b".repeat(32)}.access`;
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${path}`,
    env: { CF_ACCESS_CLIENT_ID: accessClientId }
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: null, operation: null, result: { error: "invalid_access_credentials" } });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(accessClientId, "u"));
});

test("niho-edit reports Access redirects without following or exposing the destination", async () => {
  const accessClientId = `${"c".repeat(32)}.access`, accessClientSecret = "redirect-fixture-secret";
  const destination = "https://access-login.example/cdn-cgi/access/login?token=redirect-fixture-secret";
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = await run(["read", pageId, "--locale", locale], {
    status: 302, location: destination, expectedMethod: "GET", expectedUrl: `${origin}${path}`,
    accessClientId, accessClientSecret, env: { CF_ACCESS_CLIENT_ID: accessClientId, CF_ACCESS_CLIENT_SECRET: accessClientSecret }
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 302, operation: null, result: { error: "access_redirect" } });
  assert.doesNotMatch(result.stdout + result.stderr, /access-login|redirect-fixture-secret|Location/u);
});

test("Cloudflare Access service credentials do not replace the host editing token", async () => {
  const accessClientId = `${"d".repeat(32)}.access`, accessClientSecret = "fixture-access-secret";
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${path}`, token: null,
    env: { CF_ACCESS_CLIENT_ID: accessClientId, CF_ACCESS_CLIENT_SECRET: accessClientSecret }
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: null, operation: null, result: { error: "missing_token" } });
});

test("niho-edit lists and updates stable assets through the shared host API", async (t) => {
  const listed = await run(["assets-list", "--search", "sea", "--kind", "image", "--provider", "uploads", "--limit", "1", "--recent"], {
    expectedMethod: "GET", expectedUrl: `${origin}/api/edit/v1/sites/${siteId}/operations/assets.list?search=sea&kind=image&limit=1&provider=uploads&recent=true`, result: { assets: [], folders: [] }
  });
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), { assets: [], folders: [] });

  const directory = await mkdtemp(join(tmpdir(), "niho-edit-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "asset.json");
  await writeFile(snapshotPath, JSON.stringify({ version: "etag-v1", changes: { alt: "海辺" } }));
  const updatePath = `/api/edit/v1/sites/${siteId}/operations/assets.update/uploads/sea`;
  const asset = { provider: "uploads", id: "sea", siteId, kind: "image", status: "ready", name: "sea.webp", mimeType: "image/webp", bytes: 12, alt: "海辺", version: "etag-v2", updatedAt: "2026-11-20T00:00:00Z" };
  const updated = await run(["assets-update", "uploads", "sea", "--json", snapshotPath], {
    expectedMethod: "PUT", expectedUrl: `${origin}${updatePath}`, expectedBody: { expectedVersion: "etag-v1", changes: { alt: "海辺" } }, result: { status: "saved", asset }
  });
  assert.equal(updated.exitCode, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), { apiVersion: "v1", httpStatus: 200, operation: "assets.update", result: { status: "saved", asset } });
});

test("niho-edit uploads bytes with a same-origin one-time asset token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-asset-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sea.png"), bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(file, bytes);
  const asset = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000", siteId, kind: "image", status: "ready", name: "custom.png", mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, alt: "", version: "etag-v1", updatedAt: "2026-11-20T00:00:00Z" };
  const uploadUrl = `${origin}/internal/studio/asset-upload/${asset.id}`;
  const accessClientId = `${"e".repeat(32)}.access`, accessClientSecret = "fixture-access-secret";
  const result = await runUpload(["assets-upload", file, "--mime-type", "image/png", "--provider", asset.provider, "--name", "custom.png"], {
    uploadUrl, expectedBytes: bytes, asset, name: "custom.png", accessClientId, accessClientSecret
  });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 201, operation: "assets.upload", result: { status: "uploaded", asset } });
});

test("niho-edit uploads to a configured host upload origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-asset-upload-trusted-origin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sea.png"), bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(file, bytes);
  const asset = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000", siteId, kind: "image", status: "ready", name: "sea.png", mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, alt: "", version: "etag-v1", updatedAt: "2026-11-20T00:00:00Z" };
  const trustedUploadOrigin = "https://next-site.example";
  const uploadUrl = `${trustedUploadOrigin}/internal/studio/asset-upload/${asset.id}`;
  const accessClientId = `${"f".repeat(32)}.access`, accessClientSecret = "fixture-access-secret";
  const result = await runUpload(["assets-upload", file, "--mime-type", "image/png", "--provider", asset.provider, "--upload-origin", trustedUploadOrigin], {
    uploadUrl, expectedBytes: bytes, asset, trustedUploadOrigin, accessClientId, accessClientSecret
  });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout).result, { status: "uploaded", asset });
});

test("niho-edit refuses to send an upload token to an unconfigured different origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-asset-upload-origin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sea.png");
  await writeFile(file, Buffer.from([1, 2, 3]));
  const asset = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000", siteId, kind: "image", status: "ready", name: "sea.png", mimeType: "image/png", bytes: 3, alt: "", version: "etag-v1", updatedAt: "2026-11-20T00:00:00Z" };
  const result = await runUpload(["assets-upload", file, "--mime-type", "image/png", "--provider", asset.provider], { uploadUrl: "https://evil.example/upload", expectedBytes: Buffer.from([1, 2, 3]), asset });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout).result, { error: "invalid_upload_intent" });
});

test("niho-edit lists pages directly from the host API", async () => {
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.catalog`;
  const catalog = { version: "registry-v1", pages: [{ siteId, pageId, locale: "ja", title: "Home", path: "/", kind: "page", visibility: "public", published: true }] };
  const result = await run(["pages-catalog"], { expectedMethod: "GET", expectedUrl: `${origin}${path}`, result: catalog });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), catalog);
});

test("niho-edit applies a reviewed page-management plan directly to the host API", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-page-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const change = { action: "create", siteId, locale: "ja", title: "New page", path: "/new-page" };
  const plan = { expectedVersion: "registry-v1", operationId, change, confirmationToken: "page-change-token", domain: origin,
    impact: { linkedFrom: Array.from({ length: 250 }, (_, index) => ({ pageId: `link-${index}`, locale: "ja", title: `参照元ページ ${index} ${"説明文".repeat(12)}`, count: 1 })), navigation: [], notes: ["新しいページを作成します"] } };
  const planPath = join(directory, "plan.json");
  const serializedPlan = JSON.stringify(plan);
  assert.ok(Buffer.byteLength(serializedPlan) > 16 * 1024, "valid plans with many linked pages can exceed the change input limit");
  await writeFile(planPath, serializedPlan);
  const apiPath = `/api/edit/v1/sites/${siteId}/operations/pages.change-apply`;
  const page = { siteId, pageId: "new-page", locale: "ja", title: change.title, path: change.path, kind: "page", visibility: "public", published: false };
  const result = await run(["page-change-apply", "--json", planPath], {
    expectedMethod: "POST", expectedUrl: `${origin}${apiPath}`,
    expectedBody: { expectedVersion: plan.expectedVersion, operationId, confirmationToken: plan.confirmationToken, change },
    result: { status: "applied", operationId, page }
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 200, operation: "pages.change-apply", result: { status: "applied", page, operationId } });
});

test("niho-edit reads and CAS-saves site breakpoints over the host API", async (t) => {
  const settings = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const readPath = `/api/edit/v1/sites/${siteId}/operations/site.breakpoints.read`;
  const read = await run(["breakpoints-read"], { expectedMethod: "GET", expectedUrl: `${origin}${readPath}`, result: { settings, version: "b.1" } });
  assert.equal(read.exitCode, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { settings, version: "b.1" });

  const directory = await mkdtemp(join(tmpdir(), "niho-edit-breakpoints-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "settings.json");
  await writeFile(snapshotPath, JSON.stringify({ settings, version: "b.1" }));
  const savePath = `/api/edit/v1/sites/${siteId}/operations/site.breakpoints.save`;
  const next = structuredClone(settings); next.breakpoints[0].previewWidth = 800;
  await writeFile(snapshotPath, JSON.stringify({ settings: next, version: "b.1" }));
  const saved = await run(["breakpoints-save", "--json", snapshotPath], {
    expectedMethod: "PUT", expectedUrl: `${origin}${savePath}`, expectedBody: { expectedVersion: "b.1", settings: next },
    result: { status: "saved", version: "b.2" }
  });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { apiVersion: "v1", httpStatus: 200, operation: "site.breakpoints.save", result: { status: "saved", version: "b.2" } });

  const conflict = await run(["breakpoints-save", "--json", snapshotPath], {
    status: 409, expectedMethod: "PUT", expectedUrl: `${origin}${savePath}`, expectedBody: { expectedVersion: "b.1", settings: next },
    result: { error: "version_conflict" }
  });
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(JSON.parse(conflict.stdout), { apiVersion: "v1", httpStatus: 409, operation: "site.breakpoints.save", result: { error: "version_conflict" } });
});

test("niho-edit preserves host-specific component blocks on read and save", async (t) => {
  const custom = structuredClone(fixture);
  custom.body.push({ type: "component", id: "booking-panel", block: "booking-panel", props: { title: "Book a visit" } });
  const readPath = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const read = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${readPath}`, result: { document: custom, version: "v1" }
  });
  assert.equal(read.exitCode, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).document, custom);

  const directory = await mkdtemp(join(tmpdir(), "niho-edit-custom-block-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({ document: custom, version: "v1" }));
  const savePath = `/api/edit/v1/sites/${siteId}/operations/pages.save/${pageId}?locale=${encodeURIComponent(locale)}`;
  const savedDocument = { ...custom, revision: custom.revision + 1 };
  const saved = await run(["save", pageId, "--locale", locale, "--json", snapshotPath], {
    expectedMethod: "PUT", expectedUrl: `${origin}${savePath}`, expectedBody: { expectedVersion: "v1", document: custom },
    result: { status: "saved", version: "v2", document: savedDocument }
  });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { document: savedDocument, version: "v2" });
});

test("niho-edit saves the edited document with the snapshot version and reports conflicts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const changed = structuredClone(fixture); changed.title = "Edited by CLI";
  changed.body[0].style.base.backgroundColor = "#e8f0e8";
  changed.body[0].children.push({ type: "element", id: "contact-form", tag: "form", attrs: { name: "contact" }, children: [
    { type: "element", id: "contact-name-label", tag: "label", attrs: { htmlFor: "contact-name" }, children: [{ type: "text", text: "Name" }] },
    { type: "element", id: "contact-name", tag: "input", attrs: { type: "text", name: "name", id: "contact-name", required: true }, children: [] }
  ] });
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({ document: changed, version: "v1" }));
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.save/${pageId}?locale=${encodeURIComponent(locale)}`;
  const args = ["save", pageId, "--locale", locale, "--json", snapshotPath];
  const body = { expectedVersion: "v1", document: changed };
  const savedDocument = { ...changed, revision: changed.revision + 1 };
  const saved = await run(args, { expectedMethod: "PUT", expectedUrl: `${origin}${path}`, expectedBody: body, result: { status: "saved", version: "v2", document: savedDocument } });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { document: savedDocument, version: "v2" });

  const conflict = await run(args, { status: 409, expectedMethod: "PUT", expectedUrl: `${origin}${path}`, expectedBody: body, result: { error: "version_conflict" } });
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(JSON.parse(conflict.stdout).result, { error: "version_conflict" });
  assert.equal(JSON.parse(conflict.stdout).httpStatus, 409);
});

test("niho-edit starts the save timeout after reading a stdin snapshot", async () => {
  const document = structuredClone(fixture);
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.save/${pageId}?locale=${encodeURIComponent(locale)}`;
  const savedDocument = { ...document, revision: document.revision + 1 };
  const result = await run(["save", pageId, "--locale", locale, "--json", "-"], {
    expectedMethod: "PUT", expectedUrl: `${origin}${path}`, expectedBody: { expectedVersion: "v1", document },
    result: { status: "saved", version: "v2", document: savedDocument }, stdin: JSON.stringify({ document, version: "v1" }),
    assertInputBeforeTimeout: true
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { document: savedDocument, version: "v2" });
});

test("niho-edit reviews a release plan and retries publication with the same operation ID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { siteId, pageId, locale };
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({ document: fixture, version: "v2", componentsVersion: "components-v1", presentationVersion: "presentation-v1" }));
  const plan = { target, expectedVersion: "v2", action: "publish", componentsVersion: "components-v1", presentationVersion: "presentation-v1", confirmationToken: "one-use-token", domain: "https://site.example", changes: [] };
  const preparePath = `/api/edit/v1/sites/${siteId}/operations/pages.release-plan/${pageId}?locale=${encodeURIComponent(locale)}`;
  const prepared = await run(["release-plan", pageId, "--locale", locale, "--action", "publish", "--json", snapshotPath], {
    expectedMethod: "POST", expectedUrl: `${origin}${preparePath}`, expectedBody: { expectedVersion: "v2", action: "publish", componentsVersion: "components-v1", presentationVersion: "presentation-v1" }, result: { plan }
  });
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), plan);

  const planPath = join(directory, "release-plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const applyPath = `/api/edit/v1/sites/${siteId}/operations/pages.release/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = { status: "released", operationId, version: "v3", document: fixture };
  const args = ["release", pageId, "--locale", locale, "--json", planPath, "--operation-id", operationId];
  const applied = await run(args, { expectedMethod: "POST", expectedUrl: `${origin}${applyPath}`, expectedBody: { expectedVersion: "v2", confirmationToken: plan.confirmationToken, operationId }, result });
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).result, result);
  const retried = await run(args, { expectedMethod: "POST", expectedUrl: `${origin}${applyPath}`, expectedBody: { expectedVersion: "v2", confirmationToken: plan.confirmationToken, operationId }, result });
  assert.equal(retried.exitCode, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout).result, result);
});

test("niho-edit prepares, applies and checks an idempotent multi-page release set", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-release-set-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const items = [
    { target: { siteId, pageId, locale }, expectedVersion: "v2", componentsVersion: "components-v1", presentationVersion: "presentation-v1" },
    { target: { siteId, pageId: "about", locale }, expectedVersion: "about-v3" }
  ];
  const itemsPath = join(directory, "items.json");
  await writeFile(itemsPath, JSON.stringify({ items }));
  const preparePath = `/api/edit/v1/sites/${siteId}/operations/pages.release-set-plan`;
  const plan = { siteId, operationId, confirmationToken: "set-token-once", domain: origin, items };
  const prepared = await run(["page-release-set-plan", "--json", itemsPath, "--operation-id", operationId], {
    expectedMethod: "POST", expectedUrl: `${origin}${preparePath}`, expectedBody: { siteId, operationId, items }, result: { plan }
  });
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), plan);

  const planPath = join(directory, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const applyResult = { status: "completed", operationId, items: [
    { target: items[0].target, status: "released", version: "v3" }, { target: items[1].target, status: "released", version: "about-v4" }
  ] };
  const applyPath = `/api/edit/v1/sites/${siteId}/operations/pages.release-set`;
  const applied = await run(["page-release-set-apply", "--json", planPath], {
    expectedMethod: "POST", expectedUrl: `${origin}${applyPath}`,
    expectedBody: { siteId, operationId, confirmationToken: plan.confirmationToken, items }, result: applyResult
  });
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout), { apiVersion: "v1", httpStatus: 200, operation: "pages.release-set", result: applyResult });

  const status = { status: "completed", operationId, httpStatus: 200, result: applyResult };
  const statusPath = `/api/edit/v1/sites/${siteId}/operations/pages.release-set-status/${operationId}`;
  const checked = await run(["page-release-set-status", "--operation-id", operationId], {
    expectedMethod: "GET", expectedUrl: `${origin}${statusPath}`, result: status
  });
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), status);
});

test("niho-edit prepares a queued singleton through the generic release-set API", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-single-release-set-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationId = "423e4567-e89b-42d3-a456-426614174000";
  const items = [{ target: { siteId, pageId, locale }, expectedVersion: "v2" }];
  const itemsPath = join(directory, "items.json");
  await writeFile(itemsPath, JSON.stringify({ items }));
  const preparePath = `/api/edit/v1/sites/${siteId}/operations/pages.release-set-plan`;
  const plan = { siteId, operationId, confirmationToken: "single-set-token", domain: origin, items };
  const prepared = await run(["page-release-set-plan", "--json", itemsPath, "--operation-id", operationId], {
    expectedMethod: "POST", expectedUrl: `${origin}${preparePath}`, expectedBody: { siteId, operationId, items }, result: { plan }
  });
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), plan);
});

test("niho-edit reads translation items and job state directly from the site", async () => {
  const operations = `${origin}/api/edit/v1/sites/${siteId}/operations`;
  const jobs = await run(["localization-jobs-read", "job-1"], {
    expectedMethod: "GET", expectedUrl: `${operations}/localization.jobs.read?jobId=job-1`,
    result: { status: "ready", job: { jobId: "job-1", state: "running", message: null } },
  });
  assert.equal(jobs.exitCode, 0, jobs.stdout);
  assert.equal(JSON.parse(jobs.stdout).result.job.state, "running");

  const list = await run(["localization-items-list", "--cursor", "cursor-2"], {
    expectedMethod: "GET", expectedUrl: `${operations}/localization.items.list?cursor=cursor-2`,
    result: { status: "ready", items: [], nextCursor: null },
  });
  assert.equal(list.exitCode, 0, list.stdout);
  assert.deepEqual(JSON.parse(list.stdout), { apiVersion: "v1", httpStatus: 200, operation: "localization.items.list",
    result: { status: "ready", items: [], nextCursor: null } });

  const release = await run(["localization-release-read"], {
    expectedMethod: "GET", expectedUrl: `${operations}/localization.release.read`,
    result: { status: "ready", current: null, history: [], pending: null },
  });
  assert.equal(release.exitCode, 0, release.stdout);
  assert.equal(JSON.parse(release.stdout).operation, "localization.release.read");
});

test("niho-edit preserves localization CAS conflict values and reads release tokens from JSON input", async () => {
  const operations = `${origin}/api/edit/v1/sites/${siteId}/operations`;
  const settings = { version: "settings-v2", autoDraft: true, translator: { connected: true },
    queue: { waiting: 1, failed: 0, nextRetryAt: null } };
  const change = { expectedVersion: "settings-v1", operationId: "fixture-operation-1", autoDraft: false };
  const conflict = { error: "version_conflict", current: settings };
  const save = await run(["localization-settings-save", "--json", "-"], {
    status: 409, result: conflict, stdin: JSON.stringify(change), expectedMethod: "PUT", assertInputBeforeTimeout: true,
    expectedUrl: `${operations}/localization.settings.save`, expectedBody: { siteId, ...change },
  });
  assert.equal(save.exitCode, 1, save.stdout);
  assert.deepEqual(JSON.parse(save.stdout), { apiVersion: "v1", httpStatus: 409, operation: "localization.settings.save", result: conflict });

  const translate = { expectedVersion: "overview-v1", operationId: "fixture-operation-2", unitIds: ["title"] };
  const queued = await run(["localization-items-translate", "aG9tZQ", "--json", "-"], {
    stdin: JSON.stringify(translate), expectedMethod: "POST",
    expectedUrl: `${operations}/localization.items.translate`, expectedBody: { siteId, itemKey: "aG9tZQ", ...translate },
    result: { status: "queued", job: { jobId: "job-1", state: "queued", message: null } },
  });
  assert.equal(queued.exitCode, 0, queued.stdout);
  assert.equal(JSON.parse(queued.stdout).result.job.jobId, "job-1");

  const apply = { operation: "publish", expectedVersion: "overview-v1", confirmationToken: null, resumeToken: "release-resume-token" };
  const applying = { status: "applying", progress: { done: 1, total: 2 }, resumeToken: "next-resume-token", waiting: "uploading" };
  const release = await run(["localization-release-apply", "--json", "-"], {
    result: applying, stdin: JSON.stringify(apply), expectedMethod: "POST",
    expectedUrl: `${operations}/localization.release.apply`, expectedBody: { siteId, ...apply },
  });
  assert.equal(release.exitCode, 0, release.stdout);
  assert.deepEqual(JSON.parse(release.stdout).result, applying);
  const invalid = await run(["localization-release-apply", "--json", "-"], {
    stdin: JSON.stringify({ ...apply, confirmationToken: "unexpected-second-token" }),
  });
  assert.equal(invalid.exitCode, 1);
  assert.equal(JSON.parse(invalid.stdout).result.error, "invalid_json_input");
});

test("niho-edit selects managed CMS v2 with Access authentication and an explicit retry key", async () => {
  const discovery = { contractVersion: 2, siteId, schemaRevision: "initial", operations: ["cms.items.save"] };
  const capabilities = await run(["--studio", "cms-discover"], {
    studio: true, expectedMethod: "GET", expectedUrl: `${origin}/api/edit/v2/sites/${siteId}/capabilities`, result: discovery
  });
  assert.equal(capabilities.exitCode, 0);
  assert.deepEqual(JSON.parse(capabilities.stdout).result, discovery);
  const payload = { siteId, collectionId: "posts", itemId: "item_example", locale: "ja", contractVersion: 2,
    expectedSchemaRevision: "initial", expectedRevision: "rev_example", values: { title: "Fixture" } };
  const operationKey = crypto.randomUUID(), accessClientId = `${"e".repeat(32)}.access`, accessClientSecret = "fixture-service";
  const updated = await run(["--studio", "cms-v2", "cms.items.save", "--json", "-", "--operation-id", operationKey], {
    studio: true, operationKey, token: null, accessClientId, accessClientSecret,
    env: { CF_ACCESS_CLIENT_ID: accessClientId, CF_ACCESS_CLIENT_SECRET: accessClientSecret },
    expectedMethod: "POST", expectedUrl: `${origin}/api/edit/v2/sites/${siteId}/operations/cms.items.save`,
    expectedBody: payload, stdin: JSON.stringify(payload), result: { status: "saved" }
  });
  assert.equal(updated.exitCode, 0);
  assert.deepEqual(JSON.parse(updated.stdout).result, { status: "saved" });
});
