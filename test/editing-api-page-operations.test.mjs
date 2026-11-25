import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi } from "@niho/web/editing-api";
import { createPageEditingApiClient } from "@niho/web/editing-client";
import { createMemoryPageOperationHost } from "../examples/memory-page-operation-host.mjs";

const document = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const { siteId, pageId, locale } = document, target = { siteId, pageId, locale };
const origin = "https://edit.example";
const path = `/api/edit/v1/sites/${siteId}/operations/pages.apply/${pageId}?locale=${locale}`;
const dependencies = { stylesVersion: "styles-1", componentsVersion: "components-1", presentationVersion: "site-1" };
const actor = { kind: "machine", subject: "principal", delegatedBy: "owner", clientKind: "cli" };
const oneLetter = { type: "text", parentId: "heading", childPath: [0], value: "海のそばで暮ごす" };
const operation = (operations = [oneLetter], extra = {}) => ({ baseVersion: "v1", operationId: crypto.randomUUID(), operations, ...dependencies, ...extra });

function host(context, authenticatedActor = actor) {
  const storage = createMemoryPageOperationHost([{ document, version: "v1", ...dependencies }], context);
  const api = createPageEditingApi({
    ...storage,
    async authenticate(request) {
      const auth = request.headers.get("Authorization");
      if (auth === "Bearer writer") return authenticatedActor;
      if (auth === "Bearer other") return { ...actor, subject: "other" };
      return auth ? { ...actor, subject: "reader" } : null;
    },
    async authorize(actor, capability, scope) {
      return scope.siteId === siteId && (scope.pageId === undefined || scope.pageId === pageId) && (capability === "pages.read" || capability === "pages.edit" && actor.subject !== "reader");
    },
  });
  const call = (body, auth = "writer") => api(new Request(origin + path, { method: "POST", headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const client = createPageEditingApiClient({ origin, siteId, headers: { Authorization: "Bearer writer" }, fetch: (url, options) => api(new Request(url, options)) });
  return { storage, client, call };
}

test("pages.apply discovers the stable operation schema and retries the exact applied result", async () => {
  const { storage, client, call } = host();
  const discovered = (await client.discover()).operations.find(({ id }) => id === "pages.apply");
  assert.equal(discovered.method, "POST");
  assert.equal(discovered.capability, "pages.edit");
  assert.equal(discovered.inputSchema.$defs.editorOperationById.oneOf.some((schema) => schema.properties.type.const === "text"), true);

  const input = operation();
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1024);
  const dryRun = await client.applyOperations(target, { ...input, dryRun: true });
  assert.deepEqual(dryRun.touched, ["heading"]);
  assert.equal(dryRun.diff[0].after, oneLetter.value);
  assert.equal((await client.read(target)).version, "v1");
  assert.equal(storage.readJournal().length, 0);

  const applied = await client.applyOperations(target, input);
  assert.equal(applied.status, "applied");
  assert.equal(applied.revision, 2);
  assert.equal(applied.document.body[0].children[0].children[0].text, oneLetter.value);
  const next = await client.applyOperations(target, operation([{ type: "title", value: "A later edit" }], { baseVersion: applied.version }));
  assert.equal(next.revision, 3);
  const repr = { childPath: [0], value: oneLetter.value, parentId: "heading", type: "text" };
  assert.deepEqual(await client.applyOperations(target, { ...input, operationId: input.operationId.toUpperCase(), operations: [repr], dryRun: false }), applied);
  assert.equal(await (await call({ ...input, operations: [{ ...oneLetter, value: "other" }] })).json().then(({ error }) => error), "duplicate_operation");
  assert.equal((await call(input, "other")).status, 409, "an unrelated actor cannot replay someone else's response");
  const journal = storage.readJournal();
  assert.equal(journal.length, 2);
  assert.deepEqual(journal[0].actor, actor);
  assert.equal(journal[0].inputHash.length, 64);
  assert.deepEqual(journal[0].input.operations, [oneLetter]);
  assert.equal(journal[1].input.baseVersion, applied.version);
  assert.equal((await client.read(target)).stylesVersion, dependencies.stylesVersion);
});

test("pages.apply rejects stale dependency CAS, bad batches and unauthorized actor fields without partial writes", async () => {
  const { storage, call, client } = host({ locks: [{ nodeId: "heading", fields: ["children"], reason: "Locked text" }] });
  for (const version of Object.keys(dependencies)) {
    const stale = await call(operation(undefined, { [version]: "stale" }));
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "version_conflict" });
  }
  const title = { type: "title", value: "Never stored" };
  const malformed = [
    oneLetter,
    { ...oneLetter, childPath: ["0"] },
    { ...oneLetter, unknown: true },
    { type: "restore", document },
    { type: "token", name: "ink" },
    { type: "textStyle", name: "lead" },
    { type: "replaceAsset", from: {}, to: {} },
    { type: "replaceChildren", nodeId: "heading", children: [] },
    { type: "styles", nodeId: "hero", breakpoint: "base", values: { color: { token: "ink", extra: true } } },
    { type: "add", parentId: null, node: { type: "element", id: "extra", tag: "p", children: [{ type: "text", text: "new", unknown: true }] } },
  ];
  for (const invalid of malformed) {
    const response = await call(operation([title, invalid]));
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.equal(result.error, "validation_failed");
    assert.equal(result.index, 1);
    assert.ok(result.reason);
  }
  const reusable = operation([title, oneLetter]);
  assert.equal((await call(reusable)).status, 422);
  assert.equal((await call(operation([title], { actor }))).status, 400);
  assert.equal((await call(operation([title], { operationId: "not-a-uuid" }))).status, 400);
  assert.equal((await call(operation([]))).status, 400);
  assert.equal((await call(operation(Array.from({ length: 501 }, () => title)))).status, 400);
  assert.equal((await call(operation([title]), null)).status, 401);
  assert.equal((await call(operation([title]), "reader")).status, 403);
  assert.equal((await client.read(target)).document.title, document.title);
  assert.equal(storage.readJournal().length, 0);

  const valid = { ...reusable, operations: [{ type: "styles", nodeId: "hero", breakpoint: "base", values: { padding: undefined } }] };
  const saved = await client.applyOperations(target, valid);
  assert.equal(saved.status, "applied");
  assert.equal(saved.document.body[0].style.base.padding, undefined);
  assert.deepEqual(storage.readJournal()[0].input.operations[0].values, { padding: null });
});

test("pages.apply serializes competing requests and deduplicates concurrent retries", async () => {
  const { client, storage } = host();
  const input = operation(), competing = operation([{ type: "title", value: "Competing edit" }]);
  const [first, retry, other] = await Promise.all([client.applyOperations(target, input), client.applyOperations(target, input), client.applyOperations(target, competing)]);
  assert.deepEqual(first, retry);
  const saved = await client.read(target);
  assert.equal(saved.document.revision, 2);
  assert.equal(storage.readJournal().length, 1);
  assert.notEqual(first.status, other.status);
});

test("pages.apply accepts omitted optional dependency versions and requires an authenticated client kind", async () => {
  const { client } = host();
  const title = { type: "title", value: "依存版は任意" };
  const applied = await client.applyOperations(target, { baseVersion: "v1", operationId: crypto.randomUUID(), operations: [title] });
  assert.equal(applied.status, "applied");

  const missingClientKind = host(undefined, { kind: "human", subject: "staff" });
  assert.equal((await missingClientKind.call(operation([title]))).status, 502);
});
