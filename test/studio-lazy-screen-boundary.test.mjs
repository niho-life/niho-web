import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundleDirectory = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.tmp-studio-lazy-boundary-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const bundle = path.join(bundleDirectory, "lazy-screen-boundary.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../studio/lazy-screen-boundary.tsx", import.meta.url))],
  bundle: true, external: ["react", "react/jsx-runtime"], format: "esm", platform: "node", target: "node22", outfile: bundle, logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' }
});

test("lazy screen failures keep the Studio shell and show recovery links", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="shell"><div id="root"></div></div></body></html>', { url: "https://studio.example.test/projects" });
  const globals = ["window", "document", "navigator", "HTMLElement", "Node"];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { LazyScreenBoundary } = await import(`${pathToFileURL(bundle).href}?instance=1`);
  const root = createRoot(document.querySelector("#root"));
  function FailedChunk() { throw new Error("chunk request failed"); }
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await act(async () => root.render(createElement(LazyScreenBoundary, null, createElement(FailedChunk))));
    assert.ok(document.querySelector("#shell"), "the outer Studio shell stays mounted");
    assert.equal(document.querySelector('[role="alert"] h1')?.textContent, "画面を読み込めませんでした");
    assert.equal(document.querySelector('button[type="button"]')?.textContent, "再読み込み");
    assert.equal(document.querySelector('a[href="/"]')?.textContent, "プロジェクト一覧に戻る");
  } finally {
    console.error = originalConsoleError;
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
