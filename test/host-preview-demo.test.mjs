import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

test("the bundled host preview demo draws the host calendar from context inside the canvas iframe", async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL("../examples/host-preview-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:4178/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "DOMException", "AbortController"]) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const errors = [];
  dom.window.addEventListener("error", (event) => errors.push(event.error ?? event.message));
  await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
  const document = dom.window.document;
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 300; attempt++) { const value = condition(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.fail("demo UI did not reach its expected state");
  };
  const frame = await waitFor(() => document.querySelector('iframe[title="ページのライブキャンバス"]'));
  frame.dispatchEvent(new dom.window.Event("load"));
  const calendar = await waitFor(() => frame.contentDocument?.querySelector(".host-calendar-grid"));
  assert.equal(errors.length, 0, errors.map(String).join("\n"));
  assert.match(calendar.textContent, /海辺のヨガ/, "public display data arrives through the host context");
  assert.doesNotMatch(frame.contentDocument.body.textContent, /見本の予定|見本の記事/, "the registry samples are replaced by the host display components");
  assert.ok([...frame.contentDocument.querySelectorAll("style")].some((style) => style.textContent.includes(".host-calendar-grid")), "host CSS is inside the iframe");
  assert.ok(frame.contentDocument.querySelector('[data-nw-node="calendar"] .host-calendar'), "the host block keeps the editor node attributes");
  assert.equal(document.querySelector(".host-calendar"), null, "nothing leaks into the host page");
});
