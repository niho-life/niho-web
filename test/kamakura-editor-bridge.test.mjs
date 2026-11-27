// Kamakura は凍結中も読み取りを通す（kamakura-site#84）。BFF の上流失敗の分類と、凍結中の 409 を競合と分ける扱いを守る。
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { EDITING_OPERATIONS, parseEditingApiDiscovery } from "@niho/web/editing-api";
import { createProjectEditorAdapter } from "../dist/project-editor-adapter.js";
import { renderSitePageToHtml } from "@niho/web/server";

async function loadKamakuraCatalogContract() {
  const result = await build({
    entryPoints: [new URL("../studio/kamakura-catalog.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

const contract = await loadKamakuraCatalogContract();
const communityDinnerTitle = "Kamakura: Community Dinner with Locals  | NIHO kamakura -- Shared living-room in Kamakura, where tourists and locals can get together";

async function loadStudioWorker() {
  const result = await build({
    entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

async function loadKamakuraEditor() {
  const result = await build({
    entryPoints: [new URL("../studio/kamakura-editor.tsx", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

test("翻訳一覧のページリンクは検証済みの English ページを初期表示し、不正な指定は無視する", async () => {
  const { kamakuraEditorInitialTarget } = await loadKamakuraEditor();
  assert.deepEqual(kamakuraEditorInitialTarget("?page=home&lang=en"), { siteId: "kamakura", pageId: "home", locale: "en" });
  for (const search of ["", "?page=home", "?page=home&lang=ja", "?page=home&lang=en&page=about", "?page=home&lang=en&lang=ja", "?page=../admin&lang=en", "?page=catalog&lang=en"]) {
    assert.equal(kamakuraEditorInitialTarget(search), undefined, search);
  }
});

function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : value).toString("base64url");
}

async function accessToken(pair, issuer, audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "catalog-contract-test", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: issuer, aud: audience, sub: "catalog-contract-test", email: "catalog-test@niho.life", type: "app", exp: now + 300, iat: now }));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}

function catalog(pageTitle = "NIHO Kamakura") {
  const site = { id: "kamakura", name: "鎌倉サイト", domains: ["https://next-kamakura.niho.life"] };
  return {
    project: { id: "kamakura-site", name: "NIHO kamakura", site },
    sites: [site],
    pages: [{ siteId: "kamakura", pageId: "kamakura-community-dinner", locale: "ja", title: pageTitle }],
    legacy: [{ name: "home", path: "/" }],
    blockContracts: {
      KamakuraLegacyForm: {
        props: { formId: { type: "enum", values: ["community-dinner", "parenting", "remotework"] } },
        slots: {
          form: { label: "体験予約フォーム", style: ["backgroundColor", "color", "padding", "borderRadius"], data: { reason: "Kamakuraサイトの既存フォームが管理します。", source: "Kamakuraサイト" } },
          field: { label: "フォーム入力欄", style: ["backgroundColor", "color", "borderColor", "borderRadius", "padding"] },
          submit: { label: "送信ボタン", style: ["color", "backgroundColor", "borderRadius", "padding"] }
        }
      }
    }
  };
}

test("Kamakura Studio の共通Stylesはsite.styles APIを使い、公開メタデータは読み取り専用", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const requests = [], styles = { tokens: { brand: { type: "color", value: "#195640" } } };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input), "https://studio.niho.life"), method = init.method ?? "GET";
    requests.push({ method, url: `${url.pathname}${url.search}`, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url.pathname.endsWith("/capabilities")) return Response.json({ apiVersion: "v1", siteId: "kamakura",
      operations: EDITING_OPERATIONS.filter(({ id }) => id.startsWith("site.styles.")) });
    if (url.pathname.endsWith("/operations/site.styles.read")) return Response.json({
      draft: { version: "draft-styles-v1", styles }, published: { version: "published-styles-v1", styles: {} } });
    if (url.pathname.endsWith("/operations/site.styles.edit")) return Response.json({ status: "saved", version: "draft-styles-v2",
      styles: { tokens: { brand: styles.tokens.brand, accent: { type: "color", value: "#0066cc" } } } });
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  });
  const source = catalog(), parsed = contract.parseKamakuraCatalog(source), base = createKamakuraAdapter(parsed, () => {});
  const adapter = createProjectEditorAdapter(base, { ...source.project, members: [] });
  const signal = new AbortController().signal;
  assert.equal(adapter.siteSettingsMetadataEditable, false);
  const [snapshot, concurrentSnapshot] = await Promise.all([adapter.readSiteSettings("kamakura", signal), adapter.readSiteSettings("kamakura", signal)]);
  assert.deepEqual(concurrentSnapshot, snapshot);
  assert.equal(snapshot.version, "draft-styles-v1");
  assert.equal(snapshot.settings.title, "鎌倉サイト");
  assert.deepEqual(snapshot.settings.tokens, styles.tokens);
  const result = await adapter.saveSiteSettings({ siteId: "kamakura", settings: { ...snapshot.settings, tokens: { brand: styles.tokens.brand, accent: { type: "color", value: "#0066cc" } } },
    expectedVersion: snapshot.version, previousStyles: styles }, signal);
  assert.equal(result.status, "saved"); assert.equal(result.version, "draft-styles-v2");
  assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
    ["GET", "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/capabilities?features=site.styles"],
    ["GET", "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/site.styles.read"],
    ["PUT", "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/site.styles.edit"]
  ]);
  assert.deepEqual(requests[2].body, { expectedVersion: "draft-styles-v1", edits: [
    { type: "set", styleKind: "token", name: "accent", value: { type: "color", value: "#0066cc" } }
  ] });
});

test("Studio の編集画面は初回一覧と文書を各1回だけ読み、Access・参加資格のエラー表示を保つ", async (t) => {
  const client = await build({
    entryPoints: [new URL("../studio/client.tsx", import.meta.url).pathname],
    bundle: true, format: "iife", platform: "browser", target: "es2022", write: false,
    define: { "process.env.NODE_ENV": '"production"' }
  });
  const base = "/api/projects/project-kamakura/sites/kamakura";
  const canonical = "/projects/project-kamakura/sites/kamakura/editor";
  const source = catalog(), [page] = source.pages, site = source.sites[0];
  const project = { id: "project-kamakura", name: "鎌倉プロジェクト", site, members: [] };
  const directory = { status: "ready", entries: [{ project, summary: { projectId: project.id, siteId: site.id, publicationStatus: "published",
    publishedUrl: site.domains[0], thumbnail: null, updatedAt: "2026-11-26T00:00:00Z", lastAccessedAt: null, members: { status: "ready", data: [] } } }] };
  const config = { schemaVersion: 1, siteId: site.id, sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"], documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "g1", contextVersion: "c1" };
  const localization = { status: "ready", config, pages: [{ siteId: site.id, pageId: page.pageId, title: page.title, locales: { ja: { state: "source" }, en: { state: "missing" } } }], version: `s.${"a".repeat(64)}` };
  const breakpointsPath = `${base}/editor/editing-api/v1/sites/kamakura/operations/site.breakpoints.read`;
  const documentPath = `${base}/editor/editing-api/v1/sites/kamakura/operations/pages.read/${page.pageId}?locale=ja`;
  const until = async (condition) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(condition(), "Studio did not reach the expected state");
  };
  function open(path, options = {}) {
    const dom = new JSDOM('<div id="root"></div>', { url: `https://studio.example.test${path}`, runScripts: "outside-only", pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const { window } = dom, calls = [], measures = [];
    if (options.measure) {
      const marks = new Map();
      Object.assign(window.performance, {
        getEntriesByType: (type) => type === "navigation" ? [{ startTime: 0 }] : [],
        mark: (name, { startTime = window.performance.now() } = {}) => marks.set(name, startTime),
        measure: (name, start, end) => {
          const entry = { name, startTime: marks.get(start), duration: marks.get(end) - marks.get(start) };
          if (name.startsWith("niho-studio:editor:")) measures.push(entry);
          return entry;
        },
        clearMarks: (name) => marks.delete(name),
        clearMeasures: () => {}
      });
    }
    const session = Promise.withResolvers(), editorCatalog = Promise.withResolvers();
    window.TextEncoder = TextEncoder;
    window.TextDecoder = TextDecoder;
    window.structuredClone = (value) => value === undefined ? undefined : window.JSON.parse(JSON.stringify(value));
    const json = (value, status = 200) => {
      const response = Response.json(value, { status });
      response.json = async () => window.JSON.parse(JSON.stringify(value));
      return response;
    };
    window.fetch = async (input, init) => {
      const url = new URL(String(input), window.location.origin), path = `${url.pathname}${url.search}`;
      calls.push({ path, signal: init.signal });
      if (path === "/api/session") {
        await session.promise;
        return options.expired ? json({ error: "authentication_required" }, 401) : json({ status: "authenticated", subject: "person", email: "editor@example.test" });
      }
      if (path === "/api/projects") return json(options.directory ?? directory);
      if (path === "/api/config") return json({ managedProjectsEnabled: false, publicSitesOrigin: null });
      if (path === `${base}/editor/catalog`) {
        await editorCatalog.promise;
        return options.catalogError ? json({ error: "upstream_contract_invalid" }, 502) : json(source);
      }
      if (path === `${base}/localization/editor/site`) return json(localization);
      if (path === breakpointsPath) return json({ settings: { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [] }, version: "b.v1" });
      if (path === documentPath) return json({ document: { schemaVersion: 1, siteId: page.siteId, pageId: page.pageId, locale: page.locale, revision: 1, title: page.title, tokens: {}, body: [] },
        version: "v1", editorState: { readOnly: { reason: "初期スナップショットから編集制限を表示" } } });
      return json({ error: "not_found" }, 404);
    };
    window.eval(client.outputFiles[0].text);
    return { window, calls, session, editorCatalog, measures };
  }

  const editor = open(canonical);
  await until(() => editor.calls.length === 4);
  assert.deepEqual(new Set(editor.calls.map(({ path }) => path)), new Set(["/api/session", "/api/projects", "/api/config", `${base}/editor/catalog`]));
  editor.session.resolve();
  await until(() => editor.calls.some(({ path }) => path === breakpointsPath));
  assert.ok(editor.calls.some(({ path }) => path === `${base}/localization/editor/site`));
  assert.ok(!editor.calls.some(({ path }) => path === documentPath));
  editor.editorCatalog.resolve();
  await until(() => editor.window.document.body.textContent.includes("初期スナップショットから編集制限を表示"));
  assert.equal(editor.calls.filter(({ path }) => path === documentPath).length, 1);
  assert.equal(editor.calls.filter(({ path }) => path === `${base}/editor/catalog`).length, 1);
  assert.equal(editor.calls.filter(({ path }) => path === breakpointsPath).length, 1);
  assert.equal(editor.calls.filter(({ path }) => path === `${base}/localization/editor/site`).length, 1);
  assert.ok(!editor.calls.some(({ path }) => path.endsWith("/pages.catalog") || path === `${base}/editor/${page.pageId}`));
  assert.equal(editor.window.document.querySelector(".studio-editor-performance"), null);

  const measured = open(`${canonical}?editorPerf=1`, { measure: true });
  measured.session.resolve();
  measured.editorCatalog.resolve();
  await until(() => measured.window.document.querySelector("iframe"));
  measured.window.document.querySelector("iframe").dispatchEvent(new measured.window.Event("load"));
  await until(() => measured.measures.length === 1);
  assert.equal(measured.measures[0].name, "niho-studio:editor:initial-load");
  assert.equal(measured.measures[0].startTime, 0);
  assert.ok(measured.measures[0].duration > 0);
  await until(() => measured.window.document.querySelector(".studio-editor-performance dd")?.textContent?.endsWith(" ms"));

  for (const [options, message] of [
    [{ expired: true }, "セッションの確認が必要です"],
    [{ directory: { status: "forbidden" } }, "アクセス権がありません"],
    [{ directory: { status: "ready", entries: [] } }, "プロジェクトを表示できません"]
  ]) {
    const denied = open(canonical, options);
    await until(() => denied.calls.length === 4);
    denied.session.resolve();
    await until(() => denied.window.document.body.textContent.includes(message));
    assert.ok(denied.calls.find(({ path }) => path === `${base}/editor/catalog`).signal.aborted);
    assert.equal(denied.calls.length, 4);
    denied.editorCatalog.resolve();
  }
  const failedCatalog = open("/projects/kamakura-site/admin/editor", { catalogError: true });
  failedCatalog.session.resolve();
  failedCatalog.editorCatalog.resolve();
  await until(() => failedCatalog.window.document.body.textContent.includes("ページ一覧の形式に対応できません"));
  assert.ok(!failedCatalog.calls.some(({ path }) => path === documentPath));

  const nonEditor = open("/");
  nonEditor.session.resolve();
  await until(() => nonEditor.window.document.body.textContent.includes(project.name));
  assert.ok(!nonEditor.calls.some(({ path }) => path.startsWith(base)));
});

test("鎌倉のフォーム完了先は固定の公開済み完了ページだけを候補にする", async () => {
  const source = catalog();
  source.pages.push(
    { siteId: "kamakura", pageId: "contact-success", locale: "ja", title: "お問い合わせ完了", path: "/contact-success", kind: "page" },
    { siteId: "kamakura", pageId: "business-plan", locale: "ja", title: "法人向け", path: "/business-plan", kind: "page" },
    { siteId: "kamakura", pageId: "draft-success", locale: "ja", title: "下書き", path: "/draft-success", kind: "page", published: false },
    { siteId: "kamakura", pageId: "private-success", locale: "ja", title: "非公開", path: "/private-success", kind: "page", visibility: "private" }
  );
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(source), () => {});
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.listFormCompletionPages({ siteId: "kamakura", pageId: "business-plan", locale: "ja" }, signal),
    [{ siteId: "kamakura", pageId: "contact-success", locale: "ja", title: "お問い合わせ完了", path: "/contact-success", kind: "page", visibility: "public", published: true }]);
  assert.deepEqual(await adapter.listFormCompletionPages({ siteId: "kamakura", pageId: "business-plan", locale: "en" }, signal), []);
});

test("Kamakura editor adapter は編集状態と本文を1回で読み、状態欠損時はfail-closedする", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const pageId = "kamakura-community-dinner";
  const target = { siteId: "kamakura", pageId, locale: "ja" };
  const document = { schemaVersion: 1, siteId: "kamakura", pageId, locale: "ja", revision: 1, title: "ページ", tokens: {}, body: [] };
  const version = "ja-version";
  const base = "/api/projects/project-kamakura/sites/kamakura/editor";
  const commonReadPath = `${base}/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=ja`;
  const presentation = { schemaVersion: 1, siteId: target.siteId, locale: target.locale, version: "p.v1", reset: "neutral-v1", tokens: {},
    layout: { base: { backgroundColor: "#edf5ed" } }, fonts: [],
    shared: { header: { ...document, pageId: "site-header" }, footer: { ...document, pageId: "site-footer" } } };
  const editorState = { readOnly: { reason: "読み取り専用" }, englishPublication: { state: "published", retryable: false }, releases: [{ revision: 1, label: "公開中" }] };
  const fastSnapshot = { document, version, presentation, ...editorState };
  let wire = { document, version, presentation, presentationVersion: presentation.version, editorState };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input), "https://studio.niho.life");
    const path = `${url.pathname}${url.search}`;
    calls.push(path);
    if (path === commonReadPath) {
      assert.equal(init.headers.get("Accept"), "application/json; profile=niho-editor-snapshot-v1");
      return wire instanceof Response ? wire : Response.json(wire);
    }
    throw new Error(`unexpected request: ${path}`);
  });

  const parsed = contract.parseKamakuraCatalog(catalog()), signal = new AbortController().signal;
  const adapter = createKamakuraAdapter(parsed, () => {});
  assert.deepEqual(await adapter.listPages(target.siteId, signal), parsed.pages);
  assert.deepEqual(calls, []);
  assert.deepEqual(await adapter.readDocument(target, signal), fastSnapshot);
  assert.deepEqual(calls.splice(0), [commonReadPath]);

  wire = { document, version, presentation, presentationVersion: presentation.version };
  await assert.rejects(adapter.readDocument(target, signal), (error) => error.status === 503 && error.code === "editor_state_unavailable");
  assert.deepEqual(calls.splice(0), [commonReadPath], "編集状態が無いときに別の読取経路へfallbackしない");

  const native = contract.parseKamakuraCatalog({ ...catalog(), nativePresentationPages: [pageId] });
  wire = { document, version, editorState: {} };
  await assert.rejects(createKamakuraAdapter(native, () => {}).readDocument(target, signal), /必要な表示コンテキスト/u);
  assert.deepEqual(calls.splice(0), [commonReadPath]);
  for (const [status, code] of [[401, "authentication_required"], [403, "forbidden"]]) {
    wire = Response.json({ error: code }, { status });
    await assert.rejects(adapter.readDocument(target, signal), (error) => error.status === status && error.code === code);
    assert.deepEqual(calls.splice(0), [commonReadPath]);
  }
  wire = { document, version, presentation, presentationVersion: "stale", editorState };
  await assert.rejects(adapter.readDocument(target, signal), (error) => error.code === "invalid_response");
  assert.deepEqual(calls.splice(0), [commonReadPath]);
});

test("Kamakura adapter reads pages without a draft-style dependency version", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const pageId = "kamakura-community-dinner", target = { siteId: "kamakura", pageId, locale: "ja" };
  const document = { schemaVersion: 1, siteId: "kamakura", pageId, locale: "ja", revision: 1, title: "ページ", tokens: {}, body: [] };
  const editorState = { readOnly: { reason: "読み取り専用" }, englishPublication: { state: "published", retryable: false }, releases: [] };
  const base = "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input), "https://studio.niho.life"), path = `${url.pathname}${url.search}`;
    if (path.endsWith("/capabilities?features=site.styles")) return Response.json({ apiVersion: "v1", siteId: "kamakura",
      operations: EDITING_OPERATIONS.filter(({ id }) => id.startsWith("site.styles.")) });
    if (path.endsWith("/site.styles.read")) return Response.json({
      draft: { version: "draft-styles-v1", styles: {} }, published: { version: "published-styles-v1", styles: {} } });
    if (path === `${base}/pages.read/${pageId}?locale=ja`) return Response.json({ document, version: "page-v1", editorState });
    throw new Error(`unexpected request: ${path}`);
  });
  const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(catalog()), () => {}), signal = new AbortController().signal;
  await adapter.readSiteSettings(target.siteId, signal);
  const snapshot = await adapter.readDocument(target, signal);
  assert.equal(snapshot.draftStylesVersion, undefined);
  assert.equal(snapshot.document.pageId, pageId);
});

test("Kamakura GUI sends ordinary Japanese page edits through compact pages.apply", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const pageId = "kamakura-community-dinner", target = { siteId: "kamakura", pageId, locale: "ja" };
  const document = { schemaVersion: 1, siteId: target.siteId, pageId, locale: target.locale, revision: 1, title: "ページ", tokens: {}, body: [] };
  const presentation = { schemaVersion: 1, siteId: target.siteId, locale: target.locale, version: "p.v1", reset: "neutral-v1", tokens: {},
    layout: { base: { backgroundColor: "#edf5ed" } }, fonts: [],
    shared: { header: { ...document, pageId: "site-header" }, footer: { ...document, pageId: "site-footer" } } };
  const editorState = { readOnly: { reason: "読み取り専用" }, englishPublication: { state: "published", retryable: false }, releases: [] };
  const base = "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input), "https://studio.niho.life"), method = init.method ?? "GET";
    const path = `${url.pathname}${url.search}`, body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path, body });
    if (path.endsWith("/capabilities?features=site.styles")) return Response.json({ apiVersion: "v1", siteId: "kamakura",
      operations: EDITING_OPERATIONS.filter(({ id }) => ["pages.read", "pages.apply"].includes(id) || id.startsWith("site.styles.")) });
    if (path.endsWith("/site.styles.read")) return Response.json({
      draft: { version: "draft-styles-v1", styles: {} }, published: { version: "published-styles-v1", styles: {} } });
    if (path === `${base}/pages.read/${pageId}?locale=ja`) return Response.json({ document, version: "page-v1",
      presentationVersion: presentation.version, presentation, editorState });
    if (path === `${base}/pages.apply/${pageId}?locale=ja`) return Response.json({ status: "applied", version: "page-v2", revision: 2,
      document: { ...document, title: "変更後", revision: 2 } });
    throw new Error(`unexpected request: ${method} ${path}`);
  });
  const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(catalog()), () => {}), signal = new AbortController().signal;
  await adapter.readSiteSettings(target.siteId, signal);
  const snapshot = await adapter.readDocument(target, signal);
  const result = await adapter.applyOperations({ target, baseVersion: snapshot.version, operationId: crypto.randomUUID(),
    operations: [{ type: "title", value: "変更後" }], presentationVersion: snapshot.presentationVersion }, signal);

  assert.equal(result.status, "applied");
  assert.equal(result.document.title, "変更後");
  const apply = requests.find(({ path }) => path.includes("/pages.apply/"));
  assert.equal(apply.method, "POST");
  assert.equal(apply.body.baseVersion, "page-v1");
  assert.equal(apply.body.draftStylesVersion, undefined);
  assert.equal(apply.body.stylesVersion, undefined);
  assert.equal(apply.body.document, undefined);
  assert.deepEqual(apply.body.operations, [{ type: "title", value: "変更後" }]);
  assert.ok(Buffer.byteLength(JSON.stringify(apply.body)) < 1024);
});

test("Kamakura Studio adapter routes multi-page plan, apply, and status through the shared editing API", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const base = "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations";
  const items = [
    { target: { siteId: "kamakura", pageId: "contact", locale: "ja" }, expectedVersion: "page-version-1", presentationVersion: "presentation-1" },
    { target: { siteId: "kamakura", pageId: "business-plan", locale: "ja" }, expectedVersion: "page-version-2", presentationVersion: "presentation-2" }
  ];
  const calls = [];
  let operationId;
  const result = { status: "publishing", operationId: "pending", items: [
    { target: items[0].target, status: "released", version: "ps2:pv1-result" },
    { target: items[1].target, status: "pending" }
  ] };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input), "https://studio.niho.life"), key = `${init.method ?? "GET"} ${url.pathname}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    if (key === `POST ${base}/pages.release-set-plan`) {
      operationId = body.operationId;
      result.operationId = operationId;
      return Response.json({ plan: { siteId: "kamakura", operationId, confirmationToken: "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111",
        domain: "https://next-kamakura.niho.life", items } });
    }
    if (key === `POST ${base}/pages.release-set`) return Response.json(result);
    if (key === `GET ${base}/pages.release-set-status/${operationId}`) return Response.json({ status: "completed", operationId, httpStatus: 200, result });
    throw new Error(`unexpected request: ${key}`);
  });
  const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(catalog()), () => {});
  const signal = new AbortController().signal;
  const plan = await adapter.prepareReleaseSet(items, signal);
  assert.equal(plan.operationId, operationId);
  assert.deepEqual(plan.items, items);
  assert.deepEqual(await adapter.releaseSet(plan, signal), result);
  assert.deepEqual(await adapter.releaseSetStatus(operationId, signal), { status: "completed", operationId, httpStatus: 200, result });
  assert.deepEqual(calls.map(({ key }) => key), [
    `POST ${base}/pages.release-set-plan`, `POST ${base}/pages.release-set`, `GET ${base}/pages.release-set-status/${operationId}`
  ]);
  assert.deepEqual(calls[0].body.items, items);
  assert.equal(calls[1].body.confirmationToken, plan.confirmationToken);
});

test("Kamakura editor adapter は英語読取を共通 pages.read に揃え、保存・翻訳操作は既存の正本を使う", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const parsedCatalog = contract.parseKamakuraCatalog(catalog());
  const pageId = "kamakura-community-dinner";
  const base = "/api/projects/project-kamakura/sites/kamakura/editor";
  const document = (id, locale, title = id) => ({ schemaVersion: 1, siteId: "kamakura", pageId: id, locale, revision: 2, title, tokens: {}, body: [] });
  const presentation = { schemaVersion: 1, siteId: "kamakura", locale: "en", version: "presentation-1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: document("site-header", "en"), footer: document("site-footer", "en") },
    links: { origin: "https://next-kamakura.niho.life", sourcePath: "/en/community-dinner", paths: { "/old-community": "/en/community-dinner" } } };
  const japanesePresentation = { ...presentation, locale: "ja", version: "presentation-version",
    shared: { header: document("site-header", "ja"), footer: document("site-footer", "ja") } };
  const versions = { expectedSourceVersion: `p.${"a".repeat(64)}`, expectedVersion: `l.${"b".repeat(64)}`, expectedOverlayVersion: 1 };
  const englishDocument = { ...document(pageId, "en", "Community Dinner"), body: [{ type: "element", id: "old-link", tag: "a", attrs: { href: "/old-community" }, children: [{ type: "text", text: "Community Dinner" }] }] };
  const config = { schemaVersion: 1, siteId: "kamakura", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"], documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "g1", contextVersion: "c1" };
  const overlay = { schemaVersion: 1, siteId: "kamakura", pageId, sourceLocale: "ja", targetLocale: "en", version: 1, entries: [] };
  const localizedPage = { siteId: "kamakura", pageId, title: "Community Dinner", locales: { ja: { state: "source" }, en: { state: "review-needed", changed: 1, published: false } } };
  const normalizedLocalizedPage = { ...localizedPage, title: parsedCatalog.pages[0].title };
  const englishPublication = { state: "retryable-failure", retryable: true, updatedAt: "2026-10-27T01:02:03.000Z" };
  const releases = [{ revision: 2, label: "版 2（現在公開中）" }, { revision: 1, label: "版 1" }];
  const breakpointSettings = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "Small", minWidth: 991, previewWidth: 991 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const releasePlan = { target: { siteId: "kamakura", pageId, locale: "ja" }, expectedVersion: "ja-version", presentationVersion: "presentation-version", action: "publish",
    confirmationToken: "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111", domain: "https://next-kamakura.niho.life", changes: [] };
  let japaneseVersion = "ja-version";
  let japaneseDocument = document(pageId, "ja");
  let failNextRelease = true;
  const releaseOperationIds = [];
  const breakpointReadPath = `${base}/editing-api/v1/sites/kamakura/operations/site.breakpoints.read`;
  const breakpointSavePath = `${base}/editing-api/v1/sites/kamakura/operations/site.breakpoints.save`;
  const replies = new Map([
    [`GET ${breakpointReadPath}`, { settings: breakpointSettings, version: "b.1" }],
    [`PUT ${breakpointSavePath}`, { status: "saved", version: "b.2" }],
    [`GET /api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=ja`, () => ({ document: japaneseDocument, version: japaneseVersion, presentationVersion: "presentation-version", presentation: japanesePresentation, editorState: { releases, englishPublication } })],
    [`GET /api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=en`, () => ({ document: englishDocument, version: versions.expectedVersion, presentationVersion: presentation.version, presentation })],
    [`PUT /api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.save/${pageId}?locale=ja`, () => {
      japaneseVersion = "saved-version";
      japaneseDocument = document(pageId, "ja", "保存済みタイトル");
      japaneseDocument.revision = 3;
      return { status: "saved", version: japaneseVersion, document: japaneseDocument };
    }],
    [`POST /api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.release-plan/${pageId}?locale=ja`, { plan: releasePlan }],
    [`POST /api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.release/${pageId}?locale=ja`, (body) => {
      releaseOperationIds.push(body.operationId);
      if (failNextRelease) { failNextRelease = false; throw new Error("synthetic response loss after dispatch"); }
      japaneseVersion = "released-version";
      japaneseDocument = { ...japaneseDocument, revision: japaneseDocument.revision + 1 };
      return { status: "released", operationId: body.operationId, version: japaneseVersion, document: japaneseDocument };
    }],
    [`POST /api/projects/project-kamakura/sites/kamakura/editor/${pageId}/english-publication-retry`, { status: "accepted", englishPublication: { state: "queued", retryable: false } }],
    [`POST /api/projects/project-kamakura/sites/kamakura/editor/${pageId}/release`, { status: "released", snapshot: { document: document(pageId, "ja"), version: "released-version", englishPublication: { state: "publishing", retryable: false } } }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/site`, { status: "ready", config, pages: [localizedPage], version: `s.${"c".repeat(64)}` }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}`, { status: "ready", sourceDocument: document(pageId, "ja-JP"), sourceVersion: versions.expectedSourceVersion, overlay, version: versions.expectedVersion }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/save`, { status: "saved", version: `l.${"d".repeat(64)}`, revision: 3 }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/command`, { status: "applied", version: `l.${"e".repeat(64)}` }]
  ]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, init = {}) => {
    const requestUrl = new URL(String(path), "https://studio.niho.life");
    const key = `${init.method ?? "GET"} ${requestUrl.pathname}${requestUrl.search}`, body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ key, body });
    const reply = replies.get(key);
    if (!reply) throw new Error(`unexpected request: ${key}`);
    const value = typeof reply === "function" ? reply(body) : reply;
    return value instanceof Response ? value : Response.json(value);
  });
  const adapter = createKamakuraAdapter(parsedCatalog, () => {}), signal = new AbortController().signal;
  const ja = { siteId: "kamakura", pageId, locale: "ja" }, en = { siteId: "kamakura", pageId, locale: "en" };

  const japanese = await adapter.readDocument(ja, signal);
  assert.equal(japanese.document.locale, "ja");
  assert.deepEqual(japanese.englishPublication, englishPublication);
  assert.equal(calls.some(({ key }) => key.includes("/draft")), false, "日本語の下書き読取・保存で旧draft routeを使わない");
  assert.deepEqual(await adapter.breakpointSettings.read("kamakura", signal), { settings: breakpointSettings, version: "b.1" });
  assert.deepEqual(await adapter.breakpointSettings.save({ siteId: "kamakura", settings: breakpointSettings, expectedVersion: "b.1" }, signal), { status: "saved", version: "b.2" });
  assert.equal(calls.at(-1).key, `PUT ${breakpointSavePath}`);
  assert.deepEqual(calls.at(-1).body, { settings: breakpointSettings, expectedVersion: "b.1" });
  const english = await adapter.readDocument(en, signal);
  assert.equal(english.document.locale, "en");
  assert.equal(english.presentation.version, presentation.version);
  assert.deepEqual(english.presentation.links.paths, { "/old-community": "/en/community-dinner" });
  assert.match(renderSitePageToHtml(english.document, english.presentation), /href="\/en\/community-dinner"/u, "common presentation resolves legacy English aliases in the preview");
  assert.equal(calls.findLast(({ key }) => key.includes("operations/pages.read") && key.endsWith("locale=en")).key,
    `GET ${base}/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=en`);
  assert.deepEqual(await adapter.localization.readSite("kamakura", signal), { config, pages: [normalizedLocalizedPage], version: `s.${"c".repeat(64)}` });
  assert.deepEqual(await adapter.localization.readPage(en, signal), { sourceDocument: document(pageId, "ja-JP"), sourceVersion: versions.expectedSourceVersion, overlay, version: versions.expectedVersion });
  const saved = await adapter.saveDraft({ target: en, document: english.document, expectedVersion: versions.expectedVersion, presentationVersion: presentation.version, localization: versions }, signal);
  assert.equal(saved.status, "saved");
  const saveCall = calls.at(-1);
  assert.deepEqual(saveCall.body, { document: english.document, ...versions }, "presentationVersion と target は BFF の allowlist へ混ぜない");
  const japaneseSaved = await adapter.saveDraft({ target: ja, document: { ...japanese.document, title: "保存済みタイトル" }, expectedVersion: "ja-version", presentationVersion: "presentation-version" }, signal);
  assert.deepEqual(japaneseSaved, { status: "saved", version: "saved-version", revision: 3 });
  assert.equal(calls.at(-1).key, `PUT ${base}/editing-api/v1/sites/kamakura/operations/pages.save/${pageId}?locale=ja`);
  assert.deepEqual(calls.at(-1).body, { expectedVersion: "ja-version", document: { ...japanese.document, title: "保存済みタイトル" } });
  assert.equal(calls.some(({ key }) => key === `POST ${base}/${pageId}/draft`), false, "日本語保存は旧draft routeへ送らない");
  assert.deepEqual(await adapter.localization.command({ action: "review-current", target: en, unitId: "page.title", ...versions }, signal), { status: "applied", version: `l.${"e".repeat(64)}` });
  assert.deepEqual(await adapter.englishPublication.refresh(ja, signal), englishPublication);
  assert.deepEqual(await adapter.englishPublication.retry(ja, signal), { status: "accepted", englishPublication: { state: "queued", retryable: false } });
  assert.deepEqual(calls.at(-1).body, {}, "再試行本文は空の object だけ");
  const prepared = await adapter.prepareRelease({ target: ja, expectedVersion: "ja-version", presentationVersion: "presentation-version", action: "publish" }, signal);
  assert.deepEqual(prepared, releasePlan);
  assert.equal(calls.at(-1).key, `POST ${base}/editing-api/v1/sites/kamakura/operations/pages.release-plan/${pageId}?locale=ja`);
  assert.deepEqual(calls.at(-1).body, { expectedVersion: "ja-version", presentationVersion: "presentation-version", action: "publish" });
  await assert.rejects(adapter.release(prepared, signal), /編集ブリッジを利用できません/u, "応答が失われた公開はエラーとして再試行可能にする");
  const released = await adapter.release(prepared, signal);
  assert.equal(released.status, "released");
  assert.equal(releaseOperationIds.length, 2);
  assert.equal(releaseOperationIds[0], releaseOperationIds[1], "同じ公開確認の再送はoperation IDを再利用する");
  assert.deepEqual(released.snapshot.englishPublication, englishPublication, "日本語 release 後もsnapshotから英語公開状態を伝える");
  const releaseCall = calls.findLast(({ key }) => key === `POST ${base}/editing-api/v1/sites/kamakura/operations/pages.release/${pageId}?locale=ja`);
  assert.match(releaseCall.body.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(calls.some(({ key }) => key === `POST ${base}/${pageId}/release`), false, "日本語公開は旧release routeへ送らない");
  const before = calls.length;
  await assert.rejects(adapter.localization.command({ action: "request-translation", target: en, ...versions }, signal), /まだ対応していません/u);
  assert.equal(calls.length, before, "未対応の翻訳依頼を成功扱いせず BFF にも送らない");
  await assert.rejects(adapter.saveDraft({ target: en, document: english.document, expectedVersion: `l.${"f".repeat(64)}`, presentationVersion: presentation.version, localization: versions }, signal), /版が正しくありません/u);
  assert.equal(calls.length, before);

  replies.set(`PUT ${breakpointSavePath}`, Response.json({ error: "version_conflict" }, { status: 409 }));
  assert.deepEqual(await adapter.breakpointSettings.save({ siteId: "kamakura", settings: breakpointSettings, expectedVersion: "b.1" }, signal), { status: "conflict" });
  replies.set(`GET ${breakpointReadPath}`, { settings: breakpointSettings, version: "b.2", extra: true });
  await assert.rejects(adapter.breakpointSettings.read("kamakura", signal), (error) => error?.code === "invalid_response");

  replies.set(`GET ${base}/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=en`, {
    document: englishDocument, version: versions.expectedVersion, presentationVersion: presentation.version, coordinatorEpoch: 1, presentation
  });
  await assert.rejects(adapter.readDocument(en, signal), (error) => error.code === "invalid_response", "internal coordinator epochs are rejected by the common read contract");
  replies.set(`GET ${base}/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=en`, Response.json({ error: "version_conflict" }, { status: 409 }));
  await assert.rejects(adapter.readDocument(en, signal), (error) => error.status === 409);
  replies.set(`GET /api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.read/${pageId}?locale=ja`, {
    document: document(pageId, "ja"), version: "ja-version", presentationVersion: "presentation-version", presentation: japanesePresentation,
    editorState: { releases, englishPublication: { ...englishPublication, internal: "secret" } }
  });
  await assert.rejects(adapter.readDocument(ja, signal));
  replies.set(`POST /api/projects/project-kamakura/sites/kamakura/editor/${pageId}/english-publication-retry`, { status: "accepted", englishPublication: { state: "published", retryable: false }, internal: "secret" });
  await assert.rejects(adapter.englishPublication.retry(ja, signal), /英語公開状態が正しくありません/u);
});

test("Kamakura Worker accepts valid long titles and separates contract errors from unavailable upstream", async (t) => {
  const issuer = "https://catalog-contract-test.example";
  const audience = "catalog-contract-test-audience";
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "catalog-contract-test", alg: "RS256", use: "sig" };
  const token = await accessToken(pair, issuer, audience);
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  let importedAccessKeys = 0, importedHmacKeys = 0;
  t.mock.method(crypto.subtle, "importKey", async (...args) => {
    if (args[0] === "jwk") importedAccessKeys += 1;
    if (args[0] === "raw" && args[4]?.includes("sign")) importedHmacKeys += 1;
    return importKey(...args);
  });
  const workerModule = await loadStudioWorker();
  let upstreamResponse = new Response(JSON.stringify(catalog(communityDinnerTitle)), { headers: { "Content-Type": "application/json", ETag: '"catalog-v1"' } });
  let jwksReads = 0;
  let bindingFailure = false;
  let bindingResponseFactory = null;
  const boundRequestIds = [];
  const bridgeLogs = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
    jwksReads += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", (...args) => { bridgeLogs.push(args); });

  const breakpointSettings = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "Small", minWidth: 991, previewWidth: 991 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const env = {
    DB: { prepare(sql) { assert.doesNotMatch(sql, /site_breakpoint_settings/u); return { bind() { return this; }, async first() { return { allowed: 1, role: "editor" }; } }; } },
    ASSETS: { fetch: async () => new Response("not expected", { status: 500 }) },
    KAMAKURA_SITE: { fetch: async (request) => {
      if (bindingFailure) throw new Error("binding failure detail must not be logged");
      boundRequestIds.push(request.headers.get("X-NIHO-Studio-Request-ID"));
      if (bindingResponseFactory) return bindingResponseFactory(request);
      return upstreamResponse;
    } },
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: Buffer.alloc(32, 9).toString("base64url")
  };

  const callCatalog = (headers = {}) => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/catalog", {
    headers: { "Cf-Access-Jwt-Assertion": token, ...headers }
  }), env);
  const callAssetList = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/assets/list", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ siteId: "kamakura", search: "", kind: "all", folderId: null, limit: 60 })
  }), env);

  const accepted = await callCatalog();
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("ETag"), '"catalog-v1"');
  assert.equal(accepted.headers.get("Cache-Control"), "private, no-cache");
  assert.match(accepted.headers.get("Vary"), /Accept/u);
  const acceptedCatalog = await accepted.json();
  assert.equal(acceptedCatalog.pages[0].title, communityDinnerTitle);
  assert.deepEqual(acceptedCatalog.blockContracts, catalog().blockContracts);
  assert.match(boundRequestIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  bindingResponseFactory = async (request) => {
    assert.equal(request.headers.get("If-None-Match"), '"catalog-v1"');
    return new Response(null, { status: 304, headers: { ETag: '"catalog-v1"' } });
  };
  const unchangedCatalog = await callCatalog({ "If-None-Match": '"catalog-v1"' });
  assert.equal(unchangedCatalog.status, 304);
  assert.equal(await unchangedCatalog.text(), "");
  assert.equal(unchangedCatalog.headers.get("Cache-Control"), "private, no-cache");
  assert.equal(importedAccessKeys, 1, "Access JWK imports are reused for repeated requests");
  assert.equal(importedHmacKeys, 1, "the bridge HMAC CryptoKey is reused for repeated requests");
  bindingResponseFactory = null;

  const legacyBindingCalls = boundRequestIds.length;
  const legacyPageChange = await workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/page-changes/prepare", {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ change: { action: "create", siteId: "kamakura", locale: "ja", title: "新しいページ", path: "/new-page" } })
  }), env);
  assert.equal(legacyPageChange.status, 404, "Studio-only page-management writes are removed");
  assert.equal(boundRequestIds.length, legacyBindingCalls, "legacy writes do not reach a separate host route");

  let editingApiRequest;
  const commonSnapshot = { document: { schemaVersion: 1, siteId: "kamakura", pageId: "community", locale: "ja", revision: 1, title: "地域のコミュニティ", tokens: {}, body: [] },
    version: "page-v1", editorState: {} };
  const largeSnapshotBytes = new TextEncoder().encode(JSON.stringify({ ...commonSnapshot,
    document: { ...commonSnapshot.document, body: [{ type: "element", id: "large", tag: "p", children: [{ type: "text", text: "x".repeat(1024 * 1024) }] }] } }));
  const largeChunkSize = 16 * 1024;
  let largeReadMode = false, largeReadPulls = 0;
  bindingResponseFactory = async (request) => {
    editingApiRequest = request;
    const claims = JSON.parse(Buffer.from(request.headers.get("Authorization").slice("Bearer ".length).split(".")[1], "base64url").toString("utf8"));
    const upstreamUrl = new URL(request.url), path = upstreamUrl.pathname;
    if (path.endsWith("/capabilities")) {
      const siteStylesRequested = upstreamUrl.search === "?features=site.styles";
      const operations = EDITING_OPERATIONS.filter(({ id }) => ["pages.read", "pages.apply"].includes(id)
        || siteStylesRequested && id.startsWith("site.styles.")).map((operation) => siteStylesRequested && operation.id === "pages.apply"
        ? { ...operation, path: `${operation.path}&features=site.styles` } : operation);
      return Response.json({ apiVersion: "v1", siteId: "kamakura", operations });
    }
    if (path.endsWith("/site.styles.read")) return Response.json({
      draft: { version: "draft-styles-v1", styles: { tokens: {} } },
      published: { version: "published-styles-v1", styles: { tokens: {} } }
    });
    if (path.endsWith("/site.styles.publish")) return Response.json({ status: "published", version: "published-styles-v2", styles: { tokens: {} },
      urls: ["https://kamakura.niho.life/"], elapsedMs: 12, warnings: [] });
    if (path.includes("/pages.read/")) {
      if (request.headers.get("If-None-Match") === '"page-v1"') return new Response(null, { status: 304, headers: { ETag: '"page-v1"', "Server-Timing": "page-read;dur=1.2" } });
      if (largeReadMode) {
        let offset = 0;
        return new Response(new ReadableStream({ pull(controller) {
          largeReadPulls += 1;
          if (offset >= largeSnapshotBytes.length) { controller.close(); return; }
          const end = Math.min(offset + largeChunkSize, largeSnapshotBytes.length);
          controller.enqueue(largeSnapshotBytes.slice(offset, end)); offset = end;
        } }), { headers: { "Content-Type": "application/json", ETag: '"page-v1"' } });
      }
      return new Response(JSON.stringify(commonSnapshot), { headers: { "Content-Type": "application/json", ETag: '"page-v1"', "Server-Timing": "page-read;dur=12.5" } });
    }
    if (path.endsWith("/pages.catalog")) return Response.json({ version: "registry-v1", pages: [{ siteId: "kamakura", pageId: "community", locale: "ja", title: "地域のコミュニティ", path: "/community", kind: "page", visibility: "public", published: true }] });
    if (path.endsWith("/pages.change-prepare")) {
      const input = await request.clone().json();
      return Response.json({ plan: { ...input, confirmationToken: "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111", domain: "https://kamakura.niho.life", impact: { linkedFrom: [], navigation: [], notes: [] } } });
    }
    if (path.endsWith("/pages.change-apply")) {
      const input = await request.clone().json();
      return Response.json({ status: "applied", operationId: input.operationId, page: { siteId: "kamakura", pageId: "community", locale: "ja", title: input.change.title, path: input.change.path, kind: "page", visibility: "public", published: true } });
    }
    return Response.json({ status: "saved", version: "next-version", document: { schemaVersion: 1, siteId: "kamakura", pageId: "community", locale: "ja", revision: 3, title: "変更済み", tokens: {}, body: [] }, delegatedClaims: claims });
  };
  const callEditingApi = (path, method = "GET", body, headers = {}) => workerModule.default.fetch(new Request(`https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1${path}`, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": token, ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env);
  const capabilities = await callEditingApi("/sites/kamakura/capabilities");
  assert.equal(capabilities.status, 200);
  assert.equal(editingApiRequest.url, "https://kamakura.niho.life/api/edit/v1/sites/kamakura/capabilities");
  assert.equal(editingApiRequest.headers.get("Cookie"), null, "Studioのcookieをサイトへ転送しない");
  assert.equal(editingApiRequest.headers.get("Origin"), "https://kamakura.niho.life");
  const assertDelegationSignature = async (request) => {
    const [header, claims, signature] = request.headers.get("Authorization").slice("Bearer ".length).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "HS256", typ: "JWT" });
    const key = await crypto.subtle.importKey("raw", Buffer.from(env.KAMAKURA_STUDIO_BRIDGE_SECRET, "base64url"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    assert.equal(await crypto.subtle.verify("HMAC", key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${claims}`)), true);
    return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
  };
  let delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.read", "pages.edit", "pages.publish", "site.settings.read", "site.settings.write", "cms.read", "cms.edit", "cms.publish", "assets.read", "assets.edit", "assets.upload", "assets.delete", "localization.read", "localization.edit", "localization.review", "localization.translate"]);
  assert.equal(delegated.iss, "niho-web-studio-edit");
  assert.equal(delegated.aud, "kamakura-site");
  assert.equal(delegated.sub, "catalog-contract-test");
  assert.equal(delegated.email, "catalog-test@niho.life", "検証済みのAccess identity emailをホスト監査へ委任する");
  assert.equal(delegated.exp - delegated.iat, 60);
  assert.match(delegated.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  const styleCapabilities = await callEditingApi("/sites/kamakura/capabilities?features=site.styles");
  assert.equal(styleCapabilities.status, 200);
  assert.equal(editingApiRequest.url, "https://kamakura.niho.life/api/edit/v1/sites/kamakura/capabilities?features=site.styles");
  const parsedStyleCapabilities = parseEditingApiDiscovery(await styleCapabilities.json(), "kamakura");
  assert.equal(parsedStyleCapabilities.operations.find(({ id }) => id === "pages.apply").path,
    EDITING_OPERATIONS.find(({ id }) => id === "pages.apply").path);
  assert.ok(parsedStyleCapabilities.operations.some(({ id }) => id === "site.styles.read"));
  const validBindingResponseFactory = bindingResponseFactory;
  bindingResponseFactory = async (request) => {
    const response = await validBindingResponseFactory(request), requestUrl = new URL(request.url);
    if (requestUrl.pathname.endsWith("/capabilities") && requestUrl.search === "?features=site.styles") {
      const body = await response.json();
      return Response.json({ ...body, operations: body.operations.map((operation) => operation.id === "pages.apply"
        ? { ...operation, path: `${operation.path}&unexpected=1` } : operation) });
    }
    return response;
  };
  const invalidStyleCapabilities = await callEditingApi("/sites/kamakura/capabilities?features=site.styles");
  assert.equal(invalidStyleCapabilities.status, 502, "unknown upstream path variants fail closed at the bridge");
  bindingResponseFactory = validBindingResponseFactory;
  assert.deepEqual((await assertDelegationSignature(editingApiRequest)).scope, delegated.scope);
  const styleRead = await callEditingApi("/sites/kamakura/operations/site.styles.read");
  assert.equal(styleRead.status, 200);
  assert.equal((await styleRead.json()).draft.version, "draft-styles-v1");
  assert.deepEqual((await assertDelegationSignature(editingApiRequest)).scope, ["site.settings.read"]);
  const stylePublishInput = { expectedDraftVersion: "draft-styles-v1", expectedPublishedVersion: "published-styles-v1" };
  const stylePublish = await callEditingApi("/sites/kamakura/operations/site.styles.publish", "POST", stylePublishInput);
  assert.equal(stylePublish.status, 200);
  assert.deepEqual(await editingApiRequest.clone().json(), stylePublishInput);
  assert.deepEqual((await assertDelegationSignature(editingApiRequest)).scope, ["site.settings.write", "pages.publish"]);

  const managementBase = "/sites/kamakura/operations";
  const snapshotAccept = "application/json; profile=niho-editor-snapshot-v1";
  const commonPage = await callEditingApi(`${managementBase}/pages.read/community?locale=ja`, "GET", undefined, { Accept: snapshotAccept });
  assert.equal(commonPage.status, 200);
  assert.equal(editingApiRequest.headers.get("Accept"), snapshotAccept);
  assert.equal(commonPage.headers.get("ETag"), '"page-v1"');
  assert.equal(commonPage.headers.get("Cache-Control"), "private, no-cache");
  assert.match(commonPage.headers.get("Server-Timing"), /page-read;dur=12\.5/u);
  assert.match(commonPage.headers.get("Server-Timing"), /auth;dur=/u);
  assert.match(commonPage.headers.get("Server-Timing"), /d1;dur=/u);
  assert.match(commonPage.headers.get("Server-Timing"), /upstream;dur=/u);
  assert.deepEqual(await commonPage.json(), commonSnapshot);
  assert.deepEqual((await assertDelegationSignature(editingApiRequest)).scope, ["pages.read"]);
  const unchangedPage = await callEditingApi(`${managementBase}/pages.read/community?locale=ja`, "GET", undefined,
    { Accept: snapshotAccept, "If-None-Match": '"page-v1"' });
  assert.equal(unchangedPage.status, 304);
  assert.match(unchangedPage.headers.get("Server-Timing"), /page-read;dur=1\.2/u);
  assert.match(unchangedPage.headers.get("Server-Timing"), /upstream;dur=/u);
  assert.equal(editingApiRequest.headers.get("If-None-Match"), '"page-v1"');
  assert.equal(await unchangedPage.text(), "");
  largeReadMode = true;
  const largePage = await callEditingApi(`${managementBase}/pages.read/community?locale=ja`);
  assert.equal(largePage.status, 200);
  assert.ok(largeReadPulls < Math.ceil(largeSnapshotBytes.length / largeChunkSize), "the BFF returns before buffering the 1 MiB upstream document");
  assert.deepEqual(new TextEncoder().encode(await largePage.text()), largeSnapshotBytes);
  const managementChange = { action: "update", target: { siteId: "kamakura", pageId: "community", locale: "ja" }, title: "地域の交流", path: "/community" };
  const managedCatalog = await callEditingApi(`${managementBase}/pages.catalog`, "GET", undefined, { Accept: snapshotAccept });
  assert.equal(managedCatalog.status, 200);
  assert.equal(editingApiRequest.url, `https://kamakura.niho.life/api/edit/v1${managementBase}/pages.catalog`);
  assert.equal(editingApiRequest.headers.get("Accept"), "application/json");
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.read"]);
  const managementPreparePath = `${managementBase}/pages.change-prepare`;
  const managementPrepareInput = { expectedVersion: "registry-v1", operationId: "123e4567-e89b-42d3-a456-426614174000", change: managementChange };
  const managementPlanResponse = await callEditingApi(managementPreparePath, "POST", managementPrepareInput);
  assert.equal(managementPlanResponse.status, 200);
  assert.deepEqual(await editingApiRequest.clone().json(), managementPrepareInput);
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.publish"]);
  const managementPlan = (await managementPlanResponse.json()).plan;
  const managementApplyPath = `${managementBase}/pages.change-apply`;
  const managementApplyInput = { expectedVersion: managementPlan.expectedVersion, operationId: managementPlan.operationId,
    confirmationToken: managementPlan.confirmationToken, change: managementPlan.change };
  assert.equal((await callEditingApi(managementApplyPath, "POST", managementApplyInput)).status, 200);
  assert.deepEqual(await editingApiRequest.clone().json(), managementApplyInput);
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.publish"]);

  const releaseSetItems = [
    { target: { siteId: "kamakura", pageId: "contact", locale: "ja" }, expectedVersion: "page-v1", presentationVersion: "presentation-v1" },
    { target: { siteId: "kamakura", pageId: "business-plan", locale: "ja" }, expectedVersion: "page-v2", presentationVersion: "presentation-v2" }
  ];
  const releaseSetPlanPath = `${managementBase}/pages.release-set-plan`;
  const releaseSetApplyPath = `${managementBase}/pages.release-set`;
  const releaseSetOperationId = "123e4567-e89b-42d3-a456-426614174000";
  const releaseSetConfirmationToken = "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111";
  const releaseSetPlan = { siteId: "kamakura", operationId: releaseSetOperationId, confirmationToken: releaseSetConfirmationToken, domain: "https://kamakura.niho.life", items: releaseSetItems };
  const releaseSetResult = { status: "completed", operationId: releaseSetOperationId, items: releaseSetItems.map(({ target }, index) => ({ target, status: "released", version: `released-${index}` })) };
  bindingResponseFactory = async (request) => {
    editingApiRequest = request;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/pages.release-set-plan")) return Response.json({ plan: releaseSetPlan });
    if (path.endsWith("/pages.release-set-status/" + releaseSetOperationId)) return Response.json({ status: "completed", operationId: releaseSetOperationId, httpStatus: 200, result: releaseSetResult });
    return Response.json(releaseSetResult);
  };
  const releaseSetPlanResponse = await callEditingApi(releaseSetPlanPath, "POST", { siteId: "kamakura", operationId: releaseSetOperationId, items: releaseSetItems });
  assert.equal(releaseSetPlanResponse.status, 200);
  assert.equal(editingApiRequest.url, `https://kamakura.niho.life/api/edit/v1${releaseSetPlanPath}`);
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.publish"]);
  const releaseSetApplyResponse = await callEditingApi(releaseSetApplyPath, "POST", { ...releaseSetPlan, items: releaseSetItems });
  assert.equal(releaseSetApplyResponse.status, 200);
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.publish"]);
  const releaseSetStatusResponse = await callEditingApi(`${managementBase}/pages.release-set-status/${releaseSetOperationId}`);
  assert.equal(releaseSetStatusResponse.status, 200);
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.read"], "operation status does not inherit publish permission");

  const savePath = `/sites/kamakura/operations/pages.save/${"community"}?locale=ja`;
  const saveBody = { expectedVersion: "current-version", document: { schemaVersion: 1, siteId: "kamakura", pageId: "community", locale: "ja", revision: 2, title: "変更前", tokens: {}, body: [] } };
  const saveResponse = await callEditingApi(savePath, "PUT", saveBody);
  assert.equal(saveResponse.status, 200);
  assert.equal(editingApiRequest.url, `https://kamakura.niho.life/api/edit/v1${savePath}`);
  assert.equal(editingApiRequest.method, "PUT");
  assert.equal(editingApiRequest.headers.get("Cookie"), null);
  delegated = await assertDelegationSignature(editingApiRequest);
  assert.deepEqual(delegated.scope, ["pages.edit"]);
  assert.equal(delegated.sub, "catalog-contract-test");
  const saveFetchCount = boundRequestIds.length;
  assert.equal((await callEditingApi(savePath, "PUT", saveBody, { Origin: "https://other.example" })).status, 400);
  assert.equal(boundRequestIds.length, saveFetchCount, "CSRF拒否時はサイトAPIへ転送しない");

  let cmsUpstream;
  bindingResponseFactory = async (request) => {
    cmsUpstream = { url: request.url, method: request.method, body: new Uint8Array(await request.arrayBuffer()), claims: await assertDelegationSignature(request) };
    return Response.json({ status: "accepted" });
  };
  const cmsSchemaResponse = await callEditingApi("/sites/kamakura/operations/cms.schema");
  assert.equal(cmsSchemaResponse.status, 200);
  assert.equal(cmsUpstream.url, "https://kamakura.niho.life/api/edit/v1/sites/kamakura/operations/cms.schema");
  assert.deepEqual(cmsUpstream.claims.scope, ["cms.read"]);
  const largeCmsBody = { expectedVersion: "cms-version", operationId: "123e4567-e89b-42d3-a456-426614174000", values: { body: "x".repeat(700 * 1024) } };
  const cmsSaveResponse = await callEditingApi("/sites/kamakura/operations/cms.save/posts/demo-entry", "PUT", largeCmsBody);
  assert.equal(cmsSaveResponse.status, 200, "CMS本文はページ編集の600 KiB制限より大きくてもBFFを通る");
  assert.deepEqual(cmsUpstream.claims.scope, ["cms.edit"]);
  assert.equal(cmsUpstream.url, "https://kamakura.niho.life/api/edit/v1/sites/kamakura/operations/cms.save/posts/demo-entry");
  assert.equal(JSON.parse(new TextDecoder().decode(cmsUpstream.body)).values.body.length, 700 * 1024);
  const cmsPublishResponse = await callEditingApi("/sites/kamakura/operations/cms.publish-plan/posts/demo-entry", "POST", {
    expectedVersion: "cms-version", operationId: "123e4567-e89b-42d3-a456-426614174001", redirect: false
  });
  assert.equal(cmsPublishResponse.status, 200);
  assert.deepEqual(cmsUpstream.claims.scope, ["cms.publish"]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(cmsUpstream.body)), {
    expectedVersion: "cms-version", operationId: "123e4567-e89b-42d3-a456-426614174001", redirect: false
  });

  const breakpointReadUpstreamPath = "/api/edit/v1/sites/kamakura/operations/site.breakpoints.read";
  const breakpointSaveUpstreamPath = "/api/edit/v1/sites/kamakura/operations/site.breakpoints.save";
  let hostBreakpointSettings = breakpointSettings;
  let hostBreakpointVersion = "host-breakpoints-v1";
  const breakpointRequests = [];
  bindingResponseFactory = async (request) => {
    const path = new URL(request.url).pathname;
    const claims = await assertDelegationSignature(request);
    breakpointRequests.push({ path, method: request.method, claims, body: request.method === "PUT" ? await request.json() : undefined });
    if (path === breakpointReadUpstreamPath && request.method === "GET") {
      return hostBreakpointSettings === undefined
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ settings: hostBreakpointSettings, version: hostBreakpointVersion });
    }
    if (path === breakpointSaveUpstreamPath && request.method === "PUT") {
      const input = breakpointRequests.at(-1).body;
      if (input.expectedVersion !== hostBreakpointVersion) {
        return Response.json({ error: "version_conflict" }, { status: 409 });
      }
      hostBreakpointSettings = input.settings;
      hostBreakpointVersion = "host-breakpoints-v2";
      return Response.json({ status: "saved", version: hostBreakpointVersion });
    }
    throw new Error(`unexpected breakpoint upstream request: ${request.method} ${path}`);
  };
  const breakpointRead = await callEditingApi("/sites/kamakura/operations/site.breakpoints.read");
  assert.equal(breakpointRead.status, 200);
  assert.deepEqual(await breakpointRead.json(), { settings: breakpointSettings, version: "host-breakpoints-v1" });
  assert.deepEqual(breakpointRequests.map(({ path, method }) => [path, method]), [
    [breakpointReadUpstreamPath, "GET"]
  ]);
  assert.deepEqual(breakpointRequests[0].claims.scope, ["site.settings.read"]);

  const nextBreakpointSettings = structuredClone(breakpointSettings);
  nextBreakpointSettings.breakpoints[0].previewWidth = 800;
  const breakpointSave = await callEditingApi("/sites/kamakura/operations/site.breakpoints.save", "PUT", {
    expectedVersion: hostBreakpointVersion, settings: nextBreakpointSettings
  });
  assert.equal(breakpointSave.status, 200);
  assert.deepEqual(await breakpointSave.json(), { status: "saved", version: "host-breakpoints-v2" });
  assert.deepEqual(breakpointRequests.at(-1).claims.scope, ["site.settings.write"]);
  assert.deepEqual(hostBreakpointSettings, nextBreakpointSettings);
  const breakpointReread = await callEditingApi("/sites/kamakura/operations/site.breakpoints.read");
  assert.deepEqual(await breakpointReread.json(), { settings: nextBreakpointSettings, version: "host-breakpoints-v2" });
  assert.equal(breakpointRequests.length, 3);
  hostBreakpointSettings = undefined;
  const missingBreakpoints = await callEditingApi("/sites/kamakura/operations/site.breakpoints.read");
  assert.equal(missingBreakpoints.status, 404);
  assert.equal(breakpointRequests.length, 4, "404から保存を起動しない");
  bindingResponseFactory = null;

  let embedUpstream;
  bindingResponseFactory = async (request) => {
    embedUpstream = { url: request.url, method: request.method, body: await request.json(), signature: request.headers.get("X-NIHO-Studio-Signature") };
    return new Response(JSON.stringify({ status: "draft", refId: `emb_${"1".repeat(32)}`, flow: "rental", version: "fixture-version", verification: "format_only" }), { headers: { "Content-Type": "application/json" } });
  };
  const embed = await workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/embeds/rentalspace/import", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ source: "synthetic iframe input" })
  }), env);
  assert.equal(embed.status, 200); assert.equal((await embed.json()).verification, "format_only");
  assert.deepEqual(embedUpstream.body, { source: "synthetic iframe input" });
  assert.equal(new URL(embedUpstream.url).pathname, "/internal/studio/web-content/embeds/rentalspace/import");
  assert.equal(embedUpstream.method, "POST"); assert.match(embedUpstream.signature, /^v1=[0-9a-f]{64}$/u);
  bindingResponseFactory = null;

  const retryPath = "/api/projects/project-kamakura/sites/kamakura/editor/kamakura-community-dinner/english-publication-retry";
  const callRetry = (body = {}) => workerModule.default.fetch(new Request(`https://studio.niho.life${retryPath}`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body)
  }), env);
  let retryUpstream;
  bindingResponseFactory = async (request) => {
    retryUpstream = { path: new URL(request.url).pathname, method: request.method, body: await request.json(), project: request.headers.get("X-NIHO-Studio-Project"), subject: request.headers.get("X-NIHO-Studio-Subject") };
    return Response.json({ status: "accepted", englishPublication: { state: "queued", retryable: false, updatedAt: "2026-10-27T01:02:03+09:00" } });
  };
  const retryAccepted = await callRetry();
  assert.equal(retryAccepted.status, 200);
  assert.deepEqual(await retryAccepted.json(), { status: "accepted", englishPublication: { state: "queued", retryable: false, updatedAt: "2026-10-26T16:02:03.000Z" } });
  assert.deepEqual(retryUpstream, { path: "/internal/studio/web-content/kamakura-community-dinner/english-publication-retry", method: "POST", body: {}, project: "project-kamakura", subject: "catalog-contract-test" });
  const beforeRemovedSnapshotRead = boundRequestIds.length;
  for (const route of [
    "/api/projects/project-kamakura/sites/kamakura/editor/kamakura-community-dinner",
    "/api/projects/project-kamakura/sites/kamakura/editor/kamakura-community-dinner/presentation"
  ]) {
    assert.equal((await workerModule.default.fetch(new Request(`https://studio.niho.life${route}`, {
      headers: { "Cf-Access-Jwt-Assertion": token }
    }), env)).status, 404);
  }
  assert.equal(boundRequestIds.length, beforeRemovedSnapshotRead, "旧snapshotと分離presentationのreadを上流へ通さない");
  bindingResponseFactory = null;
  const beforeInvalidRetry = boundRequestIds.length;
  assert.equal((await callRetry({ expectedVersion: "must-not-pass" })).status, 400);
  assert.equal(boundRequestIds.length, beforeInvalidRetry, "余計な要求 field は上流へ送らない");
  assert.equal((await workerModule.default.fetch(new Request(`https://studio.niho.life${retryPath}`, { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).status, 405);
  assert.equal((await workerModule.default.fetch(new Request(`https://studio.niho.life${retryPath}?force=true`, {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" }, body: "{}"
  }), env)).status, 400);
  for (const path of [
    "/api/projects/project-kamakura/sites/other/editor/kamakura-community-dinner/english-publication-retry",
    "/api/projects/project-other/sites/kamakura/editor/kamakura-community-dinner/english-publication-retry",
    "/api/projects/project-kamakura/sites/kamakura/editor/catalog/english-publication-retry",
    "/api/projects/project-kamakura/sites/kamakura/editor/Home/english-publication-retry"
  ]) assert.equal((await workerModule.default.fetch(new Request(`https://studio.niho.life${path}`, {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" }, body: "{}"
  }), env)).status, 404);
  bindingResponseFactory = null;

  const assertFailure = async (response, { status, code, category, upstreamStatus, operation = "catalog" }) => {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(body.error, code);
    assert.equal(JSON.stringify(body).includes(env.KAMAKURA_STUDIO_BRIDGE_SECRET), false);
    assert.equal(JSON.stringify(body).includes("catalog-contract-test"), false);
    assert.match(body.supportId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    const log = bridgeLogs.findLast(([, fields]) => fields.supportId === body.supportId);
    assert.ok(log, "the returned support ID must be present in Worker logs");
    assert.deepEqual(log[1], {
      supportId: body.supportId,
      operation,
      category,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus })
    });
    return body.supportId;
  };

  bindingResponseFactory = async () => Response.json({ status: "accepted", englishPublication: { state: "published", retryable: false, internal: "must-not-leak" }, rawUpstream: "must-not-leak" });
  await assertFailure(await callRetry(), { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200, operation: "english_publication_retry" });
  bindingResponseFactory = async () => Response.json({ error: "visual_editor_frozen", internal: "must-not-leak" }, { status: 409 });
  const retryConflict = await callRetry();
  assert.equal(retryConflict.status, 409);
  assert.deepEqual(await retryConflict.json(), { error: "conflict" }, "見た目編集の凍結と英語公開再試行を混同しない");
  bindingResponseFactory = null;

  upstreamResponse = new Response(JSON.stringify(catalog("invalid\u0000title")), { headers: { "Content-Type": "application/json" } });
  const incompatible = await callCatalog();
  assert.equal(incompatible.status, 200, "catalog contract validation is performed once by the browser client");
  assert.equal((await incompatible.json()).pages[0].title, "invalid\u0000title");

  upstreamResponse = new Response("not-json", { headers: { "Content-Type": "text/plain" } });
  const malformed = await callCatalog();
  const malformedId = await assertFailure(malformed, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

  upstreamResponse = new Response("{invalid json", { headers: { "Content-Type": "application/json" } });
  const invalidJson = await callCatalog();
  assert.equal(invalidJson.status, 200, "the catalog body is passed through without Worker-side JSON parsing");
  assert.equal(await invalidJson.text(), "{invalid json");

  upstreamResponse = new Response(JSON.stringify({ error: "conflict" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const unexpectedConflict = await callCatalog();
  await assertFailure(unexpectedConflict, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 409 });

  upstreamResponse = new Response(JSON.stringify({ error: "visual_editor_frozen", message: "凍結中" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const frozenCatalog = await callCatalog();
  assert.equal(frozenCatalog.status, 409);
  assert.deepEqual(await frozenCatalog.json(), { error: "visual_editor_frozen" });

  upstreamResponse = new Response("SENSITIVE_UPSTREAM_BODY", { status: 500 });
  const unavailable = await callCatalog();
  await assertFailure(unavailable, { status: 503, code: "service_unavailable", category: "upstream_server_error", upstreamStatus: 500 });

  upstreamResponse = new Response("ignored", { status: 401 });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "upstream_auth_rejected", upstreamStatus: 401 });

  upstreamResponse = new Response("ignored", { status: 404 });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "catalog_endpoint_missing", upstreamStatus: 404 });

  upstreamResponse = new Response("ignored", { status: 429 });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "upstream_rate_limited", upstreamStatus: 429 });

  upstreamResponse = new Response("asset failure", { status: 500 });
  await assertFailure(await callAssetList(), { status: 503, code: "service_unavailable", category: "upstream_server_error", upstreamStatus: 500, operation: "asset_list" });

  bindingFailure = true;
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "service_binding_failed" });
  bindingFailure = false;

  const timeouts = [];
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => { timeouts.push(milliseconds); queueMicrotask(callback); return 1; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  bindingResponseFactory = (request) => new Response(new ReadableStream({
    start(controller) { request.signal.addEventListener("abort", () => controller.error(new Error("response body aborted")), { once: true }); }
  }), { headers: { "Content-Type": "application/json" } });
  await assertFailure(await callAssetList(), { status: 503, code: "service_unavailable", category: "service_binding_timeout", operation: "asset_list" });
  assert.equal(timeouts.at(-1), 12_000);
  // 公開は commit と読み直しを含むので、ほかの操作より長く待つ（kamakura-site#109）。
  const release = await workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/pages.release/business-plan?locale=ja", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ expectedVersion: "nw2:none:new:none", confirmationToken: "x" })
  }), env);
  await assertFailure(release, { status: 503, code: "service_unavailable", category: "upstream_invalid_response", upstreamStatus: 200, operation: "editing_api" });
  assert.equal(timeouts.at(-1), 30_000);
  bindingResponseFactory = null;

  const missingSecret = await workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/catalog", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), { ...env, KAMAKURA_STUDIO_BRIDGE_SECRET: undefined });
  await assertFailure(missingSecret, { status: 503, code: "service_unavailable", category: "bridge_secret_missing_or_invalid" });

  const serializedLogs = JSON.stringify(bridgeLogs);
  assert.equal(serializedLogs.includes(env.KAMAKURA_STUDIO_BRIDGE_SECRET), false);
  assert.equal(serializedLogs.includes("catalog-contract-test"), false);
  assert.equal(serializedLogs.includes("SENSITIVE_UPSTREAM_BODY"), false);
  assert.equal(serializedLogs.includes("binding failure detail must not be logged"), false);
  assert.equal(serializedLogs.includes("response body aborted"), false);
  assert.equal(boundRequestIds.includes(malformedId), true, "the same support ID must cross the service binding");
  assert.equal(jwksReads, 1);
});

test("鎌倉のページ名操作はホストcapabilityがある時だけ接続し、再読込で最新一覧を取得する", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const source = catalog(), signal = new AbortController().signal;
  assert.equal(createKamakuraAdapter(contract.parseKamakuraCatalog(source), () => {}).preparePageChange, undefined);
  source.pageChangeActions = ["update"]; source.pagePathEditable = false;
  source.pages[0] = { ...source.pages[0], path: "/dinner", kind: "page" };
  source.pages.push({ siteId: "kamakura", pageId: "parenting", locale: "ja", title: "子育て", path: "/parenting", kind: "page" });
  const change = { action: "update", target: { siteId: "kamakura", pageId: source.pages[0].pageId, locale: "ja" }, title: "地域の夕食会", path: "/dinner" };
  const plan = { expectedVersion: "registry-v1", operationId: "123e4567-e89b-42d3-a456-426614174000", change,
    confirmationToken: "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111", domain: "https://next-kamakura.niho.life",
    impact: { before: "https://next-kamakura.niho.life/dinner", after: "https://next-kamakura.niho.life/dinner", linkedFrom: [], navigation: [], notes: [] } };
  const calls = [];
  let returnedPlan = plan, returnedPage = { ...change.target, title: change.title, path: change.path, kind: "page" };
  let latestPages = source.pages, latestVersion = "registry-v1", conflictOnApply = false;
  t.mock.method(globalThis, "fetch", async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, body });
    if (String(path).endsWith("/pages.change-prepare")) return Response.json({ plan: { ...returnedPlan, expectedVersion: body.expectedVersion, operationId: body.operationId, change: body.change } });
    if (String(path).endsWith("/pages.change-apply")) {
      if (conflictOnApply) return Response.json({ error: "version_conflict" }, { status: 409 });
      return Response.json({ status: "applied", operationId: body.operationId, page: returnedPage });
    }
    if (String(path).endsWith("/editor/catalog")) return Response.json({ ...source, pages: latestPages });
    assert.ok(String(path).endsWith("/pages.catalog")); return Response.json({ version: latestVersion, pages: latestPages });
  });
  const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(source), () => {});
  assert.deepEqual(adapter.pageChangeActions, ["update"]); assert.equal(adapter.pagePathEditable, false);
  assert.equal(createKamakuraAdapter(contract.parseKamakuraCatalog({ ...source, pagePathEditable: true }), () => {}).pagePathEditable, true);
  assert.deepEqual(await adapter.listPages("kamakura", signal), source.pages);
  assert.equal(calls.length, 0);
  latestPages = source.pages.map((page) => page.pageId === "parenting" ? { ...page, title: "最新の子育て" } : page);
  await assert.rejects(adapter.preparePageChange(change, signal), (error) => error.code === "version_conflict");
  latestPages = source.pages;
  const prepared = await adapter.preparePageChange(change, signal);
  assert.ok(String(calls[0].path).endsWith("/pages.catalog"));
  assert.deepEqual({ ...prepared, operationId: plan.operationId }, plan);
  assert.match(prepared.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal((await adapter.applyPageChange(prepared, signal)).status, "applied");
  assert.deepEqual(calls.at(-1).body, { expectedVersion: prepared.expectedVersion, operationId: prepared.operationId, confirmationToken: prepared.confirmationToken, change });
  latestPages = [returnedPage];
  latestVersion = "registry-v2";
  await assert.rejects(adapter.preparePageChange(change, signal), (error) => error.code === "version_conflict");
  assert.ok(String(calls.at(-1).path).endsWith("/pages.catalog"), "変更前と現在のメタデータが異なる場合は確認に進まない");
  assert.equal((await adapter.listPages("kamakura", signal))[0].title, change.title);
  const updatedPlan = await adapter.preparePageChange(change, signal);
  assert.equal(updatedPlan.expectedVersion, "registry-v2");
  conflictOnApply = true;
  assert.deepEqual(await adapter.applyPageChange(updatedPlan, signal), { status: "conflict" });
  conflictOnApply = false;
  await assert.rejects(adapter.preparePageChange({ action: "visibility", target: change.target, visibility: "private" }, signal), /利用できません/u);
  await assert.rejects(adapter.preparePageChange({ ...change, target: { ...change.target, locale: "en" } }, signal), /編集対象/u);
  const lifecycle = createKamakuraAdapter(contract.parseKamakuraCatalog({ ...source, pages: latestPages, pageChangeActions: ["update", "create", "visibility"] }), () => {});
  const create = { action: "create", siteId: "kamakura", locale: "ja", title: "新しいページ", path: "/new-page" };
  returnedPlan = { ...plan, change: create, impact: { linkedFrom: [], navigation: [], notes: [] } };
  returnedPage = { siteId: "kamakura", pageId: "new-page", locale: "ja", title: create.title, path: create.path, kind: "page", published: false };
  const createPlan = await lifecycle.preparePageChange(create, signal);
  assert.deepEqual(await lifecycle.applyPageChange(createPlan, signal), { status: "applied", page: returnedPage });
  returnedPage = { ...returnedPage, published: true };
  await assert.rejects(lifecycle.applyPageChange(createPlan, signal), /操作の結果/u);

  const hide = { action: "visibility", target: change.target, visibility: "private" };
  returnedPlan = { ...plan, change: hide };
  returnedPage = { ...change.target, title: change.title, path: change.path, kind: "page", visibility: "private", published: true };
  const hidePlan = await lifecycle.preparePageChange(hide, signal);
  assert.deepEqual(await lifecycle.applyPageChange(hidePlan, signal), { status: "applied", page: returnedPage });
});


test("公開確認と公開はcatalogの現在のドメインに限定し、切替前後の取り違えを拒否する", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const input = { target: { siteId: "kamakura", pageId: "kamakura-community-dinner", locale: "ja" }, expectedVersion: "ja-version", presentationVersion: "presentation-version", action: "publish" };
  const token = "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111";
  let reply, calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(reply); });
  for (const origin of ["https://next-kamakura.niho.life", "https://kamakura.niho.life"]) {
    const source = catalog();
    source.project.site.domains = [origin];
    const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(source), () => {}), signal = new AbortController().signal;
    reply = { plan: { ...input, confirmationToken: token, domain: origin, changes: [] } };
    assert.equal((await adapter.prepareRelease(input, signal)).domain, origin);
    const other = origin.includes("next-") ? "https://kamakura.niho.life" : "https://next-kamakura.niho.life";
    reply = { plan: { ...reply.plan, domain: other } };
    await assert.rejects(adapter.prepareRelease(input, signal), /ドメインが一致しません/);
    const before = calls;
    await assert.rejects(adapter.release(reply, signal), /公開確認が不正/);
    assert.equal(calls, before, "別ドメインのplanはサーバーへ送らない");
  }
});
