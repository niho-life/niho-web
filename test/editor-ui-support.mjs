import { createTestClock } from "./test-clock.mjs";

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { findLayer } from "./editor-layer-fixtures.mjs";

import { JSDOM } from "jsdom";

import { createMemoryPageOperationHost } from "../examples/memory-page-operation-host.mjs";

import { createPageEditingApi } from "@niho/web/editing-api";

import { createPageEditingApiClient } from "@niho/web/editing-client";

import { editDocumentById } from "@niho/web/editor-model";

import { createBlankEmbedRegistry, pageScope, parsePageDocument } from "@niho/web/core";

import { editorShortcuts } from "../dist/editor-shortcuts.js";

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });

for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export const { createElement, act } = await import("react");

export const { createRoot } = await import("react-dom/client");

export const { PageEditor } = await import("@niho/web/editor");

export const { createMemoryAssetLibrary } = await import("../examples/memory-asset-library.mjs");

export const { renderPageToHtml } = await import("@niho/web/server");

export const { parseResolvedAssets, uniqueAssetReferences } = await import("@niho/web/assets");

export const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

export const flush = () => wait(0);

export const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);

export const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");

export async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }

export async function layerById(nodeId) {
  return findLayer(() => document.querySelector(`[data-node-id="${nodeId}"] button.e-layer`), async (toggle) => { await act(async () => toggle.click()); await flush(); });
}

export async function clickLayer(nodeId) { const target = await layerById(nodeId); assert.ok(target, nodeId); await act(async () => target.click()); await flush(); }

export async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await act(async () => target.click()); await flush(); }

let renderCurrentEditor = async () => {};
export const reloadEditor = (...args) => renderCurrentEditor(...args);

export const pageRow = (title) => [...document.querySelectorAll("button.e-page")].find((node) => node.querySelector(".e-page-name")?.textContent === title);

export async function clickPage(title) { const target = pageRow(title); assert.ok(target, title); await act(async () => target.click()); await flush(); }

export async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  if (target.tagName !== "SELECT") await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}

export async function setup(options = {}) {
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
  await render(); renderCurrentEditor = render;
  return { calls, adapter, root, stored: () => stored, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

export const sitePages = () => [
  { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
  { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about" },
  { siteId: "demo", pageId: "badminton", locale: "ja-JP", title: "バドミントン", path: "/circles/badminton" },
  { siteId: "demo", pageId: "go", locale: "ja-JP", title: "囲碁", path: "/circles/kamakura-go", visibility: "private" },
  { siteId: "demo", pageId: "experience", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template" },
  { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared" }
];

export function pageHost(overrides = {}) {
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

export const dialog = () => document.querySelector('[role="dialog"]');

export async function panel(name) {
  const select = document.querySelector('.e-inspector-context select[aria-label="編集する対象"]');
  assert.ok(select, name); await change(select, name === "ページ" ? "page" : "site");
  return document.querySelector(".e-right .e-inspector-content");
}

export const inputIn = (root, text) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");

export const buttonIn = (root, text) => [...root.querySelectorAll("button")].find((node) => node.textContent === text);

export async function press(target) { assert.ok(target); await act(async () => target.click()); await flush(); }

export const treeShape = (list = document.querySelector(".e-page-tree")) => [...list.children].map((item) => {
  const folder = item.querySelector(":scope > .e-folder");
  return folder ? { [folder.textContent]: treeShape(item.querySelector(":scope > ul")) } : item.querySelector(".e-page-name").textContent;
});

export const mountedAssetPanel = () => document.querySelector('[aria-label="アセットライブラリ"]');

export const assetPanel = () => { const panel = mountedAssetPanel(); return panel && !panel.closest("[hidden]") ? panel : null; };

export async function tool(name) { const label = name === "アセット" && !document.querySelector('.e-tools button[title="アセット"]') ? "アップロード" : name; const target = document.querySelector(`.e-tools button[title="${label}"]`); assert.ok(target, label); await act(async () => target.click()); await flush(); }

export const assetCard = (name) => [...(assetPanel()?.querySelectorAll(".e-asset-card") ?? [])].find((node) => node.getAttribute("aria-label").startsWith(`${name}（`));

export const settle = async () => { await flush(); await flush(); };

export async function chooseAsset(name) { const target = assetCard(name); assert.ok(target, name); await act(async () => target.click()); await settle(); }

export async function uploadFiles(files) {
  const target = assetPanel().querySelector('input[type="file"]'); assert.ok(target, "file input");
  Object.defineProperty(target, "files", { configurable: true, value: files });
  await act(async () => target.dispatchEvent(new dom.window.Event("change", { bubbles: true }))); await settle();
}

export async function clickCanvas(nodeId) {
  const frame = document.querySelector("iframe");
  await act(async () => frame.contentDocument.querySelector(`[data-nw-node="${nodeId}"]`).dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true }))); await settle();
}

export const canvasNode = (nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-nw-node="${nodeId}"]`);

export const canvasBody = () => document.querySelector("iframe").contentDocument.body;

export const layerButton = (id) => document.querySelector(`[data-node-id="${id}"] button.e-layer`);

export async function shortcut(target, key, modifiers = {}, focus = true) {
  assert.ok(target, key);
  const event = new target.ownerDocument.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...modifiers });
  await act(async () => { if (focus) target.focus(); target.dispatchEvent(event); }); await settle();
  return event.defaultPrevented;
}

export const commandDialog = () => document.querySelector('[role="dialog"][aria-label="コマンドパレット"]');

export const canvasOrder = (id) => [...canvasNode(id).children].map((node) => node.dataset.nwNode);

export async function dragEvent(target, type, dataTransfer, options = {}) {
  const event = new target.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, ...options });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  await act(async () => target.dispatchEvent(event));
  await settle();
}

export async function pointer(target, type, clientY) {
  const event = new target.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => target.dispatchEvent(event));
  await settle();
}

export const png = (name, size) => new File([new Uint8Array(size)], name, { type: "image/png" });

export const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];

export const garden = { id: "garden", name: "庭の緑.png", mimeType: "image/png", bytes: 2048, width: 600, height: 400, alt: "庭の緑", src: "/media/garden.png", thumbnailUrl: "/media/garden.png" };

export function withImage(node = { attrs: { src: "/photo.webp", alt: "古い写真" } }) { const doc = structuredClone(fixture); doc.body[0].children.push({ type: "element", id: "photo", tag: "img", children: [], ...node }); return doc; }

export const night = { id: "night", name: "夜の海.avif", mimeType: "image/avif", bytes: 1024, width: 1200, height: 630, alt: "夜の海", src: "/media/night.avif", thumbnailUrl: "/media/night.avif" };

export const coverFrame = (root) => root.querySelector(".e-cover-frame");

export const coverRemove = (root) => root.querySelector(".e-cover-remove") ?? undefined;

export const caps = (extra = {}) => ({ upload: false, editMetadata: false, delete: false, folders: false, acquire: false, ...extra });

export const yoga = { id: "yoga", name: "朝ヨガ.png", mimeType: "image/png", bytes: 3072, width: 800, height: 600, alt: "海辺で朝ヨガ", sourceLabel: "体験「鎌倉の朝ヨガ」の写真", src: "/cms/yoga.png", thumbnailUrl: "/cms/yoga.png" };

export const wave = { id: "wave", name: "波.png", mimeType: "image/png", bytes: 1024, width: 640, height: 480, alt: "波の模様", src: "/stock/wave.png", thumbnailUrl: "/stock/wave.png",
  license: { name: "テスト用ライセンス", url: "https://license.example.test/terms", attribution: "見本ストック", terms: "テストの中だけで使えます。" } };

export function sourceLibrary({ stock = false, documents } = {}) {
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

export function spy(library) {
  const calls = { lists: [], acquires: [] };
  return { calls, adapter: { ...library, listAssets: async (query, signal) => { calls.lists.push(structuredClone(query)); return library.listAssets(query, signal); },
    acquireAsset: async (request, signal) => { calls.acquires.push(structuredClone(request)); return library.acquireAsset(request, signal); } } };
}

export const sourceTabs = () => [...assetPanel().querySelectorAll('[aria-label="アセットの出所"] button')];

export const cardNames = () => [...assetPanel().querySelectorAll(".e-asset-card")].map((node) => node.getAttribute("aria-label").split("（")[0]);

export const assetButton = (text) => [...(assetPanel()?.querySelectorAll("button") ?? [])].find((node) => node.textContent === text);

export const { createBrowserRecoveryStore, RecoveryTooLargeError } = await import("@niho/web/history");

export const status = () => document.querySelector('[role="status"]').textContent;

export const toolbarButton = (text) => [...document.querySelectorAll(".e-inspector-actions button,.e-preview-exit")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);

export const homeTarget = { siteId: "demo", pageId: "home", locale: "ja-JP" };

export const localTime = (value) => { const date = new Date(value), pad = (number) => String(number).padStart(2, "0"); return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };

export function memoryStorage() {
  const data = new Map();
  return { get length() { return data.size; }, key: (index) => [...data.keys()][index] ?? null, getItem: (key) => data.has(key) ? data.get(key) : null, setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); } };
}

export const recoveryKey = "niho-web:recovery:v1:staff:demo/home/ja-JP";

export function historyHost(overrides = {}) {
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

export const versionRows = () => [...document.querySelectorAll(".e-versions .e-version")];

export const historyButton = () => document.querySelector('.e-tools [aria-label="履歴"]');

export function pageOperationsAdapter(normalize = (document) => document) {
  let canonical = parsePageDocument(fixture), version = "v1";
  const operations = [];
  return {
    operations, saved: () => canonical,
    external(document) { canonical = { ...document, revision: canonical.revision + 1 }; version = `v${canonical.revision}`; },
    adapter: {
      async readDocument() { return { version, document: structuredClone(canonical) }; },
      async applyOperations(request) {
        operations.push(request);
        if (request.baseVersion !== version) return { status: "conflict" };
        let next = canonical;
        for (const operation of request.operations) next = editDocumentById(next, operation);
        canonical = { ...normalize(next), revision: canonical.revision + 1 };
        version = `v${canonical.revision}`;
        return { status: "applied", version, revision: canonical.revision, document: structuredClone(canonical) };
      }
    },
  };
}

const { test, wait } = createTestClock(act);

export { assert, readFileSync, findLayer, JSDOM, createMemoryPageOperationHost, createPageEditingApi, createPageEditingApiClient, editDocumentById, createBlankEmbedRegistry, pageScope, parsePageDocument, editorShortcuts };

export { test, wait };
