import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi, EDITING_API_ERRORS, EDITING_OPERATIONS } from "@niho/web/editing-api";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: fixture.siteId, pageId: fixture.pageId, locale: fixture.locale };

function hostFixture() {
  let document = structuredClone(fixture), version = "v1";
  const actor = { kind: "human", subject: "owner" };
  const api = createPageEditingApi({
    async authenticate(request) {
      const token = request.headers.get("Authorization");
      return token === "Bearer owner" ? actor : token === "Bearer other" ? { kind: "human", subject: "other" } : null;
    },
    async authorize(input, capability, scope) { return input.subject === "owner" && scope.siteId === fixture.siteId && (capability === "pages.read" || capability === "pages.edit"); },
    async readPage(_actor, input) { return input.siteId === target.siteId && input.pageId === target.pageId && input.locale === target.locale ? { document, version } : null; },
    async savePage(_actor, input, expectedVersion, next) {
      if (input.siteId !== target.siteId || input.pageId !== target.pageId || input.locale !== target.locale) return { status: "conflict" };
      if (expectedVersion !== version) return { status: "conflict" };
      document = { ...next, revision: next.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`;
      return { status: "saved", version, document };
    }
  });
  const send = (method, path, body, authorization = "Bearer owner") => api(new Request(`https://host.example/api/edit/v1${path}`, {
    method,
    headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  return { api, send };
}

async function json(response) { return { status: response.status, body: await response.json() }; }

test("page editing API discovery exposes machine-readable operations and stable errors", async () => {
  const { send } = hostFixture();
  const result = await json(await send("GET", `/sites/${target.siteId}/capabilities`));
  assert.equal(result.status, 200);
  assert.equal(result.body.apiVersion, "v1");
  assert.deepEqual(result.body.operations, EDITING_OPERATIONS);
  assert.ok(EDITING_API_ERRORS.includes("version_conflict"));
  assert.ok(result.body.operations.every((operation) => operation.inputSchema && operation.resultSchema && operation.errors.length > 0));
});

test("page editing API reads and saves through the host adapter with CAS conflicts", async () => {
  const { send } = hostFixture(), route = `/sites/${target.siteId}/operations`;
  const query = `?locale=${encodeURIComponent(target.locale)}`;
  const read = await json(await send("GET", `${route}/pages.read/${target.pageId}${query}`));
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { document: fixture, version: "v1" });

  const changed = structuredClone(fixture); changed.title = "Updated through the common API";
  const saved = await json(await send("PUT", `${route}/pages.save/${target.pageId}${query}`, { expectedVersion: "v1", document: changed }));
  assert.deepEqual(saved, { status: 200, body: { status: "saved", version: "v2", document: { ...changed, revision: changed.revision + 1 } } });
  const stale = await json(await send("PUT", `${route}/pages.save/${target.pageId}${query}`, { expectedVersion: "v1", document: fixture }));
  assert.deepEqual(stale, { status: 409, body: { error: "version_conflict" } });
  const reread = await json(await send("GET", `${route}/pages.read/${target.pageId}${query}`));
  assert.equal(reread.body.document.title, changed.title);
  assert.equal(reread.body.version, "v2");
});

test("page editing API rejects unauthenticated, denied, malformed and mismatched requests", async () => {
  const { send } = hostFixture(), path = `/sites/${target.siteId}/operations/pages.save/${target.pageId}?locale=${encodeURIComponent(target.locale)}`;
  assert.deepEqual(await json(await send("PUT", path, { expectedVersion: "v1", document: fixture }, "")), { status: 401, body: { error: "authentication_required" } });
  assert.deepEqual(await json(await send("PUT", `/sites/${target.siteId}/operations/pages.read/${target.pageId}?locale=${target.locale}`, {}, "Bearer owner")), { status: 405, body: { error: "method_not_allowed" } });

  const invalid = structuredClone(fixture); invalid.body[0].attrs = { onclick: "alert(1)" };
  assert.deepEqual(await json(await send("PUT", path, { expectedVersion: "v1", document: invalid })), { status: 400, body: { error: "invalid_request" } });
  const mismatched = structuredClone(fixture); mismatched.siteId = "another-site";
  assert.deepEqual(await json(await send("PUT", path, { expectedVersion: "v1", document: mismatched })), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await json(await send("GET", `/sites/${target.siteId}/operations/pages.read/${target.pageId}?locale=${target.locale}&extra=1`)), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await json(await send("GET", `/sites/${target.siteId}/operations/pages.read/${target.pageId}?locale=${target.locale}`, undefined, "Bearer other")), { status: 403, body: { error: "forbidden" } });
});
