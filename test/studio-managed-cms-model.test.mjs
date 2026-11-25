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
const { cmsDraftMatchesPublishedValues, redirectsForCmsRelease } = await import(pathToFileURL(bundle).href);

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

test("slug changes retarget historical redirects while withdrawal removes redirects to the withdrawn item", () => {
  const redirects = [{ from: "/cms/posts/a", to: "/cms/posts/b" }, { from: "/cms/posts/d", to: "/cms/posts/b" }];
  assert.deepEqual(redirectsForCmsRelease(redirects, "/cms/posts/b", "/cms/posts/d", false), [
    { from: "/cms/posts/a", to: "/cms/posts/d" }
  ]);
  assert.deepEqual(redirectsForCmsRelease(redirects, "/cms/posts/b", "/cms/posts/b", true), []);
});
