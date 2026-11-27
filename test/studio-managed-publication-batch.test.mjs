import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { outputFiles: [bundle] } = await build({
  entryPoints: [fileURLToPath(new URL("../studio/managed-publication.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false
});
const { parsePublishedSiteManifest, preparePublishedSiteBatch } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.contents).toString("base64"));

function fixture() {
  const objects = new Map(), reads = [], writes = [];
  return {
    objects, reads, writes,
    bucket: {
      async get(key) {
        reads.push(key);
        const value = objects.get(key);
        return value === undefined ? null : { json: async () => JSON.parse(value), text: async () => value };
      },
      async put(key, value, options) {
        assert.equal(options.onlyIf.get("If-None-Match"), "*");
        await new Promise((resolve) => setImmediate(resolve));
        writes.push(key);
        if (objects.has(key)) return null;
        objects.set(key, value);
        return {};
      }
    }
  };
}

const siteId = "site_example";
const defaults = { siteId, expectedVersion: "initial", currentManifestKey: null, replacePages: [] };
const detail = { pageId: "detail", locale: "ja" };
const retained = { pageId: "retained", locale: "ja" };
const inactive = { pageId: "inactive", locale: "ja" };
function route(page, path, text = path) {
  return { ...page, path, sourceRevision: 1, html: "<h1>" + text + "</h1>", title: text };
}

test("batch publication stores each URL before reading the next and writes one final manifest", async () => {
  const { bucket, objects, reads, writes } = fixture();
  const initial = await preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "first",
    routes: [route(detail, "/items/old"), route(detail, "/items/deleted"), route(retained, "/keep"), route(inactive, "/hide")]
  });
  writes.length = 0;
  reads.length = 0;
  const replacePages = [];
  const nextRoutes = [route(detail, "/items/a", "First new item"), route(detail, "/items/b", "Second new item")];
  async function* renderRoutes() {
    for (const [index, input] of nextRoutes.entries()) {
      assert.equal(writes.length, index, "previous HTML was written");
      yield input;
    }
    replacePages.push(detail);
  }
  const published = await preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "second", expectedVersion: initial.manifestVersion,
    currentManifestKey: initial.manifestKey, replacePages, activePages: [detail, retained],
    publicBaseUrl: "https://sites.example/s/site_example", siteName: "Example", routes: renderRoutes()
  });

  assert.equal(published.expectedVersion, initial.manifestVersion);
  assert.deepEqual([...published.artifacts.keys()], ["/items/a", "/items/b"]);
  assert.equal(published.artifacts.get("/items/a").pageId, detail.pageId);
  assert.equal(published.artifacts.get("/items/a").locale, detail.locale);
  assert.equal(objects.get(published.artifacts.get("/items/a").artifactKey), nextRoutes[0].html);
  const manifest = parsePublishedSiteManifest(JSON.parse(objects.get(published.manifestKey)), siteId);
  assert.ok(manifest);
  assert.deepEqual(manifest.routes.map(({ path }) => path), ["/items/a", "/items/b", "/keep"]);
  assert.equal(manifest.routes[2].artifactKey, initial.artifacts.get("/keep").artifactKey);
  assert.deepEqual(reads.filter((key) => key.includes("/manifests/")), [initial.manifestKey]);
  assert.deepEqual(writes, [
    manifest.routes[0].artifactKey,
    manifest.routes[1].artifactKey,
    ...manifest.discoveryFiles.map(({ artifactKey }) => artifactKey),
    published.manifestKey
  ]);
  const sitemap = objects.get(manifest.discoveryFiles.find(({ path }) => path === "/sitemap.xml").artifactKey);
  assert.match(sitemap, /https:\/\/sites\.example\/s\/site_example\/items\/b/u);
  assert.doesNotMatch(sitemap, /\/(?:hide|items\/old|items\/deleted)</u);
  assert.equal(reads.some((key) => key.includes("/texts/")), false);
  assert.deepEqual(manifest.discoveryFiles.map(({ path }) => path), ["/sitemap.xml", "/robots.txt", "/llms.txt"]);
  assert.equal(parsePublishedSiteManifest({ ...manifest, routes: [...manifest.routes, manifest.routes[0]] }, siteId), null);
});

test("a duplicate path in a publication does not write a new manifest", async () => {
  const { bucket, writes } = fixture();
  const original = await preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "first", routes: [route(retained, "/keep")]
  });
  writes.length = 0;
  await assert.rejects(preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "duplicate", routes: [route(retained, "/same"), route(detail, "/same")]
  }), /duplicate published route path/u);
  await assert.rejects(preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "occupied", currentManifestKey: original.manifestKey,
    expectedVersion: original.manifestVersion, routes: [route(detail, "/keep")]
  }), /published route is already owned by another page/u);
  assert.ok(writes.every((key) => !key.includes("/manifests/")));
});


test("lastmod tracks the content version independently of rebuilt HTML", async () => {
  const { bucket, objects } = fixture();
  const lastModified = "2024-01-23T04:05:06.000Z";
  const page = { ...route(retained, "/keep"), lastModified };
  const detailOne = { ...route(detail, "/items/one"), lastModified, cmsReleaseId: "release-1" };
  const detailTwo = { ...route(detail, "/items/two"), lastModified, cmsReleaseId: "release-1" };
  const original = await preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "original", routes: [page, detailOne, detailTwo]
  });
  const rebuilt = await preparePublishedSiteBatch({
    ...defaults, bucket, publicationId: "rebuild", expectedVersion: original.manifestVersion, currentManifestKey: original.manifestKey,
    replaceAll: true, publicBaseUrl: "https://sites.example",
    routes: [
      { ...page, html: "Rebuilt HTML", lastModified: undefined },
      { ...detailOne, html: "Updated article", lastModified: undefined, cmsReleaseId: "release-2" },
      { ...detailTwo, lastModified: undefined, cmsReleaseId: "release-2" }
    ]
  });
  const manifest = JSON.parse(objects.get(rebuilt.manifestKey));
  const routes = new Map(manifest.routes.map((route) => [route.path, route]));
  assert.equal(routes.get("/keep").lastModified, lastModified);
  assert.notEqual(routes.get("/items/one").lastModified, lastModified);
  assert.equal(routes.get("/items/two").lastModified, lastModified);
  assert.equal(routes.get("/items/one").cmsReleaseId, "release-2");
  assert.deepEqual(rebuilt.changedPaths, ["/items/one", "/keep"]);
});
