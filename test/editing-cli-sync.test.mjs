import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EDITING_OPERATIONS } from "@niho/web/editing-api";
import { canonicalJson } from "../cli/niho-edit-sync.mjs";
import { schema, seed } from "./collection-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../cli/niho-edit.mjs", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const origin = "https://studio.example", siteId = fixture.siteId, locale = fixture.locale;
const HOME = `pages/${locale}/home.json`, ABOUT = `pages/${locale}/about.json`, EN_HOME = "pages/en/home.json";
const POST_2 = "cms/posts/p2.json";

/* A stateful stand-in for Studio. It runs inside the CLI process (preloaded) and keeps its state in a file, so
 * the state survives from one CLI run to the next and the test can change it between runs like another editor. */
function installFakeStudio(statePath, logPath, site) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const match = new RegExp(`^/api/edit/(?:v1|v2)/sites/${site}/(capabilities|operations/(.+))$`, "u").exec(u.pathname);
    if (!match) throw new Error(`unexpected URL ${u.pathname}`);
    const operation = match[2] ?? "capabilities", method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    appendFileSync(logPath, `${JSON.stringify({ method, operation, query: u.search, body })}\n`);
    const done = (response) => { writeFileSync(statePath, JSON.stringify(state)); return response; };
    const next = (prefix) => `${prefix}${++state.counter}`;
    const [name, first, second] = operation.split("/");
    if (operation === "capabilities") return done(json({ apiVersion: "v1", siteId: site, operations: state.operations }));
    if (name === "pages.catalog") {
      return done(json({ version: "catalog-1", pages: Object.values(state.pages).map((page) => ({ siteId: site, pageId: page.document.pageId, locale: page.document.locale,
        title: page.document.title, path: page.path, kind: "page", visibility: "public", published: true })) }));
    }
    if (name === "pages.read" || name === "pages.save") {
      const key = `${u.searchParams.get("locale")}/${first}`, page = state.pages[key];
      if (!page) return done(json({ error: "not_found" }, 404));
      if (name === "pages.read") return done(json({ document: page.document, version: page.version }));
      if (body.expectedVersion !== page.version) return done(json({ error: "version_conflict" }, 409));
      page.document = { ...body.document, revision: body.document.revision + 1 };
      page.version = next("page-v");
      return done(json({ status: "saved", version: page.version, document: page.document }));
    }
    if (name === "cms.schema") return done(json({ collections: state.collections }));
    if (name === "cms.list") {
      return done(json({ collectionId: first, items: Object.values(state.items[first] ?? {}).map(({ version, values, ...summary }) => summary) }));
    }
    if (name === "cms.read") return done(json({ item: state.items[first][second] }));
    if (name === "cms.save") {
      const item = state.items[first][second];
      if (state.operations_seen[body.operationId]) return done(json({ status: "saved", item }));
      if (body.expectedVersion !== item.version) return done(json({ error: "version_conflict", current: item }, 409));
      item.values = body.values;
      item.version = next("item-v");
      state.operations_seen[body.operationId] = true;
      if (state.faults.dropNextCmsSave) {
        state.faults.dropNextCmsSave = false;
        done(null);
        throw new TypeError("fetch failed");
      }
      return done(json({ status: "saved", item }));
    }
    if (name === "site.seo.read") return done(json({ settings: state.seo, version: state.policyVersion }));
    if (name === "site.seo.save") {
      if (body.expectedVersion !== state.policyVersion) return done(json({ error: "conflict" }, 409));
      state.seo = body.settings;
      state.policyVersion = next("policy-v");
      return done(json({ settings: state.seo, version: state.policyVersion }));
    }
    if (name === "site.redirects.read") return done(json({ redirects: state.redirects, version: state.redirectVersion }));
    if (name === "site.redirects.save") {
      if (body.expectedVersion !== state.redirectVersion) return done(json({ error: "conflict" }, 409));
      state.redirects = body.redirects;
      state.redirectVersion = next("redirect-v");
      return done(json({ redirects: state.redirects, version: state.redirectVersion }));
    }
    const publicSettings = () => ({ domain: { ...state.domain, version: state.domainVersion }, origins: { ...state.origins, version: state.policyVersion } });
    if (name === "site.public.read") return done(json(publicSettings()));
    if (name === "site.public.save") {
      if (body.domain && body.domain.version !== state.domainVersion) return done(json({ error: "conflict", part: "domain" }, 409));
      if (body.origins && body.origins.version !== state.policyVersion) return done(json({ error: "conflict", part: "origins" }, 409));
      if (body.domain) { state.domain = { hostname: body.domain.hostname, noindex: body.domain.noindex }; state.domainVersion = next("domain-v"); }
      if (body.origins) {
        state.origins = { frameOrigins: body.origins.frameOrigins, resourceOrigins: body.origins.resourceOrigins };
        state.policyVersion = next("policy-v");
      }
      return done(json(publicSettings()));
    }
    if (name === "site.styles.read") {
      return done(json({ draft: { version: state.styles.version, styles: state.styles.styles }, published: { version: "published-1", styles: {} } }));
    }
    if (name === "site.styles.edit") {
      if (body.expectedVersion !== state.styles.version) return done(json({ error: "version_conflict" }, 409));
      const tokens = { ...state.styles.styles.tokens };
      for (const edit of body.edits) {
        if (edit.type === "delete" && state.usedTokens.includes(edit.name)) return done(json({ status: "referenced", usages: [{ kind: "page", id: "home", locale: "ja-JP" }] }));
        if (edit.type === "delete") delete tokens[edit.name];
        else tokens[edit.name] = edit.value;
      }
      state.styles = { version: next("styles-v"), styles: { tokens } };
      return done(json({ status: "saved", version: state.styles.version, styles: state.styles.styles }));
    }
    if (name === "site.breakpoints.read") return done(json({ settings: { base: { name: "PC", previewWidth: 1360 }, breakpoints: [] }, version: "breakpoints-1" }));
    throw new Error(`unexpected operation ${operation}`);
  };
}

function initialServer() {
  const page = (pageId, pageLocale, title, path) => ({ version: `${pageId}-${pageLocale}-v0`, path,
    document: { ...structuredClone(fixture), pageId, locale: pageLocale, title } });
  const content = seed();
  return {
    counter: 0, faults: {}, operations_seen: {}, usedTokens: ["brand"],
    operations: EDITING_OPERATIONS.filter(({ id }) => id.startsWith("site.styles.")),
    pages: { [`${locale}/home`]: page("home", locale, fixture.title, "/"), [`${locale}/about`]: page("about", locale, "About", "/about"), "en/home": page("home", "en", "Home", "/en") },
    collections: schema().collections,
    items: Object.fromEntries(Object.entries(content).map(([id, items]) => [id, Object.fromEntries(items)])),
    seo: { siteName: "Example", description: "Description", defaultOgImage: "/og.png", verificationTags: [], organization: null, robotsPolicy: "index", ga4MeasurementId: null },
    redirects: [{ locale: "ja", fromPath: "/old", toPath: "/about" }], redirectVersion: "redirect-v0",
    domain: { hostname: null, noindex: false }, domainVersion: "domain-v0",
    origins: { frameOrigins: [], resourceOrigins: [] }, policyVersion: "policy-v0",
    styles: { version: "styles-v0", styles: { tokens: { brand: { type: "color", value: "#195640" } } } }
  };
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "niho-edit-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "server.json"), logPath = join(root, "requests.jsonl"), preload = join(root, "preload.mjs");
  writeFileSync(statePath, JSON.stringify(initialServer()));
  writeFileSync(logPath, "");
  writeFileSync(preload, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";\n(${installFakeStudio.toString()})(${JSON.stringify(statePath)}, ${JSON.stringify(logPath)}, ${JSON.stringify(siteId)});\n`);
  const site = join(root, "site");
  const workspaceApi = {
    root, site,
    path: (relative) => join(site, ...relative.split("/")),
    async run(args, { studio = true, token = "fixture-token" } = {}) {
      return new Promise((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].includes(key)));
        env.NIHO_EDIT_TOKEN = token;
        const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cliPath, ...(studio ? ["--studio"] : []), "--origin", origin, "--site", siteId, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (exitCode) => {
          let result = null;
          try { result = JSON.parse(stdout).result; } catch { /* some failures print nothing parseable */ }
          resolve({ exitCode, stdout, stderr, result });
        });
      });
    },
    server: () => JSON.parse(readFileSync(statePath, "utf8")),
    changeServer(change) { const state = JSON.parse(readFileSync(statePath, "utf8")); change(state); writeFileSync(statePath, JSON.stringify(state)); },
    requests: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    clearRequests: () => writeFileSync(logPath, ""),
    readJson: async (relative) => JSON.parse(await readFile(workspaceApi.path(relative), "utf8")),
    writeJson: (relative, value, indent = 2) => writeFile(workspaceApi.path(relative), `${JSON.stringify(value, null, indent)}\n`),
    state: () => workspaceApi.readJson(".niho/state.json")
  };
  return workspaceApi;
}
async function pulled(t) {
  const ws = await workspace(t);
  const pull = await ws.run(["pull", ws.site]);
  assert.equal(pull.exitCode, 0, pull.stdout + pull.stderr);
  ws.clearRequests();
  return ws;
}

test("pull writes every resource and the state, and refuses a directory it does not own", async (t) => {
  const ws = await workspace(t);
  const pull = await ws.run(["pull", ws.site]);
  assert.equal(pull.exitCode, 0, pull.stdout + pull.stderr);
  const cmsFiles = Object.values(ws.server().items).reduce((sum, items) => sum + Object.keys(items).length, 0);
  assert.equal(pull.result.counts.written, 3 + cmsFiles + 4);
  assert.deepEqual(pull.result.conflicts, []);

  const homeText = await readFile(ws.path(HOME), "utf8");
  assert.equal(homeText, canonicalJson(fixture));
  assert.ok(homeText.startsWith('{\n  "body": ['), "keys are sorted and indented by 2 spaces");
  assert.deepEqual(await ws.readJson("site/seo.json"), ws.server().seo);
  assert.deepEqual(await ws.readJson("site/redirects.json"), ws.server().redirects);
  assert.deepEqual(await ws.readJson("site/public.json"), { domain: { hostname: null, noindex: false }, origins: { frameOrigins: [], resourceOrigins: [] } });
  assert.deepEqual(await ws.readJson("site/styles.json"), ws.server().styles.styles);
  assert.deepEqual(await ws.readJson(POST_2), ws.server().items.posts.p2.values);
  assert.equal(JSON.stringify(await ws.readJson("site/seo.json")).includes("version"), false, "versions stay out of the edited files");

  const state = await ws.state();
  assert.equal(state.formatVersion, 1);
  assert.equal(state.origin, origin);
  assert.equal(state.siteId, siteId);
  assert.deepEqual(state.files[HOME], { kind: "page", pageId: "home", locale, version: "home-ja-JP-v0", hash: state.files[HOME].hash });
  assert.equal(state.files["site/seo.json"].version, "policy-v0");
  assert.equal(state.files["site/public.json"].versions.origins, "policy-v0");
  assert.equal(state.files[POST_2].version, ws.server().items.posts.p2.version);
  const context = await ws.readJson(".niho/context.json");
  assert.ok(context.publicPaths.includes("/about"));

  // Pulling again changes nothing.
  const again = await ws.run(["pull", ws.site]);
  assert.equal(again.exitCode, 0);
  assert.equal(again.result.counts.written, 0);

  const occupied = join(ws.root, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "notes.txt"), "mine");
  const refused = await ws.run(["pull", occupied]);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.result.error, "sync_dir_not_empty");

  const otherState = { ...state, siteId: "other" };
  await ws.writeJson(".niho/state.json", otherState);
  const other = await ws.run(["pull", ws.site]);
  assert.equal(other.result.error, "sync_dir_other_site");
  await ws.writeJson(".niho/state.json", { ...state, files: { "../../outside.json": state.files[HOME] } });
  assert.equal((await ws.run(["pull", ws.site])).result.error, "sync_state_invalid");
});

test("the three commands require --studio", async (t) => {
  const ws = await workspace(t);
  for (const command of ["pull", "check", "push"]) {
    const result = await ws.run([command, ws.site], { studio: false });
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.error, "invalid_arguments");
  }
  assert.deepEqual(ws.requests(), []);
});

test("push saves only the changed page, writes the server result back, and ignores formatting-only edits", async (t) => {
  const ws = await pulled(t);
  const home = await ws.readJson(HOME);
  home.title = "新しいタイトル";
  await ws.writeJson(HOME, home);
  await ws.writeJson(ABOUT, await ws.readJson(ABOUT), 4);   // same content, other indent

  const push = await ws.run(["push", ws.site]);
  assert.equal(push.exitCode, 0, push.stdout + push.stderr);
  assert.deepEqual(push.result.saved, [HOME]);
  assert.deepEqual(push.result.conflicts, []);
  const saves = ws.requests().filter(({ operation }) => operation.startsWith("pages.save"));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].method, "PUT");
  assert.equal(saves[0].body.expectedVersion, "home-ja-JP-v0");
  assert.equal(saves[0].body.document.title, "新しいタイトル");

  const saved = ws.server().pages[`${locale}/home`];
  assert.equal(saved.document.revision, fixture.revision + 1);
  assert.equal(await readFile(ws.path(HOME), "utf8"), canonicalJson(saved.document), "the file now holds the saved document");
  const state = await ws.state();
  assert.equal(state.files[HOME].version, saved.version);
  assert.equal(state.files[ABOUT].version, "about-ja-JP-v0");

  ws.clearRequests();
  const second = await ws.run(["push", ws.site]);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.result.saved, []);
  assert.deepEqual(ws.requests(), []);
});

test("push reports a conflicting file without writing it and keeps saving the others", async (t) => {
  const ws = await pulled(t);
  const home = await ws.readJson(HOME), about = await ws.readJson(ABOUT);
  home.title = "自分の変更 home";
  about.title = "自分の変更 about";
  await ws.writeJson(HOME, home);
  await ws.writeJson(ABOUT, about);
  ws.changeServer((server) => {
    const page = server.pages[`${locale}/about`];
    page.document.title = "他の人の変更";
    page.version = "about-other-v1";
  });
  const localAbout = await readFile(ws.path(ABOUT), "utf8");

  const push = await ws.run(["push", ws.site]);
  assert.equal(push.exitCode, 1);
  assert.deepEqual(push.result.saved, [HOME]);
  assert.deepEqual(push.result.conflicts.map(({ path, reason }) => ({ path, reason })), [{ path: ABOUT, reason: "version_conflict" }]);
  assert.match(push.result.hint, /pull し直/u);
  assert.equal(await readFile(ws.path(ABOUT), "utf8"), localAbout, "the conflicting file is left as it was");
  assert.equal(ws.server().pages[`${locale}/about`].document.title, "他の人の変更", "the other editor's change is not overwritten");
  assert.equal(ws.server().pages[`${locale}/home`].document.title, "自分の変更 home");
  assert.equal((await ws.state()).files[ABOUT].version, "about-ja-JP-v0");
});

test("pull keeps local edits, reports a conflict when both sides changed, and takes unrelated server changes", async (t) => {
  const ws = await pulled(t);
  const about = await ws.readJson(ABOUT), enHome = await ws.readJson(EN_HOME);
  about.title = "ローカルの About";
  enHome.title = "Local home";
  await ws.writeJson(ABOUT, about);
  await ws.writeJson(EN_HOME, enHome);
  ws.changeServer((server) => {
    server.pages[`${locale}/about`].document.title = "サーバーの About";
    server.pages[`${locale}/about`].version = "about-server-v1";
    server.pages[`${locale}/home`].document.title = "サーバーの Home";
    server.pages[`${locale}/home`].version = "home-server-v1";
  });
  const localAbout = await readFile(ws.path(ABOUT), "utf8");

  const pull = await ws.run(["pull", ws.site]);
  assert.equal(pull.exitCode, 1);
  assert.deepEqual(pull.result.conflicts, [{ path: ABOUT, reason: "server_changed" }]);
  assert.deepEqual(pull.result.kept, [EN_HOME]);
  assert.deepEqual(pull.result.written, [HOME]);
  assert.match(pull.result.hint, /消してから pull し直/u);
  assert.equal(await readFile(ws.path(ABOUT), "utf8"), localAbout);
  assert.equal((await ws.readJson(HOME)).title, "サーバーの Home");
  assert.equal((await ws.readJson(EN_HOME)).title, "Local home");
  assert.equal((await ws.state()).files[ABOUT].version, "about-ja-JP-v0", "the base of the conflicting file does not move");

  // Dropping the local change and pulling again takes the server's file.
  await rm(ws.path(ABOUT));
  const retry = await ws.run(["pull", ws.site]);
  assert.equal(retry.exitCode, 0, retry.stdout);
  assert.equal((await ws.readJson(ABOUT)).title, "サーバーの About");
});

test("push skips new and deleted files instead of creating or deleting them", async (t) => {
  const ws = await pulled(t);
  await ws.writeJson(`pages/${locale}/fresh.json`, { ...fixture, pageId: "fresh" });
  await ws.writeJson("cms/posts/brand-new.json", { title: "新しい" });
  await rm(ws.path(ABOUT));
  const push = await ws.run(["push", ws.site]);
  assert.equal(push.exitCode, 0, push.stdout);
  assert.deepEqual(push.result.saved, []);
  assert.deepEqual(push.result.skipped.map(({ path, reason }) => ({ path, reason })), [
    { path: "cms/posts/brand-new.json", reason: "new-file" },
    { path: ABOUT, reason: "deleted-locally" },
    { path: `pages/${locale}/fresh.json`, reason: "new-file" }
  ]);
  assert.match(push.result.skipped.find(({ path }) => path.endsWith("fresh.json")).hint, /page-change/u);
  assert.match(push.result.skipped.find(({ path }) => path.endsWith("brand-new.json")).hint, /cms-create/u);
  assert.deepEqual(ws.requests(), []);
});

test("a CMS push retried after a lost response reuses the operation ID", async (t) => {
  const ws = await pulled(t);
  const values = await ws.readJson(POST_2);
  values.summary = "更新した説明";
  await ws.writeJson(POST_2, values);
  ws.changeServer((server) => { server.faults.dropNextCmsSave = true; });

  const first = await ws.run(["push", ws.site]);
  assert.equal(first.exitCode, 1);
  assert.deepEqual(first.result.invalid.map(({ path, reason }) => ({ path, reason })), [{ path: POST_2, reason: "transport_error" }]);
  const pending = (await ws.state()).files[POST_2].pendingOperationId;
  assert.match(pending, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  const second = await ws.run(["push", ws.site]);
  assert.equal(second.exitCode, 0, second.stdout);
  assert.deepEqual(second.result.saved, [POST_2]);
  const saves = ws.requests().filter(({ operation }) => operation.startsWith("cms.save"));
  assert.equal(saves.length, 2);
  assert.equal(saves[0].body.operationId, pending);
  assert.equal(saves[1].body.operationId, pending);
  assert.equal(saves[1].body.expectedVersion, saves[0].body.expectedVersion);
  const entry = (await ws.state()).files[POST_2];
  assert.equal(entry.pendingOperationId, undefined);
  assert.equal(entry.version, ws.server().items.posts.p2.version);
  assert.equal(ws.server().items.posts.p2.values.summary, "更新した説明");
});

test("push saves seo first and gives the shared version to the origins that follow", async (t) => {
  const ws = await pulled(t);
  const seo = await ws.readJson("site/seo.json"), settings = await ws.readJson("site/public.json");
  seo.description = "新しい説明";
  settings.origins.frameOrigins = ["https://frame.example"];
  await ws.writeJson("site/seo.json", seo);
  await ws.writeJson("site/public.json", settings);

  const push = await ws.run(["push", ws.site]);
  assert.equal(push.exitCode, 0, push.stdout);
  assert.deepEqual(push.result.saved, ["site/seo.json", "site/public.json"]);
  const saves = ws.requests().filter(({ operation }) => operation.startsWith("site.") && operation.endsWith(".save"));
  assert.deepEqual(saves.map(({ operation }) => operation), ["site.seo.save", "site.public.save"]);
  assert.equal(saves[0].body.expectedVersion, "policy-v0");
  assert.deepEqual(Object.keys(saves[1].body), ["origins"], "only the part that changed is sent");
  assert.equal(saves[1].body.origins.version, "policy-v1", "the origins use the version the SEO save returned");
  assert.deepEqual(saves[1].body.origins.frameOrigins, ["https://frame.example"]);
  const server = ws.server();
  assert.equal(server.seo.description, "新しい説明");
  assert.deepEqual(server.origins.frameOrigins, ["https://frame.example"]);
  const state = await ws.state();
  assert.equal(state.files["site/seo.json"].version, server.policyVersion);
  assert.equal(state.files["site/public.json"].versions.origins, server.policyVersion);

  // The domain part alone is sent with its own version.
  settings.domain = { hostname: "www.example.test", noindex: true };
  await ws.writeJson("site/public.json", settings);
  ws.clearRequests();
  const domain = await ws.run(["push", ws.site]);
  assert.equal(domain.exitCode, 0, domain.stdout);
  const body = ws.requests().find(({ operation }) => operation === "site.public.save").body;
  assert.deepEqual(Object.keys(body), ["domain"]);
  assert.equal(body.domain.version, "domain-v0");

  // A conflicting SEO change is reported and the base does not move.
  seo.description = "また変える";
  await ws.writeJson("site/seo.json", seo);
  ws.changeServer((changed) => { changed.policyVersion = "policy-other"; });
  const conflict = await ws.run(["push", ws.site]);
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(conflict.result.conflicts.map(({ path }) => path), ["site/seo.json"]);
});

test("push turns style changes into edits and reports a version conflict or a referenced delete", async (t) => {
  const ws = await pulled(t);
  const styles = await ws.readJson("site/styles.json");
  styles.tokens.brand = { type: "color", value: "#000000" };
  styles.tokens.accent = { type: "color", value: "#ff0000" };
  await ws.writeJson("site/styles.json", styles);

  const push = await ws.run(["push", ws.site]);
  assert.equal(push.exitCode, 0, push.stdout);
  assert.deepEqual(push.result.saved, ["site/styles.json"]);
  const edit = ws.requests().find(({ operation }) => operation === "site.styles.edit");
  assert.equal(edit.body.expectedVersion, "styles-v0");
  assert.deepEqual([...edit.body.edits].sort((a, b) => a.name.localeCompare(b.name)), [
    { type: "set", styleKind: "token", name: "accent", value: { type: "color", value: "#ff0000" } },
    { type: "set", styleKind: "token", name: "brand", value: { type: "color", value: "#000000" } }
  ]);
  assert.equal((await ws.state()).files["site/styles.json"].version, ws.server().styles.version);

  const used = await ws.readJson("site/styles.json");
  delete used.tokens.brand;
  await ws.writeJson("site/styles.json", used);
  const referenced = await ws.run(["push", ws.site]);
  assert.equal(referenced.exitCode, 1);
  assert.equal(referenced.result.invalid[0].reason, "referenced");
  assert.deepEqual(referenced.result.invalid[0].usages, [{ kind: "page", id: "home", locale: "ja-JP" }]);

  ws.changeServer((server) => { server.styles = { version: "styles-other", styles: { tokens: { brand: { type: "color", value: "#123456" } } } }; });
  ws.clearRequests();
  const conflict = await ws.run(["push", ws.site]);
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(conflict.result.conflicts.map(({ path }) => path), ["site/styles.json"]);
  assert.equal(ws.requests().some(({ operation }) => operation === "site.styles.edit"), false);
});

test("check validates locally, warns about large pages, and renders reference HTML", async (t) => {
  const ws = await pulled(t);
  const about = await ws.readJson(ABOUT);
  delete about.body;
  await ws.writeJson(ABOUT, about);
  const home = await ws.readJson(HOME);
  home.body[0].children.push(
    { type: "element", id: "dead", tag: "a", attrs: { href: "/no-such-page" }, children: [{ type: "text", text: "リンク" }] },
    { type: "component", id: "booking", block: "booking-panel", props: { title: "予約" } },
    { type: "element", id: "padding", tag: "p", children: [{ type: "text", text: "あ".repeat(70_000) }] }
  );
  await ws.writeJson(HOME, home);
  const seo = await ws.readJson("site/seo.json");
  seo.robotsPolicy = "everything";
  await ws.writeJson("site/seo.json", seo);

  const output = join(ws.root, "html");
  const check = await ws.run(["check", ws.site, "--html", output]);
  assert.equal(check.exitCode, 1, check.stdout + check.stderr);
  assert.deepEqual(ws.requests(), [], "check never talks to the server");
  const files = Object.fromEntries(check.result.files.map((entry) => [entry.file, entry]));
  assert.deepEqual(files[ABOUT].errors.map(({ code }) => code), ["invalid_document"]);
  assert.deepEqual(files["site/seo.json"].errors.map(({ code }) => code), ["invalid_seo"]);
  assert.ok(files[HOME].warnings.some(({ code }) => code === "page_too_large"));
  assert.ok(files[HOME].warnings.some(({ code }) => code === "broken-internal-link"), "the HTML SEO check runs on the rendered page");
  assert.equal(files[HOME].errors.length, 0);
  const rendered = await readFile(join(output, locale, "home.html"), "utf8");
  assert.match(rendered, /data-nw-block="booking-panel"/u);
  assert.match(rendered, /<h1/u);
  assert.equal(check.result.html.length, 1);
  await assert.rejects(readFile(join(output, locale, "about.html")), "a page with errors is not rendered");

  // Only changed files are checked unless --all is given.
  await ws.writeJson(ABOUT, { ...fixture, pageId: "about" });
  await ws.writeJson("site/seo.json", ws.server().seo);
  await ws.writeJson(HOME, fixture);
  const clean = await ws.run(["check", ws.site]);
  assert.equal(clean.exitCode, 0, clean.stdout);
  assert.equal(clean.result.checked, 1);
  const all = await ws.run(["check", ws.site, "--all"]);
  assert.equal(all.result.checked, Object.keys((await ws.state()).files).length);
});

test("check reports a wrong identity and a page that cannot be rendered without failing", async (t) => {
  const ws = await pulled(t);
  const about = await ws.readJson(ABOUT);
  about.pageId = "home";
  await ws.writeJson(ABOUT, about);
  const home = await ws.readJson(HOME);
  home.body.push({ type: "instance", id: "shared", component: "missing-component" });
  await ws.writeJson(HOME, home);
  const output = join(ws.root, "html");
  const check = await ws.run(["check", ws.site, "--html", output]);
  const files = Object.fromEntries(check.result.files.map((entry) => [entry.file, entry]));
  assert.deepEqual(files[ABOUT].errors.map(({ code }) => code), ["identity_mismatch"]);
  assert.deepEqual(files[HOME].errors, []);
  assert.ok(files[HOME].warnings.some(({ code }) => code === "html_render_unavailable"));
  assert.equal(check.exitCode, 1);

  // Push does not send a file that fails the same check.
  const push = await ws.run(["push", ws.site]);
  assert.equal(push.exitCode, 1);
  assert.deepEqual(push.result.invalid.map(({ path, reason }) => ({ path, reason })), [{ path: ABOUT, reason: "check_failed" }]);
  assert.equal(ws.requests().some(({ operation }) => operation.startsWith("pages.save")), true, "the valid page is still saved");
  assert.equal(ws.requests().filter(({ operation }) => operation.startsWith("pages.save")).length, 1);
});
