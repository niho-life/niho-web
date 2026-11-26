import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAutomaticCmsTranslationResult, cmsLocalizationItemKey, collectCmsLocalizationUnits,
  createCmsLocalizationOverlay, cmsLocalizationStatus, editCmsLocalizedValue, materializeCmsLocalizedItem,
  parseCmsLocalizationItemKey, parseCmsLocalizationOverlay, parseCmsItemRevision, parseCmsSchema
} from "@niho/web/cms-v2";
import { postsDefinition, tagsDefinition } from "./collection-fixtures.mjs";

const siteId = "fixture.site";
const idFor = (key) => `field-${key}`;
const definition = (source) => ({
  ...source,
  titleField: idFor(source.titleField), slugField: source.slugField === null ? null : idFor(source.slugField),
  imageField: source.imageField === null ? null : idFor(source.imageField), subtitleField: source.subtitleField === null ? null : idFor(source.subtitleField),
  fields: source.fields.filter(({ key }) => key !== "related").map((field) => ({ ...field, fieldId: idFor(field.key) }))
});
const schema = () => parseCmsSchema({ contractVersion: 2, siteId, schemaRevision: "schema-1", retiredFields: [], collections: [definition(postsDefinition()), definition(tagsDefinition())] });
const item = (body = "", title = "海辺の案内", revision = "rev-ja-1", model = schema()) => parseCmsItemRevision({ siteId: model.siteId,
  schemaRevision: model.schemaRevision, collectionId: "posts", itemId: "post-1", locale: "ja-JP", revision,
  values: { "field-title": title, "field-cover": null, "field-body": body, "field-slug": "coast", "field-category": [], "field-keywords": [],
    "field-kind": [], "field-days": [], "field-eventAt": null, "field-source": "https://example.test/post", "field-summary": title } }, model);

test("CMS 翻訳は fieldId identity、MANUAL 保護、明示 fallback で target revision を作る", async () => {
  const model = schema(), source = item(), collection = await collectCmsLocalizationUnits(model, source, "en-US");
  assert.equal(collection.fields.length, 4);
  assert.equal(collection.identity.siteId, "fixture.site");
  assert.notEqual(collection.scopeId, (await collectCmsLocalizationUnits(model, source, "en-GB")).scopeId);
  const otherSchema = parseCmsSchema({ ...model, siteId: "other.site" });
  const otherSite = await collectCmsLocalizationUnits(otherSchema, item("", "海辺の案内", "rev-ja-1", otherSchema), "en-US");
  assert.notEqual(collection.scopeId, otherSite.scopeId);
  assert.deepEqual(parseCmsLocalizationItemKey(cmsLocalizationItemKey("posts", "post-1")), { collectionId: "posts", itemId: "post-1" });
  assert.throws(() => parseCmsLocalizationOverlay({ schemaVersion: 1, identity: { ...collection.identity, targetLocale: "ja" }, version: 1, entries: [] }, collection));

  const title = collection.fields.find(({ identity }) => identity.fieldId === "field-title");
  const overlay0 = createCmsLocalizationOverlay(collection);
  const overlay1 = editCmsLocalizedValue(overlay0, collection, { fieldId: "field-title", expectedVersion: overlay0.version, value: "Coastal guide" });
  const result = { schemaVersion: 1, resultId: "translation-job-1", identity: collection.identity, baseVersion: overlay1.version,
    values: collection.fields.map((field) => ({ fieldId: field.identity.fieldId, sourceFingerprint: field.sourceFingerprint,
      value: field.identity.fieldId === "field-title" ? "The coast guide" : field.identity.fieldId === "field-slug" ? "coast-en"
        : field.identity.fieldId === "field-source" ? "https://example.test/post" : "Coastal guide" })) };
  const overlay2 = applyAutomaticCmsTranslationResult(overlay1, collection, result);
  const titleEntry = overlay2.entries.find(({ unitId }) => unitId === title.unitId);
  assert.equal(titleEntry.draftValue, "Coastal guide");
  assert.equal(titleEntry.editOrigin, "MANUAL");
  assert.equal(titleEntry.candidate.value, "The coast guide");
  const status = cmsLocalizationStatus(overlay2, collection);
  assert.equal(status.missing, 0);
  assert.ok(status.details.some(({ unitId }) => unitId === title.unitId));
  assert.throws(() => materializeCmsLocalizedItem(overlay2, collection, { revision: "rev-en-invalid", fallback: "unknown-policy" }), /expected source or omit/u);

  const updatedCollection = await collectCmsLocalizationUnits(model, item("", "更新した海辺案内", "rev-ja-2"), "en-US");
  const updatedStatus = cmsLocalizationStatus(overlay2, updatedCollection);
  assert.ok(updatedStatus.reviewNeeded > 0);
  assert.equal(materializeCmsLocalizedItem(overlay2, updatedCollection, { revision: "rev-en-stale", fallback: "omit" }).status, "omitted");

  const omitted = materializeCmsLocalizedItem(overlay0, collection, { revision: "rev-en-1", fallback: "omit" });
  assert.equal(omitted.status, "omitted");
  const materialized = materializeCmsLocalizedItem(overlay2, collection, { revision: "rev-en-2", fallback: "omit" });
  assert.equal(materialized.status, "ready");
  assert.equal(materialized.item.locale, "en-US");
  assert.equal(materialized.item.values["field-title"], "Coastal guide");
  assert.equal(materialized.item.values["field-slug"], "coast-en");
  assert.equal(materialized.item.values["field-source"], "https://example.test/post");
  const fallback = materializeCmsLocalizedItem(overlay0, collection, { revision: "rev-en-3", fallback: "source" });
  assert.equal(fallback.status, "ready");
  assert.deepEqual(fallback.missingFieldIds, collection.fields.map(({ identity }) => identity.fieldId));
  assert.equal(fallback.item.values["field-title"], "海辺の案内");
});

test("CMS rich text は安全な host adapter が無ければ未対応として返し、target 生成は原文属性を保持する", async () => {
  const model = schema(), source = item('<a href="/about" title="Read">海辺</a>');
  const withoutAdapter = await collectCmsLocalizationUnits(model, source, "en-US");
  assert.deepEqual(withoutAdapter.issues, [{ fieldId: "field-body", code: "RICH_TEXT_ADAPTER_REQUIRED" }]);
  const unsupportedStatus = cmsLocalizationStatus(createCmsLocalizationOverlay(withoutAdapter), withoutAdapter);
  assert.equal(unsupportedStatus.complete, false);
  assert.equal(unsupportedStatus.missing, 5);
  assert.equal(unsupportedStatus.issues, 1);
  assert.ok(unsupportedStatus.details.some(({ unitId, state }) => unitId === "cms.field.field-body" && state === "missing"));
  const omitted = materializeCmsLocalizedItem(createCmsLocalizationOverlay(withoutAdapter), withoutAdapter,
    { revision: "rev-en-0", fallback: "omit" });
  assert.equal(omitted.status, "omitted");
  assert.ok(omitted.missingFieldIds.includes("field-body"));
  const adapter = {
    parse: (html) => ({ value: { kind: "rich-text", children: [{ type: "element", id: "body-anchor", tag: "a", children: [{ type: "text", text: "海辺" }] }] }, sourceHtml: html }),
    serialize: (value, _field, sourceHtml) => {
      assert.equal(sourceHtml, '<a href="/about" title="Read">海辺</a>');
      return `<a href="/about" title="Read">${value.children[0].children[0].text}</a>`;
    }
  };
  const collection = await collectCmsLocalizationUnits(model, source, "en-US", { richText: adapter });
  const rich = collection.fields.find(({ identity }) => identity.fieldId === "field-body");
  assert.ok(rich);
  const overlay = editCmsLocalizedValue(createCmsLocalizationOverlay(collection), collection, { fieldId: "field-body", expectedVersion: 1,
    value: { kind: "rich-text", children: [{ type: "element", id: "body-anchor", tag: "a", children: [{ type: "text", text: "Seaside" }] }] } });
  assert.throws(() => materializeCmsLocalizedItem(overlay, collection,
    { revision: "rev-en-1", fallback: "source" }), /serializer is required/u);
  const materialized = materializeCmsLocalizedItem(overlay, collection, { revision: "rev-en-2", fallback: "source", richText: adapter });
  assert.equal(materialized.status, "ready");
  assert.equal(materialized.item.values["field-body"], '<a href="/about" title="Read">Seaside</a>');
  const changedHref = await collectCmsLocalizationUnits(model, item('<a href="/new-location" title="Read">海辺</a>'), "en-US", { richText: adapter });
  const previousRich = collection.fields.find(({ identity }) => identity.fieldId === "field-body");
  const currentRich = changedHref.fields.find(({ identity }) => identity.fieldId === "field-body");
  assert.notEqual(previousRich.sourceFingerprint, currentRich.sourceFingerprint);
});
