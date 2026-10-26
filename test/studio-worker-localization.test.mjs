import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";

// 鎌倉の翻訳の BFF（studio/worker.ts の /localization/*）・切替の CSP・bundle の分割を確かめる。
// 値はすべて架空（実在の原稿・人・内部の key は書かない）。上流の応答の形は W1 のデモ用のメモリの adapter から作る。
const STUDIO = "https://studio.niho.life";
const BASE = "/api/projects/project-kamakura/sites/kamakura/localization";
const UPSTREAM = "/internal/studio/localization";
const SITE = "https://next-kamakura.niho.life";
const FRAME = `${SITE}/_studio/localization-preview`;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const EMAIL = "editor@example.test";
const OP = "op_0123456789abcdef";
const JOB = `g${"0".repeat(32)}`;

async function accessFixture() {
  // 同じ bundle の module を使い回すので、JWKS の cache が混ざらないよう issuer を test ごとに変える
  const issuer = `https://l10n-bff-${crypto.randomUUID()}.example`, audience = "l10n-bff-test", subject = "l10n-bff-subject", kid = "l10n-bff-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "Editor@Example.test", type: "app", exp: now + 600, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

async function loadWorker() {
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
}

/** 上流（鎌倉の Worker）が返す契約の結果。W1 のデモ用のメモリの adapter から作る。 */
async function fixtures() {
  const memory = createLocalizationMemory({ frameUrl: FRAME });
  const signal = new AbortController().signal;
  const overview = await memory.adapter.loadOverview(signal);
  const list = await memory.adapter.listItems({ cursor: null }, signal);
  const item = await memory.adapter.loadItem({ itemKey: "aG9tZQ" }, signal);
  const { units: _units, previews: _previews, job: _job, ...summary } = item.item;
  return {
    overview, list, item, release: await memory.adapter.readRelease(signal),
    settings: await memory.adapter.saveSettings({ expectedVersion: "set1", autoDraft: false }, signal),
    applied: { status: "applied", unit: item.item.units[0], summary }
  };
}

function harness(auth, worker) {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const roles = new Map(), calls = [];
  let respond = () => Response.json({ status: "current" });
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: secret,
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() {
      const role = roles.get(`${this.values[1]}/${this.values[2]}`);
      if (!role) return null;
      if (/SELECT m\.role AS role/u.test(query)) return { role };
      return !/m\.role = 'owner'/u.test(query) || role === "owner" ? { allowed: 1 } : null;
    } }; } },
    ASSETS: { async fetch() { return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch(request) {
      const body = await request.text();
      const call = { method: request.method, path: new URL(request.url).pathname, search: new URL(request.url).search, headers: Object.fromEntries(request.headers), body, signal: request.signal };
      calls.push(call);
      return respond(call);
    } }
  };
  const send = (method, path, body, { headers = {}, jwt = auth.jwt, raw } = {}) => worker.fetch(new Request(`${STUDIO}${BASE}${path}`, {
    method,
    headers: {
      ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
      ...(method === "GET" ? {} : { Origin: STUDIO, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }),
      ...headers
    },
    ...(method === "GET" ? {} : { body: raw ?? JSON.stringify(body ?? {}) })
  }), env);
  const verifySignature = (call) => {
    const message = `v1\n${call.headers["x-niho-studio-timestamp"]}\n${call.method}\n${call.path}\n${createHash("sha256").update(call.body).digest("hex")}\nproject-kamakura\n${auth.subject}`;
    assert.equal(call.headers["x-niho-studio-signature"], `v1=${createHmac("sha256", Buffer.from(secret, "base64url")).update(message).digest("hex")}`);
    assert.equal(call.headers["x-niho-studio-project"], "project-kamakura");
    assert.equal(call.headers["x-niho-studio-subject"], auth.subject);
    assert.match(call.headers["x-niho-studio-request-id"], /^[0-9a-f-]{36}$/u);
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.headers["cf-access-jwt-assertion"], undefined, "Access JWT を上流へ渡さない");
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.search, "");
  };
  return { env, roles, calls, send, verifySignature, setRespond: (next) => { respond = next; } };
}

async function expectJson(response, status, errorCode) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  if (errorCode !== undefined) assert.equal(value.error, errorCode);
  return value;
}

function mockAccess(t, auth) {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
}

test("翻訳 BFF: Access と D1 の owner/editor を要求ごとに確かめ、その役割を actor に入れ、鎌倉以外と知らない経路は閉じる", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  mockAccess(t, auth);
  const data = await fixtures();
  const h = harness(auth, worker);
  h.setRespond(() => Response.json(data.overview));

  await expectJson(await h.send("POST", "/overview", {}, { jwt: "" }), 401, "session_expired");
  await expectJson(await h.send("POST", "/overview", {}), 403, "forbidden");
  h.roles.set("project-experience/experience", "owner");
  await expectJson(await worker.fetch(new Request(`${STUDIO}/api/projects/project-experience/sites/experience/localization/overview`, {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": auth.jwt, Origin: STUDIO, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: "{}"
  }), h.env), 404, "not_found");
  assert.equal(h.calls.length, 0, "認可の前に上流を呼ばない");

  for (const role of ["editor", "owner"]) {
    h.roles.set("project-kamakura/kamakura", role);
    assert.deepEqual(await expectJson(await h.send("POST", "/overview", {}), 200), data.overview);
    const call = h.calls.at(-1);
    assert.equal(call.method, "POST");
    assert.equal(call.path, `${UPSTREAM}/overview`);
    assert.equal(call.body, JSON.stringify({ actor: { email: EMAIL, role } }), "email は Access で確かめた小文字・role は D1");
    h.verifySignature(call);
  }

  const before = h.calls.length;
  for (const [method, path, status] of [
    ["POST", "/overview?x=1", 400],
    ["POST", "", 404],
    ["POST", "/", 404],
    ["POST", "/overview/", 404],
    ["POST", "/status", 404],
    ["POST", "/items/a.b", 404],
    ["POST", "/items/__proto__", 404],
    ["POST", `/items/${"a".repeat(201)}`, 404],
    ["POST", "/items/aG9tZQ/review", 404],
    ["POST", "/items/aG9tZQ/command/x", 404],
    ["POST", "/items/after/a.b", 404],
    ["POST", "/jobs/a.b", 404],
    ["POST", "/jobs/constructor", 404],
    ["POST", "/release/rollback", 404],
    ["POST", "/editor/pages/catalog", 404],
    ["POST", "/editor/pages/Home", 404],
    ["POST", "/editor/pages/home/extra", 404],
    ["POST", "/editor/pages/home/snapshot/extra", 404],
    ["POST", "/editor/pages/home/save/extra", 404],
    ["POST", "/editor/site/extra", 404],
    ["GET", "/overview", 405],
    ["PUT", "/overview", 405],
    ["GET", "/items", 405],
    ["GET", "/editor/pages/home", 405],
    ["GET", "/editor/pages/home/snapshot", 405],
    ["GET", "/editor/site", 405],
    ["GET", "/editor/pages/home/save", 405],
    ["POST", "/settings", 405],
    ["PUT", "/items/aG9tZQ/command", 405],
    ["DELETE", "/items/aG9tZQ", 405]
  ]) {
    const response = await h.send(method, path, method === "GET" || method === "DELETE" ? undefined : {});
    assert.equal(response.status, status, `${method} ${path}`);
  }
  assert.equal(h.calls.length, before);

  // 所属の取り消しは次の要求から効く
  h.roles.delete("project-kamakura/kamakura");
  await expectJson(await h.send("POST", "/overview", {}), 403, "forbidden");
  assert.equal(h.calls.length, before);
});

test("翻訳 BFF: native 訳文保存と項目操作は版・対象を検証し、actor を署名して一つの正本へ渡す", async (t) => {
  const auth = await accessFixture(), worker = await loadWorker();
  mockAccess(t, auth);
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "editor");
  const versions = { expectedSourceVersion: `p.${"a".repeat(64)}`, expectedVersion: `l.${"b".repeat(64)}`, expectedOverlayVersion: 2 };
  const document = { schemaVersion: 1, siteId: "kamakura", pageId: "home", locale: "en", revision: 4, title: "Home", tokens: {}, body: [] };
  const save = { document, ...versions }, result = { status: "saved", version: `l.${"c".repeat(64)}`, revision: 5 };
  h.setRespond(() => Response.json(result));
  assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home/save", save), 200), result);
  let call = h.calls.at(-1);
  assert.equal(call.path, `${UPSTREAM}/editor/pages/home/save`);
  assert.deepEqual(JSON.parse(call.body), { ...save, actor: { email: EMAIL, role: "editor" } });
  h.verifySignature(call);

  const command = { action: "set-value", unitId: "page.title", value: "New home", sourceFingerprint: `sha256:${"d".repeat(64)}`, expectedEntryVersion: 1, ...versions };
  h.setRespond(() => Response.json({ status: "applied", version: result.version }));
  assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home/command", command), 200), { status: "applied", version: result.version });
  call = h.calls.at(-1);
  assert.equal(call.path, `${UPSTREAM}/editor/pages/home/command`);
  assert.deepEqual(JSON.parse(call.body), { ...command, actor: { email: EMAIL, role: "editor" } });
  h.verifySignature(call);

  for (const [path, body] of [
    ["/editor/pages/home/save", { ...save, document: { ...document, pageId: "other" } }],
    ["/editor/pages/home/save", { ...save, expectedVersion: "old" }],
    ["/editor/pages/home/command", { ...command, expectedEntryVersion: -1 }],
    ["/editor/pages/home/command", { ...command, sourceFingerprint: "bad" }],
    ["/editor/pages/home/command", { ...command, actor: { role: "owner" } }]
  ]) await expectJson(await h.send("POST", path, body), 400, "invalid_request");
  assert.equal(h.calls.length, 2, "不正な本文は上流へ届かない");

  for (const reply of [{ status: "conflict" }, { status: "invalid", message: "訳文を確認してください。" }]) {
    h.setRespond(() => Response.json(reply));
    assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home/save", save), 200), reply);
  }
  h.setRespond(() => Response.json({ status: "saved", version: "bad", revision: 5 }));
  await expectJson(await h.send("POST", "/editor/pages/home/save", save), 502, "upstream_contract_invalid");
});

test("翻訳 BFF: native 編集用ページは所属を確認して署名付きで読み、原文と既存訳の scope を検証する", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  mockAccess(t, auth);
  const h = harness(auth, worker);
  const page = { schemaVersion: 1, siteId: "kamakura", pageId: "home", locale: "ja", revision: 2, title: "海辺の暮らし", tokens: {}, body: [] };
  const overlay = { schemaVersion: 1, siteId: "kamakura", pageId: "home", sourceLocale: "ja", targetLocale: "en", version: 1, entries: [] };
  const ready = { status: "ready", sourceDocument: page, sourceVersion: `p.${"a".repeat(64)}`, overlay, version: `l.${"b".repeat(64)}` };
  h.setRespond(() => Response.json(ready));
  await expectJson(await h.send("POST", "/editor/pages/home", {}, { jwt: "" }), 401, "session_expired");
  await expectJson(await h.send("POST", "/editor/pages/home", {}), 403, "forbidden");
  assert.equal(h.calls.length, 0);
  h.roles.set("project-kamakura/kamakura", "editor");
  assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home", {}), 200), ready);
  const call = h.calls.at(-1);
  assert.equal(call.path, `${UPSTREAM}/editor/pages/home`);
  assert.equal(call.body, JSON.stringify({ actor: { email: EMAIL, role: "editor" } }));
  h.verifySignature(call);
  const normalized = { ...ready, sourceDocument: { ...page, locale: "ja-JP" } };
  h.setRespond(() => Response.json(normalized));
  assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home", {}), 200), normalized);
  const before = h.calls.length;
  await expectJson(await h.send("POST", "/editor/pages/home", { pageId: "other" }), 400, "invalid_request");
  assert.equal(h.calls.length, before);
  for (const reply of [
    { ...ready, sourceDocument: { ...page, pageId: "other" } },
    { ...ready, overlay: { ...overlay, pageId: "other" } },
    { ...ready, sourceVersion: "p.bad" },
    { ...ready, extra: true }
  ]) {
    h.setRespond(() => Response.json(reply));
    await expectJson(await h.send("POST", "/editor/pages/home", {}), 502, "upstream_contract_invalid");
  }
  for (const [status, reply] of [[403, { status: "forbidden" }], [404, { status: "not_found" }]]) {
    h.setRespond(() => Response.json(reply, { status }));
    assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home", {}), status), reply);
  }
});

test("翻訳 BFF: 英語キャンバス snapshot は actor だけを加え、文書・表示文書・版の scope を検証する", async (t) => {
  const auth = await accessFixture(), worker = await loadWorker();
  mockAccess(t, auth);
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "editor");
  const page = (pageId, locale = "en") => ({ schemaVersion: 1, siteId: "kamakura", pageId, locale, revision: 2, title: pageId, tokens: {}, body: [] });
  const presentation = { schemaVersion: 1, siteId: "kamakura", locale: "en", version: "presentation-1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: page("site-header"), footer: page("site-footer") } };
  const ready = { status: "ready", document: page("home"), version: `l.${"a".repeat(64)}`, presentation };
  h.setRespond(() => Response.json(ready));

  assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home/snapshot", {}), 200), ready);
  const call = h.calls.at(-1);
  assert.equal(call.path, `${UPSTREAM}/editor/pages/home/snapshot`);
  assert.equal(call.body, JSON.stringify({ actor: { email: EMAIL, role: "editor" } }));
  h.verifySignature(call);
  const before = h.calls.length;
  await expectJson(await h.send("POST", "/editor/pages/home/snapshot", { pageId: "home" }), 400, "invalid_request");
  assert.equal(h.calls.length, before, "snapshot はブラウザ由来の値を上流へ渡さない");

  for (const reply of [
    { ...ready, document: page("other") },
    { ...ready, document: page("home", "ja") },
    { ...ready, version: "l.bad" },
    { ...ready, presentation: { ...presentation, locale: "ja" } },
    { ...ready, presentation: { ...presentation, version: "bad\nversion" } },
    { ...ready, presentation: { ...presentation, shared: { ...presentation.shared, header: page("site-header", "ja") } } },
    { ...ready, extra: true }
  ]) {
    h.setRespond(() => Response.json(reply));
    await expectJson(await h.send("POST", "/editor/pages/home/snapshot", {}), 502, "upstream_contract_invalid");
  }
  for (const reply of [{ status: "conflict" }, { status: "unavailable", message: "英語の表示材料を準備できません。" }]) {
    h.setRespond(() => Response.json(reply));
    assert.deepEqual(await expectJson(await h.send("POST", "/editor/pages/home/snapshot", {}), 200), reply);
  }
});

test("翻訳 BFF: 英語編集用のページ一覧は所属・署名・状態と公開情報を検証する", async (t) => {
  const auth = await accessFixture(), worker = await loadWorker();
  mockAccess(t, auth);
  const h = harness(auth, worker);
  const config = { schemaVersion: 1, siteId: "kamakura", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"], documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "test-v1", contextVersion: "test-v1" };
  const page = { siteId: "kamakura", pageId: "terms", title: "利用規約", path: "/terms", kind: "page", locales: { ja: { state: "source" }, en: { state: "review-needed", changed: 2, published: false } } };
  const ready = { status: "ready", config, pages: [page], version: `s.${"a".repeat(64)}` };
  h.setRespond(() => Response.json(ready));
  await expectJson(await h.send("POST", "/editor/site", {}, { jwt: "" }), 401, "session_expired");
  await expectJson(await h.send("POST", "/editor/site", {}), 403, "forbidden");
  assert.equal(h.calls.length, 0);
  h.roles.set("project-kamakura/kamakura", "editor");
  assert.deepEqual(await expectJson(await h.send("POST", "/editor/site", {}), 200), ready);
  const call = h.calls.at(-1);
  assert.equal(call.path, `${UPSTREAM}/editor/site`);
  assert.equal(call.body, JSON.stringify({ actor: { email: EMAIL, role: "editor" } }));
  h.verifySignature(call);
  await expectJson(await h.send("POST", "/editor/site", { actor: { email: EMAIL, role: "owner" } }), 400, "invalid_request");
  assert.equal(h.calls.length, 1);
  for (const reply of [
    { ...ready, pages: [page, page] },
    { ...ready, pages: [{ ...page, locales: { ...page.locales, en: { state: "source" } } }] },
    { ...ready, pages: [{ ...page, locales: { ...page.locales, en: { ...page.locales.en, published: "true" } } }] },
    { ...ready, version: "s.bad" },
    { ...ready, extra: true }
  ]) {
    h.setRespond(() => Response.json(reply));
    await expectJson(await h.send("POST", "/editor/site", {}), 502, "upstream_contract_invalid");
  }
});

test("翻訳 BFF: 本文を操作ごとの key の集合と W1 の形で確かめ、確かめた値と actor だけで作り直して署名する", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  mockAccess(t, auth);
  const data = await fixtures();
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "owner");
  const actor = { email: EMAIL, role: "owner" };
  const command = { itemKey: "aG9tZQ", operationId: OP, unitId: "title", expectedVersion: "v1", expectedSourceVersion: "s1" };
  const rich = { kind: "rich-text", children: [{ type: "text", text: "See " }, { type: "element", id: "l1", tag: "a", children: [{ type: "text", text: "here" }] }] };
  const image = { kind: "image-url", src: "https://media.example.test/cover-en.jpg" };
  const uploadUrl = `${SITE}/internal/studio/localization-upload/${UUID}`;
  const prepare = { operation: "publish", releaseId: null, expectedVersion: "o1", expectedCurrentVersion: "r2", resumeToken: null };
  const queued = { status: "queued", job: { jobId: JOB, state: "queued", message: null } };

  for (const [method, path, body, forwarded, status, reply] of [
    ["POST", "/items", {}, {}, 200, data.list],
    ["POST", "/items/after/p2", {}, {}, 200, { status: "ready", items: [], nextCursor: null }],
    ["POST", "/items/aG9tZQ", {}, {}, 200, data.item],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value", value: "Workshop ⟦m0⟧" }, { ...command, action: "set-value", value: "Workshop ⟦m0⟧" }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value", value: rich }, { ...command, action: "set-value", value: rich }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "adopt-candidate", candidateId: "c-lead-1" }, { ...command, action: "adopt-candidate", candidateId: "c-lead-1" }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "review-current" }, { ...command, action: "review-current" }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "clear-value" }, { ...command, action: "clear-value" }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-image", image }, { ...command, action: "set-image", image }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-image", image: null }, { ...command, action: "set-image", image: null }, 200, data.applied],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "review-image" }, { ...command, action: "review-image" }, 200, data.applied],
    ["POST", "/items/aG9tZQ/translate", { itemKey: "aG9tZQ", operationId: OP, unitIds: null }, { itemKey: "aG9tZQ", operationId: OP, unitIds: null }, 200, queued],
    ["POST", "/items/aG9tZQ/translate", { itemKey: "aG9tZQ", operationId: OP, unitIds: ["title", "lead"] }, { itemKey: "aG9tZQ", operationId: OP, unitIds: ["title", "lead"] }, 200, queued],
    ["POST", `/jobs/${JOB}`, {}, {}, 200, { status: "ready", job: { jobId: JOB, state: "running", message: null } }],
    ["POST", "/catalog/advance", {}, {}, 200, { status: "updating", progress: { done: 1, total: 3 } }],
    ["POST", "/release", {}, {}, 200, data.release],
    ["POST", "/release/prepare", prepare, prepare, 200, { status: "preparing", progress: { done: 1, total: 3 }, resumeToken: "prep-1" }],
    ["POST", "/release/prepare", { ...prepare, operation: "rollback", releaseId: "en-2026-09-15", resumeToken: "prep-1" }, { ...prepare, operation: "rollback", releaseId: "en-2026-09-15", resumeToken: "prep-1" }, 200, { status: "conflict" }],
    ["POST", "/release/apply", { confirmationToken: "confirm.token+1=", resumeToken: null }, { confirmationToken: "confirm.token+1=", resumeToken: null }, 200, { status: "applying", progress: { done: 1, total: 2 }, resumeToken: "apply-1" }],
    ["POST", "/release/apply", { confirmationToken: null, resumeToken: "apply-1" }, { confirmationToken: null, resumeToken: "apply-1" }, 200, { status: "expired" }],
    ["PUT", "/settings", { expectedVersion: "set1", autoDraft: false }, { expectedVersion: "set1", autoDraft: false }, 200, data.settings],
    ["POST", "/uploads/intent", { itemKey: "aG9tZQ", unitId: "cover", name: "海.png", mimeType: "image/png", bytes: 2048 }, { itemKey: "aG9tZQ", unitId: "cover", name: "海.png", mimeType: "image/png", bytes: 2048 }, 201, { uploadUrl, uploadToken: "token.value", uploadId: UUID }]
  ]) {
    h.setRespond(() => Response.json(reply, { status }));
    assert.deepEqual(await expectJson(await h.send(method, path, body), status), reply, `${method} ${path}`);
    const call = h.calls.at(-1);
    assert.equal(call.method, method);
    assert.equal(call.path, `${UPSTREAM}${path}`);
    assert.deepEqual(JSON.parse(call.body), { ...forwarded, actor }, path);
    h.verifySignature(call);
  }

  // 本文の確かめに落ちた要求は上流へ届かない
  const before = h.calls.length;
  for (const [method, path, body, headers] of [
    ["POST", "/overview", { actor: { email: "someone@example.test", role: "owner" } }],
    ["POST", "/overview", { extra: true }],
    ["POST", "/items/aG9tZQ", { itemKey: "aG9tZQ" }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "review-current", actor }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "review-current", value: "x" }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "clear-value", value: "" }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value" }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "archive" }],
    ["POST", "/items/aG9tZQ/command", { ...command, itemKey: "YWJvdXQ", action: "review-current" }],
    ["POST", "/items/aG9tZQ/command", { ...command, operationId: "short", action: "review-current" }],
    ["POST", "/items/aG9tZQ/command", { ...command, unitId: "1title", action: "review-current" }],
    ["POST", "/items/aG9tZQ/command", { ...command, expectedVersion: "", action: "review-current" }],
    ["POST", "/items/aG9tZQ/command", { ...command, expectedSourceVersion: "s1\n", action: "review-current" }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value", value: 1 }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value", value: "x".repeat(100_001) }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value", value: { kind: "rich-text", children: [{ type: "element", id: "s1", tag: "script", children: [] }] } }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-value", value: "x".repeat(1024 * 1024) }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "adopt-candidate", candidateId: "c lead" }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-image", image: { kind: "asset", asset: { provider: "kamakura-upload", id: UUID } } }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-image", image: { ...image, srcset: `${image.src} 2x` } }],
    ["POST", "/items/aG9tZQ/command", { ...command, action: "set-image", image: { kind: "image-url", src: "javascript:alert(1)" } }],
    ["POST", "/items/aG9tZQ/translate", { itemKey: "aG9tZQ", operationId: OP, unitIds: "title" }],
    ["POST", "/items/aG9tZQ/translate", { itemKey: "aG9tZQ", operationId: OP, unitIds: ["title", "title"] }],
    ["POST", "/items/aG9tZQ/translate", { itemKey: "aG9tZQ", operationId: OP, unitIds: ["ti tle"] }],
    ["POST", "/items/aG9tZQ/translate", { itemKey: "YWJvdXQ", operationId: OP, unitIds: null }],
    ["POST", "/preview/items", { itemKey: "aG9tZQ", previewId: "home page", cursor: null }],
    ["POST", "/preview/items", { itemKey: "aG9tZQ", previewId: "home", cursor: "a.b" }],
    ["POST", "/preview/items", { itemKey: "a.b", previewId: "home", cursor: null }],
    ["POST", "/release/prepare", { ...prepare, releaseId: "en-2026-09-15" }],
    ["POST", "/release/prepare", { ...prepare, operation: "rollback" }],
    ["POST", "/release/prepare", { ...prepare, operation: "delete" }],
    ["POST", "/release/prepare", { ...prepare, expectedVersion: "" }],
    ["POST", "/release/prepare", { ...prepare, resumeToken: "a b" }],
    ["POST", "/release/apply", { confirmationToken: "a", resumeToken: "b" }],
    ["POST", "/release/apply", { confirmationToken: null, resumeToken: null }],
    ["PUT", "/settings", { expectedVersion: "set1", autoDraft: "yes" }],
    ["POST", "/uploads/intent", { itemKey: "aG9tZQ", unitId: "cover", name: "a.svg", mimeType: "image/svg+xml", bytes: 10 }],
    ["POST", "/uploads/intent", { itemKey: "aG9tZQ", unitId: "cover", name: "a.png", mimeType: "image/png", bytes: 0 }],
    ["POST", "/uploads/intent", { itemKey: "aG9tZQ", unitId: "cover", name: "a.png", mimeType: "image/png", bytes: 50 * 1024 * 1024 + 1 }],
    ["POST", "/uploads/intent", { itemKey: "aG9tZQ", unitId: "cover", name: "", mimeType: "image/png", bytes: 10 }],
    ["POST", "/uploads/intent", { itemKey: "aG9tZQ", unitId: "cover", name: "a\nb.png", mimeType: "image/png", bytes: 10 }],
    ["POST", "/release", { padding: "x".repeat(17 * 1024) }],
    ["POST", "/overview", {}, { Origin: "https://evil.example" }],
    ["POST", "/overview", {}, { "Sec-Fetch-Site": "cross-site" }],
    ["POST", "/overview", {}, { "Content-Type": "text/plain" }]
  ]) await expectJson(await h.send(method, path, body, { headers }), 400, "invalid_request");
  await expectJson(await h.send("POST", "/overview", undefined, { raw: "[1]" }), 400, "invalid_request");
  await expectJson(await h.send("POST", "/overview", undefined, { raw: "{" }), 400, "invalid_request");
  assert.equal(h.calls.length, before);
});

test("翻訳 BFF: 上流の契約の結果を写し、合わない応答は 502、使えないときは 503、未配備は分かる分類で log に残す", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  mockAccess(t, auth);
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });
  const data = await fixtures();
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "editor");
  const command = { itemKey: "aG9tZQ", operationId: OP, action: "review-current", unitId: "title", expectedVersion: "v1", expectedSourceVersion: "s1" };
  const upload = { itemKey: "aG9tZQ", unitId: "cover", name: "a.png", mimeType: "image/png", bytes: 10 };
  const supportIdOf = (value) => { assert.match(value.supportId, /^[0-9a-f-]{36}$/u); assert.deepEqual(Object.keys(value).sort(), ["error", "supportId"]); return value.supportId; };

  // 契約の結果: forbidden は 403・not_found は 404・ほかは 200 のまま
  for (const [path, body, status, reply] of [
    ["/overview", {}, 403, { status: "forbidden" }],
    ["/items/aG9tZQ", {}, 404, { status: "not_found" }],
    ["/items/aG9tZQ/command", command, 200, { status: "invalid", message: "札が足りません：リンク先" }],
    ["/items/aG9tZQ/command", command, 404, { status: "not_found" }],
    ["/release/prepare", { operation: "publish", releaseId: null, expectedVersion: "o1", expectedCurrentVersion: null, resumeToken: null }, 200, { status: "blocked", blockers: [{ id: "unreviewed", message: "確認していない項目があります。", itemKey: "aG9tZQ" }] }],
    ["/uploads/intent", upload, 200, { status: "invalid", message: "この項目は画像ではありません。" }],
    ["/uploads/intent", upload, 403, { status: "forbidden" }]
  ]) {
    h.setRespond(() => Response.json(reply, { status }));
    assert.deepEqual(await expectJson(await h.send("POST", path, body), status), reply, path);
  }

  // 経路の誤り・未配備: 概要の 404 は翻訳の API がまだ無い（503・log の分類で分かる）。ほかの 404 は not_found
  for (const respond of [() => Response.json({ error: "not_found" }, { status: 404 }), () => new Response("<html>missing</html>", { status: 404, headers: { "Content-Type": "text/html" } })]) {
    h.setRespond(respond);
    supportIdOf(await expectJson(await h.send("POST", "/overview", {}), 503, "service_unavailable"));
    assert.deepEqual(await expectJson(await h.send("POST", "/items/aG9tZQ", {}), 404), { error: "not_found" });
  }
  h.setRespond(() => Response.json({ error: "conflict" }, { status: 409 }));
  assert.deepEqual(await expectJson(await h.send("POST", "/items/aG9tZQ/command", command), 409), { error: "conflict" });
  h.setRespond(() => Response.json({ error: "invalid_request", detail: "secret" }, { status: 400 }));
  assert.deepEqual(await expectJson(await h.send("POST", "/items/aG9tZQ/command", command), 400), { error: "invalid_request" });
  for (const status of [413, 415]) {
    h.setRespond(() => Response.json({ error: "too large" }, { status }));
    assert.deepEqual(await expectJson(await h.send("POST", "/uploads/intent", upload), status), { error: "image_rejected" });
  }

  // 利用できない: 401・status の無い 403・429・5xx・3xx・JSON でない・上限超え・想定外の 4xx
  for (const respond of [
    () => Response.json({ error: "unauthorized" }, { status: 401 }),
    () => Response.json({ error: "forbidden" }, { status: 403 }),
    () => Response.json({ error: "slow down" }, { status: 429 }),
    () => Response.json({ error: "down" }, { status: 500 }),
    () => Response.json({ error: "service_unavailable" }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
    () => new Response("<html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("{", { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ ...data.item, padding: "x".repeat(4 * 1024 * 1024) }), { headers: { "Content-Type": "application/json" } }),
    () => Response.json({ error: "method_not_allowed" }, { status: 405 })
  ]) {
    h.setRespond(respond);
    supportIdOf(await expectJson(await h.send("POST", "/items/aG9tZQ", {}), 503, "service_unavailable"));
  }

  // 契約に合わない応答
  const otherOverview = (preview) => ({ ...data.overview, overview: { ...data.overview.overview, preview } });
  for (const [path, body, reply, status] of [
    ["/overview", {}, { ...data.overview, extra: true }, 200],
    ["/overview", {}, otherOverview({ frameUrl: "https://evil.example/_studio/localization-preview" }), 200],
    ["/overview", {}, otherOverview({ frameUrl: `${SITE}/admin/localization` }), 200],
    ["/overview", {}, { status: "forbidden" }, 200],
    ["/overview", {}, data.overview, 403],
    ["/overview", {}, { status: "not_found" }, 404],
    ["/items", {}, { ...data.list, items: [{ ...data.list.items[0], internalKey: "x" }] }, 200],
    ["/items/aG9tZQ", {}, { status: "ready", item: { ...data.item.item, key: "YWJvdXQ" } }, 200],
    ["/items/aG9tZQ", {}, { ok: true }, 200],
    ["/items/aG9tZQ/command", command, { ...data.applied, unit: data.item.item.units[1] }, 200],
    [`/jobs/${JOB}`, {}, { status: "ready", job: { jobId: `g${"1".repeat(32)}`, state: "done", message: null } }, 200],
    ["/uploads/intent", upload, { uploadUrl: `${SITE}/internal/studio/cms-upload/${UUID}`, uploadToken: "t", uploadId: UUID }, 201],
    ["/uploads/intent", upload, { uploadUrl: `https://evil.example/internal/studio/localization-upload/${UUID}`, uploadToken: "t", uploadId: UUID }, 201],
    ["/uploads/intent", upload, { uploadUrl: `${SITE}/internal/studio/localization-upload/${UUID}?x=1`, uploadToken: "t", uploadId: UUID }, 201],
    ["/uploads/intent", upload, { uploadUrl: `${SITE}/internal/studio/localization-upload/${UUID}`, uploadToken: "t t", uploadId: UUID }, 201],
    ["/items/aG9tZQ", {}, data.item, 201]
  ]) {
    h.setRespond(() => Response.json(reply, { status }));
    supportIdOf(await expectJson(await h.send("POST", path, body), 502, "upstream_contract_invalid"));
  }

  // プレビューの材料は確かめずに上限つきでそのまま流す
  const preview = { itemKey: "aG9tZQ", previewId: "home", cursor: null };
  const material = JSON.stringify({ status: "ready", material: { part: "files", files: [{ path: "page.html", text: "<p>架空</p>" }] }, nextCursor: "c1" });
  h.setRespond(() => new Response(material, { headers: { "Content-Type": "application/json; charset=utf-8" } }));
  const streamed = await h.send("POST", "/preview/items", preview);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(streamed.headers.get("Cache-Control"), "no-store");
  assert.equal(await streamed.text(), material);
  h.setRespond(() => Response.json({ status: "not_found" }, { status: 404 }));
  assert.deepEqual(await expectJson(await h.send("POST", "/preview/items", preview), 404), { status: "not_found" });
  h.setRespond(() => new Response("x", { headers: { "Content-Type": "application/json", "Content-Length": String(3 * 1024 * 1024) } }));
  supportIdOf(await expectJson(await h.send("POST", "/preview/items", preview), 503, "service_unavailable"));
  h.setRespond(() => new Response("<p>", { headers: { "Content-Type": "text/html" } }));
  supportIdOf(await expectJson(await h.send("POST", "/preview/items", preview), 503, "service_unavailable"));
  // 長さを言わずに上限を超えたら途中で切る（ブラウザは JSON を読めない）
  const chunk = new Uint8Array(512 * 1024).fill(0x20);
  h.setRespond(() => new Response(new ReadableStream({ start(controller) { for (let index = 0; index < 6; index++) controller.enqueue(chunk); controller.close(); } }), { headers: { "Content-Type": "application/json" } }));
  const cut = await h.send("POST", "/preview/items", preview);
  assert.equal(cut.status, 200);
  await assert.rejects(cut.arrayBuffer());

  // 秘密が無い・不正なら閉じる
  const calls = h.calls.length;
  const closed = await worker.fetch(new Request(`${STUDIO}${BASE}/overview`, {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": auth.jwt, Origin: STUDIO, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: "{}"
  }), { ...h.env, KAMAKURA_STUDIO_BRIDGE_SECRET: "short" });
  await expectJson(closed, 503, "service_unavailable");
  assert.equal(h.calls.length, calls);

  // log は固定の operation と分類・上流の status だけ（本文・token・secret・subject・email を出さない）
  const logged = warnings.map(([, detail]) => detail);
  assert.ok(logged.some((detail) => detail.operation === "localization_overview" && detail.category === "localization_endpoint_missing" && detail.upstreamStatus === 404));
  assert.ok(logged.some((detail) => detail.operation === "localization_overview" && detail.category === "upstream_contract_invalid"));
  assert.ok(logged.some((detail) => detail.operation === "localization_upload_intent" && detail.category === "upstream_contract_invalid" && detail.upstreamStatus === 201));
  assert.ok(logged.some((detail) => detail.operation === "localization_item" && detail.category === "upstream_auth_rejected"));
  assert.ok(logged.some((detail) => detail.operation === "localization_preview" && detail.category === "upstream_invalid_response"));
  assert.ok(logged.some((detail) => detail.operation === "localization_overview" && detail.category === "bridge_secret_missing_or_invalid"));
  for (const detail of logged) assert.deepEqual(Object.keys(detail).filter((key) => !["supportId", "operation", "category", "upstreamStatus"].includes(key)), []);
  const text = JSON.stringify(warnings);
  for (const secret of [auth.subject, EMAIL, "Editor@Example.test", h.env.KAMAKURA_STUDIO_BRIDGE_SECRET, "token.value", "札が足りません", "架空"]) assert.ok(!text.includes(secret), secret);
});

test("翻訳 BFF: 読み取りと保存は 12 秒、概要・公開・取り込み・翻訳の依頼・プレビューは 30 秒で上流を打ち切る", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  mockAccess(t, auth);
  t.mock.method(console, "warn", () => {});
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "owner");
  let entered;
  h.setRespond((call) => new Promise((_resolve, reject) => {
    entered();
    call.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (const [method, path, body, limit] of [
    ["POST", "/items/aG9tZQ", {}, 12_000],
    ["PUT", "/settings", { expectedVersion: "set1", autoDraft: true }, 12_000],
    ["POST", "/overview", {}, 30_000],
    ["POST", "/catalog/advance", {}, 30_000],
    ["POST", "/release/apply", { confirmationToken: "c1", resumeToken: null }, 30_000]
  ]) {
    const started = new Promise((resolve) => { entered = resolve; });
    let settled = false;
    const pending = h.send(method, path, body).then((response) => { settled = true; return response; });
    await started;
    t.mock.timers.tick(limit - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, `${path} は ${limit} ms まで待つ`);
    t.mock.timers.tick(1);
    await expectJson(await pending, 503, "service_unavailable");
  }
});

test("鎌倉の Dashboard だけ翻訳プレビューの枠と画像 PUT 先を許す", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  mockAccess(t, auth);
  const h = harness(auth, worker);
  const page = async (path) => (await worker.fetch(new Request(`${STUDIO}${path}`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), h.env)).headers.get("Content-Security-Policy");
  const dashboards = ["/projects/kamakura-site/admin", "/projects/kamakura-site/admin/translations", "/projects/kamakura-site/admin/translations/aG9tZQ", "/projects/project-kamakura/sites/kamakura"];
  for (const path of dashboards) {
    const csp = await page(path);
    assert.match(csp, / connect-src 'self' https:\/\/next-kamakura\.niho\.life;/u, path);
    assert.match(csp, / frame-src https:\/\/next-kamakura\.niho\.life;/u, path);
    assert.doesNotMatch(csp, /site-admin-test\.example|admin\.example\.test/u, path);
    assert.match(csp, / img-src 'self' https:;/u, path);
    assert.match(csp, / style-src 'self';/u, path);
    assert.match(csp, /frame-ancestors 'none'/u, path);
  }
  for (const path of ["/", "/projects/niho-experience/admin", "/projects/project-experience/sites/experience"]) {
    const csp = await page(path);
    assert.match(csp, / connect-src 'self';/u, path);
    assert.doesNotMatch(csp, /frame-src/u, path);
  }
  const editor = await page("/projects/kamakura-site/admin/editor");
  assert.doesNotMatch(editor, /site-admin-test\.example|admin\.example\.test/u);
  h.roles.set("project-kamakura/kamakura", "editor");
  const admin = await worker.fetch(new Request(`${STUDIO}/api/projects/project-kamakura/sites/kamakura/site-admin`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), h.env);
  assert.deepEqual(await admin.json(), { connected: true });
  assert.equal(h.calls.length, 0);
});

test("翻訳の画面は最初の bundle に入らず、翻訳を開いたときだけ読む chunk に入る", async () => {
  const result = await build({
    entryPoints: { app: new URL("../studio/client.tsx", import.meta.url).pathname }, outdir: "/virtual-studio-assets", entryNames: "[name]", chunkNames: "chunks/[name]-[hash]",
    splitting: true, bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, define: { "process.env.NODE_ENV": '"production"' }
  });
  const outputs = result.metafile.outputs;
  const app = Object.keys(outputs).find((output) => output.endsWith("/app.js"));
  const eager = new Set(), queue = [app];
  while (queue.length) {
    const output = queue.shift();
    if (eager.has(output)) continue;
    eager.add(output);
    for (const entry of outputs[output]?.imports ?? []) if (entry.kind === "import-statement") queue.push(entry.path);
  }
  const translation = /(?:src\/localization-workspace(?:-[a-z]+)?\.tsx?|studio\/kamakura-localization(?:-workspace|-contract)?\.tsx?)$/u;
  const eagerInputs = [...eager].flatMap((output) => Object.keys(outputs[output].inputs));
  assert.deepEqual(eagerInputs.filter((input) => translation.test(input)), []);
  assert.ok(eagerInputs.some((input) => input.endsWith("studio/site-translations.tsx")), "読み込みの器は最初の bundle");
  const lazy = Object.keys(outputs).filter((output) => !eager.has(output) && output.endsWith(".js"));
  const lazyInputs = lazy.flatMap((output) => Object.keys(outputs[output].inputs));
  for (const file of ["src/localization-workspace.tsx", "src/localization-workspace-item.tsx", "studio/kamakura-localization.ts", "studio/kamakura-localization-workspace.tsx"]) {
    assert.ok(lazyInputs.some((input) => input.endsWith(file)), file);
  }
  assert.ok(Object.values(outputs[app].imports).some((entry) => entry.kind === "dynamic-import" && /kamakura-localization-workspace/u.test(entry.path)));
});
