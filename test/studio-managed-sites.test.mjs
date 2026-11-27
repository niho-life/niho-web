import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { applyKamakuraSiteImport, prepareKamakuraSiteImport } from "../scripts/import-kamakura-site.mjs";
import { JSDOM } from "jsdom";
import { parseLocalizationItemResult, parseLocalizationListResult, parseLocalizationOverviewResult } from "../dist/localization-workspace-model.js";
import { cmsLocalizationItemKey } from "@niho/web/cms-v2";
import { CMS_DELIVERY_RENDERER_VERSION, cmsDeliveryRoutes, createCmsDeliveryClient } from "@niho/web/cms-delivery";
import { cmsDeliveryHash, parseCmsDeliverySnapshot, serializeCmsDeliverySnapshot, signCmsDeliveryRequest } from "../dist/cms-delivery-contract.js";

const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));
const testWithD1 = DatabaseSync ? test : test.skip;
const MANAGEMENT_ORIGIN = "https://studio.example";
const PUBLIC_ORIGIN = "https://sites.example";
const OWNER = "managed-owner";
const OTHER = "managed-other";
const PUBLIC_EMBED_SCRIPT = "/_niho/niho-embeds-012345abcdef.js";
const PUBLIC_PRESENTATION_SCRIPT = "/_niho/presentation-012345abcdef.js";
const SERVICE_CLIENT = `${"c".repeat(32)}.access`;

const migrationDirectory = new URL("../studio/migrations/", import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort().map((name) => readFile(new URL(name, migrationDirectory), "utf8")));
const bundle = await build({
  stdin: {
    contents: 'export { default } from "./studio/worker.ts"; export { publishedSiteRequest } from "./studio/managed-publication.ts"; export { managedCmsApi } from "./studio/managed-cms.ts"; export { CmsStore } from "./studio/managed-cms-store.ts"; export { initializePublicNihoEmbeds } from "./studio/public-niho-embeds.ts";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url))
  },
  bundle: true, format: "esm", platform: "node", target: "node22", write: false,
  define: { __PUBLIC_NIHO_EMBEDS_PATH__: JSON.stringify(PUBLIC_EMBED_SCRIPT), __PUBLIC_PRESENTATION_PATH__: JSON.stringify(PUBLIC_PRESENTATION_SCRIPT) },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(`${process.cwd()}/studio-worker-test.mjs`);' }
});
const { default: worker, publishedSiteRequest, managedCmsApi, CmsStore, initializePublicNihoEmbeds } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "managed-test", alg: "RS256", use: "sig" };

async function fixture(t, { cms = false, restore, restoredObjects = [] } = {}) {
  const issuer = `https://access-${crypto.randomUUID()}.example`, audience = "managed-test";
  const now = Math.floor(Date.now() / 1000), encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims) => {
    const input = `${encode({ alg: "RS256", kid: jwk.kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, exp: now + 600, iat: now, type: "app", ...claims })}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  const ownerToken = jwt({ sub: OWNER, email: "owner@example.test" }), otherToken = jwt({ sub: OTHER, email: "other@example.test" });
  const serviceToken = jwt({ sub: "", common_name: SERVICE_CLIENT });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
  const sqlite = new DatabaseSync(restore ?? ":memory:");
  const objects = new Map(restoredObjects), faults = {};
  const CMS_OBJECTS = {
    async put(key, value, options) {
      assert.equal(options.onlyIf.get("If-None-Match"), "*");
      if (objects.has(key)) return null;
      if (faults.put === "before") { delete faults.put; throw new Error("fixture put failure"); }
      objects.set(key, value);
      if (faults.put === "after") { delete faults.put; throw new Error("fixture ambiguous put"); }
      return {};
    },
    async get(key) {
      if (faults.release && key.includes("/releases/")) { delete faults.release; throw new Error("fixture release object unavailable"); }
      if (faults.artifact && key.includes("/artifacts/")) { delete faults.artifact; throw new Error("fixture artifact unavailable"); }
      return objects.has(key) ? {
        json: async () => JSON.parse(objects.get(key)),
        text: async () => String(objects.get(key)),
        arrayBuffer: async () => new Response(objects.get(key)).arrayBuffer()
      } : null;
    }
  };
  t.after(() => sqlite.close());
  if (!restore) for (const migration of migrations) sqlite.exec(migration);
  const wrap = (query) => {
    const statement = sqlite.prepare(query);
    let params = [];
    return {
      query,
      bind(...values) {
        assert.ok(values.length <= 100, "D1 allows at most 100 bound parameters per query");
        params = values;
        return this;
      },
      async first() {
        return statement.get(...params) ?? null;
      },
      execute() {
        if (/^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(query)) return { success: true, meta: statement.run(...params) };
        return { success: true, results: statement.all(...params) };
      },
      async all() {
        if (faults.externalization && query.includes("UPDATE managed_page_versions")) {
          delete faults.externalization;
          throw new Error("fixture failed to update the page source pointer");
        }
        return this.execute();
      }
    };
  };
  const env = {
    ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, PUBLIC_SITES_ORIGIN: PUBLIC_ORIGIN, PUBLIC_SITES_PREVIEW_ORIGIN: "https://preview.sites.example",
    CMS_OBJECTS,
    ...(cms ? { CMS_DELIVERY_MASTER_KEY: "a1".repeat(32) } : {}),
    DB: { prepare: wrap, async batch(statements) {
      if (faults.managedProjectBatch) { const error = faults.managedProjectBatch; delete faults.managedProjectBatch; throw error; }
      if (faults.revokeOwnerBeforePublishCommit && statements[0]?.query.includes("INSERT INTO managed_site_audit")) {
        const { projectId, subject } = faults.revokeOwnerBeforePublishCommit;
        delete faults.revokeOwnerBeforePublishCommit;
        sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, 'backup-owner', 'owner', 'Backup owner')").run(projectId);
        sqlite.prepare("DELETE FROM project_members WHERE project_id = ? AND access_subject = ?").run(projectId, subject);
      }
      if (faults.revokePublishGrant && statements[0]?.query.includes("INSERT INTO managed_site_audit")) {
        sqlite.prepare("DELETE FROM studio_cli_grants WHERE client_id = ? AND capability = 'pages.publish'").run(SERVICE_CLIENT);
        delete faults.revokePublishGrant;
      }
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((statement, index) => {
          if (index === 1 && faults.batch && statements[0].query.includes("INSERT INTO managed_cms_receipts")) {
            delete faults.batch;
            throw new Error("fixture aborted transaction");
          }
          if (faults.deliveryEvent && statement.query.includes("INSERT INTO managed_cms_delivery_events")) {
            delete faults.deliveryEvent;
            throw new Error("fixture aborted delivery event");
          }
          const executed = statement.execute();
          if (index === 3 && faults.managedSiteTriggerChanges) {
            delete faults.managedSiteTriggerChanges;
            return { ...executed, meta: { ...executed.meta, changes: 2 } };
          }
          return executed;
        });
        sqlite.exec("COMMIT");
        return result;
      }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    } },
    ASSETS: { async fetch(request) {
      if ([PUBLIC_EMBED_SCRIPT, PUBLIC_PRESENTATION_SCRIPT].includes(new URL(request.url).pathname)) return new Response("export {};", { headers: { "Content-Type": "text/javascript" } });
      return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } });
    } },
    KAMAKURA_SITE: { async fetch() { throw new Error("existing host must not be called"); } }
  };
  const send = (origin, method, path, body, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.auth !== false) headers.set(options.cli && !options.service ? "cf-access-token" : "Cf-Access-Jwt-Assertion", options.token ?? ownerToken);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      if (!options.cli) { headers.set("Origin", MANAGEMENT_ORIGIN); headers.set("Sec-Fetch-Site", "same-origin"); }
    }
    return worker.fetch(new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  };
  const fetch = (url, init) => worker.fetch(new Request(url, init), env);
  return { sqlite, env, ownerToken, otherToken, serviceToken, send, fetch, objects, faults, cron: () => worker.scheduled({}, env) };
}

async function body(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function pageChange(send, change) {
  const { version } = await body(await send("GET", change.action === "create" ? "/catalog" : `/${change.target.pageId}`), 200);
  return body(await send("POST", "/page-changes", { change, expectedVersion: version }), 200);
}

async function setFixturePublicPolicy(h, site, settings) {
  const path = `/api/projects/${site.projectId}/sites/${site.siteId}/editor/public-settings`;
  const { version } = await body(await h.send(MANAGEMENT_ORIGIN, "GET", path), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", path, { expectedVersion: version, settings }), 200);
}
async function setFixturePublicDomain(h, site, domain, noindex = true) {
  const path = `/api/projects/${site.projectId}/sites/${site.siteId}/editor/public-domain`;
  const { version } = await body(await h.send(MANAGEMENT_ORIGIN, "GET", path), 200);
  return body(await h.send(MANAGEMENT_ORIGIN, "POST", path, { expectedVersion: version, domain, noindex }), 200);
}

testWithD1("Studio CLI shares public delivery settings, separate versions and owner grants with the GUI", async (t) => {
  const h = await fixture(t);
  const site = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "CLI Settings", slug: "cli-settings", locale: "ja" }), 201);
  const api = `/api/projects/${site.projectId}/sites/${site.siteId}/editor`;
  const endpoint = `/api/edit/v2/sites/${site.siteId}/operations/site.public`;
  const send = (method, path, input, options = { cli: true }) => h.send(MANAGEMENT_ORIGIN, method, path, input, options);
  const machine = { cli: true, service: true, token: h.serviceToken };
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, 'editor', 'Editor')")
    .run(site.projectId, OTHER);
  assert.equal((await send("GET", endpoint + ".read", undefined, { auth: false })).status, 401);
  assert.equal((await send("GET", endpoint + ".read", undefined, { cli: true, token: h.otherToken })).status, 403);
  assert.equal((await send("GET", endpoint + ".read", undefined, machine)).status, 403);

  const grant = h.sqlite.prepare(`INSERT INTO studio_cli_grants (client_id, project_id, site_id, capability, delegated_by_subject)
    VALUES (?, ?, ?, ?, ?)`);
  grant.run(SERVICE_CLIENT, site.projectId, site.siteId, "site.settings.read", OWNER);
  const initial = await body(await send("GET", endpoint + ".read", undefined, machine), 200);
  const next = {
    domain: { ...initial.domain, hostname: "custom.example.test", noindex: false },
    origins: { ...initial.origins, frameOrigins: ["https://niho.life"], resourceOrigins: ["https://media.example.test"] }
  };
  assert.equal((await send("PUT", endpoint + ".save", next, machine)).status, 403);
  grant.run(SERVICE_CLIENT, site.projectId, site.siteId, "site.settings.write", OWNER);
  const saved = await body(await send("PUT", endpoint + ".save", next, machine), 200);
  assert.notEqual(saved.domain.version, initial.domain.version);
  assert.notEqual(saved.origins.version, initial.origins.version);
  const guiDomain = await body(await send("GET", api + "/public-domain", undefined, {}), 200);
  assert.deepEqual(guiDomain, { domain: saved.domain.hostname, noindex: false, version: saved.domain.version });
  const guiOrigins = await body(await send("GET", api + "/public-settings", undefined, {}), 200);
  assert.equal(guiOrigins.version, saved.origins.version);
  assert.deepEqual(guiOrigins.settings.frameOrigins, saved.origins.frameOrigins);
  assert.deepEqual(guiOrigins.settings.resourceOrigins, saved.origins.resourceOrigins);
  assert.deepEqual(await body(await send("PUT", endpoint + ".save", next, machine), 409), { error: "conflict", part: "domain" });
  assert.deepEqual(await body(await send("PUT", endpoint + ".save", saved, machine), 200), saved);

  h.sqlite.exec(`CREATE TEMP TRIGGER simulate_concurrent_policy_edit AFTER UPDATE OF public_domain_version ON managed_sites
    BEGIN UPDATE managed_sites SET public_policy_version = 'concurrent' WHERE site_id = NEW.site_id; END`);
  const changed = {
    domain: { ...saved.domain, hostname: "updated.example.test" },
    origins: { ...saved.origins, resourceOrigins: [] }
  };
  const partial = await body(await send("PUT", endpoint + ".save", changed, machine), 409);
  assert.deepEqual(partial, { error: "partial_save", saved: "domain", failed: "origins", cause: "conflict" });
  const after = await body(await send("GET", endpoint + ".read", undefined, machine), 200);
  assert.equal(after.domain.hostname, "updated.example.test");
  assert.deepEqual(after.origins, { ...saved.origins, version: "concurrent" });
});

testWithD1("Studio CLI embed registration uses the current page scope and edit grant", async (t) => {
  const h = await fixture(t);
  const site = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "CLI Embed", slug: "cli-embed", locale: "ja" }), 201);
  await setFixturePublicPolicy(h, site, { frameOrigins: ["https://niho.life"], resourceOrigins: [] });
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, 'editor', 'Editor')")
    .run(site.projectId, OTHER);
  const endpoint = `/api/edit/v2/sites/${site.siteId}/operations/pages.embed-register`;
  const send = (pageId, input, options) => h.send(MANAGEMENT_ORIGIN, "POST", `${endpoint}/${pageId}`, input, options);
  const launch = { v: 1, flow: "inquiry", spotId: "example", publicId: "example", launchTokenVersion: 1,
    parentOrigin: PUBLIC_ORIGIN, allowedPathPrefix: "/s/cli-embed/" };
  const token = `${Buffer.from(JSON.stringify(launch)).toString("base64url")}.${"a".repeat(43)}`;
  const input = { locale: "ja", src: `https://niho.life/embed/inquiry/example?launchToken=${token}` };
  const machine = { cli: true, service: true, token: h.serviceToken };
  assert.equal((await send("home", input, machine)).status, 403);
  const grant = h.sqlite.prepare(`INSERT INTO studio_cli_grants (client_id, project_id, site_id, capability, delegated_by_subject)
    VALUES (?, ?, ?, ?, ?)`);
  grant.run(SERVICE_CLIENT, site.projectId, site.siteId, "pages.read", OWNER);
  assert.equal((await send("home", input, machine)).status, 403);
  grant.run(SERVICE_CLIENT, site.projectId, site.siteId, "pages.edit", OWNER);
  assert.equal((await send("other-page", input, machine)).status, 403);
  assert.equal((await send("home", { ...input, locale: "en" }, machine)).status, 403);
  assert.equal((await send("home", { ...input, src: "https://example.test/" }, machine)).status, 422);
  const machineResult = await body(await send("home", input, machine), 201);
  const editorResult = await body(await send("home", input, { cli: true, token: h.otherToken }), 201);
  assert.match(machineResult.refId, /^emb_[0-9a-f]{32}$/u);
  assert.match(editorResult.refId, /^emb_[0-9a-f]{32}$/u);
  assert.notEqual(machineResult.refId, editorResult.refId);
  const stored = h.sqlite.prepare("SELECT site_id, page_id, locale FROM managed_embed_connections WHERE ref_id = ?").get(machineResult.refId);
  assert.deepEqual({ ...stored }, { site_id: site.siteId, page_id: "home", locale: "ja" });
});

testWithD1("published page permits only approved embeds and serves NIHO connections only for its active page revision", async (t) => {
  const h = await fixture(t);
  const { projectId, siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Embeds", slug: "embeds", locale: "ja" }), 201);
  const api = `/api/projects/${projectId}/sites/${siteId}/editor`, settingsPath = api + "/public-settings", publicPath = "/s/embeds/";
  const publicFetch = (url, init = {}) => publishedSiteRequest(new Request(url, init), h.env);
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, 'editor', 'Editor')").run(projectId, OTHER);
  const send = (method, path, value, options) => h.send(MANAGEMENT_ORIGIN, method, path, value, options);
  const publish = async ({ version }) => {
    return body(await send("POST", api + "/home/publish", { expectedVersion: version, action: "publish" }), 200);
  };
  const initial = await body(await send("GET", settingsPath), 200);
  const savePolicy = (settings, expectedVersion = initial.version, options) => send("POST", settingsPath, { expectedVersion, settings }, options);
  const frameOrigins = ["https://niho.life", "https://www.youtube-nocookie.com", "https://calendar.example.test", "https://lottie.host", "https://unused.example.test"];
  const resourceOrigins = ["https://images.example.test", "https://video.example.test", "https://fonts.example.test"];
  const measurementId = "G-TEST12345", settings = { frameOrigins, resourceOrigins, ga4MeasurementId: measurementId };
  assert.equal((await savePolicy(settings, initial.version, { token: h.otherToken })).status, 403);
  assert.equal((await savePolicy({ ...settings, frameOrigins: ["https://frame.test;"] })).status, 422);
  assert.equal((await savePolicy({ ...settings, frameOrigins: [PUBLIC_ORIGIN] })).status, 422);
  assert.equal((await savePolicy({ ...settings, resourceOrigins: ["https://*.example.test"] })).status, 422);
  assert.equal((await savePolicy({ ...settings, ga4MeasurementId: 'G-BAD"><script>' })).status, 422);
  const savedPolicy = await body(await savePolicy(settings), 200);
  assert.equal((await savePolicy(settings)).status, 409);
  const embedRoute = api + "/home/embed-connection";
  const token = (parentOrigin, allowedPathPrefix) => {
    const payload = { v: 1, flow: "rental", spotId: "example", publicId: "example", launchTokenVersion: 1, parentOrigin, allowedPathPrefix };
    return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"a".repeat(43)}`;
  };
  const source = (parentOrigin, allowedPathPrefix) => `https://niho.life/embed/rental/example?launchToken=${token(parentOrigin, allowedPathPrefix)}`;
  assert.equal((await send("POST", embedRoute, { src: source(MANAGEMENT_ORIGIN, publicPath), locale: "ja" })).status, 422);
  assert.equal((await send("POST", embedRoute, { src: source(PUBLIC_ORIGIN, "/s/elsewhere/"), locale: "ja" })).status, 422);
  const src = source(PUBLIC_ORIGIN, publicPath);
  assert.equal((await send("POST", embedRoute, { src, locale: "en" })).status, 403);
  const { refId } = await body(await send("POST", embedRoute, { src, locale: "ja" }), 201);
  const resolvePath = `${PUBLIC_ORIGIN}${publicPath}?_niho_embed=${refId}`;
  assert.equal((await publicFetch(resolvePath)).status, 404);
  const snapshot = await body(await send("GET", api + "/home"), 200);
  snapshot.document.meta = { favicon: "https://denied.example.test/favicon.ico", ogImage: { src: "https://denied.example.test/og.webp", alt: "OG" } };
  const embed = (id, provider, source) => ({ type: "element", id, tag: "div", embed: { provider, title: id, source }, children: [] });
  const element = (id, tag, attrs, children = []) => ({ type: "element", id, tag, attrs, children });
  const lottie = "https://lottie.host/embed/3c903090-d3ad-440d-88f0-495c9793a00d/sample.json";
  snapshot.document.body[0].children.push(
    embed("youtube", "youtube", "https://www.youtube.com/watch?v=abcdefghijk"),
    embed("calendar", "url", "https://calendar.example.test/public"),
    embed("social", "vimeo", "https://vimeo.com/123"),
    embed("lottie", "lottie", lottie),
    element("image", "img", { src: "https://images.example.test/cover.webp", srcSet: "https://denied.example.test/zoom.webp", alt: "Cover" }),
    element("local-image", "img", { src: "/images/local.webp", alt: "Local" }),
    element("alt-image", "img", { src: "https://denied.example.test/alt.webp", alt: "Still described" }),
    element("picture", "picture", {}, [
      element("picture-source", "source", { srcSet: "https://images.example.test/cover.avif", type: "image/avif" }),
      element("picture-image", "img", { src: "https://denied.example.test/fallback.webp", srcSet: "https://denied.example.test/fallback-hi.webp", alt: "Responsive" })
    ]),
    element("picture-with-blocked-images", "picture", {}, [
      element("picture-source-denied", "source", { srcSet: "https://denied.example.test/all.avif", type: "image/avif" }),
      element("picture-image-denied", "img", { src: "https://denied.example.test/all.webp", alt: "Fallback description" })
    ]),
    element("picture-with-blocked-source", "picture", {}, [
      element("picture-source-optional-denied", "source", { srcSet: "https://denied.example.test/optional.avif", type: "image/avif" }),
      element("picture-image-allowed", "img", { src: "https://images.example.test/allowed.webp", alt: "Allowed description" })
    ]),
    element("video", "video", { src: "https://video.example.test/clip.mp4", poster: "https://denied.example.test/poster.webp", "aria-label": "Video" }),
    element("video-denied", "video", { src: "https://denied.example.test/clip.mp4", poster: "https://denied.example.test/blocked-poster.webp", "aria-label": "Unavailable video" }),
    { ...element("toggle", "div", {}, [
      element("toggled-video-denied", "video", { src: "https://denied.example.test/clip.mp4", poster: "https://images.example.test/for-unavailable-video.webp", title: "Unavailable interactive video" }),
      element("toggle-button", "button", { type: "button" }, [{ type: "text", text: "Play unavailable video" }])
    ]), interaction: { type: "video-toggle" } },
    { type: "component", id: "form", block: "ManagedEmbed", props: { refId, background: "white", initialHeight: 720 } }
  );
  for (const fontOrigin of ["https://fonts.example.test", "https://denied.example.test"]) {
    const document = structuredClone(snapshot.document);
    document.body[0].style = { base: { fontFamily: `url(${fontOrigin}/font.woff2)` } };
    assert.equal((await send("PUT", api + "/home/draft", { expectedVersion: snapshot.version, document })).status, 400);
  }
  const saved = await body(await send("PUT", api + "/home/draft", { expectedVersion: snapshot.version, document: snapshot.document }), 200);
  assert.equal((await publicFetch(resolvePath)).status, 404);
  const published = await publish(saved);
  const response = await publicFetch(PUBLIC_ORIGIN + publicPath + "?ignored=1");
  const html = await response.text(), csp = response.headers.get("Content-Security-Policy");
  assert.equal(response.status, 200);
  assert.match(html, /youtube-nocookie\.com\/embed\/abcdefghijk/u);
  assert.match(html, /calendar\.example\.test\/public/u);
  assert.doesNotMatch(html, /vimeo\.com|launchToken|unused\.example\.test|denied\.example\.test|fonts\.example\.test/u);
  assert.match(html, /<img[^>]+src="https:\/\/images\.example\.test\/cover\.webp"/u);
  assert.match(html, /srcSet="https:\/\/images\.example\.test\/cover\.avif"/iu);
  assert.match(html, /aria-label="Still described"/u);
  assert.match(html, /aria-label="Fallback description"/u);
  assert.match(html, /src="https:\/\/images\.example\.test\/allowed\.webp"/u);
  assert.match(html, /src="https:\/\/video\.example\.test\/clip\.mp4"/u);
  assert.match(html, /Unavailable video<\/span>/u);
  assert.match(html, /Unavailable interactive video<\/span>/u);
  assert.doesNotMatch(html, /Play unavailable video|for-unavailable-video\.webp/u);
  assert.equal([...html.matchAll(/<video\b/gu)].length, 1);
  assert.ok(html.includes(`data-managed-embed-ref="${refId}"`));
  assert.ok(html.includes(PUBLIC_EMBED_SCRIPT) && html.includes(PUBLIC_PRESENTATION_SCRIPT));
  assert.match(csp, /frame-src https:\/\/calendar\.example\.test https:\/\/lottie\.host https:\/\/niho\.life https:\/\/www\.youtube-nocookie\.com/u);
  assert.match(csp, /img-src 'self' https:\/\/\*\.google-analytics\.com https:\/\/images\.example\.test https:\/\/www\.googletagmanager\.com;/u);
  assert.match(csp, /media-src https:\/\/video\.example\.test;/u);
  assert.match(csp, /font-src 'none';/u);
  assert.doesNotMatch(csp, /unused\.example\.test|vimeo\.com|denied\.example\.test|fonts\.example\.test|https:(?:[ ;]|$)|https:\/\/\*\.google\.com/u);
  assert.match(csp, /form-action 'none'/u);
  const analyticsScript = /<script>([^<]+)<\/script>/u.exec(html)[1];
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(analyticsScript).digest("base64")}'`));
  assert.ok(html.includes(`www.googletagmanager.com/gtag/js?id=${measurementId}`));
  const resolved = await publicFetch(resolvePath);
  assert.equal(resolved.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await body(resolved, 200), { src });
  for (const path of [
    resolvePath + "&unexpected=1",
    resolvePath + "&_niho_embed=" + refId,
    `${PUBLIC_ORIGIN}/s/another/?_niho_embed=${refId}`,
    `${PUBLIC_ORIGIN}${publicPath}?_niho_embed=emb_${"a".repeat(32)}`
  ]) assert.equal((await publicFetch(path)).status, 404);
  const js = await publicFetch(PUBLIC_ORIGIN + PUBLIC_EMBED_SCRIPT);
  assert.match(js.headers.get("Content-Type"), /text\/javascript/u);
  assert.match(js.headers.get("Cache-Control"), /immutable/u);
  assert.equal((await publicFetch(PUBLIC_ORIGIN + "/_niho/other.js")).status, 404);

  const dom = new JSDOM(html, { url: PUBLIC_ORIGIN + publicPath + "?ignored=1", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.eval(analyticsScript);
  assert.equal(dom.window.dataLayer.filter((event) => event[0] === "config").length, 1);
  assert.equal(dom.window.dataLayer[1][2].page_location, PUBLIC_ORIGIN + publicPath);
  dom.window.fetch = (input) => {
    assert.equal(input, resolvePath);
    return publicFetch(input);
  };
  await initializePublicNihoEmbeds(dom.window.document, dom.window);
  const frame = dom.window.document.querySelector("[data-managed-embed-ref] iframe");
  assert.equal(new URL(frame.src).searchParams.get("parentHref"), PUBLIC_ORIGIN + publicPath);
  assert.match(frame.getAttribute("sandbox"), /allow-forms/u);
  const resize = (origin, source) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    origin, source, data: { type: "niho-embed-resize", height: 950 }
  }));
  resize("https://other.example.test", frame.contentWindow);
  resize("https://niho.life", dom.window);
  assert.equal(frame.style.height, "720px");
  resize("https://niho.life", frame.contentWindow);
  assert.equal(frame.style.height, "950px");
  for (const flow of ["inquiry", "dropin"]) dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    origin: "https://niho.life", source: frame.contentWindow, data: { type: "niho-embed-submitted", flow }
  }));
  const leads = dom.window.dataLayer.filter((event) => event[0] === "event" && event[1] === "generate_lead");
  assert.equal(leads.length, 1);
  assert.equal(leads[0][2].flow, "rental");

  const noindexDoc = { ...published.snapshot.document, meta: { noindex: true } };
  const noindexSaved = await body(await send("PUT", api + "/home/draft", { expectedVersion: published.snapshot.version, document: noindexDoc }), 200);
  await publish(noindexSaved);
  const noindexHtml = await (await publicFetch(PUBLIC_ORIGIN + publicPath, { headers: { "Cache-Control": "no-cache" } })).text();
  assert.match(noindexHtml, /name="robots" content="noindex, nofollow"/u);
  assert.ok(noindexHtml.includes(`www.googletagmanager.com/gtag/js?id=${measurementId}`));
  await body(await savePolicy({ frameOrigins: [], resourceOrigins: [], ga4MeasurementId: null }, savedPolicy.version), 200);
  const policyUpdatedPage = await body(await send("GET", api + "/home"), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", api + "/home/publish", { expectedVersion: policyUpdatedPage.version, action: "publish" }), 200);
  assert.equal((await publicFetch(resolvePath, { headers: { "Cache-Control": "no-cache" } })).status, 404);
  const revoked = await publicFetch(PUBLIC_ORIGIN + publicPath, { headers: { "Cache-Control": "no-cache" } });
  assert.match(revoked.headers.get("Content-Security-Policy"), /script-src 'none'/u);
  assert.doesNotMatch(await revoked.text(), /iframe|data-managed-embed-ref|type="module"|googletagmanager|images\.example\.test|video\.example\.test/u);
});

testWithD1("custom domain serves a noindex root page with its private NIHO embed and GA4 tag", async (t) => {
  const h = await fixture(t);
  const publicFetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cache-Control", "no-cache");
    return publishedSiteRequest(new Request(url, { ...init, headers }), h.env);
  };
  const cachedHtml = new Map();
  h.env.PUBLIC_HTML_CACHE = {
    async match(key) { return cachedHtml.get(key.url)?.clone() ?? null; },
    async put(key, response) { cachedHtml.set(key.url, response.clone()); }
  };
  const site = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Custom domain", slug: "custom-domain", locale: "ja" }), 201);
  const api = `/api/projects/${site.projectId}/sites/${site.siteId}/editor`;
  const domainPath = api + "/public-domain";
  const initial = await body(await h.send(MANAGEMENT_ORIGIN, "GET", domainPath), 200);
  assert.equal(initial.domain, null);
  assert.equal(initial.noindex, true);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", domainPath, { expectedVersion: initial.version, domain: "https://preview.example.test", noindex: true })).status, 422);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", domainPath, { expectedVersion: initial.version, domain: "studio.example", noindex: true })).status, 422);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", domainPath, { expectedVersion: initial.version, domain: "preview.example.test", noindex: true }, { token: h.otherToken })).status, 403);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", domainPath, { expectedVersion: initial.version, domain: "preview.example.test", noindex: true }), 200);
  const catalog = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/catalog`), 200);
  assert.deepEqual(new Set(catalog.sites[0].domains), new Set([PUBLIC_ORIGIN, "https://preview.example.test"]));
  const directory = await body(await h.send(MANAGEMENT_ORIGIN, "GET", "/api/projects"), 200);
  const listed = directory.entries.find((entry) => entry.project.id === site.projectId);
  assert.deepEqual(listed.project.site.domains, [PUBLIC_ORIGIN, "https://preview.example.test"]);
  const second = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Other domain", slug: "other-domain", locale: "ja" }), 201);
  const secondDomain = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `/api/projects/${second.projectId}/sites/${second.siteId}/editor/public-domain`), 200);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `/api/projects/${second.projectId}/sites/${second.siteId}/editor/public-domain`, {
    expectedVersion: secondDomain.version, domain: "preview.example.test", noindex: true
  })).status, 409);

  const frameOrigins = ["https://niho.life"];
  await setFixturePublicPolicy(h, site, { frameOrigins, resourceOrigins: [], ga4MeasurementId: "G-TEST12345" });
  const snapshot = await body(await h.send(MANAGEMENT_ORIGIN, "GET", api + "/home"), 200);
  const payload = { v: 1, flow: "inquiry", spotId: "example", publicId: "example", launchTokenVersion: 1,
    parentOrigin: "https://preview.example.test", allowedPathPrefix: "/" };
  const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"a".repeat(43)}`;
  const src = `https://niho.life/embed/inquiry/example?launchToken=${token}`;
  const { refId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", api + "/home/embed-connection", { locale: "ja", src }), 201);
  snapshot.document.meta = { noindex: true };
  snapshot.document.body[0].children.push(
    { type: "element", id: "hero", tag: "img", attrs: { src: "/media/hero.webp", alt: "Hero" }, children: [] },
    { type: "component", id: "form", block: "ManagedEmbed", props: { refId, background: "white", initialHeight: 720 } }
  );
  const saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", api + "/home/draft", { expectedVersion: snapshot.version, document: snapshot.document }), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", api + "/home/publish", { expectedVersion: saved.version, action: "publish" }), 200);

  const response = await publicFetch("https://preview.example.test/");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>Custom domain<\/title>/u);
  assert.match(html, /name="robots" content="noindex, nofollow"/u);
  assert.match(html, /src="\/media\/hero\.webp"/u);
  assert.match(html, /data-managed-embed-ref="[^"]+"/u);
  assert.match(html, /www\.googletagmanager\.com\/gtag\/js\?id=G-TEST12345/u);
  assert.match(response.headers.get("Content-Security-Policy"), /https:\/\/niho\.life/u);
  assert.match(response.headers.get("Cache-Control"), /no-cache/u);
  assert.ok(response.headers.get("ETag"));
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.doesNotMatch(html, /\/s\/custom-domain/u);
  assert.equal(cachedHtml.size, 1);
  const revalidated = await publicFetch("https://preview.example.test/", { headers: { "If-None-Match": response.headers.get("ETag") } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(await (await publicFetch("https://preview.example.test/")).text(), html);
  assert.equal(cachedHtml.size, 1);
  const changed = await body(await h.send(MANAGEMENT_ORIGIN, "GET", api + "/home"), 200);
  changed.document.title = "Custom domain updated";
  const changedDraft = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", api + "/home/draft", { expectedVersion: changed.version, document: changed.document }), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", api + "/home/publish", { expectedVersion: changedDraft.version, action: "publish" }), 200);
  assert.match(await (await publicFetch("https://preview.example.test/")).text(), /<title>Custom domain updated<\/title>/u);
  assert.equal(cachedHtml.size, 2);
  const publicScript = await publicFetch("https://preview.example.test/_niho/niho-embeds-012345abcdef.js");
  assert.equal(publicScript.status, 200);
  assert.equal(publicScript.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.notEqual((await publicFetch("https://unknown.example.test/")).status, 200);
  const robots = await publicFetch("https://preview.example.test/robots.txt");
  assert.equal(robots.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await robots.text(), /Disallow: \/\n/u);
  const sitemap = await publicFetch("https://preview.example.test/sitemap.xml");
  const sitemapBody = await sitemap.text();
  assert.match(sitemapBody, /<urlset/u);
  assert.doesNotMatch(sitemapBody, /preview\.example\.test/u);

  h.sqlite.exec(await readFile(new URL("../studio/post-deploy/0026_drop_managed_site_domain_mirror.sql", import.meta.url), "utf8"));
  const postMigrationDomain = await body(await h.send(MANAGEMENT_ORIGIN, "GET", domainPath), 200);
  const postMigrationUpdate = await body(await h.send(MANAGEMENT_ORIGIN, "POST", domainPath, {
    expectedVersion: postMigrationDomain.version, domain: "preview.example.test", noindex: true
  }), 200);
  assert.equal(postMigrationUpdate.domain, "preview.example.test");
  const clearedDomain = await body(await h.send(MANAGEMENT_ORIGIN, "POST", domainPath, {
    expectedVersion: postMigrationUpdate.version, domain: null, noindex: false
  }), 200);
  assert.deepEqual({ domain: clearedDomain.domain, noindex: clearedDomain.noindex }, { domain: null, noindex: true });
});

testWithD1("managed SEO renders alternates and JSON-LD, publishes discovery files, redirects old paths and returns a 404 page", async (t) => {
  const h = await fixture(t);
  const publicFetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cache-Control", "no-cache");
    return h.fetch(url, { ...init, headers });
  };
  const site = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "SEO Fixture", slug: "seo-fixture", locale: "ja" }), 201);
  const api = `/api/projects/${site.projectId}/sites/${site.siteId}/editor`;
  const seoPath = api + "/seo-settings", cliSeoPath = `/api/edit/v2/sites/${site.siteId}/operations/site.seo.read`;
  const initialSeo = await body(await h.send(MANAGEMENT_ORIGIN, "GET", seoPath), 200);
  const cliRead = await body(await h.send(MANAGEMENT_ORIGIN, "GET", cliSeoPath, undefined, { cli: true }), 200);
  assert.deepEqual(cliRead.settings, initialSeo.settings);
  const redirectsPath = api + "/redirects", cliRedirectPath = `/api/edit/v2/sites/${site.siteId}/operations/site.redirects.read`;
  const initialRedirects = await body(await h.send(MANAGEMENT_ORIGIN, "GET", redirectsPath), 200);
  const cliRedirectRead = await body(await h.send(MANAGEMENT_ORIGIN, "GET", cliRedirectPath, undefined, { cli: true }), 200);
  assert.deepEqual(cliRedirectRead, initialRedirects);
  assert.deepEqual(initialRedirects.redirects, []);
  const invalidRedirects = [
    [{ locale: "ja", fromPath: "https://outside.example/path", toPath: "/new-path" }],
    [{ locale: "ja", fromPath: "/old-path", toPath: "/next-path" }, { locale: "en", fromPath: "/old-path", toPath: "/other-path" }],
    [{ locale: "ja", fromPath: "/cycle-a", toPath: "/cycle-b" }, { locale: "ja", fromPath: "/cycle-b", toPath: "/cycle-a" }]
  ];
  for (const redirects of invalidRedirects) {
    assert.equal((await h.send(MANAGEMENT_ORIGIN, "PUT", redirectsPath, { redirects, expectedVersion: initialRedirects.version })).status, 422);
  }
  const firstRedirects = [{ locale: "ja", fromPath: "/legacy-page", toPath: "/about" }];
  const savedRedirects = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", redirectsPath,
    { redirects: firstRedirects, expectedVersion: initialRedirects.version }), 200);
  assert.deepEqual(savedRedirects.redirects, firstRedirects);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "PUT", redirectsPath,
    { redirects: [], expectedVersion: initialRedirects.version })).status, 409, "redirect edits use version checking");
  const seoSettings = {
    siteName: "SEO Site Name", description: "サイト共通の説明", defaultOgImage: "/images/site-og.png",
    verificationTags: [{ name: "google-site-verification", content: "verify-code-123" }],
    organization: { name: "SEO Organization", url: "https://organization.example", logo: "https://organization.example/logo.png", sameAs: ["https://social.example/organization"] },
    robotsPolicy: "index", ga4MeasurementId: "G-SEO12345"
  };
  const invalidSeo = await h.send(MANAGEMENT_ORIGIN, "POST", seoPath, {
    expectedVersion: cliRead.version, settings: { ...seoSettings, defaultOgImage: "/images/og.png#fragment" }
  });
  assert.equal(invalidSeo.status, 422, "OG images cannot include URL fragments");
  const savedSeo = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", cliSeoPath.replace("site.seo.read", "site.seo.save"),
    { expectedVersion: cliRead.version, settings: seoSettings }, { cli: true, headers: { "X-Studio-CMS-Version": "2" } }), 200);
  assert.deepEqual(savedSeo.settings, seoSettings);
  const publicSettingsPath = api + "/public-settings";
  const publicSettings = await body(await h.send(MANAGEMENT_ORIGIN, "GET", publicSettingsPath), 200);
  const oldEditorSave = await body(await h.send(MANAGEMENT_ORIGIN, "POST", publicSettingsPath,
    { expectedVersion: publicSettings.version, settings: { frameOrigins: [], resourceOrigins: [] } }), 200);
  assert.deepEqual(oldEditorSave.settings.seo, seoSettings, "public policy edits preserve the versioned SEO document");
  const release = async (pageId, _locale, version) => {
    return body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/${pageId}/publish`, { expectedVersion: version, action: "publish" }), 200);
  };
  let home = await body(await h.send(MANAGEMENT_ORIGIN, "GET", api + "/home"), 200);
  home.document.meta = { description: "日本語の説明", structuredData: ["organization"] };
  let saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", api + "/home/draft", { expectedVersion: home.version, document: home.document }), 200);
  await release("home", "ja", saved.version);

  const englishChange = { action: "create", siteId: site.siteId, locale: "en", title: "English home", path: "/en" };
  const englishCreated = await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), englishChange);
  let english = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${englishCreated.page.pageId}`), 200);
  english.document.meta = { description: "English description" };
  saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/${englishCreated.page.pageId}/draft`, { expectedVersion: english.version, document: english.document }), 200);
  await release(englishCreated.page.pageId, "en", saved.version);
  home = await body(await h.send(MANAGEMENT_ORIGIN, "GET", api + "/home"), 200);
  await release("home", "ja", home.version);

  const aboutChange = { action: "create", siteId: site.siteId, locale: "ja", title: "About", path: "/about" };
  const aboutCreated = await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), aboutChange);
  const about = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${aboutCreated.page.pageId}`), 200);
  about.document.title = "SEO Fixture";
  about.document.meta = { description: "日本語の説明" };
  const longMissingPath = `/not-published/${"x".repeat(1100)}`;
  about.document.body[0].children.push({ type: "element", id: "missing-link", tag: "a", attrs: { href: longMissingPath },
    children: [{ type: "text", text: "未公開ページ" }] });
  const aboutSaved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/${aboutCreated.page.pageId}/draft`,
    { expectedVersion: about.version, document: about.document }), 200);
  const aboutPublished = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/${aboutCreated.page.pageId}/publish`,
    { expectedVersion: aboutSaved.version, action: "publish" }), 200);
  const warningCodes = aboutPublished.warnings.map(({ code }) => code);
  assert.ok(warningCodes.includes("duplicate-title"));
  assert.ok(warningCodes.includes("duplicate-description"));
  assert.ok(warningCodes.includes("broken-internal-link"));
  assert.ok(aboutPublished.warnings.find(({ code }) => code === "broken-internal-link").message.length <= 1000);
  const directPublish = await body(await h.send(MANAGEMENT_ORIGIN, "POST",
    `/api/edit/v1/sites/${site.siteId}/operations/pages.publish/${aboutCreated.page.pageId}?locale=ja`, { action: "publish", expectedVersion: aboutPublished.snapshot.version }), 200);
  assert.ok(directPublish.warnings.some(({ code }) => code === "broken-internal-link"));

  const html = await (await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/`)).text();
  assert.match(html, /hreflang="en" href="https:\/\/sites\.example\/s\/seo-fixture\/en"/u);
  assert.match(html, /hreflang="ja" href="https:\/\/sites\.example\/s\/seo-fixture\/"/u);
  assert.match(html, /hreflang="x-default"/u);
  assert.match(html, /application\/ld\+json/u);
  assert.match(html, /"@type":"Organization"/u);
  assert.match(html, /"name":"SEO Organization"/u);
  assert.match(html, /<meta name="google-site-verification" content="verify-code-123">/u);
  assert.match(html, /<meta property="og:site_name" content="SEO Site Name">/u);
  assert.match(html, /<meta property="og:image" content="https:\/\/sites\.example\/s\/seo-fixture\/images\/site-og\.png">/u);
  assert.match(html, /G-SEO12345/u);
  assert.match(html, /<meta name="description" content="日本語の説明">/u);
  const sitemap = await (await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/sitemap.xml`)).text();
  assert.match(sitemap, /<loc>https:\/\/sites\.example\/s\/seo-fixture\/en<\/loc>/u);
  assert.match(sitemap, /hreflang="en"/u);
  assert.match(await (await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/robots.txt`)).text(), /Sitemap: https:\/\/sites\.example\/s\/seo-fixture\/sitemap\.xml/u);
  assert.match(await (await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/llms.txt`)).text(), /English home/u);
  assert.match(await (await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/llms-full.txt`)).text(), /日本語の説明|# SEO Site Name/u);
  const siteDefaultPage = await (await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/about`)).text();
  assert.match(siteDefaultPage, /"description":"サイト共通の説明"/u);
  const upper = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/ABOUT`);
  assert.equal(upper.status, 301);
  assert.equal(upper.headers.get("Location"), `${PUBLIC_ORIGIN}/s/seo-fixture/about`);
  const slash = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/about/`);
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get("Location"), `${PUBLIC_ORIGIN}/s/seo-fixture/about`);
  const redirectBeforeMove = await body(await h.send(MANAGEMENT_ORIGIN, "GET", redirectsPath), 200);
  assert.deepEqual(redirectBeforeMove.redirects, firstRedirects);
  const move = { action: "update", target: { siteId: site.siteId, pageId: aboutCreated.page.pageId, locale: "ja" }, title: "About", path: "/about-us" };
  const moved = await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), move);
  const redirectAfterMove = await body(await h.send(MANAGEMENT_ORIGIN, "GET", redirectsPath), 200);
  assert.notEqual(redirectAfterMove.version, redirectBeforeMove.version, "page path changes invalidate old redirect snapshots");
  assert.deepEqual(redirectAfterMove.redirects, [
    { locale: "ja", fromPath: "/about", toPath: "/about-us" },
    { locale: "ja", fromPath: "/legacy-page", toPath: "/about-us" }
  ]);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "PUT", redirectsPath,
    { redirects: savedRedirects.redirects, expectedVersion: savedRedirects.version })).status, 409,
  "an old CLI snapshot cannot erase a redirect generated by moving a page");
  assert.equal((await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/about`)).status, 301, "published URL changes update the static manifest immediately");
  assert.equal((await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/about-us`)).status, 200);
  const movedSnapshot = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${aboutCreated.page.pageId}`), 200);
  await release(aboutCreated.page.pageId, "ja", movedSnapshot.version);
  const old = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/about`);
  assert.equal(old.status, 301);
  assert.equal(old.headers.get("Location"), `${PUBLIC_ORIGIN}/s/seo-fixture/about-us`);
  const legacy = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/legacy-page`);
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get("Location"), `${PUBLIC_ORIGIN}/s/seo-fixture/about-us`);
  const missing = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/missing`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /ページが見つかりません/u);
  const currentSeo = await body(await h.send(MANAGEMENT_ORIGIN, "GET", seoPath), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", seoPath, {
    expectedVersion: currentSeo.version, settings: { ...currentSeo.settings, robotsPolicy: "noindex" }
  }), 200);
  home = await body(await h.send(MANAGEMENT_ORIGIN, "GET", api + "/home"), 200);
  await release("home", "ja", home.version);
  english = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${englishCreated.page.pageId}`), 200);
  await release(englishCreated.page.pageId, "en", english.version);
  const aboutBeforeNoindex = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${aboutCreated.page.pageId}`), 200);
  await release(aboutCreated.page.pageId, "ja", aboutBeforeNoindex.version);
  const noindexRobots = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/robots.txt`);
  assert.match(await noindexRobots.text(), /Disallow: \/\n/u);
  assert.equal(noindexRobots.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const noindexSitemap = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/sitemap.xml`);
  assert.equal(noindexSitemap.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.doesNotMatch(await noindexSitemap.text(), /<loc>/u);
  const noindexPage = await publicFetch(`${PUBLIC_ORIGIN}/s/seo-fixture/about-us`);
  assert.equal(noindexPage.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await noindexPage.text(), /name="robots" content="noindex, nofollow"/u);
});


testWithD1("managed project creation logs a safe D1 failure category without exposing its message", async (t) => {
  const h = await fixture(t), logged = [];
  t.mock.method(console, "error", (...args) => { logged.push(args); });
  logged.length = 0;
  h.faults.managedProjectBatch = new Error("D1_ERROR: CHECK constraint failed: private_actor@example.test");
  const response = await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", {
    title: "Failure fixture", slug: "failure-fixture", locale: "ja"
  });
  await body(response, 503);
  assert.deepEqual(logged.find(([message]) => message === "NIHO Studio managed project D1 batch failed"),
    ["NIHO Studio managed project D1 batch failed", "d1-check-constraint"]);
  assert.equal(JSON.stringify(logged).includes("private_actor@example.test"), false);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_sites").get().count, 0);
});

testWithD1("managed project creation accepts D1 change counts that include trigger rows", async (t) => {
  const h = await fixture(t);
  h.faults.managedSiteTriggerChanges = true;
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", {
    title: "Trigger fixture", slug: "trigger-fixture", locale: "ja"
  }), 201);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_sites").get().count, 1);
});

testWithD1("Studio-native site stores page sources in R2 for GUI, CAS, history and public rendering", async (t) => {
  const h = await fixture(t);
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Fixture site", slug: "fixture-site", locale: "ja" }), 201);
  const { projectId, siteId } = created, api = `/api/projects/${projectId}/sites/${siteId}/editor`;
  const publicRequest = (method, path) => publishedSiteRequest(new Request(`${PUBLIC_ORIGIN}${path}`, { method,
    headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(created.editorPath, `/projects/${projectId}/sites/${siteId}/editor`);
  assert.equal(h.sqlite.prepare("SELECT public_origin FROM sites WHERE id = ?").get(siteId).public_origin, null);
  assert.equal(h.sqlite.prepare("SELECT slug FROM managed_sites WHERE site_id = ?").get(siteId).slug, "fixture-site");
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Duplicate", slug: "fixture-site", locale: "ja" })).status, 409);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Invalid", slug: "Bad Slug", locale: "ja" })).status, 400);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_sites").get().count, 1);

  // 作成直後は保存済み下書きだけで、公開originには何も出ない。
  assert.equal((await publicRequest("GET", "/s/fixture-site/")).status, 404);
  assert.equal((await publicRequest("GET", "/assets/app.js")).status, 404);
  const catalog = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/catalog`), 200);
  assert.deepEqual(catalog.pageChangeActions, ["create", "update", "visibility"]);
  assert.equal(catalog.pages[0].pageId, "home");
  const first = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  assert.equal(first.document.revision, 1);

  const edited = structuredClone(first.document);
  edited.body[0].children.push({ type: "element", id: "link", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "About" }] });
  const saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/home/draft`, { expectedVersion: first.version, document: edited }), 200);
  assert.equal(saved.revision, 2);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_versions WHERE site_id = ? AND page_id = 'home'").get(siteId).count, 1);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/home/draft`, { expectedVersion: first.version, document: edited })).status, 409);

  // GUI経路で版2を公開。履歴行とpointerがbatchで揃い、公開HTMLはpath prefix・head・CSPを持つ。
  const released2 = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: saved.version, action: "publish" }), 200);
  assert.notEqual(released2.snapshot.version, saved.version);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: saved.version, action: "publish" })).status, 409);
  const public2 = await publicRequest("GET", "/s/fixture-site/");
  assert.equal(public2.status, 200);
  const html2 = await public2.text();
  assert.match(html2, /href="\/s\/fixture-site\/about"/u);
  assert.match(html2, /<link rel="canonical" href="https:\/\/sites\.example\/s\/fixture-site\/">/u);
  assert.match(html2, /<title>Fixture site<\/title>/u);
  assert.match(public2.headers.get("Content-Security-Policy"), /script-src 'none'/u);
  const head = await publicRequest("HEAD", "/s/fixture-site/");
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  const canonicalRedirect = await publicRequest("GET", "/s/fixture-site?utm_source=test");
  assert.equal(canonicalRedirect.status, 308);
  assert.equal(canonicalRedirect.headers.get("Location"), `${PUBLIC_ORIGIN}/s/fixture-site/?utm_source=test`);
  assert.equal((await publicRequest("GET", "/s/fixture-site/?utm_source=test")).status, 200);

  // 公開済み版2から新しい版を作り、編集画面と公開URLに同じ内容を復元する。
  const current = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200), thirdDocument = structuredClone(current.document);
  thirdDocument.title = "Third version";
  thirdDocument.meta = { noindex: true };
  const saved3 = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/home/draft`, { expectedVersion: current.version, document: thirdDocument }), 200);
  const released3 = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: saved3.version, action: "publish" }), 200);
  const thirdHtml = await (await publicRequest("GET", "/s/fixture-site/")).text();
  assert.match(thirdHtml, /<title>Third version<\/title>/u);
  assert.match(thirdHtml, /name="robots" content="noindex, nofollow"/u);
  assert.doesNotMatch(thirdHtml, /rel="canonical"/u);
  const restored = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: released3.snapshot.version, action: "restore", revision: 2 }), 200);
  assert.deepEqual(restored.snapshot.document, { ...released2.snapshot.document, revision: 4 });
  const editorRestored = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  assert.deepEqual(editorRestored.document, restored.snapshot.document);
  assert.match(await (await publicRequest("GET", "/s/fixture-site/")).text(), /<title>Fixture site<\/title>/u);
  assert.equal(h.sqlite.prepare("SELECT published_revision FROM managed_pages WHERE site_id = ? AND page_id = 'home'").get(siteId).published_revision, 4);
  const history = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home/history`), 200);
  assert.deepEqual(history.entries.map(({ revision, kind }) => [revision, kind]), [[4, "rollback"], [3, "publish"], [2, "publish"]]);
  assert.equal(history.entries[0].id, "rev-4");
  assert.deepEqual((await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/history-read`, { id: "rev-2" }), 200)).document, released2.snapshot.document);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/history-read`, { id: "rev-999" })).status, 404);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home/history?cursor=invalid`)).status, 400);
  const directPublish = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: restored.snapshot.version, action: "publish" }), 200);
  assert.equal(directPublish.status, "released");
  assert.equal(directPublish.snapshot.document.revision, 4);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_editor_plans").get().count, 0);
  h.sqlite.exec(await readFile(new URL("../studio/post-deploy/0025_drop_managed_editor_plans.sql", import.meta.url), "utf8"));
  assert.equal(h.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'managed_editor_plans'").get(), undefined);
  const directRestore = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: directPublish.snapshot.version, action: "restore", revision: 2 }), 200);
  assert.equal(directRestore.status, "released");
  assert.deepEqual(directRestore.snapshot.document, { ...released2.snapshot.document, revision: 5 });
  assert.equal(h.sqlite.prepare("SELECT published_revision FROM managed_pages WHERE site_id = ? AND page_id = 'home'").get(siteId).published_revision, 5);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: directRestore.snapshot.version, action: "restore", revision: 999 })).status, 409);

  // 同じpage-change operationで別ページを作る。公開前はpublic GETに出ない。
  const createChange = { action: "create", siteId, locale: "ja", title: "About", path: "/about" };
  const applied = await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), createChange);
  assert.equal(applied.page.path, "/about");
  assert.equal((await publicRequest("GET", "/s/fixture-site/about")).status, 404);

  const aboutTarget = { siteId, pageId: applied.page.pageId, locale: "ja" };
  const about = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${aboutTarget.pageId}`), 200);
  const move = { action: "update", target: aboutTarget, title: "About", path: "/about-us" };
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes`, { change: move, expectedVersion: about.version }), 200);
  const visibility = { action: "visibility", target: aboutTarget, visibility: "private" };
  const update = (expectedVersion, token) => h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes`, { change: visibility, expectedVersion }, { token });
  assert.deepEqual(await body(await update(about.version), 409), { error: "version_conflict" });
  const moved = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${aboutTarget.pageId}`), 200);
  assert.equal((await update(moved.version, h.otherToken)).status, 403);
  assert.equal((await body(await update(moved.version), 200)).page.visibility, "private");
  assert.deepEqual(await body(await update(moved.version), 409), { error: "version_conflict" });

  // 現在の membership がない利用者は同じサイトを操作できない。
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/catalog`, undefined, { token: h.otherToken })).status, 403);
});

testWithD1("Managed page sources over 600 KiB save, publish, replay operations, and restore from R2", async (t) => {
  const h = await fixture(t), slug = "large-page";
  const { projectId, siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Large page", slug, locale: "ja" }), 201);
  const editor = `/api/projects/${projectId}/sites/${siteId}/editor/home`;
  const gui = (method, suffix = "", input) => h.send(MANAGEMENT_ORIGIN, method, editor + suffix, input);
  const cli = (method, operation, input) => h.send(MANAGEMENT_ORIGIN, method, `/api/edit/v1/sites/${siteId}/operations/pages.${operation}/home?locale=ja`, input, { cli: true });
  const release = async (expectedVersion, requested) => {
    return body(await gui("POST", "/publish", { expectedVersion, ...requested }), 200);
  };

  const original = await body(await gui("GET"), 200);
  const large = structuredClone(original.document), text = "海".repeat(40_000);
  large.body[0].children.push(...Array.from({ length: 8 }, () => ({ type: "text", text })));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 600 * 1024);
  const oversized = structuredClone(original.document);
  oversized.body[0].children.push(...Array.from({ length: 9 }, () => ({ type: "text", text: "海".repeat(85_000) })));
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 2 * 1024 * 1024);
  assert.equal((await gui("PUT", "/draft", { expectedVersion: original.version, document: oversized })).status, 400);
  assert.equal((await cli("PUT", "save", { expectedVersion: original.version, document: oversized })).status, 400);

  const saved = await body(await gui("PUT", "/draft", { expectedVersion: original.version, document: large }), 200);
  const document = { ...large, revision: saved.revision };
  assert.deepEqual((await body(await gui("GET"), 200)).document, document);
  assert.deepEqual((await body(await cli("GET", "read"), 200)).document, document);
  assert.deepEqual((await body(await cli("POST", "history-read", { id: `rev-${saved.revision}` }), 200)).document, document);
  const version = h.sqlite.prepare(`SELECT document_json, document_key, document_digest, link_index_json
    FROM managed_page_versions WHERE site_id = ? AND page_id = 'home' AND revision = ?`);
  const row = version.get(siteId, saved.revision), source = h.objects.get(row.document_key);
  assert.equal(row.document_json, "{}");
  assert.equal(row.document_key, `sites/${siteId}/pages/home/ja/${saved.revision}/${saved.version}.json`);
  assert.equal(row.document_digest, createHash("sha256").update(source).digest("hex"));
  assert.equal(row.link_index_json, "[]");
  assert.deepEqual(JSON.parse(source), document);

  const published = await release(saved.version, { action: "publish" });
  const publicPage = () => publishedSiteRequest(new Request(`${PUBLIC_ORIGIN}/s/${slug}/`), h.env);
  assert.match(await (await publicPage()).text(), /海{40}/u);
  const operation = { baseVersion: published.snapshot.version, operationId: crypto.randomUUID(),
    operations: [{ type: "text", parentId: "heading", childPath: [0], value: "Edited by CLI" }] };
  const applied = await body(await cli("POST", "apply", operation), 200);
  const receipt = JSON.parse(h.sqlite.prepare("SELECT result_json FROM managed_page_operations WHERE site_id = ? AND operation_id = ?").get(siteId, operation.operationId).result_json);
  assert.equal(receipt.documentKey, version.get(siteId, applied.revision).document_key);
  assert.equal(receipt.document, undefined);

  const small = await body(await cli("PUT", "save", { expectedVersion: applied.version, document: { ...original.document, revision: applied.revision } }), 200);
  assert.equal(version.get(siteId, applied.revision), undefined);
  assert.deepEqual(await body(await cli("POST", "apply", operation), 200), applied);
  const rolledBack = await release(small.version, { action: "restore", revision: saved.revision });
  const restoredDocument = { ...document, revision: small.document.revision + 1 };
  assert.deepEqual(rolledBack.snapshot.document, restoredDocument);
  const restored = version.get(siteId, restoredDocument.revision);
  assert.equal(restored.document_json, "{}");
  assert.notEqual(restored.document_key, row.document_key);
  assert.deepEqual(JSON.parse(h.objects.get(restored.document_key)), restoredDocument);
  assert.match(await (await publicPage()).text(), /海{40}/u);
});

testWithD1("Legacy page sources preserve exact D1 bytes and links across a retried R2 transition", async (t) => {
  const h = await fixture(t), slug = "legacy-page";
  const { projectId, siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Legacy fixture", slug, locale: "ja" }), 201);
  const api = `/api/projects/${projectId}/sites/${siteId}/editor`;
  const gui = (method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input);
  const legacy = { schemaVersion: 1, siteId, pageId: "legacy", locale: "ja", revision: 1, title: "旧ページ", tokens: {},
    body: [{ type: "element", id: "legacy-link", tag: "a", attrs: { href: "/#about" }, children: [{ type: "text", text: "ホーム" }] }] };
  const raw = JSON.stringify(legacy, null, 2) + "\n";
  h.sqlite.prepare(`INSERT INTO managed_pages (site_id, page_id, locale, title, path, current_version, current_revision, published_revision)
    VALUES (?, 'legacy', 'ja', '旧ページ', '/old', 'legacy-1', 1, 1)`).run(siteId);
  h.sqlite.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject)
    VALUES (?, 'legacy', 'ja', 1, ?, 'initial', ?)`).run(siteId, raw, OWNER);
  const version = () => h.sqlite.prepare(`SELECT document_json, document_key, document_digest, link_index_json
    FROM managed_page_versions WHERE site_id = ? AND page_id = 'legacy'`).get(siteId);

  h.faults.put = "after";
  assert.deepEqual((await body(await gui("GET", "/legacy"), 200)).document, legacy);
  assert.equal(version().document_json, raw);
  assert.equal(version().document_key, null);
  const key = `sites/${siteId}/pages/legacy/ja/1/legacy.json`;
  h.objects.set(key, JSON.stringify(legacy));
  assert.deepEqual((await body(await gui("GET", "/legacy"), 200)).document, legacy);
  assert.equal(version().document_json, raw);
  assert.equal(version().document_key, null);
  h.objects.set(key, raw);
  h.faults.externalization = true;
  assert.deepEqual((await body(await gui("GET", "/legacy"), 200)).document, legacy);
  assert.equal(version().document_json, raw);
  assert.equal(version().document_key, null);

  const responses = await Promise.all([gui("GET", "/legacy"), gui("GET", "/legacy")]);
  for (const response of responses) assert.deepEqual((await body(response, 200)).document, legacy);
  const moved = version();
  assert.equal(moved.document_json, "{}");
  assert.equal(h.objects.get(moved.document_key), raw);
  assert.equal(moved.document_digest, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(JSON.parse(moved.link_index_json), [["legacy-link", "/"]]);
  assert.throws(() => h.sqlite.prepare(`UPDATE managed_page_versions SET document_json = '[]'
    WHERE site_id = ? AND page_id = 'legacy'`).run(siteId), /immutable/u);
  assert.equal((await publishedSiteRequest(new Request(`${PUBLIC_ORIGIN}/s/${slug}/old`, { headers: { "Cache-Control": "no-cache" } }), h.env)).status, 404,
    "a legacy D1 publication without a generated manifest artifact is not served dynamically");
});

testWithD1("Missing or modified R2 page sources keep the immutable static publication available", async (t) => {
  const h = await fixture(t), slug = "damaged-source";
  const { projectId, siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Verified page", slug, locale: "ja" }), 201);
  const editor = `/api/projects/${projectId}/sites/${siteId}/editor/home`;
  const gui = (method, suffix = "", input) => h.send(MANAGEMENT_ORIGIN, method, editor + suffix, input);
  const snapshot = await body(await gui("GET"), 200);
  const publish = (expectedVersion) => gui("POST", "/publish", { expectedVersion, action: "publish" });
  const published = await body(await publish(snapshot.version), 200);
  const { document_key: key } = h.sqlite.prepare("SELECT document_key FROM managed_page_versions WHERE site_id = ? AND page_id = 'home'").get(siteId);
  const pointer = () => h.sqlite.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(siteId).manifest_key;
  const liveManifest = pointer(), url = `${PUBLIC_ORIGIN}/s/${slug}/`;
  const submit = () => publish(published.snapshot.version);

  h.objects.set(key, h.objects.get(key) + "\n");
  assert.equal((await gui("GET")).status, 503);
  const legacy = await h.fetch(url, { headers: { "Cache-Control": "no-cache" } });
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /<title>Verified page<\/title>/u);
  assert.equal((await submit()).status, 503);
  assert.equal(pointer(), liveManifest);

  h.objects.delete(key);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `/api/edit/v1/sites/${siteId}/operations/pages.read/home?locale=ja`, undefined, { cli: true })).status, 503);
  assert.equal((await h.fetch(url, { headers: { "Cache-Control": "no-cache" } })).status, 200);
  assert.equal((await submit()).status, 503);
  assert.equal(pointer(), liveManifest);
  const artifact = await publishedSiteRequest(new Request(url, { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(artifact.status, 200);
  assert.match(await artifact.text(), /<title>Verified page<\/title>/u);
});

testWithD1("Studio Editing API publishes one time and exposes the same revision history", async (t) => {
  const h = await fixture(t, { cms: true });
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Direct publish", slug: "direct-publish", locale: "ja" }), 201);
  const { siteId } = created, base = `/api/edit/v1/sites/${siteId}`;
  const discovered = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${base}/capabilities`), 200);
  assert.ok(discovered.operations.some(({ id }) => id === "pages.publish"));
  assert.ok(discovered.operations.some(({ id }) => id === "pages.history"));
  assert.ok(discovered.operations.some(({ id }) => id === "pages.change"));
  assert.ok(discovered.operations.every(({ id }) => !["pages.release-plan", "pages.release", "cms.publish-plan", "cms.publish"].includes(id)));
  const first = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${base}/operations/pages.read/home?locale=ja`), 200);
  const edited = { ...structuredClone(first.document), title: "One-step publish" };
  const saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${base}/operations/pages.save/home?locale=ja`, { expectedVersion: first.version, document: edited }), 200);
  const publishPath = `${base}/operations/pages.publish/home?locale=ja`;
  const publish = (input) => h.send(MANAGEMENT_ORIGIN, "POST", publishPath, input);
  assert.equal((await publish({ action: "publish" })).status, 400);
  assert.deepEqual(await body(await publish({ expectedVersion: first.version, action: "publish" }), 409), { error: "version_conflict" });
  assert.deepEqual((await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${base}/operations/pages.read/home?locale=ja`), 200)).document, saved.document);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE site_id = ?").get(siteId).count, 0);
  const published = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${base}/operations/pages.publish/home?locale=ja`, { expectedVersion: saved.version, action: "publish" }), 200);
  assert.equal(published.status, "released");
  assert.equal(published.url, "https://sites.example/s/direct-publish/");
  assert.ok(Array.isArray(published.warnings));
  assert.equal(published.snapshot.document.title, "One-step publish");
  assert.equal(published.snapshot.editorState.releases[0].revision, saved.document.revision);
  const publishedState = h.sqlite.prepare("SELECT version, manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(siteId);
  assert.notEqual(publishedState.version, "initial");
  assert.ok(publishedState.manifest_key && h.objects.has(publishedState.manifest_key));
  const publicPage = await h.send(PUBLIC_ORIGIN, "GET", "/s/direct-publish/", undefined, { auth: false });
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /<title>One-step publish<\/title>/u);
  const history = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${base}/operations/pages.history/home?locale=ja`), 200);
  assert.deepEqual(history.entries.map(({ kind }) => kind), ["publish"]);
  assert.equal((await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${base}/operations/pages.history-read/home?locale=ja`, { id: `rev-${saved.document.revision}` }), 200)).document.title, "One-step publish");
  const restoreInput = { action: "restore", revision: saved.document.revision };
  assert.deepEqual(await body(await publish({ expectedVersion: saved.version, ...restoreInput }), 409), { error: "version_conflict" });
  const restored = await body(await publish({ expectedVersion: published.snapshot.version, ...restoreInput }), 200);
  assert.equal(restored.status, "released");
  assert.equal(restored.snapshot.document.title, "One-step publish");
  assert.equal(restored.snapshot.document.revision, saved.document.revision + 1);
  const restoredState = h.sqlite.prepare("SELECT version, manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(siteId);
  assert.notEqual(restoredState.version, publishedState.version);
  assert.ok(restoredState.manifest_key && h.objects.has(restoredState.manifest_key));
  const restoredSitemap = await publishedSiteRequest(new Request("https://sites.example/s/direct-publish/sitemap.xml"), h.env);
  assert.equal(restoredSitemap.status, 200, "restoring a page keeps the manifest revision aligned with the publication row");
  assert.match(await restoredSitemap.text(), /https:\/\/sites\.example\/s\/direct-publish\//u);
  const artifact = h.sqlite.prepare("SELECT artifact_key FROM managed_page_publications WHERE site_id = ? AND page_id = 'home' AND locale = 'ja'").get(siteId);
  const publishedHtml = String(h.objects.get(artifact.artifact_key));
  assert.match(publishedHtml, /<link rel="canonical" href="https:\/\/sites\.example\/s\/direct-publish\/">/u);
  assert.match(publishedHtml, /property="og:url" content="https:\/\/sites\.example\/s\/direct-publish\/"/u);
  assert.doesNotMatch(publishedHtml, /studio\.invalid/u);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${base}/operations/pages.publish/home?locale=ja`, { action: "restore", revision: -1 })).status, 400);
});

testWithD1("Studio Editing API page changes use the catalog and page versions independently", async (t) => {
  const h = await fixture(t);
  const { siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Page management", slug: "page-management", locale: "ja" }), 201);
  const base = `/api/edit/v1/sites/${siteId}/operations`;
  const request = (method, path, input) => h.send(MANAGEMENT_ORIGIN, method, `${base}/${path}`, input, { cli: true });
  const initial = await body(await request("GET", "pages.catalog"), 200);
  const create = {
    expectedVersion: initial.version,
    change: { action: "create", siteId, locale: "ja", title: "About", path: "/about" }
  };
  const { page } = await body(await request("POST", "pages.change", create), 200);
  const anotherChange = { ...create.change, path: "/contact" };
  assert.deepEqual(await body(await request("POST", "pages.change", { ...create, change: anotherChange }), 409), { error: "version_conflict" });
  const current = await body(await request("GET", "pages.catalog"), 200);
  assert.notEqual(current.version, initial.version);
  assert.deepEqual(current.pages.map(({ path }) => path), ["/", "/about"]);
  const snapshot = await body(await request("GET", `pages.read/${page.pageId}?locale=ja`), 200);
  const change = { action: "update", target: { siteId, locale: "ja", pageId: page.pageId }, title: "About us", path: "/about-us" };
  assert.deepEqual(await body(await request("POST", "pages.change", { change, expectedVersion: current.version }), 409), { error: "version_conflict" });
  const { page: updated } = await body(await request("POST", "pages.change", { change, expectedVersion: snapshot.version }), 200);
  assert.deepEqual(updated, { ...page, title: "About us", path: "/about-us" });
});

testWithD1("Static publication serves immutable HTML and applies noindex to the verification host", async (t) => {
  const h = await fixture(t, { cms: true });
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Static fixture", slug: "static-fixture", locale: "ja" }), 201);
  const api = `/api/projects/${created.projectId}/sites/${created.siteId}/editor`;
  const draft = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  const linkedDocument = structuredClone(draft.document);
  linkedDocument.body[0].children.push({ type: "element", id: "about-link", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "About" }] });
  const saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/home/draft`, { expectedVersion: draft.version, document: linkedDocument }), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: saved.version, action: "publish" }), 200);

  const state = h.sqlite.prepare("SELECT version, manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId);
  assert.match(state.version, /^[0-9a-f]{64}$/u);
  assert.equal(state.manifest_key, `managed-sites/${created.siteId}/manifests/${state.version}.json`);
  const publication = h.sqlite.prepare(`SELECT path, artifact_key, artifact_digest, manifest_key, content_type, content_security_policy
    FROM managed_page_publications WHERE site_id = ? AND page_id = 'home'`).get(created.siteId);
  assert.equal(publication.path, "/");
  assert.equal(publication.manifest_key, state.manifest_key);
  assert.equal(publication.artifact_key, `managed-sites/${created.siteId}/artifacts/${publication.artifact_digest}.html`);
  assert.equal(publication.content_type, "text/html; charset=utf-8");
  assert.ok(h.objects.has(publication.artifact_key));
  const manifest = JSON.parse(h.objects.get(state.manifest_key));
  assert.deepEqual(manifest.discoveryFiles.map(({ path }) => path).sort(), ["/llms-full.txt", "/llms.txt", "/robots.txt", "/sitemap.xml"]);
  assert.equal(Object.hasOwn(manifest.routes[0], "text"), false);
  assert.ok(manifest.routes[0].textArtifactKey && h.objects.has(manifest.routes[0].textArtifactKey));
  for (const file of manifest.discoveryFiles) assert.ok(h.objects.has(file.artifactKey));
  assert.match(h.objects.get(publication.artifact_key), /href="\/s\/static-fixture\/about"/u);

  const previewUrl = "https://preview.sites.example/s/static-fixture/";
  const preview = await publishedSiteRequest(new Request(previewUrl), h.env);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(preview.headers.get("ETag"), `"${publication.artifact_digest}"`);
  assert.equal(preview.headers.get("Content-Security-Policy"), publication.content_security_policy);
  assert.match(await preview.text(), /<title>Static fixture<\/title>/u);
  const originalDb = h.env.DB, queries = [], objectReads = [];
  const originalGet = h.env.CMS_OBJECTS.get.bind(h.env.CMS_OBJECTS);
  h.env.CMS_OBJECTS.get = async (key) => { objectReads.push(key); return originalGet(key); };
  h.env.DB = { prepare(query) { queries.push(query); return originalDb.prepare(query); }, batch: (...args) => originalDb.batch(...args) };
  const firstCachedDelivery = await publishedSiteRequest(new Request(previewUrl), h.env);
  assert.equal(firstCachedDelivery.status, 200);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => !/managed_page_publications|managed_page_versions|managed_pages/iu.test(query)));
  assert.equal(objectReads.filter((key) => key === state.manifest_key).length, 1);
  queries.length = 0;
  const secondCachedDelivery = await publishedSiteRequest(new Request(previewUrl), h.env);
  assert.equal(secondCachedDelivery.status, 200);
  assert.equal(queries.length, 0);
  assert.equal(objectReads.filter((key) => key === state.manifest_key).length, 1);
  h.env.DB = originalDb;
  h.env.CMS_OBJECTS.get = originalGet;
  const previewRobots = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/robots.txt"), h.env);
  assert.equal(previewRobots.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await previewRobots.text(), /Disallow: \/\n/u);
  const previewSitemap = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/sitemap.xml"), h.env);
  const previewSitemapBody = await previewSitemap.text();
  assert.match(previewSitemapBody, /<urlset/u);
  assert.doesNotMatch(previewSitemapBody, /preview\.sites\.example/u);
  const publicSitemap = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/sitemap.xml"), h.env);
  assert.equal(publicSitemap.status, 200);
  assert.match(await publicSitemap.text(), /https:\/\/sites\.example\/s\/static-fixture\//u);
  assert.match(await (await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/llms.txt"), h.env)).text(), /# Static fixture/u);
  assert.match(await (await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/llms-full.txt"), h.env)).text(), /About/u);
  h.sqlite.prepare("INSERT INTO managed_site_hosts (hostname, path_prefix, site_id, noindex) VALUES (?, '', ?, 1)")
    .run("private.sites.example", created.siteId);
  for (const path of ["/sitemap.xml", "/llms.txt", "/llms-full.txt"]) {
    const hiddenDiscovery = await publishedSiteRequest(new Request(`https://private.sites.example${path}`), h.env);
    assert.equal(hiddenDiscovery.status, 200);
    assert.equal(hiddenDiscovery.headers.get("X-Robots-Tag"), "noindex, nofollow");
    const body = await hiddenDiscovery.text();
    const etag = hiddenDiscovery.headers.get("ETag");
    assert.ok(etag);
    assert.doesNotMatch(body, /sites\.example|Static fixture|About/u, "a noindex host must not disclose URL or page text");
    assert.equal(etag, `"${createHash("sha256").update(body).digest("hex")}"`);
    assert.equal((await publishedSiteRequest(new Request(`https://private.sites.example${path}`, {
      headers: { "If-None-Match": etag }
    }), h.env)).status, 304);
  }
  assert.match(await (await publishedSiteRequest(new Request("https://private.sites.example/robots.txt"), h.env)).text(), /Disallow: \/\n/u);
  // `/` prefix uses the same root route as an empty prefix and never redirects to `//`.
  h.sqlite.prepare("UPDATE managed_site_hosts SET path_prefix = '/' WHERE hostname = ? AND site_id = ? AND noindex = 1")
    .run("preview.sites.example", created.siteId);
  const rootPreview = await publishedSiteRequest(new Request("https://preview.sites.example/", { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(rootPreview.status, 200);
  assert.match(await rootPreview.text(), /<title>Static fixture<\/title>/u);
  h.sqlite.prepare("UPDATE managed_site_hosts SET path_prefix = ? WHERE hostname = ? AND site_id = ? AND noindex = 1")
    .run(`/s/static-fixture`, "preview.sites.example", created.siteId);

  const notModified = await publishedSiteRequest(new Request(previewUrl, { headers: { "Cache-Control": "no-cache", "If-None-Match": `"${publication.artifact_digest}"` } }), h.env);
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const head = await publishedSiteRequest(new Request(previewUrl, { method: "HEAD", headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const publicResponse = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/", { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("X-Robots-Tag"), null);

  const create = { action: "create", siteId: created.siteId, locale: "ja", title: "About", path: "/about" };
  const createdPage = await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), create);
  const about = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${createdPage.page.pageId}`), 200);
  const aboutTarget = { siteId: created.siteId, pageId: createdPage.page.pageId, locale: "ja" };
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/${createdPage.page.pageId}/publish`, { expectedVersion: about.version, action: "publish" }), 200);
  const aboutReleaseId = h.sqlite.prepare("SELECT version FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId).version;
  const aboutResponse = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about"), h.env);
  assert.equal(aboutResponse.status, 200);
  assert.equal(aboutResponse.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await aboutResponse.text(), /<title>About<\/title>/u);

  const move = { action: "update", target: aboutTarget, title: "About", path: "/about-us" };
  await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), move);
  const oldAbout = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about", { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(oldAbout.status, 301, "moving a published page updates the static route and redirect together");
  assert.equal(oldAbout.headers.get("Location"), "https://preview.sites.example/s/static-fixture/about-us");
  assert.equal((await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about-us", { headers: { "Cache-Control": "no-cache" } }), h.env)).status, 200);

  const makePrivate = { action: "visibility", target: aboutTarget, visibility: "private" };
  await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), makePrivate);
  assert.equal((await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about-us", { headers: { "Cache-Control": "no-cache" } }), h.env)).status, 404);
  const latestState = h.sqlite.prepare("SELECT version, manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId);
  const latest = JSON.parse(h.objects.get(latestState.manifest_key));
  assert.deepEqual(latest.routes.map(({ pageId, locale }) => ({ pageId, locale })), [{ pageId: "home", locale: "ja" }]);
  const updatedSitemap = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/sitemap.xml", { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(updatedSitemap.status, 200);
  assert.doesNotMatch(await updatedSitemap.text(), /\/about/u);

  const history = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/publication-history`), 200);
  assert.equal(history.currentReleaseId, latestState.version);
  assert.ok(history.releases.some(({ releaseId }) => releaseId === aboutReleaseId));
  const rollback = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/rollback`, {
    expectedVersion: latestState.version, releaseId: aboutReleaseId
  }), 200);
  assert.deepEqual(rollback, { status: "rolled_back", releaseId: aboutReleaseId });
  assert.equal(h.sqlite.prepare("SELECT version FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId).version, aboutReleaseId);
  assert.equal((await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about", { headers: { "Cache-Control": "no-cache" } }), h.env)).status, 200);
  assert.equal((await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about-us", { headers: { "Cache-Control": "no-cache" } }), h.env)).status, 404);
  const restoredSitemap = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/sitemap.xml", { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.match(await restoredSitemap.text(), /\/about/u);

  const addContact = { action: "create", siteId: created.siteId, locale: "ja", title: "Contact", path: "/contact" };
  const contactPage = await pageChange((method, suffix, input) => h.send(MANAGEMENT_ORIGIN, method, api + suffix, input), addContact);
  const contactDraft = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${contactPage.page.pageId}`), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/${contactPage.page.pageId}/publish`, { expectedVersion: contactDraft.version, action: "publish" }), 200);
  const refreshedState = h.sqlite.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId);
  const refreshedManifest = JSON.parse(h.objects.get(refreshedState.manifest_key));
  assert.deepEqual(refreshedManifest.routes.map(({ path }) => path).sort(), ["/", "/contact"]);
  const refreshedSitemap = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/sitemap.xml", { headers: { "Cache-Control": "no-cache" } }), h.env);
  assert.equal(refreshedSitemap.status, 200);
  const refreshedSitemapBody = await refreshedSitemap.text();
  assert.match(refreshedSitemapBody, /\/contact/u);
  assert.doesNotMatch(refreshedSitemapBody, /\/about/u);

  const unknown = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/missing"), h.env);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const rootRedirect = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture"), h.env);
  assert.equal(rootRedirect.status, 308);
  assert.equal(rootRedirect.headers.get("Location"), "https://preview.sites.example/s/static-fixture/");

  const redirects = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/redirects`), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/redirects`, {
    expectedVersion: redirects.version, redirects: [{ locale: "ja", fromPath: "/old-home", toPath: "/" }]
  }), 200);
  const storedRedirect = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/old-home?ref=legacy"), h.env);
  assert.equal(storedRedirect.status, 301);
  assert.equal(storedRedirect.headers.get("Location"), "https://sites.example/s/static-fixture/?ref=legacy");
  assert.equal(rootRedirect.headers.get("X-Robots-Tag"), "noindex, nofollow");
  h.faults.artifact = true;
  const unavailablePage = await publishedSiteRequest(new Request(previewUrl), h.env);
  assert.equal(unavailablePage.status, 503);
  assert.equal(unavailablePage.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

testWithD1("static publication keeps the previous pointer when membership expires after rendering starts", async (t) => {
  const h = await fixture(t, { cms: true });
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "CAS fixture", slug: "cas-fixture", locale: "ja" }), 201);
  const api = `/api/projects/${created.projectId}/sites/${created.siteId}/editor`;
  const draft = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  h.faults.revokeOwnerBeforePublishCommit = { projectId: created.projectId, subject: OWNER };
  const publish = () => h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/publish`, { expectedVersion: draft.version, action: "publish" });
  assert.deepEqual(await body(await publish(), 409), { error: "version_conflict" });
  const state = h.sqlite.prepare("SELECT version, manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId);
  assert.equal(state.version, "initial");
  assert.equal(state.manifest_key, null);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE site_id = ?").get(created.siteId).count, 0);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_site_audit WHERE action = 'page.published' AND site_id = ?").get(created.siteId).count, 0);
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?, ?, 'owner', 'Fixture owner', 'owner@example.test')")
    .run(created.projectId, OWNER);
  await body(await publish(), 200);
});

testWithD1("Studio publish fences expired CLI delegation inside the mutation", async (t) => {
  const h = await fixture(t);
  const { projectId, siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Grant fixture", slug: "grant-fixture", locale: "ja" }), 201);
  const api = `/api/projects/${projectId}/sites/${siteId}/editor`;
  const { version } = await body(await h.send(MANAGEMENT_ORIGIN, "GET", api + "/home"), 200);
  h.sqlite.prepare(`INSERT INTO studio_cli_grants (client_id, project_id, site_id, capability, delegated_by_subject, expires_at)
    VALUES (?, ?, ?, 'pages.publish', ?, unixepoch() + 600)`).run(SERVICE_CLIENT, projectId, siteId, OWNER);
  h.faults.revokePublishGrant = true;
  const request = () => h.send(MANAGEMENT_ORIGIN, "POST", `/api/edit/v1/sites/${siteId}/operations/pages.publish/home?locale=ja`,
    { expectedVersion: version, action: "publish" }, { cli: true, service: true, token: h.serviceToken });
  assert.deepEqual(await body(await request(), 409), { error: "version_conflict" });
  assert.equal((await request()).status, 403);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE site_id = ?").get(siteId).count, 0);
});

testWithD1("Kamakura machine editing enforces current site grants for discovery, read, save and publish", async (t) => {
  const h = await fixture(t);
  const projectId = "project-kamakura", siteId = "kamakura";
  const endpoint = `/api/edit/v1/sites/${siteId}`;
  const service = { cli: true, service: true, token: h.serviceToken };
  const send = (method, path, input, options = service) => h.send(MANAGEMENT_ORIGIN, method, endpoint + path, input, options);
  const read = "/operations/pages.read/home?locale=ja";
  const save = "/operations/pages.save/home?locale=ja";
  const plan = "/operations/pages.release-plan/home?locale=ja";
  const release = "/operations/pages.release/home?locale=ja";
  const secret = Buffer.alloc(32, 41);
  h.env.KAMAKURA_STUDIO_BRIDGE_SECRET = secret.toString("base64url");
  const calls = [];
  h.env.KAMAKURA_SITE.fetch = async (request) => {
    const url = new URL(request.url);
    const [header, payload, signature] = request.headers.get("Authorization").slice("Bearer ".length).split(".");
    assert.equal(signature, createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(claims.iss, "niho-web-studio-edit");
    assert.equal(claims.sub, `studio-cli:${SERVICE_CLIENT}`);
    assert.equal(claims.exp - claims.iat, 60);
    assert.equal(request.headers.has("Cf-Access-Jwt-Assertion"), false);
    assert.equal(request.headers.has("CF-Access-Client-Secret"), false);
    const input = request.method === "GET" ? null : await request.json();
    calls.push({ path: url.pathname + url.search, method: request.method, scope: claims.scope, input });
    if (url.pathname.endsWith("/capabilities")) {
      return Response.json({ apiVersion: "v1", siteId, operations: ["pages.read", "pages.save", "pages.release-plan", "pages.release", "assets.list"].map((id) => ({ id })) });
    }
    if (url.pathname.endsWith("pages.release/home")) {
      return input.expectedVersion === "draft-v2"
        ? Response.json({ status: "released", operationId: input.operationId, version: "published-v2" })
        : Response.json({ error: "version_conflict" }, { status: 409 });
    }
    return Response.json({ forwarded: true });
  };

  await body(await send("GET", read, undefined, { auth: false }), 401);
  await body(await send("GET", "/capabilities"), 403);
  await body(await send("GET", read), 403);
  assert.equal(calls.length, 0);

  const addMember = h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?, ?, 'owner', ?, ?)");
  addMember.run(projectId, OWNER, "Fixture owner", "owner@example.test");
  addMember.run(projectId, OTHER, "Other owner", "other@example.test");
  const addGrant = h.sqlite.prepare(`INSERT INTO studio_cli_grants
    (client_id, project_id, site_id, capability, delegated_by_subject, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, unixepoch() - 600, unixepoch() + ?)`);
  addGrant.run(SERVICE_CLIENT, projectId, siteId, "pages.read", OWNER, 600);
  addGrant.run(SERVICE_CLIENT, projectId, siteId, "pages.edit", OWNER, -1);
  const discovery = await body(await send("GET", "/capabilities"), 200);
  assert.deepEqual(discovery.operations.map(({ id }) => id), ["pages.read"]);
  assert.deepEqual(calls[0].scope, ["pages.read"]);
  assert.deepEqual(await body(await send("GET", read), 200), { forwarded: true });
  await body(await send("POST", read), 405);
  await body(await send("GET", "/operations/assets.list"), 404);
  await body(await send("GET", "/operations/pages.read/home?locale=ja&upstream=other"), 404);
  await body(await send("PUT", save, { expectedVersion: "draft-v1" }), 403);
  await body(await send("POST", plan, { expectedVersion: "draft-v1" }), 403);
  assert.equal(calls.length, 2);

  h.sqlite.prepare("DELETE FROM studio_cli_grants WHERE capability = 'pages.edit'").run();
  addGrant.run(SERVICE_CLIENT, projectId, siteId, "pages.edit", OWNER, 600);
  addGrant.run(SERVICE_CLIENT, projectId, siteId, "pages.publish", OWNER, 600);
  const saveInput = { expectedVersion: "draft-v1", document: { fixture: true } };
  const planInput = { expectedVersion: "draft-v2", action: "publish" };
  const releaseInput = { ...planInput, confirmationToken: "fixture-confirmation", operationId: crypto.randomUUID() };
  await body(await send("PUT", save, saveInput), 200);
  await body(await send("POST", plan, planInput), 200);
  assert.deepEqual(await body(await send("POST", release, releaseInput), 200), {
    status: "released", operationId: releaseInput.operationId, version: "published-v2"
  });
  assert.deepEqual(calls.slice(2), [
    { path: endpoint + save, method: "PUT", scope: ["pages.edit"], input: saveInput },
    { path: endpoint + plan, method: "POST", scope: ["pages.publish"], input: planInput },
    { path: endpoint + release, method: "POST", scope: ["pages.publish"], input: releaseInput },
  ]);
  const stale = { ...releaseInput, expectedVersion: "draft-v1" };
  assert.deepEqual(await body(await send("POST", release, stale), 409), { error: "version_conflict" });

  h.sqlite.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND access_subject = ?").run(projectId, OWNER);
  await body(await send("GET", read), 403);
  await body(await send("POST", release, releaseInput), 403);
  assert.equal(calls.length, 6);
});

const CMS_OP_KEY = "X-Studio-Operation-Key";
const headers = (key = crypto.randomUUID()) => ({ [CMS_OP_KEY]: key });
async function cmsSite(h, slug) {
  const { projectId, siteId } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "CMS Fixture", slug, locale: "ja" }), 201);
  const endpoint = `/api/projects/${projectId}/sites/${siteId}/cms/v2`;
  const post = (operation, values = {}, options = {}) => h.send(MANAGEMENT_ORIGIN, "POST", `${endpoint}/${operation}`, { siteId, ...values }, options);
  const read = (operation, values = {}, options = {}) => post(operation, values, options).then((result) => body(result, 200));
  const pub = (path) => h.send(PUBLIC_ORIGIN, "GET", `/s/${slug}/cms${path}`, undefined, { auth: false });
  const cli = (method, operation, values, options = {}) => h.send(MANAGEMENT_ORIGIN, method, `/api/edit/v1/sites/${siteId}/operations/${operation}`,
    values, { cli: true, ...options, headers: { "X-Studio-CMS-Version": "2", ...options.headers } });
  return { projectId, siteId, endpoint, post, read, pub, cli };
}
function cmsOperationsWithAssets(h, site, resolver) {
  const store = new CmsStore(h.env.DB, h.env.CMS_OBJECTS, resolver);
  const post = (operation, input = {}, options = {}) => managedCmsApi(new Request(`${MANAGEMENT_ORIGIN}${site.endpoint}/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: MANAGEMENT_ORIGIN, "Sec-Fetch-Site": "same-origin", ...options.headers },
    body: JSON.stringify({ siteId: site.siteId, ...input })
  }), store, { siteId: site.siteId, projectId: site.projectId, actor: { id: OWNER, cli: false } }, operation, 2);
  return { store, post, read: (operation, input, options) => post(operation, input, options).then((response) => body(response, 200)) };
}
const versioned = (draft) => ({
  collectionId: draft.collectionId, itemId: draft.itemId, locale: draft.locale,
  expectedRevision: draft.revision, contractVersion: 2, expectedSchemaRevision: draft.schemaRevision
});
const pin = ({ collectionId, itemId, revision }) => ({ collectionId, itemId, revision });
const values = (title, slug = "notice") => ({ title, slug, body: "<script>Fixture only</script>" });
async function createDraft(site, schemaRevision, options = {}) {
  return (await site.read("cms.items.create", { collectionId: "posts", contractVersion: 2, expectedSchemaRevision: schemaRevision },
    { headers: headers(), ...options })).item;
}
async function saveDraft(site, draft, title, slug) {
  return (await site.read("cms.items.save", { ...versioned(draft), values: values(title, slug) }, { headers: headers() })).item;
}
async function releasePlan(site, schemaRevision, previous, items, at) {
  const current = await site.read("cms.release.current");
  const { plan } = await site.read("cms.release.plan", { schemaRevision, locale: "ja", routeTableRevision: current.routeTableRevision,
    expectedReleaseId: previous,
    items: items.map(pin), redirects: [], ...(at ? { at } : {}) });
  return { operationId: plan.operationId, confirmationToken: plan.confirmationToken };
}

testWithD1("Studio CMS stores, publishes and schedules 500 items while tombstones count toward capacity", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "cms-capacity");
  const { schemaRevision } = await site.read("cms.schema.read");
  const drafts = [];
  for (let number = 1; number <= 500; number++) {
    const draft = await createDraft(site, schemaRevision);
    drafts.push(await saveDraft(site, draft, `Item ${number}`, `item-${number}`));
  }
  const createInput = { collectionId: "posts", contractVersion: 2, expectedSchemaRevision: schemaRevision };
  const createBeyondCapacity = () => site.post("cms.items.create", createInput, { headers: headers() });
  assert.deepEqual(await body(await createBeyondCapacity(), 409), { error: "quota_exceeded" });
  await site.read("cms.items.remove", versioned(drafts[0]), { headers: headers() });
  assert.deepEqual(await body(await createBeyondCapacity(), 409), { error: "quota_exceeded" });
  await site.read("cms.items.restore", versioned(drafts[0]), { headers: headers() });

  const { routeTableRevision } = await site.read("cms.release.current");
  const input = { schemaRevision, locale: "ja", routeTableRevision, expectedReleaseId: null, items: drafts.map(pin), redirects: [] };
  const extra = { collectionId: "posts", itemId: "extra-item", revision: "extra-revision" };
  assert.deepEqual(await body(await site.post("cms.release.plan", { ...input, items: [...input.items, extra] }), 400),
    { error: "invalid_request" });
  const redirects = Array.from({ length: 25_001 }, (_, index) => ({ from: `/cms/old-item-${index}`, to: "/cms/posts/item-1" }));
  assert.deepEqual(await body(await site.post("cms.release.plan", { ...input, redirects }), 400), { error: "invalid_request" });

  const publish = await releasePlan(site, schemaRevision, null, drafts);
  const { result: { releaseId } } = await site.read("cms.release.apply", publish);
  assert.equal((await site.read("cms.release.status", { operationId: publish.operationId })).delivery.state, "pending");
  // Clear older revision-verification jobs within the per-invocation subrequest budget before the large release.
  for (let attempt = 0; attempt < 10; attempt++) {
    const status = await site.read("cms.release.status", { operationId: publish.operationId });
    if (status.delivery.state === "delivered") break;
    await h.cron();
  }
  const delivered = await site.read("cms.release.status", { operationId: publish.operationId });
  assert.equal(delivered.delivery.state, "delivered", JSON.stringify(delivered));
  assert.deepEqual((await site.read("cms.release.current")).snapshot.items.map(pin), drafts.map(pin));
  assert.match(await (await site.pub("/posts/item-500")).text(), /Item 500/u);

  const future = new Date(Date.now() + 120_000).toISOString();
  const reservation = await releasePlan(site, schemaRevision, releaseId, drafts, future);
  const { result: { scheduleId } } = await site.read("cms.schedule.create", reservation);
  assert.equal((await site.read("cms.schedule.status", { scheduleId })).status, "scheduled");
  const clock = t.mock.method(Date, "now", () => Date.parse(future) + 1_000);
  // Let this due reservation run before the draft verification jobs from fixture setup.
  h.sqlite.prepare("UPDATE managed_cms_outbox SET available_at = 0 WHERE id = ?").run(scheduleId);
  await h.cron();
  clock.mock.restore();
  assert.equal((await site.read("cms.schedule.status", { scheduleId })).status, "released");
  assert.deepEqual((await site.read("cms.release.current")).snapshot.items.map(pin), drafts.map(pin));
});

testWithD1("Studio CMS accepts large redirect plans and caps redirects at 25,000", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "cms-redirect-capacity");
  const { schemaRevision } = await site.read("cms.schema.read");
  const draft = await createDraft(site, schemaRevision);
  const item = await saveDraft(site, draft, "Redirect fixture", "redirect-fixture");
  const initialPlan = await releasePlan(site, schemaRevision, null, [item]);
  await site.read("cms.release.apply", initialPlan);
  await h.cron();

  const current = await site.read("cms.release.current");
  const redirects = Array.from({ length: 2_500 }, (_, index) => ({ from: `/cms/old-${index}`, to: "/cms/posts/redirect-fixture" }));
  const input = { schemaRevision, locale: "ja", routeTableRevision: current.routeTableRevision,
    expectedReleaseId: current.snapshot.releaseId, items: [pin(item)], redirects };
  assert.ok(new TextEncoder().encode(JSON.stringify({ siteId: site.siteId, ...input })).byteLength > 64 * 1024);
  const { plan } = await site.read("cms.release.plan", input);
  assert.equal(plan.candidate.snapshot.redirects.length, redirects.length);
  await site.read("cms.release.apply", { operationId: plan.operationId, confirmationToken: plan.confirmationToken });
  assert.equal((await site.read("cms.release.status", { operationId: plan.operationId })).delivery.state, "delivered");
  assert.equal((await site.read("cms.release.current")).snapshot.redirects.length, redirects.length);

  const tooMany = Array.from({ length: 25_001 }, (_, index) => ({ from: `/cms/overflow-${index}`, to: "/cms/posts/redirect-fixture" }));
  assert.deepEqual(await body(await site.post("cms.release.plan", { ...input, redirects: tooMany }, { headers: headers() }), 400),
    { error: "invalid_request" });
});

testWithD1("Studio CMS accepts migration-sized draft saves and enforces operation-specific byte limits", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "cms-save-size");
  const { schemaRevision } = await site.read("cms.schema.read");
  const draft = await createDraft(site, schemaRevision);
  const scope = { siteId: site.siteId };
  const postJson = (operation, json) => h.fetch(`${MANAGEMENT_ORIGIN}${site.endpoint}/${operation}`, {
    method: "POST", body: json, headers: {
      "Content-Type": "application/json", Origin: MANAGEMENT_ORIGIN, "Sec-Fetch-Site": "same-origin",
      "Cf-Access-Jwt-Assertion": h.ownerToken, ...headers()
    }
  });
  const saveInput = (item, itemValues) => ({ ...scope, ...versioned(item), values: itemValues });
  const migrationValues = { ...values("Larger article"), body: "" };
  const bodyBytes = 65_532 - Buffer.byteLength(JSON.stringify(migrationValues));
  migrationValues.body = "あ".repeat(Math.floor(bodyBytes / 3)) + "a".repeat(bodyBytes % 3);
  assert.equal(Buffer.byteLength(JSON.stringify(migrationValues)), 65_532);
  const migrationInput = saveInput(draft, migrationValues);
  assert.ok(Buffer.byteLength(JSON.stringify(migrationInput)) > 64 * 1024);
  const cliPath = `/api/edit/v2/sites/${site.siteId}/operations/cms.items.save`;
  const { item: saved } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", cliPath, migrationInput, { cli: true, headers: headers() }), 200);
  assert.deepEqual(saved.values, migrationValues);

  const smallSave = JSON.stringify(saveInput(saved, values("Within limit")));
  const paddedSave = smallSave.padEnd(128 * 1024, " ");
  assert.deepEqual(await body(await postJson("cms.items.save", `${paddedSave} `), 400), { error: "invalid_request" });
  const { item: boundary } = await body(await postJson("cms.items.save", paddedSave), 200);
  assert.equal(boundary.values.title, "Within limit");

  const schemaRead = JSON.stringify(scope).padEnd(64 * 1024, " ");
  assert.deepEqual(await body(await postJson("cms.schema.read", `${schemaRead} `), 400), { error: "invalid_request" });
  assert.equal((await body(await postJson("cms.schema.read", schemaRead), 200)).schemaRevision, schemaRevision);
});

testWithD1("Studio CMS resolves migration URL assets only from the site's private manifest", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "cms-migration-assets");
  const schema = await site.read("cms.schema.read"), collection = schema.collections[0];
  const field = { fieldId: "migration.cover", key: "cover", label: "表紙", type: "image", placement: "main" };
  const migratedSchema = { ...schema, collections: [{ ...collection, fields: [...collection.fields, field] }] };
  const reference = { provider: "kamakura-source", id: `src_${"a".repeat(64)}` };
  const manifestKey = `sites/${site.siteId}/migration/legacy-assets.json`;
  h.objects.set(manifestKey, JSON.stringify({ formatVersion: 1, siteId: site.siteId, assets: [
    { reference, url: "https://images.example.test/cms/cover.webp", width: null, height: null, altText: "" }
  ] }));
  const store = new CmsStore(h.env.DB, h.env.CMS_OBJECTS);
  const item = { siteId: site.siteId, schemaRevision: schema.schemaRevision, collectionId: collection.id,
    itemId: "migration-item", locale: "ja", revision: "migration-revision", values: { "migration.cover": reference } };
  assert.deepEqual(await store.publicAssets(migratedSchema, [item]), [
    { reference, url: "https://images.example.test/cms/cover.webp", width: null, height: null, altText: "" }
  ]);

  const otherSite = { ...migratedSchema, siteId: `${site.siteId}-other` };
  const otherItem = { ...item, siteId: otherSite.siteId };
  assert.deepEqual(await store.publicAssets(otherSite, [otherItem]), []);
});

testWithD1("Studio CMS localization exposes the shared workspace contract and preserves reviewed manual values after source changes", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "cms-localization");
  const original = await site.read("cms.schema.read"), route = await site.read("cms.release.current");
  const originalPosts = original.collections[0];
  const cover = { fieldId: "cover", key: "cover", label: "表紙", type: "image", placement: "main" };
  const coverReference = { provider: "fixture", id: "cover-for-localization" };
  const coverAsset = { reference: coverReference, url: "https://media.example.test/cover.webp", width: 800, height: 600, altText: "" };
  const { plan: schemaPlan } = await site.read("cms.schema.plan", { expectedSchemaRevision: original.schemaRevision,
    routeTableVersions: [{ locale: "ja", revision: route.routeTableRevision }], replacements: [],
    nextSchema: { ...original, collections: [{ ...originalPosts, fields: [...originalPosts.fields, cover] }] } });
  await site.read("cms.schema.apply", { operationId: schemaPlan.operationId, confirmationToken: schemaPlan.confirmationToken });
  const schema = await site.read("cms.schema.read"), postSchema = schema.collections[0];
  let publicAssets = [coverAsset];
  const withAssets = cmsOperationsWithAssets(h, site, async ({ siteId, references }) => {
    assert.equal(siteId, site.siteId);
    assert.deepEqual(references, [coverReference]);
    return publicAssets;
  });
  const field = (key) => postSchema.fields.find((entry) => entry.key === key).fieldId;
  const draft0 = await createDraft(site, schema.schemaRevision);
  const source = await site.read("cms.items.save", { ...versioned(draft0), values: {
    ...draft0.values, [field("title")]: "Coastal morning walk", [field("slug")]: "morning-walk", [field("body")]: "", cover: coverReference
  } }, { headers: headers() }).then(({ item }) => item);
  const sourceCurrent = await site.read("cms.release.current");
  const sourcePlan = await withAssets.read("cms.release.plan", { schemaRevision: schema.schemaRevision, locale: "ja",
    routeTableRevision: sourceCurrent.routeTableRevision, expectedReleaseId: null, items: [pin(source)], redirects: [] });
  await withAssets.read("cms.release.apply", { operationId: sourcePlan.plan.operationId, confirmationToken: sourcePlan.plan.confirmationToken });
  await h.cron();
  const itemKey = cmsLocalizationItemKey("posts", source.itemId);

  const overview = parseLocalizationOverviewResult(await site.read("cms.localization.overview"));
  assert.equal(overview.status, "ready");
  assert.equal(overview.overview.sourceLocale, "ja");
  assert.equal(overview.overview.targetLocale, "en");
  assert.ok(overview.overview.permissions.includes("edit"));
  const list = parseLocalizationListResult(await site.read("cms.localization.items.list"));
  assert.equal(list.status, "ready");
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].key, itemKey);

  const readItem = async () => parseLocalizationItemResult(await site.read("cms.localization.items.read", { itemKey }), itemKey);
  let item = (await readItem()).item;
  const title = item.units.find(({ label }) => label === "タイトル");
  assert.equal(title.source, "Coastal morning walk");
  const operationId = crypto.randomUUID();
  const saved = await site.read("cms.localization.items.command", { itemKey, operationId, action: "set-value", unitId: title.unitId,
    expectedVersion: title.version, expectedSourceVersion: source.revision, value: "Walk by the shore" }, { headers: headers(operationId) });
  assert.equal(saved.status, "applied");
  assert.equal(saved.unit.value, "Walk by the shore");
  assert.equal(saved.unit.state, "draft");

  item = (await readItem()).item;
  const currentTitle = item.units.find(({ unitId }) => unitId === title.unitId), reviewId = crypto.randomUUID();
  const reviewed = await site.read("cms.localization.items.command", { itemKey, operationId: reviewId, action: "review-current", unitId: title.unitId,
    expectedVersion: currentTitle.version, expectedSourceVersion: source.revision }, { headers: headers(reviewId) });
  assert.equal(reviewed.unit.state, "reviewed");

  item = (await readItem()).item;
  for (const unit of item.units.filter(({ unitId }) => unitId !== title.unitId)) {
    const operationId = crypto.randomUUID();
    const value = unit.singleLine ? "morning-walk-en" : "A walk beside the sea.";
    const beforeEditUnit = item.units.find(({ unitId }) => unitId === unit.unitId);
    await site.read("cms.localization.items.command", { itemKey, operationId, action: "set-value", unitId: unit.unitId,
      expectedVersion: beforeEditUnit.version, expectedSourceVersion: source.revision, value }, { headers: headers(operationId) });
    item = (await readItem()).item;
  }
  const unreviewedPlan = await withAssets.read("cms.localization.release.plan");
  assert.equal(unreviewedPlan.includedItems, 0, "draft translations stay out of a published snapshot until reviewed");
  assert.equal(unreviewedPlan.omittedItems.length, 1);

  for (const unit of item.units.filter(({ unitId }) => unitId !== title.unitId)) {
    const currentUnit = item.units.find(({ unitId }) => unitId === unit.unitId), reviewId = crypto.randomUUID();
    await site.read("cms.localization.items.command", { itemKey, operationId: reviewId, action: "review-current", unitId: unit.unitId,
      expectedVersion: currentUnit.version, expectedSourceVersion: source.revision }, { headers: headers(reviewId) });
    item = (await readItem()).item;
  }
  assert.equal(item.state, "reviewed");
  const localizedPlan = await withAssets.read("cms.localization.release.plan");
  assert.equal(localizedPlan.status, "ready");
  assert.equal(localizedPlan.locale, "en");
  assert.equal(localizedPlan.includedItems, 1);
  assert.deepEqual(localizedPlan.omittedItems, []);
  assert.equal(localizedPlan.plan.candidate.proposal.snapshot.items[0].path, "/en/cms/posts/morning-walk-en");
  assert.deepEqual(localizedPlan.plan.candidate.proposal.snapshot.assetManifest, [coverAsset]);
  const localizedInput = { operationId: localizedPlan.plan.operationId, confirmationToken: localizedPlan.plan.confirmationToken };
  const localizedHeaders = { headers: headers(localizedPlan.plan.operationId) };
  publicAssets = [];
  assert.equal((await withAssets.post("cms.localization.release.apply", localizedInput, localizedHeaders)).status, 409);
  publicAssets = [coverAsset];
  const localizedApply = await withAssets.read("cms.localization.release.apply", localizedInput, localizedHeaders);
  assert.equal(localizedApply.status, "published");
  const localizedCurrent = await site.read("cms.localization.release.current");
  const delivery = await cmsDeliveryFixture(h, site);
  const delivered = await delivery.client.snapshot("en");
  assert.equal(delivered.snapshot.releaseId, localizedCurrent.snapshot.releaseId);
  assert.deepEqual(delivered.snapshot.assetManifest, [coverAsset]);
  assert.deepEqual((await delivery.client.events()).events.map(({ locale }) => locale), ["ja", "en"]);
  assert.equal(localizedCurrent.snapshot.releaseId, localizedApply.result.releaseId);
  assert.equal(localizedCurrent.snapshot.items[0].locale, "en");
  assert.equal((await site.read("cms.release.current")).snapshot.releaseId, sourcePlan.plan.candidate.snapshot.releaseId,
    "publishing a locale does not move the source-locale release pointer");
  const englishResponse = await h.send(PUBLIC_ORIGIN, "GET", "/s/cms-localization/en/cms/posts/morning-walk-en", undefined, { auth: false });
  assert.equal(englishResponse.status, 200);
  const localizedHtml = await englishResponse.text();
  assert.match(localizedHtml, /Walk by the shore/u);
  assert.match(localizedHtml, /cover\.webp/u);
  assert.equal((await site.pub("/posts/morning-walk")).status, 200);

  const nextSource = await site.read("cms.items.save", { ...versioned(source), values: { ...source.values, [field("title")]: "A new coastal morning walk" } }, { headers: headers() }).then(({ item: next }) => next);
  item = (await readItem()).item;
  const changedTitle = item.units.find(({ unitId }) => unitId === title.unitId);
  assert.equal(changedTitle.source, "A new coastal morning walk");
  assert.equal(changedTitle.value, "Walk by the shore");
  assert.equal(changedTitle.state, "review-needed");
  assert.equal(item.state, "source-changed");
  const updatedSourceCurrent = await site.read("cms.release.current");
  const updatedSourcePlan = await withAssets.read("cms.release.plan", { schemaRevision: schema.schemaRevision, locale: "ja",
    routeTableRevision: updatedSourceCurrent.routeTableRevision, expectedReleaseId: updatedSourceCurrent.snapshot.releaseId,
    items: [pin(nextSource)], redirects: [] });
  await withAssets.read("cms.release.apply", { operationId: updatedSourcePlan.plan.operationId,
    confirmationToken: updatedSourcePlan.plan.confirmationToken });
  await h.cron();
  const stalePlan = await withAssets.read("cms.localization.release.plan");
  assert.equal(stalePlan.includedItems, 0);
  assert.equal(stalePlan.omittedItems.length, 1);
  assert.equal(stalePlan.omittedItems[0].itemId, source.itemId);
  const staleApply = await withAssets.read("cms.localization.release.apply", {
    operationId: stalePlan.plan.operationId, confirmationToken: stalePlan.plan.confirmationToken
  }, { headers: headers(stalePlan.plan.operationId) });
  assert.equal(staleApply.result.itemCount, 0);
  assert.equal((await h.send(PUBLIC_ORIGIN, "GET", "/s/cms-localization/en/cms/posts/morning-walk-en", undefined, { auth: false })).status, 404,
    "a stale translation is omitted instead of falling back to the Japanese source");
  const staleId = crypto.randomUUID();
  assert.equal((await site.post("cms.localization.items.command", { itemKey, operationId: staleId, action: "set-value", unitId: title.unitId,
    expectedVersion: currentTitle.version, expectedSourceVersion: source.revision, value: "Stale write" }, { headers: headers(staleId) })).status, 409);
  assert.equal(nextSource.revision === source.revision, false);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_cms_audit WHERE operation = 'cms.localization.items.command'").get().count, 4);
});

testWithD1("Studio page bindings publish a six-item list and dynamic detail from an immutable CMS release", async (t) => {
  const h = await fixture(t, { cms: true });
  const site = await cmsSite(h, "bound-articles");
  const customDomain = "preview.bound-articles.example.test";
  await setFixturePublicDomain(h, site, customDomain, true);
  const api = "/api/projects/" + site.projectId + "/sites/" + site.siteId + "/editor";
  const editing = "/api/edit/v1/sites/" + site.siteId;
  const browser = (method, path, input, options) => h.send(MANAGEMENT_ORIGIN, method, api + path, input, options);
  const cli = (method, path, input, options) => h.send(MANAGEMENT_ORIGIN, method, editing + path, input, { cli: true, ...options });
  const lookup = (path) => h.send(PUBLIC_ORIGIN, "GET", "/s/bound-articles" + path, undefined,
    { auth: false, headers: { "Cache-Control": "no-cache" } });
  const initial = await site.read("cms.schema.read");
  const { routeTableRevision } = await site.read("cms.release.current");
  const definition = structuredClone(initial);
  definition.collections[0].fields.push({ fieldId: "article_date", key: "article_date", type: "datetime", label: "Article date", placement: "side" });
  const schemaPlan = (await site.read("cms.schema.plan", { expectedSchemaRevision: initial.schemaRevision,
    routeTableVersions: [{ locale: "ja", revision: routeTableRevision }], nextSchema: definition, replacements: [] })).plan;
  const { result: { schemaRevision } } = await site.read("cms.schema.apply", { operationId: schemaPlan.operationId, confirmationToken: schemaPlan.confirmationToken });
  const items = [];
  for (let number = 1; number <= 7; number++) {
    const item = await createDraft(site, schemaRevision);
    items.push((await site.read("cms.items.save", { ...versioned(item), values: { ...values(number === 7 ? "Article <Seven>" : "Article " + number, number === 6 ? "Legacy-Case" : "article-" + number),
      article_date: "2026-10-0" + number + "T12:00:00Z" } }, { headers: headers() })).item);
  }
  const plan = await releasePlan(site, schemaRevision, null, items);
  await site.read("cms.release.apply", plan);
  await h.cron();
  const cmsRelease = (await site.read("cms.release.current")).snapshot;

  const createChange = { action: "create", siteId: site.siteId, locale: "ja", title: "Article", path: "/articles" };
  const { page: detailPage } = await pageChange(browser, createChange);
  const home = await body(await browser("GET", "/home"), 200);
  const firstStaticPublication = await body(await browser("POST", "/home/publish", {
    expectedVersion: home.version, action: "publish"
  }), 200);
  const listDocument = structuredClone(home.document);
  const element = (id, tag, children, attrs) => ({ type: "element", id, tag, children, ...(attrs ? { attrs } : {}) });
  const text = (value) => [{ type: "text", text: value }];
  listDocument.body = [element("article-preview", "article", [element("article-link", "a", text("Placeholder"), { href: "/articles" })])];
  const base = { schemaVersion: 1, siteId: site.siteId, pageId: "home", locale: "ja" };
  const cmsBindings = { ...base, lists: [{ templateNodeId: "article-preview", collectionId: "posts", limit: 6,
    order: { fieldId: "article_date", direction: "desc" }, fields: [
      { nodeId: "article-link", fieldId: "title", target: "text" },
      { nodeId: "article-link", fieldId: "title", target: "attribute", attribute: "aria-label" },
      { nodeId: "article-link", fieldId: "slug", target: "detail-link", path: "/articles" }
    ] }] };
  const listSaved = await body(await browser("PUT", "/home/draft", {
    expectedVersion: firstStaticPublication.snapshot.version, document: listDocument, cmsBindings
  }), 200);
  const detail = await body(await browser("GET", "/" + detailPage.pageId), 200);
  const detailDocument = { ...detail.document, body: [element("article-title", "h1", text("Title")), element("article-text", "p", text("Body"))] };
  const detailBindings = { ...base, pageId: detailPage.pageId, lists: [], detail: { collectionId: "posts", slugFieldId: "slug", fields: [
    { nodeId: "article-title", fieldId: "title", target: "text" }, { nodeId: "article-text", fieldId: "body", target: "text" }
  ] } };
  const detailPath = "/" + detailPage.pageId;
  const wrongType = structuredClone(detailBindings);
  wrongType.detail.fields[0].target = "image";
  assert.equal((await browser("PUT", detailPath + "/draft", { expectedVersion: detail.version, document: detailDocument, cmsBindings: wrongType })).status, 422);
  const detailSaved = await body(await browser("PUT", detailPath + "/draft", { expectedVersion: detail.version, document: detailDocument, cmsBindings: detailBindings }), 200);

  const collisionChange = { action: "create", siteId: site.siteId, locale: "ja", title: "Static collision", path: "/articles/article-7" };
  const { page: collisionPage } = await pageChange(browser, collisionChange);
  assert.equal((await browser("POST", detailPath + "/publish", {
    expectedVersion: detailSaved.version, action: "publish"
  })).status, 422, "detail paths must not override fixed page reservations");
  const moveCollision = { action: "update", target: { siteId: site.siteId, pageId: collisionPage.pageId, locale: "ja" }, title: "Static collision", path: "/articles/article-7-static" };
  await pageChange(browser, moveCollision);

  const collideAgain = { ...moveCollision, path: "/articles/article-7" };
  await pageChange(browser, collideAgain);
  assert.equal((await browser("POST", detailPath + "/publish", {
    expectedVersion: detailSaved.version, action: "publish"
  })).status, 422, "a newly reserved detail path blocks publication");
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE site_id = ? AND page_id = ?")
    .get(site.siteId, detailPage.pageId).count, 0);
  await pageChange(browser, moveCollision);

  const preview = { expectedVersion: detailSaved.version, collectionId: "posts", itemId: items[6].itemId, revision: items[6].revision,
    document: { ...detailDocument, revision: detailSaved.revision }, cmsBindings: detailBindings };
  const { previewId } = await body(await browser("POST", detailPath + "/cms-preview-plan", preview), 200);
  assert.equal((await browser("POST", "/home/cms-preview", { ...preview, previewId, expectedVersion: listSaved.version,
    document: { ...listDocument, revision: listSaved.revision }, cmsBindings })).status, 404);
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, 'editor', 'Editor')").run(site.projectId, OTHER);
  assert.equal((await browser("POST", detailPath + "/cms-preview", { ...preview, previewId }, { token: h.otherToken })).status, 404);
  const shown = await body(await browser("POST", detailPath + "/cms-preview", { ...preview, previewId }), 200);
  assert.equal(shown.document.body[0].children[0].text, "Article <Seven>");
  assert.equal((await browser("POST", detailPath + "/cms-preview", { ...preview, previewId })).status, 404);
  const stalePreview = await body(await browser("POST", detailPath + "/cms-preview-plan", preview), 200);
  await site.read("cms.items.save", { ...versioned(items[6]), values: { ...items[6].values, title: "New draft title" } }, { headers: headers() });
  assert.equal((await browser("POST", detailPath + "/cms-preview", { ...preview, previewId: stalePreview.previewId })).status, 404);

  const discovery = await body(await cli("GET", "/capabilities"), 200);
  assert.ok(discovery.operations.find(({ id }) => id === "pages.apply").capabilities.includes("pages.cms-bindings"));
  const inspected = await body(await cli("GET", "/operations/pages.inspect/home?locale=ja&view=outline"), 200);
  assert.deepEqual(inspected.cmsBindings, cmsBindings);
  const applyPath = "/operations/pages.apply/home?locale=ja";
  const write = { baseVersion: listSaved.version, operationId: crypto.randomUUID(), operations: [], cmsBindings };
  assert.equal((await body(await cli("POST", applyPath, { ...write, dryRun: true }), 200)).status, "valid");
  const applied = await body(await cli("POST", applyPath, write), 200);
  assert.deepEqual(await body(await cli("POST", applyPath, write), 200), applied);
  assert.equal((await cli("POST", applyPath, { ...write, cmsBindings: null })).status, 409);

  const publish = async (pageId, expectedVersion) => {
    return body(await browser("POST", "/" + pageId + "/publish", { expectedVersion, action: "publish" }), 200);
  };
  await publish(detailPage.pageId, detailSaved.version);
  await publish("home", applied.version);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE cms_release_id = ? AND cms_schema_revision = ?").get(cmsRelease.releaseId, schemaRevision).count, 2);
  const staticPointer = h.sqlite.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(site.siteId).manifest_key;
  const staticManifest = await (await h.env.CMS_OBJECTS.get(staticPointer)).json();
  assert.equal(staticManifest.routes.some(({ pageId, locale }) => pageId === "home" && locale === "ja"), false,
    "publishing a CMS-bound page removes its previous fixed route from the new manifest");
  assert.equal((await publishedSiteRequest(new Request(`${PUBLIC_ORIGIN}/s/bound-articles/`, {
    headers: { "Cache-Control": "no-cache" }
  }), h.env)).status, 404, "the static worker no longer serves the old fixed HTML for the CMS route");
  const list = await lookup("/");
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.deepEqual([...html.matchAll(/href="\/s\/bound-articles\/articles\/article-(\d)"/gu)].map((match) => match[1]), ["7", "5", "4", "3", "2"]);
  assert.match(html, /href="\/s\/bound-articles\/articles\/Legacy-Case"/u);
  assert.match(html, /aria-label="Article &lt;Seven&gt;"/u);
  const detailHtml = await (await lookup("/articles/article-7")).text();
  assert.match(detailHtml, /Article &lt;Seven&gt;/u);
  assert.match(detailHtml, /&lt;script&gt;Fixture only&lt;\/script&gt;/u);
  assert.equal((await lookup("/articles/unknown")).status, 404);
  assert.match(await (await lookup("/articles/Legacy-Case")).text(), /Article 6/u);
  assert.equal((await lookup("/articles/legacy-case")).status, 404);
  assert.equal((await lookup("/ARTICLES/Legacy-Case")).status, 404);
  assert.equal((await lookup("/articles")).status, 404);

  const customList = await h.fetch(`https://${customDomain}/`, { headers: { "Cache-Control": "no-cache" } });
  assert.equal(customList.status, 200, "a registered custom host keeps the CMS-bound page fallback");
  assert.equal(customList.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await customList.text(), /name="robots" content="noindex, nofollow"/u);
  const customCmsDetail = await h.fetch(`https://${customDomain}/cms/posts/article-7`, { headers: { "Cache-Control": "no-cache" } });
  assert.equal(customCmsDetail.status, 200, "a registered custom host keeps the CMS route fallback");
  assert.equal(customCmsDetail.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await setFixturePublicDomain(h, site, customDomain, false);
  const cmsSitemap = await h.fetch(`https://${customDomain}/sitemap.xml`, { headers: { "Cache-Control": "no-cache" } });
  assert.equal(cmsSitemap.status, 200);
  assert.ok((await cmsSitemap.text()).includes(`https://${customDomain}/cms/posts/article-7`),
    "CMS discovery stays available until #527 moves it to publication-time output");

  const currentSchema = await site.read("cms.schema.read");
  const migrate = async (nextSchema) => site.post("cms.schema.plan", { expectedSchemaRevision: schemaRevision,
    routeTableVersions: [{ locale: "ja", revision: (await site.read("cms.release.current")).routeTableRevision }], nextSchema, replacements: [] });
  const broken = structuredClone(currentSchema);
  broken.collections[0].fields = broken.collections[0].fields.map((field) => field.fieldId === "article_date"
    ? { ...field, type: "url" } : field);
  const rejected = await body(await migrate(broken), 422);
  assert.ok(rejected.problems.some((problem) => problem.code === "binding" && problem.pageId === "home" && problem.fieldId === "article_date"));
  const currentHome = await body(await browser("GET", "/home"), 200);
  const unbound = await body(await browser("PUT", "/home/draft", { expectedVersion: currentHome.version, document: currentHome.document, cmsBindings: null }), 200);
  const compatible = structuredClone(currentSchema);
  compatible.collections[0].fields = compatible.collections[0].fields.filter(({ fieldId }) => fieldId !== "article_date");
  const updatedSchemaPlan = (await body(await migrate(compatible), 200)).plan;
  await site.read("cms.schema.apply", { operationId: updatedSchemaPlan.operationId, confirmationToken: updatedSchemaPlan.confirmationToken });
  assert.equal(await (await lookup("/")).text(), html);
  assert.equal(await (await lookup("/articles/article-7")).text(), detailHtml);
  const restored = await body(await browser("POST", "/home/publish", { expectedVersion: unbound.version, action: "restore", revision: applied.revision }), 200);
  assert.deepEqual(restored.snapshot.cmsBindings, cmsBindings);
  const restoredHtml = await (await lookup("/")).text();
  assert.deepEqual([...restoredHtml.matchAll(/href="\/s\/bound-articles\/articles\/article-(\d)"/gu)].map((match) => match[1]), ["7", "5", "4", "3", "2"]);
  assert.match(restoredHtml, /href="\/s\/bound-articles\/articles\/Legacy-Case"/u);
  assert.equal(h.sqlite.prepare("SELECT p.cms_release_id FROM managed_pages AS m JOIN managed_page_publications AS p ON p.id = m.published_publication_id WHERE m.site_id = ? AND m.page_id = 'home'")
    .get(site.siteId).cms_release_id, cmsRelease.releaseId);
});

testWithD1("Studio CMS release snapshots include live unpublished page reservations", async (t) => {
  const h = await fixture(t, { cms: true });
  const site = await cmsSite(h, "reserved-cms-path");
  const schema = await site.read("cms.schema.read"), initial = await site.read("cms.release.current");
  const draft0 = await createDraft(site, schema.schemaRevision), draft = await saveDraft(site, draft0, "Reserved path", "notice");
  assert.equal(h.sqlite.prepare("UPDATE managed_pages SET path = '/about' WHERE site_id = ? AND page_id = 'home'").run(site.siteId).changes, 1);
  const current = await site.read("cms.release.current");
  assert.notEqual(current.routeTableRevision, initial.routeTableRevision, "live fixed-page changes advance the route-table revision");
  const { plan } = await site.read("cms.release.plan", { schemaRevision: schema.schemaRevision, locale: "ja",
    routeTableRevision: current.routeTableRevision, expectedReleaseId: null, items: [pin(draft)], redirects: [] });
  await site.read("cms.release.apply", { operationId: plan.operationId, confirmationToken: plan.confirmationToken });
  await h.cron();
  const released = await site.read("cms.release.current");
  assert.equal(released.routeTableRevision, released.snapshot.routeTable.revision);
  assert.ok(released.snapshot.routeTable.reservations.some(({ kind, path }) => kind === "reserved" && path === "/about"));
});

testWithD1("Studio CMS renders only assets approved for the published revision", async (t) => {
  const h = await fixture(t, { cms: true });
  const site = await cmsSite(h, "cms-assets");
  const schema = await site.read("cms.schema.read"), current = await site.read("cms.release.current");
  const collection = schema.collections[0];
  const image = { fieldId: "cover", key: "cover", label: "表紙", type: "image", placement: "main" };
  const gallery = { fieldId: "gallery", key: "gallery", label: "ギャラリー", type: "gallery", captionLabel: "説明", placement: "main" };
  const migration = await site.read("cms.schema.plan", { expectedSchemaRevision: schema.schemaRevision,
    routeTableVersions: [{ locale: "ja", revision: current.routeTableRevision }], replacements: [],
    nextSchema: { ...schema, collections: [{ ...collection, fields: [...collection.fields, image, gallery] }] } });
  const { result: { schemaRevision } } = await site.read("cms.schema.apply", {
    operationId: migration.plan.operationId, confirmationToken: migration.plan.confirmationToken
  });
  const cover = { provider: "fixture", id: "public-cover" }, slide = { provider: "fixture", id: "public-slide" };
  const privateCover = { provider: "fixture", id: "private-draft" };
  const coverAsset = { reference: cover, url: "/media/cover.webp", width: 800, height: 600, altText: 'Cover & "sea"' };
  const slideAsset = { reference: slide, url: "https://media.example.test/slide.webp", width: null, height: null, altText: "" };
  const extra = { ...slideAsset, reference: privateCover, url: "https://media.example.test/draft-only.webp" };
  const initial = await createDraft(site, schemaRevision);
  const save = async (draft, title, reference) => (await site.read("cms.items.save", {
    ...versioned(draft), values: { ...values(title), cover: reference, gallery: [{ id: "one", image: slide, caption: "<Caption>" }] }
  }, { headers: headers() })).item;
  const selected = await save(initial, "Selected content", cover);
  const draft = await save(selected, "Draft content", privateCover);
  const { previewId } = await site.read("cms.preview.prepare", pin(draft));
  const preview = await site.read("cms.preview.read", { previewId });
  assert.equal(preview.preview.title, "Draft content");
  assert.doesNotMatch(JSON.stringify(preview), /private-draft|draft-only\.webp|public-slide/u);
  assert.equal((await site.pub("/posts/notice")).status, 404);

  let available = [coverAsset, slideAsset], revokeOnRequest = Infinity;
  const requests = [];
  const { store, post } = cmsOperationsWithAssets(h, site, async ({ siteId, references }) => {
    assert.equal(siteId, site.siteId);
    requests.push(references);
    if (requests.length === revokeOnRequest) available = [slideAsset];
    return [...available.filter((asset) => references.some(({ id }) => id === asset.reference.id)),
      // A resolver returning a superset must not add unrelated assets to the snapshot.
      ...(!references.some(({ id }) => id === privateCover.id) ? [extra] : [])];
  });
  const planInput = { schemaRevision, locale: "ja", routeTableRevision: (await site.read("cms.release.current")).routeTableRevision,
    expectedReleaseId: null, items: [pin(selected)], redirects: [] };
  assert.equal((await site.post("cms.release.plan", planInput)).status, 422, "no resolver is configured for the default Worker");
  const { plan } = await body(await post("cms.release.plan", planInput), 200);
  assert.deepEqual(plan.candidate.snapshot.assetManifest, [coverAsset, slideAsset]);
  const applyInput = { operationId: plan.operationId, confirmationToken: plan.confirmationToken };
  available = [slideAsset];
  assert.equal((await post("cms.release.apply", applyInput)).status, 409, "removing an approved asset invalidates the confirmed plan");
  available = [coverAsset, slideAsset];
  const { result: { releaseId } } = await body(await post("cms.release.apply", applyInput), 200);
  assert.deepEqual(requests, [[cover, slide], [cover, slide], [cover, slide], [cover, slide]]);
  const released = await site.read("cms.release.current");
  assert.equal(released.snapshot.releaseId, releaseId);
  assert.deepEqual(released.snapshot.assetManifest, [coverAsset, slideAsset]);
  const response = await site.pub("/posts/notice");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Security-Policy"), /img-src 'self' https:/u);
  const html = await response.text();
  assert.match(html, /<img src="\/media\/cover\.webp" alt="Cover &amp; &quot;sea&quot;" width="800" height="600">/u);
  assert.match(html, /<figure><img src="https:\/\/media\.example\.test\/slide\.webp" alt=""><figcaption>&lt;Caption&gt;<\/figcaption><\/figure>/u);
  assert.doesNotMatch(html, /Draft content|draft-only\.webp|private-draft|public-cover|public-slide/u);
  const rejected = await body(await post("cms.release.plan", { ...planInput,
    expectedReleaseId: releaseId, routeTableRevision: released.routeTableRevision, items: [pin(draft)] }), 422);
  assert.ok(rejected.problems.some(({ fieldId }) => fieldId === "cover"));
  assert.equal(await (await site.pub("/posts/notice")).text(), html);

  const retry = (await body(await post("cms.release.plan", { ...planInput, expectedReleaseId: releaseId, routeTableRevision: released.routeTableRevision }), 200)).plan;
  revokeOnRequest = requests.length + 2; // The asset becomes unavailable between apply and the outbox recheck.
  await body(await post("cms.release.apply", { operationId: retry.operationId, confirmationToken: retry.confirmationToken }), 200);
  const status = await site.read("cms.release.status", { operationId: retry.operationId });
  assert.equal(status.delivery.state, "dead");
  assert.equal(status.delivery.failure, "conflict");
  assert.equal((await site.read("cms.release.current")).snapshot.releaseId, releaseId);

  const key = `sites/${site.siteId}/releases/${releaseId}.json`;
  h.objects.set(key, JSON.stringify({ ...released.snapshot, assetManifest: [slideAsset] }));
  await assert.rejects(store.snapshot(site.siteId, releaseId), /unresolved public asset/u);
});

testWithD1("Kamakura CMS releases resolve stable image references for plans and scheduled delivery", async (t) => {
  const h = await fixture(t, { cms: true });
  h.env.KAMAKURA_STUDIO_BRIDGE_SECRET = Buffer.alloc(32, 7).toString("base64url");
  const bridgeRequests = [];
  h.env.KAMAKURA_SITE = { async fetch(request) {
    const path = new URL(request.url).pathname;
    const input = await request.json();
    bridgeRequests.push({ path, method: request.method, siteId: input.siteId, subject: request.headers.get("X-NIHO-Studio-Subject"), references: input.references });
    return Response.json(Object.fromEntries(input.references.map((reference) => [`${reference.provider}:${reference.id}`, {
      src: "https://media.example.test/cms-cover.webp", width: 640, height: 480
    }])));
  } };

  const projectId = "project-kamakura", siteId = "kamakura";
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?, ?, 'owner', 'Owner', 'owner@example.test')").run(projectId, OWNER);
  h.sqlite.prepare("INSERT INTO managed_sites (site_id, slug, created_by_subject) VALUES (?, ?, ?)").run(siteId, "cms-resolver", OWNER);
  h.sqlite.prepare("INSERT INTO managed_pages (site_id, page_id, locale, title, path, current_version, current_revision) VALUES (?, 'home', 'ja', 'Home', '/', 'v1', 1)").run(siteId);

  const endpoint = `/api/projects/${projectId}/sites/${siteId}/cms/v2`;
  const read = async (operation, input = {}, options = {}) => body(await h.send(MANAGEMENT_ORIGIN, "POST", `${endpoint}/${operation}`,
    { siteId, ...input }, options), 200);
  const site = { projectId, siteId, read };
  const schema = await read("cms.schema.read"), current = await read("cms.release.current"), collection = schema.collections[0];
  const image = { fieldId: "cover", key: "cover", label: "表紙", type: "image", placement: "main" };
  const migration = await read("cms.schema.plan", { expectedSchemaRevision: schema.schemaRevision,
    routeTableVersions: [{ locale: "ja", revision: current.routeTableRevision }], replacements: [],
    nextSchema: { ...schema, collections: [{ ...collection, fields: [...collection.fields, image] }] } });
  const { result: { schemaRevision } } = await read("cms.schema.apply", {
    operationId: migration.plan.operationId, confirmationToken: migration.plan.confirmationToken
  });
  const reference = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000" };
  const draft = await createDraft(site, schemaRevision);
  const saved = await read("cms.items.save", { ...versioned(draft), values: { ...values("Published", "notice"), cover: reference } }, { headers: headers() });
  const currentForPlan = await read("cms.release.current");
  const scheduledAt = new Date(Date.now() + 60_000).toISOString();
  const planResponse = await h.send(MANAGEMENT_ORIGIN, "POST", `${endpoint}/cms.release.plan`, {
    siteId, schemaRevision, locale: "ja", routeTableRevision: currentForPlan.routeTableRevision,
    expectedReleaseId: null, items: [pin(saved.item)], redirects: [], at: scheduledAt
  });
  const planValue = await planResponse.json();
  assert.equal(planResponse.status, 200, JSON.stringify({ planValue, bridgeRequests }));
  const plan = planValue.plan;
  assert.deepEqual(bridgeRequests.map(({ subject }) => subject), [OWNER]);
  assert.deepEqual(plan.candidate.proposal.snapshot.assetManifest, [{ reference, url: "https://media.example.test/cms-cover.webp", width: 640, height: 480, altText: "" }]);
  await read("cms.schedule.create", { operationId: plan.operationId, confirmationToken: plan.confirmationToken });
  assert.deepEqual(bridgeRequests.map(({ subject }) => subject), [OWNER, OWNER]);
  h.sqlite.prepare("UPDATE managed_cms_outbox SET available_at = 0 WHERE id = ?").run(plan.candidate.id);
  await h.cron();
  const published = await read("cms.release.current");
  assert.equal(published.snapshot.releaseId, plan.candidate.proposal.snapshot.releaseId);
  assert.deepEqual(bridgeRequests.map(({ subject }) => subject), [OWNER, OWNER, "niho-studio-cms-scheduler"]);
  assert.ok(bridgeRequests.every(({ references }) => references.length === 1 && references[0].id === reference.id));
  assert.ok(bridgeRequests.every(({ path, method, siteId: resolvedSiteId }) => path === "/internal/studio/web-content/assets/resolve" && method === "POST" && resolvedSiteId === siteId));
});

testWithD1("Studio CMS uses immutable revisions, site/actor boundaries, confirmation and recoverable release jobs", async (t) => {
  const h = await fixture(t, { cms: true });
  const first = await cmsSite(h, "first-cms"), other = await cmsSite(h, "other-cms");
  const discovery = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${first.endpoint}/discover`), 200);
  assert.equal(discovery.contractVersion, 2);
  assert.ok(discovery.operations.includes("cms.schema.apply"));
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, 'editor', 'Editor')").run(first.projectId, OTHER);
  const schema = await first.read("cms.schema.read");
  const current = await first.read("cms.release.current");
  const newCollection = { ...schema.collections[0], id: "news", label: "Fixture news", pathPrefix: "/cms/news/" };
  const planned = await first.read("cms.schema.plan", { expectedSchemaRevision: schema.schemaRevision,
    routeTableVersions: [{ locale: "ja", revision: current.routeTableRevision }],
    nextSchema: { ...schema, collections: [...schema.collections, newCollection] }, replacements: [] });
  const applySchema = { operationId: planned.plan.operationId, confirmationToken: planned.plan.confirmationToken };
  assert.equal((await first.post("cms.schema.apply", applySchema, { token: h.otherToken })).status, 403);
  const { result: { schemaRevision } } = await first.read("cms.schema.apply", applySchema);
  assert.equal((await first.read("cms.schema.read")).collections[1].id, "news");

  const createInput = { collectionId: "posts", contractVersion: 2, expectedSchemaRevision: schemaRevision };
  const operationKey = headers();
  const fail = t.mock.method(console, "error", () => {});
  h.faults.put = "before";
  assert.equal((await first.post("cms.items.create", createInput, { headers: operationKey })).status, 503);
  h.faults.put = "after";
  assert.equal((await first.post("cms.items.create", createInput, { headers: operationKey })).status, 503);
  assert.equal((await first.read("cms.items.list", { collectionId: "posts", deleted: false })).items.length, 0);
  h.faults.batch = true;
  assert.equal((await first.post("cms.items.create", createInput, { headers: operationKey })).status, 503);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_cms_receipts WHERE operation = 'cms.items.create'").get().count, 0);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_cms_revisions").get().count, 0);
  assert.equal(fail.mock.callCount(), 3);
  const [created, retriedCreate] = await Promise.all([
    first.post("cms.items.create", createInput, { headers: operationKey }).then((res) => body(res, 200)),
    first.post("cms.items.create", createInput, { headers: operationKey }).then((res) => body(res, 200))
  ]);
  const draft0 = created.item;
  assert.deepEqual(retriedCreate, created);
  assert.equal([...h.objects.keys()].filter((key) => key.startsWith(`sites/${first.siteId}/items/`)).length, 1,
    "an exact retry reuses its immutable object after a failed D1 commit");
  assert.equal((await first.post("cms.items.create", { ...createInput, collectionId: "news" }, { headers: operationKey })).status, 409);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_cms_audit WHERE operation = 'cms.items.create'").get().count, 1);
  const firstDraft = await saveDraft(first, draft0, "Published first");
  assert.equal((await first.pub("/posts/notice")).status, 404);
  const seen = await body(await first.cli("GET", `cms.read/posts/${firstDraft.itemId}`), 200);
  assert.equal(seen.item.version, firstDraft.revision);
  assert.equal(seen.item.values.title, "Published first");
  assert.equal((await first.cli("POST", "cms.create/posts", { operationId: crypto.randomUUID() }, { headers: { "X-Studio-CMS-Version": "1" } })).status, 409);
  assert.equal((await other.post("cms.items.read", { collectionId: "posts", itemId: firstDraft.itemId })).status, 404);
  assert.equal((await other.post("cms.items.save", { ...versioned(firstDraft), values: values("Other") }, { headers: headers() })).status, 404);
  const preview = await first.read("cms.preview.prepare", { ...pin(firstDraft) });
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_cms_tokens WHERE token_hash = ?").get(preview.previewId).count, 0);
  assert.equal((await other.post("cms.preview.read", { previewId: preview.previewId })).status, 404);
  assert.equal((await first.post("cms.preview.read", { previewId: preview.previewId }, { token: h.otherToken })).status, 404);
  const previewResponse = await first.post("cms.preview.read", { previewId: preview.previewId });
  assert.equal(previewResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(previewResponse.headers.get("X-Robots-Tag"), "noindex");
  assert.equal((await body(previewResponse, 200)).preview.title, "Published first");
  assert.equal((await first.post("cms.preview.read", { previewId: preview.previewId })).status, 404);

  const expired = await first.read("cms.preview.prepare", pin(firstDraft));
  h.sqlite.prepare("UPDATE managed_cms_tokens SET expires_at = 0 WHERE purpose = 'preview'").run();
  assert.equal((await first.post("cms.preview.read", { previewId: expired.previewId })).status, 404);

  const publish = await releasePlan(first, schemaRevision, null, [firstDraft]);
  h.faults.batch = true;
  assert.equal((await first.post("cms.release.apply", publish)).status, 503);
  assert.equal((await first.pub("/posts/notice")).status, 404);
  const receipt = await first.read("cms.release.apply", publish, { token: h.ownerToken });
  assert.deepEqual(await first.read("cms.release.apply", publish), receipt);
  const deliveredStatus = await first.read("cms.release.status", { operationId: publish.operationId });
  assert.deepEqual(deliveredStatus.result, receipt.result);
  assert.equal(deliveredStatus.delivery.state, "delivered");
  assert.equal(deliveredStatus.delivery.failure, null);
  const releaseId = receipt.result.releaseId;
  assert.equal((await other.post("cms.release.snapshot", { releaseId })).status, 404);
  assert.equal((await first.read("cms.release.snapshot", { releaseId })).snapshot.items[0].revision, firstDraft.revision);
  const html = await (await first.pub("/posts/notice")).text();
  assert.match(html, /Published first/u);
  assert.match(html, /&lt;script&gt;Fixture only&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(await (await first.pub("/posts")).text(), /href="\/s\/first-cms\/cms\/posts\/notice"/u);

  const previewBeforeEdit = await first.read("cms.preview.prepare", pin(firstDraft));
  const secondDraft = await saveDraft(first, firstDraft, "Published second");
  assert.equal((await first.post("cms.preview.read", { previewId: previewBeforeEdit.previewId })).status, 404);
  assert.match(await (await first.pub("/posts/notice")).text(), /Published first/u);
  const secondPlan = await releasePlan(first, schemaRevision, releaseId, [secondDraft]);
  h.faults.release = true;
  const releaseReceipt = await first.read("cms.release.apply", secondPlan);
  assert.match(await (await first.pub("/posts/notice")).text(), /Published first/u);
  assert.deepEqual(await first.read("cms.release.apply", secondPlan), releaseReceipt);
  const pendingStatus = await first.read("cms.release.status", { operationId: secondPlan.operationId });
  assert.equal(pendingStatus.delivery.state, "pending");
  assert.equal(pendingStatus.delivery.failure, "unavailable");
  const pending = h.sqlite.prepare("SELECT state, attempts, failure FROM managed_cms_outbox WHERE id = ?").get(releaseReceipt.result.releaseId);
  assert.deepEqual({ ...pending }, { state: "pending", attempts: 1, failure: "unavailable" });
  h.sqlite.prepare("UPDATE managed_cms_outbox SET available_at = 0, lease_id = 'interrupted', lease_until = unixepoch() + 60 WHERE id = ?").run(releaseReceipt.result.releaseId);
  await h.cron();
  assert.match(await (await first.pub("/posts/notice")).text(), /Published first/u);
  h.sqlite.prepare("UPDATE managed_cms_outbox SET lease_until = 0 WHERE id = ?").run(releaseReceipt.result.releaseId);
  await h.cron();
  assert.match(await (await first.pub("/posts/notice")).text(), /Published second/u);
  assert.equal((await first.read("cms.release.status", { operationId: secondPlan.operationId })).delivery.state, "delivered");
  assert.match((await first.read("cms.release.snapshot", { releaseId })).snapshot.items[0].values.title, /Published first/u);

  const thirdDraft = await saveDraft(first, secondDraft, "Dead-letter candidate");
  const thirdPlan = await releasePlan(first, schemaRevision, releaseReceipt.result.releaseId, [thirdDraft]);
  h.faults.release = true;
  const failedReceipt = await first.read("cms.release.apply", thirdPlan);
  for (let attempt = 2; attempt <= 5; attempt++) {
    h.sqlite.prepare("UPDATE managed_cms_outbox SET available_at = 0 WHERE id = ?").run(failedReceipt.result.releaseId);
    h.faults.release = true;
    await h.cron();
  }
  const deadLetter = h.sqlite.prepare("SELECT state, attempts, failure FROM managed_cms_outbox WHERE id = ?").get(failedReceipt.result.releaseId);
  assert.deepEqual({ ...deadLetter }, { state: "dead", attempts: 5, failure: "unavailable" });
  assert.match(await (await first.pub("/posts/notice")).text(), /Published second/u);
  assert.equal((await first.post("cms.release.snapshot", { releaseId: failedReceipt.result.releaseId })).status, 404);
  const recoveredPlan = await releasePlan(first, schemaRevision, releaseReceipt.result.releaseId, [thirdDraft]);
  await first.read("cms.release.apply", recoveredPlan);
  assert.match(await (await first.pub("/posts/notice")).text(), /Dead-letter candidate/u);

  for (let i = 0; i < 10; i++) await createDraft(first, schemaRevision);
  const page = await first.read("cms.items.list", { collectionId: "posts", deleted: false });
  assert.equal(page.items.length, 10);
  assert.ok(page.nextCursor);
  assert.equal((await other.post("cms.items.list", { collectionId: "posts", deleted: false, cursor: page.nextCursor })).status, 404);
  assert.equal((await first.post("cms.items.list", { collectionId: "posts", deleted: false, cursor: page.nextCursor }, { token: h.otherToken })).status, 404);
  assert.equal((await first.read("cms.items.list", { collectionId: "posts", deleted: false, cursor: page.nextCursor })).items.length, 1);
});

testWithD1("Studio CMS public routes preserve uppercase slug segments", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "uppercase-cms-route");
  const { schemaRevision } = await site.read("cms.schema.read");
  const draft = await createDraft(site, schemaRevision);
  const saved = await saveDraft(site, draft, "Legacy route", "Legacy-Case");
  const plan = await releasePlan(site, schemaRevision, null, [saved]);
  await site.read("cms.release.apply", plan);
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await site.read("cms.release.status", { operationId: plan.operationId })).delivery.state === "delivered") break;
    await h.cron();
  }

  const current = await site.read("cms.release.current");
  assert.equal(current.snapshot.items[0].path, "/cms/posts/Legacy-Case");
  const response = await site.pub("/posts/Legacy-Case");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Legacy route/u);
  assert.equal((await site.pub("/posts/legacy-case")).status, 404);
});

testWithD1("Studio CMS CLI actor, scheduled release, cancellation, deletion and database/R2 restore", async (t) => {
  const h = await fixture(t, { cms: true });
  const site = await cmsSite(h, "restore-cms");
  const schema = await site.read("cms.schema.read");
  const addGrant = h.sqlite.prepare(`INSERT INTO studio_cli_grants
    (client_id, project_id, site_id, capability, delegated_by_subject, expires_at) VALUES (?, ?, ?, ?, ?, unixepoch() + 600)`);
  for (const capability of ["cms.read", "cms.edit", "cms.publish"]) addGrant.run(SERVICE_CLIENT, site.projectId, site.siteId, capability, OWNER);
  const service = { service: true, token: h.serviceToken };
  const create = { operationId: crypto.randomUUID() };
  const legacyDraft = (await body(await site.cli("POST", "cms.create/posts", create, service), 200)).item;
  assert.deepEqual((await body(await site.cli("POST", "cms.create/posts", create, service), 200)).item, legacyDraft);
  const legacySave = await body(await site.cli("PUT", `cms.save/posts/${legacyDraft.id}`, {
    operationId: crypto.randomUUID(), expectedVersion: legacyDraft.version, values: values("Initial public")
  }, service), 200);
  const operationId = crypto.randomUUID(), expectedVersion = legacySave.item.version;
  const path = `cms.publish-now/posts/${legacyDraft.id}`;
  const input = { operationId, expectedVersion };
  assert.deepEqual(await body(await site.cli("POST", path, { ...input, expectedVersion: legacyDraft.version }, service), 409), { error: "version_conflict" });
  const attempts = await Promise.all([site.cli("POST", path, input, service), site.cli("POST", path, input, service)]);
  const applied = await body(attempts[0], 200);
  assert.deepEqual(await body(attempts[1], 200), applied);
  assert.deepEqual(await body(await site.cli("POST", path, { ...input, redirect: true }, service), 409), { error: "duplicate_operation" });
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_cms_receipts WHERE site_id = ? AND operation_id = ?").get(site.siteId, operationId).count, 1);
  assert.equal(applied.status, "publishing");
  const status = await body(await site.cli("GET", `cms.operation-status/${operationId}`, undefined, service), 200);
  assert.equal(status.result.status, "published");
  assert.equal(status.result.item.version, applied.item.version);
  h.sqlite.prepare("DELETE FROM studio_cli_grants WHERE client_id = ? AND capability = 'cms.read'").run(SERVICE_CLIENT);
  assert.equal((await site.cli("GET", `cms.read/posts/${legacyDraft.id}`, undefined, service)).status, 403);
  const editRoot = `/api/edit/v2/sites/${site.siteId}`;
  const readInput = { siteId: site.siteId, collectionId: "posts", itemId: legacyDraft.id };
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${editRoot}/operations/cms.items.read`, readInput, { cli: true, ...service })).status, 403);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${editRoot}/operations/cms.items.read`, readInput, { cli: true })).status, 200);

  const initial = (await site.read("cms.items.read", { collectionId: "posts", itemId: legacyDraft.id })).item;
  const pinned = await saveDraft(site, initial, "Reservation version");
  const future = new Date(Date.now() + 120_000).toISOString();
  const { snapshot: current } = await site.read("cms.release.current");
  assert.equal(current.items[0].revision, initial.revision);
  const cancelPlan = await releasePlan(site, schema.schemaRevision, current.releaseId, [pinned], future);
  const { result: cancelled } = await site.read("cms.schedule.create", cancelPlan);
  await site.read("cms.schedule.cancel", { scheduleId: cancelled.scheduleId }, { headers: headers() });
  assert.equal((await site.read("cms.schedule.status", { scheduleId: cancelled.scheduleId })).status, "cancelled");
  const schedulePlan = await releasePlan(site, schema.schemaRevision, current.releaseId, [pinned], future);
  const { result: schedule } = await site.read("cms.schedule.create", schedulePlan);
  const latest = await saveDraft(site, pinned, "Draft after scheduling");
  assert.match(await (await site.pub("/posts/notice")).text(), /Initial public/u);
  const clock = t.mock.method(Date, "now", () => Date.parse(future) + 50_000);
  // Advance the clock past the fixed reservation and drain prior verification events.
  for (let i = 0; i < 3; i++) await h.cron();
  clock.mock.restore();
  assert.equal((await site.read("cms.schedule.status", { scheduleId: schedule.scheduleId })).status, "released");
  const publiclyServed = await (await site.pub("/posts/notice")).text();
  assert.match(publiclyServed, /Reservation version/u);
  assert.doesNotMatch(publiclyServed, /Draft after scheduling/u);

  const backupDir = await mkdtemp(join(tmpdir(), "niho-cms-restore-"));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const backupFile = join(backupDir, "registry.db"), r2Export = join(backupDir, "objects.json");
  h.sqlite.prepare("VACUUM INTO ?").run(backupFile);
  await writeFile(r2Export, JSON.stringify([...h.objects]));

  assert.equal((await site.post("cms.items.remove", versioned(latest), { headers: headers() })).status, 409);
  const withdraw = await releasePlan(site, schema.schemaRevision, schedule.releaseId, []);
  await site.read("cms.release.apply", withdraw);
  assert.equal((await site.pub("/posts/notice")).status, 404);
  await site.read("cms.items.remove", versioned(latest), { headers: headers() });
  assert.equal((await site.post("cms.items.read", { collectionId: "posts", itemId: latest.itemId })).status, 404);
  assert.equal((await site.read("cms.items.list", { collectionId: "posts", deleted: true })).items[0].id, latest.itemId);
  await site.read("cms.items.restore", versioned(latest), { headers: headers() });
  assert.equal((await site.read("cms.items.read", { collectionId: "posts", itemId: latest.itemId })).item.revision, latest.revision);
  assert.equal((await site.pub("/posts/notice")).status, 404);

  const restored = await fixture(t, { cms: true, restore: backupFile, restoredObjects: JSON.parse(await readFile(r2Export, "utf8")) });
  assert.equal(await (await restored.send(PUBLIC_ORIGIN, "GET", "/s/restore-cms/cms/posts/notice", undefined, { auth: false })).text(), publiclyServed);
  const restoredSnapshot = await body(await restored.send(MANAGEMENT_ORIGIN, "POST", `${site.endpoint}/cms.release.snapshot`,
    { siteId: site.siteId, releaseId: schedule.releaseId }), 200);
  assert.equal(restoredSnapshot.snapshot.items[0].revision, pinned.revision);
  const restoredDraft = await body(await restored.send(MANAGEMENT_ORIGIN, "POST", `${site.endpoint}/cms.items.read`,
    { siteId: site.siteId, collectionId: "posts", itemId: latest.itemId }), 200);
  assert.equal(restoredDraft.item.revision, latest.revision);
  assert.equal((await restored.send(MANAGEMENT_ORIGIN, "POST", `${site.endpoint}/cms.release.snapshot`,
    { siteId: site.siteId, releaseId: schedule.releaseId }, { token: restored.otherToken })).status, 403);
  const restoredReceipt = await body(await restored.send(MANAGEMENT_ORIGIN, "POST", `${site.endpoint}/cms.schedule.create`,
    { siteId: site.siteId, ...schedulePlan }), 200);
  assert.equal(restoredReceipt.result.releaseId, schedule.releaseId);
});

async function cmsDeliveryFixture(h, site, options = {}) {
  const admin = `/api/projects/${site.projectId}/sites/${site.siteId}/cms/delivery`;
  const credentials = `${admin}/credentials`;
  const sameOrigin = { Origin: MANAGEMENT_ORIGIN, "Sec-Fetch-Site": "same-origin" };
  const { credentialId, secret } = await body(await h.send(MANAGEMENT_ORIGIN, "POST", credentials, undefined, { headers: sameOrigin }), 201);
  const config = { origin: MANAGEMENT_ORIGIN, siteId: site.siteId, credentialId, secret,
    rendererContractVersion: CMS_DELIVERY_RENDERER_VERSION, fetch: h.fetch, ...options };
  const root = `/api/cms-delivery/v1/sites/${site.siteId}`;
  const signed = async (path, {
    method = "GET", input, sentInput = input, timestamp = String(Math.floor(Date.now() / 1000)), signPath = path,
    sendOrigin = MANAGEMENT_ORIGIN, params = "", additionalHeaders
  } = {}) => {
    const jsonBody = input === undefined ? null : JSON.stringify(input);
    const signature = await signCmsDeliveryRequest(secret, { method, siteId: site.siteId, path: signPath, timestamp, credentialId, body: jsonBody ?? "" });
    return h.fetch(`${sendOrigin}${path}${params}`, { method, ...(sentInput === undefined ? {} : { body: JSON.stringify(sentInput) }),
      headers: { "X-Cms-Credential": credentialId, "X-Cms-Timestamp": timestamp, "X-Cms-Signature": signature,
        ...(sentInput === undefined ? {} : { "Content-Type": "application/json" }), ...additionalHeaders } });
  };
  return { admin, credentials, config, client: createCmsDeliveryClient(config), credentialId, secret, root, signed, sameOrigin };
}

testWithD1("External CMS delivery links committed events, immutable snapshots and current artifact acknowledgements", async (t) => {
  const h = await fixture(t, { cms: true });
  const site = await cmsSite(h, "cms-delivery"), other = await cmsSite(h, "other-delivery");
  const cache = new Map(), fetches = [];
  const delivery = await cmsDeliveryFixture(h, site, {
    cache: { async read(key) { return cache.get(key) ?? null; }, async write(key, entry) { cache.set(key, entry); } },
    fetch: async (url, init) => {
      const response = await h.fetch(url, init);
      fetches.push({ status: response.status, etag: new Headers(init.headers).get("if-none-match") });
      return response;
    }
  });
  const { root, credentials, sameOrigin, client, signed, admin, secret, credentialId } = delivery;
  assert.equal(h.sqlite.prepare("SELECT secret_hash FROM managed_cms_delivery_credentials WHERE site_id = ? AND credential_id = ?")
    .get(site.siteId, credentialId).secret_hash, await cmsDeliveryHash(secret));
  const listed = await body(await h.send(MANAGEMENT_ORIGIN, "GET", credentials), 200);
  assert.deepEqual(listed.credentials.map((entry) => Object.keys(entry).sort()), [["createdAt", "credentialId"]]);
  assert.equal(listed.credentials[0].credentialId, credentialId);
  const hashCredential = createCmsDeliveryClient({ ...delivery.config, secret: await cmsDeliveryHash(secret) });
  await assert.rejects(hashCredential.events(), /401/u, "the stored credential hash cannot sign requests");
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, 'editor', 'Editor')").run(site.projectId, OTHER);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", credentials, undefined, { token: h.otherToken })).status, 404);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", credentials, undefined, { headers: sameOrigin, token: h.otherToken })).status, 404);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "DELETE", `${credentials}/${credentialId}`, undefined, { headers: sameOrigin, token: h.otherToken })).status, 404);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", credentials, undefined, { headers: { ...sameOrigin, Origin: "https://other.example" } })).status, 400);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${root}/ja/snapshot`)).status, 401, "human credentials cannot be used for delivery");
  assert.equal((await signed(`${root}/ja/snapshot`, { timestamp: String(Math.floor(Date.now() / 1000) - 121) })).status, 401);
  assert.equal((await signed(`${root}/ja/snapshot`, { params: "?preview=true" })).status, 404);
  assert.equal((await signed(`${root}/ja/snapshot`, { signPath: `${root}/en/snapshot` })).status, 401);
  assert.equal((await signed(root + "/events", { method: "POST", input: { afterSequence: 0 }, sentInput: { afterSequence: 1 } })).status, 401);
  assert.equal((await signed(root + "/events", { method: "POST", input: { afterSequence: 0 }, additionalHeaders: { "Content-Type": "text/plain" } })).status, 400);
  assert.equal((await signed(root.replace(site.siteId, other.siteId) + "/ja/snapshot")).status, 401);
  assert.equal((await signed(root + "/ja/snapshot", { sendOrigin: PUBLIC_ORIGIN })).status, 404);
  assert.deepEqual(await client.events(), { events: [], nextSequence: 0 });
  assert.equal((await signed(root + "/ja/snapshot")).status, 404);

  const { schemaRevision } = await site.read("cms.schema.read");
  const first = await saveDraft(site, await createDraft(site, schemaRevision), "Published value");
  const draft = await saveDraft(site, first, "Unpublished value");
  h.sqlite.prepare("UPDATE managed_pages SET path = '/draft-reservation' WHERE site_id = ? AND page_id = 'home'").run(site.siteId);
  const plan = await releasePlan(site, schemaRevision, null, [first]);
  h.faults.deliveryEvent = true;
  const publish = await site.read("cms.release.apply", plan);
  const firstId = publish.result.releaseId;
  assert.deepEqual(await client.events(), { events: [], nextSequence: 0 });
  assert.equal((await site.read("cms.release.current")).snapshot, null, "a failed event insert also rolls back the pointer");
  h.sqlite.prepare("UPDATE managed_cms_outbox SET available_at = unixepoch() WHERE id = ?").run(firstId);
  await h.cron();

  const rawEvents = await client.events();
  const [event] = rawEvents.events;
  assert.equal(event.releaseId, firstId);
  assert.equal(event.eventId, firstId);
  assert.equal(event.siteId, site.siteId);
  assert.deepEqual(await client.events(), rawEvents, "notification reads are at least once until the host advances its cursor");
  assert.deepEqual(await client.events(event.sequence), { events: [], nextSequence: event.sequence });
  const built = await client.snapshot("ja");
  assert.equal(built.snapshotDigest, event.snapshotDigest);
  assert.equal(built.snapshot.releaseId, firstId);
  assert.doesNotMatch(JSON.stringify(built.snapshot), /Unpublished value|draft-reservation/u);
  const artifact = structuredClone(cmsDeliveryRoutes(built.snapshot));
  assert.equal(artifact.lists[0].path, "/cms/posts");
  assert.equal(artifact.details[0].item.values.title, "Published value");
  assert.deepEqual(await client.snapshot("ja"), built);
  assert.deepEqual(fetches.at(-1), { status: 304, etag: built.etag });

  const legacySnapshot = structuredClone(built.snapshot);
  delete legacySnapshot.routeTable;
  delete legacySnapshot.routeTableRevision;
  const legacyDelivery = await serializeCmsDeliverySnapshot(legacySnapshot);
  const restoredLegacy = parseCmsDeliverySnapshot(JSON.parse(legacyDelivery.body), site.siteId, "ja");
  assert.equal(restoredLegacy.routeTable.reservations.some(({ path }) => path === artifact.details[0].path), true,
    "pre-route-table releases are reconstructed for delivery without changing their stored snapshot");

  const status = () => h.send(MANAGEMENT_ORIGIN, "GET", `${admin}/ja/status`).then((response) => body(response, 200));
  const ack = { state: "deployed", releaseId: firstId, snapshotDigest: built.snapshotDigest,
    rendererContractVersion: CMS_DELIVERY_RENDERER_VERSION, artifactId: "static_build_1" };
  assert.deepEqual(await status(), { state: "pending", releaseId: firstId });
  await assert.rejects(client.acknowledge("ja", { ...ack, snapshotDigest: "f".repeat(64) }), /409/u);
  assert.equal((await signed(root + "/ja/ack", { method: "POST", input: { ...ack, rendererContractVersion: 7 } })).status, 400);
  await assert.rejects(client.acknowledge("en", ack), /409/u);
  const { artifactId: _artifactId, ...failed } = ack;
  await client.acknowledge("ja", { ...failed, state: "failed" });
  assert.equal((await status()).state, "failed");
  await client.acknowledge("ja", ack);
  const acknowledged = await status();
  assert.equal(acknowledged.state, "deployed");
  assert.equal(acknowledged.artifactId, ack.artifactId);
  await client.acknowledge("ja", ack);
  assert.deepEqual(await status(), acknowledged);
  await assert.rejects(client.acknowledge("ja", { ...ack, artifactId: "other_build" }), /409/u);
  assert.deepEqual(await status(), acknowledged);
  assert.equal((await site.read("cms.release.current")).snapshot.releaseId, firstId);

  const next = await site.read("cms.release.apply", await releasePlan(site, schemaRevision, firstId, [draft]));
  await h.cron();
  assert.deepEqual(await status(), { state: "pending", releaseId: next.result.releaseId });
  assert.equal((await client.events(event.sequence)).events[0].releaseId, next.result.releaseId);
  await assert.rejects(client.acknowledge("ja", ack), /409/u);
  assert.equal((await client.snapshot("ja", firstId)).snapshotDigest, built.snapshotDigest);
  assert.equal((await client.snapshot("ja")).snapshot.releaseId, next.result.releaseId);
  assert.equal((await signed(root + `/en/snapshot/${firstId}`)).status, 404);

  const offline = createCmsDeliveryClient({ ...delivery.config, fetch: async () => { throw new Error("Studio unavailable"); } });
  await assert.rejects(offline.snapshot("ja"), /Studio unavailable/u);
  assert.equal(artifact.details[0].item.values.title, "Published value");
  const rejectedContract = createCmsDeliveryClient({ ...delivery.config, fetch: async () => new Response("{}", {
    headers: { "X-Cms-Renderer-Version": "3", "Content-Type": "application/json" }
  }) });
  await assert.rejects(rejectedContract.snapshot("ja"), /unsupported CMS renderer/u);
  const rejectedBody = createCmsDeliveryClient({ ...delivery.config, fetch: async () => new Response("{}", {
    headers: { "X-Cms-Renderer-Version": String(CMS_DELIVERY_RENDERER_VERSION), "Content-Type": "application/json", ETag: built.etag }
  }) });
  await assert.rejects(rejectedBody.snapshot("ja"), /digest/u);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "DELETE", `${credentials}/${credentialId}`, undefined, { headers: sameOrigin })).status, 204);
  await assert.rejects(client.snapshot("ja"), /401/u);
  const audit = h.sqlite.prepare("SELECT operation FROM managed_cms_audit WHERE operation GLOB 'cms.delivery.credential.*' ORDER BY operation").all();
  assert.deepEqual(audit.map(({ operation }) => operation), ["cms.delivery.credential.issued", "cms.delivery.credential.revoked"]);
});

testWithD1("Kamakura import seeds a noindex verification site and preserves immutable public and draft revisions on retry", async (t) => {
  const h = await fixture(t, { cms: true }), site = await cmsSite(h, "migration-fixture");
  const target = { projectId: site.projectId, siteId: site.siteId, verificationOrigin: h.env.PUBLIC_SITES_PREVIEW_ORIGIN };
  const schema = await site.read("cms.schema.read");
  const origin = "https://migration-source.example.test", siteId = "fixture-source";
  const media = Buffer.from("synthetic asset bytes"), contentSha256 = createHash("sha256").update(media).digest("hex");
  const originalUrl = "https://media.example.test/original.webp", aliasUrl = "https://media.example.test/alias.webp";
  const assetRef = { provider: "fixture-media", id: "original" }, derivedRef = { provider: "fixture-media", id: "alias" };
  const refId = "emb_" + "a".repeat(32);
  const launch = { v: 1, flow: "inquiry", spotId: "example", publicId: "example", launchTokenVersion: 1,
    parentOrigin: target.verificationOrigin, allowedPathPrefix: "/s/migration-fixture/" };
  const token = Buffer.from(JSON.stringify(launch)).toString("base64url") + "." + "b".repeat(43);
  const embedConnections = [{ sourceUrl: origin + "/", refId, src: `https://niho.life/embed/inquiry/example?launchToken=${token}` }];
  await setFixturePublicPolicy(h, site, { frameOrigins: ["https://niho.life"], resourceOrigins: [] });
  const document = (pageId, locale, revision, title, body = []) => ({
    document: { schemaVersion: 1, siteId, pageId, locale, revision, title, tokens: {}, body }
  });
  const source = {
    formatVersion: 1, origin, siteId, locale: "ja",
    assets: [
      { source: assetRef, url: originalUrl, aliases: [aliasUrl], width: 10, height: 20, altText: "Fixture", byteLength: media.length, contentSha256 },
      { source: { provider: "fixture-media", id: "same-bytes" }, url: "https://media.example.test/second.webp",
        width: null, height: null, altText: "", byteLength: media.length, contentSha256 }
    ],
    assetVariants: [{ source: derivedRef, original: assetRef }],
    pages: [
      { sourceUrl: origin + "/", sourcePageId: "home-source", path: "/", locale: "ja", visibility: "public",
        published: document("home-source", "ja", 8, "Published fixture"), draft: {
          ...document("home-source", "ja", 12, "Current fixture", [
            { type: "element", id: "link", tag: "a", attrs: { href: origin + "/english?ref=fixture#link" }, children: [{ type: "text", text: "Open" }] },
            { type: "element", id: "photo", tag: "img", attrs: { src: aliasUrl, alt: "Fixture" }, children: [] },
            { type: "component", id: "form", block: "KamakuraContactForm", props: {} }
          ]), sourceBlocks: { KamakuraContactForm: { props: {} } }, replacements: [{ nodeId: "form", kind: "managed-embed", refId }]
        } },
      { sourceUrl: origin + "/english", sourcePageId: "english-source", path: "/en", locale: "en", visibility: "private",
        published: null, draft: document("english-source", "en", 3, "Translation fixture") },
      { sourceUrl: origin + "/deferred", sourcePageId: "deferred-source", path: "/deferred", locale: "ja", visibility: "public",
        published: document("deferred-source", "ja", 2, "Prior deferred fixture"), draft: {
          ...document("deferred-source", "ja", 5, "Deferred fixture", [{ type: "component", id: "cms-list", block: "KamakuraCmsList", props: {} }]),
          sourceBlocks: { KamakuraCmsList: { props: {} } }
        } }
    ],
    cms: { schema: { ...schema, siteId, collections: schema.collections.map((collection) => ({ ...collection, fields: [...collection.fields,
      { fieldId: "cover", key: "cover", label: "Cover", type: "image", placement: "main" }
    ] })) }, items: [{ collectionId: "posts", itemId: "fixture-post", published: { ...values("Published post"), cover: derivedRef },
      draft: { ...values("Draft post"), cover: aliasUrl }, translations: { targetLocale: "en",
        published: { title: { value: "Published translation", reviewed: true } }, draft: { title: { value: "Current translation", reviewed: false } }
      } }] },
    redirects: [{ locale: "ja", fromPath: "/old", toPath: "/en" }],
    scheduled: [{ kind: "page", sourceUrl: origin + "/english", at: "2035-01-01T00:00:00.000Z" }]
  };
  const bytes = Buffer.from(JSON.stringify(source)), digest = createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(() => prepareKamakuraSiteImport(Buffer.concat([bytes, Buffer.from("\n")]), digest, target), /source_checksum_mismatch/);
  const prepared = await prepareKamakuraSiteImport(bytes, digest, target, embedConnections);
  const loadAsset = async () => media;
  await assert.rejects(() => applyKamakuraSiteImport(prepared, MANAGEMENT_ORIGIN, h.ownerToken, h.fetch, async () => Buffer.alloc(media.length)),
    /source_asset_checksum_mismatch/);
  const endpoint = `/api/edit/v2/sites/${site.siteId}/operations/site.migration-import`;
  const begin = (target, options = { cli: true }) => h.send(MANAGEMENT_ORIGIN, "POST", endpoint,
    { target, sourceDigest: digest, action: "begin", payload: prepared.plan }, options);
  assert.equal((await begin(target, { cli: true, token: h.otherToken })).status, 403);
  assert.equal((await begin({ ...target, projectId: "other-project" })).status, 403);
  assert.equal((await begin({ ...target, verificationOrigin: PUBLIC_ORIGIN })).status, 403);
  h.sqlite.prepare("UPDATE managed_site_hosts SET noindex = 0 WHERE site_id = ? AND hostname = ?")
    .run(site.siteId, new URL(target.verificationOrigin).hostname);
  assert.equal((await begin(target)).status, 403);
  h.sqlite.prepare("UPDATE managed_site_hosts SET noindex = 1 WHERE site_id = ? AND hostname = ?")
    .run(site.siteId, new URL(target.verificationOrigin).hostname);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM managed_site_imports").get().n, 0);

  await body(await begin(target), 200);
  const failedMedia = await h.fetch(`${MANAGEMENT_ORIGIN}${endpoint}/${contentSha256}`, {
    method: "PUT", body: Buffer.alloc(media.length), headers: { "cf-access-token": h.ownerToken, "content-type": "application/octet-stream",
      "x-import-project": site.projectId, "x-import-verification-origin": target.verificationOrigin, "x-import-source-digest": digest }
  });
  await body(failedMedia, 400);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM managed_site_import_asset_blobs").get().n, 0);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", endpoint,
    { target, sourceDigest: digest, action: "page", payload: prepared.pages[0] }, { cli: true }), 409);

  let applied = false;
  const interrupted = async (url, init) => {
    const response = await h.fetch(url, init);
    if (!applied && init.method === "POST" && JSON.parse(init.body).action === "page") {
      applied = true;
      assert.equal(response.status, 200);
      throw new Error("synthetic connection loss after commit");
    }
    return response;
  };
  await assert.rejects(() => applyKamakuraSiteImport(prepared, MANAGEMENT_ORIGIN, h.ownerToken, interrupted, loadAsset), /connection loss/);
  const result = await applyKamakuraSiteImport(prepared, MANAGEMENT_ORIGIN, h.ownerToken, h.fetch, loadAsset);
  assert.equal(result.mapping.pages[2].deferred, "cms-block-conversion");
  assert.doesNotMatch(JSON.stringify(result), /launchToken/u);
  const archived = JSON.parse(h.objects.get(`sites/${site.siteId}/migration/deferred-pages/${result.planDigest}/${result.mapping.pages[2].pageId}.json`));
  assert.equal(archived.published.document.title, "Prior deferred fixture");
  assert.equal(archived.draft.document.body[0].block, "KamakuraCmsList");
  const snapshot = [...h.objects], counts = (table) => h.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  assert.deepEqual(await applyKamakuraSiteImport(prepared, MANAGEMENT_ORIGIN, h.ownerToken, h.fetch, loadAsset), result);
  assert.deepEqual([...h.objects], snapshot);
  assert.equal(counts("managed_site_import_resources"), 4);
  assert.equal(counts("managed_site_import_asset_blobs"), 1);
  assert.deepEqual(Buffer.from(h.objects.get(`sites/${site.siteId}/migration/assets/${contentSha256}`)), media);
  assert.equal(counts("managed_embed_connections"), 1);
  assert.equal(counts("managed_page_versions"), 3);
  assert.equal(counts("managed_cms_revisions"), 2);
  assert.equal(counts("managed_page_publications"), 0);
  assert.equal(counts("managed_cms_releases"), 0);
  assert.equal(counts("managed_cms_outbox"), 0);
  assert.equal((await h.send(PUBLIC_ORIGIN, "GET", "/s/migration-fixture/", undefined, { auth: false })).status, 404);
  const proof = await publishedSiteRequest(new Request(`${target.verificationOrigin}/s/migration-fixture/`), h.env);
  assert.equal(proof.status, 404);
  assert.equal(proof.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const pageSource = h.sqlite.prepare("SELECT document_key FROM managed_page_versions WHERE site_id = ? AND page_id = 'home' ORDER BY revision")
    .all(site.siteId).map(({ document_key }) => JSON.parse(h.objects.get(document_key)));
  assert.deepEqual(pageSource.map(({ title }) => title), ["Published fixture", "Current fixture"]);
  assert.equal(pageSource[1].body[0].attrs.href, "/en?ref=fixture#link");
  const item = await site.read("cms.items.read", { collectionId: "posts", itemId: result.mapping.cmsItems[0].itemId });
  assert.equal(item.item.values.title, "Draft post");
  const importedItem = result.mapping.cmsItems[0];
  const publishedKey = `sites/${site.siteId}/items/ja/posts/${importedItem.itemId}/${importedItem.publishedRevision}.json`;
  assert.equal(JSON.parse(h.objects.get(publishedKey)).values.title, "Published post");
  const { reference } = result.mapping.assets[0];
  assert.deepEqual(item.item.values.cover, reference);
  assert.deepEqual(pageSource[1].body[1].asset, reference);
  assert.deepEqual(pageSource[1].body[2].props.refId, refId);
  const qualified = `${reference.provider}:${reference.id}`;
  const resolved = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `/api/edit/v1/sites/${site.siteId}/operations/assets.resolve`,
    { references: [reference] }, { cli: true }), 200);
  assert.deepEqual(resolved.assets[qualified], { src: originalUrl, width: 10, height: 20 });
  const itemKey = cmsLocalizationItemKey("posts", item.item.itemId);
  const localization = await site.read("cms.localization.items.read", { itemKey });
  assert.equal(parseLocalizationItemResult(localization, itemKey).item.units.find(({ label }) => label === "タイトル").value, "Current translation");
  const importPlan = JSON.parse(h.objects.get(`sites/${site.siteId}/migration/plans/${result.planDigest}.json`));
  assert.deepEqual(importPlan.scheduled, source.scheduled);
  const redirects = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `/api/projects/${site.projectId}/sites/${site.siteId}/editor/redirects`), 200);
  assert.deepEqual(redirects.redirects, source.redirects);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", endpoint, {
    target, sourceDigest: digest, action: "page", payload: { ...prepared.pages[0], visibility: "private" }
  }, { cli: true }), 409);
});
