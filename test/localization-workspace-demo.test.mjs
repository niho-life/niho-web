import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("the bundled localization workspace demo starts on fictional data only", async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL("../examples/localization-workspace-demo.tsx", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:4180/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "location", "history", "HTMLElement", "HTMLInputElement", "HTMLIFrameElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MessageEvent", "DOMException"]) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const errors = [];
  dom.window.addEventListener("error", (event) => errors.push(event.error ?? event.message));
  const source = output.outputFiles[0].text;
  for (const file of ["../examples/localization-workspace-demo.tsx", "../examples/localization-workspace-memory.mjs", "../examples/localization-workspace-demo.mjs"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /kamakura|鎌倉|cloudflarestorage|deepl/iu, `${file} uses fictional data only`);
  }
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const document = dom.window.document;
  for (let attempt = 0; attempt < 200 && !document.querySelector(".lw-row"); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors.length, 0, errors.map(String).join("\n"));
  assert.match(document.querySelector(".lw-band h2")?.textContent ?? "", /English版/);
  assert.ok([...document.querySelectorAll(".cw-row-title")].some((node) => node.textContent === "トップ"));
  assert.ok(document.querySelector(".demo-tools select"), "the demo can switch permissions");
  // 原文の取り込み（2 回）が終わるまで待ってから閉じる
  for (let attempt = 0; attempt < 60 && document.querySelector(".lw-band")?.textContent.includes("原文を取り込んでいます"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  dom.window.close();
});
