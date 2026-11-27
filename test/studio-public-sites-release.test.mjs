import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readPublicSitesReleaseSettings, smokePublicSitesPreview, writePublicSitesConfig } from "../studio/public-sites-release.mjs";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  STUDIO_DATABASE_ID: "dddddddd-eeee-4444-8888-ffffffffffff",
  STUDIO_ORIGIN: "https://studio.example.test",
  PUBLIC_SITES_ORIGIN: "https://sites.example.test",
  PUBLIC_SITES_PREVIEW_ORIGIN: "https://preview.example.test",
  PUBLIC_SITES_WORKER_NAME: "preview-fixture-worker",
  PUBLIC_SITES_SMOKE_PATH: "/s/example-site/"
};

test("public release settings require distinct HTTPS origins and a preview-only worker", () => {
  assert.throws(() => readPublicSitesReleaseSettings({}), /CLOUDFLARE_ACCOUNT_ID/u);
  assert.throws(() => readPublicSitesReleaseSettings({ ...env, PUBLIC_SITES_ORIGIN: env.STUDIO_ORIGIN }), /PUBLIC_SITES_ORIGIN/u);
  assert.throws(() => readPublicSitesReleaseSettings({ ...env, PUBLIC_SITES_PREVIEW_ORIGIN: env.PUBLIC_SITES_ORIGIN }), /PUBLIC_SITES_PREVIEW_ORIGIN/u);
  assert.throws(() => readPublicSitesReleaseSettings({ ...env, PUBLIC_SITES_WORKER_NAME: "niho-web-public-sites" }), /PUBLIC_SITES_WORKER_NAME/u);
  assert.throws(() => readPublicSitesReleaseSettings({ ...env, PUBLIC_SITES_SMOKE_PATH: "/s/example-site/../../other" }), /PUBLIC_SITES_SMOKE_PATH/u);
  assert.equal(readPublicSitesReleaseSettings(env).hostname, "preview.example.test");
});

test("public release writes a private Wrangler config routed only to the preview host", () => {
  const directory = mkdtempSync(join(tmpdir(), "niho-public-sites-release-test-"));
  try {
    const settings = readPublicSitesReleaseSettings(env);
    const configPath = writePublicSitesConfig(directory, settings);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.name, env.PUBLIC_SITES_WORKER_NAME);
    assert.equal(config.workers_dev, false);
    assert.equal(config.d1_databases[0].database_id, env.STUDIO_DATABASE_ID);
    assert.deepEqual(config.routes, [{ pattern: "preview.example.test", custom_domain: true }]);
    assert.deepEqual(config.vars, { PUBLIC_SITES_PREVIEW_ORIGIN: env.PUBLIC_SITES_PREVIEW_ORIGIN });
    assert.equal(config.main, resolve(new URL("../studio/", import.meta.url).pathname, "managed-publication.ts"));
    assert.ok(existsSync(join(directory, "migrations", "0016_static_page_publication.sql")));
    assert.ok(existsSync(join(directory, "migrations", "0017_managed_page_sources.sql")));
    assert.ok(existsSync(join(directory, "migrations", "0018_managed_public_embeds.sql")));
    assert.ok(existsSync(join(directory, "migrations", "0019_managed_public_domains.sql")));
    assert.ok(existsSync(join(directory, "migrations", "0020_managed_site_redirects.sql")));
    assert.ok(existsSync(join(directory, "migrations", "0021_managed_published_paths.sql")));
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("public release smoke requires HTML and both noindex directives", async () => {
  const settings = readPublicSitesReleaseSettings(env);
  const accepted = new Response("<!doctype html><html><head></head><body>preview</body></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" }
  });
  assert.equal((await smokePublicSitesPreview(settings, async (url, options) => {
    assert.equal(url, `${settings.previewOrigin}${settings.smokePath}`);
    assert.equal(options.redirect, "error");
    return accepted;
  })).bytes, Buffer.byteLength("<!doctype html><html><head></head><body>preview</body></html>"));
  await assert.rejects(() => smokePublicSitesPreview(settings, async () => new Response("<html>", {
    headers: { "Content-Type": "text/html", "X-Robots-Tag": "noindex" }
  })), /HTTP 200 の HTML と noindex, nofollow/u);
});
