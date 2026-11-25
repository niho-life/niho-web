import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createEditingApiHistoryAdapter, createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";

const document = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };

test("editing API client reads summaries and posts opaque revision IDs outside the URL", async () => {
  const calls = [];
  const client = createPageEditingApiClient({ origin: "https://host.example", siteId: target.siteId, fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    const body = String(input).includes("pages.history-read")
      ? { document, siteStyles: { tokens: {} } }
      : { entries: [{ id: "opaque/revision", revision: 2, kind: "draft", createdAt: "2026-11-25T10:00:00Z", actor: "編集AI", actorKind: "machine", delegatedBy: "編集者",
        operations: [{ type: "text", targetId: "heading", targetType: "element", targetTag: "h1", field: "text" }] }], next: "cursor/next" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  const page = await client.listPageHistory(target, "cursor/next");
  assert.equal(page.entries[0].operations[0].targetId, "heading");
  assert.equal(new URL(calls[0].url).searchParams.get("cursor"), "cursor/next");
  assert.equal(calls[0].init.method, "GET");
  const id = "opaque/revision#old";
  const snapshot = await client.readPageHistoryRevision(target, id);
  assert.equal(snapshot.document.pageId, target.pageId);
  assert.deepEqual(snapshot.siteStyles, { tokens: {} });
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { id });
  assert.equal(calls[1].url.includes(id), false);
});

test("editing API client rejects malformed history summaries and snapshots for another target", async () => {
  let payload = { entries: [{ id: "revision", revision: 1, kind: "draft", createdAt: "2026-11-25T10:00:00Z", operations: [{ type: "text", before: "leak" }] }] };
  const client = createPageEditingApiClient({ origin: "https://host.example", siteId: target.siteId, fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) });
  await assert.rejects(client.listPageHistory(target), (error) => error instanceof EditingApiClientError && error.code === "invalid_response");
  payload = { document: { ...document, pageId: "another-page" } };
  await assert.rejects(client.readPageHistoryRevision(target, "revision"), (error) => error instanceof EditingApiClientError && error.code === "invalid_response");
});

test("common history client methods can be wired into PageEditor without host-specific wrappers", async () => {
  const calls = [];
  const adapter = createEditingApiHistoryAdapter({
    async listPageHistory(requestTarget, cursor, signal) { calls.push({ kind: "list", requestTarget, cursor, signal }); return { entries: [] }; },
    async readPageHistoryRevision(requestTarget, id, signal) { calls.push({ kind: "read", requestTarget, id, signal }); return { document }; }
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.listRevisions({ target, cursor: "next" }, signal), { entries: [] });
  assert.deepEqual(await adapter.readRevision({ target, id: "opaque" }, signal), { document });
  assert.deepEqual(calls, [
    { kind: "list", requestTarget: target, cursor: "next", signal },
    { kind: "read", requestTarget: target, id: "opaque", signal }
  ]);
});
