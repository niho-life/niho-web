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
const frame = () => document.querySelector("iframe");
const right = () => document.querySelector('[aria-label="インスペクタ"]');
const button = (text, root = document) => [...root.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);
const field = (text, root = document) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text);
const input = (text, root = document) => field(text, root)?.querySelector("input,textarea,select");
const tabs = () => [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((node) => node.textContent);
async function click(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await click(target); }
async function canvasEvent(selector, type, init = {}) {
  const view = frame().contentWindow, target = view.document.querySelector(selector); assert.ok(target, selector);
  await act(async () => target.dispatchEvent(new (type.startsWith("key") ? view.KeyboardEvent : view.MouseEvent)(type, { bubbles: true, cancelable: true, ...init }))); await flush();
  return view.document.querySelector(selector);
}
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const stored = structuredClone(options.document ?? fixture);
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: stored.siteId, pageId: stored.pageId, locale: stored.locale, title: stored.title }],
    readDocument: async () => ({ document: structuredClone(stored), version: "v1" }),
    saveDraft: async () => { throw new Error("not used"); }, prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); },
    ...options.adapter
  };
  await act(async () => root.render(createElement(PageEditor, { adapter }))); await flush();
  await act(async () => frame().dispatchEvent(new dom.window.Event("load")));
  return { cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
/** サイト共通のカラーとテキストスタイルを持つホストと、このページだけの定義を 1 つずつ持つ文書。 */
function siteStyled() {
  const settings = { title: "デモサイト", locale: "ja", tokens: { brand: { type: "color", value: "#336655", label: "ブランド" } }, textStyles: { heading: { label: "見出し", base: { fontSize: 28, fontWeight: 700 } } } };
  const page = structuredClone(fixture);
  page.tokens = { ...page.tokens, accent: { type: "color", value: "#f2b705", label: "アクセント" } };
  page.textStyles = { note: { label: "注記", base: { fontSize: 12 } } };
  return { page, adapter: { readSiteSettings: async () => ({ settings: structuredClone(settings), version: "s1" }), saveSiteSettings: async () => { throw new Error("not used"); } } };
}

test("canvas text is committed by ⌘Enter or leaving the element and cancelled by Esc, with no finish-only button", async () => {
  const app = await setup();
  try {
    let heading = await canvasEvent("h1", "dblclick");
    assert.equal(heading.contentEditable, "true");
    const toolbar = frame().contentDocument.querySelector(".nw-text-toolbar");
    assert.ok(toolbar); assert.equal([...toolbar.querySelectorAll("button")].map((node) => node.textContent).includes("完了"), false, "no finish button");
    assert.match(toolbar.getAttribute("title"), /⌘Enter/); assert.match(toolbar.textContent, /Esc で取り消し/);
    heading.firstChild.textContent = "直接編集した見出し";
    heading = await canvasEvent("h1", "keydown", { key: "Enter", metaKey: true });
    // jsdom は contentEditable を反映属性として実装しないため、属性とツールバーの有無で判定する。
    const editing = () => heading.getAttribute("contenteditable") === "true" || !!frame().contentDocument.querySelector(".nw-text-toolbar");
    assert.equal(editing(), false, "⌘Enter commits and leaves editing");
    assert.equal(tabs()[0], "テキスト"); await editorTab("テキスト");
    assert.equal(input("テキスト", right()).value, "直接編集した見出し");
    heading = await canvasEvent("h1", "dblclick"); assert.equal(editing(), true); heading.firstChild.textContent = "捨てる変更";
    heading = await canvasEvent("h1", "keydown", { key: "Escape" });
    assert.equal(editing(), false); assert.equal(heading.textContent, "直接編集した見出し", "Esc restores the committed text");
    assert.equal(input("テキスト", right()).value, "直接編集した見出し");
    heading = await canvasEvent("h1", "dblclick"); heading.firstChild.textContent = "枠の外で確定";
    await act(async () => heading.dispatchEvent(new (frame().contentWindow.FocusEvent)("focusout", { bubbles: true }))); await flush();
    assert.equal(input("テキスト", right()).value, "枠の外で確定", "leaving the element commits like STUDIO");
  } finally { await app.cleanup(); }
});

test("the text tab lists text styles and shared colors under the place they are defined", async () => {
  const host = siteStyled(), app = await setup({ document: host.page, adapter: host.adapter });
  try {
    await canvasEvent("h1", "click"); await editorTab("テキスト");
    const select = input("テキストスタイル", right());
    const groups = Object.fromEntries([...select.querySelectorAll("optgroup")].map((group) => [group.label, [...group.querySelectorAll("option")].map((option) => option.textContent)]));
    assert.deepEqual(groups, { "サイト共通": ["見出し"], "このページ": ["注記"] });
    await click(button("文字色の候補を開く", right()));
    const pop = right().querySelector(".e-pop"), colors = Object.fromEntries([...pop.querySelectorAll(".e-pop-group")].map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll(".e-token")].map((node) => node.textContent)]));
    assert.deepEqual(colors, { "サイト共通": ["ブランド"], "このページ": ["ink", "アクセント"] }, "page colors keep their own name when they have no label");
  } finally { await app.cleanup(); }
});

test("without site-wide styles the candidates stay in one list", async () => {
  const page = structuredClone(fixture); page.textStyles = { note: { label: "注記", base: { fontSize: 12 } } };
  const app = await setup({ document: page });
  try {
    await canvasEvent("h1", "click"); await editorTab("テキスト");
    const select = input("テキストスタイル", right());
    assert.equal(select.querySelector("optgroup"), null); assert.ok([...select.options].some((option) => option.textContent === "注記"));
    await click(button("文字色の候補を開く", right()));
    assert.deepEqual([...right().querySelectorAll(".e-pop-group")].map((group) => group.getAttribute("aria-label")), ["共通カラー"]);
  } finally { await app.cleanup(); }
});

test("the four tabs reach the existing settings and the transform tab orders transform, animation and appearance like STUDIO", async () => {
  const app = await setup();
  try {
    await canvasEvent("h1", "click");
    assert.deepEqual(tabs(), ["テキスト", "ボックス", "変形", "設定"]);
    await editorTab("変形");
    assert.deepEqual([...right().querySelectorAll(".e-inspector-content h4")].map((node) => node.textContent), ["トランスフォーム", "移動", "拡大・縮小", "傾き", "アニメーション", "登場"]);
    for (const name of ["イージング", "時間", "遅延"]) { const control = input(name, right()); assert.ok(control, name); assert.equal(control.disabled, true, `${name} waits for a hover, focus or active style`); }
    assert.ok(right().textContent.includes("ホバー・フォーカス・押下中の見た目を作ると使えます。"));
    assert.ok(input("回転", right())); assert.ok(right().querySelector('[aria-label="変形の原点"]'));
    await editorTab("設定"); assert.ok(input("文字の種類", right())); assert.ok(right().querySelector(".e-widths"), "visible widths live in settings");
    await editorTab("ボックス"); assert.ok(input("幅", right())); assert.ok(input("配置方式", right())); assert.equal(input("テキスト", right()), undefined);
    await editorTab("テキスト"); assert.ok(input("文字サイズ", right())); assert.ok(input("テキストスタイル", right()));
  } finally { await app.cleanup(); }
});
