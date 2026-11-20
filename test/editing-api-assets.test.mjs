import assert from "node:assert/strict";
import { test } from "node:test";
import { EDITING_OPERATIONS, createPageEditingApi } from "@niho/web/editing-api";
import { createPageEditingApiClient, EditingApiClientError } from "@niho/web/editing-client";

const siteId = "assets-example";
const reference = { provider: "uploads", id: "asset-1" };
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const row = (extra = {}) => ({ provider: reference.provider, id: reference.id, siteId, kind: "image", status: "ready", name: "sea.webp", mimeType: "image/webp", bytes: 32,
  width: 16, height: 12, alt: "sea", version: "v1", updatedAt: "2026-11-20T00:00:00Z", ...extra });

function fixture({ capabilities = ["assets.read", "assets.edit", "assets.upload", "assets.delete"], invalidResolve = false } = {}) {
  const calls = [];
  const api = createPageEditingApi({
    async authenticate(request) { return request.headers.get("Authorization") === "Bearer editor" ? { kind: "machine", subject: "editor" } : null; },
    async authorize(actor, capability, scope) { return actor.subject === "editor" && scope.siteId === siteId && scope.assetProvider !== "other" && capabilities.includes(capability); },
    async readPage() { return null; }, async savePage() { return { status: "conflict" }; },
    async listAssets(_actor, query) { calls.push(["list", query]); return { assets: [row()], folders: [], upload: { accept: ["image/webp"], maxBytes: 1024 } }; },
    async listAssetUsages(_actor, requestedSite, requestedReference) { calls.push(["usages", requestedSite, requestedReference]); return [{ pageId: "home", locale: "ja", title: "Home", state: "published" }]; },
    async resolveAssets(_actor, requestedSite, references) { calls.push(["resolve", requestedSite, references]); return invalidResolve ? { "uploads:other": { src: "/other.webp" } } : { "uploads:asset-1": { src: "/media/asset-1.webp", width: 16, height: 12 } }; },
    async updateAsset(_actor, request) { calls.push(["update", request]); return { status: "saved", asset: row({ alt: request.changes.alt, version: "v2" }) }; },
    async createAssetUploadIntent(_actor, requestedSite, input) { calls.push(["upload-intent", requestedSite, input]); return { uploadUrl: `https://host.example/internal/upload/${uuid}`, uploadToken: "short-lived", assetId: uuid }; },
    async deleteAsset(_actor, request) { calls.push(["delete", request]); return { status: "in-use", usages: [{ pageId: "home", locale: "ja", title: "Home", state: "published" }] }; },
    async restoreAsset(_actor, request) { calls.push(["restore", request]); return { status: "restored" }; }
  });
  const send = (method, path, body, authorization = "Bearer editor") => api(new Request(`https://host.example/api/edit/v1${path}`, {
    method, headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  const client = createPageEditingApiClient({ origin: "https://host.example", siteId, headers: { Authorization: "Bearer editor" }, fetch: (input, init) => api(new Request(input, init)) });
  return { send, client, calls };
}
async function json(response) { return { status: response.status, body: await response.json() }; }

test("asset operations are discoverable with independent permissions and stable schemas", async () => {
  const { send } = fixture({ capabilities: ["assets.read", "assets.upload"] });
  const discovery = await json(await send("GET", `/sites/${siteId}/capabilities`));
  assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.body.operations.map(({ id }) => id), ["assets.list", "assets.usages", "assets.resolve", "assets.upload-intent"]);
  assert.ok(discovery.body.operations.every((operation) => operation.inputSchema && operation.resultSchema && operation.errors.length));
  assert.deepEqual(EDITING_OPERATIONS.slice(-7).map(({ id }) => id), ["assets.list", "assets.usages", "assets.resolve", "assets.update", "assets.upload-intent", "assets.delete", "assets.restore"]);
});

test("asset client uses versioned host operations and validates stable asset references", async () => {
  const { client, calls } = fixture();
  const listing = await client.listAssets({ search: "sea", kind: "image", folderId: null, limit: 10, provider: "uploads" });
  assert.equal(listing.assets[0].id, reference.id);
  assert.equal(calls[0][1].provider, "uploads");
  assert.deepEqual(await client.listAssetUsages(reference), [{ pageId: "home", locale: "ja", title: "Home", state: "published" }]);
  assert.deepEqual(await client.resolveAssets([reference]), { "uploads:asset-1": { src: "/media/asset-1.webp", width: 16, height: 12 } });
  assert.deepEqual(await client.updateAsset(reference, "v1", { alt: "shore" }), { status: "saved", asset: row({ alt: "shore", version: "v2" }) });
  assert.deepEqual(await client.createAssetUploadIntent({ name: "new.webp", mimeType: "image/webp", bytes: 32, folderId: null, provider: "uploads" }),
    { uploadUrl: `https://host.example/internal/upload/${uuid}`, uploadToken: "short-lived", assetId: uuid });
  assert.deepEqual(await client.deleteAsset(reference, "v2"), { status: "in-use", usages: [{ pageId: "home", locale: "ja", title: "Home", state: "published" }] });
  assert.deepEqual(await client.restoreAsset(reference, "v2"), { status: "restored" });
  assert.deepEqual(calls.filter(([name]) => name === "update")[0][1], { siteId, reference, expectedVersion: "v1", changes: { alt: "shore" } });
  await assert.rejects(client.resolveAssets([{ provider: "uploads", id: "../asset" }]), TypeError);
});

test("asset API rejects malformed query, unrequested resolved URLs and unauthorized scopes", async () => {
  const { send } = fixture({ invalidResolve: true });
  assert.deepEqual(await json(await send("GET", `/sites/${siteId}/operations/assets.list?search=a&search=b`)), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await json(await send("GET", `/sites/${siteId}/operations/assets.usages/other/${reference.id}`)), { status: 403, body: { error: "forbidden" } });
  assert.deepEqual(await json(await send("POST", `/sites/${siteId}/operations/assets.resolve`, { references: [reference] })), { status: 502, body: { error: "host_contract_violation" } });
  assert.deepEqual(await json(await send("POST", `/sites/${siteId}/operations/assets.upload-intent`, { name: "x.svg", mimeType: "image/svg+xml", bytes: 10, folderId: null, provider: "uploads" })),
    { status: 201, body: { uploadUrl: `https://host.example/internal/upload/${uuid}`, uploadToken: "short-lived", assetId: uuid } });
  await assert.rejects(fixture().client.listAssets({ search: "", kind: "all", folderId: null, limit: 0 }), TypeError);
});
