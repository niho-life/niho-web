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
const text = (value) => ({ type: "text", text: value });
const element = (id, tag, children = [], extra = {}) => ({ type: "element", id, tag, children, ...extra });
/** 種類ごとのレイヤーを 1 つずつ持つ文書: セクション > 見出し・段落・箇条書き・画像・リンク、ボックス、業務ブロック。 */
const document_ = {
  ...fixture, body: [
    element("hero", "section", [element("heading", "h2", [text("見出し")]), element("lead", "p", [text("本文")]),
      element("list", "ul", [element("item", "li", [text("項目")])]), element("photo", "img", [], { attrs: { src: "/photo.webp", alt: "" } }), element("link", "a", [text("リンク")], { attrs: { href: "/" } })]),
    element("box", "div", [element("note", "p", [text("補足")])]),
    { type: "component", id: "notice", block: "Notice", props: { heading: "お知らせ" } }
  ]
};
const blocks = { Notice: { label: "お知らせ", props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("p", null, heading) } };
const tool = (name) => [...document.querySelectorAll(".e-tools button")].find((node) => node.getAttribute("aria-label") === name);
const row = (id) => document.querySelector(`[data-node-id="${id}"]`);
async function click(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }],
    readDocument: async () => ({ document: structuredClone(document_), version: "v1" }),
    saveDraft: async () => { throw new Error("not used"); }, prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); }
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, blocks, ...options }))); await flush();
  const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  return { cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("the tool rail shows one line icon per STUDIO tool, names it for assistive technology and marks the open panel", async () => {
  const app = await setup();
  try {
    const buttons = [...document.querySelectorAll(".e-tools button")].filter((node) => !node.classList.contains("e-panel-toggle"));
    assert.deepEqual(buttons.map((node) => node.getAttribute("aria-label")), ["追加", "ページ", "レイヤー", "スタイル", "コンポーネント"], "without an asset adapter the upload, stock and connect tools stay hidden");
    for (const button of buttons) {
      const icon = button.querySelector("svg.e-tool-icon");
      assert.ok(icon, button.getAttribute("aria-label"));
      assert.equal(icon.getAttribute("aria-hidden"), "true"); assert.equal(icon.getAttribute("stroke-width"), "1.5"); assert.equal(icon.getAttribute("viewBox"), "0 0 24 24");
      assert.ok(button.querySelector(".e-vh")?.textContent, "the visually hidden text repeats the name");
    }
    assert.equal(tool("ページ").getAttribute("aria-pressed"), "true"); assert.equal(tool("レイヤー").getAttribute("aria-pressed"), "false");
    assert.ok(tool("追加").querySelector('rect[fill="currentColor"]'), "add uses the three solid squares and a plus");
    assert.ok(tool("スタイル").querySelector("circle"), "styles pairs an A with a small circle");
    await click(tool("レイヤー"));
    assert.equal(tool("レイヤー").getAttribute("aria-pressed"), "true"); assert.equal(tool("ページ").getAttribute("aria-pressed"), "false");
    assert.equal(document.querySelector('[aria-label="レイヤー一覧"]').hidden, false); assert.equal(document.querySelector('[aria-label="ページ一覧"]').hidden, true);
    const css = document.querySelector(".nw-editor style").textContent;
    assert.ok(css.includes(".nw-editor .e-tools button{display:flex;width:32px;height:32px"), "32px buttons in the 44px rail");
    assert.ok(css.includes(".nw-editor .e-tool-icon{display:block;width:18px;height:18px"));
    // 左パネルの開閉ボタンと上段の操作アイコンも、ツールと同じ 18px・線幅 1.5（24 のマス目）。線の太さと大きさを混ぜない。
    const toggle = document.querySelector(".e-tools .e-panel-toggle svg"); assert.ok(toggle, "the left rail starts with the panel toggle");
    assert.equal(toggle.getAttribute("stroke-width"), "1.5"); assert.equal(toggle.getAttribute("viewBox"), "0 0 24 24");
    const actionIcons = [...document.querySelectorAll(".nw-editor svg.e-action-icon")]; assert.ok(actionIcons.length >= 5, "the top actions draw with the same icon set");
    for (const icon of actionIcons) assert.equal(icon.getAttribute("stroke-width"), "1.5");
    assert.ok(css.includes(".nw-editor .e-action-icon{display:block;width:18px;height:18px}"), "the action icons are 18px like the tool icons");
    assert.ok(css.includes(".nw-editor .e-tools button[aria-pressed=true]{border-color:transparent;background:var(--nw-pressed);color:var(--e-ink)}"), "the open tool has a small grey square");
    assert.ok(css.includes("--nw-pressed:#e6e6e6"), "…drawn from the shared tokens");
  } finally { await app.cleanup(); }
});

test("the rail keeps the selected tool distinct from keyboard focus and scrolls on short screens", async () => {
  const app = await setup();
  try {
    const nav = document.querySelector('nav[aria-label="編集ツール"]');
    const buttons = [...nav.querySelectorAll("button:not(:disabled)")];
    const press = async (key) => act(async () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    tool("ページ").focus();
    await press("End"); assert.equal(document.activeElement, buttons.at(-1));
    await press("ArrowDown"); assert.equal(document.activeElement, buttons[0]);
    await press("Home"); assert.equal(document.activeElement, buttons[0]);
    await press("ArrowUp"); assert.equal(document.activeElement, buttons.at(-1));
    assert.equal(tool("ページ").getAttribute("aria-pressed"), "true", "focus must not switch the open panel");
    const css = document.querySelector(".nw-editor style").textContent;
    assert.match(css, /\.nw-editor \.e-tools\{[^}]*overflow-y:auto;overscroll-behavior:contain/);
  } finally { await app.cleanup(); }
});

test("asset tools split into upload, stock and connect when the host lists providers, each with its own icon", async () => {
  const assets = { listProviders: async () => [], listAssets: async () => ({ assets: [], folders: [] }), resolveAssets: async () => ({}) };
  const app = await setup({ assets });
  try {
    const labels = [...document.querySelectorAll(".e-tools button")].map((node) => node.getAttribute("aria-label"));
    assert.deepEqual(labels.slice(-5), ["スタイル", "アップロード", "ストック", "接続", "コンポーネント"]);
    const shapes = ["アップロード", "ストック", "接続"].map((name) => tool(name).querySelector("svg").innerHTML);
    assert.equal(new Set(shapes).size, 3, "the three asset tools are visually distinct");
    assert.ok(tool("ストック").querySelector("rect") && tool("ストック").querySelector("circle"), "stock is a picture with a plus");
    assert.equal(tool("接続").querySelectorAll('circle[fill="currentColor"]').length, 2, "connect shows two toggles");
  } finally { await app.cleanup(); }
});

test("layer rows carry a glyph per element kind, and the expand chevron keeps its label and keyboard behaviour", async () => {
  const app = await setup();
  try {
    await click(tool("レイヤー"));
    const glyph = (id) => row(id).dataset.layerGlyph;
    assert.deepEqual([glyph("hero"), glyph("heading"), glyph("lead"), glyph("list"), glyph("photo"), glyph("link"), glyph("box"), glyph("notice")], ["section", "text", "text", "list", "image", "text", "box", "block"]);
    assert.equal(row("item").dataset.layerGlyph, "box", "list items keep the plain box until they carry text styling of their own");
    for (const id of ["hero", "heading", "list", "photo", "box", "notice"]) {
      const icon = row(id).querySelector("button.e-layer svg.e-layer-icon");
      assert.ok(icon, id); assert.equal(icon.getAttribute("aria-hidden"), "true");
    }
    assert.ok(row("photo").querySelector('.e-layer-icon path[fill="currentColor"]'), "the image glyph fills its upper-left half");
    assert.ok(row("notice").querySelector(".e-layer-icon circle"), "a business block is a diamond with a dot");
    const toggle = row("hero").querySelector(".e-layer-toggle");
    assert.equal(toggle.getAttribute("aria-label"), "セクションを閉じる"); assert.ok(toggle.querySelector("svg.e-layer-chevron.is-open"));
    assert.equal(toggle.tabIndex, -1, "the chevron is reachable from the tree item, not a second tab stop");
    await click(toggle);
    assert.equal(toggle.getAttribute("aria-label"), "セクションを開く"); assert.equal(toggle.querySelector("svg.e-layer-chevron").classList.contains("is-open"), false);
    assert.equal(row("heading"), null, "collapsed children leave the tree");
    const item = row("hero").querySelector("button.e-layer");
    await act(async () => item.focus());
    await act(async () => item.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))); await flush();
    assert.ok(row("heading"), "ArrowRight reopens the section");
    assert.equal(row("hero").querySelector("button.e-layer").getAttribute("aria-expanded"), "true");
    const css = document.querySelector(".nw-editor style").textContent;
    assert.ok(css.includes(".nw-editor .e-layer-row[data-layer-glyph=part] .e-layer-icon,.nw-editor .e-layer-row[data-layer-glyph=block] .e-layer-icon{color:var(--e-part)}"), "component glyphs use the component purple");
    assert.ok(css.includes(".nw-editor .e-layer-chevron.is-open{transform:rotate(90deg)}"));
  } finally { await app.cleanup(); }
});
