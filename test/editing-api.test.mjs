import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi, EDITING_API_ERRORS, EDITING_OPERATIONS } from "@niho/web/editing-api";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: fixture.siteId, pageId: fixture.pageId, locale: fixture.locale };

function hostFixture({ validationContext, initialDocument = fixture } = {}) {
  let document = structuredClone(initialDocument), version = "v1";
  const actor = { kind: "human", subject: "owner" };
  const api = createPageEditingApi({
    async authenticate(request) {
      const token = request.headers.get("Authorization");
      return token === "Bearer owner" ? actor : token === "Bearer other" ? { kind: "human", subject: "other" } : null;
    },
    async authorize(input, capability, scope) { return input.subject === "owner" && scope.siteId === fixture.siteId && (capability === "pages.read" || capability === "pages.edit"); },
    ...(validationContext ? { async validationContext() { return validationContext; } } : {}),
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
  changed.body[0].style.base.backgroundColor = "#e8f0e8";
  changed.body[0].children.push({ type: "element", id: "contact-form", tag: "form", attrs: { name: "contact" }, children: [
    { type: "element", id: "contact-name-label", tag: "label", attrs: { htmlFor: "contact-name" }, children: [{ type: "text", text: "Name" }] },
    { type: "element", id: "contact-name", tag: "input", attrs: { type: "text", name: "name", id: "contact-name", required: true }, children: [] }
  ] });
  const saved = await json(await send("PUT", `${route}/pages.save/${target.pageId}${query}`, { expectedVersion: "v1", document: changed }));
  assert.deepEqual(saved, { status: 200, body: { status: "saved", version: "v2", document: { ...changed, revision: changed.revision + 1 } } });
  assert.equal(saved.body.document.body[0].style.base.backgroundColor, "#e8f0e8");
  assert.equal(saved.body.document.body[0].children.at(-1).tag, "form");
  const stale = await json(await send("PUT", `${route}/pages.save/${target.pageId}${query}`, { expectedVersion: "v1", document: fixture }));
  assert.deepEqual(stale, { status: 409, body: { error: "version_conflict" } });
  const reread = await json(await send("GET", `${route}/pages.read/${target.pageId}${query}`));
  assert.equal(reread.body.document.title, changed.title);
  assert.equal(reread.body.version, "v2");
});

test("page editing API validates custom blocks with the target host's trusted context", async () => {
  const blockDocument = structuredClone(fixture);
  blockDocument.body.push({ type: "component", id: "booking-panel", block: "booking-panel", props: { title: "Book a visit" } });
  const context = { blocks: { "booking-panel": { props: { title: { type: "string", required: true } } } } };
  const route = `/sites/${target.siteId}/operations`, query = `?locale=${encodeURIComponent(target.locale)}`;

  const withoutContext = hostFixture({ initialDocument: blockDocument });
  assert.deepEqual(await json(await withoutContext.send("GET", `${route}/pages.read/${target.pageId}${query}`)),
    { status: 502, body: { error: "host_contract_violation" } });

  const { send } = hostFixture({ validationContext: context, initialDocument: blockDocument });
  const read = await json(await send("GET", `${route}/pages.read/${target.pageId}${query}`));
  assert.equal(read.status, 200);
  assert.equal(read.body.document.body.at(-1).block, "booking-panel");
  const saved = await json(await send("PUT", `${route}/pages.save/${target.pageId}${query}`, { expectedVersion: "v1", document: blockDocument }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.document.body.at(-1).block, "booking-panel");
});

test("page editing API treats validation context failures as host failures", async () => {
  const api = createPageEditingApi({
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer owner" ? { kind: "human", subject: "owner" } : null; },
    async authorize() { return true; },
    async validationContext() { throw new Error("host registry unavailable"); },
    async readPage() { return { document: fixture, version: "v1" }; },
    async savePage() { return { status: "conflict" }; }
  });
  const response = await api(new Request(`https://host.example/api/edit/v1/sites/${target.siteId}/operations/pages.read/${target.pageId}?locale=${target.locale}`, {
    headers: { Authorization: "Bearer owner" }
  }));
  assert.deepEqual(await json(response), { status: 503, body: { error: "host_failure" } });
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
