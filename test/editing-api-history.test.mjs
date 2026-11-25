import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi, EDITING_OPERATIONS } from "@niho/web/editing-api";

const document = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };
const revisionId = "opaque/revision-1";
const entry = { id: revisionId, revision: 8, kind: "draft", createdAt: "2026-11-25T10:00:00.000Z", actor: "編集AI", actorKind: "machine", delegatedBy: "編集者", operations: [
  { type: "style", targetId: "hero", targetType: "element", targetTag: "section", field: "color" }
] };

function setup(overrides = {}) {
  const calls = { list: [], read: [] };
  const api = createPageEditingApi({
    async authenticate(request) {
      const token = request.headers.get("Authorization");
      if (token === "Bearer history") return { kind: "machine", subject: "private-agent-id", delegatedBy: "private-owner-id" };
      if (token === "Bearer page-reader") return { kind: "human", subject: "page-reader" };
      return null;
    },
    async authorize(actor, capability, scope) {
      return scope.siteId === target.siteId && (actor.subject === "private-agent-id" ? capability === "pages.history.read" : actor.subject === "page-reader" && capability === "pages.read");
    },
    async readPage() { return { document, version: "v1" }; },
    async savePage() { return { status: "conflict" }; },
    async listPageHistory(actor, requested, cursor) {
      calls.list.push({ subject: actor.subject, target: requested, cursor });
      return overrides.list ?? { entries: [entry], ...(cursor === undefined ? { next: "next-page" } : {}) };
    },
    async readPageHistoryRevision(actor, requested, id) {
      calls.read.push({ subject: actor.subject, target: requested, id });
      return overrides.read ?? { document, siteStyles: { tokens: {} } };
    },
    ...(overrides.validationContext ? { validationContext: overrides.validationContext } : {})
  });
  const send = (method, path, body, authorization = "Bearer history") => api(new Request(`https://host.example/api/edit/v1${path}`, {
    method, headers: { Authorization: authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  return { send, calls };
}
const json = async (response) => ({ status: response.status, body: await response.json() });
const base = `/sites/${target.siteId}/operations`;
const historyList = `${base}/pages.history/${target.pageId}?locale=${encodeURIComponent(target.locale)}`;
const historyRead = `${base}/pages.history-read/${target.pageId}?locale=${encodeURIComponent(target.locale)}`;

test("history operations require their own permission and return sanitized operation summaries", async () => {
  const { send, calls } = setup();
  const discovery = await json(await send("GET", `/sites/${target.siteId}/capabilities`));
  assert.deepEqual(discovery.body.operations.filter(({ id }) => id.startsWith("pages.history")).map(({ id, capability }) => [id, capability]), [
    ["pages.history", "pages.history.read"], ["pages.history-read", "pages.history.read"]
  ]);
  const listed = await json(await send("GET", `${historyList}&cursor=next-1`));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.entries, [entry]);
  assert.deepEqual(calls.list[0], { subject: "private-agent-id", target, cursor: "next-1" });
  assert.deepEqual(await json(await send("GET", historyList, undefined, "Bearer page-reader")), { status: 403, body: { error: "forbidden" } });
  assert.deepEqual(await json(await send("GET", historyList, undefined, null)), { status: 401, body: { error: "authentication_required" } });
});

test("revision snapshots are read by POST body ID, target checked, and strict about host data", async () => {
  const { send, calls } = setup();
  const result = await json(await send("POST", historyRead, { id: revisionId }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { document, siteStyles: { tokens: {} } });
  assert.equal(calls.read[0].id, revisionId);
  assert.equal(historyRead.includes(revisionId), false, "opaque revision ID must not be part of the URL");
  assert.deepEqual(await json(await send("POST", historyRead, { id: revisionId, email: "private@example.test" })), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await json(await send("GET", `${historyRead}&id=${encodeURIComponent(revisionId)}`)), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await json(await send("GET", historyRead)), { status: 405, body: { error: "method_not_allowed" } });
  assert.deepEqual(await json(await send("POST", historyRead, { id: revisionId }, "Bearer page-reader")), { status: 403, body: { error: "forbidden" } });

  const mismatched = setup({ read: { document: { ...document, pageId: "another-page" } } });
  assert.deepEqual(await json(await mismatched.send("POST", historyRead, { id: revisionId })), { status: 502, body: { error: "host_contract_violation" } });
  const leaked = setup({ list: { entries: [{ ...entry, operations: [{ ...entry.operations[0], before: "private text" }] }] } });
  assert.deepEqual(await json(await leaked.send("GET", historyList)), { status: 502, body: { error: "host_contract_violation" } });
});

test("revision documents are validated against their saved site styles", async () => {
  const historicalDocument = structuredClone(document);
  historicalDocument.body[0].style.base.color = { token: "oldBrand" };
  const historicalSiteStyles = { tokens: { oldBrand: { type: "color", value: "#123456" } } };
  const { send } = setup({
    read: { document: historicalDocument, siteStyles: historicalSiteStyles },
    validationContext: async () => ({ siteStyles: { tokens: { currentBrand: { type: "color", value: "#abcdef" } } } })
  });

  const result = await json(await send("POST", historyRead, { id: revisionId }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { document: historicalDocument, siteStyles: historicalSiteStyles });
});

test("history operations are absent until the host implements the corresponding storage method", async () => {
  const api = createPageEditingApi({
    async authenticate() { return { kind: "human", subject: "owner" }; }, async authorize() { return true; },
    async readPage() { return null; }, async savePage() { return { status: "conflict" }; }
  });
  const response = await api(new Request(`https://host.example/api/edit/v1/sites/${target.siteId}/capabilities`));
  const body = await response.json();
  assert.equal(body.operations.some(({ id }) => id === "pages.history" || id === "pages.history-read"), false);
  assert.ok(EDITING_OPERATIONS.some(({ id }) => id === "pages.history"));
});
