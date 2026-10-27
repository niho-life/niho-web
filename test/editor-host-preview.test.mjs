import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, createContext, useContext, Fragment, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const { PageRenderer, SitePageRenderer } = await import("@niho/web/react");
const context = createContext("missing");
/** ホストが所有する公開表示データ。PageEditor の外側の provider から iframe の中の表示部品へ届く。 */
const displayData = createContext({ events: [] });
const fixture = { schemaVersion: 1, siteId: "demo", pageId: "home", locale: "en", revision: 1, title: "Synthetic page", tokens: {}, body: [{ type: "element", id: "heading", tag: "h1", children: [{ type: "text", text: "Synthetic heading" }] }] };
const sharedDocument = (pageId, tag, text) => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "en", revision: 1, title: pageId, tokens: {}, body: [{ type: "element", id: `${pageId}_root`, tag, children: [{ type: "text", text }] }] });
const presentation = { schemaVersion: 1, siteId: "demo", locale: "en", version: "presentation-v1", reset: "neutral-v1", tokens: {}, fonts: [], shared: { header: sharedDocument("header", "header", "Synthetic header"), footer: sharedDocument("footer", "footer", "Synthetic footer") } };
/** 一般のエディターホストが登録する見本。公開と同じ表示部品はホストの previewComponent が差し替える。 */
const calendarBlocks = { EventCalendar: { props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("div", { "data-sample-calendar": "" }, `${heading} (sample)`) } };
const RealCalendar = ({ heading }) => createElement("div", { "data-real-calendar": "" }, `${heading} (real)`);
const flush = async () => { for (let index = 0; index < 4; index++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); };
async function press(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
const toolbar = (label) => [...document.querySelectorAll(".e-inspector-actions button,.e-preview-exit")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  await flush();
}
/** インスペクタの欄は focusout で文書へ確定する。 */
async function commit(target, value) {
  await change(target, value);
  await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}
async function setup(previewComponent, options = {}) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const current = options.document ?? fixture;
  const old = { ...structuredClone(current), revision: 1, title: "Earlier page" };
  const adapter = {
    listSites: async () => [{ id: "demo", name: "Synthetic site", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: current.pageId, locale: current.locale, title: current.title }],
    readDocument: async () => ({ document: structuredClone(current), version: "v1", ...(options.presentation ? { presentation: structuredClone(options.presentation) } : {}) }),
    saveDraft: async () => { throw new Error("No save expected"); },
    prepareRelease: async () => { throw new Error("No release expected"); },
    release: async () => { throw new Error("No release expected"); },
    listRevisions: async () => ({ entries: [{ id: "old", revision: 1, kind: "snapshot", createdAt: "2026-10-20T00:00:00.000Z", label: "Earlier" }] }),
    readRevision: async () => ({ document: old }),
  };
  await act(async () => root.render(createElement(context.Provider, { value: "host context" }, createElement(displayData.Provider, { value: { events: ["Synthetic market"] } },
    createElement(PageEditor, { adapter, ...(options.blocks ? { blocks: options.blocks } : {}), ...(previewComponent ? { previewComponent } : {}) })))));
  await flush();
  const frame = document.querySelector("iframe"); assert.ok(frame, document.body.textContent);
  await act(async () => frame.dispatchEvent(new dom.window.Event("load"))); await flush();
  return { frame, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("an omitted preview component keeps the default iframe renderer", async () => {
  const app = await setup();
  try {
    assert.equal(app.frame.getAttribute("sandbox"), "allow-same-origin");
    assert.equal(app.frame.contentDocument.documentElement.lang, "en");
    assert.equal(app.frame.contentDocument.querySelector("h1").textContent, "Synthetic heading");
    assert.equal(app.frame.contentDocument.querySelector("[data-host-preview]"), null);
  } finally { await app.cleanup(); }
});

test("strings, numbers, arrays and plain objects are ignored and keep the default renderer", async () => {
  for (const value of ["section", "<img src=x onerror=alert(1)>", 1, true, {}, []]) {
    const app = await setup(value);
    try {
      assert.equal(app.frame.contentDocument.querySelector("h1").textContent, "Synthetic heading", String(value));
      assert.equal(app.frame.contentDocument.querySelector("section, img"), null, String(value));
      assert.equal(app.frame.contentDocument.querySelector("[role=alert]"), null, String(value));
      assert.equal(document.body.textContent.includes("ブロックのプレビューを表示できません"), false, String(value));
    } finally { await app.cleanup(); }
  }
});

test("the host component shares context, current width and read-only preview/history inside the same iframe", async () => {
  function Preview(props) {
    return createElement("section", { "data-host-preview": "", "data-base-version": props.baseVersion, "data-history-id": props.historyRevision?.id ?? "", "data-context": useContext(context), "data-width": props.width, "data-mode": props.mode, "data-readonly": String(props.readOnly), "data-title": props.document.title,
      "data-assets": typeof props.assets, "data-blocks": Object.keys(props.blocks).join(","), "data-presentation": String(props.presentation === undefined) },
      createElement("form", { "data-host-form": "" }, createElement("button", { type: "submit" }, "Synthetic submit")),
      createElement("a", { href: "/synthetic", "data-host-link": "" }, "Synthetic link"), props.children);
  }
  const app = await setup(Preview);
  const host = () => app.frame.contentDocument.querySelector("[data-host-preview]");
  try {
    assert.equal(document.querySelector("[data-host-preview]"), null);
    assert.equal(host().dataset.context, "host context");
    assert.equal(host().dataset.baseVersion, "v1");
    assert.equal(host().dataset.historyId, "");
    assert.equal(host().dataset.assets, "object"); assert.equal(host().dataset.blocks, ""); assert.equal(host().dataset.presentation, "true");
    assert.equal(host().dataset.mode, "edit"); assert.equal(host().dataset.readonly, "false");
    assert.equal(host().querySelector("h1").textContent, "Synthetic heading");
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(host().dataset.width, "375");
    const form = app.frame.contentDocument.querySelector("[data-host-form]");
    const submit = new app.frame.contentWindow.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => form.dispatchEvent(submit)); assert.equal(submit.defaultPrevented, true);
    const link = new app.frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => app.frame.contentDocument.querySelector("[data-host-link]").dispatchEvent(link)); assert.equal(link.defaultPrevented, true);
    await press(toolbar("プレビュー")); assert.equal(host().dataset.mode, "preview"); assert.equal(host().dataset.readonly, "true");
    await press(toolbar("編集に戻る")); await press(document.querySelector('.e-tools [aria-label="履歴"]'));
    await press(document.querySelector(".e-version:not(.is-current)"));
    assert.equal(host().dataset.mode, "history"); assert.equal(host().dataset.readonly, "true");
    assert.equal(host().dataset.title, "Earlier page");
    assert.equal(host().dataset.historyId, "old");
  } finally { await app.cleanup(); }
});

test("host CSS and public display data stay inside the iframe, and the component follows edits of the document", async () => {
  function Preview(props) {
    const { events } = useContext(displayData);
    return createElement(Fragment, null,
      createElement("style", { "data-host-css": "" }, ".host-calendar{display:grid}"),
      createElement("link", { rel: "stylesheet", href: "/host-preview.css", "data-host-link": "" }),
      createElement("ul", { className: "host-calendar", "data-host-calendar": "", "data-title": props.document.title, "data-locale": props.document.locale }, events.map((event) => createElement("li", { key: event }, event))),
      props.children);
  }
  const app = await setup(Preview);
  const frameDocument = app.frame.contentDocument, calendar = () => frameDocument.querySelector("[data-host-calendar]");
  try {
    assert.ok(frameDocument.querySelector("style[data-host-css]")); assert.equal(document.querySelector("style[data-host-css]"), null);
    assert.ok(frameDocument.querySelector("link[data-host-link][rel=stylesheet]")); assert.equal(document.querySelector("link[data-host-link]"), null);
    assert.equal(calendar().querySelector("li").textContent, "Synthetic market");
    assert.equal(calendar().dataset.locale, "en"); assert.equal(calendar().dataset.title, "Synthetic page");
    assert.equal(frameDocument.querySelector("h1").textContent, "Synthetic heading");
    await commit(input("ページタイトル"), "Edited title");
    assert.equal(calendar().dataset.title, "Edited title");
  } finally { await app.cleanup(); }
});

test("the host redraws the document with its own display blocks and the presentation while canvas selection keeps working", async () => {
  function Preview(props) {
    const display = { ...props.blocks, EventCalendar: { ...props.blocks.EventCalendar, component: RealCalendar } };
    return createElement("section", { "data-host-preview": "", "data-presentation": props.presentation?.version ?? "", "data-blocks": Object.keys(props.blocks).join(",") },
      props.presentation
        ? createElement(SitePageRenderer, { document: props.document, presentation: props.presentation, blocks: display, assets: props.assets, missingAssets: "placeholder", hostViewMode: "fallback" })
        : createElement(PageRenderer, { document: props.document, blocks: display, assets: props.assets, missingAssets: "placeholder" }));
  }
  const withCalendar = { ...structuredClone(fixture), body: [...structuredClone(fixture.body), { type: "component", id: "calendar", block: "EventCalendar", props: { heading: "Synthetic events" } }] };
  const app = await setup(Preview, { document: withCalendar, presentation, blocks: calendarBlocks });
  const frameDocument = app.frame.contentDocument;
  const outlined = (id) => [...frameDocument.querySelectorAll("style")].some((style) => style.textContent.includes(`[data-nw-node="${id}"]{outline`));
  const canvasClick = async (selector) => { const view = app.frame.contentWindow, target = frameDocument.querySelector(selector); assert.ok(target, selector); await act(async () => target.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))); await flush(); };
  try {
    const host = frameDocument.querySelector("[data-host-preview]");
    assert.equal(host.dataset.presentation, "presentation-v1"); assert.equal(host.dataset.blocks, "EventCalendar");
    assert.equal(frameDocument.querySelector("[data-real-calendar]").textContent, "Synthetic events (real)");
    assert.equal(frameDocument.querySelector("[data-sample-calendar]"), null);
    assert.ok(frameDocument.querySelector("[data-nw-presentation-header]")?.textContent.includes("Synthetic header"));
    assert.equal(frameDocument.querySelector("h1").textContent, "Synthetic heading");
    await canvasClick("h1"); assert.equal(outlined("heading"), true);
    await canvasClick("[data-real-calendar]"); assert.equal(outlined("calendar"), true); assert.equal(outlined("heading"), false);
  } finally { await app.cleanup(); }
});
