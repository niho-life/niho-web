import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

const STUDIO = "https://studio.niho.life";
const BASE = "/api/projects/project-kamakura/sites/kamakura/editor/assets";
const UPSTREAM = "/internal/studio/web-content/assets";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const ADMIN_ID = Buffer.from("2026/10/aaaaaaaaaaaaaaaa.jpg").toString("base64url");

async function accessFixture() {
  const issuer = "https://asset-bff-test.example", audience = "asset-bff-test", subject = "asset-bff-subject", kid = "asset-bff-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 300, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

async function loadWorker() {
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
}

test("Kamakura asset BFF re-checks membership, validates every body, signs upstream calls and keeps reject statuses", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  const secret = Buffer.alloc(32, 9).toString("base64url");
  const roles = new Map(), calls = [];
  let respond = () => Response.json({ assets: [], folders: [] });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: secret,
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() { const role = roles.get(`${this.values[1]}/${this.values[2]}`); return role && (!/m\.role = 'owner'/u.test(query) || role === "owner") ? { allowed: 1 } : null; } }; } },
    ASSETS: { async fetch() { return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch(request) {
      const body = await request.text();
      calls.push({ method: request.method, path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body });
      return respond(request, body);
    } },
  };
  const post = (action, body, { headers = {}, jwt = auth.jwt } = {}) => worker.fetch(new Request(`${STUDIO}${BASE}/${action}`, {
    method: "POST",
    headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), Origin: STUDIO, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  }), env);
  const preview = (id, headers = {}) => worker.fetch(new Request(`${STUDIO}${BASE}/${id}/preview`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt, "Sec-Fetch-Site": "same-origin", ...headers } }), env);
  const expectJson = async (response, status, errorCode) => {
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    if (errorCode !== undefined) assert.equal(value.error, errorCode);
    return value;
  };
  const verifySignature = (call, subject) => {
    const message = `v1\n${call.headers["x-niho-studio-timestamp"]}\n${call.method}\n${call.path}\n${createHash("sha256").update(call.body).digest("hex")}\nproject-kamakura\n${subject}`;
    assert.equal(call.headers["x-niho-studio-signature"], `v1=${createHmac("sha256", Buffer.from(secret, "base64url")).update(message).digest("hex")}`);
    assert.equal(call.headers["x-niho-studio-project"], "project-kamakura");
    assert.equal(call.headers["x-niho-studio-subject"], subject);
    assert.ok(Math.abs(Number(call.headers["x-niho-studio-timestamp"]) - Date.now() / 1000) < 30);
    assert.equal(call.headers["cf-access-jwt-assertion"], undefined, "Access JWT を上流へ渡さない");
    assert.equal(call.headers.cookie, undefined);
  };
  const list = { siteId: "kamakura", search: "", kind: "all", folderId: null, limit: 60 };

  // 認証と所属
  await expectJson(await post("list", list, { jwt: "" }), 401, "session_expired");
  await expectJson(await post("list", list), 403, "forbidden");
  await expectJson(await preview(UUID), 403, "forbidden");
  assert.equal(calls.length, 0);
  roles.set("project-kamakura/kamakura", "editor");

  // 一覧: 検証済みの本文だけを署名して転送する
  assert.deepEqual(await expectJson(await post("list", { ...list, provider: "kamakura-admin-upload" }), 200), { assets: [], folders: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, `${UPSTREAM}/list`);
  assert.deepEqual(JSON.parse(calls[0].body), { ...list, provider: "kamakura-admin-upload" });
  verifySignature(calls[0], auth.subject);

  // 本文の検証に落ちた要求は上流へ届かない
  const before = calls.length;
  for (const [action, body, headers] of [
    ["list", { ...list, siteId: "experience" }],
    ["list", { ...list, provider: "kamakura-legacy" }],
    ["list", { ...list, limit: 61 }],
    ["list", { ...list, extra: true }],
    ["resolve", { siteId: "kamakura", references: [{ provider: "kamakura-upload", id: "legacy-abc" }] }],
    ["resolve", { siteId: "kamakura", references: [{ provider: "unknown", id: "x" }] }],
    ["update", { siteId: "kamakura", reference: { provider: "kamakura-admin-upload", id: ADMIN_ID }, expectedVersion: "v", changes: { alt: "x" } }],
    ["update", { siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID }, expectedVersion: "v", changes: { folderId: null } }],
    ["update", { siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID }, expectedVersion: "v", changes: {} }],
    ["usages", { siteId: "kamakura", reference: { provider: "kamakura-studio", id: "a" }, extra: 1 }],
    ["upload-intent", { siteId: "kamakura", folderId: null, name: "a.png", mimeType: "image/svg+xml", bytes: 10, provider: "kamakura-upload" }],
    ["upload-intent", { siteId: "kamakura", folderId: null, name: "a.png", mimeType: "image/png", bytes: 10, provider: "kamakura-admin-upload" }],
    ["upload-intent", { siteId: "kamakura", folderId: null, name: "a.png", mimeType: "image/png", bytes: 50 * 1024 * 1024 + 1, provider: "kamakura-upload" }],
    ["list", list, { Origin: "https://evil.example" }],
    ["list", list, { "Sec-Fetch-Site": "cross-site" }],
    ["list", list, { "Content-Type": "text/plain" }],
  ]) await expectJson(await post(action, body, { headers }), 400, "invalid_request");
  assert.equal(calls.length, before);
  assert.equal((await worker.fetch(new Request(`${STUDIO}${BASE}/list`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), env)).status, 405);
  assert.equal((await post("delete", { siteId: "kamakura" })).status, 404);
  assert.equal((await worker.fetch(new Request(`${STUDIO}${BASE}/list?x=1`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": auth.jwt, Origin: STUDIO, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify(list) }), env)).status, 400);
  assert.equal(calls.length, before);

  // 参照の正規化と転送。usages は配列で返る
  respond = () => Response.json({});
  const references = [{ provider: "kamakura-admin-upload", id: ADMIN_ID }, { provider: "kamakura-upload", id: UUID }, { provider: "kamakura-studio", id: "cy0x" }, { provider: "kamakura-approved-remote", id: "r-" + "a".repeat(40) }];
  await expectJson(await post("resolve", { siteId: "kamakura", references }), 200);
  assert.equal(calls.at(-1).path, `${UPSTREAM}/resolve`);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { siteId: "kamakura", references });
  const usage = [{ pageId: "home", locale: "ja", title: "NIHO kamakura", state: "published" }];
  respond = () => Response.json(usage);
  assert.deepEqual(await expectJson(await post("usages", { siteId: "kamakura", reference: { provider: "kamakura-admin-upload", id: ADMIN_ID } }), 200), usage);
  assert.equal(calls.at(-1).path, `${UPSTREAM}/usages`);
  respond = () => Response.json({ status: "conflict" });
  assert.deepEqual(await expectJson(await post("update", { siteId: "kamakura", reference: { provider: "kamakura-upload", id: UUID }, expectedVersion: "v1", changes: { name: "n", alt: "" } }), 200), { status: "conflict" });
  assert.equal(calls.at(-1).path, `${UPSTREAM}/update`);

  // アップロード開始: 上流の拒否 status を画面へ保つ
  const intent = { siteId: "kamakura", folderId: null, name: "a.png", mimeType: "image/png", bytes: 10, provider: "kamakura-upload" };
  respond = () => Response.json({ uploadUrl: `https://next-kamakura.niho.life/internal/studio/asset-upload/${UUID}`, uploadToken: "t", assetId: UUID }, { status: 201 });
  assert.equal((await expectJson(await post("upload-intent", intent), 201)).assetId, UUID);
  assert.equal(calls.at(-1).path, `${UPSTREAM}/upload-intent`);
  verifySignature(calls.at(-1), auth.subject);
  respond = () => Response.json({ error: "visual_editor_frozen", message: "凍結中" }, { status: 409 });
  await expectJson(await post("upload-intent", intent), 409, "visual_editor_frozen");
  respond = () => Response.json({ error: "もう一度" }, { status: 409 });
  await expectJson(await post("upload-intent", intent), 409, "conflict");
  for (const status of [413, 415, 507]) {
    respond = () => Response.json({ error: "rejected" }, { status });
    await expectJson(await post("upload-intent", intent), status, "asset_rejected");
  }
  respond = () => Response.json({ error: "bad" }, { status: 400 });
  await expectJson(await post("upload-intent", intent), 400, "invalid_request");
  respond = () => Response.json({ error: "secret" }, { status: 401 });
  assert.match((await expectJson(await post("upload-intent", intent), 503, "service_unavailable")).supportId, /^[0-9a-f-]{36}$/u);
  respond = () => new Response("<html>", { headers: { "Content-Type": "text/html" } });
  await expectJson(await post("list", list), 503, "service_unavailable");
  respond = () => Response.json({ error: "down" }, { status: 503 });
  await expectJson(await post("list", list), 503, "service_unavailable");
  respond = () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } });
  await expectJson(await post("list", list), 503, "service_unavailable");

  // プレビュー: 署名した POST に変換し、画像だけを流す
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  respond = (request, body) => {
    assert.equal(request.method, "POST");
    assert.deepEqual(JSON.parse(body), { siteId: "kamakura", assetId: UUID });
    return new Response(pngBytes, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  };
  const image = await preview(UUID);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/png");
  assert.equal(image.headers.get("Cache-Control"), "no-store");
  assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), pngBytes);
  assert.equal(calls.at(-1).path, `${UPSTREAM}/preview`);
  verifySignature(calls.at(-1), auth.subject);
  respond = () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } });
  await expectJson(await preview(UUID), 503);
  respond = () => Response.json({ error: "素材がありません" }, { status: 404 });
  await expectJson(await preview(UUID), 404, "not_found");
  const previewCalls = calls.length;
  assert.equal((await preview(UUID, { "Sec-Fetch-Site": "cross-site" })).status, 400);
  assert.equal((await preview("legacy-abc")).status, 404);
  assert.equal((await preview(ADMIN_ID)).status, 404);
  assert.equal((await worker.fetch(new Request(`${STUDIO}${BASE}/${UUID}/preview`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": auth.jwt, "Sec-Fetch-Site": "same-origin" } }), env)).status, 405);
  assert.equal(calls.length, previewCalls);

  // 所属の取り消しは次の要求から効く
  roles.delete("project-kamakura/kamakura");
  await expectJson(await post("list", list), 403, "forbidden");
  await expectJson(await preview(UUID), 403, "forbidden");
  assert.equal(calls.length, previewCalls);

  // 編集画面の CSP は CDN のサムネイルと直接アップロード先を許す
  roles.set("project-kamakura/kamakura", "owner");
  const page = await worker.fetch(new Request(`${STUDIO}/projects/kamakura-site/admin/editor`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), env);
  assert.equal(page.status, 200);
  const csp = page.headers.get("Content-Security-Policy");
  assert.match(csp, /img-src 'self' https:;/u);
  assert.match(csp, /connect-src 'self' https:\/\/next-kamakura\.niho\.life;/u);
});
