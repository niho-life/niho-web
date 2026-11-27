import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createProjectEditorAdapter } from "../dist/project-editor-adapter.js";

const bundle = await build({
  entryPoints: [new URL("../studio/managed-editor.tsx", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false, logLevel: "silent"
});
const { createManagedEditorAdapter } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

test("managed editor accepts the project's custom domain alongside its shared origin", async (t) => {
  const project = {
    id: "project-one", name: "Project One",
    site: { id: "site-one", name: "Site One", domains: ["https://sites.example", "https://www.example.test"] },
    members: [{ userId: "member-one", displayName: "Editor" }]
  };
  let catalogDomains = ["https://www.example.test", "https://sites.example"];
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), "/api/projects/project-one/sites/site-one/editor/catalog");
    return Response.json({
      sites: [{ id: project.site.id, name: project.site.name, domains: catalogDomains, futureCapability: "ignored" }],
      version: "catalog-v1",
      pages: [{ siteId: project.site.id, pageId: "home", locale: "ja", title: "Home", path: "/", kind: "page", visibility: "public", published: true, version: "home-v1" }]
    });
  });
  const managed = createManagedEditorAdapter({ sites: [project.site], pages: [] }, project);
  const adapter = createProjectEditorAdapter(managed, project);
  const signal = new AbortController().signal;

  assert.equal((await adapter.listPages(project.site.id, signal)).length, 1);
  assert.deepEqual((await adapter.listSites(signal))[0].domains, project.site.domains);

  catalogDomains = ["https://sites.example"];
  await adapter.listPages(project.site.id, signal);
  await assert.rejects(adapter.listSites(signal), /プロジェクトのサイト情報を確認できません/u);
});
