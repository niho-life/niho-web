import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const BASE = "/api/projects/project-kamakura/sites/kamakura/editor/assets";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const ADMIN_ID = Buffer.from("2026/10/aaaaaaaaaaaaaaaa.jpg").toString("base64url");
const CDN = "https://kamakura-media.niho.life/cdn-cgi/image/width=480,format=auto/uploads/2026/10/aaaaaaaaaaaaaaaa.jpg";
const signal = () => new AbortController().signal;
const row = (provider, id, extra = {}) => ({ provider, id, siteId: "kamakura", kind: "image", status: "ready", name: "a.jpg", mimeType: "image/jpeg", bytes: 10, alt: "", version: "v", updatedAt: "2026-10-25T00:00:00Z", ...extra });
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function loadKamakuraAssetLibrary() {
  const result = await build({
    entryPoints: [new URL("../studio/kamakura-assets.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import("data:text/javascript;base64," + source);
}

test("Kamakura upload previews require the upstream resolver to confirm each reference", async (t) => {
  const { kamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const existingId = "123e4567-e89b-12d3-a456-426614174000";
  const missingId = "123e4567-e89b-12d3-a456-426614174001";
  const existingKey = "kamakura-upload:" + existingId;
  const references = [
    { provider: "kamakura-upload", id: existingId },
    { provider: "kamakura-upload", id: missingId },
    { provider: "kamakura-admin-upload", id: ADMIN_ID },
    { provider: "kamakura-cms", id: "published-image" },
    { provider: "kamakura-approved-remote", id: "r-" + "a".repeat(40) },
    { provider: "unknown-provider", id: "ignored" }
  ];
  let requestedReferences;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), `${BASE}/resolve`);
    requestedReferences = JSON.parse(init.body).references;
    return jsonResponse({
      [existingKey]: { src: "https://cdn.example.com/draft.webp" },
      ["kamakura-admin-upload:" + ADMIN_ID]: { src: "https://kamakura-media.niho.life/uploads/2026/10/aaaaaaaaaaaaaaaa.jpg", width: 1200, height: 800 },
      "kamakura-cms:published-image": { src: "https://cdn.example.com/published.webp" },
      ["kamakura-approved-remote:r-" + "a".repeat(40)]: { src: "https://images.unsplash.com/photo-approved" }
    });
  });

  const resolved = await kamakuraAssetLibrary.resolveAssets({ siteId: "kamakura", references }, signal());
  assert.deepEqual(requestedReferences, references.slice(0, -1));
  assert.deepEqual(resolved, {
    [existingKey]: { src: `${BASE}/${existingId}/preview` },
    ["kamakura-admin-upload:" + ADMIN_ID]: { src: "https://kamakura-media.niho.life/uploads/2026/10/aaaaaaaaaaaaaaaa.jpg", width: 1200, height: 800 },
    "kamakura-cms:published-image": { src: "https://cdn.example.com/published.webp" },
    ["kamakura-approved-remote:r-" + "a".repeat(40)]: { src: "https://images.unsplash.com/photo-approved" }
  });
});

test("Kamakura asset adapter declares the fixed sources, keeps public thumbnails and routes Studio uploads through the preview endpoint", async (t) => {
  const { kamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const providers = await kamakuraAssetLibrary.listProviders({ siteId: "kamakura" }, signal());
  assert.deepEqual(providers.map((provider) => [provider.id, provider.kind, provider.status, provider.capabilities.upload, provider.capabilities.editMetadata, provider.capabilities.delete, provider.capabilities.folders, provider.capabilities.acquire]), [
    ["kamakura-upload", "upload", "available", true, true, false, false, false],
    ["kamakura-admin-upload", "cms", "available", false, false, false, false, false],
    ["kamakura-studio", "cms", "available", false, false, false, false, false],
    ["kamakura-cms", "cms", "available", false, false, false, false, false],
    ["kamakura-approved-remote", "cms", "available", false, false, false, false, false]
  ]);
  await assert.rejects(kamakuraAssetLibrary.listProviders({ siteId: "experience" }, signal()), /一致しません/u);

  const requests = [];
  let payload = { assets: [row("kamakura-upload", UUID, { sourceLabel: "NIHO Studio へのアップロード" }), row("kamakura-admin-upload", ADMIN_ID, { thumbnailUrl: CDN })], folders: [], upload: { accept: ["image/png"], maxBytes: 10 } };
  t.mock.method(globalThis, "fetch", async (url, init) => { requests.push({ url: String(url), init }); return jsonResponse(payload); });
  const query = { siteId: "kamakura", search: "", kind: "all", folderId: null, limit: 60 };
  const listed = await kamakuraAssetLibrary.listAssets(query, signal());
  assert.equal(listed.assets[0].thumbnailUrl, `${BASE}/${UUID}/preview`, "非公開の Studio 素材は認証つきの経路で表示する");
  assert.equal(listed.assets[1].thumbnailUrl, CDN, "公開済みの素材は CDN のサムネイルのまま");
  assert.deepEqual(listed.upload, { accept: ["image/png"], maxBytes: 10 });
  assert.equal(requests[0].url, `${BASE}/list`);
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[0].init.body), query);

  payload = { assets: [row("kamakura-legacy", "x")], folders: [] };
  await assert.rejects(kamakuraAssetLibrary.listAssets(query, signal()), /対象外の出所/u);
  payload = { assets: [row("kamakura-cms", "x")], folders: [] };
  await assert.rejects(kamakuraAssetLibrary.listAssets({ ...query, provider: "kamakura-studio" }, signal()), /対象外の出所/u);
  payload = { assets: [row("kamakura-studio", "x", { siteId: "experience" })], folders: [] };
  await assert.rejects(kamakuraAssetLibrary.listAssets(query, signal()));
  await assert.rejects(kamakuraAssetLibrary.listAssets({ ...query, siteId: "experience" }, signal()), /一致しません/u);

  const beforeWrites = requests.length;
  assert.deepEqual(await kamakuraAssetLibrary.updateAsset({ siteId: "kamakura", reference: { provider: "kamakura-admin-upload", id: ADMIN_ID }, expectedVersion: "v", changes: { alt: "x" } }, signal()), { status: "rejected", reason: "permission" });
  assert.deepEqual(await kamakuraAssetLibrary.updateAsset({ siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID }, expectedVersion: "v", changes: { folderId: null } }, signal()), { status: "rejected", reason: "permission" });
  assert.deepEqual(await kamakuraAssetLibrary.deleteAsset({ siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID }, expectedVersion: "v" }, signal()), { status: "rejected", reason: "permission" });
  assert.equal(requests.length, beforeWrites, "権限のない操作は BFF を呼ばない");
});

test("Kamakura uploads go through the signed intent and a one-time direct PUT to the fixed kamakura-site origin", async (t) => {
  const { kamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const file = new Blob([new Uint8Array(16)], { type: "image/png" });
  const request = { siteId: "kamakura", folderId: null, file, name: "a.png", mimeType: "image/png", bytes: 16, provider: "kamakura-upload" };
  const uploadUrl = `https://next-kamakura.niho.life/internal/studio/asset-upload/${UUID}`;
  const asset = row("kamakura-upload", UUID, { name: "a.png", mimeType: "image/png", bytes: 16, width: 2, height: 2, sourceLabel: "NIHO Studio へのアップロード" });
  const calls = [];
  let intent = { uploadUrl, uploadToken: "tok.en", assetId: UUID };
  let handler = (url) => String(url).endsWith("/upload-intent") ? jsonResponse(intent, 201) : jsonResponse({ asset }, 201);
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url: String(url), init }); return handler(url, init); });

  const result = await kamakuraAssetLibrary.uploadAsset(request, signal());
  assert.equal(result.status, "uploaded");
  assert.equal(result.asset.id, UUID);
  assert.equal(result.asset.thumbnailUrl, `${BASE}/${UUID}/preview`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE}/upload-intent`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { siteId: "kamakura", folderId: null, name: "a.png", mimeType: "image/png", bytes: 16, provider: "kamakura-upload" });
  assert.equal(calls[1].url, uploadUrl);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.credentials, "omit", "Access Cookie を鎌倉 Worker へ送らない");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok.en");
  assert.equal(calls[1].init.headers["Content-Type"], "image/png");
  assert.equal(calls[1].init.body, file);

  for (const bad of [
    { ...intent, uploadUrl: `https://evil.example/internal/studio/asset-upload/${UUID}` },
    { ...intent, uploadUrl: `${uploadUrl}?x=1` },
    { ...intent, uploadUrl: `http://next-kamakura.niho.life/internal/studio/asset-upload/${UUID}` },
    { ...intent, assetId: "123e4567-e89b-42d3-a456-426614174001" },
    { ...intent, uploadToken: "" }
  ]) {
    intent = bad;
    calls.length = 0;
    await assert.rejects(kamakuraAssetLibrary.uploadAsset(request, signal()), /正しくありません/u);
    assert.equal(calls.length, 1, "不正な開始情報では PUT を送らない");
  }

  calls.length = 0;
  assert.deepEqual(await kamakuraAssetLibrary.uploadAsset({ ...request, provider: "kamakura-admin-upload" }, signal()), { status: "rejected", reason: "invalid" });
  assert.deepEqual(await kamakuraAssetLibrary.uploadAsset({ ...request, mimeType: "image/svg+xml", file: new Blob([new Uint8Array(16)], { type: "image/svg+xml" }) }, signal()), { status: "rejected", reason: "invalid" });
  assert.deepEqual(await kamakuraAssetLibrary.uploadAsset({ ...request, bytes: 15 }, signal()), { status: "rejected", reason: "invalid" });
  assert.equal(calls.length, 0);

  intent = { uploadUrl, uploadToken: "tok.en", assetId: UUID };
  handler = () => jsonResponse({ error: "quota" }, 507);
  await assert.rejects(kamakuraAssetLibrary.uploadAsset(request, signal()), (error) => error.status === 507);
  handler = (url) => String(url).endsWith("/upload-intent") ? jsonResponse(intent, 201) : jsonResponse({ error: "type" }, 415);
  await assert.rejects(kamakuraAssetLibrary.uploadAsset(request, signal()), (error) => error.status === 415);
  handler = (url) => String(url).endsWith("/upload-intent") ? jsonResponse(intent, 201) : jsonResponse({ asset: { ...asset, id: "123e4567-e89b-42d3-a456-426614174001" } }, 201);
  await assert.rejects(kamakuraAssetLibrary.uploadAsset(request, signal()), /アップロード結果が正しくありません/u);
});

test("Studio Preview accepts direct PUT only at its dedicated upload gateway", async (t) => {
  const uploadOrigin = "https://upload-preview.example";
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __NIHO_STUDIO_RUNTIME__: { kamakuraUploadOrigin: uploadOrigin } }
  });
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  });
  const { kamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const file = new Blob([new Uint8Array(16)], { type: "image/png" });
  const uploadUrl = [uploadOrigin, "/internal/studio/asset-upload/", UUID].join("");
  const asset = row("kamakura-upload", UUID, { mimeType: "image/png", bytes: 16, width: 2, height: 2 });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).endsWith("/upload-intent")
      ? jsonResponse({ uploadUrl, uploadToken: "one-time", assetId: UUID }, 201)
      : jsonResponse({ asset }, 201);
  });

  const result = await kamakuraAssetLibrary.uploadAsset({
    siteId: "kamakura", folderId: null, file, name: "preview.png", mimeType: "image/png", bytes: 16, provider: "kamakura-upload"
  }, signal());
  assert.equal(result.status, "uploaded");
  assert.equal(calls[1].url, uploadUrl);
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.headers.Authorization, "Bearer one-time");

  window.__NIHO_STUDIO_RUNTIME__.kamakuraUploadOrigin = "https://untrusted.example";
  calls.length = 0;
  await assert.rejects(kamakuraAssetLibrary.uploadAsset({
    siteId: "kamakura", folderId: null, file, name: "preview.png", mimeType: "image/png", bytes: 16, provider: "kamakura-upload"
  }, signal()), /正しくありません/u);
  assert.equal(calls.length, 1, "unknown runtime origin is rejected before token-bearing PUT");
});

test("Kamakura Studio prefers the shared editing API for asset reads, resolution and metadata updates", async (t) => {
  const { createKamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const uploaded = row("kamakura-upload", UUID);
  const common = "https://studio.example/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations";
  const expected = [
    [`${common}/assets.list?search=&kind=all&limit=60`, "GET"],
    [`${common}/assets.usages/kamakura-upload/${UUID}`, "GET"],
    [`${common}/assets.resolve`, "POST"],
    [`${common}/assets.update/kamakura-upload/${UUID}`, "PUT"]
  ];
  let index = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), method: init.method, credentials: init.credentials, authorization: new Headers(init.headers).get("Authorization") };
    requests.push(request);
    index++;
    if (request.url.includes("assets.usages/")) return jsonResponse({ usages: [{ pageId: "home", locale: "ja", title: "Home", state: "published" }] });
    if (request.url.endsWith("assets.resolve")) return jsonResponse({ assets: { [`kamakura-upload:${UUID}`]: { src: "/private/asset.webp" } } });
    if (request.url.includes("assets.update/")) return jsonResponse({ status: "saved", asset: { ...uploaded, alt: "shore", version: "v2" } });
    if (request.url.includes("assets.list")) return jsonResponse({ assets: [uploaded], folders: [] });
    return jsonResponse({ status: "saved", asset: { ...uploaded, alt: "shore", version: "v2" } });
  });
  const adapter = createKamakuraAssetLibrary("https://studio.example");
  const listing = await adapter.listAssets({ siteId: "kamakura", search: "", kind: "all", folderId: null, limit: 60 }, signal());
  assert.equal(listing.assets[0].id, UUID);
  assert.deepEqual(await adapter.listAssetUsages({ siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID } }, signal()),
    [{ pageId: "home", locale: "ja", title: "Home", state: "published" }]);
  assert.deepEqual(await adapter.resolveAssets({ siteId: "kamakura", references: [{ provider: "kamakura-upload", id: UUID }] }, signal()),
    { [`kamakura-upload:${UUID}`]: { src: `${BASE}/${UUID}/preview` } });
  assert.deepEqual(await adapter.updateAsset({ siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID }, expectedVersion: "v1", changes: { alt: "shore" } }, signal()),
    { status: "saved", asset: { ...uploaded, alt: "shore", version: "v2", thumbnailUrl: `${BASE}/${UUID}/preview` } });
  assert.equal(index, expected.length);
  assert.deepEqual(requests.map(({ url, method }) => [url, method]), expected);
  assert.ok(requests.every((request) => request.credentials === "same-origin" && request.authorization === null));
});

test("Kamakura Studio gets a shared API upload intent then sends the one-time token only to its fixed origin", async (t) => {
  const { createKamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const assetId = UUID, intentUrl = `https://next-kamakura.niho.life/internal/studio/asset-upload/${assetId}`;
  const intentPath = "https://studio.example/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1/sites/kamakura/operations/assets.upload-intent";
  const file = new File([new Uint8Array([1, 2, 3])], "sea.png", { type: "image/png" });
  let calls = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    requests.push({ url: String(url), method: init.method, credentials: init.credentials, authorization: new Headers(init.headers).get("Authorization"), body: init.body });
    if (calls === 1) {
      return jsonResponse({ uploadUrl: intentUrl, uploadToken: "short-lived", assetId }, 201);
    }
    return jsonResponse({ asset: row("kamakura-upload", assetId, { name: "sea.png", mimeType: "image/png", bytes: 3 }) }, 201);
  });
  const adapter = createKamakuraAssetLibrary("https://studio.example");
  const result = await adapter.uploadAsset({ siteId: "kamakura", file, folderId: null, name: "sea.png", mimeType: "image/png", bytes: 3 }, signal());
  assert.equal(result.status, "uploaded");
  assert.equal(result.asset.id, assetId);
  assert.equal(calls, 2);
  assert.deepEqual(requests.map(({ url, method, credentials }) => [url, method, credentials]), [[intentPath, "POST", "same-origin"], [intentUrl, "PUT", "omit"]]);
  assert.deepEqual(JSON.parse(requests[0].body), { folderId: null, name: "sea.png", mimeType: "image/png", bytes: 3, provider: "kamakura-upload" });
  assert.equal(requests[1].authorization, "Bearer short-lived");
});
