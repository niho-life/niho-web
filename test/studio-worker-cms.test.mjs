import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

// 架空の値だけを使う（実在の記事・人・内部 ID は書かない）。
const STUDIO = "https://studio.niho.life";
const BASE = "/api/projects/project-kamakura/sites/kamakura/cms";
const UPSTREAM = "/internal/studio/cms";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const EMAIL = "editor@example.test";

async function accessFixture() {
  // 同じ bundle の module を使い回すので、JWKS の cache が混ざらないよう issuer を test ごとに変える
  const issuer = `https://cms-bff-${crypto.randomUUID()}.example`, audience = "cms-bff-test", subject = "cms-bff-subject", kid = "cms-bff-key";
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

const schema = () => ({
  status: "ready",
  collections: [
    {
      id: "posts", label: "記事", addLabel: "新しく書く", icon: "document", ordering: "publishedAt", pathPrefix: "/posts/",
      titleField: "title", slugField: "slug", imageField: "cover", subtitleField: null,
      capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: true },
      fields: [
        { key: "title", label: "タイトル", type: "text", required: true, placement: "main" },
        { key: "cover", label: "カバー画像", type: "image", placement: "main" },
        { key: "body", label: "本文", type: "richText", placement: "main" },
        { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" },
        { key: "tags", label: "タグ", type: "tags", placement: "side" }
      ]
    },
    {
      id: "circles", label: "サークル", addLabel: "追加する", icon: "people", ordering: "manual", pathPrefix: "/circles/",
      titleField: "name", slugField: null, imageField: null, subtitleField: null,
      capabilities: { create: true, duplicate: false, remove: false, unpublish: false, schedule: false },
      fields: [
        { key: "name", label: "名前", type: "text", required: true, placement: "main" },
        { key: "category", label: "種類", type: "select", multiple: false, options: [{ id: "sports", label: "運動" }, { id: "culture", label: "文化" }], placement: "side" }
      ]
    }
  ]
});
const item = (overrides = {}, values = {}) => ({
  id: "morning-walk", title: "海辺の朝さんぽ", subtitle: null, imageUrl: null, path: null, status: "draft",
  publishedAt: null, updatedAt: "2026-10-20T09:00:00Z", updatedBy: "書き手（架空）", scheduledAt: null, publishFailed: false, order: null,
  version: "v1:-:etag-a:-", values: { title: "海辺の朝さんぽ", cover: null, body: "<p>朝の海辺。</p>", slug: "morning-walk", tags: ["海"], ...values }, ...overrides
});
const summary = ({ version: _version, values: _values, ...rest }) => rest;

function harness(auth, worker) {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const roles = new Map(), calls = [];
  let respond = () => Response.json(schema());
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: secret,
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() { const role = roles.get(`${this.values[1]}/${this.values[2]}`); return role && (!/m\.role = 'owner'/u.test(query) || role === "owner") ? { allowed: 1 } : null; } }; } },
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
    ...(method === "GET" ? {} : { body: raw ?? JSON.stringify(body) })
  }), env);
  const verifySignature = (call) => {
    const message = `v1\n${call.headers["x-niho-studio-timestamp"]}\n${call.method}\n${call.path}\n${createHash("sha256").update(call.body).digest("hex")}\nproject-kamakura\n${auth.subject}`;
    assert.equal(call.headers["x-niho-studio-signature"], `v1=${createHmac("sha256", Buffer.from(secret, "base64url")).update(message).digest("hex")}`);
    assert.equal(call.headers["x-niho-studio-project"], "project-kamakura");
    assert.equal(call.headers["x-niho-studio-subject"], auth.subject);
    assert.match(call.headers["x-niho-studio-request-id"], /^[0-9a-f-]{36}$/u);
    assert.ok(Math.abs(Number(call.headers["x-niho-studio-timestamp"]) - Date.now() / 1000) < 30);
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

test("CMS BFF: Access と D1 の owner/editor を要求ごとに確かめ、鎌倉以外と知らない経路は閉じる", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
  const h = harness(auth, worker);

  await expectJson(await h.send("GET", "/schema", undefined, { jwt: "" }), 401, "session_expired");
  await expectJson(await h.send("GET", "/schema"), 403, "forbidden");
  await expectJson(await h.send("PUT", "/collections/posts/items/morning-walk/draft", { version: "v1", values: {} }), 403, "forbidden");
  h.roles.set("project-experience/experience", "owner");
  await expectJson(await worker.fetch(new Request(`${STUDIO}/api/projects/project-experience/sites/experience/cms/schema`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), h.env), 404, "not_found");
  assert.equal(h.calls.length, 0, "認可の前に上流を呼ばない");

  h.roles.set("project-kamakura/kamakura", "editor");
  const ready = await expectJson(await h.send("GET", "/schema"), 200);
  // 今の上流（capabilities が 5 つ）も通し、後から足した 4 つは false にそろえて返す
  const normalized = schema();
  for (const collection of normalized.collections) Object.assign(collection.capabilities, { redirects: false, reorder: false, bulk: false, retrySchedule: false });
  assert.deepEqual(ready, normalized);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].path, `${UPSTREAM}/schema`);
  assert.equal(h.calls[0].body, "");
  h.verifySignature(h.calls[0]);

  const before = h.calls.length;
  for (const [method, path, status] of [
    ["GET", "/schema?x=1", 400],
    ["GET", "/collections/posts/items?", 400],
    ["GET", "/", 404],
    ["GET", "/collections", 404],
    ["GET", "/collections/Posts/items", 404],
    ["GET", "/collections/posts/items/__proto__", 404],
    ["GET", "/collections/posts/items/.hidden", 404],
    ["GET", "/collections/posts/items/a/b/c", 404],
    ["POST", "/collections/posts/items/morning-walk/archive", 404],
    ["POST", "/schema", 405],
    ["DELETE", "/collections/posts/items/morning-walk", 405],
    ["PUT", "/collections/posts/items", 405],
    ["GET", "/collections/posts/items/morning-walk/draft", 405],
    ["PUT", "/collections/posts/items/morning-walk/publish", 405],
    ["GET", "/uploads/intent", 405]
  ]) {
    const response = await worker.fetch(new Request(`${STUDIO}${BASE}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), h.env);
    assert.equal(response.status, status, `${method} ${path}`);
  }
  assert.equal(h.calls.length, before);

  // 所属の取り消しは次の要求から効く
  h.roles.delete("project-kamakura/kamakura");
  await expectJson(await h.send("GET", "/schema"), 403, "forbidden");
  assert.equal(h.calls.length, before);
});

test("CMS BFF: 本文を操作ごとの key の集合で確かめ、actor に確かめ済みの email を入れて署名する", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "owner");
  const target = "/collections/posts/items/morning-walk";
  const saved = item({ version: "v1:-:etag-b:-", title: "新しい題" }, { title: "新しい題" });

  // 下書き: 直した key だけを JSON に作り直して送る
  h.setRespond(() => Response.json({ status: "saved", item: saved }));
  const result = await expectJson(await h.send("PUT", `${target}/draft`, { values: { title: "新しい題", tags: ["海", "朝"], cover: null }, version: "v1:-:etag-a:-" }), 200);
  assert.deepEqual(result, { status: "saved", item: saved });
  const draftCall = h.calls.at(-1);
  assert.equal(draftCall.method, "PUT");
  assert.equal(draftCall.path, `${UPSTREAM}${target}/draft`);
  assert.equal(draftCall.body, JSON.stringify({ version: "v1:-:etag-a:-", values: { title: "新しい題", tags: ["海", "朝"], cover: null }, actor: { email: EMAIL } }));
  h.verifySignature(draftCall);

  // 公開・非公開・下書きに戻す・複製・削除・予約・予約の取り消し・新規
  const writes = [
    ["POST", `${target}/publish`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 202, { status: "publishing", item: item({ status: "publishing" }) }],
    ["POST", `${target}/unpublish`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 202, { status: "publishing", item: item({ status: "publishing" }) }],
    ["POST", `${target}/discard-draft`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 200, { status: "saved", item: item() }],
    ["POST", `${target}/duplicate`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 201, { status: "created", item: item({ id: "morning-walk-copy" }) }],
    ["POST", `${target}/remove`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 200, { status: "removed" }],
    ["POST", `${target}/schedule`, { version: "v1", at: "2026-11-01T18:00:00+09:00" }, { version: "v1", at: "2026-11-01T09:00:00.000Z", actor: { email: EMAIL } }, 200, { status: "saved", item: item({ status: "scheduled", scheduledAt: "2026-11-01T09:00:00Z" }) }],
    ["POST", `${target}/cancel-schedule`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 200, { status: "saved", item: item() }],
    ["POST", "/collections/circles/items", {}, { actor: { email: EMAIL } }, 201, { status: "created", item: item({ id: "new-circle", title: "" }, { title: undefined }) }]
  ];
  for (const [method, path, body, forwarded, status, reply] of writes) {
    h.setRespond(() => Response.json(reply, { status }));
    assert.deepEqual(await expectJson(await h.send(method, path, body), status), JSON.parse(JSON.stringify(reply)), path);
    assert.equal(h.calls.at(-1).path, `${UPSTREAM}${path}`);
    assert.deepEqual(JSON.parse(h.calls.at(-1).body), forwarded, path);
    h.verifySignature(h.calls.at(-1));
  }

  // 読み取り
  h.setRespond(() => Response.json({ status: "ready", collectionId: "posts", items: [summary(item())] }));
  assert.equal((await expectJson(await h.send("GET", "/collections/posts/items"), 200)).items[0].id, "morning-walk");
  h.setRespond(() => Response.json({ status: "ready", item: item() }));
  assert.deepEqual(await expectJson(await h.send("GET", target), 200), { status: "ready", item: item() });

  // 本文の確かめに落ちた要求は上流へ届かない
  const before = h.calls.length;
  const big = { version: "v1", values: { body: "x".repeat(1_000_001) } };
  for (const [method, path, body, headers] of [
    ["PUT", `${target}/draft`, { version: "v1", values: { title: "t" }, actor: { email: "someone@example.test" } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { title: "t" }, extra: true }],
    ["PUT", `${target}/draft`, { values: { title: "t" } }],
    ["PUT", `${target}/draft`, { version: "", values: {} }],
    ["PUT", `${target}/draft`, { version: "v1\n", values: {} }],
    ["PUT", `${target}/draft`, { version: "v1", values: { Title: "t" } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { title_1: "t" } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { title: 1 } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { title: { nested: true } } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { tags: ["a", "a"] } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { tags: [""] } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { tags: ["x".repeat(201)] } }],
    ["PUT", `${target}/draft`, { version: "v1", values: { tags: Array.from({ length: 201 }, (_, index) => `t${index}`) } }],
    ["PUT", `${target}/draft`, { version: "v1", values: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`k${index}`, ""])) }],
    ["PUT", `${target}/draft`, big],
    ["PUT", `${target}/draft`, { version: "v1", values: { body: "x".repeat(2 * 1024 * 1024) } }],
    ["POST", `${target}/publish`, { version: "v1", actor: { email: EMAIL } }],
    ["POST", `${target}/publish`, { version: "v1", values: {} }],
    ["POST", `${target}/publish`, { version: "v1", padding: "x".repeat(17 * 1024) }],
    ["POST", `${target}/schedule`, { version: "v1", at: "2026-11-01 09:00" }],
    ["POST", `${target}/schedule`, { version: "v1" }],
    ["POST", "/collections/circles/items", { actor: { email: EMAIL } }],
    ["POST", `${target}/publish`, { version: "v1" }, { Origin: "https://evil.example" }],
    ["POST", `${target}/publish`, { version: "v1" }, { "Sec-Fetch-Site": "cross-site" }],
    ["POST", `${target}/publish`, { version: "v1" }, { "Content-Type": "text/plain" }]
  ]) await expectJson(await h.send(method, path, body, { headers }), 400, "invalid_request");
  await expectJson(await h.send("POST", `${target}/publish`, undefined, { raw: "[1]" }), 400, "invalid_request");
  await expectJson(await h.send("POST", `${target}/publish`, undefined, { raw: "{" }), 400, "invalid_request");
  assert.equal(h.calls.length, before);

  // アップロード開始
  const intent = { collectionId: "posts", name: "朝の海.png", mimeType: "image/png", bytes: 1024 };
  const uploadUrl = `https://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}`;
  h.setRespond(() => Response.json({ uploadUrl, uploadToken: "token.value", uploadId: UUID }, { status: 201 }));
  assert.deepEqual(await expectJson(await h.send("POST", "/uploads/intent", intent), 201), { uploadUrl, uploadToken: "token.value", uploadId: UUID });
  assert.equal(h.calls.at(-1).path, `${UPSTREAM}/uploads/intent`);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body), { ...intent, actor: { email: EMAIL } });
  h.verifySignature(h.calls.at(-1));
  const beforeIntent = h.calls.length;
  for (const body of [
    { ...intent, mimeType: "image/svg+xml" },
    { ...intent, bytes: 0 },
    { ...intent, bytes: 50 * 1024 * 1024 + 1 },
    { ...intent, name: "" },
    { ...intent, name: "a\nb.png" },
    { ...intent, collectionId: "Posts" },
    { ...intent, actor: { email: EMAIL } }
  ]) await expectJson(await h.send("POST", "/uploads/intent", body), 400, "invalid_request");
  assert.equal(h.calls.length, beforeIntent);
});

test("CMS BFF: 上流の status を契約どおりに写し、契約に合わない応答は 502、利用できないときは 503 と問い合わせ ID", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "editor");
  const target = "/collections/posts/items/morning-walk";
  const save = () => h.send("PUT", `${target}/draft`, { version: "v1", values: { title: "t" } });
  const supportIdOf = (value) => { assert.match(value.supportId, /^[0-9a-f-]{36}$/u); return value.supportId; };

  // 409・422・404・400
  const latest = item({ version: "v2:-:etag-z:-", updatedBy: "別の書き手（架空）" });
  h.setRespond(() => Response.json({ error: "conflict", item: latest }, { status: 409 }));
  assert.deepEqual(await expectJson(await save(), 409), { error: "conflict", item: latest });
  h.setRespond(() => Response.json({ error: "conflict", item: item({ id: "other-post" }) }, { status: 409 }));
  supportIdOf(await expectJson(await save(), 502, "upstream_contract_invalid"));
  h.setRespond(() => Response.json({ error: "conflict" }, { status: 409 }));
  supportIdOf(await expectJson(await save(), 502, "upstream_contract_invalid"));
  const errors = Array.from({ length: 60 }, (_, index) => ({ field: index === 0 ? "" : "title", message: `直してください ${index}` }));
  h.setRespond(() => Response.json({ error: "invalid", errors }, { status: 422 }));
  const invalid = await expectJson(await save(), 422, "invalid");
  assert.equal(invalid.errors.length, 50);
  assert.deepEqual(invalid.errors[0], { field: "", message: "直してください 0" });
  h.setRespond(() => Response.json({ error: "invalid", errors: [{ field: "title", message: "" }] }, { status: 422 }));
  await expectJson(await save(), 502, "upstream_contract_invalid");
  h.setRespond(() => Response.json({ error: "not_found" }, { status: 404 }));
  assert.deepEqual(await expectJson(await save(), 404), { error: "not_found" });
  assert.deepEqual(await expectJson(await h.send("GET", target), 404), { error: "not_found" });
  supportIdOf(await expectJson(await h.send("GET", "/schema"), 503, "service_unavailable"));
  h.setRespond(() => Response.json({ error: "bad", detail: "secret" }, { status: 400 }));
  assert.deepEqual(await expectJson(await save(), 400), { error: "invalid_request" });

  // upload の拒否は status を保つ
  const intent = { collectionId: "posts", name: "a.png", mimeType: "image/png", bytes: 10 };
  for (const status of [413, 415]) {
    h.setRespond(() => Response.json({ error: "too large" }, { status }));
    assert.deepEqual(await expectJson(await h.send("POST", "/uploads/intent", intent), status), { error: "image_rejected" });
  }
  for (const reply of [
    { uploadUrl: `https://evil.example/internal/studio/cms-upload/${UUID}`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `https://next-kamakura.niho.life/internal/studio/asset-upload/${UUID}`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `https://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}?x=1`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `https://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}`, uploadToken: "t", uploadId: "123e4567-e89b-42d3-a456-426614174001" },
    { uploadUrl: `https://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}`, uploadToken: "t t", uploadId: UUID }
  ]) {
    h.setRespond(() => Response.json(reply, { status: 201 }));
    await expectJson(await h.send("POST", "/uploads/intent", intent), 502, "upstream_contract_invalid");
  }

  // 利用できない: 401・403・429・5xx・3xx・JSON でない・上限超え
  for (const respond of [
    () => Response.json({ error: "signature" }, { status: 401 }),
    () => Response.json({ error: "forbidden" }, { status: 403 }),
    () => Response.json({ error: "slow down" }, { status: 429 }),
    () => Response.json({ error: "down" }, { status: 500 }),
    () => Response.json({ error: "service_unavailable" }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
    () => new Response("<html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("{", { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ status: "ready", item: item({}, { body: "x".repeat(3 * 1024 * 1024) }) }), { headers: { "Content-Type": "application/json" } }),
    () => Response.json({ error: "method" }, { status: 405 })
  ]) {
    h.setRespond(respond);
    const value = await expectJson(await h.send("GET", target), 503, "service_unavailable");
    assert.deepEqual(Object.keys(value).sort(), ["error", "supportId"]);
  }

  // 契約に合わない成功
  for (const [method, path, body, reply, status] of [
    ["GET", "/schema", undefined, { ...schema(), extra: true }, 200],
    ["GET", "/schema", undefined, { status: "forbidden" }, 200],
    ["GET", "/schema", undefined, { status: "ready", collections: [{ ...schema().collections[0], fields: [{ key: "title_ja", label: "題", type: "text", placement: "main" }], titleField: "title_ja", slugField: null, imageField: null }] }, 200],
    ["GET", "/schema", undefined, { status: "ready", collections: [{ ...schema().collections[0], id: "Posts" }] }, 200],
    ["GET", "/collections/posts/items", undefined, { status: "ready", collectionId: "circles", items: [] }, 200],
    ["GET", "/collections/posts/items", undefined, { status: "ready", collectionId: "posts", items: [{ ...summary(item()), internalId: "x" }] }, 200],
    ["GET", target, undefined, { status: "ready", item: item({ id: "other-post" }) }, 200],
    ["GET", target, undefined, { status: "ready", item: { ...item(), studioId: "x" } }, 200],
    ["GET", target, undefined, { status: "ready", item: item({}, { body: 1 }) }, 200],
    ["GET", target, undefined, { status: "ready", item: item({ version: "" }) }, 200],
    ["PUT", `${target}/draft`, { version: "v1", values: {} }, { status: "saved", item: item() }, 201],
    ["PUT", `${target}/draft`, { version: "v1", values: {} }, { status: "ready", item: item() }, 200],
    ["POST", `${target}/publish`, { version: "v1" }, { status: "published", item: item() }, 202],
    ["POST", `${target}/duplicate`, { version: "v1" }, { status: "created", item: item() }, 201],
    ["POST", `${target}/remove`, { version: "v1" }, { status: "removed", item: item() }, 200],
    ["POST", "/collections/posts/items", {}, { status: "created", item: item() }, 200]
  ]) {
    h.setRespond(() => Response.json(reply, { status }));
    supportIdOf(await expectJson(await h.send(method, path, body), 502, "upstream_contract_invalid"));
  }

  // 秘密が無い・不正なら閉じる
  const withoutSecret = { ...h.env, KAMAKURA_STUDIO_BRIDGE_SECRET: "short" };
  const calls = h.calls.length;
  const closed = await worker.fetch(new Request(`${STUDIO}${BASE}/schema`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), withoutSecret);
  await expectJson(closed, 503, "service_unavailable");
  assert.equal(h.calls.length, calls);

  // log は固定の operation と分類だけ（本文・secret・subject を出さない）
  const logged = warnings.map(([, detail]) => detail);
  assert.ok(logged.some((detail) => detail.operation === "cms_draft_save" && detail.category === "upstream_contract_invalid" && detail.upstreamStatus === 409));
  assert.ok(logged.some((detail) => detail.operation === "cms_schema" && detail.category === "cms_endpoint_missing"));
  assert.ok(logged.some((detail) => detail.operation === "cms_schema" && detail.category === "bridge_secret_missing_or_invalid"));
  assert.ok(!JSON.stringify(logged).includes(auth.subject));
  assert.ok(!JSON.stringify(logged).includes(EMAIL));
});

test("CMS BFF: 読み取りは 12 秒、書き込みは 30 秒で上流を打ち切る", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
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
    ["GET", "/collections/posts/items/morning-walk", undefined, 12_000],
    ["POST", "/collections/posts/items/morning-walk/publish", { version: "v1" }, 30_000]
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

test("CMS BFF: 並べ替え・まとめての操作・予約のやり直しと、転送の任意の key を確かめて actor を入れて渡す", async (t) => {
  const auth = await accessFixture();
  const worker = await loadWorker();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });
  const h = harness(auth, worker);
  h.roles.set("project-kamakura/kamakura", "editor");
  const target = "/collections/posts/items/morning-walk";
  const circle = (id, order) => summary(item({ id, title: `架空のサークル ${id}`, path: `/circles/${id}`, status: "published", publishedAt: "2026-10-20T09:00:00Z", order }));
  const list = [circle("walk", 1), circle("books", 2)];

  // 新しい schema（9 つの capabilities・gallery の項目）はそのまま通す
  const next = schema();
  next.collections[1].capabilities = { create: true, duplicate: false, remove: true, unpublish: true, schedule: false, redirects: true, reorder: true, bulk: true, retrySchedule: false };
  next.collections[1].fields.push({ key: "portfolio", label: "作品／活動", type: "gallery", captionLabel: "説明", placement: "main", maxItems: 60, captionMaxLength: 2000 });
  h.setRespond(() => Response.json(next));
  assert.deepEqual((await expectJson(await h.send("GET", "/schema"), 200)).collections[1], next.collections[1]);

  const writes = [
    ["POST", `${target}/publish`, { version: "v1", redirect: false }, { version: "v1", redirect: false, actor: { email: EMAIL } }, 202, { status: "publishing", item: item({ status: "publishing" }) }],
    ["POST", `${target}/schedule`, { version: "v1", at: "2026-11-01T18:00:00+09:00", redirect: true }, { version: "v1", at: "2026-11-01T09:00:00.000Z", redirect: true, actor: { email: EMAIL } }, 200, { status: "saved", item: item({ status: "scheduled", scheduledAt: "2026-11-01T09:00:00Z" }) }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: null }, { version: "v1", redirectTo: null, actor: { email: EMAIL } }, 200, { status: "removed" }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: "/posts/other-post" }, { version: "v1", redirectTo: "/posts/other-post", actor: { email: EMAIL } }, 200, { status: "removed" }],
    ["POST", `${target}/retry-schedule`, { version: "v1" }, { version: "v1", actor: { email: EMAIL } }, 200, { status: "saved", item: item({ status: "scheduled", scheduledAt: "2026-11-01T09:00:00Z" }) }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 1, to: 0 }, { ids: ["walk", "books"], from: 1, to: 0, actor: { email: EMAIL } }, 202, { status: "publishing", items: [circle("books", 1), circle("walk", 2)] }],
    // 同じ番号どうしの入れ替えは commit が無く 200 saved
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 1, to: 0 }, { ids: ["walk", "books"], from: 1, to: 0, actor: { email: EMAIL } }, 200, { status: "saved", items: list }],
    ["POST", "/collections/circles/bulk", { action: "unpublish", items: [{ id: "walk", version: "v1" }, { id: "books", version: "v2" }] }, { action: "unpublish", items: [{ id: "walk", version: "v1" }, { id: "books", version: "v2" }], actor: { email: EMAIL } }, 202, { status: "publishing", items: list }],
    ["POST", "/collections/circles/bulk", { action: "remove", items: [{ id: "walk", version: "v1" }] }, { action: "remove", items: [{ id: "walk", version: "v1" }], actor: { email: EMAIL } }, 200, { status: "saved", items: [list[1]] }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "w1", image: "https://kamakura-media.niho.life/uploads/a.jpg", caption: "説明\n二行目" }, { id: "", image: null, caption: "" }] } },
      { version: "v1", values: { portfolio: [{ id: "w1", image: "https://kamakura-media.niho.life/uploads/a.jpg", caption: "説明\n二行目" }, { id: "", image: null, caption: "" }] }, actor: { email: EMAIL } }, 200,
      { status: "saved", item: item({ id: "walk" }, { portfolio: [{ id: "w1", image: null, caption: "x" }] }) }]
  ];
  for (const [method, path, body, forwarded, status, reply] of writes) {
    h.setRespond(() => Response.json(reply, { status }));
    assert.deepEqual(await expectJson(await h.send(method, path, body), status), JSON.parse(JSON.stringify(reply)), path);
    assert.equal(h.calls.at(-1).path, `${UPSTREAM}${path}`);
    assert.deepEqual(JSON.parse(h.calls.at(-1).body), forwarded, path);
    h.verifySignature(h.calls.at(-1));
  }

  // 409 は一覧つき・422 は errors。posts の並べ替えは上流の 404
  h.setRespond(() => Response.json({ error: "conflict", items: list }, { status: 409 }));
  assert.deepEqual(await expectJson(await h.send("POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 1 }), 409), { error: "conflict", items: list });
  assert.deepEqual(await expectJson(await h.send("POST", "/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1" }] }), 409), { error: "conflict", items: list });
  h.setRespond(() => Response.json({ error: "invalid", errors: [{ field: "", message: "作品／活動を直した項目は 1 件ずつ公開してください" }] }, { status: 422 }));
  assert.equal((await expectJson(await h.send("POST", "/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1" }] }), 422, "invalid")).errors[0].field, "");
  h.setRespond(() => Response.json({ error: "not_found" }, { status: 404 }));
  assert.deepEqual(await expectJson(await h.send("POST", "/collections/posts/reorder", { ids: ["a", "b"], from: 0, to: 1 }), 404), { error: "not_found" });

  // 契約に合わない応答は 502
  for (const [path, body, reply, status] of [
    ["/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 1 }, { status: "saved", items: list }, 202],
    ["/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 1 }, { status: "publishing", items: list }, 200],
    ["/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 1 }, { error: "conflict", item: item() }, 409],
    ["/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1" }] }, { status: "publishing", items: list }, 200],
    ["/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1" }] }, { status: "publishing", items: [list[0], list[0]] }, 202],
    ["/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1" }] }, { status: "publishing", items: [{ ...list[0], secret: 1 }] }, 202],
    [`${target}/retry-schedule`, { version: "v1" }, { status: "publishing", item: item() }, 200]
  ]) {
    h.setRespond(() => Response.json(reply, { status }));
    await expectJson(await h.send("POST", path, body), 502, "upstream_contract_invalid");
  }

  // 本文の確かめに落ちた要求は上流へ届かない
  const before = h.calls.length;
  const bulkItems = (count) => Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, version: "v1" }));
  for (const [method, path, body] of [
    ["POST", `${target}/publish`, { version: "v1", redirect: "yes" }],
    ["POST", `${target}/publish`, { version: "v1", redirectTo: null }],
    ["POST", `${target}/schedule`, { version: "v1", at: "2026-11-01T09:00:00Z", redirect: 1 }],
    ["POST", `${target}/unpublish`, { version: "v1", redirect: true }],
    ["POST", `${target}/remove`, { version: "v1", redirect: true }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: "https://evil.example/x" }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: "//evil.example/x" }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: "/posts/a?b=1" }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: "/posts/a b" }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: "" }],
    ["POST", `${target}/remove`, { version: "v1", redirectTo: 1 }],
    ["POST", `${target}/remove`, { redirectTo: null }],
    ["POST", `${target}/retry-schedule`, { version: "v1", at: "2026-11-01T09:00:00Z" }],
    ["POST", `${target}/retry-schedule`, {}],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 0 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 2 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: -1, to: 1 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0.5, to: 1 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: "0", to: 1 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "walk"], from: 0, to: 1 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "../books"], from: 0, to: 1 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk"], from: 0, to: 1 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0 }],
    ["POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 1, actor: { email: EMAIL } }],
    ["POST", "/collections/circles/bulk", { action: "archive", items: bulkItems(1) }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: [] }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: bulkItems(101) }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1" }, { id: "walk", version: "v2" }] }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "v1", status: "published" }] }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: [{ id: "walk" }] }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: [{ id: "walk", version: "" }] }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: ["walk"] }],
    ["POST", "/collections/circles/bulk", { action: "publish", items: bulkItems(1), actor: { email: EMAIL } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "w1", image: null }] } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "w1", image: null, caption: "", order: 1 }] } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "../w", image: null, caption: "" }] } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "w1", image: "https://a.example/x y.jpg", caption: "" }] } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "w1", image: null, caption: "x".repeat(20_001) }] } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: [{ id: "w1", image: null, caption: "" }, "w2"] } }],
    ["PUT", "/collections/circles/items/walk/draft", { version: "v1", values: { portfolio: Array.from({ length: 201 }, () => ({ id: "", image: null, caption: "" })) } }]
  ]) await expectJson(await h.send(method, path, body), 400, "invalid_request");
  assert.equal(h.calls.length, before);

  // 経路: 並べ替え・まとめての操作は POST だけ。項目の下や知らない操作は閉じる
  for (const [method, path, status] of [
    ["GET", "/collections/circles/reorder", 405],
    ["PUT", "/collections/circles/bulk", 405],
    ["POST", "/collections/Circles/reorder", 404],
    ["POST", "/collections/circles/items/walk/reorder", 404],
    ["POST", "/collections/circles/sort", 404],
    ["GET", `${target}/retry-schedule`, 405]
  ]) {
    const response = await worker.fetch(new Request(`${STUDIO}${BASE}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), h.env);
    assert.equal(response.status, status, `${method} ${path}`);
  }
  assert.equal(h.calls.length, before);

  // log は固定の operation だけ
  h.setRespond(() => Response.json({ error: "down" }, { status: 500 }));
  await expectJson(await h.send("POST", "/collections/circles/reorder", { ids: ["walk", "books"], from: 0, to: 1 }), 503, "service_unavailable");
  await expectJson(await h.send("POST", "/collections/circles/bulk", { action: "publish", items: bulkItems(1) }), 503, "service_unavailable");
  await expectJson(await h.send("POST", `${target}/retry-schedule`, { version: "v1" }), 503, "service_unavailable");
  const logged = warnings.map(([, detail]) => detail.operation);
  for (const operation of ["cms_reorder", "cms_bulk", "cms_retry_schedule"]) assert.ok(logged.includes(operation), operation);
  assert.ok(!JSON.stringify(warnings).includes(EMAIL));
});
