import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi, EDITING_OPERATIONS } from "@niho/web/editing-api";
import { createEditingApiSiteSettingsFacade, createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";

const document = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const siteId = document.siteId;
const initial = { tokens: { brand: { type: "color", value: "#195640" } } };
const operationId = "12345678-1234-4123-8123-123456789abc";

function fixture({ publish = true, pageNodeNames = false, pageRelease = false } = {}) {
  let draft = { version: "draft-1", styles: structuredClone(initial) };
  let published = { stylesVersion: "published-1", styles: {} };
  let epoch = "epoch-1";
  let pageVersion = "page-1";
  const released = new Map(), migrated = new Map();
  const siteStyles = {
    async read() { return { sitePublicationEpoch: epoch, draft: structuredClone(draft), published: structuredClone(published) }; },
    async save(_actor, _siteId, expectedVersion, styles) {
      if (expectedVersion !== draft.version) return { status: "conflict" };
      draft = { version: `draft-${Number(draft.version.split("-")[1]) + 1}`, styles: structuredClone(styles) };
      return { status: "saved", version: draft.version };
    },
    async prepareRelease(_actor, requestedSiteId, input) {
      if (input.expectedVersion !== draft.version || input.expectedStylesVersion !== published.stylesVersion || input.sitePublicationEpoch !== epoch) return { status: "conflict" };
      return { status: "prepared", plan: { ...input, siteId: requestedSiteId, confirmationToken: "release-token", expiresAt: "2030-01-01T00:00:00.000Z",
        before: structuredClone(published.styles), after: structuredClone(draft.styles), affected: [{ kind: "page", id: document.pageId, locale: document.locale, version: "page-1" }] } };
    },
    async release(_actor, _siteId, input) {
      const previous = released.get(input.operationId);
      if (previous) return JSON.stringify(previous.input) === JSON.stringify(input) ? previous.result : { status: "duplicate" };
      if (input.confirmationToken !== "release-token" || input.expectedVersion !== draft.version || input.expectedStylesVersion !== published.stylesVersion || input.sitePublicationEpoch !== epoch) return { status: "conflict" };
      published = { stylesVersion: "published-2", styles: structuredClone(draft.styles) }; epoch = "epoch-2";
      const result = { status: "released", operationId: input.operationId, stylesVersion: published.stylesVersion, sitePublicationEpoch: epoch };
      released.set(input.operationId, { input: structuredClone(input), result }); return result;
    },
    async prepareMigration(_actor, requestedSiteId, input) {
      if (input.expectedVersion !== draft.version || input.expectedStylesVersion !== published.stylesVersion || input.sitePublicationEpoch !== epoch) return { status: "conflict" };
      return { status: "prepared", plan: { ...input, siteId: requestedSiteId, confirmationToken: "migration-token", expiresAt: "2030-01-01T00:00:00.000Z",
        classification: "lossless", before: structuredClone(draft.styles), after: {}, affected: [{ kind: "page", id: document.pageId, locale: document.locale, version: "page-1" }] } };
    },
    async applyMigration(_actor, _siteId, input) {
      const previous = migrated.get(input.operationId);
      if (previous) return JSON.stringify(previous.input) === JSON.stringify(input) ? previous.result : { status: "duplicate" };
      if (input.confirmationToken !== "migration-token") return { status: "conflict" };
      draft = { version: "draft-3", styles: {} }; published = { stylesVersion: "published-3", styles: {} }; epoch = "epoch-3";
      const result = { status: "applied", operationId: input.operationId, version: draft.version, stylesVersion: published.stylesVersion, sitePublicationEpoch: epoch };
      migrated.set(input.operationId, { input: structuredClone(input), result }); return result;
    }
  };
  const api = createPageEditingApi({
    async authenticate() { return { kind: "human", subject: "owner", clientKind: "gui" }; },
    async authorize(_actor, capability) { return capability !== "pages.publish" || publish; },
    siteStyles,
    pageNodeNames,
    localization: {
      "localization.settings.save": async () => ({ status: "migration_in_progress" }),
      "localization.release.prepare": async () => ({ status: "publication_in_progress" })
    },
    ...(pageRelease ? {
      async releaseSite() { return { id: siteId, name: "Example", domains: ["https://host.example"] }; },
      async preparePageRelease(_actor, request) {
        return { status: "prepared", plan: { ...request, confirmationToken: "page-release-token", domain: "https://host.example", changes: [] } };
      },
      async publishPage(_actor, target, input) {
        const previous = released.get(input.operationId);
        if (previous) return JSON.stringify(previous.input) === JSON.stringify(input) ? previous.result : { status: "duplicate" };
        if (input.confirmationToken !== "page-release-token" || input.expectedVersion !== pageVersion
          || input.siteStylesRevision?.version !== published.stylesVersion || input.sitePublicationEpoch !== epoch) return { status: "conflict" };
        pageVersion = "page-2";
        const result = { status: "released", operationId: input.operationId, version: pageVersion, document };
        released.set(input.operationId, { input: structuredClone(input), result }); return result;
      }
    } : {}),
    async readPage() { return { document, version: pageVersion, draftStylesVersion: draft.version }; },
    async savePage(_actor, _target, expectedVersion, candidate, revision) {
      if (expectedVersion !== pageVersion || revision?.stage !== "draft" || revision.version !== draft.version) return { status: "conflict" };
      pageVersion = "page-2";
      return { status: "saved", version: pageVersion, document: candidate };
    }
  });
  return { api, client: createPageEditingApiClient({ origin: "https://host.example", siteId, fetch: (input, init) => api(new Request(input, init)) }) };
}

test("site.styles is opt-in and preserves queryless discovery", async () => {
  const { api } = fixture();
  const legacy = await api(new Request(`https://host.example/api/edit/v1/sites/${siteId}/capabilities`));
  const legacyBody = await legacy.json();
  assert.equal(legacy.status, 200);
  assert.equal(legacyBody.operations.some(({ id }) => id.startsWith("site.styles.")), false);
  const legacyRead = legacyBody.operations.find(({ id }) => id === "pages.read");
  assert.ok(legacyRead.resultSchema.properties.stylesVersion);
  assert.equal(legacyRead.resultSchema.properties.draftStylesVersion, undefined);
  assert.equal(legacyBody.operations.find(({ id }) => id === "localization.settings.save").errors.includes("site_style_migration_in_progress"), false);

  const opted = await api(new Request(`https://host.example/api/edit/v1/sites/${siteId}/capabilities?features=site.styles`));
  const optedBody = await opted.json();
  assert.equal(opted.status, 200);
  assert.deepEqual(optedBody.operations.filter(({ id }) => id.startsWith("site.styles.")).map(({ id }) => id), [
    "site.styles.read", "site.styles.save", "site.styles.release-plan", "site.styles.release", "site.styles.migration-plan", "site.styles.migration-apply"
  ]);
  assert.deepEqual(optedBody.operations.find(({ id }) => id === "site.styles.read").resultSchema.required, ["draft", "published", "sitePublicationEpoch"]);
  const featureRead = optedBody.operations.find(({ id }) => id === "pages.read");
  assert.ok(featureRead.resultSchema.required.includes("draftStylesVersion"));
  assert.equal(featureRead.resultSchema.properties.stylesVersion, undefined);
  assert.ok(optedBody.operations.find(({ id }) => id === "localization.settings.save").errors.includes("site_style_migration_in_progress"));
  const localeRelease = optedBody.operations.find(({ id }) => id === "localization.release.prepare");
  assert.ok(localeRelease.errors.includes("site_publication_in_progress"));
  assert.ok(localeRelease.errors.includes("site_style_migration_in_progress"));
});

test("site.styles and page name capabilities compose once in discovery", async () => {
  const { client } = fixture({ pageNodeNames: true });
  const discovery = await client.discover();
  const save = discovery.operations.find(({ id }) => id === "pages.save");
  assert.ok(save);
  assert.equal(save.path.match(/features=site\.styles/g)?.length, 1);
  assert.deepEqual(save.capabilities, ["pages.name"]);
  assert.equal(save.inputSchema.required.filter((key) => key === "draftStylesVersion").length, 1);
});

test("localization writes preserve stable site fence errors", async () => {
  const { client } = fixture();
  await client.discover();
  await assert.rejects(client.executeLocalization("localization.settings.save", {
    expectedVersion: "locale-1", operationId: "locale_settings_1234", autoDraft: true
  }), (error) => error instanceof EditingApiClientError && error.code === "site_style_migration_in_progress" && error.status === 409);
  await assert.rejects(client.executeLocalization("localization.release.prepare", {
    operation: "publish", releaseId: null, expectedVersion: "locale-1", expectedCurrentVersion: null,
    resumeToken: null, operationId: "locale_release_12345"
  }), (error) => error instanceof EditingApiClientError && error.code === "site_publication_in_progress" && error.status === 409);
});

test("client keeps draft and published versions distinct and style saves are CAS protected", async () => {
  const { client } = fixture();
  await client.discover();
  const snapshot = await client.readSiteStyles();
  assert.equal(snapshot.sitePublicationEpoch, "epoch-1");
  assert.equal(snapshot.draft.version, "draft-1");
  assert.equal(snapshot.published.stylesVersion, "published-1");
  assert.deepEqual(await client.saveSiteStyles("stale", snapshot.draft.styles), { status: "conflict" });
  assert.equal((await client.saveSiteStyles(snapshot.draft.version, { tokens: { brand: { type: "color", value: "#000000" }, ink: { type: "color", value: "#111111" } } })).status, "saved");
  await assert.rejects(client.saveSiteStyles("draft-2", {}), (error) => error instanceof EditingApiClientError && error.code === "style_migration_required" && error.status === 422);
});

test("feature-aware page reads and saves bind the opaque page CAS to the draft style revision", async () => {
  const { client } = fixture();
  const target = { siteId, pageId: document.pageId, locale: document.locale };
  await client.discover();
  const snapshot = await client.read(target);
  assert.equal(snapshot.version, "page-1");
  assert.equal(snapshot.draftStylesVersion, "draft-1");
  const saved = await client.save(target, snapshot.version, snapshot.document);
  assert.deepEqual(saved, { status: "saved", version: "page-2", document: snapshot.document });
  assert.deepEqual(await client.save(target, "page-2", snapshot.document, undefined, "stale-draft"), { status: "conflict" });
});

test("feature-aware page release applies the prepared plan with its published style fence", async () => {
  const { client } = fixture({ pageRelease: true });
  await client.discover();
  const target = { siteId, pageId: document.pageId, locale: document.locale };
  const snapshot = await client.read(target);
  const plan = await client.prepareRelease(target, { expectedVersion: snapshot.version, action: "publish",
    siteStylesRevision: { stage: "published", version: "published-1" }, sitePublicationEpoch: "epoch-1" });
  assert.equal(plan.siteStylesRevision.version, "published-1");
  assert.equal(plan.sitePublicationEpoch, "epoch-1");
  const released = await client.release(target, plan, "12345678-1234-4123-8123-123456789abc");
  assert.deepEqual(released, { status: "released", operationId: "12345678-1234-4123-8123-123456789abc", version: "page-2", document });
});

test("release and migration plans bind versions and replay the same operation result", async () => {
  const { client } = fixture();
  await client.discover();
  const releaseRequest = { expectedVersion: "draft-1", expectedStylesVersion: "published-1", sitePublicationEpoch: "epoch-1", operationId };
  const plan = await client.prepareSiteStylesRelease(releaseRequest);
  assert.deepEqual(plan.affected.map(({ kind, id, locale }) => ({ kind, id, locale })), [{ kind: "page", id: document.pageId, locale: document.locale }]);
  const first = await client.releaseSiteStyles(plan), replay = await client.releaseSiteStyles(plan);
  assert.deepEqual(replay, first);

  const migrationOperation = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const migration = await client.prepareSiteStylesMigration({ expectedVersion: "draft-1", expectedStylesVersion: "published-2", sitePublicationEpoch: "epoch-2",
    operationId: migrationOperation, changes: [{ kind: "delete", styleKind: "token", name: "brand" }] });
  const applied = await client.applySiteStylesMigration(migration);
  assert.equal(applied.status, "applied");
  assert.deepEqual(await client.applySiteStylesMigration(migration), applied);
});

test("site-wide release discovery consistently requires publish permission", async () => {
  const { client } = fixture({ publish: false });
  const discovery = await client.discover();
  assert.ok(discovery.operations.some(({ id }) => id === "site.styles.save"));
  assert.equal(discovery.operations.some(({ id }) => id === "site.styles.release"), false);
  await assert.rejects(client.prepareSiteStylesRelease({ expectedVersion: "draft-1", expectedStylesVersion: "published-1", sitePublicationEpoch: "epoch-1", operationId }),
    (error) => error instanceof EditingApiClientError && error.code === "not_found");
});

test("new clients retry legacy discovery without sending style operations", async () => {
  const requests = [];
  const legacyOperation = EDITING_OPERATIONS.find(({ id }) => id === "pages.read");
  const client = createPageEditingApiClient({ origin: "https://old.example", siteId, fetch: async (input) => {
    requests.push(String(input));
    if (String(input).includes("features=site.styles")) return Response.json({ error: "invalid_request" }, { status: 400 });
    return Response.json({ apiVersion: "v1", siteId, operations: [legacyOperation] });
  } });
  await client.discover();
  await assert.rejects(client.readSiteStyles(), (error) => error instanceof EditingApiClientError && error.code === "not_found");
  assert.equal(requests.some((url) => url.includes("operations/site.styles")), false);
});

test("the EditorAdapter site-settings facade delegates its style slice to the common API", async () => {
  const saves = [];
  const facade = createEditingApiSiteSettingsFacade({
    async readSiteStyles() {
      return { sitePublicationEpoch: "epoch-7", draft: { version: "draft-7", styles: initial }, published: { stylesVersion: "published-4", styles: {} } };
    },
    async saveSiteStyles(expectedVersion, styles) {
      saves.push({ expectedVersion, styles: structuredClone(styles) });
      return { status: "saved", version: "draft-8" };
    }
  }, siteId, { title: "Demo", locale: "ja" });
  assert.equal(facade.siteSettingsMetadataEditable, false);
  assert.deepEqual(await facade.readSiteSettings(siteId), { version: "draft-7", settings: { title: "Demo", locale: "ja", ...initial } });
  assert.deepEqual(await facade.saveSiteSettings({ siteId, expectedVersion: "draft-7", settings: { title: "Demo", locale: "ja", ...initial } }),
    { status: "saved", version: "draft-8" });
  assert.deepEqual(saves, [{ expectedVersion: "draft-7", styles: initial }]);
});
