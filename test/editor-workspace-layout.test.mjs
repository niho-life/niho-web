import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const { useBreakpointSettings } = await import("../dist/editor-breakpoints.js");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const pages = [
  { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
  { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about" },
  { siteId: "demo", pageId: "experience", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template" },
  { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared" }
];
const crumb = () => ({ site: document.querySelector(".e-crumb-site")?.textContent, page: document.querySelector(".e-crumb-page")?.textContent, detail: document.querySelector(".e-crumb-path")?.textContent });
const pageRow = (title) => [...document.querySelectorAll("button.e-page")].find((node) => node.querySelector(".e-page-name")?.textContent === title);
async function click(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function change(target, value) { assert.ok(target); await act(async () => { const prototype = target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, String(value)); target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); await flush(); }
async function setup(props = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => pages,
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId }, version: "v1" }),
    saveDraft: async () => { throw new Error("not used"); }, prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); }
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...props }))); await flush();
  const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  return { cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("the editor opens on the page list and the left header always names the site, the open page and its path", async () => {
  const app = await setup();
  try {
    assert.equal(document.querySelector('.e-tools button[aria-label="ページ"]').getAttribute("aria-pressed"), "true");
    assert.equal(pageRow("ホーム").getAttribute("aria-current"), "page");
    assert.deepEqual(crumb(), { site: "デモサイト", page: "ホーム", detail: "/" });
    assert.equal(document.querySelector(".e-project-context").getAttribute("title"), "デモサイト / ホーム · /");
    assert.equal(document.querySelector(".e-crumb-sep").getAttribute("aria-hidden"), "true", "the slash is decoration");
    await click(pageRow("私たちについて"));
    assert.deepEqual(crumb(), { site: "デモサイト", page: "私たちについて", detail: "/about" });
    assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page"); assert.equal(pageRow("ホーム").getAttribute("aria-current"), null);
    await click(pageRow("体験詳細"));
    assert.deepEqual(crumb(), { site: "デモサイト", page: "体験詳細", detail: "/experiences/[slug]" });
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "コンポーネントを編集"));
    assert.deepEqual(crumb(), { site: "デモサイト", page: "ヘッダー", detail: "サイト全体のコンポーネント" }, "shared components show their kind instead of a path");
  } finally { await app.cleanup(); }
});

test("the workspace keeps three fixed columns on desktop, overlays panels under 820px and wraps the inspector header at 320px", async () => {
  const app = await setup();
  try {
    const css = document.querySelector(".nw-editor style").textContent;
    assert.ok(css.includes(".nw-editor{") && css.includes("height:100dvh;max-height:100dvh") && css.includes("overflow:hidden"), "the shell owns the viewport height so the host page does not scroll");
    assert.ok(css.includes("grid-template-columns:350px minmax(0,1fr) 300px"));
    assert.ok(css.includes("@media(max-width:820px)") && css.includes(".e-left{left:0;width:min(350px,calc(100vw - 50px))") && css.includes(".e-right{right:0;left:auto;width:min(300px,calc(100vw - 50px))"), "narrow screens overlay the panels on the canvas");
    const narrow = css.slice(css.indexOf("@media(max-width:480px)"));
    assert.ok(narrow.includes(".nw-editor .e-inspector-context{flex-wrap:wrap"), "the inspector header wraps so the close toggle stays reachable");
    assert.ok(narrow.includes(".nw-editor .e-inspector-context strong{flex:1 1 100%}"));
    assert.ok(narrow.includes(".nw-editor .e-canvas-tools{height:auto;flex-wrap:wrap;gap:3px;padding:4px 5px}") && narrow.includes(".nw-editor .e-width-field{width:70px}"), "the viewport bar wraps inside a 320px stage");
    assert.ok(narrow.includes(".nw-editor .e-dialog-backdrop{align-items:end;padding:0}") && narrow.includes(".nw-editor .e-dialog-actions{position:sticky"), "editing mode keeps close and save reachable at narrow widths");
    for (const label of ["左パネルを閉じる", "右パネルを閉じる", "表示幅", "PC 1280px", "タブレット 768px", "モバイル 375px", "元に戻す", "下書き保存", "公開"]) assert.ok(document.querySelector(`[aria-label="${label}"]`), label);
    await click(document.querySelector('[aria-label="右パネルを閉じる"]'));
    assert.equal(document.querySelector('[aria-label="インスペクタ"]').hidden, true);
    assert.ok(document.querySelector('.e-canvas-tools [aria-label="右パネルを開く"]'), "the viewport bar offers the way back");
  } finally { await app.cleanup(); }
});

test("site-defined viewport presets select the four responsive ranges", async () => {
  const app = await setup({ breakpoints: [
    { minWidth: 691, label: "タブレット", previewWidth: 840 },
    { minWidth: 991, label: "スモール", previewWidth: 991 },
    { minWidth: 1280, label: "PC", previewWidth: 1280 }
  ], mobilePreviewWidth: 480 });
  try {
    const button = (name) => document.querySelector(`.e-device-group [aria-label="${name}"]`);
    for (const name of ["PC 1280px", "スモール 991px", "タブレット 840px", "モバイル 480px"]) assert.ok(button(name), name);
    await click(button("タブレット 840px"));
    assert.equal(document.querySelector('[aria-label="表示幅"]').value, "840");
    assert.equal(button("タブレット 840px").getAttribute("aria-pressed"), "true");
    await click(button("モバイル 480px"));
    assert.equal(document.querySelector('[aria-label="表示幅"]').value, "480");
    assert.equal(button("モバイル 480px").getAttribute("aria-pressed"), "true");
  } finally { await app.cleanup(); }
});

test("viewport edges change only the preview width by keyboard, including the bounds", async () => {
  const app = await setup();
  try {
    const edge = document.querySelector('[aria-label="画面右端で表示幅を変更"]');
    const field = document.querySelector('[aria-label="表示幅"]');
    assert.ok(edge && document.querySelector('[aria-label="画面左端で表示幅を変更"]'));
    const press = async (key, shiftKey = false) => act(async () => edge.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
    await press("ArrowLeft", true); assert.equal(field.value, "1270");
    await press("Home"); assert.equal(field.value, "320");
    await press("ArrowLeft"); assert.equal(field.value, "320");
    await press("End"); assert.equal(field.value, "1920");
    assert.equal(document.querySelector("iframe").style.width, "1920px");
  } finally { await app.cleanup(); }
});

test("editing mode remains keyboard reachable and shows legacy host values as read-only", async () => {
  const app = await setup();
  try {
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "編集モード"));
    const dialog = document.querySelector('[role="dialog"][aria-label="編集モード"]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /読み取り専用/);
    assert.equal(dialog.querySelector('[aria-label="タブレットの開始幅"]').value, "768");
    assert.equal([...dialog.querySelectorAll("button")].find((node) => node.textContent === "サイト設定を保存").disabled, true);
    await act(async () => dialog.querySelector('[aria-label="編集モードを閉じる"]').dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="dialog"][aria-label="編集モード"]'), null);
  } finally { await app.cleanup(); }
});

test("site breakpoint settings save with CAS, re-read after save, and expose conflict reload", async () => {
  let settings = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [
    { name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "Small", minWidth: 991, previewWidth: 991 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }
  ] }, version = "b.1", reads = 0, conflict = false;
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }], listPages: async () => pages,
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId }, version: "v1" }),
    saveDraft: async () => { throw new Error("not used"); }, prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); },
    breakpointSettings: {
      read: async () => { reads++; return { settings: structuredClone(settings), version }; },
      save: async (request) => { if (conflict) return { status: "conflict" }; assert.equal(request.expectedVersion, version); settings = structuredClone(request.settings); version = `b.${Number(version.slice(2)) + 1}`; return { status: "saved", version }; }
    }
  };
  const app = await setup({ adapter });
  try {
    assert.equal(reads, 1);
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "編集モード"));
    await change(document.querySelector('[aria-label="タブレットの開始幅"]'), 700);
    const save = [...document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent === "サイト設定を保存");
    assert.equal(save.disabled, true, "changing a start width requires explicit impact confirmation");
    assert.match(document.querySelector(".e-breakpoint-impact").textContent, /タブレット: 691px → 700px/);
    assert.match(document.querySelector(".e-breakpoint-impact").textContent, /現在のページに 0件/);
    await click(document.querySelector(".e-breakpoint-impact input[type=checkbox]"));
    await click(save);
    assert.equal(reads, 2, "saved settings are re-read instead of trusting the PUT response");
    assert.equal(document.querySelector('[aria-label="タブレットの開始幅"]').value, "700");
    conflict = true;
    await change(document.querySelector('[aria-label="タブレットのプレビュー幅"]'), 850);
    await click([...document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent === "サイト設定を保存"));
    assert.match(document.querySelector(".e-breakpoint-conflict").textContent, /再読み込み/);
    const reload = [...document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent === "編集中の変更を破棄して再読み込み");
    assert.ok(reload, "conflict reload explicitly says that the draft is discarded");
    await click(reload);
    assert.equal(reads, 3);
  } finally { await app.cleanup(); }
});

test("breakpoint read failure offers retry and PC-only settings show a PC base preset", async () => {
  let reads = 0;
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }], listPages: async () => pages,
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId }, version: "v1" }),
    saveDraft: async () => { throw new Error("not used"); }, prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); },
    breakpointSettings: {
      read: async () => { reads++; if (reads === 1) throw new Error("設定の読込に失敗しました。"); return { settings: { base: { name: "PC", previewWidth: 1280 }, breakpoints: [] }, version: "b.1" }; },
      save: async () => ({ status: "saved", version: "b.2" })
    }
  };
  const app = await setup({ adapter });
  try {
    await click([...document.querySelectorAll("button")].find((node) => node.textContent === "編集モード"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /設定の読込に失敗/);
    await click([...document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent === "設定を再試行"));
    assert.equal(reads, 2);
    assert.ok(document.querySelector('[aria-label="PCのプレビュー幅"]'));
    assert.equal(document.querySelector('[aria-label="モバイルのプレビュー幅"]'), null);
    assert.ok(document.querySelector('.e-device-group [aria-label="PC 1280px"]'));
    assert.equal(document.querySelector('.e-device-group [aria-label^="モバイル "]'), null, "PC-only must not be labeled as mobile");
  } finally { await app.cleanup(); }
});

test("breakpoint settings never reuse a loaded snapshot after the site id changes", async () => {
  const siteA = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const siteB = { base: { name: "PC", previewWidth: 1280 }, breakpoints: [] };
  const fallback = { base: { name: "Small", previewWidth: 991 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  let resolveB;
  const adapter = { breakpointSettings: {
    read: (siteId) => siteId === "site-a" ? Promise.resolve({ settings: siteA, version: "a.1" }) : new Promise((resolve) => { resolveB = resolve; }),
    save: async () => ({ status: "saved", version: "unused" })
  } };
  const Harness = ({ siteId }) => {
    const state = useBreakpointSettings(adapter, siteId, fallback);
    return createElement("output", { id: "breakpoint-state", "data-editable": String(state.editable) }, JSON.stringify(state.settings));
  };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Harness, { siteId: "site-a" }))); await flush();
    assert.match(document.querySelector("#breakpoint-state").textContent, /Mobile/);
    await act(async () => root.render(createElement(Harness, { siteId: "site-b" })));
    assert.match(document.querySelector("#breakpoint-state").textContent, /Small/, "the new site's fallback is used while its read is pending");
    assert.doesNotMatch(document.querySelector("#breakpoint-state").textContent, /Mobile/);
    assert.equal(document.querySelector("#breakpoint-state").dataset.editable, "false");
    await act(async () => resolveB({ settings: siteB, version: "b.1" })); await flush();
    assert.match(document.querySelector("#breakpoint-state").textContent, /PC/);
    assert.equal(document.querySelector("#breakpoint-state").dataset.editable, "true");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("the demo host embeds the editor below a slim banner without page scrolling", () => {
  const source = readFileSync(new URL("../examples/editor-demo.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("body{margin:0;display:flex;flex-direction:column;overflow:hidden"));
  assert.ok(source.includes("#root>.nw-editor{height:100%;max-height:100%}"));
  assert.ok(!source.includes("padding:20px"), "no outer padding around the workspace");
});
