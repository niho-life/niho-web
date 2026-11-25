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

function clientFixture({ token = "owner", initialDocument = blockDocument, publishing = false, versionedInspection = false, releaseSet = false, staleAfterSetPrepare = false, pendingSetOnce = false, pageManagement = false, initialBreakpointSettings } = {}) {
  let document = structuredClone(initialDocument), version = "v1";
  const secondTarget = { siteId: target.siteId, pageId: "about", locale: "ja" };
  let secondVersion = "about-v1";
  const releaseSetOperations = new Map();
  let breakpointSettings = initialBreakpointSettings === undefined ? null : structuredClone(initialBreakpointSettings), breakpointVersion = "b.1";
  const completed = new Map();
  let pageManagementVersion = "registry-v1";
  const pages = [{ siteId: target.siteId, pageId: target.pageId, locale: "ja", title: "Home", path: "/", kind: "page", visibility: "public", published: true }];
  const pageChangeOperations = new Map();
  const api = createPageEditingApi({
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer owner" ? { kind: "machine", subject: "agent", delegatedBy: "owner" } : null; },
    async authorize(actor, capability, scope) { return actor.subject === "agent" && scope.siteId === target.siteId && (["pages.read", "pages.edit"].includes(capability) || (publishing || releaseSet || pageManagement) && capability === "pages.publish" || breakpointSettings !== null && ["site.settings.read", "site.settings.write"].includes(capability)); },
    async validationContext() { return validationContext; },
    async readPage(_actor, requested) { return requested.siteId === target.siteId && requested.pageId === target.pageId && requested.locale === target.locale
      ? { document, version, ...(publishing ? { componentsVersion: "components-v1", presentationVersion: "presentation-v1" }
        : versionedInspection ? { componentsVersion: "components-v1", presentationVersion: "presentation-v1", stylesVersion: "styles-v1" } : {}) } : null; },
    async savePage(_actor, requested, expectedVersion, next) {
      if (requested.siteId !== target.siteId || requested.pageId !== target.pageId || requested.locale !== target.locale || expectedVersion !== version) return { status: "conflict" };
      document = { ...next, revision: next.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`;
      return { status: "saved", version, document };
    },
    ...(breakpointSettings === null ? {} : {
      async readBreakpointSettings(_actor, siteId) { return siteId === target.siteId ? { settings: breakpointSettings, version: breakpointVersion } : null; },
      async saveBreakpointSettings(_actor, siteId, expectedVersion, next) {
        if (siteId !== target.siteId || expectedVersion !== breakpointVersion) return { status: "conflict" };
        breakpointSettings = structuredClone(next); breakpointVersion = `b.${Number(breakpointVersion.slice(2)) + 1}`;
        return { status: "saved", version: breakpointVersion };
      }
    }),
    ...(publishing || releaseSet ? {
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
      },
      ...(releaseSet ? {
        async preparePageReleaseSet(_actor, siteId, operationId, items) {
          const prior = releaseSetOperations.get(operationId);
          if (prior) return JSON.stringify(prior.plan.items) === JSON.stringify(items) ? { status: "prepared", plan: prior.plan } : { status: "duplicate" };
          if (siteId !== target.siteId || items.some((item) => item.target.pageId === target.pageId ? item.expectedVersion !== version
            : item.target.pageId === secondTarget.pageId ? item.expectedVersion !== secondVersion : true)) return { status: "conflict" };
          const plan = { siteId, operationId, confirmationToken: `set-token-${operationId}`, domain: "https://host.example", items: structuredClone(items) };
          releaseSetOperations.set(operationId, { plan, input: structuredClone(items), result: null, results: new Map(), pendingSetConsumed: false });
          if (staleAfterSetPrepare) secondVersion = "about-v2";
          return { status: "prepared", plan };
        },
        async publishPageReleaseSet(_actor, siteId, input) {
          const entry = releaseSetOperations.get(input.operationId);
          if (!entry || siteId !== target.siteId || entry.plan.confirmationToken !== input.confirmationToken
            || JSON.stringify(entry.input) !== JSON.stringify(input.items)) return { status: "duplicate" };
          if (entry.result) return entry.result;
          const results = input.items.map((item) => {
            const key = `${item.target.pageId}\u0000${item.target.locale}`;
            const prior = entry.results.get(key);
            if (prior && prior.status !== "pending") return prior;
            if (prior?.status === "pending") entry.results.delete(key);
            if (pendingSetOnce && !entry.pendingSetConsumed && item.target.pageId === secondTarget.pageId) {
              entry.pendingSetConsumed = true;
              const pending = { target: item.target, status: "pending" };
              entry.results.set(key, pending);
              return pending;
            }
            if (item.target.pageId === target.pageId) {
              if (item.expectedVersion !== version) {
                const conflict = { target: item.target, status: "conflict" };
                entry.results.set(key, conflict);
                return conflict;
              }
              version = "v2";
              const released = { target: item.target, status: "released", version };
              entry.results.set(key, released);
              return released;
            }
            if (item.target.pageId === secondTarget.pageId) {
              if (item.expectedVersion !== secondVersion) {
                const conflict = { target: item.target, status: "conflict" };
                entry.results.set(key, conflict);
                return conflict;
              }
              secondVersion = "about-v2";
              const released = { target: item.target, status: "released", version: secondVersion };
              entry.results.set(key, released);
              return released;
            }
            const conflict = { target: item.target, status: "conflict" };
            entry.results.set(key, conflict);
            return conflict;
          });
          const status = results.some(({ status }) => status === "pending") ? "publishing" : "completed";
          const result = { status, operationId: input.operationId, items: results };
          if (status === "completed") {
            entry.result = result;
            entry.status = { status: "completed", operationId: input.operationId, httpStatus: 200, result };
          } else entry.status = { status: "received", operationId: input.operationId };
          return result;
        },
        async readPageReleaseSetStatus(_actor, siteId, operationId) {
          return siteId === target.siteId ? releaseSetOperations.get(operationId)?.status ?? { status: "unknown", operationId } : null;
        }
      } : {})
    } : {})
    ,...(pageManagement ? {
      async releaseSite() { return { id: target.siteId, name: "Example", domains: ["https://host.example"] }; },
      async readPageCatalog() { return { version: pageManagementVersion, pages: structuredClone(pages) }; },
      async preparePageChange(_actor, _siteId, expectedVersion, operationId, change) {
        if (pageChangeOperations.has(operationId)) return { status: "duplicate" };
        if (expectedVersion !== pageManagementVersion) return { status: "conflict" };
        const plan = { expectedVersion, operationId, change, confirmationToken: "page-change-token", domain: "https://host.example",
          impact: { linkedFrom: [], navigation: ["sitemap"], notes: ["新しいページを作成します"] } };
        pageChangeOperations.set(operationId, { plan, applied: null });
        return { status: "prepared", plan };
      },
      async applyPageChange(_actor, _siteId, input) {
        const entry = pageChangeOperations.get(input.operationId);
        if (!entry || entry.plan.confirmationToken !== input.confirmationToken || JSON.stringify(entry.plan.change) !== JSON.stringify(input.change)) return { status: "duplicate" };
        if (entry.applied) return entry.applied;
        if (entry.plan.expectedVersion !== input.expectedVersion || input.expectedVersion !== pageManagementVersion) return { status: "conflict" };
        const page = { siteId: target.siteId, pageId: "new-page", locale: "ja", title: input.change.title, path: input.change.path, kind: "page", visibility: "public", published: false };
        pages.push(page); pageManagementVersion = "registry-v2";
        entry.applied = { status: "applied", operationId: input.operationId, page };
        return entry.applied;
      }
    } : {})
  });
  const client = createPageEditingApiClient({
    origin: "https://host.example", siteId: target.siteId, headers: token ? { Authorization: `Bearer ${token}` } : {},
    fetch: (input, init) => api(new Request(input, init))
  });
  return client;
}

test("shared client reads partial page projections with dependency versions", async () => {
  const client = clientFixture({ versionedInspection: true });
  const result = await client.inspectPage(target, { view: "outline", depth: 1 });
  assert.equal(result.view, "outline");
  assert.equal(result.version, "v1");
  assert.equal(result.componentsVersion, "components-v1");
  assert.equal(result.presentationVersion, "presentation-v1");
  assert.equal(result.stylesVersion, "styles-v1");
  assert.ok(result.items.length > 0);
});

test("shared page editing client discovers, reads custom blocks and saves with CAS", async () => {
  const client = clientFixture();
  const discovery = await client.discover();
  assert.deepEqual(discovery.operations.map(({ id }) => id), ["pages.inspect", "pages.read", "pages.save"]);
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

test("shared editing client reads the page catalog and prepares/applies a versioned page change", async () => {
  const client = clientFixture({ pageManagement: true });
  const discovery = await client.discover();
  assert.deepEqual(discovery.operations.map(({ id }) => id), ["pages.inspect", "pages.read", "pages.save", "pages.catalog", "pages.change-prepare", "pages.change-apply"]);
  const catalog = await client.readPageCatalog();
  assert.equal(catalog.version, "registry-v1");
  assert.equal(catalog.pages[0].pageId, target.pageId);
  const change = { action: "create", siteId: target.siteId, locale: "ja", title: "新しいページ", path: "/new-page" };
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const plan = await client.preparePageChange(change, catalog.version, undefined, operationId);
  assert.equal(plan.expectedVersion, catalog.version);
  assert.equal(plan.operationId, operationId);
  assert.equal(plan.impact.notes[0], "新しいページを作成します");
  const applied = await client.applyPageChange(plan);
  assert.deepEqual(applied, { status: "applied", operationId, page: { siteId: target.siteId, pageId: "new-page", locale: "ja", title: change.title, path: change.path, kind: "page", visibility: "public", published: false } });
  assert.deepEqual(await client.applyPageChange(plan), applied);
  await assert.rejects(client.preparePageChange(change, catalog.version, undefined, operationId),
    (error) => error instanceof EditingApiClientError && error.code === "duplicate_operation" && error.status === 409);
});

test("shared editing client reads and saves site breakpoint settings through the discoverable API", async () => {
  const initial = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const client = clientFixture({ initialBreakpointSettings: initial });
  const discovery = await client.discover();
  assert.deepEqual(discovery.operations.slice(-2).map(({ id }) => id), ["site.breakpoints.read", "site.breakpoints.save"]);
  const snapshot = await client.readBreakpointSettings();
  assert.deepEqual(snapshot, { settings: initial, version: "b.1" });
  const next = structuredClone(initial); next.breakpoints[0].previewWidth = 800;
  assert.deepEqual(await client.saveBreakpointSettings(snapshot.version, next), { status: "saved", version: "b.2" });
  assert.deepEqual(await client.saveBreakpointSettings(snapshot.version, initial), { status: "conflict" });
  await assert.rejects(client.saveBreakpointSettings("b.2", { ...next, unexpected: true }), TypeError);
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

test("shared editing client prepares and applies an idempotent multi-page release set with status lookup", async () => {
  const client = clientFixture({ releaseSet: true });
  const discovery = await client.discover();
  assert.ok(discovery.operations.some(({ id }) => id === "pages.release-set-plan"));
  assert.ok(discovery.operations.some(({ id }) => id === "pages.release-set"));
  assert.ok(discovery.operations.some(({ id }) => id === "pages.release-set-status"));
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const items = [
    { target, expectedVersion: "v1", componentsVersion: "components-v1", presentationVersion: "presentation-v1" },
    { target: { ...target, pageId: "about" }, expectedVersion: "about-v1" }
  ];
  const plan = await client.preparePageReleaseSet(items, undefined, operationId);
  assert.equal(plan.operationId, operationId);
  assert.deepEqual(plan.items, items);
  assert.deepEqual(await client.publishPageReleaseSet(plan), {
    status: "completed", operationId, items: [
      { target, status: "released", version: "v2" }, { target: { ...target, pageId: "about" }, status: "released", version: "about-v2" }
    ]
  });
  assert.deepEqual(await client.publishPageReleaseSet(plan), {
    status: "completed", operationId, items: [
      { target, status: "released", version: "v2" }, { target: { ...target, pageId: "about" }, status: "released", version: "about-v2" }
    ]
  });
  assert.deepEqual(await client.pageReleaseSetStatus(operationId), {
    status: "completed", operationId, httpStatus: 200,
    result: { status: "completed", operationId, items: [
      { target, status: "released", version: "v2" }, { target: { ...target, pageId: "about" }, status: "released", version: "about-v2" }
    ] }
  });
  await assert.rejects(client.preparePageReleaseSet([items[0], items[0]], undefined, operationId), TypeError);
});

test("shared editing client uses a one-item release set for a queued single page", async () => {
  const client = clientFixture({ releaseSet: true, pendingSetOnce: true });
  const operationId = "723e4567-e89b-42d3-a456-426614174000";
  const singleTarget = { siteId: target.siteId, pageId: "about", locale: "ja" };
  const items = [{ target: singleTarget, expectedVersion: "about-v1" }];
  const plan = await client.preparePageReleaseSet(items, undefined, operationId);
  assert.deepEqual(plan.items, items);
  assert.deepEqual(await client.publishPageReleaseSet(plan), {
    status: "publishing", operationId, items: [{ target: singleTarget, status: "pending" }]
  });
  assert.deepEqual(await client.pageReleaseSetStatus(operationId), { status: "received", operationId });
  assert.deepEqual(await client.publishPageReleaseSet(plan), {
    status: "completed", operationId, items: [{ target: singleTarget, status: "released", version: "about-v2" }]
  });
  assert.deepEqual(await client.pageReleaseSetStatus(operationId), {
    status: "completed", operationId, httpStatus: 200,
    result: { status: "completed", operationId, items: [{ target: singleTarget, status: "released", version: "about-v2" }] }
  });
});

test("multi-page release set resumes a pending target without republishing completed pages", async () => {
  const client = clientFixture({ releaseSet: true, pendingSetOnce: true });
  const operationId = "623e4567-e89b-42d3-a456-426614174000";
  const items = [
    { target, expectedVersion: "v1" },
    { target: { ...target, pageId: "about" }, expectedVersion: "about-v1" }
  ];
  const plan = await client.preparePageReleaseSet(items, undefined, operationId);
  assert.deepEqual(await client.publishPageReleaseSet(plan), { status: "publishing", operationId, items: [
    { target, status: "released", version: "v2" }, { target: { ...target, pageId: "about" }, status: "pending" }
  ] });
  assert.deepEqual(await client.pageReleaseSetStatus(operationId), { status: "received", operationId });
  assert.deepEqual(await client.publishPageReleaseSet(plan), { status: "completed", operationId, items: [
    { target, status: "released", version: "v2" }, { target: { ...target, pageId: "about" }, status: "released", version: "about-v2" }
  ] });
  assert.equal((await client.read(target)).version, "v2", "the completed page must not be published again while resuming the pending target");
});

test("multi-page release set reports partial success when one target turns stale", async () => {
  const client = clientFixture({ releaseSet: true, staleAfterSetPrepare: true });
  const operationId = "423e4567-e89b-42d3-a456-426614174000";
  const items = [
    { target, expectedVersion: "v1" },
    { target: { ...target, pageId: "about" }, expectedVersion: "about-v1" }
  ];
  const plan = await client.preparePageReleaseSet(items, undefined, operationId);
  const result = await client.publishPageReleaseSet(plan);
  assert.deepEqual(result, { status: "completed", operationId, items: [
    { target, status: "released", version: "v2" }, { target: { ...target, pageId: "about" }, status: "conflict" }
  ] });
  assert.equal((await client.read(target)).version, "v2", "the successful target must publish even if another target is stale");
  assert.deepEqual(await client.publishPageReleaseSet(plan), result, "retrying the same operation must not publish a completed target twice");
  assert.equal((await client.read(target)).version, "v2");
});
