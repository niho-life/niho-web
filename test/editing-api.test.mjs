import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi, createRegisteredPageEditingApi, EDITING_API_ERRORS, EDITING_OPERATIONS } from "@niho/web/editing-api";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: fixture.siteId, pageId: fixture.pageId, locale: fixture.locale };

function hostFixture({ validationContext, initialDocument = fixture, publishing = false, initialBreakpointSettings, editorSnapshot = {}, versionedInspection = false, stylesVersion } = {}) {
  let document = structuredClone(initialDocument), version = "v1";
  let breakpointSettings = initialBreakpointSettings === undefined ? null : structuredClone(initialBreakpointSettings), breakpointVersion = "b.1";
  const actor = { kind: "human", subject: "owner" };
  const completedOperations = new Map();
  const site = { id: fixture.siteId, name: "Example", domains: ["https://host.example"] };
  const api = createPageEditingApi({
    async authenticate(request) {
      const token = request.headers.get("Authorization");
      return token === "Bearer owner" ? actor : token === "Bearer other" ? { kind: "human", subject: "other" } : null;
    },
    async authorize(input, capability, scope) { return input.subject === "owner" && scope.siteId === fixture.siteId && (capability === "pages.read" || capability === "pages.edit" || publishing && capability === "pages.publish" || breakpointSettings !== null && (capability === "site.settings.read" || capability === "site.settings.write")); },
    ...(validationContext ? { async validationContext() { return validationContext; } } : {}),
    async readPage(_actor, input) { return input.siteId === target.siteId && input.pageId === target.pageId && input.locale === target.locale ? { document, version, ...editorSnapshot,
      ...(versionedInspection ? { componentsVersion: "components-v1", presentationVersion: "presentation-v1", stylesVersion: "styles-v1" }
        : stylesVersion === undefined ? {} : { stylesVersion }) } : null; },
    async savePage(_actor, input, expectedVersion, next) {
      if (input.siteId !== target.siteId || input.pageId !== target.pageId || input.locale !== target.locale) return { status: "conflict" };
      if (expectedVersion !== version) return { status: "conflict" };
      document = { ...next, revision: next.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`;
      return { status: "saved", version, document };
    },
    ...(breakpointSettings === null ? {} : {
      async readBreakpointSettings(_actor, siteId) { return siteId === fixture.siteId ? { settings: breakpointSettings, version: breakpointVersion } : null; },
      async saveBreakpointSettings(_actor, siteId, expectedVersion, next) {
        if (siteId !== fixture.siteId || expectedVersion !== breakpointVersion) return { status: "conflict" };
        breakpointSettings = structuredClone(next); breakpointVersion = `b.${Number(breakpointVersion.slice(2)) + 1}`;
        return { status: "saved", version: breakpointVersion };
      }
    }),
    ...(publishing ? {
      async releaseSite() { return site; },
      async preparePageRelease(_actor, request) {
        if (request.expectedVersion !== version) return { status: "conflict" };
        return { status: "prepared", plan: { ...request, confirmationToken: "release-token", domain: "https://host.example", changes: [] } };
      },
      async publishPage(_actor, input, request) {
        const completed = completedOperations.get(request.operationId);
        if (completed) return completed.expectedVersion === request.expectedVersion && completed.confirmationToken === request.confirmationToken ? completed.result : { status: "conflict" };
        if (input.siteId !== target.siteId || input.pageId !== target.pageId || input.locale !== target.locale
          || request.expectedVersion !== version || request.confirmationToken !== "release-token") return { status: "conflict" };
        version = `v${Number(version.slice(1)) + 1}`;
        const result = { status: "released", operationId: request.operationId, version, document };
        completedOperations.set(request.operationId, { expectedVersion: request.expectedVersion, confirmationToken: request.confirmationToken, result });
        return result;
      }
    } : {})
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
  const operationIds = EDITING_OPERATIONS.map(({ id }) => id);
  assert.equal(new Set(operationIds).size, operationIds.length, "the catalog is the unique source of public operation IDs");
  assert.ok(EDITING_OPERATIONS.every(({ inputSchema, resultSchema, errors }) => inputSchema && resultSchema && errors.length > 0));
  assert.ok(EDITING_OPERATIONS.every(({ errors }) => errors.every((error) => EDITING_API_ERRORS.includes(error))));
  const { send } = hostFixture();
  const result = await json(await send("GET", `/sites/${target.siteId}/capabilities`));
  assert.equal(result.status, 200);
  assert.equal(result.body.apiVersion, "v1");
  assert.deepEqual(result.body.operations.map(({ id }) => id), ["pages.inspect", "pages.read", "pages.save"]);
  assert.ok(EDITING_API_ERRORS.includes("version_conflict"));
  assert.ok(result.body.operations.every((operation) => operation.inputSchema && operation.resultSchema && operation.errors.length > 0));
});

test("pages.inspect uses page-read authorization, returns versioned projections and rejects invalid cursors", async () => {
  const { send } = hostFixture({ versionedInspection: true });
  const path = `/sites/${target.siteId}/operations/pages.inspect/${target.pageId}?locale=${encodeURIComponent(target.locale)}&view=find&node=heading`;
  const result = await json(await send("GET", path));
  assert.equal(result.status, 200);
  assert.equal(result.body.view, "find");
  assert.equal(result.body.version, "v1");
  assert.equal(result.body.componentsVersion, "components-v1");
  assert.equal(result.body.presentationVersion, "presentation-v1");
  assert.equal(result.body.stylesVersion, "styles-v1");
  assert.deepEqual(result.body.items.map(({ id }) => id), ["heading"]);
  const read = await json(await send("GET", `/sites/${target.siteId}/operations/pages.read/${target.pageId}?locale=${encodeURIComponent(target.locale)}`));
  assert.deepEqual(read.body, { document: fixture, version: "v1", componentsVersion: "components-v1", presentationVersion: "presentation-v1", stylesVersion: "styles-v1" });
  const inspect = EDITING_OPERATIONS.find(({ id }) => id === "pages.inspect");
  assert.equal(inspect.capability, "pages.read");
  assert.ok(inspect.inputSchema && inspect.resultSchema && inspect.errors.includes("invalid_cursor"));
  assert.deepEqual(await json(await send("GET", path, undefined, "Bearer other")), { status: 403, body: { error: "forbidden" } });
  assert.deepEqual(await json(await send("GET", `${path}&view=outline`)), { status: 400, body: { error: "invalid_request" } });
  const invalidCursor = path.replace("view=find&node=heading", "view=outline&cursor=eA");
  assert.deepEqual(await json(await send("GET", invalidCursor)), { status: 400, body: { error: "invalid_cursor" } });
});

test("page catalog and two-phase page management share authorization, version checks and operation IDs", async () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000", domain = "https://host.example";
  const change = { action: "create", siteId: target.siteId, locale: "ja", title: "新しいページ", path: "/new-page" };
  let version = "registry-v1";
  const pages = [{ siteId: target.siteId, pageId: "home", locale: "ja", title: "Home", path: "/", kind: "page", visibility: "public", published: true }];
  const plans = new Map(), usedOperationIds = new Set();
  const site = { id: target.siteId, name: "Example", domains: [domain] };
  const api = createPageEditingApi({
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer owner" ? { kind: "human", subject: "owner" } : null; },
    async authorize(actor, capability, scope) { return actor.subject === "owner" && scope.siteId === target.siteId && (capability === "pages.read" || capability === "pages.publish"); },
    async readPage() { return null; }, async savePage() { return { status: "conflict" }; },
    async releaseSite() { return site; },
    async readPageCatalog() { return { version, pages: structuredClone(pages) }; },
    async preparePageChange(_actor, siteId, expectedVersion, requestedId, requestedChange) {
      if (siteId !== target.siteId) return { status: "not_found" };
      if (usedOperationIds.has(requestedId)) return { status: "duplicate" };
      if (expectedVersion !== version) return { status: "conflict" };
      usedOperationIds.add(requestedId);
      const plan = { expectedVersion, operationId: requestedId, change: requestedChange, confirmationToken: "change-token", domain,
        impact: { linkedFrom: [], navigation: ["sitemap"], notes: ["未公開の下書きとして作成します"] } };
      plans.set(requestedId, { plan, applied: null });
      return { status: "prepared", plan };
    },
    async applyPageChange(_actor, siteId, input) {
      const entry = plans.get(input.operationId);
      if (!entry || siteId !== target.siteId || JSON.stringify(entry.plan.change) !== JSON.stringify(input.change)
        || entry.plan.confirmationToken !== input.confirmationToken || entry.plan.expectedVersion !== input.expectedVersion) return { status: "duplicate" };
      if (entry.applied) return entry.applied;
      if (version !== input.expectedVersion) return { status: "conflict" };
      const page = { siteId, pageId: "page-created", locale: "ja", title: input.change.title, path: input.change.path, kind: "page", visibility: "public", published: false };
      pages.push(page); version = "registry-v2";
      entry.applied = { status: "applied", operationId: input.operationId, page };
      return entry.applied;
    }
  });
  const send = (method, path, body, authorization = "Bearer owner") => api(new Request(`https://host.example/api/edit/v1${path}`, {
    method, headers: { Authorization: authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  const management = `/sites/${target.siteId}/operations`;
  const discovered = await json(await send("GET", `/sites/${target.siteId}/capabilities`));
  assert.deepEqual(discovered.body.operations.map(({ id }) => id), ["pages.inspect", "pages.read", "pages.catalog", "pages.change-prepare", "pages.change-apply"]);
  const catalog = await json(await send("GET", `${management}/pages.catalog`));
  assert.equal(catalog.body.version, "registry-v1");
  assert.equal(catalog.body.pages[0].pageId, "home");
  assert.deepEqual(await json(await send("POST", `${management}/pages.change-prepare`, { expectedVersion: "stale", operationId, change })), { status: 409, body: { error: "version_conflict" } });
  const planResult = await json(await send("POST", `${management}/pages.change-prepare`, { expectedVersion: "registry-v1", operationId, change }));
  assert.equal(planResult.status, 200);
  assert.equal(planResult.body.plan.expectedVersion, "registry-v1");
  assert.equal(planResult.body.plan.operationId, operationId);
  assert.deepEqual(await json(await send("POST", `${management}/pages.change-prepare`, { expectedVersion: "registry-v1", operationId, change })), { status: 409, body: { error: "duplicate_operation" } });
  const plan = planResult.body.plan;
  const input = { expectedVersion: plan.expectedVersion, operationId, confirmationToken: plan.confirmationToken, change };
  const applied = await json(await send("POST", `${management}/pages.change-apply`, input));
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body, { status: "applied", operationId, page: pages[1] });
  assert.deepEqual(await json(await send("POST", `${management}/pages.change-apply`, input)), applied, "same operation ID and input safely retries after a lost response");
  assert.deepEqual(await json(await send("POST", `${management}/pages.change-apply`, { ...input, change: { ...change, path: "/different" } })), { status: 409, body: { error: "duplicate_operation" } });
  assert.deepEqual(await json(await send("GET", `${management}/pages.catalog`, undefined, "Bearer denied")), { status: 401, body: { error: "authentication_required" } });
});

test("site breakpoint operations use the common catalog, validate settings and enforce version CAS", async () => {
  const initial = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const { send } = hostFixture({ initialBreakpointSettings: initial });
  const discovered = await json(await send("GET", `/sites/${target.siteId}/capabilities`));
  assert.deepEqual(discovered.body.operations.slice(-2).map(({ id }) => id), ["site.breakpoints.read", "site.breakpoints.save"]);
  assert.ok(discovered.body.operations.slice(-2).every(({ inputSchema, resultSchema, errors }) => inputSchema && resultSchema && errors.length > 0));

  const base = `/sites/${target.siteId}/operations/site.breakpoints`;
  assert.deepEqual(await json(await send("GET", `${base}.read`)), { status: 200, body: { settings: initial, version: "b.1" } });
  const next = structuredClone(initial); next.breakpoints[0].previewWidth = 800;
  assert.deepEqual(await json(await send("PUT", `${base}.save`, { expectedVersion: "b.1", settings: next })), { status: 200, body: { status: "saved", version: "b.2" } });
  assert.deepEqual(await json(await send("PUT", `${base}.save`, { expectedVersion: "b.1", settings: initial })), { status: 409, body: { error: "version_conflict" } });
  const invalid = structuredClone(next); invalid.breakpoints[0].previewWidth = 1300;
  assert.deepEqual(await json(await send("PUT", `${base}.save`, { expectedVersion: "b.2", settings: invalid })), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await json(await send("PUT", `${base}.read`)), { status: 405, body: { error: "method_not_allowed" } });
  assert.deepEqual(await json(await send("GET", `${base}.read`, undefined, "Bearer other")), { status: 403, body: { error: "forbidden" } });
  assert.deepEqual(await json(await send("GET", `/sites/${target.siteId}/operations/site.breakpoints.read?unexpected=1`)), { status: 400, body: { error: "invalid_request" } });
});

test("registered page editing hosts route each site to its own adapter", async () => {
  function registeredHost(siteId, title) {
    let document = { ...structuredClone(fixture), siteId, title }, version = "v1";
    const adapter = {
      async authenticate(request) { return request.headers.get("Authorization") === "Bearer owner" ? { kind: "machine", subject: `agent-${siteId}` } : null; },
      async authorize(actor, capability, scope) { return actor.kind === "machine" && scope.siteId === siteId && ["pages.read", "pages.edit"].includes(capability); },
      async readPage(_actor, input) { return input.siteId === siteId && input.pageId === target.pageId && input.locale === target.locale ? { document, version } : null; },
      async savePage(_actor, input, expectedVersion, next) {
        if (input.siteId !== siteId || input.pageId !== target.pageId || input.locale !== target.locale || expectedVersion !== version) return { status: "conflict" };
        document = { ...next, revision: next.revision + 1 };
        version = `v${Number(version.slice(1)) + 1}`;
        return { status: "saved", version, document };
      }
    };
    return { adapter, read: () => document };
  }

  const first = registeredHost(target.siteId, "First host"), second = registeredHost("second-site", "Second host");
  const api = createRegisteredPageEditingApi([
    { siteIds: [target.siteId], adapter: first.adapter },
    { siteIds: ["second-site"], adapter: second.adapter }
  ]);
  const send = (siteId, method, body) => api(new Request(`https://host.example/api/edit/v1/sites/${encodeURIComponent(siteId)}/operations/${method === "GET" ? "pages.read" : "pages.save"}/${target.pageId}?locale=${encodeURIComponent(target.locale)}`, {
    method: method === "GET" ? "GET" : "PUT",
    headers: { Authorization: "Bearer owner", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));

  const firstRead = await json(await send(target.siteId, "GET"));
  const secondRead = await json(await send("second-site", "GET"));
  assert.equal(firstRead.body.document.title, "First host");
  assert.equal(secondRead.body.document.title, "Second host");

  const wrongSiteDocument = structuredClone(first.read());
  assert.deepEqual(await json(await send("second-site", "PUT", { expectedVersion: "v1", document: wrongSiteDocument })), {
    status: 400, body: { error: "invalid_request" }
  });
  const changed = structuredClone(second.read()); changed.title = "Updated second host";
  assert.equal((await json(await send("second-site", "PUT", { expectedVersion: "v1", document: changed }))).status, 200);
  assert.equal((await json(await send(target.siteId, "GET"))).body.document.title, "First host");
  assert.equal((await json(await send("second-site", "GET"))).body.document.title, "Updated second host");
  assert.deepEqual(await json(await send("unregistered-site", "GET")), { status: 404, body: { error: "not_found" } });
  assert.throws(() => createRegisteredPageEditingApi([
    { siteIds: [target.siteId], adapter: first.adapter },
    { siteIds: [target.siteId], adapter: second.adapter }
  ]), /already registered/u);
});

test("page editing API prepares an allowlisted release and applies it idempotently", async () => {
  const { send } = hostFixture({ publishing: true });
  const path = `/sites/${target.siteId}/operations`, query = `?locale=${encodeURIComponent(target.locale)}`;
  const prepared = await json(await send("POST", `${path}/pages.release-plan/${target.pageId}${query}`, { expectedVersion: "v1", action: "publish" }));
  assert.equal(prepared.status, 200);
  assert.deepEqual(prepared.body.plan, {
    target, expectedVersion: "v1", action: "publish", confirmationToken: "release-token", domain: "https://host.example", changes: []
  });
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const applyPath = `${path}/pages.release/${target.pageId}${query}`;
  const input = { expectedVersion: "v1", confirmationToken: "release-token", operationId };
  const released = await json(await send("POST", applyPath, input));
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, { status: "released", operationId, version: "v2", document: fixture });
  assert.deepEqual(await json(await send("POST", applyPath, input)), released);
  assert.deepEqual(await json(await send("POST", applyPath, { ...input, confirmationToken: "other-token" })), { status: 409, body: { error: "version_conflict" } });
});

test("page release sets bind every target version, require each target permission and support status lookup", async () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const items = [
    { target, expectedVersion: "v1", componentsVersion: "components-v1", presentationVersion: "presentation-v1" },
    { target: { ...target, pageId: "about" }, expectedVersion: "about-v1" }
  ];
  const prepared = new Map(), current = new Map([[target.pageId, "v1"], ["about", "about-v1"]]);
  let prepareCalls = 0, applyCalls = 0;
  const api = createPageEditingApi({
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer owner" ? { kind: "human", subject: "owner" } : null; },
    async authorize(actor, capability, scope) {
      return actor.subject === "owner" && scope.siteId === target.siteId && (capability === "pages.read" || capability === "pages.publish" && scope.pageId !== "denied");
    },
    async readPage() { return null; }, async savePage() { return { status: "conflict" }; },
    async releaseSite() { return { id: target.siteId, name: "Example", domains: ["https://host.example"] }; },
    async preparePageReleaseSet(_actor, siteId, requestedOperationId, requestedItems) {
      prepareCalls++;
      if (siteId !== target.siteId || requestedItems.some((item) => current.get(item.target.pageId) !== item.expectedVersion)) return { status: "conflict" };
      const plan = { siteId, operationId: requestedOperationId, confirmationToken: "set-token", domain: "https://host.example", items: structuredClone(requestedItems) };
      prepared.set(requestedOperationId, { plan, result: null });
      return { status: "prepared", plan };
    },
    async publishPageReleaseSet(_actor, siteId, input) {
      applyCalls++;
      const entry = prepared.get(input.operationId);
      if (!entry || siteId !== target.siteId || entry.plan.confirmationToken !== input.confirmationToken
        || JSON.stringify(entry.plan.items) !== JSON.stringify(input.items)) return { status: "duplicate" };
      if (entry.result) return entry.result;
      const results = input.items.map((item) => {
        if (current.get(item.target.pageId) !== item.expectedVersion) return { target: item.target, status: "conflict" };
        const version = `${item.expectedVersion}-published`;
        current.set(item.target.pageId, version);
        return { target: item.target, status: "released", version };
      });
      entry.result = { status: "completed", operationId: input.operationId, items: results };
      entry.status = { status: "completed", operationId: input.operationId, httpStatus: 200, result: entry.result };
      return entry.result;
    },
    async readPageReleaseSetStatus(_actor, _siteId, requestedOperationId) { return prepared.get(requestedOperationId)?.status ?? null; }
  });
  const send = (method, path, body) => api(new Request(`https://host.example/api/edit/v1${path}`, {
    method, headers: { Authorization: "Bearer owner", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  const route = `/sites/${target.siteId}/operations`;
  const plan = await json(await send("POST", `${route}/pages.release-set-plan`, { siteId: target.siteId, operationId, items }));
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.plan, { siteId: target.siteId, operationId, confirmationToken: "set-token", domain: "https://host.example", items });
  const result = { status: "completed", operationId, items: [
    { target, status: "released", version: "v1-published" }, { target: items[1].target, status: "released", version: "about-v1-published" }
  ] };
  const applyBody = { siteId: target.siteId, operationId, confirmationToken: "set-token", items };
  assert.deepEqual(await json(await send("POST", `${route}/pages.release-set`, applyBody)), { status: 200, body: result });
  assert.deepEqual(await json(await send("POST", `${route}/pages.release-set`, applyBody)), { status: 200, body: result });
  assert.deepEqual(await json(await send("GET", `${route}/pages.release-set-status/${operationId}`)), {
    status: 200, body: { status: "completed", operationId, httpStatus: 200, result }
  });
  assert.equal(applyCalls, 2);

  const singleOperationId = "423e4567-e89b-42d3-a456-426614174000";
  const singleItems = [{ target, expectedVersion: "v1-published" }];
  const singlePlan = await json(await send("POST", `${route}/pages.release-set-plan`, { siteId: target.siteId, operationId: singleOperationId, items: singleItems }));
  assert.equal(singlePlan.status, 200, "a queued single-page publication uses the generic release-set operation");
  const singleApply = { siteId: target.siteId, operationId: singleOperationId, confirmationToken: "set-token", items: singleItems };
  const singleResult = { status: "completed", operationId: singleOperationId, items: [
    { target, status: "released", version: "v1-published-published" }
  ] };
  assert.deepEqual(await json(await send("POST", `${route}/pages.release-set`, singleApply)), { status: 200, body: singleResult });
  assert.deepEqual(await json(await send("GET", `${route}/pages.release-set-status/${singleOperationId}`)), {
    status: 200, body: { status: "completed", operationId: singleOperationId, httpStatus: 200, result: singleResult }
  });

  const denied = await json(await send("POST", `${route}/pages.release-set-plan`, { siteId: target.siteId, operationId: "223e4567-e89b-42d3-a456-426614174000",
    items: [items[0], { target: { ...target, pageId: "denied" }, expectedVersion: "private-v1" }] }));
  assert.deepEqual(denied, { status: 403, body: { error: "forbidden" } });
  assert.equal(prepareCalls, 2, "the host must not prepare a set with a denied target");

  const duplicateTarget = await json(await send("POST", `${route}/pages.release-set-plan`, { siteId: target.siteId, operationId: "323e4567-e89b-42d3-a456-426614174000", items: [items[0], items[0]] }));
  assert.deepEqual(duplicateTarget, { status: 400, body: { error: "invalid_request" } });
  assert.equal(prepareCalls, 2, "duplicate targets must be rejected before calling the host");
});

test("page editing API hides unsupported publish operations and rejects an untrusted release domain", async () => {
  const missingPublisher = hostFixture();
  const discovered = await json(await missingPublisher.send("GET", `/sites/${target.siteId}/capabilities`));
  assert.deepEqual(discovered.body.operations.map((operation) => operation.id), ["pages.inspect", "pages.read", "pages.save"]);

  const badDomainApi = createPageEditingApi({
    async authenticate() { return { kind: "machine", subject: "agent" }; },
    async authorize() { return true; },
    async releaseSite() { return { id: target.siteId, name: "Example", domains: ["https://host.example"] }; },
    async preparePageRelease(_actor, request) { return { status: "prepared", plan: { ...request, confirmationToken: "token", domain: "https://attacker.example", changes: [] } }; },
    async publishPage() { return { status: "conflict" }; },
    async readPage() { return { document: fixture, version: "v1" }; },
    async savePage() { return { status: "conflict" }; }
  });
  const response = await badDomainApi(new Request(`https://host.example/api/edit/v1/sites/${target.siteId}/operations/pages.release-plan/${target.pageId}?locale=${target.locale}`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: "v1", action: "publish" })
  }));
  assert.deepEqual(await json(response), { status: 502, body: { error: "host_contract_violation" } });
});

test("page release set rejects an unsafe host-listed origin", async () => {
  const operationId = "523e4567-e89b-42d3-a456-426614174000";
  const items = [
    { target, expectedVersion: "v1" },
    { target: { ...target, pageId: "about" }, expectedVersion: "about-v1" }
  ];
  const api = createPageEditingApi({
    async authenticate() { return { kind: "machine", subject: "agent" }; },
    async authorize() { return true; },
    async readPage() { return null; }, async savePage() { return { status: "conflict" }; },
    async releaseSite() { return { id: target.siteId, name: "Example", domains: ["http://host.example"] }; },
    async preparePageReleaseSet(_actor, siteId, requestedOperationId, requestedItems) {
      return { status: "prepared", plan: { siteId, operationId: requestedOperationId, confirmationToken: "set-token", domain: "http://host.example", items: requestedItems } };
    },
    async publishPageReleaseSet() { return { status: "duplicate" }; }
  });
  const response = await api(new Request(`https://host.example/api/edit/v1/sites/${target.siteId}/operations/pages.release-set-plan`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ siteId: target.siteId, operationId, items })
  }));
  assert.deepEqual(await json(response), { status: 502, body: { error: "host_contract_violation" } });
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

test("page editing API negotiates a validated version-bound editor snapshot", async () => {
  const version = "presentation-v1";
  const shared = (pageId) => ({ schemaVersion: 1, siteId: target.siteId, pageId, locale: target.locale, revision: 1, title: pageId, tokens: {}, body: [] });
  const presentation = { schemaVersion: 1, siteId: target.siteId, locale: target.locale, version, reset: "neutral-v1", tokens: {}, layout: { base: { backgroundColor: "#edf5ed" } }, fonts: [],
    shared: { header: shared("header"), footer: shared("footer") } };
  const editorState = { readOnly: { reason: "Read only" }, englishPublication: { state: "published", retryable: false }, releases: [{ revision: 1, label: "Published" }] };
  const extension = { presentation, presentationVersion: version, editorState };
  const path = `/sites/${target.siteId}/operations/pages.read/${target.pageId}?locale=${target.locale}`;
  const sendSnapshot = (fields) => hostFixture({ editorSnapshot: fields }).api(new Request(`https://host.example/api/edit/v1${path}`, {
    headers: { Authorization: "Bearer owner", Accept: "application/json; profile=niho-editor-snapshot-v1" }
  })).then(json);
  assert.deepEqual(await sendSnapshot(extension), { status: 200, body: { document: fixture, version: "v1", ...extension } });
  assert.deepEqual(await sendSnapshot({ presentation, presentationVersion: version }), {
    status: 200, body: { document: fixture, version: "v1", presentationVersion: version, presentation }
  });
  assert.deepEqual(await sendSnapshot({ editorState: {} }), { status: 200, body: { document: fixture, version: "v1", editorState: {} } });
  assert.deepEqual(await json(await hostFixture({ editorSnapshot: extension }).send("GET", path)), {
    status: 200, body: { document: fixture, version: "v1", presentationVersion: version }
  });
  for (const fields of [
    { ...extension, presentationVersion: "stale" },
    { ...extension, presentationVersion: undefined },
    { ...extension, presentation: undefined },
    { ...extension, presentation: { ...presentation, siteId: "another-site" } },
    { presentation },
    { ...extension, editorState: { readOnly: { reason: "Read only", editUrl: "javascript:alert(1)" } } }
  ]) {
    assert.deepEqual(await sendSnapshot(fields), { status: 502, body: { error: "host_contract_violation" } });
  }
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
