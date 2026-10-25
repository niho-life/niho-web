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
async function setup() {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => pages,
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId }, version: "v1" }),
    saveDraft: async () => { throw new Error("not used"); }, prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); }
  };
  await act(async () => root.render(createElement(PageEditor, { adapter }))); await flush();
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
    assert.ok(css.includes("grid-template-columns:296px minmax(0,1fr) 300px"));
    assert.ok(css.includes("@media(max-width:820px)") && css.includes("width:min(296px,calc(100vw - 44px))"), "narrow screens overlay the panels on the canvas");
    const narrow = css.slice(css.indexOf("@media(max-width:480px)"));
    assert.ok(narrow.includes(".nw-editor .e-inspector-context{flex-wrap:wrap"), "the inspector header wraps so the close toggle stays reachable");
    assert.ok(narrow.includes(".nw-editor .e-inspector-context strong{flex:1 1 100%}"));
    assert.ok(narrow.includes(".nw-editor .e-canvas-tools{gap:3px;padding:4px 5px}") && narrow.includes(".nw-editor .e-width-field{width:70px}"), "the viewport bar fits inside a 320px stage");
    for (const label of ["左パネルを閉じる", "右パネルを閉じる", "表示幅", "PC 1280px", "モバイル 375px", "元に戻す", "下書き保存", "公開"]) assert.ok(document.querySelector(`[aria-label="${label}"]`), label);
    await click(document.querySelector('[aria-label="右パネルを閉じる"]'));
    assert.equal(document.querySelector('[aria-label="インスペクタ"]').hidden, true);
    assert.ok(document.querySelector('.e-canvas-tools [aria-label="右パネルを開く"]'), "the viewport bar offers the way back");
  } finally { await app.cleanup(); }
});

test("the demo host embeds the editor below a slim banner without page scrolling", () => {
  const source = readFileSync(new URL("../examples/editor-demo.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("body{margin:0;display:flex;flex-direction:column;overflow:hidden"));
  assert.ok(source.includes("#root>.nw-editor{height:100%;max-height:100%}"));
  assert.ok(!source.includes("padding:20px"), "no outer padding around the workspace");
});
