import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegisteredPageEditingApi, EDITING_CAPABILITIES, EDITING_OPERATIONS } from "@niho/web/editing-api";
import { createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";

const origin = "https://site.example";
const siteId = "studio-example";
const basePath = `/api/edit/v1/sites/${siteId}`;
const itemKey = "aG9tZQ";
const signal = new AbortController().signal;
const capabilities = EDITING_CAPABILITIES.filter((capability) => capability.startsWith("localization."));
const commandInput = {
  itemKey, unitId: "title", action: "set-value", value: "Manual title",
  expectedVersion: "v1", expectedSourceVersion: "s1", operationId: "command-operation-1",
};
const prepareInput = {
  operation: "publish", releaseId: null, expectedVersion: "o1", expectedCurrentVersion: "r2", resumeToken: null,
  operationId: "release-prepare-1",
};
const applyInput = { operation: "publish", expectedVersion: "o1", confirmationToken: "test-confirmation", resumeToken: null };

function fixture(grants = capabilities, overrides = {}) {
  const memory = createLocalizationMemory({ catalogRounds: 2 }), adapter = memory.adapter;
  const auth = { kind: "machine", subject: "editor", delegatedBy: "operator" };
  const seen = [], records = new Map();
  const write = (run) => async (actor, receivedSite, input) => {
    const key = `${actor.subject}/${receivedSite}/${input.operationId}`;
    const serialized = JSON.stringify(input), previous = records.get(key);
    if (previous) return previous.input === serialized ? previous.result : { status: "duplicate" };
    const result = await run(input);
    records.set(key, { input: serialized, result });
    return result;
  };
  const currentOverviewVersion = () => `o${memory.state.overviewVersion}`;
  const api = createRegisteredPageEditingApi([{ siteIds: [siteId], adapter: {
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer test-token" ? auth : null; },
    async authorize(actor, capability, scope) {
      seen.push({ actor, capability, scope });
      return scope.siteId === siteId && grants.includes(capability);
    },
    async readPage() { return null; },
    async savePage() { return { status: "conflict" }; },
    localization: {
      "localization.overview": () => adapter.loadOverview(signal),
      "localization.items.list": (_actor, _site, input) => adapter.listItems(input, signal),
      "localization.items.read": (_actor, _site, input) => adapter.loadItem(input, signal),
      "localization.items.command": write((input) => adapter.command(input, signal)),
      "localization.items.translate": write((input) => input.expectedVersion === currentOverviewVersion()
        ? adapter.requestTranslation(input, signal) : { status: "conflict" }),
      "localization.jobs.read": (_actor, _site, input) => adapter.readJob(input, signal),
      "localization.catalog.advance": write((input) => input.expectedVersion === currentOverviewVersion()
        ? adapter.advanceCatalog({}, signal) : { status: "conflict" }),
      "localization.preview": (_actor, _site, input) => adapter.loadPreview(input, signal),
      "localization.release.read": () => adapter.readRelease(signal),
      "localization.release.prepare": async (actor, receivedSite, input) => {
        const run = (request) => adapter.prepareRelease(request, signal);
        return input.resumeToken === null ? write(run)(actor, receivedSite, input) : run(input);
      },
      "localization.release.apply": async (_actor, _site, input) => {
        if (input.operation !== memory.state.plan?.operation) return { status: "invalid_token" };
        if (input.expectedVersion !== currentOverviewVersion()) return { status: "conflict" };
        const result = await adapter.applyRelease(input, signal);
        return result.status === "applying" ? { ...result, waiting: "deployment" } : result;
      },
      "localization.settings.save": write((input) => adapter.saveSettings(input, signal)),
      ...overrides,
    },
  } }]);
  const headers = { Authorization: "Bearer test-token" };
  const client = createPageEditingApiClient({ origin, siteId, headers, fetch: (url, init) => api(new Request(url, init)) });
  const send = async (method, path, payload, opts = {}) => {
    const response = await api(new Request(`${origin}${path}`, {
      method,
      headers: { ...(opts.noAuth ? {} : headers), ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...opts.headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { client, send, seen, memory, auth };
}

const opPath = (id) => `${basePath}/operations/${id}`;
const stableError = (code, status) => (error) => error instanceof EditingApiClientError && error.code === code && error.status === status;

test("localization discovery uses catalog schemas, optional host methods and action-specific grants", async () => {
  const { client } = fixture();
  const catalog = EDITING_OPERATIONS.filter((entry) => entry.id.startsWith("localization."));
  const discovery = await client.discover();
  assert.deepEqual(discovery.operations, catalog);
  assert.equal(catalog.length, 12);
  assert.deepEqual(new Set(capabilities), new Set([
    "localization.read", "localization.edit", "localization.review", "localization.translate",
    "localization.manage", "localization.publish", "localization.rollback",
  ]));
  assert.ok(catalog.every(({ inputSchema, resultSchema }) => typeof inputSchema === "object" && typeof resultSchema === "object"));

  const { client: reviewer, seen, auth } = fixture(["localization.review"], { "localization.overview": undefined });
  const { operations } = await reviewer.discover();
  assert.deepEqual(operations.map(({ id }) => id), ["localization.items.command"]);
  assert.equal(operations[0].capabilityByInput.values["review-current"], "localization.review");
  await assert.rejects(reviewer.executeLocalization("localization.items.command", commandInput), stableError("forbidden", 403));
  const { value: _value, ...input } = commandInput;
  const reviewed = await reviewer.executeLocalization("localization.items.command", { ...input, action: "review-current" });
  assert.equal(reviewed.unit.state, "reviewed");
  assert.deepEqual(seen.at(-1), { actor: auth, capability: "localization.review", scope: {
    siteId, localizationItemKey: itemKey, localizationUnitId: "title",
  }});

  const { client: editor } = fixture(["localization.edit"]);
  await assert.rejects(editor.executeLocalization("localization.items.command", { ...input, action: "review-current" }), stableError("forbidden", 403));

  const { client: publisher, memory } = fixture(["localization.publish"]);
  const apply = { ...applyInput, operation: "rollback" };
  const rollback = { ...prepareInput, operation: "rollback", releaseId: "release-old" };
  await assert.rejects(publisher.executeLocalization("localization.release.prepare", rollback), stableError("forbidden", 403));
  await assert.rejects(publisher.executeLocalization("localization.release.apply", apply), stableError("forbidden", 403));
  assert.equal(memory.named("prepareRelease").length + memory.named("applyRelease").length, 0);
  const { client: rollbacker } = fixture(["localization.rollback"]);
  const rollbackOps = (await rollbacker.discover()).operations;
  assert.deepEqual(rollbackOps.map(({ id }) => id), ["localization.release.prepare", "localization.release.apply"]);
  assert.equal(rollbackOps[1].capabilityByInput.values.rollback, "localization.rollback");
  await assert.rejects(rollbacker.executeLocalization("localization.release.apply", applyInput), stableError("forbidden", 403));

  const partial = fixture(capabilities, { "localization.items.list": undefined });
  assert.ok(!(await partial.client.discover()).operations.some(({ id }) => id === "localization.items.list"));
  await assert.rejects(partial.client.executeLocalization("localization.items.list", {}), stableError("not_found", 404));
});

test("localization reads item pages and preview, then performs CAS writes and translation job reads", async () => {
  const { client, memory, seen } = fixture();
  const { overview } = await client.executeLocalization("localization.overview", {});
  const list = await client.executeLocalization("localization.items.list", {});
  assert.equal(list.items[0].key, itemKey);
  const next = await client.executeLocalization("localization.items.list", { cursor: list.nextCursor });
  assert.notEqual(next.items[0].key, itemKey);
  const { item } = await client.executeLocalization("localization.items.read", { itemKey });
  assert.equal(item.units.length, 4);
  const preview = await client.executeLocalization("localization.preview", { itemKey, previewId: "home" });
  assert.equal(preview.material.title, item.title);
  assert.equal((await client.executeLocalization("localization.preview", { itemKey, previewId: "home", cursor: preview.nextCursor })).material.units.length, 4);
  assert.equal(seen.at(-1).scope.localizationPreviewId, "home");

  const catalogRequest = { expectedVersion: overview.version, operationId: "refresh-catalog-1" };
  assert.deepEqual(await client.executeLocalization("localization.catalog.advance", catalogRequest), { status: "updating", progress: { done: 1, total: 2 } });
  assert.equal(seen.at(-1).capability, "localization.edit");
  const queued = await client.executeLocalization("localization.items.translate", {
    expectedVersion: overview.version, operationId: "translate-operation-1", itemKey, unitIds: ["body"],
  });
  assert.equal(memory.named("requestTranslation")[0].input.unitIds[0], "body");
  assert.equal(queued.job.state, "queued");
  const job = { jobId: queued.job.jobId };
  assert.equal((await client.executeLocalization("localization.jobs.read", job)).job.state, "running");
  assert.equal((await client.executeLocalization("localization.jobs.read", job)).job.state, "done");

  const saved = await client.executeLocalization("localization.items.command", commandInput);
  assert.equal(saved.status, "applied");
  assert.deepEqual(await client.executeLocalization("localization.items.command", commandInput), saved);
  assert.equal(memory.named("command").length, 1);
  await assert.rejects(client.executeLocalization("localization.items.command", { ...commandInput, value: "Changed payload" }), stableError("duplicate_operation", 409));
  const stale = { ...commandInput, value: "Unsaved local work", operationId: "command-operation-2" };
  const conflict = await client.executeLocalization("localization.items.command", stale);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.unit.value, "Manual title");
  assert.equal(stale.value, "Unsaved local work");
  assert.deepEqual(await client.executeLocalization("localization.items.translate", {
    expectedVersion: overview.version, operationId: "translate-operation-2", itemKey, unitIds: null,
  }), { status: "conflict" });

  const settings = { expectedVersion: overview.settings.version, operationId: "settings-operation-1", autoDraft: false };
  const settingsResult = await client.executeLocalization("localization.settings.save", settings);
  assert.equal(settingsResult.settings.autoDraft, false);
  assert.deepEqual(await client.executeLocalization("localization.settings.save", { ...settings, operationId: "settings-operation-2" }),
    { ...settingsResult, status: "conflict" });
});

test("localization release reports blockers, validates confirmation, and returns resumable deployment status", async () => {
  const { client, memory } = fixture();
  const pre = await client.executeLocalization("localization.release.prepare", prepareInput);
  assert.equal(pre.status, "blocked");
  assert.ok(pre.blockers.length);
  memory.setBlockers([]);
  const first = await client.executeLocalization("localization.release.prepare", { ...prepareInput, operationId: "release-prepare-2" });
  assert.equal(first.status, "preparing");
  assert.equal((await client.executeLocalization("localization.release.read", {})).pending.resumeToken, first.resumeToken);
  const { operationId: _operationId, ...resume } = prepareInput;
  const second = await client.executeLocalization("localization.release.prepare", { ...resume, resumeToken: first.resumeToken });
  const plan = await client.executeLocalization("localization.release.prepare", { ...resume, resumeToken: second.resumeToken });
  assert.equal(plan.status, "ready");
  const { releaseId, version } = plan.plan.prepared;
  const applying = await client.executeLocalization("localization.release.apply", {
    ...applyInput, confirmationToken: plan.plan.confirmationToken, prepared: { releaseId, version },
  });
  assert.equal(applying.waiting, "deployment");
  assert.equal((await client.executeLocalization("localization.release.read", {})).pending.stage, "apply");
  const applied = await client.executeLocalization("localization.release.apply", {
    ...applyInput, confirmationToken: null, resumeToken: applying.resumeToken, prepared: { releaseId, version },
  });
  assert.deepEqual(applied, { status: "applied", current: plan.plan.prepared });
  assert.equal((await client.executeLocalization("localization.release.read", {})).pending, null);
});

test("localization release returns expired for rejected resume tokens", async () => {
  const { client, send } = fixture(capabilities, {
    "localization.release.prepare": async () => ({ status: "invalid_token" }),
    "localization.release.apply": async () => ({ status: "invalid_token" }),
  });
  const { operationId: _operationId, ...resume } = prepareInput;
  const prepare = { ...resume, resumeToken: "expired-prepare-token" };
  assert.deepEqual(await send("POST", opPath("localization.release.prepare"), { siteId, ...prepare }),
    { status: 200, body: { status: "expired" } });
  assert.deepEqual(await client.executeLocalization("localization.release.prepare", prepare), { status: "expired" });

  const apply = { ...applyInput, confirmationToken: null, resumeToken: "expired-apply-token" };
  assert.deepEqual(await client.executeLocalization("localization.release.apply", apply), { status: "expired" });
});

test("localization rejects cross-site and malformed inputs without invoking host operations", async () => {
  const { client, send, memory } = fixture();
  assert.deepEqual(await send("GET", opPath("localization.overview"), undefined, { noAuth: true }),
    { status: 401, body: { error: "authentication_required" } });
  assert.deepEqual(await send("GET", opPath("localization.overview").replace(siteId, "other-site")),
    { status: 404, body: { error: "not_found" } });
  const command = opPath("localization.items.command");
  for (const payload of [
    { ...commandInput, siteId: "other-site" }, { ...commandInput, siteId, actor: { subject: "override" } },
    { ...commandInput, siteId, expectedVersion: undefined }, { ...commandInput, siteId, operationId: "short" },
    { ...commandInput, siteId, value: "x".repeat(4 * 1024 * 1024) }, { ...commandInput, siteId, action: "unknown" },
  ]) {
    assert.deepEqual(await send("POST", command, payload), { status: 400, body: { error: "invalid_request" } });
  }
  assert.equal(memory.named("command").length, 0);
  for (const query of ["?itemKey=__proto__", "?itemKey=aG9tZQ&itemKey=duplicate", "?itemKey=aG9tZQ&unknown=1"]) {
    assert.equal((await send("GET", opPath("localization.items.read") + query)).status, 400);
  }
  assert.equal(memory.named("loadItem").length, 0);
  await assert.rejects(client.executeLocalization("localization.items.read", { itemKey: "missing" }), stableError("not_found", 404));
  await assert.rejects(client.executeLocalization("localization.items.command", { ...commandInput, value: "x".repeat(100_001) }), TypeError);
  await assert.rejects(client.executeLocalization("localization.release.apply", { ...applyInput, resumeToken: "both" }), TypeError);
  await assert.rejects(client.executeLocalization("localization.release.apply", { ...applyInput, confirmationToken: "invalid\ntoken" }), TypeError);
  assert.deepEqual(await client.executeLocalization("localization.release.apply", applyInput), { status: "expired" });
});

test("localization validates host results and rejects a response with wrong scope, shape or status", async () => {
  const { client } = fixture(capabilities, {
    "localization.jobs.read": async () => ({ status: "ready", job: { jobId: "another-job", state: "done", message: null } }),
    "localization.preview": async () => ({ status: "ready", material: "x".repeat(2 * 1024 * 1024 + 1), nextCursor: null }),
    "localization.release.apply": async () => ({ status: "applying", progress: { done: 1, total: 2 }, resumeToken: "resume", waiting: "unknown" }),
  });
  await assert.rejects(client.executeLocalization("localization.jobs.read", { jobId: "job-1" }), stableError("host_contract_violation", 502));
  await assert.rejects(client.executeLocalization("localization.preview", { itemKey, previewId: "home" }), stableError("host_contract_violation", 502));
  await assert.rejects(client.executeLocalization("localization.release.apply", applyInput), stableError("host_contract_violation", 502));
  for (const [status, body] of [
    [200, { status: "conflict" }],
    [409, { error: "version_conflict" }],
    [400, { error: "version_conflict" }],
    [403, { error: "forbidden", leakedField: true }],
  ]) {
    const invalid = createPageEditingApiClient({ origin, siteId, fetch: () => Response.json(body, { status }) });
    await assert.rejects(invalid.executeLocalization("localization.items.command", commandInput), stableError("invalid_response", status));
  }
});
