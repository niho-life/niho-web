import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
  entryPoints: [fileURLToPath(new URL("../studio/worker.ts", import.meta.url))], bundle: true, format: "esm", platform: "node", target: "node22", write: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(`${process.cwd()}/studio-worker-test.mjs`);' }
});
const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`)).default;
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
      return objects.has(key) ? { json: async () => JSON.parse(objects.get(key)) } : null;
    }
  };
  t.after(() => sqlite.close());
  if (!restore) for (const migration of migrations) sqlite.exec(migration);
  const wrap = (query) => {
    const statement = sqlite.prepare(query);
    let params = [];
    return {
      query,
      bind(...values) { params = values; return this; },
      async first() { return statement.get(...params) ?? null; },
      execute() {
        if (/^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(query)) return { success: true, meta: statement.run(...params) };
        return { success: true, results: statement.all(...params) };
      },
      async all() { return this.execute(); }
    };
  };
  const env = {
    ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, PUBLIC_SITES_ORIGIN: PUBLIC_ORIGIN, ...(cms ? { CMS_OBJECTS } : {}),
    DB: { prepare: wrap, async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((statement, index) => {
          if (index === 1 && faults.batch && statements[0].query.includes("INSERT INTO managed_cms_receipts")) {
            delete faults.batch;
            throw new Error("fixture aborted transaction");
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
  return { sqlite, env, ownerToken, otherToken, serviceToken, send, objects, faults, cron: () => worker.scheduled({}, env) };
}

async function body(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

testWithD1("Studio-native site uses one D1 page store for GUI, CLI, CAS, release history and public rendering", async (t) => {
  const h = await fixture(t);
  const created = await body(await h.send(MANAGEMENT_ORIGIN, "POST", "/api/projects", { title: "Fixture site", slug: "fixture-site", locale: "ja" }), 201);
  const { projectId, siteId } = created, api = `/api/projects/${projectId}/sites/${siteId}/editor`, cli = `/api/cli/v1/projects/${projectId}/sites/${siteId}`;
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

  // operatorが既に付与したservice grantもmanaged操作へ接続し、grant外の操作はadvertiseしない。
  const addGrant = h.sqlite.prepare(`INSERT INTO studio_cli_grants
    (client_id, project_id, site_id, capability, delegated_by_subject, expires_at) VALUES (?, ?, ?, ?, ?, unixepoch() + 600)`);
  for (const capability of ["pages.read", "pages.edit", "pages.publish"]) addGrant.run(SERVICE_CLIENT, projectId, siteId, capability, OWNER);
  const serviceDiscovery = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${cli}/capabilities`, undefined, { cli: true, service: true, token: h.serviceToken }), 200);
  assert.deepEqual(serviceDiscovery.operations.map(({ id }) => id), ["pages.catalog", "pages.read", "pages.save", "pages.release-plan", "pages.release", "pages.change-prepare", "pages.change-apply"]);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${cli}/operations/pages.read/home`, undefined, { cli: true, service: true, token: h.serviceToken })).status, 200);

  // GUI保存と同じoperationをCLI user tokenでも使う。cookie由来のhuman assertionだけではCLIを許可しない。
  const discovery = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${cli}/capabilities`, undefined, { cli: true }), 200);
  assert.deepEqual(discovery.operations.map(({ id }) => id), ["pages.catalog", "pages.read", "pages.save", "pages.release-plan", "pages.release", "pages.change-prepare", "pages.change-apply"]);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${cli}/capabilities`, undefined, { headers: { "Cf-Access-Jwt-Assertion": h.ownerToken }, auth: false })).status, 401);
  const edited = structuredClone(first.document);
  edited.body[0].children.push({ type: "element", id: "link", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "About" }] });
  const saved = await body(await h.send(MANAGEMENT_ORIGIN, "PUT", `${cli}/operations/pages.save/home`, { expectedVersion: first.version, document: edited }, { cli: true }), 200);
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
  const restored = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${cli}/operations/pages.release/home`, { expectedVersion: released3.snapshot.version, confirmationToken: rollback.confirmationToken }, { cli: true }), 200);
  assert.deepEqual(restored.snapshot.document, { ...released2.snapshot.document, revision: 4 });
  const editorRestored = await body(await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/home`), 200);
  assert.deepEqual(editorRestored.document, restored.snapshot.document);
  assert.match(await (await h.send(PUBLIC_ORIGIN, "GET", "/s/fixture-site/", undefined, { auth: false })).text(), /<title>Fixture site<\/title>/u);
  assert.equal(h.sqlite.prepare("SELECT published_revision FROM managed_pages WHERE site_id = ? AND page_id = 'home'").get(siteId).published_revision, 4);

  // 同じpage-change operationで別ページを作る。公開前はpublic GETに出ない。
  const createChange = { action: "create", siteId, locale: "ja", title: "About", path: "/about" };
  const changePlan = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${cli}/operations/pages.change-prepare`, { change: createChange }, { cli: true }), 200);
  const applied = await body(await h.send(MANAGEMENT_ORIGIN, "POST", `${cli}/operations/pages.change-apply`, { change: createChange, confirmationToken: changePlan.confirmationToken }, { cli: true }), 200);
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

  // 現在のmembershipがないhuman tokenはGUI/CLIどちらからも同じsiteを操作できない。
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${api}/catalog`, undefined, { token: h.otherToken })).status, 403);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "GET", `${cli}/capabilities`, undefined, { token: h.otherToken, cli: true })).status, 403);
  const audit = h.sqlite.prepare("SELECT operation, actor_subject FROM studio_cli_audit ORDER BY started_at, rowid").all();
  assert.ok(audit.some((entry) => entry.operation === "pages.save" && entry.actor_subject === OWNER));
  assert.ok(audit.some((entry) => entry.operation === "pages.change-apply" && entry.actor_subject === OWNER));
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
    items.push((await site.read("cms.items.save", { ...versioned(item), values: { ...values(number === 7 ? "Article <Seven>" : "Article " + number, "article-" + number),
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
  assert.deepEqual([...html.matchAll(/href="\/s\/bound-articles\/articles\/article-(\d)"/gu)].map((match) => match[1]), ["7", "6", "5", "4", "3", "2"]);
  assert.match(html, /aria-label="Article &lt;Seven&gt;"/u);
  const detailHtml = await (await lookup("/articles/article-7")).text();
  assert.match(detailHtml, /Article &lt;Seven&gt;/u);
  assert.match(detailHtml, /&lt;script&gt;Fixture only&lt;\/script&gt;/u);
  assert.equal((await lookup("/articles/unknown")).status, 404);
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
  assert.deepEqual([...restoredHtml.matchAll(/href="\/s\/bound-articles\/articles\/article-(\d)"/gu)].map((match) => match[1]), ["7", "6", "5", "4", "3", "2"]);
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
  const cliRoot = `/api/cli/v1/projects/${site.projectId}/sites/${site.siteId}`;
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${cliRoot}/operations/cms.items.read`,
    { siteId: site.siteId, collectionId: "posts", itemId: legacyDraft.id }, { cli: true, ...service })).status, 403);
  assert.equal((await h.send(MANAGEMENT_ORIGIN, "POST", `${cliRoot}/operations/cms.items.read`,
    { siteId: site.siteId, collectionId: "posts", itemId: legacyDraft.id }, { cli: true })).status, 200);

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
