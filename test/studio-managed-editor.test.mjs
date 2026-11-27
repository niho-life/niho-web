import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../studio/managed-editor.tsx", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false
});
const { createManagedEditorAdapter } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

function fixture(domains) {
  const project = { id: "project_demo", site: { id: "demo", name: "Demo", domains: ["https://sites.example.test"] } };
  const adapter = createManagedEditorAdapter({ sites: [project.site], pages: [] }, project);
  return { project, adapter, response: Response.json({ sites: [{ ...project.site, domains }], pages: [] }) };
}

test("managed editor refresh accepts the registered public domain alongside the shared origin", async (t) => {
  const domains = ["https://kamakura.example.test", "https://sites.example.test"];
  const { adapter, response } = fixture(domains);
  t.mock.method(globalThis, "fetch", async () => response.clone());
  const signal = new AbortController().signal;
  assert.deepEqual((await adapter.listSites(signal))[0].domains, domains);
  assert.deepEqual(await adapter.listPages("demo", signal), []);
});

test("managed editor rejects unsafe, duplicate and excess public domains", async (t) => {
  let response = Response.json({ sites: [], pages: [] });
  const project = { id: "project_demo", site: { id: "demo", name: "Demo", domains: ["https://sites.example.test"] } };
  const adapter = createManagedEditorAdapter({ sites: [project.site], pages: [] }, project);
  t.mock.method(globalThis, "fetch", async () => response.clone());
  for (const domains of [
    ["https://sites.example.test", "https://evil.example.test/path"],
    ["https://sites.example.test", "https://sites.example.test"],
    ["https://a.example.test", "https://b.example.test", "https://c.example.test"]
  ]) {
    response = Response.json({ sites: [{ ...project.site, domains }], pages: [] });
    await assert.rejects(() => adapter.listPages("demo", new AbortController().signal), /サイト情報/u);
  }
});
