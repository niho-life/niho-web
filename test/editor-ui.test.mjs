import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findLayer } from "./editor-layer-fixtures.mjs";
import { JSDOM } from "jsdom";
import { createMemoryPageOperationHost } from "../examples/memory-page-operation-host.mjs";
import { createPageEditingApi } from "@niho/web/editing-api";
import { createPageEditingApiClient } from "@niho/web/editing-client";
import { editDocumentById } from "@niho/web/editor-model";
import { createBlankEmbedRegistry, pageScope, parsePageDocument } from "@niho/web/core";
import { editorShortcuts } from "../dist/editor-shortcuts.js";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const { createMemoryAssetLibrary } = await import("../examples/memory-asset-library.mjs");
const { renderPageToHtml } = await import("@niho/web/server");
const { parseResolvedAssets, uniqueAssetReferences } = await import("@niho/web/assets");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);
const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
async function layerById(nodeId) {
  return findLayer(() => document.querySelector(`[data-node-id="${nodeId}"] button.e-layer`), async (toggle) => { await act(async () => toggle.click()); await flush(); });
}
async function clickLayer(nodeId) { const target = await layerById(nodeId); assert.ok(target, nodeId); await act(async () => target.click()); await flush(); }
async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await act(async () => target.click()); await flush(); }
/** ブラウザの再読込と同じく、エディタを開き直して保存済みの文書を読み直す。 */
let reloadEditor = async () => {};
const pageRow = (title) => [...document.querySelectorAll("button.e-page")].find((node) => node.querySelector(".e-page-name")?.textContent === title);
async function clickPage(title) { const target = pageRow(title); assert.ok(target, title); await act(async () => target.click()); await flush(); }
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  if (target.tagName !== "SELECT") await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const calls = { reads: [], saves: [], prepares: [], releases: [] }; let stored = structuredClone(options.document ?? fixture), version = "v1";
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" }],
    readDocument: async (target) => { calls.reads.push(structuredClone(target)); return { document: { ...structuredClone(stored), pageId: target.pageId, locale: target.locale }, version, releases: [{ revision: 1, label: "最初の公開" }], ...(options.locks ? { locks: options.locks } : {}), ...(options.readOnly ? { readOnly: options.readOnly } : {}), ...(options.englishPublication ? { englishPublication: options.englishPublication } : {}) }; },
    saveDraft: async (request) => {
      calls.saves.push(structuredClone(request));
      if (options.save) return options.save(request);
      stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision };
    },
    prepareRelease: async (request) => { calls.prepares.push(request); return { ...request, confirmationToken: "reviewed-token", domain: options.domain ?? "https://example.test", changes: [{ path: "見出し", before: "現在の見出し", after: "編集した見出し" }] }; },
    release: async (request) => { calls.releases.push(request); return { status: "released", snapshot: { document: stored, version: "released-v3" } }; },
    ...options.adapter
  };
  let mount = 0;
  const render = async () => {
    await act(async () => root.render(createElement(PageEditor, { key: ++mount, adapter, ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.insertableBlocks ? { insertableBlocks: options.insertableBlocks } : {}), ...(options.assets ? { assets: options.assets } : {}), ...options.props }))); await flush();
    const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  };
  await render(); reloadEditor = render;
  return { calls, adapter, root, stored: () => stored, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const mountedAssetPanel = () => document.querySelector('[aria-label="アセットライブラリ"]');
const assetPanel = () => { const panel = mountedAssetPanel(); return panel && !panel.closest("[hidden]") ? panel : null; };
async function tool(name) { const label = name === "アセット" && !document.querySelector('.e-tools button[title="アセット"]') ? "アップロード" : name; const target = document.querySelector(`.e-tools button[title="${label}"]`); assert.ok(target, label); await act(async () => target.click()); await flush(); }
const assetCard = (name) => [...(assetPanel()?.querySelectorAll(".e-asset-card") ?? [])].find((node) => node.getAttribute("aria-label").startsWith(`${name}（`));
const settle = async () => { await flush(); await flush(); };
async function chooseAsset(name) { const target = assetCard(name); assert.ok(target, name); await act(async () => target.click()); await settle(); }
async function uploadFiles(files) {
  const target = assetPanel().querySelector('input[type="file"]'); assert.ok(target, "file input");
  Object.defineProperty(target, "files", { configurable: true, value: files });
  await act(async () => target.dispatchEvent(new dom.window.Event("change", { bubbles: true }))); await settle();
}
async function clickCanvas(nodeId) {
  const frame = document.querySelector("iframe");
  await act(async () => frame.contentDocument.querySelector(`[data-nw-node="${nodeId}"]`).dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true }))); await settle();
}
const canvasNode = (nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-nw-node="${nodeId}"]`);
const canvasBody = () => document.querySelector("iframe").contentDocument.body;
const layerButton = (id) => document.querySelector(`[data-node-id="${id}"] button.e-layer`);
async function shortcut(target, key, modifiers = {}, focus = true) {
  assert.ok(target, key);
  const event = new target.ownerDocument.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...modifiers });
  await act(async () => { if (focus) target.focus(); target.dispatchEvent(event); }); await settle();
  return event.defaultPrevented;
}
const commandDialog = () => document.querySelector('[role="dialog"][aria-label="コマンドパレット"]');
const canvasOrder = (id) => [...canvasNode(id).children].map((node) => node.dataset.nwNode);
async function dragEvent(target, type, dataTransfer, options = {}) {
  const event = new target.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, ...options });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  await act(async () => target.dispatchEvent(event));
  await settle();
}
async function pointer(target, type, clientY) {
  const event = new target.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => target.dispatchEvent(event));
  await settle();
}


test("page rows prefetch on focus and the matching snapshot serves the page switch", async () => {
  const prefetches = [];
  const app = await setup({ adapter: { prefetchDocument: async (target) => {
    prefetches.push(structuredClone(target));
    return { document: { ...structuredClone(fixture), ...target }, version: `prefetched-${target.pageId}` };
  } } });
  try {
    const other = pageRow("別ページ"); assert.ok(other);
    await act(async () => other.focus()); await flush();
    assert.deepEqual(prefetches, [{ siteId: "demo", pageId: "other", locale: "ja-JP" }]);
    await clickPage("別ページ");
    assert.equal(app.calls.reads.filter(({ pageId }) => pageId === "other").length, 0, "ページ切替は先読みしたsnapshotを使う");
    assert.equal(document.querySelector(".e-page[aria-current='page'] .e-page-name")?.textContent, "別ページ");
  } finally { await app.cleanup(); }
});

test("the adjacent page is prefetched automatically and serves a switch", async () => {
  const prefetches = [];
  const app = await setup({ adapter: { prefetchDocument: async (target) => {
    prefetches.push(structuredClone(target));
    return { document: { ...structuredClone(fixture), ...target }, version: `idle-${target.pageId}` };
  } } });
  try {
    assert.deepEqual(prefetches, [{ siteId: "demo", pageId: "other", locale: "ja-JP" }], "idle warmup should not depend on pointer movement");
    await clickPage("別ページ");
    assert.equal(app.calls.reads.filter(({ pageId }) => pageId === "other").length, 0, "the warmed snapshot serves the page switch");
  } finally { await app.cleanup(); }
});

test("a previously opened page is shown before its version revalidation finishes", async () => {
  const reads = [], homeReads = { count: 0 };
  let resolveHomeRefresh;
  const homeRefresh = new Promise((resolve) => { resolveHomeRefresh = resolve; });
  const app = await setup({ adapter: {
    prefetchDocument: undefined,
    readDocument: async (target) => {
      reads.push(target.pageId);
      if (target.pageId === "home" && ++homeReads.count === 2) return homeRefresh;
      return { document: { ...structuredClone(fixture), ...target }, version: `${target.pageId}-v${homeReads.count}` };
    }
  } });
  try {
    await clickPage("別ページ");
    await clickPage("ホーム");
    assert.equal(input("ページタイトル").value, fixture.title, "the saved page cache renders without waiting for the second home read");
    assert.deepEqual(reads, ["home", "other", "home"], "the cached navigation still revalidates the server version");

    const latest = structuredClone(fixture); latest.title = "サーバーで更新されたページ";
    await act(async () => resolveHomeRefresh({ document: { ...latest, pageId: "home", locale: "ja-JP" }, version: "home-v2" }));
    await flush();
    assert.equal(input("ページタイトル").value, latest.title, "a clean editor adopts the refreshed server session");
  } finally {
    resolveHomeRefresh({ document: { ...structuredClone(fixture), pageId: "home", locale: "ja-JP" }, version: "home-cleanup" });
    await app.cleanup();
  }
});

test("a page revalidation never replaces a newer local edit", async () => {
  let homeReads = 0, resolveHomeRefresh;
  const homeRefresh = new Promise((resolve) => { resolveHomeRefresh = resolve; });
  const app = await setup({ adapter: {
    prefetchDocument: undefined,
    readDocument: async (target) => {
      if (target.pageId === "home" && ++homeReads === 2) return homeRefresh;
      return { document: { ...structuredClone(fixture), ...target }, version: `${target.pageId}-v${homeReads}` };
    }
  } });
  try {
    await clickPage("別ページ");
    await clickPage("ホーム");
    await change(input("ページタイトル"), "手元の編集");
    const latest = structuredClone(fixture); latest.title = "別の編集者の更新";
    await act(async () => resolveHomeRefresh({ document: { ...latest, pageId: "home", locale: "ja-JP" }, version: "home-v2" }));
    await flush();
    assert.equal(input("ページタイトル").value, "手元の編集", "the pending local edit remains visible after server revalidation");
    assert.equal(button("下書き保存").disabled, false, "the local edit remains available for the existing version conflict flow");
  } finally {
    resolveHomeRefresh({ document: { ...structuredClone(fixture), pageId: "home", locale: "ja-JP" }, version: "home-cleanup" });
    await app.cleanup();
  }
});

test("both adjacent pages start prefetching before the first document finishes loading", async () => {
  const prefetches = [], reads = [];
  let finishInitialRead;
  const initialRead = new Promise((resolve) => { finishInitialRead = resolve; });
  const pages = [
    { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" },
    { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" },
    { siteId: "demo", pageId: "last", locale: "ja-JP", title: "最後のページ" }
  ];
  const app = await setup({ adapter: {
    listPages: async () => pages,
    readDocument: async (target) => {
      reads.push(target.pageId);
      if (target.pageId === "home") await initialRead;
      return { document: { ...structuredClone(fixture), ...target }, version: `read-${target.pageId}`, releases: [] };
    },
    prefetchDocument: async (target) => {
      prefetches.push(target.pageId);
      return { document: { ...structuredClone(fixture), ...target }, version: `prefetched-${target.pageId}` };
    }
  } });
  try {
    assert.deepEqual(reads, ["home"], "the initial document is still loading");
    assert.deepEqual(new Set(prefetches), new Set(["last", "other"]), "both visible neighbors warm in parallel");
    await act(async () => { finishInitialRead(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await clickPage("別ページ");
    assert.deepEqual(reads, ["home"], "the prefetched page skips a new document request");
    assert.equal(document.querySelector(".e-page[aria-current='page'] .e-page-name")?.textContent, "別ページ");
  } finally {
    finishInitialRead();
    await app.cleanup();
  }
});

test("breakpoint settings dialog analyzes every page and reports unused and nearby widths", async () => {
  const reads = [];
  const page = (pageId, width) => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title: pageId,
    tokens: {}, body: [{ type: "element", id: `${pageId}-root`, tag: "main",
      ...(width ? { style: { responsive: [{ minWidth: width, declarations: { fontSize: 24 } }] } } : {}), children: [{ type: "text", text: pageId }] }] });
  const docs = { home: page("home"), other: page("other", 1264) };
  const settings = { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [
    { name: "Tablet", minWidth: 768, previewWidth: 900 }, { name: "PC", minWidth: 1280, previewWidth: 1440 }
  ] };
  const app = await setup({ adapter: {
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" }],
    readDocument: async (target) => { reads.push(target.pageId); return { document: docs[target.pageId], version: `v-${target.pageId}` }; },
    breakpointSettings: { read: async () => ({ settings, version: "bp-v1" }), save: async () => ({ status: "saved", version: "bp-v2" }) }
  } });
  try {
    await click("編集モード");
    for (let attempt = 0; attempt < 5 && !document.querySelector(".e-breakpoint-analysis")?.textContent.includes("保存済み設定で全 2 文書"); attempt++) await flush();
    const analysis = document.querySelector(".e-breakpoint-analysis");
    assert.ok(analysis);
    assert.deepEqual(reads.sort(), ["home", "other"], "the current page is already loaded and the other page is fetched for analysis");
    assert.match(analysis.textContent, /どの文書からも使われていない段[\s\S]*タブレット 768px/u);
    assert.match(analysis.textContent, /近接した段（48px以内）[\s\S]*PC 1280px と 文書の段 1264px/u);
    assert.match(analysis.textContent, /正規化の plan/u);
  } finally { await app.cleanup(); }
});

test("breakpoint analysis fails closed when any page cannot be read", async () => {
  const settings = { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1440 }] };
  const app = await setup({ adapter: {
    readDocument: async (target) => target.pageId === "home"
      ? { document: { ...structuredClone(fixture), pageId: "home", locale: "ja-JP" }, version: "v-home" }
      : Promise.reject(new Error("別ページの読込に失敗しました。")),
    breakpointSettings: { read: async () => ({ settings, version: "bp-v1" }), save: async () => ({ status: "saved", version: "bp-v2" }) }
  } });
  try {
    await click("編集モード");
    for (let attempt = 0; attempt < 5 && !document.querySelector(".e-breakpoint-analysis")?.textContent.includes("別ページの読込に失敗しました"); attempt++) await flush();
    const analysis = document.querySelector(".e-breakpoint-analysis");
    assert.match(analysis.textContent, /別ページの読込に失敗しました/u);
    assert.doesNotMatch(analysis.textContent, /使われていない設定段はありません/u);
  } finally { await app.cleanup(); }
});

test("breakpoint analysis keeps the error state when another read resolves after abort", async () => {
  let resolveAbout;
  let contactStarted = false;
  const aboutRead = new Promise((resolve) => { resolveAbout = resolve; });
  const settings = { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1440 }] };
  const app = await setup({ adapter: {
    listPages: async () => [
      { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" },
      { siteId: "demo", pageId: "about", locale: "ja-JP", title: "紹介" },
      { siteId: "demo", pageId: "contact", locale: "ja-JP", title: "問い合わせ" }
    ],
    readDocument: async (target) => {
      if (target.pageId === "about") return aboutRead;
      contactStarted = true;
      throw new Error("問い合わせページの読込に失敗しました。");
    },
    breakpointSettings: { read: async () => ({ settings, version: "bp-v1" }), save: async () => ({ status: "saved", version: "bp-v2" }) }
  } });
  try {
    await click("編集モード");
    for (let attempt = 0; attempt < 30 && !document.querySelector(".e-breakpoint-analysis")?.textContent.includes("問い合わせページの読込に失敗しました"); attempt++) await flush();
    const analysis = document.querySelector(".e-breakpoint-analysis");
    assert.equal(contactStarted, true);
    assert.match(analysis.textContent, /問い合わせページの読込に失敗しました/u);
    resolveAbout({ document: { ...structuredClone(fixture), pageId: "about", locale: "ja-JP" }, version: "v-about" });
    await flush();
    assert.match(analysis.textContent, /問い合わせページの読込に失敗しました/u);
    assert.doesNotMatch(analysis.textContent, /確認中/u);
  } finally { await app.cleanup(); }
});

test("initialTarget opens the requested page and falls back when the page is absent", async () => {
  const requested = await setup({ props: { initialTarget: { siteId: "demo", pageId: "other", locale: "ja-JP" } } });
  try { assert.deepEqual(requested.calls.reads, [{ siteId: "demo", pageId: "other", locale: "ja-JP" }]); }
  finally { await requested.cleanup(); }
  const absent = await setup({ props: { initialTarget: { siteId: "demo", pageId: "missing", locale: "ja-JP" } } });
  try { assert.deepEqual(absent.calls.reads, [{ siteId: "demo", pageId: "home", locale: "ja-JP" }]); }
  finally { await absent.cleanup(); }
});

test("performance measurements finish after the canvas is ready and a draft is acknowledged", async () => {
  const events = [];
  const saved = Promise.withResolvers();
  const app = await setup({
    props: { measurePerformance: (operation) => {
      events.push(["begin", operation]);
      return () => events.push(["finish", operation]);
    } },
    save: () => saved.promise
  });
  try {
    assert.deepEqual(events, [["begin", "initial-load"], ["finish", "initial-load"]]);
    await clickPage("別ページ");
    assert.deepEqual(events.slice(2), [["begin", "page-switch"], ["finish", "page-switch"]]);
    const editRenderPhases = () => events.filter(([, operation]) => operation === "edit-render").map(([phase]) => phase);
    const assertEditRenderFinished = () => {
      const phases = editRenderPhases();
      assert.ok(phases.length >= 2);
      assert.equal(phases.length % 2, 0);
      for (let index = 0; index < phases.length; index += 2) assert.deepEqual(phases.slice(index, index + 2), ["begin", "finish"]);
    };
    await change(input("ページタイトル"), "保存の計測");
    assertEditRenderFinished();
    await click("下書き保存");
    const saveEvents = () => events.filter(([, operation]) => operation === "save");
    assert.deepEqual(saveEvents(), [["begin", "save"]]);
    await act(async () => saved.resolve({ status: "saved", version: "v2", revision: fixture.revision + 1 }));
    assert.deepEqual(saveEvents(), [["begin", "save"], ["finish", "save"]]);
    assertEditRenderFinished();
  } finally { await app.cleanup(); }
});

test("unrelated page edits preserve the shared text-style context for memoized canvas nodes", async () => {
  let renders = 0;
  const blocks = { Counter: { props: {}, component: () => { renders++; return createElement("span", null, "counter"); } } };
  const page = structuredClone(fixture);
  page.textStyles = { body: { base: { fontSize: 16 } } };
  page.body = Array.from({ length: 40 }, (_, index) => ({ type: "component", id: `counter-${index}`, block: "Counter", props: {}, style: { textStyle: "body" } }));
  const app = await setup({ document: page, blocks });
  try {
    const initialRenders = renders;
    assert.equal(initialRenders, page.body.length);
    await change(input("ページタイトル"), "更新したページタイトル");
    assert.equal(renders, initialRenders, "metadata edits should not rerender unchanged canvas nodes");
  } finally { await app.cleanup(); }
});

test("form completion inspector filters candidates, shows loading and unresolved IDs, and saves only an eligible page ID", async () => {
  let resolvePages;
  const page = structuredClone(fixture); page.body.push({ type: "element", id: "contact_form", tag: "form", formCompletionPageId: "removed", attrs: { name: "contact" }, children: [
    { type: "element", id: "contact_submit", tag: "button", attrs: { type: "submit" }, children: [{ type: "text", text: "送信" }] }
  ] });
  const app = await setup({ document: page, adapter: { listFormCompletionPages: (_target, signal) => new Promise((resolve, reject) => {
    resolvePages = resolve; signal.addEventListener("abort", () => reject(new dom.window.DOMException("aborted", "AbortError")), { once: true });
  }) } });
  try {
    await clickLayer("contact_form"); await editorTab("フォーム");
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /完了ページを読み込んでいます/u);
    await act(async () => resolvePages([
      { siteId: "demo", pageId: "thanks", locale: "ja-JP", title: "送信完了", path: "/thanks", kind: "page", visibility: "public", published: true },
      { siteId: "demo", pageId: "home", locale: "ja-JP", title: "現在", path: "/", kind: "page", visibility: "public", published: true },
      { siteId: "demo", pageId: "private", locale: "ja-JP", title: "非公開", path: "/private", kind: "page", visibility: "private", published: true },
      { siteId: "demo", pageId: "draft", locale: "ja-JP", title: "未公開", path: "/draft", kind: "page", visibility: "public", published: false },
      { siteId: "demo", pageId: "template", locale: "ja-JP", title: "テンプレート", path: "/items/[slug]", kind: "template", visibility: "public", published: true },
      { siteId: "other", pageId: "foreign", locale: "ja-JP", title: "別サイト", path: "/foreign", kind: "page", visibility: "public", published: true }
    ])); await flush();
    const select = input("完了ページ");
    assert.deepEqual([...select.options].map((option) => [option.value, option.disabled]), [["", false], ["removed", true], ["thanks", false]]);
    assert.match(select.selectedOptions[0].textContent, /未解決/u);
    await change(select, "thanks"); await click("下書き保存");
    assert.equal(app.stored().body.find((node) => node.id === "contact_form").formCompletionPageId, "thanks");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-node="contact_form"]').getAttribute("formCompletionPageId"), null);
  } finally { await app.cleanup(); }
});

test("form completion inspector is unconnected without the capability and ignores a late result from the previous page", async () => {
  const page = structuredClone(fixture); page.body.push({ type: "element", id: "contact_form", tag: "form", formCompletionPageId: "removed", children: [] });
  const unconnected = await setup({ document: page });
  try {
    await clickLayer("contact_form"); await editorTab("フォーム");
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /完了ページは未接続/u);
    assert.equal(input("完了ページ"), undefined);
  } finally { await unconnected.cleanup(); }

  const pending = new Map();
  const app = await setup({ document: page, adapter: { listFormCompletionPages: (target, signal) => new Promise((resolve, reject) => {
    pending.set(target.pageId, resolve); signal.addEventListener("abort", () => reject(new dom.window.DOMException("aborted", "AbortError")), { once: true });
  }) } });
  try {
    await clickLayer("contact_form"); await editorTab("フォーム");
    const old = pending.get("home"); await clickPage("別ページ"); await clickLayer("contact_form"); await editorTab("フォーム");
    await act(async () => old([{ siteId: "demo", pageId: "old", locale: "ja-JP", title: "古い候補", path: "/old", kind: "page", visibility: "public", published: true }])); await flush();
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /読み込んでいます/u);
    assert.doesNotMatch(document.querySelector('[aria-label="インスペクタ"]').textContent, /古い候補/u);
    await act(async () => pending.get("other")([{ siteId: "demo", pageId: "done", locale: "ja-JP", title: "新しい候補", path: "/done", kind: "page", visibility: "public", published: true }])); await flush();
    assert.deepEqual([...input("完了ページ").options].map((option) => option.value), ["", "removed", "done"]);
  } finally { await app.cleanup(); }
});

test("English publication states stay separate from the Japanese draft and retry only when allowed", async () => {
  const states = [
    ["queued", "処理待ち"], ["translating", "翻訳中"], ["review-required", "未翻訳"], ["publishing", "公開中"],
    ["published", "公開済み"], ["withdrawn", "取り下げ"], ["retryable-failure", "失敗（再試行可能）"], ["superseded", "新しい版に置換済み"]
  ];
  let refreshIndex = 0;
  const app = await setup({
    englishPublication: { state: "initial-release-required", retryable: true, updatedAt: "2026-10-27T01:02:03.000Z" },
    adapter: {
      listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja", title: "別ページ" }],
      englishPublication: {
        refresh: async () => {
          const [state] = states[refreshIndex++];
          return { state, retryable: state === "retryable-failure" };
        },
        retry: async () => ({ status: "accepted", englishPublication: { state: "queued", retryable: false } })
      }
    }
  });
  try {
    const publication = () => document.querySelector(".e-english-publication");
    assert.match(publication().textContent, /最初の英語版公開待ち/u);
    assert.equal(button("英語公開を再試行"), undefined, "初回公開待ちは retryable が不正に true でも再試行しない");

    await change(input("ページタイトル"), "保存前の日本語タイトル");
    await click("状態を更新");
    assert.equal(input("ページタイトル").value, "保存前の日本語タイトル", "状態更新は未保存文書を上書きしない");
    await click("元に戻す");
    assert.equal(input("ページタイトル").value, fixture.title, "状態更新後も undo 履歴を保持する");

    for (const [, label] of states.slice(1, -1)) {
      await click("状態を更新");
      if (label === "公開済み") {
        assert.equal(publication(), null, "正常な公開済み状態では画面上部の帯を表示しない");
        await clickPage("別ページ"); await clickPage("ホーム");
        continue;
      }
      assert.ok(publication().querySelector("strong").textContent.includes(label), label);
    }
    assert.ok(button("英語公開を再試行"));
    await click("英語公開を再試行");
    assert.match(publication().textContent, /処理待ち/u);
    assert.doesNotMatch(publication().textContent, /公開済み/u, "accepted を公開済みと決めつけない");
    await click("状態を更新");
    assert.equal(publication(), null, "新しい版に置換済みのバナーは表示しない");

    await change(input("ページタイトル"), "保存する日本語タイトル");
    await click("下書き保存");
    assert.equal(app.calls.saves.at(-1).expectedVersion, "v1", "状態操作は文書 version を進めない");
  } finally { await app.cleanup(); }
});

test("a late English publication refresh is ignored after switching pages", async () => {
  let resolveRefresh;
  const app = await setup({ adapter: {
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja", title: "別ページ" }],
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId, locale: "ja" }, version: `v-${target.pageId}`,
      englishPublication: target.pageId === "home" ? { state: "queued", retryable: false } : { state: "withdrawn", retryable: false } }),
    englishPublication: {
      refresh: () => new Promise((resolve) => { resolveRefresh = resolve; }),
      retry: async () => ({ status: "accepted", englishPublication: { state: "queued", retryable: false } })
    }
  } });
  try {
    await click("状態を更新");
    await clickPage("別ページ");
    assert.match(document.querySelector(".e-english-publication").textContent, /取り下げ/u);
    await act(async () => resolveRefresh({ state: "published", retryable: false })); await flush();
    assert.match(document.querySelector(".e-english-publication").textContent, /取り下げ/u);
    assert.doesNotMatch(document.querySelector(".e-english-publication").textContent, /公開済み/u);
  } finally { await app.cleanup(); }
});

test("English publication retry failures show only a safe message and keep the draft", async () => {
  const app = await setup({
    englishPublication: { state: "retryable-failure", retryable: true },
    adapter: {
      listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja", title: "ホーム" }],
      englishPublication: {
        refresh: async () => ({ state: "retryable-failure", retryable: true }),
        retry: async () => { throw new Error("SENSITIVE_UPSTREAM_ERROR"); }
      }
    }
  });
  try {
    await change(input("ページタイトル"), "保持する日本語下書き");
    await click("英語公開を再試行");
    assert.equal(input("ページタイトル").value, "保持する日本語下書き");
    assert.match(document.body.textContent, /英語公開を再試行できませんでした/u);
    assert.doesNotMatch(document.body.textContent, /SENSITIVE_UPSTREAM_ERROR/u);
  } finally { await app.cleanup(); }
});

test("editor opens the page tree in a full-width quiet workspace", async () => {
  const app = await setup();
  try {
    assert.equal(document.querySelector('.e-tools button[title="ページ"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[aria-label="ページ一覧"]').hidden, false);
    assert.equal(document.querySelector('[aria-label="要素を追加"]').hidden, true);
    assert.equal(document.querySelector('.e-tools button[title="アセット"]'), null);
    assert.ok(pageRow("ホーム")); assert.ok(document.querySelector('.e-canvas-tools input[aria-label="表示幅"]'));
    const css = document.querySelector(".nw-editor style").textContent;
    assert.ok(css.includes("--e-blue:var(--nw-accent)") && css.includes("--nw-accent:#0f70eb"), "selection blue comes from the shared accent token"); assert.ok(css.includes("grid-template-columns:350px minmax(0,1fr) 300px"));
    assert.ok(css.includes("position:absolute")); assert.ok(css.includes("@media(max-width:820px)"));
    assert.ok(css.includes("scrollbar-gutter:stable"), "fit canvas keeps the scrollbar gutter even when its content fits");
    assert.ok(css.includes("@supports not (scrollbar-gutter:stable){.nw-editor .e-stage{overflow-y:scroll}}"), "older engines reserve the same width with a persistent scrollbar");
    assert.equal(document.querySelector(".e-toolbar"), null); assert.ok(document.querySelector(".e-project-context")); assert.ok(document.querySelector(".e-inspector-actions"));
    const zoom = document.querySelector('.e-inspector-actions select[aria-label="表示倍率"]');
    assert.deepEqual([...zoom.options].map((option) => option.textContent), [zoom.options[0].textContent, "25%", "50%", "75%", "100%", "150%", "200%"]);
    assert.match(zoom.options[0].textContent, /^\d+%$/, "the closed select shows only the number, like STUDIO"); assert.equal(zoom.selectedOptions[0], zoom.options[0], "the fit scale is the first option");
    assert.deepEqual([...zoom.querySelectorAll("optgroup")].map((group) => group.label), ["全体表示", "倍率"], "fit is told apart from the fixed 50% by its group");
    await change(zoom, "0.5"); assert.equal(document.querySelector(".e-canvas-spacer").dataset.scale, "0.500");
    // CSS zoom は iframe の devicePixelRatio を倍率にし、箱の寸法が device px に丸められて折返しが変わる。拡縮は transform だけで行う。
    assert.equal(document.querySelector(".e-canvas-scaled").style.transform, "scale(0.5)", "workspace scaling must not change the layout inside the canvas");
    assert.equal(document.querySelector(".e-canvas-scaled").style.zoom, "");
    assert.equal(document.querySelector(".e-canvas-scaled").style.transformOrigin, "0 0");
    assert.equal(document.querySelector("iframe").style.border, "0px", "the canvas border must not reduce the authored viewport width");
    await click("左パネルを閉じる"); assert.equal(document.querySelector('[aria-label="サイト・ページ・レイヤー"]').hidden, false); assert.ok(document.querySelector(".e-body").classList.contains("is-left-closed"));
    await click("ページ"); assert.equal(document.querySelector(".e-body").classList.contains("is-left-closed"), false);
    await click("右パネルを閉じる"); assert.equal(document.querySelector('[aria-label="インスペクタ"]').hidden, true);
    await click("右パネルを開く"); assert.equal(document.querySelector('[aria-label="インスペクタ"]').hidden, false);
  } finally { await app.cleanup(); }
});

test("three rails edit live text, color, size, position and viewport before draft save", async () => {
  const app = await setup();
  try {
    assert.ok(document.querySelector('[aria-label="サイト・ページ・レイヤー"]'));
    assert.ok(document.querySelector('[aria-label="インスペクタ"]'));
    const frame = document.querySelector("iframe");
    await act(async () => frame.contentDocument.querySelector("h1").dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true })));
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["テキスト", "ボックス", "変形", "設定"]);
    assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]').textContent, "テキスト");
    assert.equal(button("直し終える"), undefined);
    const textTab = document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]');
    await act(async () => textTab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await flush(); assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]').textContent, "ボックス");
    assert.equal(document.activeElement.textContent, "ボックス"); assert.ok(input("幅")); assert.equal(input("テキスト"), undefined);
    await editorTab("設定"); assert.ok(input("文字の種類"));
    await editorTab("テキスト");
    await change(input("テキスト"), "編集した見出し"); await change(input("文字色"), "#ff0000"); await change(input("文字サイズ"), "24");
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("編集した見出し"));
    assert.equal(button("公開").disabled, true);
    await clickLayer("hero"); assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["ボックス", "変形", "設定"]);
    await editorTab("ボックス"); await change(input("配置の基準"), "absolute"); await change(input("上から"), "12");
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(document.querySelector("iframe").style.width, "375px");
    await click("下書き保存"); assert.equal(app.calls.saves[0].expectedVersion, "v1"); assert.equal("trigger" in app.calls.saves[0], false);
    const saved = app.calls.saves[0].document; assert.equal(saved.body[0].children[0].children[0].text, "編集した見出し");
    assert.equal(saved.body[0].children[0].style.base.color, "#ff0000"); assert.equal(saved.body[0].children[0].style.base.fontSize, 24); assert.equal(saved.body[0].style.base.top, 12);
    assert.equal(saved.revision, 1); assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 2 }));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("Basic Icon and Video can be selected, edited, saved, reloaded and rendered", async () => {
  const app = await setup();
  const addPreset = async (id) => {
    await click("追加");
    const target = document.querySelector(`.e-preset-preview[data-preset="${id}"]`)?.closest("button");
    assert.ok(target, id); await act(async () => target.click()); await flush();
  };
  try {
    await click("追加");
    assert.deepEqual([...document.querySelectorAll(".e-add-category .e-preset-preview")].slice(0, 10).map((item) => item.dataset.preset), ["section", "box", "img", "text", "icon", "richtext", "video", "embed-blank", "embed-map", "embed-youtube"]);
    await addPreset("icon");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "アイコン");
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["アイコン", "文字", "ボックス", "変形"]);
    await change(input("アイコン"), "star"); await change(input("アクセシブルな名前"), "おすすめ");
    await editorTab("文字"); await change(input("文字サイズ"), "40"); await change(input("文字色"), "#123456");
    await click("下書き保存");
    assert.equal(app.stored().body.at(-1).icon, "star"); assert.equal(app.stored().body.at(-1).attrs["aria-label"], "おすすめ");
    await reloadEditor(); await clickLayer("node_1");
    assert.equal(input("アイコン").value, "star"); assert.equal(input("アクセシブルな名前").value, "おすすめ");

    await addPreset("video");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "動画");
    await change(input("動画 URL"), "https://media.example.test/intro.mp4");
    await change(input("動画の説明"), "施設の紹介動画"); await change(input("ポスター画像 URL"), "/poster.webp"); await change(input("先読み"), "none");
    const check = (caption) => [...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes(caption))?.querySelector("input");
    const controls = check("再生コントロールを表示"), loop = check("繰り返す");
    assert.equal(controls.checked, true); await act(async () => controls.click()); await act(async () => loop.click()); await flush();
    await click("下書き保存"); await reloadEditor(); await clickLayer("node_2");
    assert.equal(input("動画 URL").value, "https://media.example.test/intro.mp4"); assert.equal(input("動画の説明").value, "施設の紹介動画");
    assert.equal(check("再生コントロールを表示").checked, false); assert.equal(check("繰り返す").checked, true); assert.equal(input("先読み").value, "none");
    const html = renderPageToHtml(app.stored()), video = html.match(/<video[^>]*data-nw-node="node_2"[^>]*><\/video>/)?.[0];
    assert.ok(video.includes('src="https://media.example.test/intro.mp4"')); assert.ok(video.includes('aria-label="施設の紹介動画"'));
    assert.ok(video.includes('poster="/poster.webp"')); assert.ok(video.includes('loop=""')); assert.ok(!video.includes("controls=")); assert.ok(!video.includes("autoplay"));
  } finally { await app.cleanup(); }
});
test("VideoWithButton saves and reloads its closed tree, stays inert while editing and runs in preview", async () => {
  const app = await setup();
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="video-with-button"]')?.closest("button");
    assert.ok(card); assert.equal(card.closest(".e-palette-group").querySelector("h3").textContent, "インタラクション");
    await act(async () => card.click()); await settle();
    let frame = document.querySelector("iframe"), rootElement = frame.contentDocument.querySelector("[data-nw-video-with-button]"), video = frame.contentDocument.querySelector("[data-nw-video]"), control = frame.contentDocument.querySelector("[data-nw-video-toggle]");
    assert.equal(video, null); assert.equal(control.disabled, true, "source未設定では外部要求も無効な操作も行わない");
    const rootId = rootElement.dataset.nwNode;
    const storedRoot = () => app.stored().body.find((node) => node.id === rootId);
    const videoId = rootElement.querySelector("[data-nw-missing-asset]").dataset.nwNode;
    await clickCanvas(videoId); await change(input("動画 URL"), "/intro.mp4"); await settle();
    frame = document.querySelector("iframe"); video = frame.contentDocument.querySelector("[data-nw-video]"); control = frame.contentDocument.querySelector("[data-nw-video-toggle]");
    let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
    await act(async () => control.click()); await settle(); assert.equal(plays, 0, "edit canvas does not bind playback");
    await click("下書き保存");
    assert.deepEqual(storedRoot().interaction, { type: "video-toggle" }); assert.equal(storedRoot().children[0].attrs.src, "/intro.mp4");
    await reloadEditor(); await settle();
    assert.ok(document.querySelector("iframe").contentDocument.querySelector("[data-nw-video-with-button]"));
    await click("プレビュー"); await settle();
    frame = document.querySelector("iframe"); video = frame.contentDocument.querySelector("[data-nw-video]"); control = frame.contentDocument.querySelector("[data-nw-video-toggle]");
    let paused = true;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    video.play = () => { plays++; paused = false; video.dispatchEvent(new frame.contentWindow.Event("play")); return Promise.resolve(); };
    video.pause = () => { paused = true; video.dispatchEvent(new frame.contentWindow.Event("pause")); };
    await act(async () => control.click()); await settle();
    assert.equal(plays, 1); assert.equal(control.getAttribute("aria-label"), "動画を一時停止"); assert.equal(control.getAttribute("aria-pressed"), "true"); assert.equal(video.controls, true);
  } finally { await app.cleanup(); }
});
test("Loop Box palette and inspector save, reload and activate only in preview", async () => {
  const app = await setup();
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="loop-box"]')?.closest("button");
    assert.ok(card); assert.equal(card.closest(".e-palette-group").querySelector("h3").textContent, "インタラクション");
    await act(async () => card.click()); await settle();
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["Loop Box", "ボックス", "変形"]);
    let frame = document.querySelector("iframe"), rootElement = frame.contentDocument.querySelector("[data-nw-loop-box-static]");
    assert.ok(rootElement); assert.equal(frame.contentDocument.querySelector("[data-nw-loop-box]"), null, "edit canvas stays inert");
    const rootId = rootElement.dataset.nwNode;
    await change(input("方向"), "column-reverse"); await change(input("速度（px/秒）"), "90");
    const pause = [...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes("ホバー中は一時停止"))?.querySelector("input");
    assert.equal(pause.checked, true); await act(async () => pause.click()); await settle();
    await click("下書き保存");
    let stored = app.stored().body.find((node) => node.id === rootId);
    assert.deepEqual(stored.interaction, { type: "loop-box", speed: 90, pauseOnHover: false }); assert.equal(stored.style.base.flexDirection, "column-reverse");
    await reloadEditor(); await clickLayer(rootId);
    assert.equal(input("方向").value, "column-reverse"); assert.equal(input("速度（px/秒）").value, "90");
    assert.equal([...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes("ホバー中は一時停止"))?.querySelector("input").checked, false);
    await click("プレビュー"); await settle();
    frame = document.querySelector("iframe"); assert.ok(frame.contentDocument.querySelector("[data-nw-loop-box]")); assert.equal(frame.contentDocument.querySelector("[data-nw-loop-box-static]"), null);
  } finally { await app.cleanup(); }
});
test("Basic の標準埋め込みはカード UI、URL 正規化、保存・再読込、プレビューを共有する", async () => {
  const xPostFrameUrl = "https://frame.example.test/widgets/x-post.html";
  const app = await setup({ props: { xPostFrameUrl } });
  const addPreset = async (id) => {
    await click("追加"); const target = document.querySelector(`.e-preset-preview[data-preset="${id}"]`)?.closest("button");
    assert.ok(target, id); await act(async () => target.click()); await flush();
  };
  try {
    await click("追加");
    const embedGroup = [...document.querySelectorAll(".e-palette-group")].find((group) => group.querySelector("h3")?.textContent === "埋め込み");
    assert.deepEqual([...embedGroup.querySelectorAll(".e-preset-card")].map((card) => card.querySelector(".e-preset-label").lastChild.textContent), ["Blank", "Map", "YouTube", "Vimeo", "Lottie", "Facebook", "X", "Instagram"]);
    await addPreset("embed-map");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Map");
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("Map の URL を設定してください"));
    await addPreset("embed-youtube");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "YouTube");
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["埋め込み", "ボックス", "変形"]);
    const staticCanvas = document.querySelector("iframe");
    await change(input("埋め込み URL"), "https://youtube.com/shorts/dQw4w9WgXcQ");
    await change(input("アクセシブルなタイトル"), "施設紹介");
    assert.equal(input("埋め込み URL").value, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    assert.equal(document.querySelector("iframe").getAttribute("sandbox"), "allow-same-origin allow-scripts");
    assert.notEqual(document.querySelector("iframe"), staticCanvas, "sandbox flags take effect only after a frame navigation");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="youtube"] iframe').style.pointerEvents, "none");
    const trustedCanvas = document.querySelector("iframe");
    await change(input("埋め込み URL"), "");
    assert.notEqual(document.querySelector("iframe"), trustedCanvas);
    assert.equal(document.querySelector("iframe").getAttribute("sandbox"), "allow-same-origin");
    await change(input("埋め込み URL"), "https://youtube.com/shorts/dQw4w9WgXcQ");
    await addPreset("embed-vimeo");
    await addPreset("embed-lottie");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Lottie");
    assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("lottie.host の Asset link"));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("Lottie の URL を設定してください"));
    await change(input("LottieFiles Asset link"), "https://lottie.host/123E4567-E89B-42D3-A456-426614174000/intro.json");
    await change(input("アクセシブルなタイトル"), "ローディングアニメーション");
    let canvas = document.querySelector("iframe"), lottieRoot = canvas.contentDocument.querySelector('[data-nw-embed="lottie"]');
    const lottieId = lottieRoot.dataset.nwNode;
    assert.equal(lottieRoot.dataset.nwLottieSource, "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
    assert.equal(lottieRoot.querySelector("iframe"), null, "edit canvas keeps the external player unloaded");
    await click("アニメーションを再生"); await settle();
    canvas = document.querySelector("iframe"); lottieRoot = canvas.contentDocument.querySelector('[data-nw-embed="lottie"]');
    assert.equal(lottieRoot.querySelector("iframe"), null, "the edit-mode motion replay also keeps Lottie static");
    await addPreset("embed-facebook");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Facebook");
    assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("公開投稿の facebook.com URL"));
    await change(input("Facebook の投稿 URL"), "https://facebook.com/example.page/posts/123456789/");
    await change(input("アクセシブルなタイトル"), "Facebook のお知らせ");
    const facebookId = document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="facebook"]').dataset.nwNode;
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-facebook-link]').getAttribute("href"), "https://www.facebook.com/example.page/posts/123456789");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-facebook-load]').hidden, true, "edit canvas keeps Facebook static");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="facebook"] iframe'), null);
    await addPreset("embed-x");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "X");
    assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("公開ポストの x.com URL"));
    await change(input("X のポスト URL"), "https://x.com/Example/status/1234567890123456789/");
    await change(input("アクセシブルなタイトル"), "X のお知らせ");
    const xRoot = document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="x"]'), xId = xRoot.dataset.nwNode;
    assert.equal(xRoot.dataset.nwSocialSource, "https://x.com/example/status/1234567890123456789"); assert.equal(xRoot.querySelector('[data-nw-social-load]').hidden, true); assert.equal(xRoot.querySelector("iframe"), null);
    await addPreset("embed-instagram");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Instagram");
    await change(input("Instagram の投稿・リール URL"), "https://instagram.com/reel/AbCdEf12345");
    await change(input("アクセシブルなタイトル"), "Instagram のお知らせ");
    const instagramRoot = document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="instagram"]'), instagramId = instagramRoot.dataset.nwNode;
    assert.equal(instagramRoot.dataset.nwSocialSource, "https://www.instagram.com/reel/AbCdEf12345/"); assert.equal(instagramRoot.querySelector('[data-nw-social-load]').hidden, true); assert.equal(instagramRoot.querySelector("iframe"), null);
    await click("下書き保存");
    assert.deepEqual(app.stored().body.slice(-7).map((node) => node.embed.provider), ["map", "youtube", "vimeo", "lottie", "facebook", "x", "instagram"]);
    assert.equal(app.stored().body.at(-6).embed.title, "施設紹介");
    assert.deepEqual(app.stored().body.at(-4).embed, { provider: "lottie", title: "ローディングアニメーション", source: "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json" });
    assert.deepEqual(app.stored().body.at(-3).embed, { provider: "facebook", title: "Facebook のお知らせ", source: "https://www.facebook.com/example.page/posts/123456789" });
    assert.deepEqual(app.stored().body.at(-2).embed, { provider: "x", title: "X のお知らせ", source: "https://x.com/example/status/1234567890123456789" });
    assert.deepEqual(app.stored().body.at(-1).embed, { provider: "instagram", title: "Instagram のお知らせ", source: "https://www.instagram.com/reel/AbCdEf12345/" });
    await reloadEditor(); await clickLayer("node_2");
    assert.equal(input("埋め込み URL").value, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    assert.equal(input("アクセシブルなタイトル").value, "施設紹介");
    await clickLayer(lottieId); assert.equal(input("LottieFiles Asset link").value, "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
    await clickLayer(facebookId); assert.equal(input("Facebook の投稿 URL").value, "https://www.facebook.com/example.page/posts/123456789");
    await clickLayer(xId); assert.equal(input("X のポスト URL").value, "https://x.com/example/status/1234567890123456789");
    await clickLayer(instagramId); assert.equal(input("Instagram の投稿・リール URL").value, "https://www.instagram.com/reel/AbCdEf12345/");
    const html = renderPageToHtml(app.stored());
    assert.match(html, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/); assert.match(html, /title="施設紹介"/);
    assert.doesNotMatch(html, /<iframe[^>]+lottie\.host/); assert.match(html, /data-nw-lottie-source="https:\/\/lottie\.host\/embed\//);
    assert.doesNotMatch(html, /facebook\.com\/plugins\/post\.php/); assert.match(html, /href="https:\/\/www\.facebook\.com\/example\.page\/posts\/123456789"/);
    assert.doesNotMatch(html, /platform\.twitter\.com\/widgets\.js/); assert.doesNotMatch(html, /instagram\.com\/embed\.js/);
    assert.match(html, /href="https:\/\/x\.com\/example\/status\/1234567890123456789"/); assert.match(html, /href="https:\/\/www\.instagram\.com\/reel\/AbCdEf12345\/"/);
    await click("プレビュー"); await settle();
    canvas = document.querySelector("iframe"); lottieRoot = canvas.contentDocument.querySelector('[data-nw-embed="lottie"]');
    assert.equal(lottieRoot.querySelector("iframe")?.getAttribute("src"), "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
    const facebookRoot = canvas.contentDocument.querySelector('[data-nw-embed="facebook"]'), facebookButton = facebookRoot.querySelector('[data-nw-facebook-load]');
    assert.equal(facebookButton.hidden, false); assert.equal(facebookRoot.querySelector("iframe"), null);
    await act(async () => facebookButton.click()); await flush();
    assert.match(facebookRoot.querySelector("iframe").getAttribute("src"), /^https:\/\/www\.facebook\.com\/plugins\/post\.php\?href=/u);
    assert.equal(facebookRoot.querySelector("iframe").style.pointerEvents, "none");
    assert.ok(facebookRoot.querySelector('[data-nw-facebook-link]'));
    for (const provider of ["x", "instagram"]) {
      const socialRoot = canvas.contentDocument.querySelector(`[data-nw-embed="${provider}"]`), socialButton = socialRoot.querySelector('[data-nw-social-load]');
      assert.equal(socialButton.hidden, false); assert.equal(socialRoot.querySelector("iframe"), null);
      await act(async () => socialButton.click()); await flush();
      const frame = socialRoot.querySelector("iframe");
      if (provider === "x") {
        const frameUrl = new URL(frame.getAttribute("src"));
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin"); assert.equal(`${frameUrl.origin}${frameUrl.pathname}`, xPostFrameUrl); assert.deepEqual([...frameUrl.searchParams], [["url", "https://x.com/example/status/1234567890123456789"]]); assert.equal(frame.hasAttribute("srcdoc"), false);
      } else {
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts"); assert.equal(frame.hasAttribute("src"), false); assert.ok(frame.getAttribute("srcdoc").includes("instagram.com/embed.js"));
      }
      assert.equal(frame.style.pointerEvents, "none"); assert.ok(socialRoot.querySelector('[data-nw-social-link]'));
    }
  } finally { await app.cleanup(); }
});
test("外部URLの新規追加はopt-inで、保存とTravel previewの制限権限を共有する", async () => {
  const blankEmbeds = createBlankEmbedRegistry({ parentOrigin: "https://editor.example.test", entries: [] });
  const app = await setup({ props: { enableUrlEmbeds: true, blankEmbeds } });
  const source = "https://travel.niho.life/embed/experiences/sea-kayak/book?locale=ja&campaign=kamakura";
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="embed-url"]')?.closest("button");
    assert.ok(card); assert.match(card.textContent, /外部URL/u);
    await act(async () => card.click()); await flush();
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "外部URL");
    assert.match(document.querySelector("iframe").contentDocument.body.textContent, /外部URL の URL を設定/u);
    await change(input("公開HTTPS URL"), source);
    await change(input("アクセシブルなタイトル"), "NIHO Travel 予約");
    let canvas = document.querySelector("iframe"), root = canvas.contentDocument.querySelector('[data-nw-embed="url"]');
    assert.ok(root?.hasAttribute("data-nw-url-static")); assert.equal(root.querySelector("iframe"), null, "編集中は外部通信しない");
    await click("下書き保存");
    assert.deepEqual(app.stored().body.at(-1).embed, { provider: "url", title: "NIHO Travel 予約", source });
    assert.equal(app.stored().body.at(-1).style.base.width, "100%");
    assert.equal(app.stored().body.at(-1).style.base.height, 640);
    await click("プレビュー"); await settle();
    canvas = document.querySelector("iframe"); root = canvas.contentDocument.querySelector('[data-nw-embed="url"]');
    const frame = root.querySelector("iframe"), preview = new URL(frame.getAttribute("src"));
    assert.equal(preview.searchParams.get("locale"), "ja"); assert.equal(preview.searchParams.get("campaign"), "kamakura"); assert.equal(preview.searchParams.get("preview"), "1");
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms");
    assert.equal(frame.getAttribute("referrerpolicy"), "origin"); assert.equal(frame.getAttribute("data-nw-url-embed-frame"), "");
    assert.equal(root.querySelector("[data-nw-url-fallback]").getAttribute("href"), preview.href);
  } finally { await app.cleanup(); }
});
test("Blank は承認済み key だけを選択し、未接続案内・保存・undo・preview を共有する", async () => {
  const disconnectedDocument = structuredClone(fixture);
  disconnectedDocument.body.push({ type: "element", id: "blank_existing", tag: "div", embed: { provider: "blank", title: "公開ガイド" }, children: [] });
  const disconnected = await setup({ document: disconnectedDocument });
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="embed-blank"]').closest("button");
    assert.equal(card.disabled, true); assert.match(card.textContent, /未接続/u); assert.match(card.title, /接続されていません/u);
    const detailSelect = input("追加する要素"), blankOption = [...detailSelect.options].find((option) => option.value === "embed-blank");
    assert.equal(blankOption.disabled, true); assert.match(blankOption.textContent, /未接続/u);
    await change(detailSelect, "embed-blank");
    const addButton = button("要素を追加");
    assert.equal(addButton.disabled, true); assert.match(addButton.title, /接続されていません/u); assert.match(document.body.textContent, /追加できません/u);
    const blankCount = document.querySelector("iframe").contentDocument.querySelectorAll('[data-nw-embed="blank"]').length;
    const reactProps = Object.keys(addButton).find((key) => key.startsWith("__reactProps$"));
    assert.ok(reactProps, "中心 add handler");
    await act(async () => addButton[reactProps].onClick()); await flush();
    assert.match(document.querySelector('[role="alert"]').textContent, /追加できません/u);
    assert.equal(document.querySelector("iframe").contentDocument.querySelectorAll('[data-nw-embed="blank"]').length, blankCount, "中心の add 経路も未接続 Blank を拒否する");
    await clickLayer("blank_existing");
    assert.equal(input("承認済みの埋め込み").disabled, true);
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /Blank 埋め込みが未接続です/u);
    assert.equal(input("アクセシブルなタイトル").disabled, false);
    await change(input("アクセシブルなタイトル"), "更新した公開ガイド");
    assert.equal(input("アクセシブルなタイトル").value, "更新した公開ガイド");
    await click("削除");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-node="blank_existing"]'), null);
    await click("元に戻す");
    assert.ok(document.querySelector("iframe").contentDocument.querySelector('[data-nw-node="blank_existing"]'));
  } finally { await disconnected.cleanup(); }

  const blankEmbeds = createBlankEmbedRegistry({ parentOrigin: "https://example.test", entries: [
    { key: "public-guide", label: "公開ガイド", src: "https://embed.example.test/public/guide", sandbox: "scripts" }
  ] });
  const app = await setup({ props: { blankEmbeds } });
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="embed-blank"]').closest("button");
    assert.equal(card.disabled, false);
    await act(async () => card.click()); await flush();
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Blank");
    assert.match(document.querySelector("iframe").contentDocument.body.textContent, /承認済みの埋め込みを選択/u);
    await change(input("承認済みの埋め込み"), "public-guide");
    await change(input("アクセシブルなタイトル"), "施設の公開ガイド");
    let canvas = document.querySelector("iframe"), root = canvas.contentDocument.querySelector('[data-nw-embed="blank"]');
    assert.ok(root); assert.equal(root.querySelector("iframe"), null, "edit canvas keeps Blank unloaded");
    assert.match(root.textContent, /公開ガイド（プレビューで表示）/u);
    await click("元に戻す");
    assert.equal(input("アクセシブルなタイトル").value, "埋め込みコンテンツ");
    await click("やり直す");
    assert.equal(input("アクセシブルなタイトル").value, "施設の公開ガイド");
    await click("下書き保存");
    assert.deepEqual(app.stored().body.at(-1).embed, { provider: "blank", title: "施設の公開ガイド", source: "public-guide" });
    await reloadEditor(); await clickLayer(app.stored().body.at(-1).id);
    assert.equal(input("承認済みの埋め込み").value, "public-guide");
    await click("プレビュー"); await settle();
    canvas = document.querySelector("iframe"); root = canvas.contentDocument.querySelector('[data-nw-embed="blank"]');
    assert.equal(root.querySelector("iframe").getAttribute("src"), "https://embed.example.test/public/guide");
    assert.equal(root.querySelector("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(root.querySelector('[data-nw-blank-fallback]').getAttribute("href"), "https://embed.example.test/public/guide");
  } finally { await app.cleanup(); }
});
test("Basic のフォーム一覧とインスペクタでフォーム項目を編集し、既存フォームへ安全に追加できる", async () => {
  const app = await setup();
  const addPreset = async (id) => {
    await click("追加"); const target = document.querySelector(`.e-preset-preview[data-preset="${id}"]`)?.closest("button");
    assert.ok(target, id); await act(async () => target.click()); await flush();
  };
  try {
    await click("追加");
    const labels = [...document.querySelectorAll(".e-add-category .e-preset-card")].map((item) => item.textContent);
    for (const label of ["Form1", "Form2", "Form3", "Input", "Textarea", "Select", "Radio", "Confirm", "Checkbox", "File", "Submit", "Search", "Password"]) assert.ok(labels.some((text) => text.endsWith(label)), label);
    await addPreset("form-1");
    assert.ok(input("フォーム名")); assert.ok(document.body.textContent.includes("完了設定")); assert.ok(document.body.textContent.includes("項目一覧"));
    await change(input("フォーム名"), "contact_form");
    const formId = document.querySelector("iframe").contentDocument.querySelector("form[data-nw-node]").dataset.nwNode;
    await addPreset("form-input");
    assert.ok(input("項目名")); assert.equal(input("入力タイプ").value, "text");
    await change(input("項目名"), "company"); await change(input("入力タイプ"), "email"); await change(input("プレースホルダー"), "company@example.com");
    const required = [...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes("必須項目"))?.querySelector("input");
    await act(async () => required.click()); await flush(); await click("下書き保存");
    const form = app.stored().body.at(-1), controls = form.children.filter((node) => node.type === "element" && node.tag === "input");
    assert.equal(form.tag, "form"); assert.equal(form.attrs.name, "contact_form"); assert.equal(form.children.some((node) => node.type === "element" && node.tag === "form"), false);
    assert.ok(controls.some((control) => control.attrs.name === "company" && control.attrs.type === "email" && control.attrs.required === true && control.attrs.placeholder === "company@example.com"));
    await clickCanvas(formId);
    const itemButtons = [...document.querySelectorAll(".e-form-items button")];
    assert.equal(itemButtons.length, 4);
    await act(async () => itemButtons.find((item) => item.textContent.includes("company")).click()); await flush();
    assert.equal(input("項目名").value, "company");
  } finally { await app.cleanup(); }
});
test("host adapters receive only the documented editor target fields", async () => {
  const app = await setup(), target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
  try {
    assert.deepEqual(app.calls.reads[0], target);
    await change(input("ページタイトル"), "変更したタイトル"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].target, target);
    await click("公開"); assert.deepEqual(app.calls.prepares[0].target, target);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開"); assert.deepEqual(app.calls.releases[0].target, target);
  } finally { await app.cleanup(); }
});
test("read-only documents stay selectable and navigable but block every document write path", async () => {
  const recoveryCalls = { read: 0, write: 0, remove: 0 }, recovery = {
    read: async () => { recoveryCalls.read++; return null; }, write: async () => { recoveryCalls.write++; }, remove: async () => { recoveryCalls.remove++; }
  };
  const revision = { id: "rev-one", revision: 1, kind: "draft", createdAt: "2026-10-21T00:00:00.000Z" };
  const readOnly = { reason: "公開テキストの原文は業務編集画面が正本です。", editUrl: "/staff/business/public-text/home", editLabel: "業務原稿を編集" };
  const app = await setup({ readOnly, props: { recovery }, adapter: {
    preparePageChange: async () => { throw new Error("must not prepare"); }, applyPageChange: async () => { throw new Error("must not apply"); },
    listRevisions: async () => ({ entries: [revision] }), readRevision: async () => ({ document: structuredClone(fixture) }),
    createSnapshot: async () => { throw new Error("must not snapshot"); }
  } });
  try {
    assert.ok(document.body.textContent.includes("原文（読み取り専用）")); assert.ok(document.body.textContent.includes(readOnly.reason));
    const canonical = [...document.querySelectorAll("a")].find((node) => node.textContent === "業務原稿を編集"); assert.equal(canonical?.getAttribute("href"), readOnly.editUrl);
    assert.equal(input("ページタイトル").disabled, true); assert.equal(button("下書き保存").disabled, true); assert.equal(button("公開").disabled, true);
    const openTool = async (name) => { const target = [...document.querySelectorAll(".e-tools button")].find((node) => node.querySelector("small")?.textContent === name); assert.ok(target); await act(async () => target.click()); await flush(); };
    await openTool("レイヤー"); const heading = await layerById("heading"); assert.equal(heading.disabled, false); await act(async () => heading.click()); await flush(); assert.equal(input("テキスト").disabled, true);
    await openTool("ページ"); assert.equal(document.querySelector('button[aria-label="ページを追加"]').disabled, true); assert.equal(document.querySelector('button[aria-label="ホーム の操作"]').disabled, true);
    await click("履歴"); await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent.includes("2026/10/21"))?.click()); await flush();
    assert.equal(button("この版を復元").disabled, true); assert.ok(document.body.textContent.includes(readOnly.reason));
    assert.deepEqual(recoveryCalls, { read: 0, write: 0, remove: 0 }); assert.equal(app.calls.saves.length, 0); assert.equal(app.calls.prepares.length, 0);
  } finally { await app.cleanup(); }
});
test("invalid URL buffers stay visible, block saving, and can be cancelled", async () => {
  const app = await setup();
  try {
    await clickLayer("link"); await editorTab("設定"); await change(input("リンク先 URL"), "javascript:alert(1)");
    assert.equal(input("リンク先 URL").value, "javascript:alert(1)");
    assert.ok(document.body.textContent.includes("文書のルールに合いません"));
    assert.equal(button("下書き保存").disabled, true);
    assert.equal(document.querySelector("iframe").contentDocument.querySelector("a").getAttribute("href"), "/about");
    await click("入力を取り消す"); assert.equal(input("リンク先 URL").value, "/about");
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});
test("409 and network failures retain edits, history and expectedVersion for retry", async () => {
  let mode = "conflict";
  const app = await setup({ save: async () => { if (mode === "throw") throw new Error("offline"); if (mode === "throw409") throw { status: 409 }; return mode === "conflict" ? { status: "conflict" } : { status: "saved", version: "v2", revision: 2 }; } });
  try {
    await clickLayer("heading"); await change(input("テキスト"), "失わない編集");
    await click("下書き保存"); assert.ok(document.body.textContent.includes("409")); assert.equal(input("テキスト").value, "失わない編集");
    mode = "throw"; await click("下書き保存"); assert.ok(document.body.textContent.includes("編集内容を保持しています"));
    mode = "throw409"; await click("下書き保存"); assert.ok(document.body.textContent.includes("409"));
    mode = "saved"; await click("下書き保存"); assert.equal(app.calls.saves.length, 4); assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1"));
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("in-flight save checkpoints the captured document without losing later edits", async () => {
  let finish; let saves = 0;
  const app = await setup({ save: () => ++saves === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ status: "saved", version: "v3", revision: 3 }) });
  try {
    await clickLayer("heading"); await change(input("テキスト"), "保存開始時"); await click("下書き保存");
    await change(input("テキスト"), "保存中に続けた編集");
    await act(async () => finish({ status: "saved", version: "v2", revision: 2 })); await flush();
    assert.equal(input("テキスト").value, "保存中に続けた編集"); assert.equal(button("下書き保存").disabled, false);
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, true);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, false);
    await click("下書き保存"); assert.equal(app.calls.saves[1].expectedVersion, "v2"); assert.equal(app.calls.saves[1].document.revision, 2); assert.equal(app.calls.saves[1].document.body[0].children[0].children[0].text, "保存中に続けた編集");
    assert.equal(button("下書き保存").disabled, true);
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, true);
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 3 }));
  } finally { await app.cleanup(); }
});
test("data-linked props show a lock reason while display props remain editable", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "表示名", count: 5 } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true }, count: { type: "number", required: true } }, lockedProps: { count: "外部データから取得します" }, component: ({ heading, count }) => createElement("p", null, `${heading}: ${count}`) } };
  const app = await setup({ document: doc, blocks });
  try {
    await clickLayer("notice"); await editorTab("設定"); assert.equal(input("count").disabled, true); assert.ok(document.body.textContent.includes("ロック: 外部データから取得します"));
    await change(input("heading"), "編集後の表示名"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).props, { heading: "編集後の表示名", count: 5 });
  } finally { await app.cleanup(); }
});
test("host can hide business block insertion while retaining existing block editing", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "Before" } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("p", null, heading) } };
  const app = await setup({ document: doc, blocks, insertableBlocks: [] });
  try {
    assert.equal(document.querySelector('select[aria-label="追加する要素"] option[value="block:Notice"]'), null);
    await clickLayer("notice"); await editorTab("設定"); await change(input("heading"), "After"); await click("下書き保存");
    assert.equal(app.calls.saves[0].document.body.at(-1).props.heading, "After");
  } finally { await app.cleanup(); }
});
test("publishing and rollback require the allowed domain, authoritative diff and explicit confirmation", async () => {
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId, locale: target.locale }, version: "v1",
    publishedSiteStylesVersion: "published-styles-v1", sitePublicationEpoch: "epoch-v1", releases: [{ revision: 1, label: "最初の公開" }] }) } });
  try {
    await click("公開"); assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(document.body.textContent.includes("https://example.test")); assert.ok(document.body.textContent.includes("現在の見出し"));
    assert.equal(button("この内容を公開").disabled, true); assert.equal(app.calls.releases.length, 0);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開"); assert.equal(app.calls.releases[0].confirmationToken, "reviewed-token");
    assert.equal(app.calls.releases[0].expectedVersion, "v1");
    assert.deepEqual(app.calls.prepares[0].siteStylesRevision, { stage: "published", version: "published-styles-v1" });
    assert.equal(app.calls.prepares[0].sitePublicationEpoch, "epoch-v1");
    assert.deepEqual(app.calls.releases[0].siteStylesRevision, { stage: "published", version: "published-styles-v1" });
    assert.equal(app.calls.releases[0].sitePublicationEpoch, "epoch-v1");
  } finally { await app.cleanup(); }
  const invalid = await setup({ domain: "https://other.example" });
  try { await click("公開"); assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(invalid.calls.releases.length, 0); } finally { await invalid.cleanup(); }
});
test("publish confirmation fails closed when the published site-style fence is incomplete", async () => {
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId, locale: target.locale }, version: "v1",
    publishedSiteStylesVersion: "published-styles-v1", releases: [{ revision: 1, label: "最初の公開" }] }) } });
  try {
    await click("公開");
    assert.equal(app.calls.prepares.length, 0);
    assert.ok(document.body.textContent.includes("サイト共通スタイルの公開版を確認できません"));
  } finally { await app.cleanup(); }
});
test("a successful page publication refreshes its site epoch before the next plan", async () => {
  let publication = { stylesVersion: "published-v1", epoch: "epoch-1" };
  const app = await setup({ adapter: {
    readSiteSettings: async () => ({ settings: { title: "デモサイト", description: "説明", locale: "ja" }, version: "draft-v1" }),
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), ...target }, version: "v1",
      publishedSiteStylesVersion: publication.stylesVersion, sitePublicationEpoch: publication.epoch, releases: [{ revision: 1, label: "最初の公開" }] }),
    release: async () => {
      const previous = publication;
      publication = { stylesVersion: "published-v2", epoch: "epoch-2" };
      return { status: "released", snapshot: { document: { ...structuredClone(fixture), siteId: "demo", pageId: "home", locale: "ja-JP" }, version: "released-v2",
        publishedSiteStylesVersion: previous.stylesVersion, sitePublicationEpoch: previous.epoch } };
    }
  } });
  try {
    await click("公開");
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開");
    await settle();
    await click("公開");
    assert.deepEqual(app.calls.prepares.at(-1).siteStylesRevision, { stage: "published", version: "published-v2" });
    assert.equal(app.calls.prepares.at(-1).sitePublicationEpoch, "epoch-2");
  } finally { await app.cleanup(); }
});
test("dirty navigation requires explicit discard and can keep editing", async () => {
  const app = await setup();
  try {
    await change(input("ページタイトル"), "変更したタイトル");
    await clickPage("別ページ");
    assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける"); assert.equal(input("ページタイトル").value, "変更したタイトル");
    await clickPage("別ページ"); await click("変更を破棄して移動");
    assert.equal(pageRow("別ページ").getAttribute("aria-current"), "page"); assert.equal(app.calls.reads.at(-1).pageId, "other"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("rollback uses its own confirmation bound to the selected published revision", async () => {
  const app = await setup();
  try {
    await change(document.querySelector('[aria-label="戻す版"]'), "1"); await click("戻す内容を確認");
    assert.equal(app.calls.prepares[0].action, "rollback"); assert.equal(app.calls.prepares[0].revision, 1);
    assert.equal(button("この版に戻す").disabled, true);
    assert.ok(!document.querySelector('[role="dialog"]').textContent.includes("検索結果に出る情報"));
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click()); await click("この版に戻す");
    assert.equal(app.calls.releases[0].action, "rollback"); assert.equal(app.calls.releases[0].revision, 1);
  } finally { await app.cleanup(); }
});
test("discarding a pending invalid buffer resets fields even when the loaded value is unchanged", async () => {
  const app = await setup();
  try {
    await change(input("ページタイトル"), ""); assert.equal(input("ページタイトル").value, "");
    await clickPage("別ページ"); await click("変更を破棄して移動");
    assert.equal(input("ページタイトル").value, fixture.title); assert.equal(button("公開").disabled, false);
  } finally { await app.cleanup(); }
});
test("invalid saved revision responses retain edits and do not advance the optimistic lock", async () => {
  let invalidRevision = 1;
  const app = await setup({ save: async () => ({ status: "saved", version: "v2", revision: invalidRevision }) });
  try {
    await change(input("ページタイトル"), "保持する編集"); await click("下書き保存");
    assert.equal(input("ページタイトル").value, "保持する編集"); assert.equal(button("下書き保存").disabled, false);
    invalidRevision = 2; await click("下書き保存");
    assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1" && request.document.revision === 1));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});

const sitePages = () => [
  { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
  { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about" },
  { siteId: "demo", pageId: "badminton", locale: "ja-JP", title: "バドミントン", path: "/circles/badminton" },
  { siteId: "demo", pageId: "go", locale: "ja-JP", title: "囲碁", path: "/circles/kamakura-go", visibility: "private" },
  { siteId: "demo", pageId: "experience", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template" },
  { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared" }
];
/** ページ操作とサイト設定を実装したホスト。 */
function pageHost(overrides = {}) {
  const calls = { lists: 0, prepares: [], applies: [], settingsReads: 0, settingsSaves: [] };
  let pages = sitePages(), settings = { title: "デモサイト", description: "サイトの説明", locale: "ja" }, settingsVersion = 1;
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"], structuredData: [{ id: "organization", label: "組織", description: "運営者の名前とロゴ" }] }, { id: "second", name: "別サイト", domains: ["https://second.example.test"] }],
    listPages: async (siteId) => { calls.lists++; return siteId === "demo" ? structuredClone(pages) : [{ siteId, pageId: "home", locale: "ja-JP", title: "別のホーム", path: "/" }]; },
    preparePageChange: async (change) => {
      calls.prepares.push(structuredClone(change));
      return overrides.prepare?.(change) ?? { change, confirmationToken: "page-token", domain: "https://example.test", impact: { before: "https://example.test/about", after: "https://example.test/company",
        redirect: { from: "https://example.test/about", to: "https://example.test/company" }, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 2 }], navigation: ["ヘッダー"], notes: ["sitemap の URL が変わります。"] } };
    },
    applyPageChange: async (plan) => {
      calls.applies.push(structuredClone(plan));
      if (overrides.apply) return overrides.apply(plan);
      pages = pages.map((page) => page.pageId === plan.change.target.pageId ? { ...page, title: plan.change.title, path: plan.change.path } : page);
      return { status: "applied", page: pages.find((page) => page.pageId === plan.change.target.pageId) };
    },
    readSiteSettings: async () => { calls.settingsReads++; return { settings: structuredClone(settings), version: `s${settingsVersion}` }; },
    saveSiteSettings: async (request) => {
      calls.settingsSaves.push(structuredClone(request));
      if (overrides.saveSettings) return overrides.saveSettings(request);
      if (request.expectedVersion !== `s${settingsVersion}`) return { status: "conflict" };
      settings = request.settings; settingsVersion++; return { status: "saved", version: `s${settingsVersion}` };
    }
  };
  return { calls, adapter, setSettings: (next) => { settings = next; settingsVersion++; } };
}
const dialog = () => document.querySelector('[role="dialog"]');
/** 右レールの対象セレクタから「ページ」「サイト」を開き、その内容を返す。 */
async function panel(name) {
  const select = document.querySelector('.e-inspector-context select[aria-label="編集する対象"]');
  assert.ok(select, name); await change(select, name === "ページ" ? "page" : "site");
  return document.querySelector(".e-right .e-inspector-content");
}
const inputIn = (root, text) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
const buttonIn = (root, text) => [...root.querySelectorAll("button")].find((node) => node.textContent === text);
async function press(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
const treeShape = (list = document.querySelector(".e-page-tree")) => [...list.children].map((item) => {
  const folder = item.querySelector(":scope > .e-folder");
  return folder ? { [folder.textContent]: treeShape(item.querySelector(":scope > ul")) } : item.querySelector(".e-page-name").textContent;
});

test("page panel shows the path tree, kinds, states and counts, and selecting a row loads that page", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    assert.equal(document.querySelector('[aria-label="ページ"]')?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(treeShape(), ["ホーム", "私たちについて", { circles: ["バドミントン", "囲碁"] }], "templates leave the path tree");
    assert.equal(pageRow("ホーム").getAttribute("aria-current"), "page"); assert.ok(pageRow("ホーム").textContent.includes("/"));
    // 状態は札ではなく右端の点（緑＝公開中・輪郭＝非公開）とそのツールチップ・読み上げで示す。
    assert.ok(pageRow("囲碁").textContent.includes("/circles/kamakura-go")); assert.equal(pageRow("囲碁").textContent.includes("非公開"), false, "no text badge");
    assert.equal(document.querySelector(".e-page .e-badge"), null, "page rows carry no badge");
    assert.equal(pageRow("囲碁").querySelector(".e-page-state").className, "e-page-state is-private"); assert.equal(pageRow("囲碁").querySelector(".e-page-state").getAttribute("aria-label"), "非公開");
    assert.equal(pageRow("囲碁").querySelector(".e-page-state").title, "非公開");
    assert.equal(pageRow("ホーム").querySelector(".e-page-state").className, "e-page-state is-live"); assert.equal(pageRow("ホーム").querySelector(".e-page-state").getAttribute("aria-label"), "公開中");
    // テンプレートは「テンプレート」の見出しの下（パスの階層には入れない）。
    const templates = document.querySelector(".e-page-section"); assert.equal(templates.querySelector("h3").textContent, "テンプレート");
    assert.deepEqual(treeShape(templates.querySelector(".e-page-templates")), ["体験詳細"]); assert.ok(templates.contains(pageRow("体験詳細"))); assert.ok(pageRow("体験詳細").textContent.includes("/experiences/[slug]"));
    assert.equal(document.querySelector(".e-page-templates .e-folder"), null); assert.equal(pageRow("ヘッダー"), undefined);
    assert.ok(document.body.textContent.includes("公開中 3 / 4 ページ"));
    assert.equal(document.querySelector('[aria-label="体験詳細 の操作"]'), null); assert.equal(document.querySelector('[aria-label="ヘッダー の操作"]'), null);
    assert.ok(document.querySelector('[aria-label="私たちについて の操作"]'));
    const folder = [...document.querySelectorAll(".e-folder")].find((node) => node.textContent === "circles");
    assert.equal(folder.getAttribute("aria-expanded"), "true"); await press(folder);
    assert.equal(folder.getAttribute("aria-expanded"), "false"); assert.equal(pageRow("バドミントン"), undefined); await press(folder);
    await clickPage("私たちについて");
    assert.deepEqual(app.calls.reads.at(-1), { siteId: "demo", pageId: "about", locale: "ja-JP" }); assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page");
    await press(document.querySelector('[aria-label="検索"]'));
    await change(document.querySelector('input[aria-label="ページを検索"]'), "circles");
    assert.deepEqual(treeShape(), ["バドミントン", "囲碁"]); assert.equal(document.querySelector(".e-page-section"), null, "no template matches circles");
    await change(document.querySelector('input[aria-label="ページを検索"]'), "slug");
    assert.equal(document.querySelector(".e-page-tree:not(.e-page-templates)"), null); assert.deepEqual(treeShape(document.querySelector(".e-page-templates")), ["体験詳細"], "search also filters the template section");
    await change(document.querySelector('input[aria-label="ページを検索"]'), "存在しない");
    assert.ok(document.body.textContent.includes("一致するページはありません")); assert.equal(document.querySelector(".e-page-section"), null);
    await press(document.querySelector('[aria-label="検索"]')); assert.equal(document.querySelector('input[aria-label="ページを検索"]'), null);
    assert.equal(treeShape().length, 3); assert.ok(document.querySelector(".e-page-section"));
  } finally { await app.cleanup(); }
});

test("host publication notes replace the generic unpublished badge in the page list, page settings and site components", async () => {
  const preview = { label: "プレビューのみ", description: "公開サイトは移行前の表示のままです。ここで編集しても公開サイトには出ません。" };
  const partial = { label: "一部で公開中", description: "新しい表示で公開中の 1 ページにだけ出ます。" };
  const app = await setup({ adapter: { listPages: async () => [
    { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
    { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about", published: false, publication: preview },
    { siteId: "demo", pageId: "draft", locale: "ja-JP", title: "準備中", path: "/draft", published: false },
    { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared", publication: partial }
  ] } });
  try {
    // ホストの label と description は点のツールチップ・読み上げに回り、行には文字の札を出さない。
    const dot = (title) => pageRow(title).querySelector(".e-page-state");
    assert.equal(dot("私たちについて").className, "e-page-state is-unpublished"); assert.equal(dot("私たちについて").getAttribute("aria-label"), `${preview.label}：${preview.description}`);
    assert.equal(dot("私たちについて").title, `${preview.label}：${preview.description}`);
    assert.equal(pageRow("私たちについて").querySelector(".e-badge, .e-badge-publication"), null); assert.ok(!pageRow("私たちについて").textContent.includes("プレビューのみ"));
    assert.ok(!pageRow("私たちについて").textContent.includes("未公開"));
    assert.ok(pageRow("私たちについて").title.includes(preview.description));
    assert.equal(pageRow("私たちについて").querySelector(".e-page-label > .e-page-name").textContent, "私たちについて");
    assert.deepEqual([...pageRow("私たちについて").querySelectorAll(".e-page-label > .e-page-path")].map((node) => node.textContent), ["/about"]);
    assert.equal(dot("準備中").className, "e-page-state is-unpublished"); assert.equal(dot("準備中").getAttribute("aria-label"), "未公開"); assert.ok(!pageRow("準備中").textContent.includes("未公開"));
    assert.equal(dot("ホーム").className, "e-page-state is-live"); assert.equal(pageRow("ホーム").querySelector(".e-badge-publication"), null);
    assert.ok(document.body.textContent.includes("公開中 1 / 3 ページ"));
    await clickPage("私たちについて");
    const settings = await panel("ページ");
    const state = [...settings.querySelectorAll(".e-rows > div")].find((row) => row.querySelector("dt")?.textContent === "公開状態");
    assert.equal(state?.querySelector("dd")?.textContent, `${preview.label}${preview.description}`);
    await click("コンポーネント");
    const card = document.querySelector('.e-site-component[aria-label="ヘッダー"]');
    assert.equal(card?.querySelector(".e-badge-publication")?.textContent, partial.label);
    assert.ok(card?.textContent.includes(`サイト共通。${partial.description}`));
  } finally { await app.cleanup(); }
});

test("multi-page release selects only pages with changes and can resume from the saved operation status", async () => {
  const pages = [
    { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", kind: "page" },
    { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", kind: "page" },
    { siteId: "demo", pageId: "contact", locale: "ja-JP", title: "お問い合わせ", kind: "page" }
  ];
  const absent = await setup();
  try { assert.equal(document.querySelector(".e-page-release-select"), null, "hosts without the optional methods do not show multi-page controls"); }
  finally { await absent.cleanup(); }

  let plannedItems, plannedPageRequests = [], applied = 0, statusReads = 0, siteSettingsReads = 0, publishedStylesVersion = "s-initial", sitePublicationEpoch = "epoch-demo", operationId;
  const app = await setup({ adapter: {
    listPages: async () => pages,
    readSiteSettings: async () => { siteSettingsReads++; return { settings: { title: "デモサイト", description: "サイトの説明", locale: "ja" }, version: "draft-styles-v1" }; },
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), ...target }, version: `v-${target.pageId}`, publishedSiteStylesVersion: publishedStylesVersion, sitePublicationEpoch, presentation: { version: `p-${target.pageId}` }, hasSavedDraft: true }),
    prepareRelease: async (request) => { plannedPageRequests.push(structuredClone(request)); return { ...request, confirmationToken: `single-${request.target.pageId}`, domain: "https://example.test",
      changes: request.target.pageId === "about" ? [] : [{ path: "title", before: "旧タイトル", after: request.target.pageId === "home" ? "ホーム更新" : "お問い合わせ更新" }] }; },
    prepareReleaseSet: async (items) => {
      plannedItems = structuredClone(items); operationId = "550e8400-e29b-41d4-a716-446655440000";
      return { siteId: "demo", operationId, confirmationToken: "set-token", domain: "https://example.test", sitePublicationEpoch: "epoch-demo", items: structuredClone(items) };
    },
    releaseSet: async (plan) => {
      assert.equal(plan.sitePublicationEpoch, "epoch-demo");
      applied++;
      publishedStylesVersion = "s-after-partial"; sitePublicationEpoch = "epoch-2";
      return { status: "publishing", operationId: plan.operationId, items: plan.items.map((item, index) => index === 0
        ? { target: item.target, status: "released", version: "released-home" } : { target: item.target, status: "pending" }) };
    },
    releaseSetStatus: async (id) => {
      statusReads++; assert.equal(id, operationId);
      publishedStylesVersion = "s-after-completion"; sitePublicationEpoch = "epoch-3";
      return { status: "completed", operationId: id, httpStatus: 200, result: { status: "completed", operationId: id,
        items: plannedItems.map((item, index) => ({ target: item.target, status: "released", version: `released-${index}` })) } };
    }
  } });
  try {
    for (const title of ["ホーム", "私たちについて", "お問い合わせ"]) {
      const checkbox = document.querySelector(`[aria-label="「${title}」を一括公開の対象にする"]`); assert.ok(checkbox, title);
      await press(checkbox);
    }
    await click("選択したページの変更を確認");
    const confirmation = document.querySelector('[role="dialog"]'); assert.ok(confirmation);
    assert.ok(confirmation.textContent.includes("https://example.test"), `the release destination is visible before confirmation: ${confirmation.textContent}`);
    assert.match(confirmation.textContent, /差分がある 2 ページ/u);
    assert.ok(confirmation.textContent.includes("ホーム")); assert.ok(confirmation.textContent.includes("お問い合わせ"));
    assert.ok(!confirmation.textContent.includes("私たちについて"), "unchanged pages are excluded");
    assert.deepEqual(plannedItems.map((item) => item.target.pageId), ["home", "contact"]);
    assert.deepEqual(plannedItems.map((item) => item.presentationVersion), ["p-home", "p-contact"]);
    assert.deepEqual(plannedItems.map((item) => item.stylesVersion), ["s-initial", "s-initial"]);
    assert.equal(plannedPageRequests.length, 3);
    assert.ok(plannedPageRequests.every((request) => request.sitePublicationEpoch === "epoch-demo" && request.siteStylesRevision.stage === "published"));
    const consent = confirmation.querySelector(".e-release-set-confirm input"); await press(consent);
    await click("2 ページを公開");
    assert.equal(applied, 1); assert.match(document.querySelector('[role="dialog"]').textContent, /ページは処理待ち/u);
    await settle();
    assert.equal(siteSettingsReads >= 3, true, "the partial result refreshes site settings");
    await click("状態を確認");
    assert.equal(statusReads, 1); assert.equal(document.querySelector('[role="dialog"]').textContent.includes("公開済み"), true);
    await settle();
    assert.equal(siteSettingsReads >= 4, true, "each publish result refreshes site settings");
    await click("ページ一覧に戻る"); assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await app.cleanup(); }
});

test("multi-page release rejects a host plan outside the confirmed site, destination, targets, or versions", async () => {
  const invalidPlans = [
    (plan) => ({ ...plan, siteId: "another-site" }),
    (plan) => ({ ...plan, domain: "https://untrusted.example" }),
    (plan) => ({ ...plan, items: plan.items.map((item, index) => index ? item : { ...item, target: { ...item.target, pageId: "unreviewed" } }) }),
    (plan) => ({ ...plan, items: plan.items.map((item, index) => index ? item : { ...item, expectedVersion: "different-version" }) })
  ];
  for (const corrupt of invalidPlans) {
    let applied = 0;
    const app = await setup({ adapter: {
      prepareReleaseSet: async (items) => corrupt({ siteId: "demo", operationId: "550e8400-e29b-41d4-a716-446655440000",
        confirmationToken: "set-token", domain: "https://example.test", items: structuredClone(items) }),
      releaseSet: async () => { applied++; return { status: "conflict" }; },
      releaseSetStatus: async (operationId) => ({ status: "unknown", operationId })
    } });
    try {
      for (const title of ["ホーム", "別ページ"]) {
        const checkbox = document.querySelector(`[aria-label="「${title}」を一括公開の対象にする"]`); assert.ok(checkbox, title);
        await press(checkbox);
      }
      await click("選択したページの変更を確認");
      const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
      assert.ok(dialog.querySelector('[role="alert"]'), dialog.textContent);
      assert.equal(dialog.querySelector(".e-release-set-confirm"), null, "an unchecked plan must not reach user confirmation");
      assert.equal(applied, 0);
    } finally { await app.cleanup(); }
  }
});

test("page status maps visibility, published and the host publication to a dot and its words", async () => {
  const { pageStatus } = await import("../dist/editor-pages.js");
  const base = { siteId: "demo", pageId: "p", locale: "ja-JP", title: "P" };
  assert.deepEqual(pageStatus(base), { state: "live", text: "公開中" });
  assert.deepEqual(pageStatus({ ...base, published: false }), { state: "unpublished", text: "未公開" });
  assert.deepEqual(pageStatus({ ...base, visibility: "private" }), { state: "private", text: "非公開" });
  const preview = { label: "プレビューのみ", description: "公開サイトは移行前のままです。" };
  assert.deepEqual(pageStatus({ ...base, published: false, publication: preview }), { state: "unpublished", text: "プレビューのみ：公開サイトは移行前のままです。" });
  assert.deepEqual(pageStatus({ ...base, publication: { label: "公開中", description: "保存・公開した内容は反映されます。" } }), { state: "live", text: "公開中：保存・公開した内容は反映されます。" });
  assert.deepEqual(pageStatus({ ...base, visibility: "private", published: false, publication: preview }), { state: "private", text: "非公開 · プレビューのみ：公開サイトは移行前のままです。" });
});

test("public information edits are undoable document edits saved in meta", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const page = await panel("ページ");
    await change(inputIn(page, "説明文"), "海のそばの暮らしを\n紹介します。");
    assert.equal(document.querySelector('[role="status"]').textContent, "未保存の変更あり");
    assert.ok(page.textContent.includes("16 / 500")); assert.ok(!page.textContent.includes("検索結果に表示される文章です。"), "説明文の欄は文字数だけを出す");
    assert.equal(buttonIn(page, "画像を選ぶ"), undefined); assert.equal(inputIn(page, "画像 URL").closest("details"), null);
    await change(inputIn(page, "画像 URL"), "javascript:alert(1)");
    assert.ok(page.textContent.includes("URL は https:// か / から始まる形式")); assert.equal(button("下書き保存").disabled, true);
    await change(inputIn(page, "画像 URL"), "/cover.jpg"); await change(inputIn(page, "画像の説明"), "海の写真");
    await act(async () => [...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("検索エンジンに表示しない")).querySelector("input").click()); await flush();
    await act(async () => [...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("組織")).querySelector("input").click()); await flush();
    assert.ok(!page.textContent.includes("検索結果での見え方"), "検索結果の見本は出さない");
    assert.equal(inputIn(page, "説明文").value, "海のそばの暮らしを 紹介します。");
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.meta, { description: "海のそばの暮らしを 紹介します。", ogImage: { src: "/cover.jpg", alt: "海の写真" }, noindex: true, structuredData: ["organization"] });
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    assert.equal([...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("組織")).querySelector("input").checked, false);
  } finally { await app.cleanup(); }
});

test("unsupported structured data stays visible and can be removed", async () => {
  const doc = { ...structuredClone(fixture), meta: { structuredData: ["event"] } };
  const host = pageHost(), app = await setup({ document: doc, adapter: host.adapter });
  try {
    const page = await panel("ページ"); assert.ok(page.textContent.includes("未対応: event"));
    await press(page.querySelector('[aria-label="event を外す"]'));
    await click("下書き保存"); assert.equal("meta" in app.calls.saves[0].document, false);
  } finally { await app.cleanup(); }
});

test("renaming a page validates input, reviews impact, applies the exact plan and reloads", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const trigger = document.querySelector('[aria-label="私たちについて の操作"]');
    await press(trigger);
    const menuItem = document.querySelector('[role="menuitem"]');
    assert.equal(await shortcut(menuItem, "Escape"), true);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await press(trigger);
    assert.ok(document.querySelector('[role="menu"]')); await press(button("名前とURLを変更"));
    assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて"); assert.equal(inputIn(dialog(), "URL パス").value, "/about");
    assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "URL パス"), "/About");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /半角英小文字/); assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "URL パス"), "/experiences/kayak");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /テンプレート「体験詳細」/);
    assert.equal(host.calls.prepares.length, 0);
    await change(inputIn(dialog(), "URL パス"), "/company"); assert.equal(dialog().querySelector('[role="alert"]'), null);
    await press(buttonIn(dialog(), "影響を確認"));
    assert.deepEqual(host.calls.prepares[0], { action: "update", target: { siteId: "demo", pageId: "about", locale: "ja-JP" }, title: "私たちについて", path: "/company" });
    const text = dialog().textContent;
    for (const expected of ["https://example.test", "https://example.test/about", "https://example.test/company", "ホーム · 2 件", "ヘッダー", "sitemap の URL が変わります。"]) assert.ok(text.includes(expected), expected);
    assert.equal(buttonIn(dialog(), "変更を反映").disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    const lists = host.calls.lists; await press(buttonIn(dialog(), "変更を反映"));
    assert.equal(host.calls.applies.length, 1);
    assert.deepEqual(host.calls.applies[0], { change: host.calls.prepares[0], confirmationToken: "page-token", domain: "https://example.test", impact: { before: "https://example.test/about", after: "https://example.test/company",
      redirect: { from: "https://example.test/about", to: "https://example.test/company" }, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 2 }], navigation: ["ヘッダー"], notes: ["sitemap の URL が変わります。"] } });
    assert.equal(dialog(), null); assert.equal(host.calls.lists, lists + 1);
    assert.ok(document.body.textContent.includes("ページ名とURLを変更しました。"));
    assert.deepEqual(app.calls.reads.at(-1), { siteId: "demo", pageId: "about", locale: "ja-JP" });
    assert.ok(pageRow("私たちについて").textContent.includes("/company")); assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page");
  } finally { await app.cleanup(); }
});

test("page edits stay disabled while the page list reloads after an applied change", async () => {
  const host = pageHost(), listPages = host.adapter.listPages;
  let waitForList = false, releaseList;
  const listGate = new Promise((resolve) => { releaseList = resolve; });
  host.adapter.listPages = async (...args) => {
    if (waitForList) { waitForList = false; await listGate; }
    return listPages(...args);
  };
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]'));
    await press(button("名前とURLを変更"));
    await change(inputIn(dialog(), "URL パス"), "/company");
    await press(buttonIn(dialog(), "影響を確認"));
    await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    waitForList = true;
    await press(buttonIn(dialog(), "変更を反映"));
    assert.equal(dialog(), null);
    assert.equal(input("ページタイトル").disabled, true);
    assert.equal(button("要素を追加").disabled, true);
    await act(async () => releaseList()); await flush();
    assert.equal(input("ページタイトル").disabled, false);
  } finally { releaseList(); await app.cleanup(); }
});

test("page change conflicts keep inputs and reload the list; unknown results are not retried", async () => {
  let mode = "conflict";
  const host = pageHost({ apply: async () => { if (mode === "throw") throw new Error("offline"); return { status: "conflict" }; } }), app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("複製"));
    assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて のコピー"); assert.equal(inputIn(dialog(), "URL パス").value, "/about-copy");
    await change(inputIn(dialog(), "URL パス"), "/company");
    await press(buttonIn(dialog(), "影響を確認")); await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    const lists = host.calls.lists; await press(buttonIn(dialog(), "変更を反映"));
    assert.ok(dialog()); assert.match(dialog().textContent, /競合しました（409）/);
    assert.equal(inputIn(dialog(), "URL パス").value, "/company"); assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて のコピー"); assert.equal(host.calls.lists, lists + 1);
    mode = "throw"; await press(buttonIn(dialog(), "影響を確認")); await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    await press(buttonIn(dialog(), "変更を反映"));
    assert.match(dialog().textContent, /反映されたか確認できません/); assert.equal(buttonIn(dialog(), "変更を反映"), undefined);
    const reads = app.calls.reads.length; await press(buttonIn(dialog(), "ページ一覧を再読込"));
    assert.equal(dialog(), null); assert.equal(app.calls.reads.length, reads + 1); assert.equal(host.calls.applies.length, 2);
  } finally { await app.cleanup(); }
});

test("page management prepare conflicts reload the catalog before another review", async () => {
  let conflict = true;
  const host = pageHost({ prepare: (change) => {
    if (conflict) { const error = new Error("version conflict"); error.status = 409; throw error; }
    return { change, confirmationToken: "page-token", domain: "https://example.test", impact: { linkedFrom: [], navigation: [], notes: [] } };
  } });
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("名前とURLを変更"));
    await change(inputIn(dialog(), "URL パス"), "/company");
    const lists = host.calls.lists;
    await press(buttonIn(dialog(), "影響を確認")); await flush();
    assert.match(dialog().textContent, /競合しました（409）/);
    assert.match(dialog().textContent, /ページ一覧を再読込しました/u);
    assert.equal(host.calls.lists, lists + 1);
    assert.ok(buttonIn(dialog(), "影響を確認"), "the user can review again against the refreshed catalog");
    conflict = false;
    await press(buttonIn(dialog(), "影響を確認")); await flush();
    assert.ok(dialog().textContent.includes("変更の影響を確認"));
  } finally { await app.cleanup(); }
});

test("invalid plans and private changes use their own confirmation", async () => {
  let domain = "https://evil.example.test";
  const host = pageHost({ prepare: (change) => ({ change, confirmationToken: "t", domain, impact: { before: `${domain}/about`, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 1 }], navigation: [], notes: [] } }),
    apply: async (plan) => ({ status: "applied", page: { ...sitePages()[1], visibility: plan.change.visibility } }) });
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("非公開にする"));
    assert.ok(dialog().textContent.includes("公開中のURLは表示されなくなり")); await press(buttonIn(dialog(), "影響を確認"));
    assert.match(dialog().textContent, /影響を確認できませんでした/); assert.ok(buttonIn(dialog(), "影響を確認"));
    domain = "https://example.test"; await press(buttonIn(dialog(), "影響を確認"));
    assert.ok(dialog().textContent.includes("公開サイトに表示されなくなります")); assert.ok(dialog().textContent.includes("ホーム · 1 件"));
    const confirm = [...dialog().querySelectorAll("button")].find((node) => node.textContent === "非公開にする");
    assert.ok(confirm.className.includes("e-danger-primary")); assert.equal(confirm.disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click()); await press(confirm);
    assert.deepEqual(host.calls.applies[0].change, { action: "visibility", target: { siteId: "demo", pageId: "about", locale: "ja-JP" }, visibility: "private" });
    assert.ok(document.body.textContent.includes("ページを非公開にしました。"));
  } finally { await app.cleanup(); }
});

test("page operations wait for unsaved edits and the page tab switch opens the visibility dialog", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const page = await panel("ページ"), toggle = page.querySelector('[role="switch"]');
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await change(input("ページタイトル"), "未保存のタイトル");
    assert.equal(document.querySelector('[aria-label="ページを追加"]').disabled, true); assert.equal(toggle.disabled, true);
    assert.equal(document.querySelector('[aria-label="私たちについて の操作"]').disabled, true);
    assert.ok(!document.body.textContent.includes("未保存の変更を保存してから操作できます。")); assert.equal(toggle.title, "保存してから変更できます");
    await click("下書き保存"); assert.equal(toggle.disabled, false);
    await press(toggle); assert.equal(dialog().getAttribute("aria-label"), "ページを非公開にする");
    await act(async () => dialog().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await flush();
    assert.equal(dialog(), null);
    await press(document.querySelector('[aria-label="ページを追加"]'));
    assert.equal(inputIn(dialog(), "URL パス").value, "/new-page"); assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "ページ名"), "新しいページ"); assert.equal(buttonIn(dialog(), "影響を確認").disabled, false);
    await press(buttonIn(dialog(), "影響を確認"));
    assert.deepEqual(host.calls.prepares[0], { action: "create", siteId: "demo", locale: "ja-JP", title: "新しいページ", path: "/new-page" });
  } finally { await app.cleanup(); }
  const legacy = await setup();
  try {
    assert.equal(document.querySelector('[aria-label="ページを追加"]'), null); assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(document.querySelector('[aria-label="ホーム の操作"]'), null);
    assert.ok((await panel("サイト")).textContent.includes("このサイトではサイト設定を編集できません。"));
  } finally { await legacy.cleanup(); }
});

test("site settings load, save with the optimistic version, keep input on 409 and guard site switching", async () => {
  let mode = "normal";
  const host = pageHost({ saveSettings: (request) => mode === "conflict" ? { status: "conflict" } : mode === "throw" ? Promise.reject(new Error("offline")) : { status: "saved", version: `s-${request.expectedVersion}-next` } });
  const app = await setup({ adapter: host.adapter });
  try {
    const site = await panel("サイト"); assert.equal(document.querySelector(".e-page-settings"), null);
    assert.ok(site.textContent.includes("https://example.test"));
    assert.equal(inputIn(site, "サイトタイトル").value, "デモサイト"); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    await change(inputIn(site, "言語"), "Japanese");
    assert.match(site.querySelector('[role="alert"]').textContent, /ja や ja-JP/); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    await change(inputIn(site, "言語"), "ja-JP"); await change(inputIn(site, "サイトタイトル"), "新しいサイト名");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[0], { siteId: "demo", settings: { title: "新しいサイト名", description: "サイトの説明", locale: "ja-JP" }, expectedVersion: "s1" });
    assert.ok(site.textContent.includes("サイト設定を保存しました。")); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    mode = "conflict"; await change(inputIn(site, "説明文"), "競合する説明"); await press(buttonIn(site, "サイト設定を保存"));
    assert.equal(host.calls.settingsSaves[1].expectedVersion, "s-s1-next");
    assert.ok(site.textContent.includes("サイト設定が競合しました（409）。入力を保持しています。")); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    mode = "throw"; await press(buttonIn(site, "サイト設定を保存"));
    assert.ok(site.textContent.includes("サイト設定を保存できませんでした。入力を保持しています。")); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    await change(document.querySelector('[aria-label="編集するサイト"]'), "second");
    assert.ok(dialog()); await click("編集を続ける"); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    mode = "conflict"; await press(buttonIn(site, "サイト設定を保存"));
    host.setSettings({ title: "他の人の変更", locale: "ja" });
    const reads = host.calls.settingsReads; await press(buttonIn(site, "最新の設定を読み込む（入力を破棄）"));
    assert.equal(host.calls.settingsReads, reads + 1); assert.equal(inputIn(site, "サイトタイトル").value, "他の人の変更"); assert.equal(inputIn(site, "説明文").value, "");
    await change(document.querySelector('[aria-label="編集するサイト"]'), "second"); assert.equal(dialog(), null);
  } finally { await app.cleanup(); }
});

test("site settings load failures can be retried", async () => {
  let fail = true;
  const host = pageHost(), read = host.adapter.readSiteSettings;
  host.adapter.readSiteSettings = async (...args) => { if (fail) throw new Error("offline"); return read(...args); };
  const app = await setup({ adapter: host.adapter });
  try {
    const site = await panel("サイト"); assert.ok(site.textContent.includes("サイト設定を読み込めませんでした。"));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("海のそばで過ごす"));
    assert.ok(document.body.textContent.includes("文書単体で編集を開始しました"));
    fail = false; await press(buttonIn(site, "再試行")); assert.equal(inputIn(site, "サイトタイトル").value, "デモサイト");
  } finally { await app.cleanup(); }
});

test("an invalid reload keeps the current session when site settings also fail", async () => {
  let invalid = false;
  const app = await setup({ adapter: {
    readDocument: async (target) => ({ document: invalid ? { ...structuredClone(fixture), siteId: target.siteId, pageId: target.pageId, body: [{ type: "element", id: "duplicate", tag: "div", children: [] }, { type: "element", id: "duplicate", tag: "div", children: [] }] } : { ...structuredClone(fixture), siteId: target.siteId, pageId: target.pageId }, version: "v1" }),
    readSiteSettings: async () => { throw new Error("offline"); }
  } });
  try {
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("海のそばで過ごす"));
    invalid = true; await clickPage("別ページ"); await settle();
    assert.ok(document.body.textContent.includes("現在の編集内容は保持されています"));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("海のそばで過ごす"));
  } finally { await app.cleanup(); }
});

test("release confirmation shows the public URL and the search result information", async () => {
  const doc = { ...structuredClone(fixture), meta: { description: "公開する説明文" } };
  const host = pageHost(), app = await setup({ document: doc, adapter: host.adapter });
  try {
    await click("公開");
    const text = dialog().textContent;
    for (const expected of ["公開URL", "https://example.test/", "検索結果に出る情報", fixture.title, "公開する説明文", "表示する", "現在の見出し"]) assert.ok(text.includes(expected), expected);
  } finally { await app.cleanup(); }
});

test("page switches reset uncontrolled canvas DOM state without replacing the iframe", async () => {
  const page = (pageId) => ({ ...structuredClone(fixture), pageId, body: [{ type: "element", id: "shared-details", tag: "details", children: [
    { type: "element", id: "shared-summary", tag: "summary", children: [{ type: "text", text: "ページ内容" }] },
    { type: "element", id: "shared-content", tag: "p", children: [{ type: "text", text: "同じIDの内容" }] }
  ] }] });
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: page(target.pageId), version: `v-${target.pageId}` }) } });
  try {
    const frame = document.querySelector("iframe"), body = canvasBody(), originalDetails = body.querySelector("details");
    assert.ok(originalDetails);
    originalDetails.open = true;
    await clickPage("別ページ");
    const currentDetails = canvasBody().querySelector("details");
    assert.equal(document.querySelector("iframe"), frame, "page changes keep the same iframe");
    assert.equal(canvasBody(), body, "the iframe document remains mounted");
    assert.equal(currentDetails, originalDetails, "matching nodes are reconciled instead of remounted");
    assert.equal(currentDetails.open, false, "the next page starts from its document state");
  } finally { await app.cleanup(); }
});

test("page switches reset uncontrolled form fields while reusing matching DOM nodes", async () => {
  const page = (pageId) => ({ ...structuredClone(fixture), pageId, body: [{ type: "element", id: "shared-form", tag: "form", attrs: { name: "contact" }, children: [
    { type: "element", id: "shared-input-label", tag: "label", attrs: { htmlFor: "shared-input-control" }, children: [{ type: "text", text: "名前" }] },
    { type: "element", id: "shared-input", tag: "input", attrs: { id: "shared-input-control", name: "name", type: "text", value: "initial" }, children: [] },
    { type: "element", id: "shared-checkbox-label", tag: "label", attrs: { htmlFor: "shared-checkbox-control" }, children: [{ type: "text", text: "通知を受け取る" }] },
    { type: "element", id: "shared-checkbox", tag: "input", attrs: { id: "shared-checkbox-control", name: "notify", type: "checkbox", checked: true }, children: [] },
    { type: "element", id: "shared-textarea-label", tag: "label", attrs: { htmlFor: "shared-textarea-control" }, children: [{ type: "text", text: "説明" }] },
    { type: "element", id: "shared-textarea", tag: "textarea", attrs: { id: "shared-textarea-control", name: "description" }, children: [{ type: "text", text: "saved" }] },
    { type: "element", id: "shared-select-label", tag: "label", attrs: { htmlFor: "shared-select-control" }, children: [{ type: "text", text: "分類" }] },
    { type: "element", id: "shared-select", tag: "select", attrs: { id: "shared-select-control", name: "category" }, children: [
      { type: "element", id: "shared-option-one", tag: "option", attrs: { value: "one", disabled: true }, children: [{ type: "text", text: "一" }] },
      { type: "element", id: "shared-option-two", tag: "option", attrs: { value: "two" }, children: [{ type: "text", text: "二" }] },
    ] },
  ] }] });
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: page(target.pageId), version: `v-${target.pageId}` }) } });
  try {
    const input = canvasBody().querySelector('input[type="text"]'), checkbox = canvasBody().querySelector('input[type="checkbox"]');
    const textarea = canvasBody().querySelector("textarea"), select = canvasBody().querySelector("select");
    assert.ok(input); assert.ok(checkbox); assert.ok(textarea); assert.ok(select);
    input.value = "typed"; checkbox.checked = false; textarea.value = "typed"; select.selectedIndex = 1;
    await clickPage("別ページ");
    assert.equal(canvasBody().querySelector("input"), input);
    assert.equal(canvasBody().querySelector("select"), select);
    assert.equal(canvasBody().querySelector("textarea"), textarea);
    assert.equal(input.value, "initial");
    assert.equal(checkbox.checked, true);
    assert.equal(textarea.value, "saved");
    assert.equal(select.selectedIndex, 1, "the first enabled option is selected");
  } finally { await app.cleanup(); }
});

test("page switches reset only nodes owned by the current page in a shared presentation", async () => {
  const page = (pageId) => ({ ...structuredClone(fixture), pageId, body: [
    { type: "element", id: "shared-form", tag: "form", attrs: { name: "contact" }, children: [
      { type: "element", id: "shared-select-label", tag: "label", attrs: { htmlFor: "category" }, children: [{ type: "text", text: "分類" }] },
      { type: "element", id: "shared-node-id", tag: "select", attrs: { id: "category", name: "category" }, children: [
        { type: "element", id: "shared-option-disabled", tag: "option", attrs: { value: "disabled", disabled: true }, children: [{ type: "text", text: "無効" }] },
        { type: "element", id: "shared-option-enabled", tag: "option", attrs: { value: "enabled" }, children: [{ type: "text", text: "有効" }] },
      ] },
    ] },
  ] });
  const shared = (pageId) => ({ ...structuredClone(fixture), pageId, body: [{ type: "element", id: "shared-node-id", tag: "div", children: [] }] });
  const presentation = { schemaVersion: 1, siteId: "demo", locale: "ja-JP", version: "presentation-v1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: shared("shared-header"), footer: shared("shared-footer") } };
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: page(target.pageId), version: "v-" + target.pageId, presentation }) } });
  try {
    const frame = document.querySelector("iframe");
    assert.ok(frame, document.querySelector(".e-notice")?.textContent);
    const select = frame.contentDocument.body.querySelector("select");
    assert.ok(select);
    select.selectedIndex = 0;
    await clickPage("別ページ");
    assert.equal(frame.contentDocument.body.querySelector("select"), select);
    assert.equal(select.selectedIndex, 1, "footer nodes with colliding IDs do not shadow page nodes");
  } finally { await app.cleanup(); }
});
