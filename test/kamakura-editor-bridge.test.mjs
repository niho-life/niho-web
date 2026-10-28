// Kamakura は凍結中も読み取りを通す（kamakura-site#84）。BFF の上流失敗の分類と、凍結中の 409 を競合と分ける扱いを守る。
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

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
  const site = { id: "kamakura", name: "鎌倉サイト（新サイト確認用）", domains: ["https://next-kamakura.niho.life"] };
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

test("Kamakura editor adapter は日本語経路を維持し、英語 snapshot・overlay 保存・翻訳操作を localization BFF に限定する", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const parsedCatalog = contract.parseKamakuraCatalog(catalog());
  const pageId = "kamakura-community-dinner";
  const document = (id, locale, title = id) => ({ schemaVersion: 1, siteId: "kamakura", pageId: id, locale, revision: 2, title, tokens: {}, body: [] });
  const presentation = { schemaVersion: 1, siteId: "kamakura", locale: "en", version: "presentation-1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: document("site-header", "en"), footer: document("site-footer", "en") } };
  const versions = { expectedSourceVersion: `p.${"a".repeat(64)}`, expectedVersion: `l.${"b".repeat(64)}`, expectedOverlayVersion: 1 };
  const config = { schemaVersion: 1, siteId: "kamakura", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"], documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "g1", contextVersion: "c1" };
  const overlay = { schemaVersion: 1, siteId: "kamakura", pageId, sourceLocale: "ja", targetLocale: "en", version: 1, entries: [] };
  const localizedPage = { siteId: "kamakura", pageId, title: "Community Dinner", locales: { ja: { state: "source" }, en: { state: "review-needed", changed: 1, published: false } } };
  const normalizedLocalizedPage = { ...localizedPage, title: parsedCatalog.pages[0].title };
  const englishPublication = { state: "retryable-failure", retryable: true, updatedAt: "2026-10-27T01:02:03.000Z" };
  const breakpointSettings = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "Small", minWidth: 991, previewWidth: 991 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const releasePlan = { target: { siteId: "kamakura", pageId, locale: "ja" }, expectedVersion: "ja-version", presentationVersion: "presentation-version", action: "publish",
    confirmationToken: "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111", domain: "https://next-kamakura.niho.life", changes: [] };
  const replies = new Map([
    ["GET /api/projects/project-kamakura/sites/kamakura/breakpoints", { settings: breakpointSettings, version: "b.1" }],
    ["PUT /api/projects/project-kamakura/sites/kamakura/breakpoints", { status: "saved", version: "b.2" }],
    [`GET /api/projects/project-kamakura/sites/kamakura/editor/${pageId}`, { document: document(pageId, "ja"), version: "ja-version", englishPublication }],
    [`POST /api/projects/project-kamakura/sites/kamakura/editor/${pageId}/english-publication-retry`, { status: "accepted", englishPublication: { state: "queued", retryable: false } }],
    [`POST /api/projects/project-kamakura/sites/kamakura/editor/${pageId}/release`, { status: "released", snapshot: { document: document(pageId, "ja"), version: "released-version", englishPublication: { state: "publishing", retryable: false } } }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/site`, { status: "ready", config, pages: [localizedPage], version: `s.${"c".repeat(64)}` }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}`, { status: "ready", sourceDocument: document(pageId, "ja-JP"), sourceVersion: versions.expectedSourceVersion, overlay, version: versions.expectedVersion }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/snapshot`, { status: "ready", document: document(pageId, "en", "Community Dinner"), version: versions.expectedVersion, presentation }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/save`, { status: "saved", version: `l.${"d".repeat(64)}`, revision: 3 }],
    [`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/command`, { status: "applied", version: `l.${"e".repeat(64)}` }]
  ]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, init = {}) => {
    const key = `${init.method ?? "GET"} ${String(path)}`, body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ key, body });
    const reply = replies.get(key);
    if (!reply) throw new Error(`unexpected request: ${key}`);
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const adapter = createKamakuraAdapter(parsedCatalog, () => {}), signal = new AbortController().signal;
  const ja = { siteId: "kamakura", pageId, locale: "ja" }, en = { siteId: "kamakura", pageId, locale: "en" };

  const japanese = await adapter.readDocument(ja, signal);
  assert.equal(japanese.document.locale, "ja");
  assert.deepEqual(japanese.englishPublication, englishPublication);
  assert.deepEqual(await adapter.breakpointSettings.read("kamakura", signal), { settings: breakpointSettings, version: "b.1" });
  assert.deepEqual(await adapter.breakpointSettings.save({ siteId: "kamakura", settings: breakpointSettings, expectedVersion: "b.1" }, signal), { status: "saved", version: "b.2" });
  assert.deepEqual(calls.at(-1).body, { settings: breakpointSettings, expectedVersion: "b.1" });
  const english = await adapter.readDocument(en, signal);
  assert.equal(english.document.locale, "en");
  assert.equal(english.presentation.version, presentation.version);
  assert.deepEqual(await adapter.localization.readSite("kamakura", signal), { config, pages: [normalizedLocalizedPage], version: `s.${"c".repeat(64)}` });
  assert.deepEqual(await adapter.localization.readPage(en, signal), { sourceDocument: document(pageId, "ja-JP"), sourceVersion: versions.expectedSourceVersion, overlay, version: versions.expectedVersion });
  const saved = await adapter.saveDraft({ target: en, document: english.document, expectedVersion: versions.expectedVersion, presentationVersion: presentation.version, localization: versions }, signal);
  assert.equal(saved.status, "saved");
  const saveCall = calls.at(-1);
  assert.deepEqual(saveCall.body, { document: english.document, ...versions }, "presentationVersion と target は BFF の allowlist へ混ぜない");
  assert.deepEqual(await adapter.localization.command({ action: "review-current", target: en, unitId: "page.title", ...versions }, signal), { status: "applied", version: `l.${"e".repeat(64)}` });
  assert.deepEqual(await adapter.englishPublication.refresh(ja, signal), englishPublication);
  assert.deepEqual(await adapter.englishPublication.retry(ja, signal), { status: "accepted", englishPublication: { state: "queued", retryable: false } });
  assert.deepEqual(calls.at(-1).body, {}, "再試行本文は空の object だけ");
  const released = await adapter.release(releasePlan, signal);
  assert.deepEqual(released.snapshot.englishPublication, { state: "publishing", retryable: false }, "日本語 release の snapshot から英語公開状態を伝える");
  const before = calls.length;
  await assert.rejects(adapter.localization.command({ action: "request-translation", target: en, ...versions }, signal), /まだ対応していません/u);
  assert.equal(calls.length, before, "未対応の翻訳依頼を成功扱いせず BFF にも送らない");
  await assert.rejects(adapter.saveDraft({ target: en, document: english.document, expectedVersion: `l.${"f".repeat(64)}`, presentationVersion: presentation.version, localization: versions }, signal), /版が正しくありません/u);
  assert.equal(calls.length, before);

  replies.set("PUT /api/projects/project-kamakura/sites/kamakura/breakpoints", Response.json({ error: "conflict" }, { status: 409 }));
  assert.deepEqual(await adapter.breakpointSettings.save({ siteId: "kamakura", settings: breakpointSettings, expectedVersion: "b.1" }, signal), { status: "conflict" });
  replies.set("GET /api/projects/project-kamakura/sites/kamakura/breakpoints", { settings: breakpointSettings, version: "b.2", extra: true });
  await assert.rejects(adapter.breakpointSettings.read("kamakura", signal), /応答が正しくありません/u);

  replies.set(`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/snapshot`, { status: "unavailable", message: "このページの英語表示材料はまだありません。" });
  await assert.rejects(adapter.readDocument(en, signal), /英語表示材料/u);
  replies.set(`POST /api/projects/project-kamakura/sites/kamakura/localization/editor/pages/${pageId}/snapshot`, { status: "conflict" });
  await assert.rejects(adapter.readDocument(en, signal), (error) => error.status === 409);
  replies.set(`GET /api/projects/project-kamakura/sites/kamakura/editor/${pageId}`, { document: document(pageId, "ja"), version: "ja-version", englishPublication: { ...englishPublication, internal: "secret" } });
  await assert.rejects(adapter.readDocument(ja, signal), /英語公開状態が正しくありません/u);
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
  const workerModule = await loadStudioWorker();
  let upstreamResponse = new Response(JSON.stringify(catalog(communityDinnerTitle)), { headers: { "Content-Type": "application/json" } });
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

  const env = {
    DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ allowed: 1 }) }) },
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

  const callCatalog = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/catalog", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), env);
  const callPage = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/kamakura-community-dinner", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), env);
  const callAssetList = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/assets/list", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ siteId: "kamakura", search: "", kind: "all", folderId: null, limit: 60 })
  }), env);

  const accepted = await callCatalog();
  assert.equal(accepted.status, 200);
  const acceptedCatalog = await accepted.json();
  assert.equal(acceptedCatalog.pages[0].title, communityDinnerTitle);
  assert.deepEqual(acceptedCatalog.blockContracts, catalog().blockContracts);
  assert.match(boundRequestIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  const pageChange = { action: "update", target: { siteId: "kamakura", pageId: "community", locale: "ja" }, title: "地域のコミュニティ", path: "/community" };
  let pageChangeUpstream;
  bindingResponseFactory = async (request) => {
    pageChangeUpstream = { path: new URL(request.url).pathname, body: await request.json(), signature: request.headers.get("X-NIHO-Studio-Signature") };
    return Response.json({ status: "fixture" });
  };
  const callPageChange = (body, headers = {}) => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/page-changes/prepare", {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin", ...headers }, body: JSON.stringify(body)
  }), env);
  assert.equal((await callPageChange({ change: pageChange })).status, 200);
  assert.deepEqual(pageChangeUpstream.body, { change: pageChange });
  assert.equal(pageChangeUpstream.path, "/internal/studio/web-content/_site/page-changes/prepare");
  assert.match(pageChangeUpstream.signature, /^v1=[0-9a-f]{64}$/u);
  assert.equal((await callPageChange({ change: pageChange, impact: {} })).status, 400);
  assert.equal((await callPageChange({ change: pageChange }, { Origin: "https://other.example" })).status, 400);
  assert.equal((await callPageChange({ change: pageChange }, { "Cf-Access-Jwt-Assertion": "" })).status, 401);
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
  const incompatibleId = await assertFailure(incompatible, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

  upstreamResponse = new Response("not-json", { headers: { "Content-Type": "text/plain" } });
  const malformed = await callCatalog();
  await assertFailure(malformed, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

  upstreamResponse = new Response("{invalid json", { headers: { "Content-Type": "application/json" } });
  const invalidJson = await callCatalog();
  await assertFailure(invalidJson, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

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

  upstreamResponse = new Response("unexpected method", { status: 405 });
  await assertFailure(await callPage(), { status: 503, code: "service_unavailable", category: "upstream_unexpected_4xx", upstreamStatus: 405, operation: "page_read" });

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
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "service_binding_timeout" });
  assert.equal(timeouts.at(-1), 12_000);
  // 公開は commit と読み直しを含むので、ほかの操作より長く待つ（kamakura-site#109）。
  const release = await workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/business-plan/release", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ expectedVersion: "nw2:none:new:none", confirmationToken: "x" })
  }), env);
  await assertFailure(release, { status: 503, code: "service_unavailable", category: "service_binding_timeout", operation: "release" });
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
  assert.equal(boundRequestIds.includes(incompatibleId), true, "the same support ID must cross the service binding");
  assert.equal(jwksReads, 1);
});

test("鎌倉のページ名操作はホストcapabilityがある時だけ接続し、再読込で最新一覧を取得する", async (t) => {
  const { createKamakuraAdapter } = await loadKamakuraEditor();
  const source = catalog(), signal = new AbortController().signal;
  assert.equal(createKamakuraAdapter(contract.parseKamakuraCatalog(source), () => {}).preparePageChange, undefined);
  source.pageChangeActions = ["update"]; source.pagePathEditable = false;
  source.pages[0] = { ...source.pages[0], path: "/dinner", kind: "page" };
  const change = { action: "update", target: { siteId: "kamakura", pageId: source.pages[0].pageId, locale: "ja" }, title: "地域の夕食会", path: "/dinner" };
  const plan = { change, confirmationToken: "00000000-0000-4000-8000-00000000000011111111-1111-4111-8111-111111111111", domain: "https://next-kamakura.niho.life", impact: { before: "https://next-kamakura.niho.life/dinner", after: "https://next-kamakura.niho.life/dinner", linkedFrom: [], navigation: [], notes: [] } };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, body });
    if (String(path).endsWith("/prepare")) return Response.json(plan);
    if (String(path).endsWith("/apply")) return Response.json({ status: "applied", page: { ...change.target, title: change.title, path: change.path, kind: "page" } });
    assert.ok(String(path).endsWith("/catalog")); return Response.json({ ...source, pages: [{ ...source.pages[0], title: change.title }] });
  });
  const adapter = createKamakuraAdapter(contract.parseKamakuraCatalog(source), () => {});
  assert.deepEqual(adapter.pageChangeActions, ["update"]); assert.equal(adapter.pagePathEditable, false);
  assert.deepEqual(await adapter.preparePageChange(change, signal), plan);
  assert.equal((await adapter.applyPageChange(plan, signal)).status, "applied");
  assert.deepEqual(calls.at(-1).body, { change, confirmationToken: plan.confirmationToken });
  assert.equal((await adapter.listPages("kamakura", signal))[0].title, change.title);
  await assert.rejects(adapter.preparePageChange({ action: "visibility", target: change.target, visibility: "private" }, signal), /利用できません/u);
  await assert.rejects(adapter.preparePageChange({ ...change, target: { ...change.target, locale: "en" } }, signal), /編集対象/u);
});
