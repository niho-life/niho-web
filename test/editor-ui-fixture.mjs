import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findLayer } from "./editor-layer-fixtures.mjs";
import { JSDOM } from "jsdom";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const { renderPageToHtml } = await import("@niho/web/server");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const flush = () => act(async () => {});
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);
const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
async function layerById(nodeId) {
  return findLayer(() => document.querySelector(`[data-node-id="${nodeId}"] button.e-layer`), async (toggle) => { await act(async () => toggle.click()); await flush(); });
}
async function clickLayer(nodeId) { const target = await layerById(nodeId); assert.ok(target, nodeId); await act(async () => target.click()); await flush(); }
async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await act(async () => target.click()); await flush(); }
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
  // ページを開き直すと adapter が保存済み文書を読み込む。
  const render = async () => {
    await act(async () => root.render(createElement(PageEditor, { key: ++mount, adapter, ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.insertableBlocks ? { insertableBlocks: options.insertableBlocks } : {}), ...(options.assets ? { assets: options.assets } : {}), ...options.props }))); await flush();
    const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  };
  await render();
  return { calls, adapter, root, reload: render, stored: () => stored, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
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
async function tool(name) { const label = name === "アセット" && !document.querySelector('.e-tools button[title="アセット"]') ? "アップロード" : name; const target = document.querySelector(`.e-tools button[title="${label}"]`); assert.ok(target, label); await act(async () => target.click()); await flush(); }
const settle = async () => { await flush(); await flush(); };
async function clickCanvas(nodeId) {
  const frame = document.querySelector("iframe");
  await act(async () => frame.contentDocument.querySelector(`[data-nw-node="${nodeId}"]`).dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true }))); await settle();
}
const canvasNode = (nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-nw-node="${nodeId}"]`);
async function shortcut(target, key, modifiers = {}, focus = true) {
  assert.ok(target, key);
  const event = new target.ownerDocument.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...modifiers });
  await act(async () => { if (focus) target.focus(); target.dispatchEvent(event); }); await settle();
  return event.defaultPrevented;
}
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

export { PageEditor, act, button, buttonIn, canvasNode, change, click, clickCanvas, clickLayer, clickPage, createElement, dialog, dom, editorTab, fixture, flush, historyButton, historyHost, input, inputIn, layerById, pageHost, pageRow, panel, press, renderPageToHtml, settle, setup, shortcut, sitePages, tool, versionRows };
