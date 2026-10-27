import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import {
  parseLocaleReleaseApplyResult, parseLocaleReleasePrepareResult, parseLocaleReleaseStateResult, parseLocalizationCatalogResult, parseLocalizationCommandResult,
  parseLocalizationImageResult, parseLocalizationItemResult, parseLocalizationJobResult, parseLocalizationListResult, parseLocalizationOverviewResult,
  parseLocalizationPreviewResult, parseLocalizationSettingsResult, parseLocalizationTranslationResult
} from "@niho/web/localization-workspace-model";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";

// 架空の値だけを使う（実在の原稿・人・内部の key は書かない）。上流の応答の形は W1 のデモ用のメモリの adapter から作る。
const BASE = "/api/projects/project-kamakura/sites/kamakura/localization";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UPLOAD_URL = `https://next-kamakura.niho.life/internal/studio/localization-upload/${UUID}`;
const MEDIA = "https://kamakura-media.niho.life/uploads/2026/10/aaaaaaaaaaaaaa.png";
const OP = "op_0123456789abcdef";
const JOB = `g${"0".repeat(32)}`;
const signal = () => new AbortController().signal;
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const b64 = (text) => Buffer.from(text).toString("base64url");

async function loadAdapter() {
  const result = await build({ entryPoints: [new URL("../studio/kamakura-localization.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}

async function loadContract() {
  const result = await build({ entryPoints: [new URL("../studio/kamakura-localization-contract.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}

test("CMS の項目から翻訳の itemKey を作り、同じ原文の項目に戻せる", async () => {
  const { kamakuraCmsLocalizationItemKey, kamakuraLocalizationCmsSource } = await loadContract();
  const key = kamakuraCmsLocalizationItemKey("posts", "morning-walk");
  assert.equal(key, b64("cms:posts:morning-walk"));
  assert.deepEqual(kamakuraLocalizationCmsSource(key), { collectionId: "posts", itemId: "morning-walk" });
  assert.equal(kamakuraCmsLocalizationItemKey("posts", "../bad"), null);
  assert.equal(kamakuraCmsLocalizationItemKey("p".repeat(40), "x".repeat(128)), null, "Worker の一覧に入らない長さはリンクしない");
});

/** 偽の BFF。routes の `${method} ${path}` に合う関数の戻り値を応答にする。 */
function fakeBff(t, routes) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).startsWith(BASE) ? String(url).slice(BASE.length) : String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body, init });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${path}`);
    return handler(body, calls.length);
  });
  return calls;
}

async function fixtures() {
  const memory = createLocalizationMemory({ frameUrl: "https://next-kamakura.niho.life/_studio/localization-preview", glossary: true });
  const s = signal();
  const item = await memory.adapter.loadItem({ itemKey: "aG9tZQ" }, s);
  const { units: _units, previews: _previews, job: _job, ...summary } = item.item;
  return {
    overview: await memory.adapter.loadOverview(s), list: await memory.adapter.listItems({ cursor: null }, s), item,
    release: await memory.adapter.readRelease(s), settings: await memory.adapter.saveSettings({ expectedVersion: "set1", autoDraft: false }, s),
    applied: { status: "applied", unit: item.item.units[0], summary }
  };
}

test("翻訳 adapter: 各メソッドは同一 origin の BFF を契約の経路と本文で呼び、応答を W1 の parser に通す", async (t) => {
  const { createKamakuraLocalizationAdapter } = await loadAdapter();
  const data = await fixtures();
  const command = { itemKey: "aG9tZQ", operationId: OP, action: "set-value", unitId: "title", expectedVersion: "v1", expectedSourceVersion: "s1", value: "Workshop" };
  const prepare = { operation: "publish", releaseId: null, expectedVersion: "o1", expectedCurrentVersion: "r2", resumeToken: null };
  const replies = {
    "POST /overview": () => jsonResponse(data.overview),
    "POST /items": () => jsonResponse(data.list),
    "POST /items/after/p2": () => jsonResponse({ status: "ready", items: [], nextCursor: null }),
    "POST /items/aG9tZQ": () => jsonResponse(data.item),
    "POST /items/aG9tZQ/command": () => jsonResponse(data.applied),
    "POST /items/aG9tZQ/translate": () => jsonResponse({ status: "queued", job: { jobId: JOB, state: "queued", message: null } }),
    [`POST /jobs/${JOB}`]: () => jsonResponse({ status: "ready", job: { jobId: JOB, state: "done", message: null } }),
    "POST /catalog/advance": () => jsonResponse({ status: "current" }),
    "POST /preview/items": () => jsonResponse({ status: "ready", material: { part: "page", title: "トップ" }, nextCursor: "c1" }),
    "POST /release": () => jsonResponse(data.release),
    "POST /release/prepare": () => jsonResponse({ status: "preparing", progress: { done: 1, total: 3 }, resumeToken: "prep-1" }),
    "POST /release/apply": () => jsonResponse({ status: "applying", progress: { done: 1, total: 2 }, resumeToken: "apply-1" }),
    "PUT /settings": () => jsonResponse(data.settings)
  };
  const calls = fakeBff(t, replies);
  const adapter = createKamakuraLocalizationAdapter();
  const s = signal();

  for (const [run, method, path, body, parse] of [
    [() => adapter.loadOverview(s), "POST", "/overview", {}, parseLocalizationOverviewResult],
    [() => adapter.listItems({ cursor: null }, s), "POST", "/items", {}, parseLocalizationListResult],
    [() => adapter.listItems({ cursor: "p2" }, s), "POST", "/items/after/p2", {}, parseLocalizationListResult],
    [() => adapter.loadItem({ itemKey: "aG9tZQ" }, s), "POST", "/items/aG9tZQ", {}, (value) => parseLocalizationItemResult(value, "aG9tZQ")],
    [() => adapter.command(command, s), "POST", "/items/aG9tZQ/command", command, (value) => parseLocalizationCommandResult(value, { itemKey: "aG9tZQ", unitId: "title" })],
    [() => adapter.requestTranslation({ itemKey: "aG9tZQ", operationId: OP, unitIds: null }, s), "POST", "/items/aG9tZQ/translate", { itemKey: "aG9tZQ", operationId: OP, unitIds: null }, parseLocalizationTranslationResult],
    [() => adapter.readJob({ jobId: JOB }, s), "POST", `/jobs/${JOB}`, {}, (value) => parseLocalizationJobResult(value, JOB)],
    [() => adapter.advanceCatalog({}, s), "POST", "/catalog/advance", {}, parseLocalizationCatalogResult],
    [() => adapter.loadPreview({ itemKey: "aG9tZQ", previewId: "home", cursor: null }, s), "POST", "/preview/items", { itemKey: "aG9tZQ", previewId: "home", cursor: null }, parseLocalizationPreviewResult],
    [() => adapter.readRelease(s), "POST", "/release", {}, parseLocaleReleaseStateResult],
    [() => adapter.prepareRelease(prepare, s), "POST", "/release/prepare", prepare, (value) => parseLocaleReleasePrepareResult(value, prepare)],
    [() => adapter.applyRelease({ confirmationToken: "c1", resumeToken: null }, s), "POST", "/release/apply", { confirmationToken: "c1", resumeToken: null }, (value) => parseLocaleReleaseApplyResult(value, { prepared: null })],
    [() => adapter.saveSettings({ expectedVersion: "set1", autoDraft: false }, s), "PUT", "/settings", { expectedVersion: "set1", autoDraft: false }, parseLocalizationSettingsResult],
    [() => adapter.saveSettings({ expectedVersion: "set2", reviewGlossaryVersion: "demo-glossary-v1" }, s), "PUT", "/settings", { expectedVersion: "set2", reviewGlossaryVersion: "demo-glossary-v1" }, parseLocalizationSettingsResult]
  ]) {
    const result = await run();
    const call = calls.at(-1);
    assert.equal(call.method, method, path);
    assert.equal(call.path, path);
    assert.deepEqual(call.body, body, path);
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.headers["Content-Type"], "application/json");
    // 画面の parser がそのまま読める（adapter は確かめた形を返す）
    assert.deepEqual(parse(result), result, path);
  }
  // 任意のメソッドは、ホストが渡したときだけ
  assert.equal(adapter.pickAsset, undefined);
  assert.equal(adapter.sourceLink, undefined);
});

test("翻訳 adapter: 本文の status は parser へ、BFF の 403 は forbidden、ほかの失敗と契約に合わない応答は例外", async (t) => {
  const { createKamakuraLocalizationAdapter, KamakuraLocalizationRequestError } = await loadAdapter();
  const data = await fixtures();
  let overview = () => jsonResponse({ status: "forbidden" }, 403);
  let item = () => jsonResponse({ status: "not_found" }, 404);
  fakeBff(t, { "POST /overview": () => overview(), "POST /items/aG9tZQ": () => item() });
  const adapter = createKamakuraLocalizationAdapter();

  assert.deepEqual(await adapter.loadOverview(signal()), { status: "forbidden" });
  assert.deepEqual(await adapter.loadItem({ itemKey: "aG9tZQ" }, signal()), { status: "not_found" });
  overview = () => jsonResponse({ error: "forbidden" }, 403);
  assert.deepEqual(await adapter.loadOverview(signal()), { status: "forbidden" }, "所属の無い人の BFF の 403");
  for (const [reply, status] of [[{ error: "not_found" }, 404], [{ error: "service_unavailable", supportId: "123e4567-e89b-42d3-a456-426614174000" }, 503], [{ error: "session_expired" }, 401]]) {
    item = () => jsonResponse(reply, status);
    await assert.rejects(adapter.loadItem({ itemKey: "aG9tZQ" }, signal()), (error) => error instanceof KamakuraLocalizationRequestError && error.status === status && error.supportId === (reply.supportId ?? null));
  }
  item = () => new Response("<html>", { status: 502, headers: { "Content-Type": "text/html" } });
  await assert.rejects(adapter.loadItem({ itemKey: "aG9tZQ" }, signal()), (error) => error instanceof KamakuraLocalizationRequestError && error.status === 502);
  // 契約に合わない応答（別の 1 件・未知の field）は parser が拒む
  item = () => jsonResponse({ status: "ready", item: { ...data.item.item, key: "YWJvdXQ" } });
  await assert.rejects(adapter.loadItem({ itemKey: "aG9tZQ" }, signal()));
  overview = () => jsonResponse({ ...data.overview, extra: true });
  await assert.rejects(adapter.loadOverview(signal()));
  // 形の違う指定は BFF を呼ばない
  await assert.rejects(adapter.loadItem({ itemKey: "a/b" }, signal()));
  await assert.rejects(adapter.listItems({ cursor: "a/b" }, signal()));
  await assert.rejects(adapter.readJob({ jobId: "a/b" }, signal()));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(adapter.loadOverview(aborted.signal), (error) => error.name === "AbortError");
});

test("翻訳 adapter: 画像は intent の URL を確かめてから credentials なしで直接 PUT し、W1 の uploaded を返す。拒否は理由つき", async (t) => {
  const { createKamakuraLocalizationAdapter } = await loadAdapter();
  const uploaded = { status: "uploaded", image: { asset: { kind: "image-url", src: MEDIA }, url: MEDIA } };
  let intentReply = () => jsonResponse({ uploadUrl: UPLOAD_URL, uploadToken: "token.value", uploadId: UUID }, 201);
  let putReply = () => jsonResponse(uploaded, 201);
  const calls = fakeBff(t, { "POST /uploads/intent": () => intentReply(), [`PUT ${UPLOAD_URL}`]: () => putReply() });
  const adapter = createKamakuraLocalizationAdapter();
  const file = new File([new Uint8Array(32)], "海\n.png", { type: "image/png" });

  const result = await adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file }, signal());
  assert.deepEqual(parseLocalizationImageResult(result), uploaded);
  assert.deepEqual(calls[0].body, { itemKey: "aG9tZQ", unitId: "cover", name: "海.png", mimeType: "image/png", bytes: 32 });
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].init.credentials, "omit", "Access の Cookie を鎌倉の Worker へ送らない");
  assert.equal(calls[1].init.mode, "cors");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.referrerPolicy, "no-referrer");
  assert.equal(calls[1].init.headers.Authorization, "Bearer token.value");
  assert.equal(calls[1].init.headers["Content-Type"], "image/png");
  assert.equal(calls[1].body, file);

  // 行き先が違う intent では PUT しない
  for (const bad of [
    { uploadUrl: `https://evil.example/internal/studio/localization-upload/${UUID}`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `https://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `${UPLOAD_URL}#x`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: UPLOAD_URL, uploadToken: "t", uploadId: "123e4567-e89b-42d3-a456-426614174001" },
    { uploadUrl: UPLOAD_URL, uploadToken: "t", uploadId: UUID, extra: true }
  ]) {
    intentReply = () => jsonResponse(bad, 201);
    const before = calls.length;
    await assert.rejects(adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file }, signal()));
    assert.equal(calls.length, before + 1, "intent だけ呼び、PUT しない");
  }
  intentReply = () => jsonResponse({ uploadUrl: UPLOAD_URL, uploadToken: "token.value", uploadId: UUID }, 201);
  for (const reply of [
    { status: "uploaded", image: { asset: { kind: "asset", asset: { provider: "kamakura-upload", id: UUID } }, url: MEDIA } },
    { status: "picked", image: uploaded.image },
    { url: MEDIA, width: 1, height: 1 }
  ]) {
    putReply = () => jsonResponse(reply, 201);
    await assert.rejects(adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file }, signal()));
  }

  // 拒否
  const before = calls.length;
  assert.deepEqual(await adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file: new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }) }, signal()), { status: "rejected", reason: "type" });
  assert.deepEqual(await adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file: new File([], "a.png", { type: "image/png" }) }, signal()), { status: "rejected", reason: "invalid" });
  assert.equal(calls.length, before, "形式・大きさが合わなければ BFF を呼ばない");
  for (const [reply, status, reason] of [
    [{ status: "forbidden" }, 403, "permission"], [{ error: "forbidden" }, 403, "permission"], [{ status: "not_found" }, 404, "invalid"],
    [{ status: "invalid", message: "この項目は画像ではありません。" }, 200, "invalid"], [{ error: "image_rejected" }, 413, "size"], [{ error: "image_rejected" }, 415, "type"], [{ error: "invalid_request" }, 400, "invalid"]
  ]) {
    intentReply = () => jsonResponse(reply, status);
    assert.deepEqual(await adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file }, signal()), { status: "rejected", reason }, JSON.stringify(reply));
  }
  intentReply = () => jsonResponse({ uploadUrl: UPLOAD_URL, uploadToken: "token.value", uploadId: UUID }, 201);
  for (const [status, reason] of [[413, "size"], [415, "type"]]) {
    putReply = () => jsonResponse({ error: "x" }, status);
    assert.deepEqual(await adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file }, signal()), { status: "rejected", reason });
  }
  putReply = () => jsonResponse({ error: "used" }, 409);
  await assert.rejects(adapter.uploadImage({ itemKey: "aG9tZQ", unitId: "cover", file }, signal()), (error) => error.name === "KamakuraLocalizationRequestError" && error.status === 409);
});

test("翻訳 adapter: 素材から選んだ画像は鎌倉の公開画像だけ { kind: \"image-url\", src } で返し、原文へのリンクは CMS の項目だけ", async () => {
  const { createKamakuraLocalizationAdapter } = await loadAdapter();
  const chosen = [];
  let pick = MEDIA;
  const adapter = createKamakuraLocalizationAdapter({
    chooseImage: async (input) => { chosen.push(input); return pick; },
    cmsItemUrl: (collectionId, itemId) => `/projects/kamakura-site/admin/cms/${collectionId}/${itemId}`,
    cmsTranslationUrl: (collectionId, itemId) => `/projects/kamakura-site/admin/cms/${collectionId}/${itemId}?lang=en`,
    pageTranslationUrl: (pageId) => `/projects/kamakura-site/admin/editor?page=${pageId}&lang=en`
  });
  assert.deepEqual(parseLocalizationImageResult(await adapter.pickAsset({ itemKey: "aG9tZQ", unitId: "cover" }, signal())), { status: "picked", image: { asset: { kind: "image-url", src: MEDIA }, url: MEDIA } });
  assert.deepEqual(chosen, [{ itemKey: "aG9tZQ", unitId: "cover" }]);
  pick = null;
  assert.deepEqual(await adapter.pickAsset({ itemKey: "aG9tZQ", unitId: "cover" }, signal()), { status: "cancelled" });
  for (const url of ["https://cdn.example.test/a.png", "http://kamakura-media.niho.life/uploads/a.png", "https://kamakura-media.niho.life/uploads/a.png?x=1", "https://kamakura-media.niho.life/cdn-cgi/image/width=1/a.png", "/uploads/a.png"]) {
    pick = url;
    assert.deepEqual(await adapter.pickAsset({ itemKey: "aG9tZQ", unitId: "cover" }, signal()), { status: "rejected", reason: "invalid" }, url);
  }

  // CMS の項目の 1 件だけ Studio の CMS へ。固定ページなどの原文はコードで管理なので出さない
  assert.equal(adapter.sourceLink(b64("cms:posts:morning-walk")), "/projects/kamakura-site/admin/cms/posts/morning-walk");
  assert.equal(adapter.editLink(b64("cms:posts:morning-walk")), "/projects/kamakura-site/admin/cms/posts/morning-walk?lang=en");
  assert.equal(adapter.editLink(b64("common:home")), "/projects/kamakura-site/admin/editor?page=home&lang=en");
  assert.equal(adapter.editLink(b64("common:site-header")), "/projects/kamakura-site/admin/editor?page=site-header&lang=en");
  assert.equal(adapter.sourceLink(b64("cms:circles:海の会")), null, "CMS の項目の id の形でないものは出さない");
  for (const key of [b64("page:about"), b64("part:footer"), b64("list:news"), b64("cms:Posts:x"), b64("cms:posts:a:b"), b64("cms:posts"), b64("common:../admin"), b64("common:catalog"), "aG9tZQ", "%%%", "a"]) {
    assert.equal(adapter.sourceLink(key), null, key);
    assert.equal(adapter.editLink(key), null, key);
  }
});

test("翻訳 adapter: サイトの中の画像（\"/\" から始まる）は、表示用の URL だけサイトの公開 origin の絶対 URL にする", async (t) => {
  const { createKamakuraLocalizationAdapter } = await loadAdapter();
  const data = await fixtures();
  const local = { asset: { kind: "image-url", src: "/images/cover-ja.jpg" }, url: "/images/cover-ja.jpg" };
  const units = data.item.item.units.map((unit) => unit.kind === "image" ? { ...unit, state: "draft", source: local, value: { asset: { kind: "image-url", src: "/images/cover-en.jpg" }, url: "/images/cover-en.jpg" } } : unit);
  const image = units.find((unit) => unit.kind === "image");
  fakeBff(t, {
    "POST /items/aG9tZQ": () => jsonResponse({ status: "ready", item: { ...data.item.item, units } }),
    "POST /items/aG9tZQ/command": () => jsonResponse({ ...data.applied, unit: image })
  });
  const command = { itemKey: "aG9tZQ", operationId: OP, action: "review-image", unitId: image.unitId, expectedVersion: "v1", expectedSourceVersion: "s1" };

  const withSite = createKamakuraLocalizationAdapter({ siteOrigin: "https://site.example.test" });
  const loaded = parseLocalizationItemResult(await withSite.loadItem({ itemKey: "aG9tZQ" }, signal()), "aG9tZQ");
  const cover = loaded.item.units.find((unit) => unit.kind === "image");
  assert.equal(cover.source.url, "https://site.example.test/images/cover-ja.jpg");
  assert.equal(cover.value.url, "https://site.example.test/images/cover-en.jpg");
  assert.deepEqual(cover.source.asset, local.asset, "set-image で送る値は変えない");
  const commanded = parseLocalizationCommandResult(await withSite.command(command, signal()), { itemKey: "aG9tZQ", unitId: image.unitId });
  assert.equal(commanded.unit.source.url, "https://site.example.test/images/cover-ja.jpg");
  // 文字の項目と https の画像はそのまま。公開 origin が無い・https の origin でなければ変えない
  assert.deepEqual(loaded.item.units.filter((unit) => unit.kind !== "image"), units.filter((unit) => unit.kind !== "image"));
  for (const siteOrigin of [null, "http://site.example.test", "https://site.example.test/path"]) {
    const plain = parseLocalizationItemResult(await createKamakuraLocalizationAdapter({ siteOrigin }).loadItem({ itemKey: "aG9tZQ" }, signal()), "aG9tZQ");
    assert.equal(plain.item.units.find((unit) => unit.kind === "image").source.url, "/images/cover-ja.jpg", String(siteOrigin));
  }
});
