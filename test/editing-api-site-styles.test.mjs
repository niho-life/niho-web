import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPageEditingApi } from "@niho/web/editing-api";
import { createEditingApiSiteSettingsFacade, createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";
import { parseSiteStyles, parseSiteStylesWithFrame, resolvePageStyles } from "@niho/web/core";
import { siteStylesEdits } from "../dist/editing-site-styles.js";

const sourceDocument = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const siteId = sourceDocument.siteId;
const oldBrand = { type: "color", value: "#195640" };
const newBrand = { type: "color", value: "#0055aa" };

function sharedPage(pageId, locale) {
  const page = structuredClone(sourceDocument);
  page.pageId = pageId;
  page.locale = locale;
  page.title = pageId;
  delete page.tokens.ink;
  page.body[0].style.base.color = { token: "brand" };
  return page;
}

function rewriteReferences(value, styleKind, from, to) {
  if (Array.isArray(value)) return value.map((entry) => rewriteReferences(entry, styleKind, from, to));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (styleKind === "token" && key === "token" && entry === from) result[key] = to;
    else if (styleKind === "textStyle" && key === "textStyle" && entry === from) result[key] = to;
    else result[key] = rewriteReferences(entry, styleKind, from, to);
  }
  return result;
}

function documentUses(document, styleKind, name) {
  const serialized = JSON.stringify(document);
  return styleKind === "token" ? serialized.includes(`\"token\":\"${name}\"`) : serialized.includes(`\"textStyle\":\"${name}\"`);
}

function fixture({ publish = true, extraResponseFields = false, extraHostFields = false } = {}) {
  let draft = { version: "draft-1", styles: { tokens: { brand: oldBrand } } };
  let published = { version: "published-1", styles: { tokens: { brand: oldBrand } } };
  let draftNumber = 1, publishedNumber = 1;
  let pages = [sharedPage("home", "ja-JP"), sharedPage("about", "en-US")];
  const editCalls = [];
  const siteStyles = {
    async read() { return structuredClone({ draft, published }); },
    async edit(_actor, _siteId, input) {
      editCalls.push(structuredClone(input));
      if (input.expectedVersion !== draft.version) return { status: "conflict" };
      const styles = structuredClone(draft.styles), candidatePages = structuredClone(pages);
      for (const edit of input.edits) {
        const collection = edit.styleKind === "token" ? "tokens" : "textStyles";
        if (edit.type === "set") (styles[collection] ??= {})[edit.name] = structuredClone(edit.value);
        if (edit.type === "delete") {
          const usages = candidatePages.flatMap((document) => documentUses(document, edit.styleKind, edit.name)
            ? [{ kind: "page", id: document.pageId, locale: document.locale, path: "body" }] : []);
          if (edit.styleKind === "token" && documentUses({ textStyles: styles.textStyles ?? {} }, "token", edit.name)) {
            usages.push({ kind: "siteStyle", id: edit.name, path: "textStyles" });
          }
          if (usages.length) return { status: "referenced", usages };
          delete styles[collection]?.[edit.name];
          if (styles[collection] && !Object.keys(styles[collection]).length) delete styles[collection];
        }
        if (edit.type === "rename") {
          if (!styles[collection]?.[edit.from] || styles[collection]?.[edit.to]) return { status: "conflict" };
          styles[collection][edit.to] = styles[collection][edit.from];
          delete styles[collection][edit.from];
          const rewritten = rewriteReferences(styles, edit.styleKind, edit.from, edit.to);
          Object.keys(styles).forEach((key) => delete styles[key]);
          Object.assign(styles, rewritten);
          for (let index = 0; index < candidatePages.length; index++) {
            candidatePages[index] = rewriteReferences(candidatePages[index], edit.styleKind, edit.from, edit.to);
          }
        }
      }
      const checked = parseSiteStyles(styles);
      draft = { version: `draft-${++draftNumber}`, styles: checked };
      pages = candidatePages;
      const result = { status: "saved", version: draft.version, styles: structuredClone(draft.styles) };
      return extraHostFields ? { ...result, futureField: "must be rejected by the server" } : result;
    },
    async publish(_actor, _siteId, input) {
      if (input.expectedDraftVersion !== draft.version || input.expectedPublishedVersion !== published.version) return { status: "conflict" };
      published = { version: `published-${++publishedNumber}`, styles: structuredClone(draft.styles) };
      const result = { status: "published", version: published.version, styles: structuredClone(published.styles),
        urls: ["https://host.example/"], elapsedMs: 12, warnings: [] };
      return extraHostFields ? { ...result, futureField: "must be rejected by the server" } : result;
    }
  };
  const api = createPageEditingApi({
    async authenticate() { return { kind: "human", subject: "owner", clientKind: "gui" }; },
    async authorize(_actor, capability) { return capability !== "pages.publish" || publish; },
    siteStyles,
    async validationContext() { return { siteStyles: draft.styles }; },
    async readPage(_actor, target) {
      const document = pages.find((page) => page.pageId === target.pageId && page.locale === target.locale);
      return document ? { document, version: "page-1" } : null;
    },
    async savePage(_actor, _target, expectedVersion, document) {
      return expectedVersion === "page-1" ? { status: "saved", version: "page-2", document } : { status: "conflict" };
    }
  });
  const requests = [];
  const client = createPageEditingApiClient({ origin: "https://host.example", siteId, fetch: async (input, init) => {
    const request = new Request(input, init); requests.push(request.url);
    const response = await api(request), path = new URL(request.url).pathname;
    if (!extraResponseFields || !response.ok || !/\/operations\/site\.styles\.(?:edit|publish)$/u.test(path)) return response;
    const body = await response.json();
    return Response.json({ ...body, futureField: "ignored",
      ...(Array.isArray(body.usages) ? { usages: body.usages.map((entry) => ({ ...entry, futureUsageField: "ignored" })) } : {}) }, { status: response.status });
  } });
  return {
    api, client, editCalls, requests,
    pages: () => structuredClone(pages),
    snapshot: () => structuredClone({ draft, published }),
    publishedValues: () => pages.map((page) => resolvePageStyles(page, published.styles).tokens.brand?.value)
  };
}

test("site.styles exposes only read/edit/publish and does not alter page contracts", async () => {
  const { api } = fixture();
  const legacy = await api(new Request(`https://host.example/api/edit/v1/sites/${siteId}/capabilities`));
  const legacyBody = await legacy.json();
  assert.equal(legacyBody.operations.some(({ id }) => id.startsWith("site.styles.")), false);

  const opted = await api(new Request(`https://host.example/api/edit/v1/sites/${siteId}/capabilities?features=site.styles`));
  const body = await opted.json();
  assert.deepEqual(body.operations.filter(({ id }) => id.startsWith("site.styles.")).map(({ id }) => id), [
    "site.styles.read", "site.styles.edit", "site.styles.publish"
  ]);
  const read = body.operations.find(({ id }) => id === "pages.read");
  assert.equal(read.resultSchema.properties.stylesVersion, undefined);
  assert.equal(read.resultSchema.properties.draftStylesVersion, undefined);
  assert.deepEqual(body.operations.find(({ id }) => id === "site.styles.read").resultSchema.required, ["draft", "published"]);
});

test("referenced deletion is refused with usages and does not write", async () => {
  const state = fixture();
  const before = state.snapshot();
  const result = await state.client.editSiteStyles({ expectedVersion: before.draft.version,
    edits: [{ type: "delete", styleKind: "token", name: "brand" }] });
  assert.equal(result.status, "referenced");
  assert.deepEqual(result.usages.map(({ id, locale, path }) => ({ id, locale, path })), [
    { id: "home", locale: "ja-JP", path: "body" }, { id: "about", locale: "en-US", path: "body" }
  ]);
  assert.deepEqual(state.snapshot(), before);
});

test("client ignores newer site-style response fields while validating known values", async () => {
  const state = fixture({ extraResponseFields: true });
  const referenced = await state.client.editSiteStyles({ expectedVersion: "draft-1", edits: [{ type: "delete", styleKind: "token", name: "brand" }] });
  assert.equal(referenced.status, "referenced");
  assert.equal(referenced.usages[0].futureUsageField, undefined);

  const saved = await state.client.editSiteStyles({ expectedVersion: "draft-1", edits: [{ type: "set", styleKind: "token", name: "brand", value: newBrand }] });
  assert.equal(saved.status, "saved");
  assert.equal(saved.futureField, undefined);
  const published = await state.client.publishSiteStyles({ expectedDraftVersion: "draft-2", expectedPublishedVersion: "published-1" });
  assert.equal(published.status, "published");
  assert.equal(published.futureField, undefined);
});

test("server still rejects unknown host fields in style edit and publish results", async () => {
  const state = fixture({ extraHostFields: true });
  const edit = await state.api(new Request(`https://host.example/api/edit/v1/sites/${siteId}/operations/site.styles.edit`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: "draft-1", edits: [{ type: "set", styleKind: "token", name: "brand", value: newBrand }] })
  }));
  assert.equal(edit.status, 502);
  assert.equal((await edit.json()).error, "host_contract_violation");
  const publish = await state.api(new Request(`https://host.example/api/edit/v1/sites/${siteId}/operations/site.styles.publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDraftVersion: "draft-2", expectedPublishedVersion: "published-1" })
  }));
  assert.equal(publish.status, 502);
  assert.equal((await publish.json()).error, "host_contract_violation");
});

test("rename updates its definition and all references in one edit operation", async () => {
  const state = fixture();
  const result = await state.client.editSiteStyles({ expectedVersion: "draft-1",
    edits: [{ type: "rename", styleKind: "token", from: "brand", to: "primary" }] });
  assert.equal(result.status, "saved");
  assert.equal(state.editCalls.length, 1);
  assert.ok(result.styles.tokens.primary);
  assert.equal(result.styles.tokens.brand, undefined);
  for (const page of state.pages()) {
    assert.equal(documentUses(page, "token", "brand"), false);
    assert.equal(documentUses(page, "token", "primary"), true);
  }
});

test("draft changes stay private and one publish applies to every published page", async () => {
  const state = fixture();
  assert.deepEqual(state.publishedValues(), [oldBrand.value, oldBrand.value]);
  const saved = await state.client.editSiteStyles({ expectedVersion: "draft-1",
    edits: [{ type: "set", styleKind: "token", name: "brand", value: newBrand }] });
  assert.equal(saved.status, "saved");
  assert.deepEqual(state.publishedValues(), [oldBrand.value, oldBrand.value]);
  const published = await state.client.publishSiteStyles({ expectedDraftVersion: saved.version, expectedPublishedVersion: "published-1" });
  assert.equal(published.status, "published");
  assert.deepEqual(state.publishedValues(), [newBrand.value, newBrand.value]);
});

test("page calls have no style version, epoch, or feature fence", async () => {
  const state = fixture();
  await state.client.readSiteStyles();
  const target = { siteId, pageId: "home", locale: "ja-JP" };
  const snapshot = await state.client.read(target);
  assert.deepEqual(Object.keys(snapshot).sort(), ["document", "version"]);
  assert.equal(state.requests.find((url) => url.includes("/operations/pages.read/"))?.includes("features=site.styles"), false);
  assert.deepEqual(await state.client.save(target, snapshot.version, snapshot.document), { status: "saved", version: "page-2", document: snapshot.document });
});

test("GUI site settings delegates its style diff to site.styles.edit", async () => {
  const edits = [];
  const facade = createEditingApiSiteSettingsFacade({
    async readSiteStyles() { return { draft: { version: "draft-1", styles: { tokens: { brand: oldBrand } } }, published: { version: "published-1", styles: {} } }; },
    async editSiteStyles(input) { edits.push(structuredClone(input)); return { status: "saved", version: "draft-2", styles: { tokens: { brand: newBrand } } }; }
  }, siteId, { title: "Demo", locale: "ja" });
  const current = await facade.readSiteSettings(siteId);
  const result = await facade.saveSiteSettings({ siteId, expectedVersion: current.version, previousStyles: { tokens: { brand: oldBrand } },
    settings: { title: "Demo", locale: "ja", tokens: { brand: newBrand } } });
  assert.equal(result.status, "saved");
  assert.deepEqual(edits, [{ expectedVersion: "draft-1", edits: [{ type: "set", styleKind: "token", name: "brand", value: newBrand }] }]);
});

test("GUI site settings neither shows nor removes the shared frame", async () => {
  const frame = { ja: { header: [{ type: "element", id: "head", tag: "header", children: [{ type: "text", text: "共通" }] }], footer: [] } };
  const edits = [];
  const facade = createEditingApiSiteSettingsFacade({
    async readSiteStyles() { return { draft: { version: "draft-1", styles: { tokens: { brand: oldBrand }, frame } }, published: { version: "published-1", styles: { frame } } }; },
    async editSiteStyles(input) { edits.push(structuredClone(input)); return { status: "saved", version: "draft-2", styles: { tokens: { brand: newBrand }, frame } }; }
  }, siteId, { title: "Demo", locale: "ja" });
  const current = await facade.readSiteSettings(siteId);
  assert.equal("frame" in current.settings, false);
  assert.equal("frame" in current.publishedStyles, false);
  await facade.saveSiteSettings({ siteId, expectedVersion: current.version, previousStyles: { tokens: { brand: oldBrand } },
    settings: { title: "Demo", locale: "ja", tokens: { brand: newBrand } } });
  assert.deepEqual(edits, [{ expectedVersion: "draft-1", edits: [{ type: "set", styleKind: "token", name: "brand", value: newBrand }] }]);
});

test("siteStylesEdits replaces or removes a locale's frame and rejects an unsafe frame", () => {
  const header = [{ type: "element", id: "head", tag: "header", children: [{ type: "text", text: "共通" }] }];
  const before = { frame: { ja: { header, footer: [] }, en: { header, footer: [] } } };
  const after = { frame: { ja: { header: [], footer: header } } };
  assert.deepEqual(siteStylesEdits(before, after), [
    { type: "frame", locale: "ja", value: { header: [], footer: header } },
    { type: "frame", locale: "en", value: null }
  ]);
  assert.deepEqual(siteStylesEdits(before, before), []);
  assert.throws(() => parseSiteStylesWithFrame({ frame: { ja: { header: [{ type: "element", id: "x", tag: "script", children: [] }], footer: [] } } }));
  assert.throws(() => parseSiteStylesWithFrame({ frame: { ja: { header: [], footer: [], extra: 1 } } }));
  assert.deepEqual(parseSiteStyles({ tokens: { brand: oldBrand }, frame: before.frame }), { tokens: { brand: oldBrand } });
});

test("a carousel in the shared frame is rejected because it references node IDs", () => {
  const slide = (id) => ({ type: "element", id, tag: "div", children: [{ type: "text", text: id }] });
  const header = [{ type: "element", id: "slides", tag: "div", interaction: { type: "carousel", binding: { slideIds: ["one", "two"] } }, children: [slide("one"), slide("two")] }];
  assert.throws(() => parseSiteStylesWithFrame({ frame: { ja: { header, footer: [] } } }), /carousel is not allowed in the shared frame/u);
});

test("GUI style rename is sent as one explicit edit and publish uses the shared pointer", async () => {
  const edits = [], publishes = [];
  const oldSize = { type: "length", value: 24, label: "見出しサイズ" };
  const oldTextStyle = { label: "見出し", base: { fontSize: { token: "headingSize" } } };
  const renamedTextStyle = { label: "見出し", base: { fontSize: { token: "displaySize" } } };
  const facade = createEditingApiSiteSettingsFacade({
    async readSiteStyles() { return { draft: { version: "draft-1", styles: { tokens: { headingSize: oldSize }, textStyles: { heading: oldTextStyle } } },
      published: { version: "published-1", styles: {} } }; },
    async editSiteStyles(input) { edits.push(structuredClone(input)); return { status: "saved", version: "draft-2", styles: { tokens: { displaySize: oldSize }, textStyles: { heading: renamedTextStyle } } }; },
    async publishSiteStyles(input) { publishes.push(structuredClone(input)); return { status: "published", version: "published-2", styles: { tokens: { displaySize: oldSize }, textStyles: { heading: renamedTextStyle } } }; }
  }, siteId, { title: "Demo", locale: "ja" });
  const current = await facade.readSiteSettings(siteId);
  assert.equal(current.publishedVersion, "published-1");
  assert.deepEqual(current.publishedStyles, {});
  const result = await facade.saveSiteSettings({ siteId, expectedVersion: current.version,
    previousStyles: { tokens: { headingSize: oldSize }, textStyles: { heading: oldTextStyle } },
    styleRenames: [{ type: "rename", styleKind: "token", from: "headingSize", to: "displaySize" }],
    settings: { title: "Demo", locale: "ja", tokens: { displaySize: oldSize }, textStyles: { heading: renamedTextStyle } } });
  assert.equal(result.status, "saved");
  assert.deepEqual(edits[0].edits, [
    { type: "rename", styleKind: "token", from: "headingSize", to: "displaySize" },
    { type: "set", styleKind: "textStyle", name: "heading", value: renamedTextStyle }
  ]);
  const published = await facade.publishSiteStyles({ siteId, expectedDraftVersion: "draft-2", expectedPublishedVersion: "published-1" });
  assert.equal(published.status, "published");
  assert.deepEqual(publishes, [{ expectedDraftVersion: "draft-2", expectedPublishedVersion: "published-1" }]);
});

test("GUI can reuse a renamed source name for a new definition before saving", async () => {
  const oldToken = { type: "color", value: "#123456" }, replacement = { type: "color", value: "#abcdef" };
  let editRequest;
  const facade = createEditingApiSiteSettingsFacade({
    async readSiteStyles() { return { draft: { version: "draft-1", styles: { tokens: { "color-1": oldToken } } },
      published: { version: "published-1", styles: { tokens: { "color-1": oldToken } } } }; },
    async editSiteStyles(input) { editRequest = structuredClone(input); return { status: "saved", version: "draft-2", styles: { tokens: { brand: oldToken, "color-1": replacement } } }; }
  }, siteId, { title: "Demo", locale: "ja" });
  const current = await facade.readSiteSettings(siteId);
  const result = await facade.saveSiteSettings({ siteId, expectedVersion: current.version, previousStyles: { tokens: { "color-1": oldToken } },
    styleRenames: [{ type: "rename", styleKind: "token", from: "color-1", to: "brand" }],
    settings: { title: "Demo", locale: "ja", tokens: { brand: oldToken, "color-1": replacement } } });
  assert.equal(result.status, "saved");
  assert.deepEqual(editRequest.edits, [
    { type: "rename", styleKind: "token", from: "color-1", to: "brand" },
    { type: "set", styleKind: "token", name: "color-1", value: replacement }
  ]);
});

test("publish permission controls only site.styles.publish", async () => {
  const { client } = fixture({ publish: false });
  const snapshot = await client.readSiteStyles();
  assert.equal(snapshot.draft.version, "draft-1");
  assert.equal((await client.editSiteStyles({ expectedVersion: "draft-1", edits: [{ type: "set", styleKind: "token", name: "brand", value: newBrand }] })).status, "saved");
  await assert.rejects(client.publishSiteStyles({ expectedDraftVersion: "draft-2", expectedPublishedVersion: "published-1" }),
    (error) => error instanceof EditingApiClientError && error.code === "not_found");
});

test("composeSiteFrame drops unused text styles only when the frame and page together exceed the limit", async () => {
  const { composeSiteFrame } = await import("../dist/site-frame.js");
  const { parsePageDocument } = await import("@niho/web/core");
  const style = (size) => ({ base: { fontSize: `${size}px` } });
  const pageStyles = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`page${index}`, style(10 + index)]));
  const frameStyles = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`frame${index}`, style(30 + index)]));
  const text = (id, textStyle) => ({ type: "element", id, tag: "p", style: { textStyle }, children: [{ type: "text", text: id }] });
  const page = { schemaVersion: 1, siteId: "site", pageId: "home", locale: "ja", revision: 1, title: "Home", tokens: {},
    textStyles: pageStyles, body: Array.from({ length: 10 }, (_, index) => text(`body${index}`, `page${index}`)) };
  const frame = { ja: { header: Array.from({ length: 6 }, (_, index) => text(`head${index}`, `frame${index}`)), footer: [], textStyles: frameStyles } };
  const composed = composeSiteFrame(page, frame);
  assert.deepEqual(Object.keys(composed.textStyles).sort(), [...Array.from({ length: 6 }, (_, index) => `frame${index}`),
    ...Array.from({ length: 10 }, (_, index) => `page${index}`)].sort());
  assert.equal(parsePageDocument(composed).body.length, 1, "the composed page parses within the limit");
  const small = composeSiteFrame({ ...page, textStyles: { page0: style(10), unused: style(12) } }, frame);
  assert.deepEqual(Object.keys(small.textStyles).sort(), [...Object.keys(frameStyles), "page0", "unused"].sort(), "within the limit nothing is dropped");
});

test("composeSiteFrame keeps the page's HTML id when the frame uses the same one", async () => {
  const { composeSiteFrame } = await import("../dist/site-frame.js");
  const { parsePageDocument } = await import("@niho/web/core");
  const page = { schemaVersion: 1, siteId: "site", pageId: "home", locale: "ja", revision: 1, title: "Home", tokens: {},
    body: [{ type: "element", id: "page-footer", tag: "footer", attrs: { id: "footer" }, children: [{ type: "text", text: "page" }] }] };
  const frame = { ja: { header: [], footer: [{ type: "element", id: "frame-footer", tag: "div", attrs: { id: "footer", "aria-label": "kept" }, children: [{ type: "text", text: "frame" }] },
    { type: "element", id: "frame-nav", tag: "nav", attrs: { id: "site-nav" }, children: [] }] } };
  const composed = parsePageDocument(composeSiteFrame(page, frame));
  const nodes = (items) => items.flatMap((node) => node.type === "element" ? [node, ...nodes(node.children)] : []);
  const ids = nodes(composed.body).flatMap((node) => node.attrs?.id ? [node.attrs.id] : []);
  assert.deepEqual(ids.sort(), ["footer", "site-nav"]);
  assert.deepEqual(nodes(composed.body).find((node) => node.id.endsWith("frame-footer")).attrs, { "aria-label": "kept" });
});
