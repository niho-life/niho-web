import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

async function fixture(t) {
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
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const migration of migrations) sqlite.exec(migration);
  const wrap = (query) => {
    const statement = sqlite.prepare(query);
    let params = [];
    return {
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
    ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, PUBLIC_SITES_ORIGIN: PUBLIC_ORIGIN,
    DB: { prepare: wrap, async batch(statements) {
      sqlite.exec("BEGIN");
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return result; }
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
  return { sqlite, env, ownerToken, otherToken, serviceToken, send };
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
