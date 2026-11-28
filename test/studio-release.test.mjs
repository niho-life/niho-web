import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { pendingMigrations, readReleaseSettings, registeredManagedSite, smokeStudio, writeConfig } from "../studio/release.mjs";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  STUDIO_DATABASE_ID: "dddddddd-eeee-4444-8888-ffffffffffff",
  STUDIO_ORIGIN: "https://studio.example.test",
  PUBLIC_SITES_ORIGIN: "https://public.example.test",
  PUBLIC_SITES_PREVIEW_ORIGIN: "https://preview.example.test",
  STUDIO_ACCESS_ISSUER: "https://access.example.test",
  STUDIO_ACCESS_AUDIENCE: "b".repeat(64),
  STUDIO_SMOKE_PROJECT_ID: "project-fixture",
  STUDIO_SMOKE_SITE_ID: "site-fixture",
  STUDIO_SMOKE_PUBLIC_PATH: "/s/example/",
  STUDIO_SMOKE_ACCESS_CLIENT_ID: `${"c".repeat(32)}.access`,
  STUDIO_SMOKE_ACCESS_CLIENT_SECRET: "e".repeat(64)
};
const capabilities = (siteId, ids = ["pages.read"]) => Response.json({ apiVersion: "v1", siteId, operations: ids.map((id) => ({ id })) });

test("release preflight rejects missing settings and unsuitable Access credentials without printing values", () => {
  assert.throws(() => readReleaseSettings({}), /CLOUDFLARE_ACCOUNT_ID/u);
  const privateValue = "unsafe-private-value";
  assert.throws(() => readReleaseSettings({ ...env, STUDIO_DATABASE_ID: privateValue }), (error) => {
    assert.match(error.message, /STUDIO_DATABASE_ID/u);
    assert.ok(!error.message.includes(privateValue));
    return true;
  });
  assert.throws(() => readReleaseSettings({ ...env, PUBLIC_SITES_ORIGIN: env.STUDIO_ORIGIN }), /PUBLIC_SITES_ORIGIN/u);
  assert.throws(() => readReleaseSettings({ ...env, PUBLIC_SITES_PREVIEW_ORIGIN: env.PUBLIC_SITES_ORIGIN }), /PUBLIC_SITES_PREVIEW_ORIGIN/u);
  assert.throws(() => readReleaseSettings({ ...env, STUDIO_SMOKE_PUBLIC_PATH: "/s/example/../../unexpected" }), /STUDIO_SMOKE_PUBLIC_PATH/u);
  assert.throws(() => readReleaseSettings({ ...env, STUDIO_SMOKE_ACCESS_CLIENT_ID: "fixture-user@example.test" }), /STUDIO_SMOKE_ACCESS_CLIENT_ID/u);
  assert.throws(() => readReleaseSettings({ ...env, STUDIO_SMOKE_ACCESS_CLIENT_SECRET: undefined }), /STUDIO_SMOKE_ACCESS_CLIENT_SECRET/u);
  const secret = `${"s".repeat(40)} private`;
  assert.throws(() => readReleaseSettings({ ...env, STUDIO_SMOKE_ACCESS_CLIENT_SECRET: secret }), (error) => {
    assert.match(error.message, /STUDIO_SMOKE_ACCESS_CLIENT_SECRET/u);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const settings = readReleaseSettings(env);
  assert.equal(settings.site, env.STUDIO_SMOKE_SITE_ID);
  assert.equal(settings.clientId, env.STUDIO_SMOKE_ACCESS_CLIENT_ID);
});

test("release parses Wrangler list and blocks pending migrations outside the additive allowlist", () => {
  const list = (rows) => ["Resource location: remote", "Migrations to be applied:", "│ Name │", ...rows.map((name) => `│ ${name} │`)].join("\n");
  assert.deepEqual(pendingMigrations("✅ No migrations to apply!\n"), []);
  const additive = ["0015_cms_delivery.sql", "0016_static_page_publication.sql",
    "0017_managed_public_embeds.sql", "0018_managed_public_domains.sql", "0019_managed_site_redirects.sql", "0020_managed_published_paths.sql",
    "0021_managed_page_sources.sql", "0022_managed_site_redirect_versions.sql",
    "0023_managed_site_primary_host.sql", "0024_managed_one_step_publish.sql", "0025_managed_site_imports.sql",
    "0026_managed_site_styles.sql"];
  assert.deepEqual(pendingMigrations(list(additive)), additive);
  assert.throws(() => pendingMigrations(list(["0015_cms_delivery.sql", "0016_drop_old_table.sql"])), /一致しません/u);
  assert.throws(() => pendingMigrations("unknown Wrangler output"), /読み取れません/u);
});

// D1 はファイル名で適用済みを判定する。配備先に適用した名前を変えると、同じ SQL を再実行して配備が止まる。
test("applied D1 migration file names stay fixed", () => {
  for (const name of ["0016_static_page_publication.sql", "0017_managed_public_embeds.sql", "0018_managed_public_domains.sql",
    "0019_managed_site_redirects.sql", "0020_managed_published_paths.sql", "0021_managed_page_sources.sql",
    "0022_managed_site_redirect_versions.sql", "0023_managed_site_primary_host.sql", "0024_managed_one_step_publish.sql",
    "0025_managed_site_imports.sql", "0026_managed_site_styles.sql"]) {
    assert.ok(existsSync(new URL(`../studio/migrations/${name}`, import.meta.url)), name);
  }
});

test("primary-host migration avoids dynamic SQLite GLOB patterns", () => {
  const migration = readFileSync(new URL("../studio/migrations/0023_managed_site_primary_host.sql", import.meta.url), "utf8");
  assert.match(migration, /substr\(manifest_key,\s*1,\s*length\('managed-sites\/' \|\| site_id \|\| '\/manifests\/'\)\)/u);
  assert.match(migration, /substr\(manifest_key,\s*-5\)\s*=\s*'\.json'/u);
  assert.doesNotMatch(migration, /manifest_key\s+GLOB/iu);
});

test("release parses one registered managed site and its publication count from Wrangler D1 JSON", () => {
  const row = (slug, count = 2) => ({ slug, published_page_count: count });
  assert.deepEqual(registeredManagedSite(JSON.stringify([{ success: true, results: [row("example-site")] }])), { slug: "example-site", publishedPageCount: 2 });
  assert.deepEqual(registeredManagedSite(JSON.stringify([{ success: true, results: [row("example-site", 0)] }])), { slug: "example-site", publishedPageCount: 0 });
  assert.throws(() => registeredManagedSite(JSON.stringify([{ success: true, results: [] }])), /一意に確認/u);
  assert.throws(() => registeredManagedSite(JSON.stringify([{ success: true, results: [row("one"), row("two")] }])), /一意に確認/u);
  assert.throws(() => registeredManagedSite(JSON.stringify([{ success: true, results: [{ slug: "example-site" }] }])), /一意に確認/u);
  assert.throws(() => registeredManagedSite(JSON.stringify([{ success: false, results: [row("example-site")] }])), /一意に確認/u);
  assert.throws(() => registeredManagedSite(JSON.stringify([{ success: true, results: [row("bad--slug")] }])), /一意に確認/u);
  assert.throws(() => registeredManagedSite("unknown Wrangler output"), /読み取れません/u);
});

test("release builds a private Wrangler config from external settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "niho-studio-release-test-"));
  try {
    const settings = readReleaseSettings(env);
    const configPath = writeConfig(directory, settings);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.name, "niho-web-studio");
    assert.equal(config.account_id, undefined);
    assert.equal(config.d1_databases[0].database_id, env.STUDIO_DATABASE_ID);
    assert.equal(config.vars.ACCESS_ISSUER, env.STUDIO_ACCESS_ISSUER);
    assert.equal(config.vars.ACCESS_AUDIENCE, env.STUDIO_ACCESS_AUDIENCE);
    assert.equal(config.vars.PUBLIC_SITES_ORIGIN, env.PUBLIC_SITES_ORIGIN);
    assert.equal(config.vars.PUBLIC_SITES_PREVIEW_ORIGIN, env.PUBLIC_SITES_PREVIEW_ORIGIN);
    assert.equal(config.keep_vars, true);
    assert.deepEqual(config.secrets.required, ["KAMAKURA_STUDIO_BRIDGE_SECRET"]);
    assert.deepEqual(config.routes.map(({ pattern }) => pattern), ["studio.example.test", "public.example.test"]);
    assert.equal(config.main, resolve(new URL("../studio/", import.meta.url).pathname, "dist/worker.js"));
    assert.ok(existsSync(join(directory, "migrations", "0015_cms_delivery.sql")));
    assert.ok(existsSync(join(directory, "migrations", "0016_static_page_publication.sql")));
    for (const name of ["0021_managed_page_sources.sql", "0017_managed_public_embeds.sql", "0018_managed_public_domains.sql",
      "0019_managed_site_redirects.sql", "0020_managed_published_paths.sql", "0022_managed_site_redirect_versions.sql",
      "0023_managed_site_primary_host.sql", "0024_managed_one_step_publish.sql", "0025_managed_site_imports.sql",
      "0026_managed_site_styles.sql"]) {
      assert.ok(existsSync(join(directory, "migrations", name)));
    }
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function smokeFixture(publishedPageCount, publicResponse) {
  const settings = readReleaseSettings(env);
  const assets = {
    entry: "/assets/app-aaaaaa111111.js", chunkPath: "/assets/chunks/project-dashboard-AAA11111.js",
    script: Buffer.from("fixture entry"), chunk: Buffer.from("fixture chunk")
  };
  const readRegisteredSite = async (project, site) => {
    assert.equal(project, settings.project);
    assert.equal(site, settings.site);
    return { slug: "example", publishedPageCount };
  };
  const requests = [];
  const ok = (body, type) => new Response(body, { headers: { "Content-Type": type } });
  async function request(rawUrl, options) {
    const url = new URL(rawUrl);
    requests.push(url.pathname);
    assert.equal(options.redirect, "error");
    if (url.origin === settings.publicOrigin) {
      assert.equal(options.headers["CF-Access-Client-Id"], undefined);
      assert.equal(options.headers["CF-Access-Client-Secret"], undefined);
      assert.equal(url.pathname, settings.publicPath);
      return publicResponse(rawUrl);
    }
    assert.equal(url.origin, settings.studioOrigin);
    assert.equal(options.headers["CF-Access-Client-Id"], env.STUDIO_SMOKE_ACCESS_CLIENT_ID);
    assert.equal(options.headers["CF-Access-Client-Secret"], env.STUDIO_SMOKE_ACCESS_CLIENT_SECRET);
    if (url.pathname === `/api/edit/v1/sites/${settings.site}/capabilities`) return capabilities(settings.site);
    if (url.pathname === assets.entry) return ok(assets.script, "application/javascript");
    if (url.pathname === assets.chunkPath) return ok(assets.chunk, "text/javascript; charset=utf-8");
    assert.fail("Unexpected smoke request");
  }
  return { settings, assets, readRegisteredSite, requests, ok, request };
}

test("release smoke sends the service token only to Studio and checks build assets and the public page", async () => {
  const { settings, assets, readRegisteredSite, requests, ok, request } = smokeFixture(1,
    (rawUrl) => new Response(`<meta property="og:url" content="${rawUrl}">`, { headers: { "Content-Type": "text/html" } }));
  await smokeStudio(settings, assets, request, readRegisteredSite);
  assert.deepEqual(requests, [`/api/edit/v1/sites/${settings.site}/capabilities`, assets.entry, assets.chunkPath, settings.publicPath]);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith(assets.chunkPath)
    ? ok("old chunk", "application/javascript") : request(url, options), readRegisteredSite), /遅延読込 chunk/u);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith(settings.publicPath)
    ? ok("<html>unexpected page</html>", "text/html") : request(url, options), readRegisteredSite), /og:url/u);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith("/capabilities")
    ? capabilities(settings.site, ["site.settings.read"]) : request(url, options), readRegisteredSite), /pages\.read/u);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith("/capabilities")
    ? capabilities("other-site") : request(url, options), readRegisteredSite), /pages\.read/u);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith("/capabilities")
    ? Response.json({ error: "forbidden" }, { status: 403 }) : request(url, options), readRegisteredSite), /HTTP 403/u);
  await assert.rejects(() => smokeStudio(settings, assets, () => { throw new TypeError("redirect"); }, readRegisteredSite), /service token/u);
  await assert.rejects(() => smokeStudio(settings, assets, request, async () => ({ slug: "other-site", publishedPageCount: 1 })), /登録済み slug/u);
});

test("release smoke accepts an unpublished managed site only when its public path returns a safe 404", async () => {
  const safeNotFound = () => new Response("<!doctype html><title>Not found</title>", { status: 404, headers: {
    "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  } });
  const { settings, assets, readRegisteredSite, requests, ok, request } = smokeFixture(0, safeNotFound);
  await smokeStudio(settings, assets, request, readRegisteredSite);
  assert.deepEqual(requests, [`/api/edit/v1/sites/${settings.site}/capabilities`, assets.entry, assets.chunkPath, settings.publicPath]);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith(settings.publicPath)
    ? new Response(null, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }) : request(url, options), readRegisteredSite), /安全な404/u);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith(settings.publicPath)
    ? new Response(null, { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'" } })
    : request(url, options), readRegisteredSite), /安全な404/u);
  await assert.rejects(() => smokeStudio(settings, assets, (url, options) => url.endsWith(settings.publicPath)
    ? ok("unexpected published page", "text/html") : request(url, options), readRegisteredSite), /安全な404/u);
  await assert.rejects(() => smokeStudio(settings, assets, request, async () => ({ slug: "another-site", publishedPageCount: 0 })), /登録済み slug/u);
  const pagePath = readReleaseSettings({ ...env, STUDIO_SMOKE_PUBLIC_PATH: "/s/example/about/" });
  await assert.rejects(() => smokeStudio(pagePath, assets, request, readRegisteredSite), /サイト先頭/u);
});

test("Studio reports missing bindings and invalid settings on its first cron event", async (t) => {
  const bundle = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const url = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
  const { default: worker } = await import(url);
  const runtimeEnv = { ACCESS_ISSUER: "invalid-private-issuer", PUBLIC_SITES_ORIGIN: "invalid-private-origin" };
  const warnings = t.mock.method(console, "error", () => {});
  await worker.scheduled({}, runtimeEnv);
  await worker.scheduled({}, runtimeEnv);
  assert.equal(warnings.mock.callCount(), 1);
  const [label, names] = warnings.mock.calls[0].arguments;
  assert.match(label, /configuration missing or invalid/u);
  for (const name of ["DB", "CMS_OBJECTS", "ACCESS_ISSUER", "ACCESS_AUDIENCE", "PUBLIC_SITES_ORIGIN"]) assert.ok(names.split(", ").includes(name));
  assert.ok(!names.includes("invalid-private"));
});
