import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { editDocument } from "../dist/editor-model.js";
import { canvasViewportHeight, fitCanvasScale, pathForNodeId, projectLayers, visibleLayers } from "../dist/layers.js";
import { EditorSessionCache, EditorSessionLoadError, readEditorSession } from "../dist/editor-session.js";

const source = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: source.siteId, pageId: source.pageId, locale: source.locale };
const snapshot = (document = source) => ({ document: structuredClone(document), version: "v1" });

test("layer projection uses stable IDs, omits raw text rows and resolves current paths after structure edits", () => {
  const initial = projectLayers(source);
  assert.deepEqual(initial.map(({ id }) => id), ["hero", "heading", "lead", "link"]);
  assert.equal(initial.find(({ id }) => id === "heading").label, "海のそばで過ごす");
  assert.equal(initial.some(({ node }) => node.type === "text"), false);

  const added = editDocument(source, { type: "add", parentId: "hero", index: 0, node: { type: "element", id: "photo", tag: "img", attrs: { src: "/photo.webp", alt: "" }, children: [] } });
  assert.deepEqual(pathForNodeId(added, "heading"), [0, 1]);
  const moved = editDocument(added, { type: "move", path: [0, 1], parentId: "hero", index: 3 });
  assert.deepEqual(pathForNodeId(moved, "heading"), [0, 3]);
  const removedSibling = editDocument(moved, { type: "remove", path: [0, 0] });
  assert.deepEqual(pathForNodeId(removedSibling, "heading"), [0, 2]);
  const withoutHeading = editDocument(removedSibling, { type: "remove", path: [0, 2] });
  assert.equal(pathForNodeId(withoutHeading, "heading"), null);
});

test("collapsed layer projection hides descendants without changing document paths", () => {
  const entries = projectLayers(source), collapsed = visibleLayers(entries, new Set());
  assert.deepEqual(collapsed.map(({ id }) => id), ["hero"]);
  assert.deepEqual(pathForNodeId(source, "link"), [0, 2]);
  assert.deepEqual(visibleLayers(entries, new Set(["hero"])).map(({ id }) => id), ["hero", "heading", "lead", "link"]);
});

test("layer moves still pass through core cycle and lock validation", () => {
  assert.throws(() => editDocument(source, { type: "move", path: [0], parentId: "heading", index: 0 }), /移動|子孫|nesting|parent/);
  assert.throws(() => editDocument(source, { type: "move", path: [0, 0], parentId: null, index: 1 }, {}, [{ nodeId: "hero", fields: ["children"], reason: "固定構造" }]), /固定構造|データ連動値/);
});

test("editor session opens a self-contained document when optional site settings fail", async () => {
  const result = await readEditorSession({ readDocument: async () => snapshot(), readSiteSettings: async () => { throw new Error("offline"); } }, target, new AbortController().signal);
  assert.equal(result.session.history.present.title, source.title);
  assert.equal(result.session.selfContained, true);
  assert.match(result.warning, /文書単体/);
});

test("editor session starts site-settings discovery before the page read", async () => {
  let settingsStarted = false;
  let pageReadSawSettingsStart = false;
  await readEditorSession({
    readSiteSettings: async () => {
      settingsStarted = true;
      return { settings: { title: "Demo", locale: "ja" }, version: "s1" };
    },
    readDocument: async () => {
      pageReadSawSettingsStart = settingsStarted;
      return snapshot();
    }
  }, target, new AbortController().signal);
  assert.equal(pageReadSawSettingsStart, true);
});

test("editor session reuses the current site-settings snapshot without a network read", async () => {
  let settingsReads = 0;
  const result = await readEditorSession({
    readDocument: async () => snapshot(),
    readSiteSettings: async () => { settingsReads++; throw new Error("should use supplied snapshot"); }
  }, target, new AbortController().signal, {}, undefined, {
    siteSettings: { settings: { title: "Demo", locale: "ja" }, version: "s2" }
  });
  assert.equal(settingsReads, 0);
  assert.equal(result.session.selfContained, false);
  assert.equal(result.warning, undefined);
});

test("editor session refreshes site settings when the page reports a newer draft-style version", async () => {
  const dependent = structuredClone(source);
  dependent.body[0].style = { base: { color: { token: "siteInk" } } };
  let settingsReads = 0;
  const result = await readEditorSession({
    readDocument: async () => ({ ...snapshot(dependent), draftStylesVersion: "draft-2" }),
    readSiteSettings: async () => {
      settingsReads++;
      return { settings: { title: "Demo", locale: "ja", tokens: { siteInk: { type: "color", value: "#123456" } } }, version: "draft-2" };
    }
  }, target, new AbortController().signal, {}, undefined, {
    siteSettings: { settings: { title: "Demo", locale: "ja" }, version: "draft-1" }
  });
  assert.equal(settingsReads, 1);
  assert.equal(result.session.siteStyles.tokens.siteInk.value, "#123456");
  assert.equal(result.session.selfContained, false);
});

test("editor session replaces a prefetched page when its style dependency is stale", async () => {
  const dependent = structuredClone(source);
  dependent.body[0].style = { base: { color: { token: "siteInk" } } };
  const latest = { ...dependent, title: "最新のページ" };
  let pageReads = 0;
  const result = await readEditorSession({
    readDocument: async () => { pageReads++; return { ...snapshot(latest), draftStylesVersion: "draft-2" }; },
    readSiteSettings: async () => ({ settings: { title: "Demo", locale: "ja", tokens: { siteInk: { type: "color", value: "#123456" } } }, version: "draft-2" })
  }, target, new AbortController().signal, {}, undefined, {
    snapshot: { ...snapshot(dependent), draftStylesVersion: "draft-1" },
    siteSettings: { settings: { title: "Demo", locale: "ja", tokens: { siteInk: { type: "color", value: "#123456" } } }, version: "draft-2" }
  });
  assert.equal(pageReads, 1);
  assert.equal(result.session.history.present.title, "最新のページ");
});

test("editor session refreshes cached site settings when a page reports a newer styles version", async () => {
  const dependent = structuredClone(source);
  dependent.body[0].style = { base: { color: { token: "siteInk" } } };
  let settingsReads = 0;
  const result = await readEditorSession({
    readDocument: async () => ({ ...snapshot(dependent), stylesVersion: "s2" }),
    readSiteSettings: async () => {
      settingsReads++;
      return { settings: { title: "Demo", locale: "ja", tokens: { siteInk: { type: "color", value: "#123456" } } }, version: "s2" };
    }
  }, target, new AbortController().signal, {}, undefined, {
    siteSettings: { settings: { title: "Demo", locale: "ja" }, version: "s1" }
  });
  assert.equal(settingsReads, 1);
  assert.equal(result.session.siteStyles.tokens.siteInk.value, "#123456");
  assert.equal(result.session.dependencyVersions.stylesVersion, "s2");
});

test("editor page cache reuses only the saved session for the same document version", async () => {
  const cache = new EditorSessionCache(2), controller = new AbortController();
  let document = structuredClone(source), version = "v1", reads = 0;
  const adapter = { readDocument: async () => { reads++; return { ...snapshot(document), version }; } };
  const first = await readEditorSession(adapter, target, controller.signal, {}, undefined, { cache });
  const savedDocument = first.session.history.present;
  first.session.history = { ...first.session.history, present: editDocument(savedDocument, { type: "title", value: "未保存の編集" }) };

  const sameVersion = await readEditorSession(adapter, target, controller.signal, {}, undefined, { cache });
  assert.equal(reads, 2, "版を確かめる文書取得は続け、解析済みsessionだけを再利用する");
  assert.strictEqual(sameVersion.session.history.present, savedDocument);
  assert.equal(sameVersion.session.history.present.title, source.title, "未保存編集はcacheへ入れない");
  assert.deepEqual(sameVersion.session.history.past, []);

  document = { ...source, title: "サーバー側の新しい版" };
  version = "v2";
  const changedVersion = await readEditorSession(adapter, target, controller.signal, {}, undefined, { cache });
  assert.notStrictEqual(changedVersion.session.history.present, savedDocument);
  assert.equal(changedVersion.session.history.present.title, "サーバー側の新しい版");
});

test("editor page cache keeps a clean last-known session and keys it by component-library identity", async () => {
  const cache = new EditorSessionCache(2), controller = new AbortController();
  const components = { schemaVersion: 1, siteId: target.siteId, revision: 1, tokens: {}, components: [] };
  const snapshotValue = snapshot();
  const first = await readEditorSession({ readDocument: async () => snapshotValue }, target, controller.signal, {}, components, { cache });
  first.session.history = { past: [source], present: editDocument(first.session.history.present, { type: "title", value: "未保存の編集" }), future: [] };

  const latest = cache.getLatest(target, components);
  assert.ok(latest);
  assert.equal(latest.session.history.present.title, source.title, "cache keeps only the saved document");
  assert.deepEqual(latest.session.history.past, []);
  assert.equal(cache.getLatest(target, { ...components }), undefined, "a different component-library snapshot cannot reuse the old parsed session");
  assert.equal(cache.getLatest(target, components, -1), undefined, "expired sessions are not served as the last-known page");
});

test("editor page cache can invalidate the last-known session after a server-side localization change", async () => {
  const cache = new EditorSessionCache(2), controller = new AbortController();
  const components = { schemaVersion: 1, siteId: target.siteId, revision: 1, tokens: {}, components: [] };
  await readEditorSession({ readDocument: async () => snapshot() }, target, controller.signal, {}, components, { cache });
  assert.ok(cache.getLatest(target, components));
  cache.invalidateLatest(target);
  assert.equal(cache.getLatest(target, components), undefined);
});

test("editor page cache can remember a newly acknowledged saved session", async () => {
  const cache = new EditorSessionCache(2), controller = new AbortController();
  const components = { schemaVersion: 1, siteId: target.siteId, revision: 1, tokens: {}, components: [] };
  const first = await readEditorSession({ readDocument: async () => snapshot() }, target, controller.signal, {}, components, { cache });
  const savedDocument = editDocument(first.session.history.present, { type: "title", value: "保存済みの版" });
  const savedSession = { ...first.session, version: "v2", saved: "saved-v2", history: { past: [], present: savedDocument, future: [] } };
  cache.rememberLatest(target, { session: savedSession }, components);
  assert.equal(cache.getLatest(target, components)?.session.history.present.title, "保存済みの版");
  assert.deepEqual(cache.getLatest(target, components)?.session.history.past, []);
});

test("editor page cache retains the site-settings snapshot with a prefetched session", async () => {
  const cache = new EditorSessionCache(2), controller = new AbortController();
  const siteSettings = { settings: { title: "Demo", locale: "ja" }, version: "s1" };
  const adapter = {
    readDocument: async () => { throw new Error("should use the prefetched snapshot"); },
    readSiteSettings: async () => siteSettings
  };
  const prefetchedSnapshot = snapshot();
  const first = await readEditorSession(adapter, target, controller.signal, {}, undefined, { cache, snapshot: prefetchedSnapshot });
  const cached = await readEditorSession(adapter, target, controller.signal, {}, undefined, { cache, snapshot: prefetchedSnapshot });
  assert.deepEqual(cached.siteSettings, first.siteSettings);
  assert.equal(cached.siteSettings.version, "s1");
});

test("editor session requires unavailable site settings when the document references their tokens", async () => {
  const dependent = structuredClone(source);
  dependent.body[0].style = { base: { color: { token: "siteInk" } } };
  await assert.rejects(() => readEditorSession({ readDocument: async () => snapshot(dependent), readSiteSettings: async () => { throw new Error("offline"); } }, target, new AbortController().signal),
    (error) => error instanceof EditorSessionLoadError && error.reason === "site-settings-required" && /サイト共通スタイル/.test(error.message));
  const loaded = await readEditorSession({ readDocument: async () => snapshot(dependent), readSiteSettings: async () => ({ settings: { title: "Demo", locale: "ja", tokens: { siteInk: { type: "color", value: "#123456" } } }, version: "s1" }) }, target, new AbortController().signal);
  assert.equal(loaded.session.selfContained, false);
  assert.equal(loaded.session.siteStyles.tokens.siteInk.value, "#123456");
});

test("editor session rejects aborted reads even when an adapter resolves late", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; }), controller = new AbortController();
  const reading = readEditorSession({ readDocument: () => pending }, target, controller.signal);
  controller.abort(); resolve(snapshot());
  await assert.rejects(reading, (error) => error?.name === "AbortError");
});

test("a newer target can finish before an aborted older target without installing the old result", async () => {
  let resolveOld;
  const oldTarget = target, newTarget = { ...target, pageId: "other" };
  const oldController = new AbortController(), newController = new AbortController();
  const oldRead = readEditorSession({ readDocument: () => new Promise((resolve) => { resolveOld = resolve; }) }, oldTarget, oldController.signal);
  const newRead = readEditorSession({ readDocument: async () => snapshot({ ...source, pageId: newTarget.pageId }) }, newTarget, newController.signal);
  const newer = await newRead;
  oldController.abort(); resolveOld(snapshot());
  await assert.rejects(oldRead, (error) => error?.name === "AbortError");
  assert.equal(newer.session.target.pageId, "other");
});

test("editor session wraps invalid documents consistently when site settings load", async () => {
  const invalid = snapshot({ ...source, siteId: "wrong-site" });
  await assert.rejects(() => readEditorSession({ readDocument: async () => invalid, readSiteSettings: async () => ({ settings: { title: "Demo", locale: "ja" }, version: "s1" }) }, target, new AbortController().signal),
    (error) => error instanceof EditorSessionLoadError && error.reason === "document" && /現在の編集内容は保持/.test(error.message) && error.cause instanceof Error);
});

test("editor session carries only a strictly validated English publication status", async () => {
  const englishPublication = { state: "review-required", retryable: false, updatedAt: "2026-10-27T01:02:03+09:00" };
  const loaded = await readEditorSession({ readDocument: async () => ({ ...snapshot(), englishPublication }) }, target, new AbortController().signal);
  assert.deepEqual(loaded.session.englishPublication, { ...englishPublication, updatedAt: "2026-10-26T16:02:03.000Z" });
  for (const invalid of [
    { state: "unknown", retryable: false },
    { state: "queued", retryable: "false" },
    { state: "queued", retryable: false, updatedAt: "tomorrow" },
    { state: "queued", retryable: false, internal: "secret" }
  ]) {
    await assert.rejects(() => readEditorSession({ readDocument: async () => ({ ...snapshot(), englishPublication: invalid }) }, target, new AbortController().signal),
      (error) => error instanceof EditorSessionLoadError && error.reason === "document" && /現在の編集内容は保持/u.test(error.message));
  }
});

test("canvas fit scale is pure and leaves the document viewport width unchanged", () => {
  assert.equal(fitCanvasScale(1280, 640), .5);
  assert.equal(fitCanvasScale(1280, 1600), 1);
  assert.equal(fitCanvasScale(375, 300), .8);
  assert.equal(fitCanvasScale(1280, 0), 1);
  assert.equal(canvasViewportHeight(.5, 600), 1200);
  assert.equal(canvasViewportHeight(.25, 600), 2400);
  assert.equal(canvasViewportHeight(1, 600), 800);
  assert.equal(canvasViewportHeight(.5, 0), 800);
});
