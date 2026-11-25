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
const oneLetterPreconditions = { parentId: "heading", oldValue: "海のそばで過ごす", textPathContext: [{ type: "target" }] };
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
    { ...oneLetter, preconditions: { ...oneLetterPreconditions, textPathContext: [{ type: "target", extra: true }] } },
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

test("pages.apply safely rebases independent leaf edits and records the rebased version", async () => {
  const { client, storage } = host();
  const first = await client.applyOperations(target, operation([{
    type: "style", nodeId: "hero", breakpoint: "base", property: "color", value: "#334455",
    preconditions: { parentId: null, oldValue: { token: "ink" } },
  }]));
  assert.equal(first.status, "applied");

  const second = await client.applyOperations(target, operation([{
    type: "style", nodeId: "heading", breakpoint: "base", property: "color", value: "#556677",
    preconditions: { parentId: "hero", oldValue: null },
  }]));
  assert.equal(second.status, "applied");
  assert.equal(second.document.body[0].style.base.color, "#334455");
  assert.equal(second.document.body[0].children[0].style.base.color, "#556677");
  assert.equal(second.revision, 3);
  assert.equal(storage.readJournal()[1].input.baseVersion, "v1");
  assert.equal(storage.readJournal()[1].rebasedFromVersion, first.version);
});

test("pages.apply rebases a text edit while its exact child path context survives", async () => {
  const { storage, call, client } = host();
  const concurrent = structuredClone(document);
  concurrent.title = "Concurrent title";
  const concurrentSave = await storage.savePage(actor, target, "v1", concurrent);
  assert.equal(concurrentSave.status, "saved");

  const response = await call(operation([{ ...oneLetter, preconditions: oneLetterPreconditions }]));
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.document.title, "Concurrent title");
  assert.equal(saved.document.body[0].children[0].children[0].text, oneLetter.value);
  assert.equal(storage.readJournal()[0].rebasedFromVersion, concurrentSave.version);
  assert.equal((await client.read(target)).document.title, "Concurrent title");
});

test("pages.apply returns unmet preconditions for conflicting or unsupported stale operations", async () => {
  const sameField = host();
  await sameField.client.applyOperations(target, operation([{
    type: "style", nodeId: "hero", breakpoint: "base", property: "color", value: "#334455",
    preconditions: { parentId: null, oldValue: { token: "ink" } },
  }]));
  const conflict = await sameField.client.applyOperations(target, operation([{
    type: "style", nodeId: "hero", breakpoint: "base", property: "color", value: "#556677",
    preconditions: { parentId: null, oldValue: { token: "ink" } },
  }]));
  assert.deepEqual(conflict, { status: "conflict", unmetPreconditions: [{ index: 0, condition: "old_value" }] });
  assert.equal(sameField.storage.readJournal().length, 1);
  assert.equal((await sameField.client.read(target)).document.body[0].style.base.color, "#334455");

  const unsupported = host();
  await unsupported.client.applyOperations(target, operation([{ type: "title", value: "Concurrent" }]));
  const rejected = await unsupported.client.applyOperations(target, operation([{ type: "title", value: "Stale title" }]));
  assert.deepEqual(rejected, { status: "conflict", unmetPreconditions: [{ index: 0, condition: "rebase_supported" }] });
  assert.equal(unsupported.storage.readJournal().length, 1);
  assert.equal((await unsupported.client.read(target)).document.title, "Concurrent");

  const structuralText = host(), concurrent = structuredClone(document), heading = concurrent.body[0].children[0];
  heading.children.unshift(structuredClone(heading.children[0]));
  assert.equal((await structuralText.storage.savePage(actor, target, "v1", concurrent)).status, "saved");
  const response = await structuralText.call(operation([{ ...oneLetter, preconditions: oneLetterPreconditions }]));
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).unmetPreconditions, [{ index: 0, condition: "child_path" }]);
  const latest = await structuralText.client.read(target);
  assert.deepEqual(latest.document.body[0].children[0].children.map(({ text }) => text), ["海のそばで過ごす", "海のそばで過ごす"]);
});

test("pages.apply reports multiple failed conditions for one operation and never partially commits a batch", async () => {
  const { client, storage } = host();
  await client.applyOperations(target, operation([{
    type: "style", nodeId: "heading", breakpoint: "base", property: "color", value: "#334455",
    preconditions: { parentId: "hero", oldValue: null },
  }]));
  const conflict = await client.applyOperations(target, operation([{
    type: "style", nodeId: "hero", breakpoint: "base", property: "gap", value: 24,
    preconditions: { parentId: null, oldValue: 16 },
  }, {
    type: "style", nodeId: "heading", breakpoint: "base", property: "color", value: "#556677",
    preconditions: { parentId: "hero", oldValue: null },
  }]));
  assert.deepEqual(conflict, { status: "conflict", unmetPreconditions: [{ index: 1, condition: "old_value" }] });
  assert.equal(storage.readJournal().length, 1);
  const saved = (await client.read(target)).document;
  assert.equal(saved.body[0].style.base.gap, 16);
  assert.equal(saved.body[0].children[0].style.base.color, "#334455");

  const both = await client.applyOperations(target, operation([{
    type: "style", nodeId: "hero", breakpoint: "base", property: "gap", value: 24,
    preconditions: { parentId: "wrong-parent", oldValue: 8 },
  }]));
  assert.deepEqual(both, { status: "conflict", unmetPreconditions: [
    { index: 0, condition: "parent_id" }, { index: 0, condition: "old_value" },
  ] });
  assert.equal(storage.readJournal().length, 1);
});

test("pages.apply uses node anchors for insert and move while retaining numeric indices", async () => {
  const { client, call } = host();
  const added = (id) => ({ type: "element", id, tag: "p", children: [{ type: "text", text: id }] });
  let saved = await client.applyOperations(target, operation([{ type: "add", parentId: null, node: added("start"), anchor: { edge: "start" } }]));
  saved = await client.applyOperations(target, operation([{ type: "add", parentId: null, node: added("after"), anchor: { after: "hero" } }], { baseVersion: saved.version }));
  saved = await client.applyOperations(target, operation([{ type: "add", parentId: null, node: added("end"), anchor: { edge: "end" } }], { baseVersion: saved.version }));
  saved = await client.applyOperations(target, operation([{ type: "move", nodeId: "after", parentId: null, anchor: { before: "hero" } }], { baseVersion: saved.version }));
  assert.deepEqual(saved.document.body.map((node) => node.id), ["start", "after", "hero", "end"]);

  const indexed = await client.applyOperations(target, operation([{ type: "add", parentId: null, node: added("indexed"), index: 1 }], { baseVersion: saved.version }));
  assert.deepEqual(indexed.document.body.map((node) => node.id), ["start", "indexed", "after", "hero", "end"]);
  for (const invalid of [
    { type: "move", nodeId: "after", parentId: null },
    { type: "move", nodeId: "after", parentId: null, index: 0, anchor: { edge: "start" } },
    { type: "add", parentId: null, node: added("bad"), index: 0, anchor: { edge: "start" } },
    { type: "add", parentId: null, node: added("bad"), anchor: { before: "missing" } },
  ]) {
    const response = await call(operation([invalid], { baseVersion: indexed.version }));
    assert.equal(response.status, 422);
  }
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
