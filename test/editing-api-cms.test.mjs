import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPageEditingApi, EDITING_OPERATIONS } from "@niho/web/editing-api";
import { createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";
import { post, schema, toSummary } from "./collection-fixtures.mjs";

const siteId = "cms-example";
const operationIds = {
  create: "123e4567-e89b-42d3-a456-426614174000",
  save: "123e4567-e89b-42d3-a456-426614174001",
  staleSave: "123e4567-e89b-42d3-a456-426614174002",
  publish: "123e4567-e89b-42d3-a456-426614174003",
};

function cmsFixture(overrides = {}) {
  let item = post("p1", "記事", { status: "draft" }, { slug: "article" });
  const operations = new Map();
  const api = createPageEditingApi({
    async authenticate(request) {
      return request.headers.get("Authorization") === "Bearer editor" ? { kind: "machine", subject: "editor", delegatedBy: "owner" } : null;
    },
    async authorize(actor, capability, scope) {
      return actor.subject === "editor" && scope.siteId === siteId
        && (scope.collectionId === undefined || scope.collectionId === "posts")
        && ["cms.read", "cms.edit", "cms.publish"].includes(capability);
    },
    async readPage() { return null; },
    async savePage() { return { status: "conflict" }; },
    async readCmsSchema() { return schema(); },
    async listCmsItems(_actor, requestedSite, collectionId) {
      return requestedSite === siteId && collectionId === "posts" ? { status: "ready", collectionId, items: [toSummary(item)] } : { status: "not_found" };
    },
    async readCmsItem(_actor, target) {
      return target.siteId === siteId && target.collectionId === "posts" && target.itemId === item.id ? { status: "ready", item } : { status: "not_found" };
    },
    async createCmsItem(_actor, requestedSite, collectionId, operationId) {
      if (requestedSite !== siteId || collectionId !== "posts") return { status: "not_found" };
      if (operations.has(operationId)) return { status: "duplicate" };
      const created = post("new1", "", { status: "draft" });
      operations.set(operationId, { kind: "create", result: created });
      return { status: "created", item: created };
    },
    async saveCmsItem(_actor, target, expectedVersion, operationId, values) {
      if (target.siteId !== siteId || target.collectionId !== "posts" || target.itemId !== item.id) return { status: "not_found" };
      if (operations.has(operationId)) return { status: "duplicate" };
      if (expectedVersion !== item.version) return { status: "conflict", item };
      item = { ...item, title: values.title, values, version: "v2" };
      operations.set(operationId, { kind: "save", result: item });
      return { status: "saved", item };
    },
    async prepareCmsPublish(_actor, target, expectedVersion, operationId, options) {
      if (overrides.prepareCmsPublish) return overrides.prepareCmsPublish(_actor, target, expectedVersion, operationId, options);
      if (target.siteId !== siteId || target.collectionId !== "posts" || target.itemId !== item.id) return { status: "not_found" };
      if (operations.has(operationId)) return { status: "duplicate" };
      if (expectedVersion !== item.version) return { status: "conflict" };
      const plan = { target, expectedVersion, operationId, confirmationToken: "publish-token", item,
        ...(options?.redirect === undefined ? {} : { redirect: options.redirect }) };
      operations.set(operationId, { kind: "publish", plan });
      return { status: "prepared", plan };
    },
    async publishCmsItem(_actor, target, input) {
      const prepared = operations.get(input.operationId);
      if (!prepared || prepared.kind !== "publish" || prepared.plan.confirmationToken !== input.confirmationToken
        || prepared.plan.expectedVersion !== input.expectedVersion || prepared.plan.target.itemId !== target.itemId
        || prepared.plan.redirect !== input.redirect) return { status: "duplicate" };
      if (input.expectedVersion !== item.version) return { status: "conflict" };
      item = { ...item, status: "published", path: "/posts/article", publishedAt: "2026-10-20T09:00:00Z", version: "v3" };
      const result = { status: "published", operationId: input.operationId, item };
      operations.set(input.operationId, { ...prepared, result });
      return result;
    },
    async readCmsOperationStatus(_actor, requestedSite, operationId) {
      if (requestedSite !== siteId) return null;
      const operation = operations.get(operationId);
      return operation?.result ? { status: "completed", operationId, httpStatus: 200, result: operation.result } : { status: "unknown", operationId };
    },
  });
  const send = (method, path, body, authorization = "Bearer editor") => api(new Request(`https://host.example/api/edit/v1${path}`, {
    method,
    headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const client = createPageEditingApiClient({
    origin: "https://host.example", siteId, headers: { Authorization: "Bearer editor" },
    fetch: (input, init) => api(new Request(input, init)),
  });
  return { send, client };
}

function runCli(args, routes) {
  const command = fileURLToPath(new URL("../cli/niho-edit.mjs", import.meta.url));
  const source = `const routes = ${JSON.stringify(routes)};
    globalThis.fetch = async (url, init) => {
      const route = routes.shift();
      if (!route || String(url) !== route.url || init.method !== route.method) throw new Error("unexpected CMS CLI request");
      if (new Headers(init.headers).get("Authorization") !== "Bearer fixture-token") throw new Error("missing authorization");
      if (JSON.stringify(init.body ? JSON.parse(init.body) : null) !== JSON.stringify(route.body ?? null)) throw new Error("unexpected request body");
      return new Response(JSON.stringify(route.response), { status: route.status ?? 200, headers: { "Content-Type": "application/json" } });
    };
    process.on("beforeExit", () => { if (routes.length) throw new Error("expected CMS CLI request was not made"); });`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, command, "--origin", "https://host.example", "--site", siteId, ...args], {
      env: { ...process.env, NIHO_EDIT_TOKEN: "fixture-token" }, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("CMS operations expose one authenticated, versioned wire contract for machine clients", async () => {
  const { send, client } = cmsFixture();
  const discovered = await client.discover();
  assert.deepEqual(discovered.operations.slice(-8).map(({ id }) => id), [
    "cms.schema", "cms.list", "cms.read", "cms.create", "cms.save", "cms.publish-plan", "cms.publish", "cms.operation-status",
  ]);
  assert.deepEqual((await client.readCmsSchema()).map(({ id }) => id), ["posts", "circles", "tags"]);
  assert.equal((await client.listCmsItems("posts"))[0].id, "p1");
  assert.equal((await client.readCmsItem({ siteId, collectionId: "posts", itemId: "p1" })).version, "v1");

  const created = await client.createCmsItem("posts", operationIds.create);
  assert.equal(created.id, "new1");
  const changedValues = { ...created.values, title: "更新した記事" };
  const saved = await client.saveCmsItem({ siteId, collectionId: "posts", itemId: "p1" }, "v1", operationIds.save, changedValues);
  assert.equal(saved.status, "saved");
  if (saved.status === "saved") assert.equal(saved.item.version, "v2");
  const conflict = await client.saveCmsItem({ siteId, collectionId: "posts", itemId: "p1" }, "v1", operationIds.staleSave, changedValues);
  assert.equal(conflict.status, "conflict");
  if (conflict.status === "conflict") assert.equal(conflict.current.version, "v2");

  const target = { siteId, collectionId: "posts", itemId: "p1" };
  const plan = await client.prepareCmsPublish(target, "v2", operationIds.publish, undefined, false);
  assert.equal(plan.confirmationToken, "publish-token");
  assert.equal(plan.redirect, false);
  const applied = await client.publishCmsItem(plan);
  assert.equal(applied.status, "published");
  assert.deepEqual(await client.cmsOperationStatus(operationIds.publish), {
    status: "completed", operationId: operationIds.publish, httpStatus: 200,
    result: { status: "published", operationId: operationIds.publish, item: await client.readCmsItem(target) },
  });

  const denied = await send("GET", `/sites/${siteId}/operations/cms.read/posts/p1`, undefined, null);
  assert.equal(denied.status, 401);
  const invalid = await send("GET", `/sites/${siteId}/operations/cms.read/__proto__/p1`);
  assert.equal(invalid.status, 400);
  const invalidOperationEncoding = await send("GET", `/sites/${siteId}/operations/cms.operation-status/%FF`);
  assert.equal(invalidOperationEncoding.status, 400);
  const unsupportedCreate = await send("POST", `/sites/${siteId}/operations/cms.create/tags`, { operationId: "123e4567-e89b-42d3-a456-426614174005" });
  assert.equal(unsupportedCreate.status, 403);
});

test("CMS公開計画の検証エラーはGUI/CLI共通のfield detailsで返す", async () => {
  const errors = [{ field: "slug", message: "このアドレスは使えません。" }];
  const { client } = cmsFixture({ prepareCmsPublish: async () => ({ status: "invalid", errors }) });
  await assert.rejects(client.prepareCmsPublish({ siteId, collectionId: "posts", itemId: "p1" }, "v1", operationIds.publish), (error) => {
    assert.ok(error instanceof EditingApiClientError);
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, errors);
    return true;
  });
});

test("niho-edit reads and saves CMS snapshots directly through the common API", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-cms-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const item = post("p1", "記事", { status: "draft" }, { slug: "article" });
  const schemaUrl = "https://host.example/api/edit/v1/sites/cms-example/operations/cms.schema";
  const readPath = "https://host.example/api/edit/v1/sites/cms-example/operations/cms.read/posts/p1";
  const read = await runCli(["cms-read", "posts", "p1"], [
    { method: "GET", url: schemaUrl, response: { collections: schema().collections } },
    { method: "GET", url: readPath, response: { item } },
  ]);
  assert.equal(read.exitCode, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { id: item.id, version: "v1", values: item.values });

  const operationId = "123e4567-e89b-42d3-a456-426614174004";
  const nextValues = { ...item.values, title: "CUIで編集" };
  const basePath = join(directory, "base.json");
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(basePath, JSON.stringify({ id: item.id, version: item.version, values: item.values }));
  await writeFile(snapshotPath, JSON.stringify({ id: item.id, version: item.version, values: nextValues }));
  const diff = await runCli(["cms-diff", "--base", basePath, "--json", snapshotPath], []);
  assert.equal(diff.exitCode, 0, diff.stderr);
  assert.deepEqual(JSON.parse(diff.stdout), { id: item.id, version: item.version, changes: [{ field: "title", beforePresent: true, afterPresent: true, before: "記事", after: "CUIで編集" }] });
  const savedItem = { ...item, title: nextValues.title, version: "v2", values: nextValues };
  const save = await runCli(["cms-save", "posts", "p1", "--json", snapshotPath, "--operation-id", operationId], [
    { method: "GET", url: schemaUrl, response: { collections: schema().collections } },
    { method: "PUT", url: "https://host.example/api/edit/v1/sites/cms-example/operations/cms.save/posts/p1",
      body: { expectedVersion: "v1", operationId, values: nextValues }, response: { status: "saved", item: savedItem } },
  ]);
  assert.equal(save.exitCode, 0, save.stderr);
  assert.deepEqual(JSON.parse(save.stdout), { id: item.id, version: "v2", values: nextValues });
});

test("niho-edit CMS公開計画はリダイレクト選択をホストへ渡し、planへ保持する", async () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174005";
  const target = { siteId, collectionId: "posts", itemId: "p1" };
  const item = post("p1", "記事", { status: "published", path: "/posts/old" }, { slug: "old" });
  const plan = { target, expectedVersion: item.version, operationId, confirmationToken: "publish-token", item, redirect: false };
  const prepared = await runCli(["cms-publish-plan", "posts", "p1", "--expected-version", item.version, "--operation-id", operationId, "--redirect", "false"], [
    { method: "GET", url: "https://host.example/api/edit/v1/sites/cms-example/operations/cms.schema", response: { collections: schema().collections } },
    { method: "POST", url: "https://host.example/api/edit/v1/sites/cms-example/operations/cms.publish-plan/posts/p1",
      body: { expectedVersion: item.version, operationId, redirect: false }, response: { plan } },
  ]);
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), plan);
});
