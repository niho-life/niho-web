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
async function press(target, key, extra = {}) {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  await act(async () => target.dispatchEvent(event)); await flush();
  return event.defaultPrevented;
}
async function changeInput(target, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush();
}
const layer = (id) => row(id)?.querySelector("button.e-layer");
const layerToggle = (id) => row(id)?.querySelector(".e-layer-toggle");
const layerTree = () => document.querySelector(".e-layer-list");
const canvasNode = (id) => document.querySelector("iframe").contentDocument.querySelector(`[data-nw-node="${id}"]`);
async function clickCanvas(id) {
  const node = canvasNode(id);
  await act(async () => node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true })));
  await flush();
}
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const { source = document_, nameSupport = false, readOnly, locks, ...props } = options;
  let stored = structuredClone(source);
  const writes = [];
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }],
    readDocument: async () => ({ document: structuredClone(stored), version: `v${stored.revision}`, ...(readOnly ? { readOnly } : {}), ...(locks ? { locks } : {}) }),
    ...(nameSupport ? { discoverPageNodeNames: async () => true } : {}),
    saveDraft: async ({ document }) => {
      writes.push(structuredClone(document));
      stored = { ...structuredClone(document), revision: stored.revision + 1 };
      return { status: "saved", version: `v${stored.revision}`, revision: stored.revision };
    },
    prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); }
  };
  let mount = 0;
  const reload = async () => {
    await act(async () => root.render(createElement(PageEditor, { adapter, blocks, ...props, key: ++mount }))); await flush();
    const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  };
  await reload();
  return { writes, reload, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("the tool rail shows one line icon per STUDIO tool, names it for assistive technology and marks the open panel", async () => {
  const app = await setup();
  try {
    const buttons = [...document.querySelectorAll(".e-tools button")].filter((node) => !node.classList.contains("e-panel-toggle"));
    assert.deepEqual(buttons.map((node) => node.getAttribute("aria-label")), ["追加", "ページ", "レイヤー", "スタイル", "コンポーネント", "コンテンツ編集"], "without an asset adapter the upload, stock and connect tools stay hidden");
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

test("content edit rail finds document text and opens the existing text inspector", async () => {
  const app = await setup();
  try {
    await click(tool("コンテンツ編集"));
    const panel = document.querySelector('section[aria-label="コンテンツ編集"]');
    assert.equal(panel.hidden, false);
    assert.equal(tool("コンテンツ編集").getAttribute("aria-pressed"), "true");
    const heading = [...panel.querySelectorAll(".e-content-list button")].find((item) => item.textContent.includes("見出し"));
    assert.ok(heading, "the heading is available as content");
    await click(heading);
    assert.equal(heading.getAttribute("aria-current"), "true");
    assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]')?.textContent, "テキスト");
    assert.equal(tool("コンテンツ編集").getAttribute("aria-pressed"), "true");
  } finally { await app.cleanup(); }
});

test("asset tools split into upload, stock and connect when the host lists providers, each with its own icon", async () => {
  const assets = { listProviders: async () => [], listAssets: async () => ({ assets: [], folders: [] }), resolveAssets: async () => ({}) };
  const app = await setup({ assets });
  try {
    const labels = [...document.querySelectorAll(".e-tools button")].map((node) => node.getAttribute("aria-label"));
    assert.deepEqual(labels.slice(-6), ["スタイル", "アップロード", "ストック", "接続", "コンポーネント", "コンテンツ編集"]);
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
    assert.equal(row("heading"), null, "branches start closed");
    await click(layerToggle("hero"));
    await click(layerToggle("list"));
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

test("the layer viewport reveals a canvas selection and keeps keyboard order with 1,000 nodes", async () => {
  const source = { ...document_, body: [
    element("many", "section", Array.from({ length: 998 }, (_, i) => element(`item_${i}`, "p", [text(`項目 ${i}`)]))),
    element("last", "p", [text("末尾")])
  ] };
  const app = await setup({ source });
  try {
    await click(tool("レイヤー"));
    const tree = layerTree();
    Object.defineProperty(tree, "clientHeight", { value: 170 });
    assert.deepEqual([...tree.querySelectorAll("[data-node-id]")].map(({ dataset }) => dataset.nodeId), ["many", "last"]);
    await clickCanvas("item_997");
    assert.equal(layer("many"), undefined, "the first rows are outside the render window");
    const lastChild = layer("item_997");
    assert.ok(lastChild);
    assert.equal(lastChild.getAttribute("aria-selected"), "true");
    assert.equal(lastChild.getAttribute("aria-level"), "3");
    assert.equal(lastChild.getAttribute("aria-posinset"), "998");
    assert.equal(lastChild.getAttribute("aria-setsize"), "998", "sibling metadata describes the whole visible tree");
    const top = Number.parseInt(row("item_997").style.top, 10), rowHeight = Number.parseInt(row("item_997").style.height, 10);
    assert.ok(tree.scrollTop <= top && tree.scrollTop + tree.clientHeight >= top + rowHeight);
    assert.ok(tree.querySelectorAll("[data-node-id]").length < 30);

    await act(async () => { tree.scrollTop = 0; tree.dispatchEvent(new dom.window.Event("scroll")); });
    await clickCanvas("item_997");
    assert.ok(tree.scrollTop > 0, "selecting the same canvas element reveals it again");
    const scrolls = [];
    canvasNode("item_997").scrollIntoView = (options) => scrolls.push(options);
    await click(layer("item_997"));
    assert.deepEqual(scrolls, [{ block: "nearest", inline: "nearest" }]);

    await act(async () => layer("item_997").focus());
    await press(document.activeElement, "Home");
    assert.equal(document.activeElement, tree.querySelector(".e-layer-root"));
    assert.equal(tree.scrollTop, 0);
    await press(document.activeElement, "End");
    assert.equal(document.activeElement, layer("last"));
    await press(document.activeElement, "ArrowUp");
    assert.equal(document.activeElement, layer("item_997"));
    await press(document.activeElement, "ArrowLeft");
    assert.equal(document.activeElement, layer("many"));
    assert.equal(document.activeElement.getAttribute("aria-expanded"), "true");
    await press(document.activeElement, "ArrowRight");
    assert.equal(document.activeElement, layer("item_0"));
    assert.deepEqual([...tree.querySelectorAll('[role="treeitem"]')].filter((item) => item.tabIndex === 0), [document.activeElement]);

    await act(async () => { tree.scrollTop = top; tree.dispatchEvent(new dom.window.Event("scroll")); });
    const dragged = row("item_997");
    const dragStart = new dom.window.MouseEvent("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: { setData() {} } });
    await act(async () => dragged.dispatchEvent(dragStart));
    await act(async () => { tree.scrollTop = 0; tree.dispatchEvent(new dom.window.Event("scroll")); });
    assert.equal(row("item_997"), dragged, "scrolling does not remove the active drag source");
    await act(async () => dragged.dispatchEvent(new dom.window.MouseEvent("dragend", { bubbles: true })));
    assert.equal(row("item_997"), null);
  } finally { await app.cleanup(); }
});

test("expanding an unrelated layer does not pull the selected row back into view", async () => {
  const source = { ...document_, body: [
    element("top", "section", [element("top_child", "p", [text("先頭の項目")])]),
    element("many", "section", Array.from({ length: 24 }, (_, i) => element(`item_${i}`, "p", [text(`項目 ${i}`)])))
  ] };
  const app = await setup({ source });
  try {
    await click(tool("レイヤー"));
    const tree = layerTree();
    Object.defineProperty(tree, "clientHeight", { value: 100 });
    await clickCanvas("item_23");
    await act(async () => { tree.scrollTop = 0; tree.dispatchEvent(new dom.window.Event("scroll")); });
    assert.equal(tree.scrollTop, 0);

    await click(layerToggle("top"));
    assert.equal(tree.scrollTop, 0, "expanding an earlier branch keeps the user's scroll position");
    assert.equal(layer("item_23").getAttribute("aria-selected"), "true");
  } finally { await app.cleanup(); }
});

test("search finds the displayed name and full source text, and clear restores collapsed branches", async () => {
  const source = { ...document_, body: [
    element("section", "section", [element("group", "div", [
      element("paragraph", "p", [text("表示ラベルの抜粋よりだいぶ後ろにある本文。".repeat(3) + "内覧予約はこちら")], { name: "ご案内" }),
      element("unrelated", "p", [text("別のお知らせ")])
    ])]),
    element("outside", "section", [element("another", "p", [text("別の段落")])]),
    { type: "component", id: "componentText", block: "Notice", props: { heading: "公開前の予約相談" } }
  ] };
  const app = await setup({ source });
  try {
    await click(tool("レイヤー"));
    const search = document.querySelector(".e-layer-search input");
    await changeInput(search, "予約相談");
    assert.equal(layer("componentText").textContent, "お知らせ");
    await changeInput(search, "内覧予約");
    assert.equal(row("componentText"), null);
    assert.equal(layer("paragraph").textContent, "ご案内");
    assert.equal(layer("section").getAttribute("aria-expanded"), "true");
    assert.equal(layer("group").getAttribute("aria-expanded"), "true");
    assert.equal(row("unrelated"), null);
    assert.equal(row("outside"), null);
    await changeInput(search, "ご案内");
    assert.ok(layer("paragraph"));
    await changeInput(search, "");
    assert.equal(row("paragraph"), null);
    assert.equal(layer("section").getAttribute("aria-expanded"), "false");
  } finally { await app.cleanup(); }
});

test("layer rename supports F2, double-click, undo, clearing, and save", async () => {
  const app = await setup({ nameSupport: true });
  try {
    await click(tool("レイヤー"));
    await clickCanvas("heading");
    await act(async () => layer("heading").focus());
    assert.equal(await press(layer("heading"), "F2"), true);
    const field = () => row("heading").querySelector('input[aria-label="要素の名前"]');
    assert.equal(document.activeElement, field());
    await changeInput(field(), "ヒーロー見出し");
    assert.equal(await press(field(), "Enter", { isComposing: true }), false);
    await press(field(), "Enter");
    assert.equal(layer("heading").textContent, "ヒーロー見出し");
    assert.equal(document.activeElement, layer("heading"));
    const button = (label) => [...document.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
    await click(button("元に戻す"));
    assert.equal(layer("heading").textContent, "見出し");
    await click(button("やり直す"));
    await click(button("下書き保存"));
    assert.equal(app.writes.at(-1).body[0].children[0].name, "ヒーロー見出し");
    await app.reload();
    await click(tool("レイヤー"));
    await clickCanvas("heading");
    assert.equal(layer("heading").textContent, "ヒーロー見出し");
    await act(async () => layer("heading").dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })));
    await changeInput(field(), "");
    await press(field(), "Escape");
    assert.equal(layer("heading").textContent, "ヒーロー見出し");
    await press(layer("heading"), "F2");
    await changeInput(field(), "");
    await press(field(), "Enter");
    assert.equal(layer("heading").textContent, "見出し");
    await click(button("下書き保存"));
    assert.equal(Object.hasOwn(app.writes.at(-1).body[0].children[0], "name"), false);
  } finally { await app.cleanup(); }
});

test("layer rename is unavailable for unsupported, read-only and locked nodes", async () => {
  for (const options of [{}, { nameSupport: true, readOnly: { reason: "読み取り専用です。" } },
    { nameSupport: true, locks: [{ nodeId: "hero", fields: ["children"], reason: "連動しています。" }] }]) {
    const app = await setup(options);
    try {
      await click(tool("レイヤー"));
      await click(layerToggle("hero"));
      assert.equal(await press(layer("heading"), "F2"), false);
      assert.equal(row("heading").querySelector("input"), null);
    } finally { await app.cleanup(); }
  }
});
