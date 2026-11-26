import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  cancelCmsSchedule, checkCmsReleaseApply, checkCmsReplay, checkCmsScheduleCreate, checkCmsSchemaApply, checkCmsWriteVersion,
  cmsItemKey, cmsLegacyCollections, cmsOperationStatus, cmsRoleCapabilities, cmsWorkspaceItem,
  discoverCmsContract, dueCmsSchedule, parseCmsDiscovery, parseCmsDraftWrite, parseCmsItemRevision, parseCmsReleaseAssetManifest, parseCmsSchema,
  parseCmsRouteTable, parseCmsSchemaPlanInput, planCmsMigrationWithRouteTables, planCmsRelease, planCmsRouteTable,
  planCmsSchedule, removeCmsItem, resolveCmsPageBindings, restoreCmsItem, revalidateCmsRelease,
} from "@niho/web/cms-v2";
import { assetKey } from "@niho/web/assets";
import { parsePageDocument } from "@niho/web/core";
import { renderPageToHtml } from "@niho/web/server";
import { parseCollectionSchemaResult } from "@niho/web/collection-model";
import { postsDefinition, tagsDefinition } from "./collection-fixtures.mjs";

const siteId = "demo-site", locale = "ja", now = "2026-11-26T10:00:00Z", later = "2026-11-26T12:00:00Z";
const owner = { siteId, actorId: "owner-fake" }, editor = { siteId, actorId: "editor-fake" };
const fieldId = (key) => key === null ? null : `field-${key}`;
const definition = (source) => ({ ...source, titleField: fieldId(source.titleField), slugField: fieldId(source.slugField),
  imageField: fieldId(source.imageField), subtitleField: fieldId(source.subtitleField),
  fields: source.fields.filter(({ key }) => key !== "related").map((field) => ({ ...field, fieldId: fieldId(field.key) })) });
const schema = () => parseCmsSchema({ contractVersion: 2, siteId, schemaRevision: "schema-1", retiredFields: [], collections: [definition(postsDefinition()), definition(tagsDefinition())] });
const post = { collectionId: "posts", itemId: "post-1", locale }, tag = { collectionId: "tags", itemId: "tag-1", locale };
const presentation = { subtitle: null, imageUrl: null, path: null, updatedAt: now, updatedBy: null, order: null };
const digest = (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const pin = ({ collectionId, itemId, revision }) => ({ collectionId, itemId, revision });

test("CMS page projection filters single selects and resolves only approved asset references", () => {
  const model = schema(), pageId = "articles", cover = { provider: "cms-fixture", id: "cover-1" };
  const article = parseCmsItemRevision({ ...post, siteId, schemaRevision: model.schemaRevision, revision: "rev-1", values: {
    "field-title": '<b>"Story"</b>', "field-slug": "story", "field-kind": ["news"], "field-cover": cover,
    "field-source": "https://example.test/story"
  } }, model);
  const page = parsePageDocument({ schemaVersion: 1, siteId, pageId, locale, revision: 1, title: "Stories", tokens: {}, body: [
    { type: "element", tag: "article", id: "story", children: [
      { type: "element", tag: "a", id: "story-link", attrs: { href: "/" }, children: [{ type: "text", text: "Title" }] },
      { type: "element", tag: "img", id: "story-cover", attrs: { src: "/fallback.png", alt: "Cover" }, children: [] }
    ] }
  ] });
  const bindings = { schemaVersion: 1, siteId, pageId, locale, lists: [{ templateNodeId: "story", collectionId: "posts", limit: 10,
    filter: { fieldId: "field-kind", equals: "news" }, fields: [
      { nodeId: "story-link", target: "text", fieldId: "field-title" }, { nodeId: "story-link", target: "link", fieldId: "field-source" },
      { nodeId: "story-cover", target: "image", fieldId: "field-cover" }
    ] }] };
  assert.throws(() => parsePageDocument({ ...page, cmsBindings: bindings }), /unknown field/u);
  const excluded = { ...article, itemId: "excluded", revision: "rev-2", values: { ...article.values, "field-kind": ["report"] } };
  const projected = resolveCmsPageBindings(page, bindings, { schema: model, items: [article, excluded] });
  assert.equal(projected.body.length, 1);
  assert.equal(page.body[0].children[1].attrs.src, "/fallback.png");
  assert.deepEqual(projected.body[0].children[1].asset, cover);
  const html = renderPageToHtml(projected, {}, { assets: { [assetKey(cover)]: { src: "https://assets.example.test/cover.webp" } } });
  assert.match(html, /href="https:\/\/example\.test\/story"/u);
  assert.match(html, /src="https:\/\/assets\.example\.test\/cover\.webp"/u);
  assert.match(html, /&lt;b&gt;&quot;Story&quot;&lt;\/b&gt;/u);
  const emptyUrl = parseCmsItemRevision({ ...post, siteId, schemaRevision: model.schemaRevision, revision: "rev-empty-url",
    values: { ...article.values, "field-source": "" } }, model);
  const withoutOptionalLink = resolveCmsPageBindings(page, bindings, { schema: model, items: [emptyUrl] });
  assert.equal(withoutOptionalLink.body[0].children[0].attrs?.href, undefined);
  assert.doesNotMatch(renderPageToHtml(withoutOptionalLink, {}), /href=""/u);
  assert.throws(() => resolveCmsPageBindings(page, bindings, { schema: model, items: [{ ...article, siteId: "wrong-site" }] }), /scope mismatch/u);
  assert.throws(() => resolveCmsPageBindings(page, bindings, { schema: model, items: [{ ...article,
    values: { ...article.values, "field-cover": "https://untrusted.example.test/cover.jpg" } }] }), /expected a JSON object/u);
  const invalid = structuredClone(bindings);
  invalid.lists[0].fields[0].fieldId = "field-missing";
  assert.throws(() => resolveCmsPageBindings(page, invalid, { schema: model, items: [article] }), /フィールド/u);
});

class MemoryHost {
  schema = schema();
  drafts = new Map();
  state = new Map();
  revisions = new Map();
  receipts = new Map();
  snapshots = new Map();
  schedules = new Map();
  routeTables = [
    { siteId, locale, revision: "routes-ja-1", reservations: [] },
    { siteId, locale: "en", revision: "routes-en-1", reservations: [] },
  ];
  current = null;
  routeBlocked = false;
  sequence = 0;
  newId() { return `v-${++this.sequence}`; }
  constructor() {
    this.add(post, { "field-title": "海辺の案内", "field-slug": "coast", "field-category": [tag.itemId], "field-summary": "案内の下書き" });
    this.add(tag, { "field-title": "散歩" });
  }
  add(target, values) {
    const key = cmsItemKey(target);
    const item = parseCmsItemRevision({ ...target, siteId, revision: this.newId(), schemaRevision: this.schema.schemaRevision, values }, this.schema);
    this.drafts.set(key, item);
    this.revisions.set(item.revision, item);
    this.state.set(key, { publishedRevision: null, publishedAt: null,
      schedule: null, tombstone: null, deliveryState: { state: "idle" }, ...this.state.get(key), draftRevision: item.revision });
    return item;
  }
  target(item) {
    return { ...item, siteId, contractVersion: 2, expectedSchemaRevision: this.schema.schemaRevision, expectedRevision: this.drafts.get(cmsItemKey(item)).revision };
  }
  save(input) {
    const gate = checkCmsWriteVersion(this.schema, input.contractVersion, input.expectedSchemaRevision);
    if (gate.status !== "allowed") return gate;
    const request = parseCmsDraftWrite(input, this.schema, "save"), key = cmsItemKey(request);
    const old = this.drafts.get(key);
    if (!old || this.state.get(key).tombstone || old.revision !== request.expectedRevision) return { status: "conflict" };
    return { status: "saved", item: this.add({ collectionId: request.collectionId, itemId: request.itemId, locale: request.locale }, request.values) };
  }
  remove(target) { this.state.set(cmsItemKey(target), removeCmsItem(this.state.get(cmsItemKey(target)), now)); }
  restore(target) { this.state.set(cmsItemKey(target), restoreCmsItem(this.state.get(cmsItemKey(target)))); }
  getItem(target) { return cmsWorkspaceItem(this.schema, this.drafts.get(cmsItemKey(target)), this.state.get(cmsItemKey(target)), presentation); }
  confirm(scope, operation, candidate) {
    return { ...scope, operation, candidate, operationId: this.newId(), expiresAt: "2026-11-26T11:00:00Z", confirmationToken: this.newId() };
  }
  input(plan) { return { siteId: plan.siteId, operationId: plan.operationId, confirmationToken: plan.confirmationToken }; }
  migrationDrafts() { return [...this.drafts.values()].map((item) => ({ item, tombstoned: this.state.get(cmsItemKey(item)).tombstone !== null })); }
  draftList() { return [...this.drafts.values()].filter((item) => !this.state.get(cmsItemKey(item)).tombstone); }
  planSchema(next, replacements = [], impact) {
    const routeTableVersions = this.routeTables.map(({ locale, revision }) => ({ locale, revision }));
    const request = parseCmsSchemaPlanInput({ siteId, expectedSchemaRevision: this.schema.schemaRevision, routeTableVersions, nextSchema: next, replacements }, siteId);
    const migration = planCmsMigrationWithRouteTables({ before: this.schema, next: request.nextSchema, items: this.migrationDrafts(),
      replacements: request.replacements, routeTables: this.routeTables, expectedRouteTableVersions: request.routeTableVersions, impact });
    assert.ok(migration);
    return { migration, confirmation: this.confirm(editor, "cms.schema.apply", migration) };
  }
  applySchema(scope, confirmation, replacements = [], impact) {
    if (!cmsRoleCapabilities(scope.actorId === owner.actorId ? "owner" : "editor").includes("cms.schema.apply")) return { status: "forbidden" };
    const checked = checkCmsSchemaApply(scope, this.input(confirmation), confirmation, now, this.schema, this.migrationDrafts(), this.routeTables, replacements, impact);
    if (checked.status !== "allowed") return checked;
    // Draft and schema switches are committed together. Previous revisions remain addressable.
    this.schema = checked.candidate.schema;
    for (const { previousRevision: _old, tombstoned: _tombstoned, values, ...target } of checked.candidate.items) this.add(target, values);
    for (const removed of checked.candidate.removedItems) {
      this.drafts.delete(cmsItemKey(removed));
      this.state.delete(cmsItemKey(removed));
    }
    return { status: "applied" };
  }
  context() {
    return { schema: this.schema, locale, currentReleaseId: this.current, routeTable: this.routeTables.find((table) => table.locale === locale),
      isRemoved: (item) => this.state.get(cmsItemKey(item))?.tombstone !== null,
      readRevision: ({ revision }) => this.revisions.get(revision),
      impact: () => this.routeBlocked ? [{ code: "route", path: "/posts/coast", message: "固定ページとの重複" }] : [] };
  }
  planRelease(items = this.draftList().map(pin), redirects = [], options = {}) {
    const context = this.context();
    return planCmsRelease({ siteId, locale, schemaRevision: this.schema.schemaRevision, routeTableRevision: context.routeTable.revision,
      expectedReleaseId: this.current, items, redirects, ...options }, this.newId(), context);
  }
  publish(scope, confirmation, input = this.input(confirmation)) {
    const receiptKey = `${scope.siteId}/${scope.actorId}/${input.operationId}`;
    const requestDigest = digest(input), prior = checkCmsReplay(scope, "cms.release.apply", input.operationId, requestDigest, this.receipts.get(receiptKey));
    if (prior.status !== "not_found") return prior;
    const checked = checkCmsReleaseApply(scope, input, confirmation, now, this.context());
    if (checked.status !== "allowed") return checked;
    const snapshot = checked.candidate.snapshot;
    const result = { releaseId: snapshot.releaseId, locale: snapshot.locale };
    this.commit(snapshot);
    this.receipts.set(receiptKey, { ...scope, operation: "cms.release.apply", operationId: input.operationId, requestDigest, result });
    return cmsOperationStatus(scope, "cms.release.apply", input.operationId, this.receipts.get(receiptKey));
  }
  commit(snapshot) {
    const selected = new Map(snapshot.items.map((item) => [cmsItemKey(item), item.revision]));
    this.current = snapshot.releaseId;
    this.routeTables = this.routeTables.map((table) => table.locale === snapshot.locale ? snapshot.routeTable : table);
    this.snapshots.set(snapshot.releaseId, snapshot);
    for (const [key, value] of this.state) {
      this.state.set(key, { ...value, publishedRevision: selected.get(key) ?? null, publishedAt: selected.has(key) ? now : null });
    }
  }
  schedule(confirmation) {
    const checked = checkCmsScheduleCreate(editor, this.input(confirmation), confirmation, now, this.context());
    if (checked.status !== "allowed") return checked;
    const schedule = checked.candidate;
    this.schedules.set(schedule.id, schedule);
    for (const item of schedule.proposal.snapshot.items) this.state.get(cmsItemKey(item)).schedule = schedule;
    return checked;
  }
  runSchedule(scheduleId, time) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || !dueCmsSchedule(schedule, time)) return "not_due";
    const checked = revalidateCmsRelease(schedule.proposal, this.context());
    if (checked.status !== "allowed") {
      schedule.state = "failed";
      return "failed";
    }
    this.commit(checked.candidate.snapshot);
    this.schedules.delete(scheduleId);
    for (const item of schedule.proposal.snapshot.items) this.state.get(cmsItemKey(item)).schedule = null;
    return "published";
  }
}

function revisedSchema(before) {
  const next = structuredClone(before);
  next.schemaRevision = "schema-2";
  const fields = next.collections[0].fields;
  const title = fields.find(({ fieldId }) => fieldId === "field-title");
  title.key = "headline";
  title.label = "見出し";
  const summary = fields.find(({ fieldId }) => fieldId === "field-summary");
  Object.assign(summary, { type: "tags" });
  delete summary.rows;
  delete summary.maxLength;
  const removed = fields.findIndex(({ fieldId }) => fieldId === "field-keywords");
  fields.splice(removed, 1);
  fields.push({ fieldId: "field-added", key: "added", label: "追加", type: "text", placement: "main" });
  return next;
}

function publish(host, plan = host.planRelease()) {
  assert.equal(plan.status, "ready");
  return host.publish(editor, host.confirm(editor, "cms.release.apply", plan.proposal));
}

function largeReleaseFixture(count, changeSlugs = false) {
  const host = new MemoryHost(), sample = host.drafts.get(cmsItemKey(post));
  const revisions = new Map(), items = [], reservations = [];
  for (let index = 0; index < count; index++) {
    const itemId = `post-${index}`, revision = `large-revision-${index}`, oldSlug = `old-${index}`;
    const slug = changeSlugs ? `new-${index}` : oldSlug;
    const item = { ...sample, itemId, revision, values: { ...sample.values, "field-slug": slug, "field-category": [] } };
    revisions.set(revision, item);
    items.push({ collectionId: "posts", itemId, revision });
    reservations.push({ kind: "cms-item", path: `/posts/${oldSlug}`, collectionId: "posts", itemId });
  }
  const routeTable = { siteId, locale, revision: "routes-ja-large", reservations };
  return {
    context: { ...host.context(), routeTable, readRevision: ({ revision }) => revisions.get(revision), isRemoved: () => false },
    input: { siteId, locale, schemaRevision: host.schema.schemaRevision, routeTableRevision: routeTable.revision,
      expectedReleaseId: null, items, redirects: [] },
  };
}

test("discovery is authorized and v1 cannot write through either a stale or guessed version", () => {
  const host = new MemoryHost();
  assert.deepEqual(discoverCmsContract({ contractVersion: 1, siteId }), { siteId, schemaRevision: null, contractVersion: 1 });
  const discovery = discoverCmsContract(host.schema, cmsRoleCapabilities("editor"));
  assert.equal(discovery.contractVersion, 2);
  assert.deepEqual(parseCmsDiscovery(discovery, siteId), discovery);
  assert.throws(() => parseCmsDiscovery({ ...discovery, contractVersion: 3 }, siteId), /unsupported CMS contract version/u);
  assert.ok(discovery.operations.includes("cms.schema.plan"));
  assert.ok(discovery.operations.includes("cms.localization.items.command"));
  assert.ok(discovery.operations.includes("cms.localization.release.apply"));
  assert.ok(!discovery.operations.includes("cms.schema.apply"));
  assert.equal(checkCmsWriteVersion({ contractVersion: 1, siteId }, undefined).status, "allowed");
  assert.equal(checkCmsWriteVersion(host.schema, 1).status, "unsupported_version");
  assert.equal(host.save({ siteId }).status, "unsupported_version");
  assert.equal(host.save({ ...host.target(post), expectedSchemaRevision: "old" }).status, "conflict");
  assert.equal(host.getItem(post).title, "海辺の案内");
  assert.throws(() => parseCollectionSchemaResult({ status: "ready", collections: host.schema.collections }), /unknown field/u);
  assert.throws(() => host.save({ ...host.target(post), values: { title: "old key" } }), /unknown field/u);
});

test("schema plan reports conversion and binding impacts and apply checks scope, role and stale drafts", () => {
  const host = new MemoryHost(), next = revisedSchema(host.schema);
  const { migration, confirmation } = host.planSchema(next, [], () => [{ code: "binding", fieldId: "field-keywords", message: "一覧がフィールドを使用" }]);
  assert.deepEqual(migration.problems.map(({ code }) => code), ["conversion", "binding"]);
  assert.ok(migration.changes.some(({ kind, fieldId }) => kind === "rename" && fieldId === "field-title"));
  assert.ok(migration.changes.some(({ kind, fieldId }) => kind === "add" && fieldId === "field-added"));
  assert.equal(host.applySchema(editor, confirmation).status, "forbidden");
  assert.equal(host.applySchema(owner, confirmation).status, "invalid_confirmation");
  const replacements = [{ ...post, values: { "field-summary": ["案内"] } }];
  const plan = host.planSchema(next, replacements);
  const approved = host.confirm(owner, "cms.schema.apply", plan.migration);
  assert.equal(plan.migration.problems.length, 0);
  assert.equal(host.applySchema(owner, approved, replacements).status, "applied");
  assert.deepEqual(host.getItem(post).values.summary, ["案内"]);
  assert.equal(host.getItem(post).values.headline, "海辺の案内");
  assert.deepEqual(host.schema.retiredFields, [{ collectionId: "posts", fieldId: "field-keywords" }]);
  const reuse = structuredClone(host.schema);
  reuse.schemaRevision = "schema-3";
  reuse.retiredFields = [];
  reuse.collections[0].fields.push({ fieldId: "field-keywords", key: "reused", label: "再利用", type: "tags", placement: "main" });
  assert.throws(() => host.planSchema(reuse), /retired field ID/u);
  const same = { ...structuredClone(host.schema), schemaRevision: "schema-4" };
  const stale = host.confirm(owner, "cms.schema.apply", host.planSchema(same).migration);
  host.add(post, { "field-title": "新しい案内", "field-slug": "coast" });
  assert.equal(host.applySchema(owner, stale).status, "conflict");
});

test("schema plan reports field hint and placement changes and preserves reordered fields", () => {
  const host = new MemoryHost(), next = structuredClone(host.schema);
  next.schemaRevision = "schema-2";
  const fields = next.collections[0].fields;
  fields[0].hint = "記事の見出しを入力";
  fields[1].placement = fields[1].placement === "side" ? "main" : "side";
  [fields[0], fields[1]] = [fields[1], fields[0]];

  const { migration } = host.planSchema(next);
  assert.ok(migration.changes.some(({ kind, fieldId }) => kind === "convert" && fieldId === fields[0].fieldId));
  assert.ok(migration.changes.some(({ kind, fieldId }) => kind === "convert" && fieldId === fields[1].fieldId));
  assert.deepEqual(migration.schema.collections[0].fields.map(({ fieldId }) => fieldId), fields.map(({ fieldId }) => fieldId));
});

test("removing a collection keeps its source revisions in the apply conflict check", () => {
  const host = new MemoryHost(), next = structuredClone(host.schema);
  next.schemaRevision = "schema-2";
  next.collections = next.collections.filter(({ id }) => id !== "tags");
  next.collections[0].fields = next.collections[0].fields.filter(({ fieldId }) => fieldId !== "field-category");
  const migration = host.planSchema(next).migration;
  assert.deepEqual(migration.removedItems, [{ collectionId: "tags", itemId: tag.itemId, locale, tombstoned: false, previousRevision: "v-2" }]);
  const confirmation = host.confirm(owner, "cms.schema.apply", migration);
  host.add(tag, { "field-title": "更新されたカテゴリ" });
  assert.equal(host.applySchema(owner, confirmation).status, "conflict");
});

test("schema migrations pin all locale route-table versions and stop when a route is reserved", () => {
  const host = new MemoryHost(), next = { ...structuredClone(host.schema), schemaRevision: "schema-2" };
  const { migration } = host.planSchema(next);
  const confirmation = host.confirm(owner, "cms.schema.apply", migration);
  assert.deepEqual(migration.routeTableVersions, [
    { locale: "en", revision: "routes-en-1" }, { locale: "ja", revision: "routes-ja-1" },
  ]);
  host.routeTables[0] = { ...host.routeTables[0], revision: "routes-ja-2" };
  assert.equal(host.applySchema(owner, confirmation).status, "conflict");

  const blocked = new MemoryHost();
  blocked.routeTables[0].reservations.push({ kind: "fixed-page", path: "/posts/coast", reservationId: "fixed-coast" });
  const blockedPlan = blocked.planSchema({ ...structuredClone(blocked.schema), schemaRevision: "schema-2" });
  assert.ok(blockedPlan.migration.problems.some(({ code, path }) => code === "route" && path === "/posts/coast"));
  assert.throws(() => parseCmsSchemaPlanInput({ siteId, expectedSchemaRevision: blocked.schema.schemaRevision,
    nextSchema: blocked.schema, replacements: [] }, siteId), /routeTableVersions/u);
});

test("release snapshot is immutable, rejects missing published references and keeps exact receipt scope", () => {
  const host = new MemoryHost();
  const bad = host.planRelease([pin(host.drafts.get(cmsItemKey(post)))]);
  assert.equal(bad.problems[0].code, "reference");
  const plan = host.planRelease(undefined, [{ from: "/posts/old-coast", to: "/posts/coast" }]);
  const confirmation = host.confirm(editor, "cms.release.apply", plan.proposal);
  assert.throws(() => checkCmsReleaseApply(editor, { ...host.input(confirmation), siteId: "another-site" }, confirmation, now, host.context()), /CMS site mismatch/u);
  const applied = host.publish(editor, confirmation);
  assert.equal(applied.status, "recorded");
  assert.deepEqual(host.publish(editor, confirmation), applied);
  assert.equal(host.publish(editor, confirmation, { ...host.input(confirmation), confirmationToken: "other" }).status, "conflict");
  assert.equal(host.publish(owner, confirmation).status, "invalid_confirmation");
  assert.equal(cmsOperationStatus({ ...editor, siteId: "second-site" }, "cms.release.apply", confirmation.operationId, [...host.receipts.values()][0]).status, "not_found");
  const previous = host.snapshots.get(applied.result.releaseId);
  assert.throws(() => { previous.items[0].values["field-title"] = "書き換え"; }, TypeError);
  host.add(post, { "field-title": "後から編集", "field-slug": "coast" });
  assert.equal(previous.items[0].values["field-title"], "海辺の案内");
  assert.equal(host.getItem(post).status, "changed");
  const invalidRedirect = host.planRelease(undefined, [{ from: "/posts/coast", to: "/posts/missing" }]);
  assert.ok(invalidRedirect.problems.some(({ code }) => code === "route"));
  const duplicate = { ...post, itemId: "post-2" };
  host.add(duplicate, { "field-title": "パスが同じ", "field-slug": "coast" });
  assert.equal(host.planRelease().problems[0].code, "route");
  assert.throws(() => host.planRelease(undefined, [], { locale: "en" }), /site or locale mismatch/u);
});

test("release assets are pinned to selected image and gallery fields and rechecked at apply", () => {
  const host = new MemoryHost();
  host.schema = parseCmsSchema({ ...host.schema, collections: host.schema.collections.map((collection) =>
    collection.id === "posts" ? { ...collection, fields: [...collection.fields,
      { fieldId: "field-gallery", key: "gallery", type: "gallery", label: "Gallery", captionLabel: "Caption", placement: "main" }] } : collection) });
  const cover = { provider: "fixture", id: "cover" }, slide = { provider: "fixture", id: "slide" };
  const coverAsset = { reference: cover, url: "/media/cover.webp", width: 800, height: 600, altText: "Cover" };
  const slideAsset = { reference: slide, url: "https://images.example.test/slide.webp", width: null, height: null, altText: "" };
  const unused = { ...slideAsset, reference: { provider: "fixture", id: "draft-only" } };
  const selectedValues = { "field-title": "公開記事", "field-slug": "story", "field-cover": cover,
    "field-gallery": [{ id: "", image: slide, caption: "Gallery image" }, { id: "", image: cover, caption: "" }] };
  const draft = host.add(post, selectedValues);
  const context = { ...host.context(), publicAssets: [unused, slideAsset, coverAsset] };
  const input = { siteId, locale, schemaRevision: host.schema.schemaRevision, routeTableRevision: context.routeTable.revision,
    expectedReleaseId: null, items: [pin(draft)], redirects: [] };
  const plan = planCmsRelease(input, "release-assets", context);
  assert.equal(plan.status, "ready");
  const { snapshot } = plan.proposal;
  assert.deepEqual(snapshot.assetManifest, [coverAsset, slideAsset]);
  assert.notEqual(snapshot.assetManifest[0], coverAsset);
  assert.ok(Object.isFrozen(snapshot.assetManifest[0].reference));
  assert.deepEqual(parseCmsReleaseAssetManifest(snapshot.schema, snapshot.items, snapshot.assetManifest), snapshot.assetManifest);
  assert.throws(() => parseCmsReleaseAssetManifest(snapshot.schema, snapshot.items, undefined), /unresolved public asset/u);
  assert.throws(() => parseCmsReleaseAssetManifest(snapshot.schema, snapshot.items, [...snapshot.assetManifest, unused]), /unreferenced public asset/u);
  assert.throws(() => parseCmsReleaseAssetManifest(snapshot.schema, snapshot.items, [coverAsset, { ...slideAsset, url: "//unsafe.example.test/slide" }]), /unsafe image URL/u);
  assert.equal(revalidateCmsRelease(plan.proposal, { ...context, publicAssets: [{ ...coverAsset, width: 801 }, slideAsset] }).status, "conflict");

  const noCover = planCmsRelease(input, "release-assets", { ...context, publicAssets: [slideAsset] });
  assert.equal(noCover.status, "invalid");
  assert.deepEqual(noCover.problems.map(({ fieldId }) => fieldId), ["field-cover", "field-gallery"]);
  for (const unsafeUrl of ["http://images.example.test/cover.png", "https://user:pass@images.example.test/cover.png", "javascript:alert(1)", "/%2fprivate.webp"]) {
    assert.equal(planCmsRelease(input, "release-assets", { ...context, publicAssets: [{ ...coverAsset, url: unsafeUrl }, slideAsset] }).status, "invalid");
  }
  const raw = host.add(post, { ...selectedValues, "field-cover": coverAsset.url,
    "field-gallery": [{ id: "", image: slideAsset.url, caption: "Raw URL" }] });
  const rawPlan = planCmsRelease({ ...input, items: [pin(raw)] }, "release-assets", context);
  assert.equal(rawPlan.status, "invalid");
  assert.deepEqual(rawPlan.problems.map(({ fieldId }) => fieldId), ["field-cover", "field-gallery"]);

  const textOnly = planCmsRelease({ ...input, items: [] }, "release-text-only", context);
  assert.equal(textOnly.status, "ready");
  const { assetManifest: _assetManifest, ...legacy } = textOnly.proposal.snapshot;
  assert.deepEqual(parseCmsReleaseAssetManifest(legacy.schema, legacy.items, undefined), []);
  assert.equal(revalidateCmsRelease({ ...textOnly.proposal, snapshot: legacy }, context).status, "allowed");
});

test("release routes reject fixed, template, and redirect-source conflicts and pin a slug-change redirect", () => {
  const fixed = new MemoryHost();
  fixed.routeTables[0].reservations.push({ kind: "fixed-page", path: "/posts/coast", reservationId: "fixed-coast" });
  assert.ok(fixed.planRelease().problems.some(({ code, path }) => code === "route" && path === "/posts/coast"));

  const template = new MemoryHost();
  template.routeTables[0].reservations.push({ kind: "template", path: "/posts/[slug]", reservationId: "post-template" });
  assert.ok(template.planRelease().problems.some(({ code }) => code === "route"));

  const redirectSource = new MemoryHost();
  redirectSource.routeTables[0].reservations.push({ kind: "fixed-page", path: "/posts/old-coast", reservationId: "old-coast-page" });
  assert.ok(redirectSource.planRelease(undefined, [{ from: "/posts/old-coast", to: "/posts/coast" }]).problems.some(({ code }) => code === "route"));

  const itemSource = new MemoryHost();
  publish(itemSource);
  assert.ok(itemSource.planRelease(undefined, [{ from: "/posts/coast", to: "/posts/new-coast" }]).problems.some(({ code, path }) => code === "route" && path === "/posts/coast"));

  const host = new MemoryHost();
  publish(host);
  const updated = host.add(post, { "field-title": "新しい海辺の案内", "field-slug": "new-coast", "field-category": [tag.itemId], "field-summary": "案内" });
  const plan = host.planRelease([pin(updated), pin(host.drafts.get(cmsItemKey(tag)))]);
  assert.equal(plan.status, "ready");
  const table = plan.proposal.snapshot.routeTable;
  assert.equal(plan.proposal.snapshot.routeTableRevision, "route_v-3");
  assert.equal(table.revision, "route_v-7");
  assert.ok(table.reservations.some((entry) => entry.kind === "cms-item" && entry.path === "/posts/new-coast"));
  assert.ok(table.reservations.some((entry) => entry.kind === "redirect" && entry.owner === "cms"
    && entry.path === "/posts/coast" && entry.targetPath === "/posts/new-coast"));
  assert.deepEqual(plan.proposal.snapshot.redirects, [{ from: "/posts/coast", to: "/posts/new-coast" }]);
  const confirmation = host.confirm(editor, "cms.release.apply", plan.proposal);
  assert.equal(host.publish(editor, confirmation).status, "recorded");
  assert.equal(host.routeTables.find((entry) => entry.locale === "ja").revision, table.revision);
});

test("fixed-page redirect targets are accepted and conflicting sources remain invalid without duplicate reservations", () => {
  const fixedTarget = new MemoryHost();
  fixedTarget.routeTables[0].reservations.push({ kind: "fixed-page", path: "/About", reservationId: "about-page" });
  const release = fixedTarget.planRelease([], [{ from: "/old", to: "/About" }]);
  assert.equal(release.status, "ready");

  const routePlan = planCmsRouteTable({
    current: { siteId, locale, revision: "routes-ja-1", reservations: [
      { kind: "fixed-page", path: "/about", reservationId: "about-page" },
    ] },
    siteId, locale, expectedRevision: "routes-ja-1", nextRevision: "routes-ja-2",
    routes: [{ collectionId: "posts", itemId: "post-1", path: "/posts/coast" }],
    redirects: [
      { from: "/posts/coast", to: "/about" },
      { from: "/old", to: "/about" },
      { from: "/old", to: "/about" },
    ],
  });
  assert.ok(routePlan.problems.some(({ path }) => path === "/posts/coast"));
  assert.ok(routePlan.problems.some(({ path }) => path === "/old"));
  assert.equal(routePlan.table.reservations.filter(({ kind, path }) => kind === "redirect" && path === "/posts/coast").length, 0);
  assert.equal(routePlan.table.reservations.filter(({ kind, path }) => kind === "redirect" && path === "/old").length, 1);

  const hostRedirect = planCmsRouteTable({
    current: { siteId, locale, revision: "routes-ja-1", reservations: [
      { kind: "fixed-page", path: "/about", reservationId: "about-page" },
      { kind: "redirect", path: "/old", targetPath: "/about", owner: "host" },
    ] },
    siteId, locale, expectedRevision: "routes-ja-1", nextRevision: "routes-ja-2", routes: [],
    redirects: [{ from: "/old", to: "/about" }],
  });
  assert.ok(hostRedirect.problems.some(({ path }) => path === "/old"));
  assert.equal(hostRedirect.table.reservations.filter(({ kind, path }) => kind === "redirect" && path === "/old").length, 1);

  const itemSource = new MemoryHost();
  publish(itemSource);
  const updated = itemSource.add(post, { "field-title": "新しい海辺の案内", "field-slug": "new-coast", "field-category": [tag.itemId], "field-summary": "案内" });
  const generatedConflict = itemSource.planRelease([pin(updated), pin(itemSource.drafts.get(cmsItemKey(tag)))], [{ from: "/posts/coast", to: "/posts/other" }]);
  assert.equal(generatedConflict.status, "invalid");
  assert.ok(generatedConflict.problems.some(({ code, path }) => code === "route" && path === "/posts/coast"));
});

test("retained host redirects are revalidated and long release IDs still produce bounded route revisions", () => {
  const staleTarget = new MemoryHost();
  staleTarget.routeTables[0] = { siteId, locale, revision: "routes-ja-2", reservations: [
    { kind: "cms-item", path: "/posts/coast", collectionId: "posts", itemId: "coast" },
    { kind: "redirect", path: "/legacy", targetPath: "/posts/coast", owner: "host" },
  ] };
  const invalid = staleTarget.planRelease([], []);
  assert.equal(invalid.status, "invalid");
  assert.ok(invalid.problems.some(({ code, path }) => code === "route" && path === "/legacy"));

  const host = new MemoryHost(), releaseId = "r".repeat(128), routeTable = host.routeTables.find((table) => table.locale === locale);
  const plan = planCmsRelease({ siteId, locale, schemaRevision: host.schema.schemaRevision, routeTableRevision: routeTable.revision,
    expectedReleaseId: null, items: [], redirects: [] }, releaseId, host.context());
  assert.equal(plan.status, "ready");
  assert.ok(plan.proposal.snapshot.routeTable.revision.length <= 128);
});

test("release and schema plans accept the route table revision identifier format", () => {
  const host = new MemoryHost();
  host.routeTables[0] = { ...host.routeTables[0], revision: "routes:1" };
  assert.equal(host.planRelease().status, "ready");
  const nextSchema = { ...structuredClone(host.schema), schemaRevision: "schema-route-revision" };
  const { migration } = host.planSchema(nextSchema);
  assert.equal(migration.routeTableVersions.find(({ locale: value }) => value === locale)?.revision, "routes:1");
});

test("route planning indexes fixed paths for large CMS collections", () => {
  const routes = Array.from({ length: 25_000 }, (_, index) => ({
    collectionId: "posts", itemId: `post-${index}`, path: `/posts/post-${index}`
  }));
  const started = Date.now();
  const plan = planCmsRouteTable({ current: { siteId, locale, revision: "routes-ja-1", reservations: [] },
    siteId, locale, expectedRevision: "routes-ja-1", nextRevision: "routes-ja-2", routes, redirects: [] });
  assert.equal(plan.problems.length, 0);
  assert.equal(plan.table.reservations.length, routes.length);
  assert.ok(Date.now() - started < 5_000, "25,000 fixed path candidates should be planned without quadratic scans");
});

test("schema migration indexes existing CMS routes and release planning rejects an oversized route table", () => {
  const host = new MemoryHost(), sample = host.drafts.get(cmsItemKey(post)), count = 25_000;
  const items = [], reservations = [];
  for (let index = 0; index < count; index++) {
    const itemId = `migration-post-${index}`, revision = `migration-revision-${index}`, slug = `migration-${index}`;
    const item = { ...sample, itemId, revision, values: { ...sample.values, "field-slug": slug, "field-category": [] } };
    items.push({ item, tombstoned: false });
    reservations.push({ kind: "cms-item", path: `/posts/${slug}`, collectionId: "posts", itemId });
  }
  const routeTable = { siteId, locale, revision: "routes-ja-migration", reservations };
  const nextSchema = { ...structuredClone(host.schema), schemaRevision: "schema-migration" };
  const started = Date.now();
  const migration = planCmsMigrationWithRouteTables({ before: host.schema, next: nextSchema, items, routeTables: [routeTable],
    expectedRouteTableVersions: [{ locale, revision: routeTable.revision }] });
  assert.ok(migration);
  assert.deepEqual(migration.problems, []);
  assert.ok(Date.now() - started < 5_000, "25,000 existing CMS routes should be checked without quadratic scans");

  host.routeTables[0] = { siteId, locale, revision: "routes-ja-full", reservations: Array.from({ length: 100_000 }, (_, index) => ({
    kind: "fixed-page", path: `/fixed/page-${index}`, reservationId: `fixed-${index}`,
  })) };
  const overflow = planCmsRelease({ siteId, locale, schemaRevision: host.schema.schemaRevision, routeTableRevision: "routes-ja-full",
    expectedReleaseId: null, items: [], redirects: [{ from: "/legacy", to: "/fixed/page-0" }] }, "release-full", host.context());
  assert.equal(overflow.status, "invalid");
  assert.ok(overflow.problems.some(({ code, message }) => code === "route" && message.includes("上限")));
});

test("release planning indexes prior item routes and rejects generated redirects over the limit", () => {
  const large = largeReleaseFixture(25_000), started = Date.now();
  const unchanged = planCmsRelease(large.input, "large-release", large.context);
  assert.equal(unchanged.status, "ready");
  assert.ok(Date.now() - started < 5_000, "25,000 existing CMS routes should be matched without quadratic scans");

  const changing = largeReleaseFixture(12_501, true);
  const explicitRedirects = Array.from({ length: 12_500 }, (_, index) => ({
    from: `/legacy-${index}`, to: `/posts/new-${index}`,
  }));
  const overflow = planCmsRelease({ ...changing.input, redirects: explicitRedirects }, "large-release", changing.context);
  assert.equal(overflow.status, "invalid");
  assert.ok(overflow.problems.some(({ code, message }) => code === "route" && message.includes("上限")));
});

test("scheduling pins content, detects new collisions and lets the host retry with a fresh plan", () => {
  const host = new MemoryHost();
  const first = planCmsSchedule("s1", later, now, host.planRelease().proposal);
  assert.equal(host.schedule(host.confirm(editor, "cms.schedule.create", first)).status, "allowed");
  host.add(post, { "field-title": "予約の後で編集した下書き", "field-slug": "new-coast" });
  assert.equal(host.runSchedule(first.id, now), "not_due");
  assert.equal(host.runSchedule(first.id, later), "published");
  assert.equal(host.snapshots.get(host.current).items[0].path, "/posts/coast");
  assert.equal(host.getItem(post).status, "changed");
  const replacement = planCmsSchedule("s2", later, now, host.planRelease().proposal);
  assert.equal(host.schedule(host.confirm(editor, "cms.schedule.create", replacement)).status, "allowed");
  host.routeBlocked = true;
  assert.equal(host.runSchedule(replacement.id, later), "failed");
  assert.equal(host.snapshots.get(host.current).items[0].path, "/posts/coast");
  assert.equal(host.getItem(post).publishFailed, true);
  assert.equal(host.runSchedule(replacement.id, later), "not_due");
  assert.equal(dueCmsSchedule(cancelCmsSchedule(replacement), later), false);
});

test("withdraw and delete hide an item, restoring recovers the draft and leaves prior snapshots intact", () => {
  const host = new MemoryHost();
  const published = publish(host);
  assert.throws(() => host.remove(tag), /withdraw/u);
  const withdrawn = publish(host, host.planRelease([]));
  assert.equal(withdrawn.status, "recorded");
  host.remove(tag);
  assert.equal(host.getItem(tag), null);
  const next = { ...structuredClone(host.schema), schemaRevision: "schema-2" };
  // Clear the post’s draft reference before migrating while its target is in the trash.
  host.add(post, { "field-title": "海辺の案内", "field-slug": "coast" });
  const migration = host.planSchema(next).migration;
  assert.equal(migration.items.find(({ collectionId }) => collectionId === "tags").tombstoned, true);
  assert.equal(host.applySchema(owner, host.confirm(owner, "cms.schema.apply", migration)).status, "applied");
  host.restore(tag);
  assert.equal(host.getItem(tag).status, "draft");
  assert.equal(host.getItem(tag).title, "散歩");
  assert.equal(host.snapshots.get(published.result.releaseId).items.length, 2);
});

test("deletion waits for pending delivery and schedule cancellation only accepts a pending schedule", () => {
  const host = new MemoryHost();
  const state = host.state.get(cmsItemKey(post));
  state.deliveryState = { state: "pending", releaseId: "release-in-flight" };
  assert.throws(() => removeCmsItem(state, now), /pending delivery/u);
  state.deliveryState = { state: "idle" };
  const scheduled = planCmsSchedule("s-pending", later, now, host.planRelease().proposal);
  assert.equal(cancelCmsSchedule(scheduled).state, "cancelled");
  assert.throws(() => cancelCmsSchedule({ ...scheduled, state: "failed" }), /pending schedule/u);
});

test("CollectionWorkspace displays v2-derived status and failure without changing its adapter contract", async (t) => {
  const dom = new JSDOM("<!doctype html><main></main>", { url: "https://example.test/studio" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  t.after(() => dom.window.close());
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { CollectionWorkspace } = await import("@niho/web/collection-workspace");
  const host = new MemoryHost();
  publish(host);
  host.add(post, { "field-title": "新しい海辺の案内", "field-slug": "coast" });
  host.state.get(cmsItemKey(post)).schedule = { id: "s-failed", at: later, state: "failed" };
  const root = createRoot(document.querySelector("main"));
  const adapter = {
    async loadSchema() { return { status: "ready", collections: cmsLegacyCollections(host.schema) }; },
    async listItems({ collectionId }) {
      const { values: _values, version: _version, ...item } = host.getItem(post);
      return { status: "ready", collectionId, items: [item] };
    },
  };
  try {
    await act(async () => root.render(createElement(CollectionWorkspace, { adapter, initialCollectionId: "posts" })));
    await act(async () => {});
    assert.match(document.querySelector('[data-status="changed"]').textContent, /変更あり/u);
    assert.match(document.querySelector('[data-status="failed"]').textContent, /前回の公開に失敗/u);
    assert.match(document.body.textContent, /新しい海辺の案内/u);
    host.state.get(cmsItemKey(post)).deliveryState = { state: "pending", releaseId: host.current };
    await act(async () => root.render(createElement(CollectionWorkspace, { key: "pending", adapter, initialCollectionId: "posts" })));
    await act(async () => {});
    assert.match(document.querySelector('[data-status="publishing"]').textContent, /反映中/u);
    Object.assign(host.state.get(cmsItemKey(post)), { publishedRevision: null, publishedAt: null, deliveryState: { state: "idle" }, schedule: { id: "s-next", at: later, state: "scheduled" } });
    await act(async () => root.render(createElement(CollectionWorkspace, { key: "scheduled", adapter, initialCollectionId: "posts" })));
    await act(async () => {});
    assert.match(document.querySelector('[data-status="scheduled"]').textContent, /予約/u);
  } finally {
    await act(async () => root.unmount());
  }
});
