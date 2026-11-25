import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { generatePageCss, parseComponentLibrary, parsePageDocument, parseSitePresentation, resolvePageDocument } from "@niho/web/core";
import { commitHistory, editDocument, editDocumentById, travelHistory } from "@niho/web/editor-model";
import { renderPageToHtml, renderSitePageToHtml } from "@niho/web/server";
import { collectLocalizationUnits, createLocalizationOverlay, editLocalizedValue, materializeLocalizedPage } from "@niho/web/localization";
import { operationQueue, queuePageEdit, queuePageTravel } from "../dist/editor-operation-queue.js";
import { pageOperationUsesNodeNames } from "../dist/editing-page-operations.js";
import { inspectPageDocument, parsePageInspectQuery } from "../dist/page-inspect.js";

const element = (id, tag, children = []) => ({ type: "element", id, tag, children });
const text = (text) => ({ type: "text", text });
const instance = (id, name) => ({ type: "instance", id, component: "card", ...(name === undefined ? {} : { name }) });
const block = (id) => ({ type: "component", id, block: "Notice", props: { message: "お知らせ" } });
const blocks = { Notice: { props: { message: { type: "string" } }, component: ({ message }) => createElement("aside", null, message) } };
const page = (body, pageId = "home") => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "ja", revision: 1, title: "案内", tokens: {}, body });
const library = (root = element("cardRoot", "article")) => parseComponentLibrary({
  schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{ id: "card", name: "カード", kind: "part", version: 1, root }]
}, blocks);

test("v1 parses optional names on each identified node, with no new key on old documents", () => {
  const original = page([element("hero", "section"), block("notice"), instance("cardOne")]);
  const options = { components: library() };
  const parsed = parsePageDocument(original, blocks, options);
  assert.deepEqual(parsed, original);
  assert.ok(parsed.body.every((node) => !Object.hasOwn(node, "name")));
  const legal = [" ヒーロー ", "a", "🌊".repeat(80)];
  const named = { ...original, body: original.body.map((node, index) => ({ ...node, name: legal[index] })) };
  assert.deepEqual(parsePageDocument(named, blocks, options).body.map((node) => node.name), legal);
  assert.equal(parsePageInspectQuery({ view: "find", name: legal[2] })?.name, legal[2]);
  for (const name of ["", "🌊".repeat(81), "改\n行", "\t", "\u007f", "\u0085", null, 5]) {
    for (const node of original.body) assert.throws(() => parsePageDocument(page([{ ...node, name }]), blocks, options), /name: invalid node name/);
  }
  assert.throws(() => parsePageDocument(page([{ ...text("本文"), name: "対象外" }])), /unknown field/);
});

test("duplicate and pasted subtrees keep names independently of copied ID rewrites", () => {
  const source = page([{ ...element("hero", "section", [
    { ...element("headline", "p", [text("ようこそ")]), name: "見出し" },
    { ...block("notice"), name: "業務のお知らせ" },
    instance("cardOne", "上のカード")
  ]), name: "ヒーロー" }]);
  const components = library();
  const repeated = editDocumentById(source, { type: "duplicate", nodeId: "hero" }, blocks, [], components);
  const copied = repeated.body[1];
  assert.equal(copied.id, "hero_copy1");
  assert.deepEqual(copied.children.map(({ id }) => id), ["headline_copy1", "notice_copy1", "cardOne_copy1"]);
  assert.equal(copied.name, "ヒーロー");
  assert.deepEqual(copied.children.map(({ name }) => name), ["見出し", "業務のお知らせ", "上のカード"]);
  const pasted = editDocumentById(source, { type: "addMany", parentId: null, nodes: JSON.parse(JSON.stringify([copied])) }, blocks, [], components);
  assert.deepEqual(pasted.body[1], copied);
});

test("unsupported hosts can reject names before add, paste, rich text replacement, or restore is applied", () => {
  const named = { ...element("copy", "div"), name: "コピー" };
  assert.equal(pageOperationUsesNodeNames({ type: "name", path: [0], value: "名前" }), true);
  assert.equal(pageOperationUsesNodeNames({ type: "add", parentId: null, node: named }), true);
  assert.equal(pageOperationUsesNodeNames({ type: "addMany", parentId: null, nodes: [named] }), true);
  assert.equal(pageOperationUsesNodeNames({ type: "replaceChildren", path: [0], children: [named] }), true);
  assert.equal(pageOperationUsesNodeNames({ type: "restore", document: page([named]) }), true);
  assert.equal(pageOperationUsesNodeNames({ type: "attribute", path: [0], name: "name", value: "form-field" }), false);
});

test("element, block, and shared names preserve public HTML and CSS bytes", () => {
  const original = page([{ ...element("hero", "section", [block("notice")]), style: { base: { color: "#123456" } } }]);
  const renamed = structuredClone(original);
  renamed.body[0].name = 'ヒーロー <タグ> "名前"';
  renamed.body[0].children[0].name = "内部向けお知らせ";
  assert.equal(generatePageCss(renamed, blocks), generatePageCss(original, blocks));
  assert.equal(renderPageToHtml(renamed, blocks), renderPageToHtml(original, blocks));
  const presentation = {
    schemaVersion: 1, siteId: "demo", locale: "ja", version: "v1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: {
      header: page([element("header", "header", [text("共通ヘッダー")])], "shared-header"),
      footer: page([element("footer", "footer", [text("共通フッター")])], "shared-footer")
    }
  };
  const namedPresentation = structuredClone(presentation);
  namedPresentation.shared.header.body[0].name = "ヘッダーの名前";
  namedPresentation.shared.footer.body[0].name = "フッターの名前";
  const parsed = parseSitePresentation(namedPresentation, renamed, blocks);
  assert.equal(parsed.shared.header.body[0].name, "ヘッダーの名前");
  assert.equal(parsed.shared.footer.body[0].name, "フッターの名前");
  assert.equal(renderSitePageToHtml(renamed, parsed, blocks), renderSitePageToHtml(original, presentation, blocks));
  assert.equal(inspectPageDocument(renamed, { view: "find", name: "内部向けお知らせ" }).items[0].id, "notice");
});

test("instance expansion and detach keep the instance name with the master root name as fallback", () => {
  const root = {
    ...element("cardRoot", "article", [{ ...element("heading", "h2", [text("記事")]), name: "部品の見出し" }]),
    name: "部品の外枠"
  };
  const components = library(root);
  const named = page([instance("first", "ページの先頭"), instance("second")]);
  const document = resolvePageDocument(named, components, blocks).document;
  assert.deepEqual(document.body.map((node) => node.name), ["ページの先頭", "部品の外枠"]);
  assert.deepEqual(document.body.map((node) => node.children[0].name), ["部品の見出し", "部品の見出し"]);
  const resolvedUnnamed = resolvePageDocument(page([instance("first"), instance("second")]), components, blocks).document;
  assert.equal(renderPageToHtml(document, blocks), renderPageToHtml(resolvedUnnamed, blocks));
  assert.equal(generatePageCss(document, blocks), generatePageCss(resolvedUnnamed, blocks));
  assert.equal(editDocumentById(named, { type: "detach", nodeId: "first" }, blocks, [], components).body[0].name, "ページの先頭");
  assert.equal(components.components[0].root.name, "部品の外枠");
});

test("translation materialization rebuilds named inline elements without translating layer names", async () => {
  const config = {
    schemaVersion: 1, siteId: "demo", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"],
    documentLocales: { ja: "ja", en: "en" }, glossaryVersion: "g1", contextVersion: "c1"
  };
  const source = page([element("lead", "p", [text("海の"), element("emphasis", "strong", [text("そば")])]), block("notice"), instance("cardOne")]);
  const options = { blocks, components: library() };
  const renamed = structuredClone(source);
  renamed.body[0].name = "リード";
  renamed.body[0].children[1].name = "強調";
  renamed.body[1].name = "ブロック";
  renamed.body[2].name = "部品";
  options.components.components[0].root.name = "共通部品の外枠";
  const collection = await collectLocalizationUnits(config, renamed, "en", options);
  const unnamedCollection = await collectLocalizationUnits(config, source, "en", options);
  assert.deepEqual(collection.units, unnamedCollection.units);
  const unit = collection.units.find(({ kind }) => kind === "rich-text");
  assert.ok(unit);
  const overlay = createLocalizationOverlay(collection);
  const translated = editLocalizedValue(overlay, collection, {
    unitId: unit.unitId, expectedVersion: overlay.version,
    value: { ...unit.sourceValue, children: [text("By the "), { ...unit.sourceValue.children[1], children: [text("sea")] }] }
  });
  const result = await materializeLocalizedPage(config, renamed, collection, translated, options);
  assert.deepEqual(result.document.body.map((node) => node.name), ["リード", "ブロック", "部品"]);
  assert.equal(result.document.body[0].children[1].name, "強調");
  assert.equal(result.document.body[0].children[1].children[0].text, "sea");
  assert.equal(result.components.components[0].root.name, "共通部品の外枠");
});

test("assigning, changing, and clearing the name each enqueue a single undoable operation", () => {
  const source = page([element("hero", "section")]);
  const apply = (document, operation) => editDocumentById(document, operation);
  let history = { past: [], present: source, future: [] }, queue = operationQueue(source);
  const names = [undefined, "ヒーロー", "メイン", undefined];
  for (const value of names.slice(1)) {
    const next = queuePageEdit(queue, history.present, [{ type: "name", path: [0], value }], editDocument, apply);
    assert.equal(next.document.body[0].name, value);
    assert.equal(next.queue.fallback, false);
    assert.deepEqual(next.queue.pending.at(-1), { type: "name", nodeId: "hero", ...(value === undefined ? {} : { value }) });
    history = commitHistory(history, next.document);
    queue = next.queue;
  }
  for (const value of names.slice(0, -1).reverse()) {
    const previous = travelHistory(history, "undo", {}, []);
    queue = queuePageTravel(queue, history.present, previous.present, "undo", apply);
    assert.equal(previous.present.body[0].name, value);
    assert.equal(queue.fallback, false);
    assert.deepEqual(queue.pending.at(-1), { type: "name", nodeId: "hero", ...(value === undefined ? {} : { value }) });
    history = previous;
  }
  assert.equal(Object.hasOwn(history.present.body[0], "name"), false);
});
