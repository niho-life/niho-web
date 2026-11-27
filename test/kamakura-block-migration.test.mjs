import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { migrateKamakuraBlocks } from "../scripts/migrate-kamakura-blocks.mjs";
import { parsePageDocument } from "../dist/document.js";
import { parsePageOperation } from "../dist/editing-page-operations.js";
import { resolveCmsPageBindings } from "../dist/cms-page-bindings.js";
import { managedBlockContracts } from "../dist/managed-embed-block.js";
import { initializeSitePresentation } from "../dist/presentation-runtime.js";
import { renderPageToHtml } from "../dist/server.js";
import { postsDefinition } from "./collection-fixtures.mjs";

const text = (text) => ({ type: "text", text });
const element = (id, tag, children = [], attrs) => ({ type: "element", id, tag, children, ...(attrs && { attrs }) });
const document = (pageId, body = []) => ({ schemaVersion: 1, siteId: "source-site", pageId, locale: "ja", revision: 1,
  title: "Fixture page", tokens: {}, body });
const block = (id, block, props = {}) => ({ type: "component", id, block, props });
const target = { siteId: "target-site", pageId: "fixture-page", locale: "ja", revision: 2, version: "target-version" };
const sourceBlocks = {
  KamakuraCarousel: { props: { carouselId: { type: "string" } }, slots: { slide: { label: "スライド", style: ["padding"] } } },
  KamakuraLegacyForm: { props: { formId: { type: "string" } }, slots: { form: { label: "既存フォーム", style: ["padding"] } } },
  KamakuraLegacyFrame: { props: { frameId: { type: "string" } } },
  KamakuraMapEmbed: { props: {} },
  KamakuraCompanyDirectory: { props: {} },
  KamakuraCmsDetail: { props: {} }
};
const input = (body, replacements, extra = {}) => ({ document: document("source", body), sourceBlocks, target, replacements, ...extra });
const presentation = (hostViews) => ({ schemaVersion: 1, siteId: "source-site", locale: "ja", version: "fixture", reset: "neutral-v1", tokens: {}, fonts: [],
  shared: { header: document("header"), footer: document("footer") }, hostViews });
const embed = { provider: "map", title: "地図", source: "https://www.google.com/maps/embed?pb=synthetic-fixture" };

test("Kamakura carousel migration reuses the public runtime, including ordering, autoplay options and controls", (t) => {
  const node = { ...block("cover", "KamakuraCarousel", { carouselId: "fixture" }), slots: { slide: { base: { padding: 12 } } } };
  const carousel = { rootId: "slider", slideIds: ["slide-a", "slide-b"], previousIds: ["prev"], nextIds: ["next"], playPauseIds: ["pause"],
    autoplayMs: 5000, fadeMs: 1200, initiallyPlaying: false, loop: true, swipe: true };
  const control = (id, label) => element(id, "a", [text(label)], { href: "#slides" });
  const view = {
    id: "view-slider", block: node.block, props: node.props, carousel, slotBindings: { slide: ["slide-a", "slide-b"] },
    document: document("slider-view", [element("slider", "div", [
      element("controls", "div", [control("prev", "前へ"), control("next", "次へ"), control("pause", "停止")]),
      element("slide-a", "div", [text("最初")]), { ...element("slide-b", "div", [text("次")]), style: { base: { display: "flex" } } }
    ])])
  };
  const recipe = { nodeId: node.id, kind: "carousel" };
  const migrated = migrateKamakuraBlocks(input([node, element("slide-a", "div", [text("別要素")])], [recipe], { presentation: presentation([view]) }));
  assert.equal(migrated.status, "ready");
  assert.equal(migrated.snapshot.version, target.version);
  assert.equal(migrated.snapshot.document.revision, target.revision);
  const slider = migrated.snapshot.document.body[0].children[0];
  assert.equal(slider.interaction.type, "carousel");
  assert.notEqual(slider.interaction.binding.slideIds[0], "slide-a", "colliding source IDs are remapped along with bindings");
  assert.equal(slider.children[2].style.base.padding, 12);
  assert.equal(parsePageOperation({ type: "add", parentId: null, node: slider }, "$").node.interaction.type, "carousel");
  const invalid = structuredClone(migrated.snapshot.document);
  invalid.body[0].children[0].interaction.binding.slideIds[0] = "unknown-elsewhere";
  assert.throws(() => parsePageDocument(invalid), /carousel binding/u);
  const dom = new JSDOM(renderPageToHtml(migrated.snapshot.document));
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector("[data-nw-carousel]");
  assert.equal(root.dataset.nwCarouselAutoplay, "5000");
  assert.equal(root.dataset.nwCarouselFade, "1200");
  assert.equal(root.dataset.nwCarouselSwipe, "true");
  const slides = [...root.querySelectorAll("[data-nw-carousel-slide]")];
  assert.deepEqual(slides.map((slide) => slide.hidden), [false, true]);
  assert.equal(dom.window.getComputedStyle(slides[1]).display, "none");
  assert.equal(root.querySelector("[data-nw-carousel-next]").getAttribute("role"), "button");
  const dispose = initializeSitePresentation(dom.window.document);
  t.after(dispose);
  root.querySelector("[data-nw-carousel-next]").click();
  assert.deepEqual(slides.map((slide) => slide.hidden), [true, false]);
});

test("visible map frames use a standard embed and unresolved legacy frames or forms produce no replacement draft", () => {
  const frame = {
    id: "location", block: "KamakuraMapEmbed", props: {},
    document: document("location-view", [element("map-target", "div")]),
    externalFrames: [{ nodeId: "map-target", src: embed.source, title: embed.title, allowFullScreen: true }]
  };
  const map = block("map", frame.block);
  const options = { presentation: presentation([frame]), frameOrigins: ["https://www.google.com"] };
  const result = migrateKamakuraBlocks(input([map], [{ nodeId: map.id, kind: "frame", embed }], options));
  assert.equal(result.status, "ready");
  const html = renderPageToHtml(result.snapshot.document);
  assert.match(html, /<iframe[^>]+src="https:\/\/www\.google\.com\/maps\/embed\?pb=synthetic-fixture"/u);
  assert.match(html, /allowfullscreen/iu);
  const denied = migrateKamakuraBlocks(input([map], [{ nodeId: map.id, kind: "frame", embed }], { ...options, frameOrigins: [] }));
  assert.equal(denied.blocked[0].reason, "frame-destination-not-confirmed");
  const oldFrame = block("old-frame", "KamakuraLegacyFrame", { frameId: "calendar" });
  const responsiveView = { ...frame, id: "old-frame-view", block: oldFrame.block, props: oldFrame.props,
    externalFrames: [{ ...frame.externalFrames[0], frameKey: "sizing" }] };
  const oldForm = block("old-form", "KamakuraLegacyForm", { formId: "demo" });
  const stalled = migrateKamakuraBlocks(input([oldFrame, oldForm], [{ nodeId: oldFrame.id, kind: "frame", embed }], {
    ...options, presentation: presentation([responsiveView])
  }));
  assert.deepEqual(stalled.blocked.map(({ reason }) => reason), ["frame-needs-host-behavior", "missing-replacement"]);
  assert.equal("snapshot" in stalled, false);
});

test("form migration uses only the new opaque reference and keeps missing or unmapped legacy configuration blocked", () => {
  const node = block("old-form", "KamakuraLegacyForm", { formId: "legacy-key" });
  const recipe = { nodeId: node.id, kind: "managed-embed", refId: "emb_" + "1".repeat(32) };
  const result = migrateKamakuraBlocks(input([node], [recipe]));
  assert.equal(result.status, "ready");
  const { document: migrated } = result.snapshot;
  assert.deepEqual(parsePageDocument(migrated, managedBlockContracts).body[0].props, {
    refId: recipe.refId, background: "white", initialHeight: 720
  });
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-key|launchToken/u);
  const invalid = migrateKamakuraBlocks(input([node], [{ ...recipe, refId: "" }]));
  assert.equal(invalid.blocked[0].reason, "missing-target-embed-reference");
  const styled = migrateKamakuraBlocks(input([{ ...node, slots: { form: { base: { padding: 12 } } } }], [recipe]));
  assert.equal(styled.blocked[0].reason, "form-slot-style-requires-review");
});

test("CMS list and detail migrations output field mappings used by the standard published snapshot renderer", () => {
  const definition = postsDefinition();
  const schema = { contractVersion: 2, siteId: target.siteId, schemaRevision: "fixture-schema", retiredFields: [],
    collections: [{ ...definition, fields: definition.fields.filter(({ key }) => ["title", "slug", "body"].includes(key))
      .map((field) => ({ ...field, fieldId: field.key })), imageField: null, subtitleField: null }] };
  const list = block("legacy-list", "KamakuraCompanyDirectory"), detail = block("legacy-detail", "KamakuraCmsDetail");
  const listRecipe = { nodeId: list.id, kind: "cms-list",
    body: [element("card", "article", [element("heading", "h2", [text("一覧")])])],
    binding: { templateNodeId: "card", collectionId: "posts", limit: 3, fields: [{ nodeId: "heading", fieldId: "title", target: "text" }] } };
  const detailRecipe = { nodeId: detail.id, kind: "cms-detail", body: [element("detail-title", "h1", [text("詳細")])],
    binding: { collectionId: "posts", slugFieldId: "slug", fields: [{ nodeId: "detail-title", fieldId: "title", target: "text" }] } };
  const result = migrateKamakuraBlocks(input([list, detail], [listRecipe, detailRecipe], { cmsSchema: schema }));
  assert.equal(result.status, "ready");
  const items = ["first", "second"].map((slug) => ({ siteId: target.siteId, locale: target.locale, schemaRevision: schema.schemaRevision,
    collectionId: "posts", itemId: slug, revision: "r-" + slug, values: { title: slug + " published", slug } }));
  const rendered = resolveCmsPageBindings(result.snapshot.document, result.cmsBindings, { schema, items }, { detail: { slug: "first" } });
  const html = renderPageToHtml(rendered);
  assert.match(html, /<h1[^>]*>first published<\/h1>/u);
  assert.match(html, /<h2[^>]*>second published<\/h2>/u);
  const incorrect = migrateKamakuraBlocks(input([list, detail], [listRecipe, {
    ...detailRecipe, binding: { ...detailRecipe.binding, fields: [{ nodeId: "heading", fieldId: "title", target: "text" }] }
  }], { cmsSchema: schema }));
  assert.equal(incorrect.blocked[0].reason, "cms-binding-outside-replacement");
});
