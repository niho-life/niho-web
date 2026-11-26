import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { PageRenderer, SitePageRenderer } from "@niho/web/react";
import { EditorPageRenderer, EditorSitePageRenderer } from "../dist/editor-renderer.js";
import { parsePageDocument } from "@niho/web/core";

const page = (pageId, body = []) => parsePageDocument({
  schemaVersion: 1, siteId: "test-site", pageId, locale: "ja", revision: 1, title: pageId, tokens: {}, body
});

test("editor's trusted canvas render matches the public renderer for validated pages", () => {
  const document = page("home", [{ type: "element", id: "section", tag: "section", children: [
    { type: "element", id: "heading", tag: "h1", children: [{ type: "text", text: "Hello" }] }
  ] }]);
  const publicHtml = renderToStaticMarkup(createElement(PageRenderer, { document }));
  const editorHtml = renderToStaticMarkup(createElement(EditorPageRenderer, { document }));
  assert.equal(editorHtml, publicHtml);
});

test("editor's trusted site canvas keeps the public composition output", () => {
  const document = page("home", [{ type: "element", id: "main", tag: "main", children: [{ type: "text", text: "Page" }] }]);
  const presentation = {
    schemaVersion: 1, siteId: "test-site", locale: "ja", version: "v1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: page("header"), footer: page("footer") }
  };
  const publicHtml = renderToStaticMarkup(createElement(SitePageRenderer, { document, presentation }));
  const editorHtml = renderToStaticMarkup(createElement(EditorSitePageRenderer, { document, presentation }));
  assert.equal(editorHtml, publicHtml);
});

test("public PageRenderer continues to reject an untrusted invalid document", () => {
  assert.throws(() => renderToStaticMarkup(createElement(PageRenderer, {
    document: { schemaVersion: 1, siteId: "test-site", pageId: "bad", locale: "ja", revision: 1, title: "bad", tokens: {}, body: [
      { type: "element", id: "script", tag: "script", children: [] }
    ] }
  })));
});

test("editor renderer skips unchanged node subtrees after an immutable text edit", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://editor.example.test" });
  for (const key of ["window", "document", "HTMLElement", "Element", "Event"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  let componentRenders = 0;
  const blocks = { Counter: { props: {}, component: () => { componentRenders++; return createElement("span", null, "unchanged component"); } } };
  const document = parsePageDocument({
    schemaVersion: 1, siteId: "test-site", pageId: "home", locale: "ja", revision: 1, title: "home", tokens: {}, body: [
      { type: "element", id: "section", tag: "section", children: [{ type: "text", text: "Before" }] },
      { type: "component", id: "component", block: "Counter", props: {} }
    ]
  }, blocks);
  const nextDocument = { ...document, body: [
    { ...document.body[0], children: [{ type: "text", text: "After" }] }, document.body[1]
  ] };
  const container = dom.window.document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(createElement(EditorPageRenderer, { document, blocks })));
    assert.equal(componentRenders, 1);
    await act(async () => root.render(createElement(EditorPageRenderer, { document: nextDocument, blocks })));
    assert.equal(componentRenders, 1, "the unchanged sibling subtree is reused");
    assert.match(container.textContent, /After/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
