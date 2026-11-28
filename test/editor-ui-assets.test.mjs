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

test("canvas resize handle measures inline selections after layout without waiting for ResizeObserver", async () => {
  const previous = globalThis.ResizeObserver, observers = [];
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; this.target = null; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() {}
    deliver() { this.callback([{ target: this.target }], this); }
  }
  let app;
  globalThis.ResizeObserver = TestResizeObserver;
  try {
    const doc = structuredClone(fixture);
    doc.body = [
      { type: "element", id: "block", tag: "div", children: [{ type: "text", text: "Block" }] },
      { type: "element", id: "inline_link", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "Inline link" }] }
    ];
    app = await setup({ document: doc });
    const frame = document.querySelector("iframe"), scheduled = [];
    frame.contentWindow.requestAnimationFrame = (callback) => { scheduled.push(callback); return scheduled.length; };
    frame.contentWindow.cancelAnimationFrame = () => {};
    const block = canvasNode("block"), inline = canvasNode("inline_link");
    let blockReads = 0, inlineReads = 0;
    block.getBoundingClientRect = () => { blockReads++; return { left: 1, top: 2, width: 120, height: 60 }; };
    inline.getBoundingClientRect = () => { inlineReads++; return { left: 3, top: 4, width: 44, height: 18 }; };

    await clickCanvas("block");
    assert.ok(observers.some((entry) => entry.target === block), "the selected block is observed");
    assert.equal(blockReads, 0, "the block is not measured synchronously");
    assert.equal(scheduled.length, 1, "initial geometry is scheduled after layout");
    await act(async () => scheduled.shift()(0));
    await settle();
    assert.equal(frame.contentDocument.querySelector(".nw-resize-handle")?.title, "120 × 60 px");

    await clickCanvas("inline_link");
    assert.ok(observers.some((entry) => entry.target === inline), "the inline element is observed");
    assert.equal(inlineReads, 0, "the inline element is not measured synchronously");
    assert.equal(scheduled.length, 1, "inline geometry is scheduled even without an observer notification");
    await act(async () => scheduled.shift()(0));
    await settle();
    assert.equal(frame.contentDocument.querySelector(".nw-resize-handle")?.title, "44 × 18 px", "the handle follows the current inline selection");
  } finally {
    if (app) await app.cleanup();
    if (previous === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previous;
  }
});

test("canvas arrows reorder siblings in one history step while layer arrows move focus", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("lead");
    assert.ok(await shortcut(layerButton("lead"), "ArrowUp"));
    assert.equal(document.activeElement, layerButton("heading"));
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.ok(await shortcut(canvasBody(), "ArrowUp"));
    assert.deepEqual(canvasOrder("hero"), ["lead", "heading", "link"]);
    assert.ok(await shortcut(canvasBody(), "z", { metaKey: true }));
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.equal(button("元に戻す").disabled, true);
    assert.ok(await shortcut(canvasBody(), "ArrowDown"));
    assert.deepEqual(canvasOrder("hero"), ["heading", "link", "lead"]);
    assert.ok(await shortcut(canvasBody(), "z", { metaKey: true }));
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
  } finally { await app.cleanup(); }
});

test("Alt-drag duplicates and moves to another parent in one undo step", async () => {
  const page = structuredClone(fixture);
  page.body.push({ id: "destination", type: "element", tag: "section", children: [] });
  const app = await setup({ document: page });
  try {
    await clickCanvas("heading");
    const transfer = { setData() {} }, destination = canvasNode("destination");
    destination.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 100, width: 100, height: 100 });
    await dragEvent(canvasNode("heading"), "dragstart", transfer, { altKey: true });
    await dragEvent(destination, "dragover", transfer, { clientY: 50 });
    assert.equal(transfer.dropEffect, "copy");
    assert.equal(canvasNode("heading_copy1"), null);
    await dragEvent(destination, "drop", transfer, { clientY: 50 });
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.deepEqual(canvasOrder("destination"), ["heading_copy1"]);
    await click("元に戻す");
    assert.deepEqual(canvasOrder("destination"), []);
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.equal(button("元に戻す").disabled, true);
    await click("やり直す");
    assert.deepEqual(canvasOrder("destination"), ["heading_copy1"]);
  } finally { await app.cleanup(); }
});

test("spacing handles preview without history and commit only to the selected breakpoint", async () => {
  const app = await setup();
  try {
    await clickCanvas("hero"); await editorTab("ボックス"); await click("タブレット 768px〜");
    const canvas = canvasBody(), handle = (property) => canvas.querySelector(`[data-spacing="${property}"]`);
    const hero = canvasNode("hero"), originalStyle = hero.getAttribute("style");
    assert.ok(handle("paddingTop")); assert.ok(handle("gap"));
    await pointer(handle("paddingTop"), "pointerdown", 20);
    await pointer(handle("paddingTop"), "pointermove", 42);
    const preview = Number.parseFloat(hero.style.paddingTop);
    assert.ok(preview > 0);
    assert.equal(button("元に戻す").disabled, true);
    await pointer(handle("paddingTop"), "pointercancel", 42);
    assert.equal(hero.getAttribute("style"), originalStyle);
    await pointer(handle("paddingTop"), "pointerdown", 20);
    await pointer(handle("paddingTop"), "pointermove", 42);
    await pointer(handle("paddingTop"), "pointerup", 42);
    await click("下書き保存");
    const lastStyle = () => app.calls.saves.at(-1).document.body[0].style;
    assert.equal(lastStyle().base.paddingTop, undefined);
    assert.equal(lastStyle().responsive.find((entry) => entry.minWidth === 768).declarations.paddingTop, preview);
    await click("元に戻す");
    assert.equal(button("元に戻す").disabled, true);
    await pointer(handle("gap"), "pointerdown", 20);
    await pointer(handle("gap"), "pointermove", 30);
    await pointer(handle("gap"), "pointerup", 30);
    await click("下書き保存");
    assert.equal(lastStyle().base.gap, 16);
    const tablet = lastStyle().responsive.find((entry) => entry.minWidth === 768).declarations;
    assert.equal(tablet.gap, 26);
    assert.equal(tablet.paddingTop, undefined);
    await click("元に戻す");
    assert.equal(button("元に戻す").disabled, true);
  } finally { await app.cleanup(); }
});

test("spacing handles hide percent-based gaps instead of treating percentages as pixels", async () => {
  const page = structuredClone(fixture);
  page.body[0].style = { ...page.body[0].style, base: { ...page.body[0].style.base, display: "flex", gap: "10%" } };
  const app = await setup({ document: page });
  try {
    await clickCanvas("hero"); await editorTab("ボックス");
    const hero = canvasNode("hero"), computed = hero.ownerDocument.defaultView.getComputedStyle(hero);
    assert.equal(computed.gap, "var(--nw-Node-hero-base-gap)");
    assert.equal(hero.style.getPropertyValue("--nw-Node-hero-base-gap"), "10%");
    assert.equal(canvasBody().querySelector('[data-spacing="gap"]'), null);
  } finally { await app.cleanup(); }
});

test("spacing handles hide breakpoint properties protected by a specific style lock", async () => {
  const app = await setup({ locks: [{ nodeId: "hero", fields: ["style.responsive.paddingTop"], reason: "Tablet padding is host-managed" }] });
  try {
    await clickCanvas("hero"); await editorTab("ボックス"); await click("タブレット 768px〜");
    const canvas = canvasBody();
    assert.equal(canvas.querySelector('[data-spacing="paddingTop"]'), null);
    assert.ok(canvas.querySelector('[data-spacing="paddingRight"]'));
  } finally { await app.cleanup(); }
});

test("command palette searches layer names, full text and commands and guards unsaved navigation", async () => {
  const page = structuredClone(fixture);
  page.body[0].children[0].name = "メインタイトル";
  const app = await setup({ document: page });
  try {
    const search = () => commandDialog().querySelector('input[type="search"]');
    assert.ok(await shortcut(canvasBody(), "k", { metaKey: true }));
    assert.equal(document.activeElement, search());
    await change(search(), "メインタイトル");
    assert.ok(await shortcut(search(), "Enter"));
    assert.equal(commandDialog(), null);
    await click("コマンドパレット");
    await change(search(), "海のそばで過ごす");
    assert.match(commandDialog().querySelector('[aria-label="要素"]').textContent, /メインタイトル/u);
    assert.ok(await shortcut(search(), "Enter"));
    await click("コマンドパレット"); await change(search(), "複製");
    assert.match(commandDialog().querySelector("kbd").textContent, /⌘D/u);
    assert.ok(await shortcut(search(), "Enter"));
    assert.ok(canvasNode("heading_copy1"));
    await click("コマンドパレット"); await change(search(), "別ページ");
    assert.ok(await shortcut(search(), "Enter"));
    assert.ok(document.querySelector('[role="dialog"][aria-label="未保存の変更"]'));
    assert.equal(app.calls.reads.length, 1);
    await click("変更を破棄して移動");
    assert.equal(app.calls.reads.at(-1).pageId, "other");
  } finally { await app.cleanup(); }
});

test("locked and read-only values reject direct manipulation and palette edits", async () => {
  const cases = [{ locks: [{ nodeId: "hero", fields: ["*"], reason: "ホスト管理" }] }, { readOnly: { reason: "読み取り専用ページ" } }];
  for (const options of cases) {
    const app = await setup(options);
    try {
      await clickCanvas("lead");
      assert.equal(await shortcut(canvasBody(), "ArrowUp"), false);
      assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
      assert.equal(canvasBody().querySelector(".nw-spacing-handle"), null);
      const transfer = { setData() {} };
      await dragEvent(canvasNode("lead"), "dragstart", transfer, { altKey: true });
      await dragEvent(canvasNode("link"), "drop", transfer, { altKey: true });
      assert.equal(canvasNode("lead_copy1"), null);
      await click("コマンドパレット");
      const remove = [...commandDialog().querySelectorAll('section[aria-label="操作"] button')].find((item) => item.textContent.startsWith("削除"));
      assert.equal(remove.disabled, true);
      assert.ok(commandDialog().querySelector('section[aria-label="ページ"] button'));
      assert.equal(button("元に戻す").disabled, true);
    } finally { await app.cleanup(); }
  }
});

test("shortcut matrix shares structure and history across parent, iframe and layer focus", async () => {
  const app = await setup();
  try {
    await tool("レイヤー");
    const positions = [
      { name: "parent", target: () => document.body, command: { metaKey: true }, remove: "Delete" },
      { name: "iframe", target: canvasBody, command: { ctrlKey: true }, remove: "Backspace" },
      { name: "layer", target: () => layerButton("heading"), command: { metaKey: true }, remove: "Delete" },
    ];
    for (const { name, target, command, remove } of positions) {
      await clickLayer("heading");
      assert.ok(await shortcut(target(), "d", command), name);
      assert.ok(canvasNode("heading_copy1"), name);
      assert.ok(await shortcut(target(), "z", command), name);
      assert.equal(canvasNode("heading_copy1"), null, name);
      assert.equal(button("元に戻す").disabled, true, name);
      assert.ok(await shortcut(target(), "Z", { ...command, shiftKey: true }), name);
      assert.ok(canvasNode("heading_copy1"), name);
      assert.ok(await shortcut(target(), "z", command), name);
      assert.ok(await shortcut(target(), remove), name);
      assert.equal(canvasNode("heading"), null, name);
      assert.ok(await shortcut(document.body, "z", command), name);
      assert.ok(canvasNode("heading"), name);
      assert.equal(button("元に戻す").disabled, true, name);
    }
    assert.equal(await shortcut(canvasBody(), "d", { metaKey: true }), false, "no selected layer");
    assert.match(document.querySelector(".e-notice").textContent, /要素を選択/);
  } finally { await app.cleanup(); }
});

test("box grouping confirms layout changes and stays undoable and redoable", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("link");
    assert.ok(await shortcut(layerButton("link"), "g", { metaKey: true }));
    assert.match(document.querySelector('[role="dialog"]').textContent, /並び方や余白が変わる/u);
    await click("適用する");
    assert.ok(canvasNode("group_1"));
    assert.equal(canvasNode("link").parentElement.closest('[data-nw-node="group_1"]')?.getAttribute("data-nw-node"), "group_1");
    await click("元に戻す"); assert.equal(!!canvasNode("group_1"), false); assert.ok(canvasNode("link"));
    await click("やり直す"); assert.ok(canvasNode("group_1"));

    await clickLayer("group_1");
    assert.ok(await shortcut(layerButton("group_1"), "g", { metaKey: true, shiftKey: true }));
    assert.match(document.querySelector('[role="dialog"]').textContent, /並び方や余白が変わる/u);
    await click("適用する");
    assert.equal(!!canvasNode("group_1"), false); assert.ok(canvasNode("link"));
    await click("元に戻す"); assert.ok(canvasNode("group_1"));
    await click("やり直す"); assert.equal(!!canvasNode("group_1"), false);
  } finally { await app.cleanup(); }
});

test("shortcut matrix preserves focused fields, direct editing, IME and dialog controls", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("heading");
    for (const target of [document.body, canvasBody(), layerButton("heading")]) {
      assert.equal(await shortcut(target, "Delete", { isComposing: true }), false);
      assert.equal(await shortcut(target, "d", { ctrlKey: true, keyCode: 229 }), false);
    }
    const editable = document.createElement("div"); editable.setAttribute("contenteditable", "true");
    const richChild = document.createElement("span"); editable.append(richChild); canvasBody().append(editable);
    for (const target of [input("表示幅"), input("テキスト"), document.querySelector('select[aria-label="表示倍率"]'), richChild]) {
      assert.equal(await shortcut(target, "d", { ctrlKey: true }), false);
      assert.equal(await shortcut(target, "Delete"), false);
      assert.equal(await shortcut(target, "?", { shiftKey: true }), false);
      assert.equal(await shortcut(target, "ArrowDown"), false);
      assert.equal(await shortcut(target, "k", { metaKey: true }), false);
    }
    editable.remove();
    assert.ok(canvasNode("heading")); assert.equal(canvasNode("heading_copy1"), null);
    assert.ok(await shortcut(layerButton("heading"), "Escape"));
    assert.equal(layerButton("hero").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, layerButton("hero"));
    assert.ok(await shortcut(document.activeElement, "Enter"));
    assert.equal(layerButton("heading").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, layerButton("heading"));
    assert.ok(await shortcut(document.activeElement, "Enter"));
    const heading = canvasNode("heading");
    assert.equal(heading.contentEditable, "true");
    const original = heading.textContent; heading.textContent = "入力中";
    for (const target of [document.body, canvasBody(), layerButton("heading")]) {
      assert.equal(await shortcut(target, "Delete", {}, false), false);
      assert.match(document.querySelector(".e-notice").textContent, /入力を適用するか取り消して/);
    }
    assert.equal(await shortcut(heading, "Escape", { isComposing: true }), false);
    assert.equal(heading.textContent, "入力中");
    assert.ok(await shortcut(heading, "Escape"));
    assert.equal(canvasNode("heading").textContent, original, "Esc rebuilds the element from the draft"); assert.equal(canvasBody().querySelector(".nw-text-toolbar"), null);
    assert.equal(layerButton("heading").getAttribute("aria-selected"), "true", "Esc cancels text before navigating");
    assert.ok(await shortcut(canvasBody(), "?", { shiftKey: true }));
    const help = document.querySelector('[role="dialog"][aria-label="ショートカット一覧"]'), close = help.querySelector("button");
    assert.equal(help.querySelectorAll("tbody tr").length, editorShortcuts.length);
    assert.deepEqual([...help.querySelectorAll("tbody kbd")].map((element) => element.textContent), editorShortcuts.map(({ keyLabel }) => keyLabel));
    assert.equal(document.activeElement, close);
    assert.equal(await shortcut(close, "Delete"), false);
    assert.equal(await shortcut(canvasBody(), "Delete", {}, false), false);
    assert.match(document.querySelector(".e-notice").textContent, /ダイアログを閉じて/);
    assert.ok(await shortcut(close, "Escape"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(canvasNode("heading"));
  } finally { await app.cleanup(); }
});

function historyHost(overrides = {}) {
  const calls = { lists: [], reads: [], snapshots: [] };
  const old = structuredClone(fixture); old.title = "以前のタイトル"; old.body[0].children[0].children[0].text = "以前の見出し";
  const entries = [
    { id: "rev_3", revision: 3, kind: "autosave", createdAt: "2026-10-21T03:00:00.000Z", actor: "編集AI", actorKind: "machine", delegatedBy: "編集者A",
      operations: [{ type: "style", targetId: "hero", targetType: "element", targetTag: "section", field: "color" }] },
    { id: "rev_2", revision: 2, kind: "snapshot", createdAt: "2026-10-20T02:00:00.000Z", actor: "編集者B", label: "公開前の確認" },
    { id: "rev_1", revision: 1, kind: "publish", createdAt: "2026-10-19T01:00:00.000Z", actor: "編集者A", ...(overrides.expiredSnapshot ? { snapshotAvailable: false } : {}) }
  ];
  const adapter = {
    listRevisions: async (request) => {
      calls.lists.push(structuredClone(request)); const start = request.cursor ? Number(request.cursor) : 0;
      return { entries: entries.slice(start, start + 2), ...(start + 2 < entries.length ? { next: String(start + 2) } : {}) };
    },
    readRevision: async (request) => { calls.reads.push(structuredClone(request)); return { document: { ...structuredClone(old), pageId: request.target.pageId } }; },
    createSnapshot: async (request) => { calls.snapshots.push(structuredClone(request)); return overrides.snapshot?.(request) ?? { status: "saved", entry: { id: "snap_new", revision: 1, kind: "snapshot", createdAt: "2026-10-21T05:00:00.000Z", actor: "あなた", label: request.label } }; }
  };
  return { calls, adapter, entries };
}
const versionRows = () => [...document.querySelectorAll(".e-versions .e-version")];
const historyButton = () => document.querySelector('.e-tools [aria-label="履歴"]');

test("shortcut matrix denies mutations with reasons in read-only, locked, history and preview modes", async () => {
  const host = historyHost();
  const cases = [
    { options: { readOnly: { reason: "原文は業務画面で編集します。" } }, expected: /原文は業務画面/ },
    { options: { locks: [{ nodeId: "heading", fields: ["children"], reason: "ホストが管理する見出し" }] }, expected: /ホストが管理する見出し/ },
    { options: { adapter: host.adapter }, enter: async () => { await press(historyButton()); await press(versionRows()[1]); }, expected: /版の表示を閉じて/ },
    { options: {}, enter: () => click("プレビュー"), expected: /プレビューを閉じて/ },
  ];
  for (const { options, enter, expected } of cases) {
    const app = await setup(options);
    try {
      await tool("レイヤー"); await clickLayer("heading"); await enter?.();
      for (const target of [document.body, canvasBody(), layerButton("heading")]) {
        assert.equal(await shortcut(target, "Delete", {}, false), false, String(expected));
        assert.match(document.querySelector(".e-notice").textContent, expected);
        assert.ok(canvasNode("heading"));
      }
      assert.equal(await shortcut(canvasBody(), "d", { metaKey: true }, false), false);
      assert.equal(canvasNode("heading_copy1"), null);
    } finally { await app.cleanup(); }
  }
});

test("page switches reuse the canvas iframe and keep its current keyboard listener", async () => {
  const app = await setup();
  try {
    const scale = () => document.querySelector('select[aria-label="表示倍率"]').value;
    const oldFrame = document.querySelector("iframe"), oldBody = canvasBody(), OldKeyboardEvent = oldBody.ownerDocument.defaultView.KeyboardEvent;
    assert.ok(await shortcut(oldBody, "0", { ctrlKey: true })); assert.equal(scale(), "1");
    assert.ok(await shortcut(document.body, "+", { metaKey: true, shiftKey: true })); assert.equal(scale(), "1.5");
    assert.ok(await shortcut(oldBody, "-", { metaKey: true })); assert.equal(scale(), "1");
    assert.equal(button("元に戻す").disabled, true);
    await clickPage("別ページ");
    assert.equal(document.querySelector("iframe"), oldFrame, "page changes keep the same iframe");
    assert.equal(canvasBody(), oldBody, "the current page is rendered into the existing iframe document");
    const oldEvent = new OldKeyboardEvent("keydown", { key: "-", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => oldBody.dispatchEvent(oldEvent));
    assert.equal(oldEvent.defaultPrevented, true); assert.equal(scale(), "0.75");
    assert.ok(await shortcut(canvasBody(), "0", { ctrlKey: true })); assert.equal(scale(), "1");
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

const png = (name, size) => new File([new Uint8Array(size)], name, { type: "image/png" });
const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
const garden = { id: "garden", name: "庭の緑.png", mimeType: "image/png", bytes: 2048, width: 600, height: 400, alt: "庭の緑", src: "/media/garden.png", thumbnailUrl: "/media/garden.png" };
function withImage(node = { attrs: { src: "/photo.webp", alt: "古い写真" } }) { const doc = structuredClone(fixture); doc.body[0].children.push({ type: "element", id: "photo", tag: "img", children: [], ...node }); return doc; }

test("a ready MP4 can replace a native video without storing its resolved URL", async () => {
  const clip = { id: "intro", name: "紹介.mp4", mimeType: "video/mp4", bytes: 4096, alt: "", src: "/media/intro.mp4" };
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, clip] });
  const doc = structuredClone(fixture); doc.body.push({ type: "element", id: "movie", tag: "video", attrs: { src: "/old.mp4", "aria-label": "紹介動画", controls: true }, children: [] });
  const app = await setup({ document: doc, assets: library });
  try {
    await clickCanvas("movie"); assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["動画", "ボックス", "変形", "設定"]);
    await click("動画を置き換え"); await settle();
    assert.equal(assetPanel().querySelector("h2").textContent, "動画を選ぶ"); assert.equal(assetCard("庭の緑.png"), undefined); assert.ok(assetCard("紹介.mp4"));
    await chooseAsset("紹介.mp4"); await settle();
    const edited = app.calls.saves.length ? app.calls.saves.at(-1).document : null;
    assert.equal(input("動画 URL").value, ""); assert.ok(canvasNode("movie").getAttribute("src").endsWith("/media/intro.mp4"));
    await click("下書き保存");
    const saved = app.calls.saves.at(-1).document.body.find((node) => node.id === "movie");
    assert.deepEqual(saved.asset, { provider: "uploads", id: "intro" }); assert.equal(saved.attrs.src, undefined); assert.equal(edited, null);
    await reloadEditor(); await settle(); assert.ok(canvasNode("movie").getAttribute("src").endsWith("/media/intro.mp4"));
  } finally { await app.cleanup(); }
});

test("layer tree keeps ID selection through sibling edits and clears only a removed target", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("heading");
    const destinations = [...input("移動先").options].map((option) => ({ value: option.value, text: option.textContent }));
    assert.deepEqual(destinations.slice(0, 2), [
      { value: "", text: "ページ直下" },
      { value: "hero", text: "セクション" },
    ]);
    assert.equal(destinations.some(({ text }) => text.includes("hero") || text.includes("heading")), false);
    await click("下へ"); assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    await click("元に戻す"); assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    await click("複製"); assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    await click("削除"); assert.equal(document.querySelector('[data-node-id="heading"]'), null); assert.equal(document.querySelector(".e-layer-root").getAttribute("aria-pressed"), "true");
    assert.deepEqual([...document.querySelectorAll('[role="treeitem"]')].filter((item) => item.tabIndex === 0), [document.querySelector(".e-layer-root")]);
    await click("元に戻す"); assert.ok(document.querySelector('[data-node-id="heading"]')); assert.equal(document.querySelector(".e-layer-root").getAttribute("aria-pressed"), "true");
  } finally { await app.cleanup(); }
});

test("layer tree collapse uses roving focus and canvas selection reopens ancestors", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("heading");
    const toggle = document.querySelector('[data-node-id="hero"] .e-layer-toggle');
    await act(async () => toggle.click()); await settle();
    assert.equal(document.querySelector('[data-node-id="heading"]'), null);
    assert.equal(document.querySelector('[data-node-id="hero"] button.e-layer').tabIndex, 0);
    assert.equal([...document.querySelectorAll('[role="treeitem"]')].filter((item) => item.tabIndex === 0).length, 1);
    await clickCanvas("heading");
    assert.equal(document.querySelector('[data-node-id="hero"] button.e-layer').getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    const heading = document.querySelector('[data-node-id="heading"] button.e-layer');
    heading.focus(); await act(async () => heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))); await settle();
    assert.equal(document.activeElement, document.querySelector('[data-node-id="hero"] button.e-layer'));
  } finally { await app.cleanup(); }
});

test("failed asset preview resolution can be retried", async () => {
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  let attempts = 0;
  const assets = { ...library, resolveAssets: async (request, signal) => {
    attempts++;
    if (attempts === 1) throw new Error("temporary failure");
    return library.resolveAssets(request, signal);
  } };
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets });
  try {
    await settle();
    assert.equal(attempts, 1);
    assert.ok(button("アセットを再読み込み"));
    await click("アセットを再読み込み");
    await settle();
    assert.equal(attempts, 2);
    assert.equal(button("アセットを再読み込み"), undefined);
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/garden.png"));
    await clickCanvas("photo"); await editorTab("画像"); assert.equal(input("レスポンシブ画像 URL"), undefined);
  } finally { await app.cleanup(); }
});

test("asset resolution revalidates on new references and before release, not when opening the library", async () => {
  const extra = { ...garden, id: "extra", name: "別の庭.png", src: "/media/extra.png", thumbnailUrl: "/media/extra.png" };
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, extra] });
  const resolutions = [];
  const assets = { ...library, resolveAssets: async (request, signal) => { resolutions.push(request.references); return library.resolveAssets(request, signal); } };
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets });
  try {
    await settle(); assert.equal(resolutions.length, 1);
    await tool("アセット"); await settle(); assert.equal(resolutions.length, 1);
    await chooseAsset("別の庭.png"); await click("ページに追加"); await settle();
    assert.equal(resolutions.length, 2);
    assert.deepEqual(resolutions.at(-1), [{ provider: "uploads", id: "extra" }]);
    await click("下書き保存"); await settle();
    await click("公開"); await settle();
    assert.equal(resolutions.length, 3, "公開内容の確認前に参照済み素材を再検証する");
    assert.deepEqual(resolutions.at(-1).map(({ id }) => id).sort(), ["extra", "garden"]);
    await click("編集に戻る");
  } finally { await app.cleanup(); }
});

test("changing the asset adapter does not retain the previous session's resolved image", async () => {
  const first = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  const second = createMemoryAssetLibrary({ siteId: "demo", seed: [{ ...garden, src: "/media/new-garden.png" }] });
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets: first });
  try {
    await settle();
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/garden.png"));
    await act(async () => app.root.render(createElement(PageEditor, { adapter: app.adapter, assets: second })));
    await settle();
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/new-garden.png"));
  } finally { await app.cleanup(); }
});

test("staff upload an image, set its alt, replace a page image, save the draft and see it after reload", async () => {
  let app;
  const library = createMemoryAssetLibrary({
    siteId: "demo", seed: [garden, { id: "guide", name: "利用案内.pdf", mimeType: "application/pdf", bytes: 4096, src: "/media/guide.pdf" }],
    upload: { accept: imageTypes, maxBytes: 1024 * 1024 }, quota: { limitBytes: 10 * 1024 * 1024 },
    documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [],
    store: async (_file, meta) => ({ src: `/media/${meta.id}.png`, thumbnailUrl: `/media/${meta.id}.png`, width: 1200, height: 800 })
  });
  app = await setup({ document: withImage(), assets: library });
  try {
    assert.equal(assetPanel(), null, "閉じている間は AssetLibraryPanel をマウントしない");
    await tool("アセット"); assert.ok(assetPanel()); assert.equal(assetPanel().closest("[hidden]"), null);
    assert.ok(assetCard("庭の緑.png").getAttribute("aria-label").startsWith("庭の緑.png（画像・600×400・2 KB"));
    assert.ok(assetCard("利用案内.pdf").getAttribute("aria-label").startsWith("利用案内.pdf（PDF・4 KB"));
    assert.ok(assetPanel().textContent.includes("ストレージ使用量 6 KB / 10 MB"));
    await uploadFiles([png("海辺の朝.png", 1500)]);
    assert.ok(assetPanel().textContent.includes("海辺の朝.png: 追加しました。"));
    assert.equal(document.activeElement, input("代替テキスト"));
    await change(input("代替テキスト"), "朝の海辺"); await click("変更を保存");
    assert.ok(assetPanel().textContent.includes("保存しました。"));
    await click("一覧に戻る");
    const first = assetPanel().querySelector(".e-asset-card");
    assert.ok(first.getAttribute("aria-label").startsWith("海辺の朝.png（画像・1200×800")); assert.equal(document.activeElement, first);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像");
    await click("画像を置き換え");
    assert.equal(assetPanel().closest("[hidden]"), null); assert.equal(assetPanel().querySelector("h2").textContent, "画像を選ぶ");
    assert.equal(await shortcut(assetPanel().querySelector("h2"), "Escape"), true);
    assert.equal(assetPanel(), null);
    await click("画像を置き換え");
    assert.equal(assetCard("利用案内.pdf"), undefined);
    await chooseAsset("海辺の朝.png");
    assert.ok(document.body.textContent.includes("画像を置き換えました。代替テキストを確認してください。"));
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/asset-1.png"); assert.equal(canvasNode("photo").getAttribute("alt"), "朝の海辺");
    assert.equal(assetPanel(), null);
    await editorTab("画像"); assert.equal(input("画像の説明").value, "朝の海辺");
    await click("下書き保存");
    const saved = app.calls.saves[0].document.body[0].children.at(-1);
    assert.deepEqual(saved.asset, { provider: "uploads", id: "asset-1" }); assert.deepEqual(saved.attrs, { alt: "朝の海辺" });
    await reloadEditor();
    assert.equal(app.calls.reads.length, 2); assert.equal(canvasNode("photo").getAttribute("src"), "/media/asset-1.png");
  } finally { await app.cleanup(); }
});

const night = { id: "night", name: "夜の海.avif", mimeType: "image/avif", bytes: 1024, width: 1200, height: 630, alt: "夜の海", src: "/media/night.avif", thumbnailUrl: "/media/night.avif" };
const coverFrame = (root) => root.querySelector(".e-cover-frame");
const coverRemove = (root) => root.querySelector(".e-cover-remove") ?? undefined;
test("staff choose the page social cover from the library, save it as an asset reference and see it after reload", async () => {
  let app;
  const terrace = { id: "terrace", name: "テラス.jpg", mimeType: "image/jpeg", bytes: 1024, width: 1200, height: 630, alt: "テラス", src: "/media/terrace.jpg", thumbnailUrl: "/media/terrace.jpg" };
  const host = pageHost(), library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, night, terrace], documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [] });
  app = await setup({ adapter: host.adapter, assets: library });
  try {
    let page = await panel("ページ");
    assert.equal(coverFrame(page).textContent, "画像は未設定です"); assert.equal(coverFrame(page).getAttribute("aria-label"), "画像を選ぶ"); assert.equal(coverRemove(page), undefined);
    assert.equal(inputIn(page, "画像 URL"), undefined, "素材を選べる画面では URL 入力を出さない"); assert.equal(inputIn(page, "画像の説明"), undefined);
    await press(coverFrame(page));
    assert.equal(assetPanel().closest("[hidden]"), null); assert.equal(assetPanel().querySelector("h2").textContent, "ソーシャルカバーを選ぶ");
    await chooseAsset("夜の海.avif");
    assert.equal(assetPanel().querySelector('[role="alert"]').textContent, "ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。");
    assert.equal(app.stored().meta, undefined); assert.equal(button("下書き保存").disabled, true);
    await chooseAsset("庭の緑.png");
    assert.ok(document.body.textContent.includes("ソーシャルカバーを設定しました。"));
    assert.equal(assetPanel(), null);
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/garden.png");
    assert.equal(coverFrame(page).getAttribute("aria-label"), "画像を変更"); assert.ok(coverRemove(page));
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.meta, { ogImage: { asset: { provider: "uploads", id: "garden" }, alt: "庭の緑" } }, "画像の説明は素材の説明を使う");
    await reloadEditor();
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/garden.png");
    // ソーシャルカバーで使っているアセットは削除できず、使用箇所の置き換えでカバーも差し替わる（SNS で表示できない形式は拒否）。
    await tool("アセット"); await chooseAsset("庭の緑.png");
    assert.equal(button("削除…").disabled, true); assert.ok(assetPanel().textContent.includes("このページで使用中です。"));
    await click("このページの使用箇所を置き換え"); await chooseAsset("夜の海.avif");
    assert.equal(assetPanel().querySelector('[role="alert"]').textContent, "この画像はソーシャルカバーにも使われています。ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。");
    await chooseAsset("テラス.jpg"); assert.ok(document.body.textContent.includes("このページの使用箇所を置き換えました。"));
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/terrace.jpg");
    await press(coverRemove(page)); assert.equal(coverFrame(page).textContent, "画像は未設定です"); assert.equal(coverRemove(page), undefined);
    await click("下書き保存"); assert.equal(app.calls.saves[1].document.meta, undefined);
  } finally { await app.cleanup(); }
});

test("the site social cover is chosen from the library, saved with site settings and resolved after reload", async () => {
  const host = pageHost(), library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  let app = await setup({ adapter: host.adapter, assets: library });
  try {
    const site = await panel("サイト");
    assert.equal(inputIn(site, "画像の説明"), undefined);
    await press(coverFrame(site));
    assert.equal(assetPanel().querySelector("h2").textContent, "ソーシャルカバーを選ぶ");
    await chooseAsset("庭の緑.png");
    assert.equal(assetPanel(), null); assert.equal(button("下書き保存").disabled, true);
    assert.equal(coverFrame(site).querySelector("img").getAttribute("src"), "/media/garden.png");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[0].settings, { title: "デモサイト", description: "サイトの説明", ogImage: { asset: { provider: "uploads", id: "garden" }, alt: "庭の緑" }, locale: "ja" });
    const page = await panel("ページ"); assert.equal(coverFrame(page).textContent, "サイト共通の画像を使います");
  } finally { await app.cleanup(); }
  app = await setup({ adapter: host.adapter, assets: library });
  try {
    const site = await panel("サイト");
    assert.equal(coverFrame(site).querySelector("img").getAttribute("src"), "/media/garden.png");
    await press(coverRemove(site)); assert.equal(coverFrame(site).textContent, "画像は未設定です");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[1].settings, { title: "デモサイト", description: "サイトの説明", locale: "ja" });
  } finally { await app.cleanup(); }
});

test("library images can be added inside the selected element and used as its background", async () => {
  const app = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try {
    await clickLayer("hero"); await tool("アセット"); await chooseAsset("庭の緑.png");
    await click("ページに追加");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "画像");
    assert.ok(document.querySelector('[data-node-id="node_1"]'));
    assert.equal(canvasNode("node_1").parentElement.getAttribute("data-nw-node"), "hero");
    assert.equal(canvasNode("node_1").getAttribute("src"), "/media/garden.png"); assert.equal(canvasNode("node_1").getAttribute("width"), "600");
    await tool("レイヤー"); await clickLayer("hero"); assert.equal(document.querySelector('[aria-label="インスペクタ"] [role="tab"][aria-selected="true"]').textContent, "ボックス"); await click("背景画像を選ぶ");
    assert.equal(assetPanel().querySelector("h2").textContent, "背景画像を選ぶ");
    await chooseAsset("庭の緑.png");
    const css = () => document.querySelector("iframe").contentDocument.querySelector("style[data-nw-style]").textContent;
    assert.ok(css().includes("background-image:var(--nw-Node-hero-base-backgroundImage);"));
    assert.equal(canvasNode("hero").style.getPropertyValue("--nw-Node-hero-base-backgroundImage"), 'url("/media/garden.png")');
    await change(input("背景のサイズ"), "cover");
    assert.ok(css().includes("background-size:var(--nw-Node-hero-base-backgroundSize);"));
    assert.equal(canvasNode("hero").style.getPropertyValue("--nw-Node-hero-base-backgroundSize"), "cover");
    await click("下書き保存");
    const hero = app.calls.saves[0].document.body[0];
    assert.deepEqual(hero.style.base.backgroundImage, { asset: { provider: "uploads", id: "garden" } }); assert.equal(hero.style.base.backgroundSize, "cover");
    assert.deepEqual(hero.children.at(-1), { type: "element", id: "node_1", tag: "img", asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭の緑" }, style: { base: { maxWidth: "100%", height: "auto" } }, children: [] });
    await click("背景画像を外す"); assert.ok(!css().includes("background-image"));
  } finally { await app.cleanup(); }
});

test("uploads explain rejected formats, sizes, quota, scans and permissions, and cross-site listings fail closed", async () => {
  let mode = "host";
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [{ id: "existing", name: "既存.png", mimeType: "image/png", bytes: 1000, src: "/media/existing.png" }], upload: { accept: ["image/png"], maxBytes: 1000 }, quota: { limitBytes: 1500 } });
  const guarded = { ...library, uploadAsset: async (request, signal) => {
    if (mode === "scan") return { status: "rejected", reason: "scan" };
    if (mode === "forbidden") throw Object.assign(new Error("forbidden"), { status: 403 });
    return library.uploadAsset(request, signal);
  } };
  const app = await setup({ assets: guarded });
  try {
    await tool("アセット");
    await uploadFiles([new File(["%PDF"], "案内.pdf", { type: "application/pdf" }), png("大きい.png", 2000), png("中くらい.png", 600)]);
    const text = () => assetPanel().querySelector(".e-asset-uploads").textContent;
    assert.ok(text().includes("案内.pdf: この形式はアップロードできません。アップロードできる形式: PNG"));
    assert.ok(text().includes("大きい.png: ファイルが大きすぎます（上限 1000 B）。"));
    assert.ok(text().includes("中くらい.png: 容量の上限を超えるためアップロードできません。"));
    mode = "scan"; await uploadFiles([png("検査.png", 10)]); assert.ok(text().includes("検査.png: 安全性の確認で受け付けられませんでした。"));
    mode = "forbidden"; await uploadFiles([png("権限.png", 10)]); assert.ok(text().includes("権限.png: アセットを追加する権限がありません。"));
    assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 1);
    await act(async () => assetPanel().querySelector('[aria-label="案内.pdf の通知を閉じる"]').click()); assert.ok(!text().includes("案内.pdf"));
  } finally { await app.cleanup(); }
  const foreign = { ...library, listAssets: async (query, signal) => { const result = await library.listAssets(query, signal); return { ...result, assets: [...result.assets, { ...result.assets[0], id: "foreign", siteId: "other" }] }; } };
  const crossSite = await setup({ assets: foreign });
  try {
    await tool("アセット");
    assert.ok(assetPanel().textContent.includes("アセットを読み込めませんでした。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
  } finally { await crossSite.cleanup(); }
  const readOnly = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try {
    await tool("アセット");
    assert.equal(button("アップロード"), undefined); assert.ok(assetPanel().textContent.includes("このサイトにアセットを追加する権限がありません。"));
  } finally { await readOnly.cleanup(); }
});

test("assets used on this page or other pages cannot be deleted; unused assets are deleted after confirmation", async () => {
  const other = withImage({ asset: { provider: "uploads", id: "elsewhere" }, attrs: { alt: "" } }); other.pageId = "about";
  const image = (id, name) => ({ id, name, mimeType: "image/png", bytes: 1024, src: `/media/${id}.png` });
  let hideUsages = false;
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [image("here", "使用中.png"), image("spare", "未使用.png"), image("trash", "削除する.png"), image("elsewhere", "他ページ.png")],
    documents: () => [{ pageId: "about", locale: "ja-JP", title: "紹介", state: "published", document: other }] });
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "here" }, attrs: { alt: "ここ" } }), assets: { ...library, listAssetUsages: async (request, signal) => hideUsages ? [] : library.listAssetUsages(request, signal) } });
  try {
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/here.png");
    await tool("アセット");
    assert.ok(assetCard("使用中.png").getAttribute("aria-label").endsWith("・使用中）")); assert.ok(assetCard("他ページ.png").getAttribute("aria-label").endsWith("・使用中）"));
    await chooseAsset("使用中.png");
    assert.equal(button("削除…").disabled, true);
    assert.ok(assetPanel().textContent.includes("このページ: 1 か所")); assert.ok(assetPanel().textContent.includes("このページで使用中です。先に別の画像へ置き換えてください。"));
    await click("このページの使用箇所を置き換え");
    assert.equal(assetPanel().querySelector("h2").textContent, "置き換える画像を選ぶ");
    await chooseAsset("未使用.png");
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/spare.png"); assert.ok(document.body.textContent.includes("このページの使用箇所を置き換えました。"));
    await chooseAsset("未使用.png"); assert.ok(assetPanel().textContent.includes("このページ: 1 か所"));
    await click("一覧に戻る"); await chooseAsset("削除する.png");
    await click("削除…"); assert.ok(assetPanel().textContent.includes("「削除する.png」を削除します。元に戻せません。"));
    await click("削除する"); assert.equal(assetCard("削除する.png"), undefined);
    await chooseAsset("他ページ.png");
    assert.equal(button("削除…").disabled, true); assert.ok(assetPanel().textContent.includes("紹介（ja-JP）・公開中"));
    assert.ok(assetPanel().textContent.includes("公開中または下書きのページで使用中のため削除できません。"));
    hideUsages = true; await click("使用状況を再確認"); assert.equal(button("削除…").disabled, false);
    await click("削除…"); await click("削除する");
    assert.ok(assetCard("他ページ.png") === undefined && assetPanel().textContent.includes("公開中または下書きのページで使用中のため削除できません。"));
    assert.ok(assetPanel().textContent.includes("紹介（ja-JP）・公開中"));
  } finally { await app.cleanup(); }
});

test("without an asset adapter the editor keeps the URL image fields and shows no library", async () => {
  const app = await setup({ document: withImage() });
  try {
    assert.equal(document.querySelector('.e-tools button[aria-label="アセット"]'), null); assert.equal(assetPanel(), null);
    await clickCanvas("photo"); await editorTab("画像");
    assert.equal(input("画像 URL").value, "/photo.webp"); assert.equal(button("画像を置き換え"), undefined); assert.equal(button("背景画像を選ぶ"), undefined);
    await change(input("画像 URL"), "/other.webp");
    // 文書は root-relative のまま保存し、キャンバスの iframe（Studio の origin）ではサイトの公開 origin で解決して表示する。
    assert.equal(canvasNode("photo").getAttribute("src"), "https://example.test/other.webp");
  } finally { await app.cleanup(); }
});

test("image URL locks disable responsive replacement and keep alt editable", async () => {
  for (const field of ["attrs.src", "attrs.srcSet", "asset"]) {
    const app = await setup({ document: withImage({ attrs: { src: "/photo.webp", srcSet: "/large.webp", alt: "Sea" } }), locks: [{ nodeId: "photo", fields: [field], reason: "業務画像" }] });
    try {
      await clickCanvas("photo"); await editorTab("画像");
      assert.equal(input("画像 URL").disabled, true);
      assert.equal(input("レスポンシブ画像 URL").disabled, true);
      assert.equal(input("画像の説明").disabled, false);
      assert.equal(button("下書き保存").disabled, true);
    } finally { await app.cleanup(); }
  }
});

const caps = (extra = {}) => ({ upload: false, editMetadata: false, delete: false, folders: false, acquire: false, ...extra });
const yoga = { id: "yoga", name: "朝ヨガ.png", mimeType: "image/png", bytes: 3072, width: 800, height: 600, alt: "海辺で朝ヨガ", sourceLabel: "体験「鎌倉の朝ヨガ」の写真", src: "/cms/yoga.png", thumbnailUrl: "/cms/yoga.png" };
const wave = { id: "wave", name: "波.png", mimeType: "image/png", bytes: 1024, width: 640, height: 480, alt: "波の模様", src: "/stock/wave.png", thumbnailUrl: "/stock/wave.png",
  license: { name: "テスト用ライセンス", url: "https://license.example.test/terms", attribution: "見本ストック", terms: "テストの中だけで使えます。" } };
function sourceLibrary({ stock = false, documents } = {}) {
  return createMemoryAssetLibrary({
    siteId: "demo", folders: [{ id: "photos", name: "写真" }], upload: { accept: imageTypes, maxBytes: 1024 * 1024 }, ...(documents ? { documents } : {}),
    store: async (_file, meta) => ({ src: `/media/${meta.id}.png`, thumbnailUrl: `/media/${meta.id}.png`, width: 10, height: 10 }),
    providers: [
      { id: "uploads", kind: "upload", label: "サイト", origin: "このサイトにアップロードした素材", status: "available", capabilities: caps({ upload: true, editMetadata: true, delete: true, folders: true }), seed: [garden] },
      { id: "experience", kind: "cms", label: "体験写真", origin: "NIHO の体験原稿で公開を許可された写真", terms: "体験の公開中だけ表示されます。写真の差し替え・非公開は体験原稿で行います。", status: "available", capabilities: caps(), seed: [yoga] },
      stock ? { id: "stock", kind: "stock", label: "ストック", origin: "ライセンス確認済みのストック素材", status: "available", capabilities: caps({ acquire: true }), seed: [wave] }
        : { id: "stock", kind: "stock", label: "ストック", origin: "ライセンス確認済みのストック素材", status: "unavailable", unavailableReason: "ストックアセットはまだ接続されていません。", capabilities: caps() }
    ]
  });
}
function spy(library) {
  const calls = { lists: [], acquires: [] };
  return { calls, adapter: { ...library, listAssets: async (query, signal) => { calls.lists.push(structuredClone(query)); return library.listAssets(query, signal); },
    acquireAsset: async (request, signal) => { calls.acquires.push(structuredClone(request)); return library.acquireAsset(request, signal); } } };
}
const sourceTabs = () => [...assetPanel().querySelectorAll('[aria-label="アセットの出所"] button')];
const cardNames = () => [...assetPanel().querySelectorAll(".e-asset-card")].map((node) => node.getAttribute("aria-label").split("（")[0]);
const assetButton = (text) => [...(assetPanel()?.querySelectorAll("button") ?? [])].find((node) => node.textContent === text);

test("upload, stock and connect tools scope their libraries while the image picker keeps all sources", async () => {
  const { adapter } = spy(sourceLibrary());
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    assert.deepEqual([...document.querySelectorAll(".e-tools button")].filter((node) => !node.classList.contains("e-panel-toggle")).map((node) => node.title), ["追加", "ページ", "レイヤー", "スタイル", "アップロード", "ストック", "接続", "コンポーネント", "コンテンツ編集"]);
    await tool("アップロード");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["サイト"]);
    assert.deepEqual(cardNames(), ["庭の緑.png"]); assert.ok(button("アップロード"));
    await tool("接続");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["体験写真"]);
    assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像"); await click("画像を置き換え");
    assert.equal(assetPanel().querySelector("h2").textContent, "画像を選ぶ");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["すべて", "サイト", "体験写真", "ストック（未接続）"]);
    await click("体験写真");
    await chooseAsset("朝ヨガ.png");
    assert.equal(canvasNode("photo").getAttribute("src"), "/cms/yoga.png"); assert.equal(canvasNode("photo").getAttribute("alt"), "海辺で朝ヨガ");
    await click("下書き保存");
    const saved = app.calls.saves[0].document;
    assert.deepEqual(saved.body[0].children.at(-1).asset, { provider: "experience", id: "yoga" }); assert.ok(!JSON.stringify(saved).includes("/cms/"));
  } finally { await app.cleanup(); }
});

test("asset panel reads only while open and reuses cached provider and list scopes", async () => {
  const library = sourceLibrary({ stock: true });
  let providerReads = 0;
  const { calls, adapter } = spy({ ...library, listProviders: async (...args) => { providerReads++; return library.listProviders(...args); } });
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    assert.equal(assetPanel(), null);
    assert.equal(providerReads, 0);
    assert.equal(calls.lists.length, 0);

    await tool("アップロード"); await settle();
    assert.equal(providerReads, 1);
    assert.equal(calls.lists.length, 1);
    const afterUpload = calls.lists.length;

    await tool("ストック"); await settle();
    assert.equal(calls.lists.length, afterUpload + 1);
    await tool("アップロード"); await settle();
    assert.equal(calls.lists.length, afterUpload + 1, "同じ範囲へ戻ったときは一覧を再取得しない");
    assert.deepEqual(cardNames(), ["庭の緑.png"]);
    assert.equal(providerReads, 1, "非表示化して再表示しても出所一覧は一度だけ取得する");

    await tool("レイヤー");
    assert.equal(assetPanel(), null, "別パネルを表示している間は素材パネルを隠す");
    assert.ok(mountedAssetPanel(), "初回表示後はアップロード状態を保つため素材パネルをマウントしたままにする");
    await tool("アップロード"); await settle();
    assert.equal(calls.lists.length, afterUpload + 1, "素材パネルを再度開いてもキャッシュ済み範囲を使う");
    assert.equal(providerReads, 1);
    assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("processing assets are fetched again when the asset panel is reopened", async () => {
  const library = sourceLibrary(); let reads = 0;
  const { adapter } = spy({ ...library, listAssets: async (query, signal) => {
    reads++;
    const result = await library.listAssets(query, signal);
    return reads === 1 ? { ...result, assets: result.assets.map((asset) => ({ ...asset, status: "processing" })) } : result;
  } });
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("アップロード"); await settle();
    assert.equal(reads, 1);
    await tool("レイヤー"); await tool("アップロード"); await settle();
    assert.equal(reads, 2, "処理中の一覧はキャッシュせず再取得する");
    assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("upload keeps running while the asset panel is hidden", async () => {
  const library = sourceLibrary(); let resolveUpload; let uploadSignal;
  const adapter = { ...library, uploadAsset: (request, signal) => new Promise((resolve) => {
    uploadSignal = signal;
    resolveUpload = async () => resolve(await library.uploadAsset(request, signal));
  }) };
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("アップロード"); await settle();
    await uploadFiles([png("継続.png", 10)]);
    assert.ok(resolveUpload);
    await tool("レイヤー");
    assert.equal(uploadSignal.aborted, false, "パネル切り替えで進行中のアップロードを中断しない");
    await act(async () => resolveUpload()); await settle();
    assert.equal(uploadSignal.aborted, false);
    await tool("アップロード"); await settle();
    assert.ok(assetCard("継続.png"));
  } finally { await app.cleanup(); }
});

test("provider scopes clear hidden folder filters and wait for the matching source", async () => {
  const { calls, adapter } = spy(sourceLibrary({ stock: true }));
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("アップロード"); await settle();
    await change(assetPanel().querySelector('select[aria-label="フォルダ"]'), "photos");
    assert.equal(calls.lists.at(-1).folderId, "photos");

    let before = calls.lists.length;
    await tool("ストック"); await settle();
    assert.equal(calls.lists.slice(before).some((query) => query.provider === "uploads"), false);
    assert.equal(calls.lists.at(-1).provider, "stock"); assert.equal(calls.lists.at(-1).folderId, null);
    assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null); assert.deepEqual(cardNames(), ["波.png"]);

    before = calls.lists.length;
    await tool("接続"); await settle();
    assert.equal(calls.lists.slice(before).some((query) => query.provider === "stock"), false);
    assert.equal(calls.lists.at(-1).provider, "experience"); assert.equal(calls.lists.at(-1).folderId, null);
    assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);

    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像"); await click("画像を置き換え"); await settle();
    assert.equal(Object.hasOwn(calls.lists.at(-1), "provider"), false); assert.equal(calls.lists.at(-1).folderId, null);
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["すべて", "サイト", "体験写真", "ストック"]);
    assert.deepEqual(cardNames(), ["庭の緑.png", "朝ヨガ.png", "波.png"]);
  } finally { await app.cleanup(); }
});

test("CMS photos show their origin and terms read-only, without save, upload, folders or delete", async () => {
  const { calls, adapter } = spy(sourceLibrary());
  const app = await setup({ assets: adapter });
  try {
    await tool("接続"); await chooseAsset("朝ヨガ.png");
    assert.equal(input("名前").readOnly, true); assert.equal(input("代替テキスト").readOnly, true); assert.equal(input("保存先フォルダ"), undefined);
    assert.equal(button("変更を保存"), undefined); assert.equal(button("削除…"), undefined); assert.ok(button("ページに追加"));
    const text = assetPanel().textContent;
    for (const expected of ["出所体験写真NIHO の体験原稿で公開を許可された写真体験「鎌倉の朝ヨガ」の写真", "利用条件体験の公開中だけ表示されます。写真の差し替え・非公開は体験原稿で行います。",
      "「体験写真」で管理しています", "「体験写真」のアセットはここでは削除できません。", "このページ: 0 か所"]) assert.ok(text.includes(expected), expected);
    await click("一覧に戻る"); await tool("アップロード"); await chooseAsset("庭の緑.png");
    assert.equal(input("名前").readOnly, false); assert.ok(button("変更を保存")); assert.ok(button("削除…")); assert.ok(input("保存先フォルダ"));
    await click("一覧に戻る"); const beforeConnect = calls.lists.length; await tool("接続");
    assert.equal(calls.lists.length, beforeConnect, "接続タブへ戻ると取得済みの一覧を使う"); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    assert.ok(!assetPanel().textContent.includes("NIHO の体験原稿で公開を許可された写真"), "一覧の上に出所の説明文を出さない");
    assert.equal(assetButton("アップロード"), undefined); assert.equal(button("フォルダを追加"), undefined); assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null);
    assert.ok(!assetPanel().textContent.includes("このサイトにアセットを追加する権限がありません。"));
    await tool("アップロード"); assert.ok(assetButton("アップロード")); assert.ok(assetPanel().querySelector('select[aria-label="フォルダ"]')); assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("an unconnected stock source explains why without requesting a listing", async () => {
  const { calls, adapter } = spy(sourceLibrary()), errors = [], original = console.error;
  console.error = (...args) => { errors.push(args); };
  const app = await setup({ assets: adapter });
  try {
    await tool("ストック"); const before = calls.lists.length;
    assert.equal(sourceTabs().length, 1); assert.equal(sourceTabs()[0].getAttribute("aria-pressed"), "true");
    assert.ok(assetPanel().textContent.includes("ストックアセットはまだ接続されていません。")); assert.ok(assetPanel().textContent.includes("ライセンス確認済みのストック素材"));
    assert.equal(calls.lists.length, before); assert.ok(calls.lists.every((query) => query.provider !== "stock"));
    assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0); assert.equal(assetPanel().querySelector('[role="alert"]'), null); assert.equal(assetButton("アップロード"), undefined);
    await tool("アップロード"); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    assert.deepEqual(errors, []);
  } finally { console.error = original; await app.cleanup(); }
});

test("connected stock shows its license and is acquired into site uploads before placement", async () => {
  const { calls, adapter } = spy(sourceLibrary({ stock: true }));
  const app = await setup({ assets: adapter });
  try {
    await tool("ストック");
    assert.equal(calls.lists.at(-1).provider, "stock");
    assert.ok(assetCard("波.png").getAttribute("aria-label").endsWith("・ライセンスあり）")); assert.ok(assetCard("波.png").querySelector(".e-asset-badges").textContent.includes("ライセンス"));
    await chooseAsset("波.png");
    const link = [...assetPanel().querySelectorAll("a")].find((node) => node.textContent === "ライセンスを確認");
    assert.equal(link.getAttribute("href"), "https://license.example.test/terms"); assert.equal(link.getAttribute("target"), "_blank"); assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    for (const expected of ["出所ストックライセンス確認済みのストック素材", "ライセンステスト用ライセンス", "クレジット: 見本ストック", "テストの中だけで使えます。"]) assert.ok(assetPanel().textContent.includes(expected), expected);
    await click("ページに追加");
    assert.deepEqual(calls.acquires, [{ siteId: "demo", reference: { provider: "stock", id: "wave" }, expectedVersion: "1" }]);
    assert.ok(assetPanel().textContent.includes("ライセンス情報を記録して配置しました。"));
    assert.ok(assetPanel().textContent.includes("出所サイトこのサイトにアップロードした素材「ストック」から取り込んだ素材")); assert.ok(assetPanel().textContent.includes("ライセンステスト用ライセンス"));
    assert.equal(canvasNode("node_1").getAttribute("src"), "/stock/wave.png");
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).asset, { provider: "uploads", id: "asset-1" }); assert.ok(!JSON.stringify(app.calls.saves[0].document).includes('"stock"'));
    await click("一覧に戻る"); assert.deepEqual(cardNames(), ["波.png"]);
    await tool("アップロード"); assert.equal(calls.lists.at(-1).provider, "uploads");
    assert.deepEqual(cardNames(), ["波.png", "庭の緑.png"]); assert.ok(assetCard("波.png").getAttribute("aria-label").includes("・ライセンスあり"));
  } finally { await app.cleanup(); }
});

test("a removed provider leaves its open asset detail read-only and blocks placement", async () => {
  const library = sourceLibrary(); let removed = false;
  const adapter = { ...library, listProviders: async (request, signal) => {
    const providers = await library.listProviders(request, signal);
    return removed ? providers.filter((provider) => provider.id !== "experience") : providers;
  } };
  const app = await setup({ assets: adapter });
  try {
    await tool("接続"); await chooseAsset("朝ヨガ.png");
    removed = true;
    await clickPage("別ページ"); await settle();
    assert.equal(input("名前").readOnly, true);
    assert.equal(input("代替テキスト").readOnly, true);
    assert.equal(button("変更を保存"), undefined);
    assert.equal(button("削除…"), undefined);
    assert.equal(button("ページに追加").disabled, true);
    assert.ok(assetPanel().textContent.includes("出所が確認できないアセットは利用できません。"));
  } finally { await app.cleanup(); }
});

test("acquisition cannot place an asset returned from an unavailable provider", async () => {
  const library = sourceLibrary({ stock: true });
  const adapter = { ...library, listProviders: async (request, signal) => [
    ...await library.listProviders(request, signal),
    { id: "offline", kind: "stock", label: "未接続", origin: "未接続の出所", status: "unavailable", capabilities: caps() }
  ], acquireAsset: async (request, signal) => {
    const result = await library.acquireAsset(request, signal);
    return result.status === "ready" ? { ...result, asset: { ...result.asset, provider: "offline" } } : result;
  } };
  const app = await setup({ assets: adapter });
  try {
    await tool("ストック"); await chooseAsset("波.png");
    await click("ページに追加");
    assert.equal(canvasNode("node_1"), null);
    assert.ok(assetPanel().textContent.includes("この出所は現在利用できません。"));
  } finally { await app.cleanup(); }
});

test("photos unpublished in the CMS become placeholders after the editor reloads and are left out of public HTML", async () => {
  const library = sourceLibrary(), reference = { provider: "experience", id: "yoga" }, doc = withImage({ asset: reference, attrs: { alt: "海辺で朝ヨガ" } });
  const publicHtml = async () => renderPageToHtml(doc, {}, { assets: parseResolvedAssets(await library.resolveAssets({ siteId: "demo", references: uniqueAssetReferences(parsePageDocument(doc)) }, new AbortController().signal)) });
  const app = await setup({ document: doc, assets: library });
  try {
    assert.equal(canvasNode("photo").getAttribute("src"), "/cms/yoga.png"); assert.ok((await publicHtml()).includes('src="/cms/yoga.png"'));
    library.setPublished(reference, false);
    // エディター内の再読込で解決をやり直し、非公開になった写真をプレビューから外す。
    await reloadEditor(); await settle();
    assert.equal(canvasNode("photo").hasAttribute("data-nw-missing-asset"), true); assert.equal(canvasNode("photo").getAttribute("src"), null);
    await clickCanvas("photo"); await editorTab("画像"); assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("画像を表示できません"));
    const html = await publicHtml(); assert.ok(!html.includes("/cms/yoga.png")); assert.ok(!html.includes('data-nw-node="photo"'));
    await tool("接続"); assert.equal(!!assetCard("朝ヨガ.png"), false);
  } finally { await app.cleanup(); }
});

test("source listing failures and assets from undeclared or other sources fail closed", async () => {
  let failing = true, mode = "ok";
  const library = sourceLibrary(), lists = [], uploads = [];
  const adapter = { ...library,
    listProviders: async (request, signal) => { if (failing) throw new Error("offline"); return library.listProviders(request, signal); },
    listAssets: async (query, signal) => {
      lists.push(query); const result = await library.listAssets(query, signal);
      if (mode === "unknown") return { ...result, assets: [...result.assets, { ...result.assets[0], provider: "other", id: "x" }] };
      if (mode === "mixed" && query.provider === "uploads") return { ...result, assets: [...result.assets, ...(await library.listAssets({ ...query, provider: "experience" }, signal)).assets] };
      return result;
    },
    uploadAsset: async (request, signal) => {
      uploads.push(request.provider); const result = await library.uploadAsset(request, signal);
      return mode === "upload" && result.status === "uploaded" ? { ...result, asset: { ...result.asset, provider: "experience" } } : result;
    } };
  const app = await setup({ assets: adapter });
  try {
    await tool("アップロード");
    assert.ok(assetPanel().textContent.includes("アセットの出所を読み込めませんでした。")); assert.ok(button("再読み込み"));
    assert.equal(lists.length, 0); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0); assert.equal(assetPanel().querySelector('input[type="search"]'), null);
    failing = false; await click("再読み込み"); assert.deepEqual(sourceTabs().map((node) => node.textContent), ["サイト"]); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    mode = "unknown"; await tool("接続");
    assert.ok(assetPanel().textContent.includes("アセットを読み込めませんでした。出所が確認できないアセットは利用できません。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
    mode = "mixed";
    const mixedAdapter = { ...adapter };
    await act(async () => app.root.render(createElement(PageEditor, { adapter: app.adapter, assets: mixedAdapter }))); await flush();
    await tool("アップロード");
    assert.ok(assetPanel().textContent.includes("出所が確認できないアセットは利用できません。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
    mode = "ok"; await click("再読み込み"); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    mode = "upload"; await uploadFiles([png("混入.png", 10)]);
    assert.deepEqual(uploads, ["uploads"]);
    assert.ok(assetPanel().querySelector(".e-asset-uploads").textContent.includes("混入.png: 出所が確認できないアセットは利用できません。")); assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("recently used assets are requested with recent, also while picking, and legacy adapters show no sources", async () => {
  let app;
  const { calls, adapter } = spy(sourceLibrary({ documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [] }));
  app = await setup({ document: withImage({ asset: { provider: "experience", id: "yoga" }, attrs: { alt: "朝ヨガ" } }), assets: adapter });
  try {
    await tool("接続"); assert.equal(button("最近使った").getAttribute("aria-pressed"), "false"); assert.equal("recent" in calls.lists.at(-1), false);
    await click("最近使った");
    assert.equal(button("最近使った").getAttribute("aria-pressed"), "true"); assert.equal(calls.lists.at(-1).recent, true); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像"); await click("画像を置き換え");
    assert.equal(button("最近使った").getAttribute("aria-pressed"), "true"); assert.equal(calls.lists.at(-1).recent, true); assert.equal(calls.lists.at(-1).kind, "image");
  } finally { await app.cleanup(); }
  const legacy = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try { await tool("アセット"); assert.equal(button("最近使った"), undefined); assert.equal(document.querySelector('[aria-label="アセットの出所"]'), null); } finally { await legacy.cleanup(); }
});
// 保存状態・自動保存・端末内の復元・競合の比較・版履歴（docs/save-history-contract.md）
