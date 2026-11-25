import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = mkdtempSync(path.join(os.tmpdir(), "studio-managed-cms-model-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const bundle = path.join(directory, "model.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../studio/managed-cms-model.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node22", outfile: bundle, logLevel: "silent"
});
const { cmsDraftMatchesPublishedValues, redirectsForCmsItemRelease } = await import(pathToFileURL(bundle).href);

test("schema revision change compares raw rich text with its escaped published value", () => {
  const schema = { collections: [{ id: "posts", fields: [
    { fieldId: "body", type: "richText" }, { fieldId: "title", type: "text" }
  ] }] };
  const draft = { body: "<p>こんにちは & welcome</p>", title: "記事" };
  const published = { body: "&lt;p&gt;こんにちは &amp; welcome&lt;/p&gt;", title: "記事" };

  assert.equal(cmsDraftMatchesPublishedValues(schema, "posts", draft, published), true);
  assert.equal(cmsDraftMatchesPublishedValues(schema, "posts", { ...draft, title: "変更" }, published), false);
  assert.equal(cmsDraftMatchesPublishedValues(schema, "missing", draft, published), false);
});

test("publishing a new item path retargets historical redirects and withdrawal removes them", () => {
  const redirects = [
    { from: "/cms/posts/old", to: "/cms/posts/current", owner: "cms" },
    { from: "/cms/posts/older", to: "/cms/posts/current", owner: "cms" },
    { from: "/legacy", to: "/about", owner: "host" }
  ];
  assert.deepEqual(redirectsForCmsItemRelease(redirects, "/cms/posts/current", "/cms/posts/next", false), [
    { from: "/cms/posts/old", to: "/cms/posts/next", owner: "cms" },
    { from: "/cms/posts/older", to: "/cms/posts/next", owner: "cms" },
    { from: "/legacy", to: "/about", owner: "host" }
  ]);
  assert.deepEqual(redirectsForCmsItemRelease(redirects, "/cms/posts/current", "/cms/posts/next", true), [
    { from: "/legacy", to: "/about", owner: "host" }
  ]);
});
