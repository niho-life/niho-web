import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi } from "@niho/web/editing-api";
import { createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: fixture.siteId, pageId: fixture.pageId, locale: fixture.locale };
const blockDocument = structuredClone(fixture);
blockDocument.body.push({ type: "component", id: "booking-panel", block: "booking-panel", props: { title: "Book a visit" } });
const validationContext = { blocks: { "booking-panel": { props: { title: { type: "string", required: true } } } } };

function clientFixture({ token = "owner", initialDocument = blockDocument, publishing = false } = {}) {
  let document = structuredClone(initialDocument), version = "v1";
  const completed = new Map();
  const api = createPageEditingApi({
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer owner" ? { kind: "machine", subject: "agent", delegatedBy: "owner" } : null; },
    async authorize(actor, capability, scope) { return actor.subject === "agent" && scope.siteId === target.siteId && (["pages.read", "pages.edit"].includes(capability) || publishing && capability === "pages.publish"); },
    async validationContext() { return validationContext; },
    async readPage(_actor, requested) { return requested.siteId === target.siteId && requested.pageId === target.pageId && requested.locale === target.locale
      ? { document, version, ...(publishing ? { componentsVersion: "components-v1", presentationVersion: "presentation-v1" } : {}) } : null; },
    async savePage(_actor, requested, expectedVersion, next) {
      if (requested.siteId !== target.siteId || requested.pageId !== target.pageId || requested.locale !== target.locale || expectedVersion !== version) return { status: "conflict" };
      document = { ...next, revision: next.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`;
      return { status: "saved", version, document };
    },
    ...(publishing ? {
      async releaseSite() { return { id: target.siteId, name: "Example", domains: ["https://host.example"] }; },
      async preparePageRelease(_actor, request) {
        if (request.expectedVersion !== version) return { status: "conflict" };
        return { status: "prepared", plan: { ...request, confirmationToken: "release-token", domain: "https://host.example", changes: [] } };
      },
      async publishPage(_actor, requested, input) {
        const prior = completed.get(input.operationId);
        if (prior) return prior.expectedVersion === input.expectedVersion && prior.confirmationToken === input.confirmationToken ? prior.result : { status: "conflict" };
        if (requested.siteId !== target.siteId || requested.pageId !== target.pageId || requested.locale !== target.locale
          || input.expectedVersion !== version || input.confirmationToken !== "release-token") return { status: "conflict" };
        version = `v${Number(version.slice(1)) + 1}`;
        const result = { status: "released", operationId: input.operationId, version, document };
        completed.set(input.operationId, { expectedVersion: input.expectedVersion, confirmationToken: input.confirmationToken, result });
        return result;
      }
    } : {})
  });
  const client = createPageEditingApiClient({
    origin: "https://host.example", siteId: target.siteId, headers: token ? { Authorization: `Bearer ${token}` } : {},
    fetch: (input, init) => api(new Request(input, init))
  });
  return client;
}

test("shared page editing client discovers, reads custom blocks and saves with CAS", async () => {
  const client = clientFixture();
  const discovery = await client.discover();
  assert.deepEqual(discovery.operations.map(({ id }) => id), ["pages.read", "pages.save"]);
  const snapshot = await client.read(target);
  assert.equal(snapshot.document.body.at(-1).block, "booking-panel");
  const changed = structuredClone(snapshot.document); changed.title = "Saved by shared client";
  const saved = await client.save(target, snapshot.version, changed);
  assert.equal(saved.status, "saved");
  if (saved.status === "saved") {
    assert.equal(saved.version, "v2");
    assert.equal(saved.document.title, "Saved by shared client");
  }
  assert.deepEqual(await client.save(target, snapshot.version, changed), { status: "conflict" });
});

test("shared page editing client keeps authorization failures stable and rejects cross-site targets", async () => {
  const client = clientFixture({ token: "invalid" });
  await assert.rejects(client.discover(), (error) => error instanceof EditingApiClientError && error.code === "authentication_required" && error.status === 401);
  await assert.rejects(client.read({ ...target, siteId: "another-site" }), TypeError);
});

test("shared page editing client validates the document envelope but leaves custom block validation to the host", async () => {
  const client = clientFixture();
  const candidate = structuredClone(blockDocument); candidate.body.at(-1).props.title = "Edited block";
  const saved = await client.save(target, "v1", candidate);
  assert.equal(saved.status, "saved");
  await assert.rejects(client.save(target, "v1", { ...candidate, arbitrary: true }), (error) => error instanceof EditingApiClientError && error.code === "invalid_response");
});

test("shared page editing client prepares a release and safely retries with the same operation ID", async () => {
  const client = clientFixture({ publishing: true });
  const snapshot = await client.read(target);
  assert.equal(snapshot.componentsVersion, "components-v1");
  assert.equal(snapshot.presentationVersion, "presentation-v1");
  const plan = await client.prepareRelease(target, { expectedVersion: snapshot.version, action: "publish", componentsVersion: snapshot.componentsVersion, presentationVersion: snapshot.presentationVersion });
  assert.equal(plan.confirmationToken, "release-token");
  assert.equal(plan.target.pageId, target.pageId);
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const released = await client.release(target, plan, operationId);
  assert.deepEqual(released, { status: "released", operationId, version: "v2", document: blockDocument });
  assert.deepEqual(await client.release(target, plan, operationId), released);
  await assert.rejects(client.prepareRelease(target, { expectedVersion: "v1", action: "publish" }),
    (error) => error instanceof EditingApiClientError && error.code === "version_conflict" && error.status === 409);
  await assert.rejects(client.release({ ...target, siteId: "another-site" }, plan, operationId), TypeError);
});
