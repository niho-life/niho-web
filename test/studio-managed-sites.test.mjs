import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
const SERVICE_CLIENT = `${"c".repeat(32)}.access`;

const migrationDirectory = new URL("../studio/migrations/", import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort().map((name) => readFile(new URL(name, migrationDirectory), "utf8")));
const bundle = await build({
  stdin: {
    contents: 'export { default } from "./studio/worker.ts"; export { publishedSiteRequest } from "./studio/managed-publication.ts"; export { managedCmsApi } from "./studio/managed-cms.ts"; export { CmsStore } from "./studio/managed-cms-store.ts";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url))
  },
  bundle: true, format: "esm", platform: "node", target: "node22", write: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(`${process.cwd()}/studio-worker-test.mjs`);' }
});
const { default: worker, publishedSiteRequest, managedCmsApi, CmsStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
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
      return objects.has(key) ? { json: async () => JSON.parse(objects.get(key)), text: async () => String(objects.get(key)) } : null;
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
      async first() { return statement.get(...params) ?? null; },
      execute() {
        if (/^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(query)) return { success: true, meta: statement.run(...params) };
        return { success: true, results: statement.all(...params) };
      },
      async all() { return this.execute(); }
    };
  };
  const env = {
    ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, PUBLIC_SITES_ORIGIN: PUBLIC_ORIGIN, PUBLIC_SITES_PREVIEW_ORIGIN: "https://preview.sites.example",
    ...(cms ? { CMS_OBJECTS, CMS_DELIVERY_MASTER_KEY: "a1".repeat(32) } : {}),
    DB: { prepare: wrap, async batch(statements) {
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
          return statement.execute();
        });
        sqlite.exec("COMMIT");
        return result;
      }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    } },
    ASSETS: { async fetch() { return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
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

testWithD1("Studio-native site uses one D1 page store for GUI, CAS, release history and public rendering", async (t) => {
  const h = await fixture(t);
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Fixture site", slug: "fixture-site", locale: "ja" }), 201);
  const { projectId, siteId } = created, api = `/api/projects/${projectId}/sites/${siteId}/editor`;
  assert.equal(created.editorPath, `/projects/${projectId}/sites/${siteId}/editor`);
  assert.equal(h.sqlite.prepare("SELECT public_origin FROM sites WHERE id = ?").get(siteId).public_origin, null);
  assert.equal(h.sqlite.prepare("SELECT slug FROM managed_sites WHERE site_id = ?").get(siteId).slug, "fixture-site");
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Duplicate", slug: "fixture-site", locale: "ja" })).status, 409);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Invalid", slug: "Bad Slug", locale: "ja" })).status, 400);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_sites").get().count, 1);

  // 作成直後は保存済み下書きだけで、公開originには何も出ない。
  assert.equal((await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/", undefined, { auth: false })).status, 404);
  assert.equal((await h.send(PUBLIC_ORIGIN, "GET", "/assets/app.js", undefined, { auth: false })).status, 404);
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
  const target = { siteId, pageId: "home", locale: "ja" };
  const plan2 = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release-plan`, { target, expectedVersion: saved.version, action: "publish" }), 200);
  const stalePlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release-plan`, { target, expectedVersion: saved.version, action: "publish" }), 200);
  const released2 = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release`, { expectedVersion: saved.version, confirmationToken: plan2.confirmationToken }), 200);
  assert.notEqual(released2.snapshot.version, saved.version);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release`, { expectedVersion: saved.version, confirmationToken: stalePlan.confirmationToken })).status, 409);
  const public2 = await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/", undefined, { auth: false });
  assert.equal(public2.status, 200);
  const html2 = await public2.text();
  assert.match(html2, /href="\/s\/fixture-site\/about"/u);
  assert.match(html2, /<link rel="canonical" href="https:\/\/sites\.example\/s\/fixture-site\/">/u);
  assert.match(html2, /<title>Fixture site<\/title>/u);
  assert.match(public2.headers.get("Content-Security-Policy"), /script-src 'none'/u);
  const head = await h.send(PUBLIC_ORIGIN, "HEAD", "/s/fixture-site/", undefined, { auth: false });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  const canonicalRedirect = await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site?utm_source=test", undefined, { auth: false });
  assert.equal(canonicalRedirect.status, 308);
  assert.equal(canonicalRedirect.headers.get("Location"), `${PUBLIC_ORIGIN}/s/fixture-site/?utm_source=test`);
  assert.equal((await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/?utm_source=test", undefined, { auth: false })).status, 200);

  // 公開済み版2から新しい版を作り、編集画面と公開URLに同じ内容を復元する。
  const current = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200), thirdDocument = structuredClone(current.document);
  thirdDocument.title = "Third version";
  thirdDocument.meta = { noindex: true };
  const saved3 = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${api}/home/draft`, { expectedVersion: current.version, document: thirdDocument }), 200);
  const plan3 = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release-plan`, { target, expectedVersion: saved3.version, action: "publish" }), 200);
  const released3 = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release`, { expectedVersion: saved3.version, confirmationToken: plan3.confirmationToken }), 200);
  const thirdHtml = await (await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/", undefined, { auth: false })).text();
  assert.match(thirdHtml, /<title>Third version<\/title>/u);
  assert.match(thirdHtml, /name="robots" content="noindex, nofollow"/u);
  assert.doesNotMatch(thirdHtml, /rel="canonical"/u);
  const rollback = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release-plan`, { target, expectedVersion: released3.snapshot.version, action: "rollback", revision: 2 }), 200);
  const restored = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release`, { expectedVersion: released3.snapshot.version, confirmationToken: rollback.confirmationToken }), 200);
  assert.deepEqual(restored.snapshot.document, { ...released2.snapshot.document, revision: 4 });
  const editorRestored = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  assert.deepEqual(editorRestored.document, restored.snapshot.document);
  assert.match(await (await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/", undefined, { auth: false })).text(), /<title>Fixture site<\/title>/u);
  assert.equal(h.sqlite.prepare("SELECT published_revision FROM managed_pages WHERE site_id = ? AND page_id = 'home'").get(siteId).published_revision, 4);

  // 同じpage-change operationで別ページを作る。公開前はpublic GETに出ない。
  const createChange = { action: "create", siteId, locale: "ja", title: "About", path: "/about" };
  const changePlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/prepare`, { change: createChange }), 200);
  const applied = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/apply`, { change: createChange, confirmationToken: changePlan.confirmationToken }), 200);
  assert.equal(applied.page.path, "/about");
  assert.equal((await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/about", undefined, { auth: false })).status, 404);

  // plan後にmembershipを失ったactorは反映できず、失敗したplanは消費しない。再参加後だけ同じplanを安全に適用できる。
  const aboutTarget = { siteId, pageId: applied.page.pageId, locale: "ja" };
  const move = { action: "update", target: aboutTarget, title: "About", path: "/about-us" };
  const movePlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/prepare`, { change: move }), 200);
  const links = [{ pageId: "home", locale: "ja", title: "Fixture site", count: 1 }];
  assert.deepEqual(movePlan.impact.linkedFrom, links);
  assert.equal(movePlan.impact.after, `${PUBLIC_ORIGIN}/s/fixture-site/about-us`);

  const visibility = { action: "visibility", target: aboutTarget, visibility: "private" };
  const visibilityPlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/prepare`, { change: visibility }), 200);
  assert.deepEqual(visibilityPlan.impact.linkedFrom, links);
  assert.equal(visibilityPlan.impact.after, undefined);
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?, 'backup-owner', 'owner', 'Backup owner', 'backup@example.test')").run(projectId);
  h.sqlite.prepare("DELETE FROM project_members WHERE project_id = ? AND access_subject = ?").run(projectId, OWNER);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/apply`, { change: visibility, confirmationToken: visibilityPlan.confirmationToken })).status, 403);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_editor_plans WHERE site_id = ? AND operation = 'page.visibility'").get(siteId).count, 1);
  h.sqlite.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?, ?, 'owner', 'Fixture owner', 'owner@example.test')").run(projectId, OWNER);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/apply`, { change: visibility, confirmationToken: visibilityPlan.confirmationToken }), 200);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_editor_plans WHERE site_id = ? AND operation = 'page.visibility'").get(siteId).count, 0);

  // 現在の membership がない利用者は同じサイトを操作できない。
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/catalog`, undefined, { token: h.otherToken })).status, 403);
});

testWithD1("Static publication serves immutable HTML and applies noindex to the verification host", async (t) => {
  const h = await fixture(t, { cms: true });
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Static fixture", slug: "static-fixture", locale: "ja" }), 201);
  const api = `/api/projects/${created.projectId}/sites/${created.siteId}/editor`;
  const draft = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  const target = { siteId: created.siteId, pageId: "home", locale: "ja" };
  const plan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release-plan`, {
    target, expectedVersion: draft.version, action: "publish"
  }), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/home/release`, {
    expectedVersion: draft.version, confirmationToken: plan.confirmationToken
  }), 200);

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

  const previewUrl = "https://preview.sites.example/s/static-fixture/";
  const preview = await publishedSiteRequest(new Request(previewUrl), h.env);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(preview.headers.get("ETag"), `"${publication.artifact_digest}"`);
  assert.equal(preview.headers.get("Content-Security-Policy"), publication.content_security_policy);
  assert.match(await preview.text(), /<title>Static fixture<\/title>/u);

  const notModified = await publishedSiteRequest(new Request(previewUrl, { headers: { "If-None-Match": `"${publication.artifact_digest}"` } }), h.env);
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const head = await publishedSiteRequest(new Request(previewUrl, { method: "HEAD" }), h.env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const publicResponse = await publishedSiteRequest(new Request("https://sites.example/s/static-fixture/"), h.env);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("X-Robots-Tag"), null);

  const create = { action: "create", siteId: created.siteId, locale: "ja", title: "About", path: "/about" };
  const createPlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/prepare`, { change: create }), 200);
  const createdPage = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/page-changes/apply`, {
    change: create, confirmationToken: createPlan.confirmationToken
  }), 200);
  const about = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/${createdPage.page.pageId}`), 200);
  const aboutTarget = { siteId: created.siteId, pageId: createdPage.page.pageId, locale: "ja" };
  const aboutPlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/${createdPage.page.pageId}/release-plan`, {
    target: aboutTarget, expectedVersion: about.version, action: "publish"
  }), 200);
  await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${api}/${createdPage.page.pageId}/release`, {
    expectedVersion: about.version, confirmationToken: aboutPlan.confirmationToken
  }), 200);
  const aboutResponse = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/about"), h.env);
  assert.equal(aboutResponse.status, 200);
  assert.equal(aboutResponse.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await aboutResponse.text(), /<title>About<\/title>/u);
  const latestState = h.sqlite.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?").get(created.siteId);
  const latest = JSON.parse(h.objects.get(latestState.manifest_key));
  assert.equal(latest.routes.length, 2);

  const unknown = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture/missing"), h.env);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const rootRedirect = await publishedSiteRequest(new Request("https://preview.sites.example/s/static-fixture"), h.env);
  assert.equal(rootRedirect.status, 307);
  assert.equal(rootRedirect.headers.get("Location"), "https://preview.sites.example/s/static-fixture/");
  assert.equal(rootRedirect.headers.get("X-Robots-Tag"), "noindex, nofollow");
  h.faults.artifact = true;
  const unavailablePage = await publishedSiteRequest(new Request(previewUrl), h.env);
  assert.equal(unavailablePage.status, 503);
  assert.equal(unavailablePage.headers.get("X-Robots-Tag"), "noindex, nofollow");
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
  const api = "/api/projects/" + site.projectId + "/sites/" + site.siteId + "/editor";
  const editing = "/api/edit/v1/sites/" + site.siteId;
  const browser = (method, path, input, options) => h.send(MANAGEMENT_ORIGIN, method, api + path, input, options);
  const cli = (method, path, input, options) => h.send(MANAGEMENT_ORIGIN, method, editing + path, input, { cli: true, ...options });
  const lookup = (path) => h.send(PUBLIC_ORIGIN, "GET", "/s/bound-articles" + path, undefined, { auth: false });
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
  const createPlan = await body(await browser("POST", "/page-changes/prepare", { change: createChange }), 200);
  const { page: detailPage } = await body(await browser("POST", "/page-changes/apply", { change: createChange, confirmationToken: createPlan.confirmationToken }), 200);
  const home = await body(await browser("GET", "/home"), 200);
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
  const listSaved = await body(await browser("PUT", "/home/draft", { expectedVersion: home.version, document: listDocument, cmsBindings }), 200);
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
  const collisionPlan = await body(await browser("POST", "/page-changes/prepare", { change: collisionChange }), 200);
  const { page: collisionPage } = await body(await browser("POST", "/page-changes/apply", { change: collisionChange, confirmationToken: collisionPlan.confirmationToken }), 200);
  assert.equal((await browser("POST", detailPath + "/release-plan", {
    target: { siteId: site.siteId, pageId: detailPage.pageId, locale: "ja" }, expectedVersion: detailSaved.version, action: "publish"
  })).status, 422, "detail paths must not override fixed page reservations");
  const moveCollision = { action: "update", target: { siteId: site.siteId, pageId: collisionPage.pageId, locale: "ja" }, title: "Static collision", path: "/articles/article-7-static" };
  const moveCollisionPlan = await body(await browser("POST", "/page-changes/prepare", { change: moveCollision }), 200);
  await body(await browser("POST", "/page-changes/apply", { change: moveCollision, confirmationToken: moveCollisionPlan.confirmationToken }), 200);

  const staleRoutePlan = await body(await browser("POST", detailPath + "/release-plan", {
    target: { siteId: site.siteId, pageId: detailPage.pageId, locale: "ja" }, expectedVersion: detailSaved.version, action: "publish"
  }), 200);
  const collideAgain = { ...moveCollision, path: "/articles/article-7" };
  const collideAgainPlan = await body(await browser("POST", "/page-changes/prepare", { change: collideAgain }), 200);
  await body(await browser("POST", "/page-changes/apply", { change: collideAgain, confirmationToken: collideAgainPlan.confirmationToken }), 200);
  assert.equal((await browser("POST", detailPath + "/release", {
    expectedVersion: detailSaved.version, confirmationToken: staleRoutePlan.confirmationToken
  })).status, 409, "a detail release plan must conflict if its reserved routes changed");
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE site_id = ? AND page_id = ?")
    .get(site.siteId, detailPage.pageId).count, 0);
  const clearCollisionPlan = await body(await browser("POST", "/page-changes/prepare", { change: moveCollision }), 200);
  await body(await browser("POST", "/page-changes/apply", { change: moveCollision, confirmationToken: clearCollisionPlan.confirmationToken }), 200);

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
    const release = await body(await browser("POST", "/" + pageId + "/release-plan", {
      target: { siteId: site.siteId, pageId, locale: "ja" }, expectedVersion, action: "publish"
    }), 200);
    return body(await browser("POST", "/" + pageId + "/release", { expectedVersion, confirmationToken: release.confirmationToken }), 200);
  };
  await publish(detailPage.pageId, detailSaved.version);
  await publish("home", applied.version);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM managed_page_publications WHERE cms_release_id = ? AND cms_schema_revision = ?").get(cmsRelease.releaseId, schemaRevision).count, 2);
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
  const rollback = await body(await browser("POST", "/home/release-plan", {
    target: { siteId: site.siteId, pageId: "home", locale: "ja" }, expectedVersion: unbound.version, action: "rollback", revision: applied.revision
  }), 200);
  const restored = await body(await browser("POST", "/home/release", { expectedVersion: unbound.version, confirmationToken: rollback.confirmationToken }), 200);
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
  const { plan } = await body(await site.cli("POST", `cms.publish-plan/posts/${legacyDraft.id}`, {
    operationId: crypto.randomUUID(), expectedVersion: legacySave.item.version
  }, service), 200);
  const { operationId, confirmationToken, expectedVersion } = plan;
  const applied = await body(await site.cli("POST", `cms.publish/posts/${legacyDraft.id}`, { operationId, confirmationToken, expectedVersion }, service), 200);
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
