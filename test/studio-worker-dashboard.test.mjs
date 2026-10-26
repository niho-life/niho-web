import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";
import { parseProjectDashboardResult } from "@niho/web/project-read-model";

const OVERVIEW_PATH = "/internal/studio/web-content/_site/overview";
const secret = Buffer.alloc(32, 41).toString("base64url");

async function accessFixture() {
  const issuer = "https://dashboard-test.example", audience = "dashboard-test", subject = "dashboard-subject-7", kid = "dashboard-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 600, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

const rows = {
  "project-kamakura/kamakura": { project_id: "project-kamakura", project_name: "NIHO kamakura", site_id: "kamakura", site_name: "鎌倉サイト（新サイト確認用）", public_origin: "https://next-kamakura.niho.life", display_name: "編集者" },
  "project-experience/experience": { project_id: "project-experience", project_name: "NIHO Experience", site_id: "experience", site_name: "NIHO Experience", public_origin: "https://experience.niho.life", display_name: "編集者" },
};
const projectOf = (row, subject) => ({ id: row.project_id, name: row.project_name, site: { id: row.site_id, name: row.site_name, domains: [row.public_origin] }, members: [{ userId: subject, displayName: row.display_name }] });
// D1 の project_members（表示名と役割だけを読む）。値はすべて架空
const memberRows = {
  "project-kamakura": [{ display_name: "オーナー（架空）", role: "owner" }, { display_name: "編集者", role: "editor" }],
  "project-experience": [{ display_name: "編集者", role: "editor" }]
};

const upstreamOverview = () => ({
  publicationStatus: "published",
  publishedUrl: "https://next-kamakura.niho.life",
  lastPublishedAt: "2026-10-26T01:02:03Z",
  publishedPageCount: 62,
  assetBytes: null,
  recentChanges: [
    { id: `commit-${"a".repeat(40)}`, label: "記事を公開: 鎌倉の秋", changedAt: "2026-10-26T01:00:00Z", sha: "a".repeat(40) },
    { id: `commit-${"b".repeat(40)}`, label: "固定ページの文言を直す", changedAt: "2026-10-25T10:00:00.000+09:00" },
  ],
  futureField: { ignored: true },
});

test("Dashboard reads the Kamakura overview through the signed bridge and degrades to unavailable", async (t) => {
  const auth = await accessFixture();
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });

  const members = new Set();
  const calls = [];
  let upstream = async () => Response.json(upstreamOverview());
  let membersQuery = async (projectId) => ({ success: true, results: memberRows[projectId] ?? [] });
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: secret,
    DB: { prepare() { return { bind(...values) { this.values = values; return this; }, async first() {
      const key = `${this.values[1]}/${this.values[2]}`;
      return this.values[0] === auth.subject && members.has(key) ? rows[key] : null;
    }, async all() {
      // メンバー一覧は project_id と上限だけで引く（subject で絞らない＝参加者全員）
      assert.equal(this.values.length, 2); assert.equal(this.values[1], 500);
      return membersQuery(this.values[0]);
    } }; } },
    ASSETS: { async fetch() { return new Response("unused"); } },
    KAMAKURA_SITE: { async fetch(request) {
      calls.push(request);
      return upstream(request);
    } },
  };
  const dashboard = async (projectId, siteId, target = env) => {
    const response = await worker.fetch(new Request(`https://studio.niho.life/api/projects/${projectId}/sites/${siteId}/dashboard`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), target);
    assert.equal(response.status, 200);
    return response.json();
  };
  const kamakura = async (target = env) => {
    const value = await dashboard("project-kamakura", "kamakura", target);
    assert.deepEqual(Object.keys(value).sort(), ["analytics", "fetchedAt", "members", "overview", "projectId", "siteId", "status"]);
    assert.equal(value.status, "ready");
    assert.deepEqual(value.analytics, { status: "disconnected" });
    // client 側の parser（未知の key を拒否する）にそのまま通る
    const parsed = parseProjectDashboardResult(value, projectOf(rows["project-kamakura/kamakura"], auth.subject));
    assert.equal(parsed.status, "ready");
    return value;
  };

  // 参加していないと上流を呼ばずに forbidden
  assert.deepEqual(await dashboard("project-kamakura", "kamakura"), { status: "forbidden", projectId: "project-kamakura", siteId: "kamakura" });
  assert.equal(calls.length, 0);
  members.add("project-kamakura/kamakura");
  members.add("project-experience/experience");

  // 上流 OK: 既知の key だけで組み立て直し、日時は UTC に揃える
  const ready = await kamakura();
  // メンバーは参加者全員の表示名と役割だけ（subject・メール・日時は出さない）。owner が先
  assert.deepEqual(ready.members, { status: "ready", data: [{ displayName: "オーナー（架空）", role: "owner" }, { displayName: "編集者", role: "editor" }] });
  assert.deepEqual(ready.overview, { status: "ready", data: {
    publicationStatus: "published",
    publishedUrl: "https://next-kamakura.niho.life",
    lastPublishedAt: "2026-10-26T01:02:03.000Z",
    publishedPageCount: 62,
    assetBytes: null,
    recentChanges: [
      { id: `commit-${"a".repeat(40)}`, label: "記事を公開: 鎌倉の秋", changedAt: "2026-10-26T01:00:00.000Z" },
      { id: `commit-${"b".repeat(40)}`, label: "固定ページの文言を直す", changedAt: "2026-10-25T01:00:00.000Z" },
    ],
  } });
  // 署名つき GET（本文なし・redirect は手動・既存のブリッジと同じ message）
  assert.equal(calls.length, 1);
  const sent = calls[0], sentUrl = new URL(sent.url);
  assert.equal(sent.method, "GET");
  assert.equal(sentUrl.pathname, OVERVIEW_PATH);
  assert.equal(sentUrl.search, "");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.body, null);
  assert.equal(sent.headers.get("X-NIHO-Studio-Project"), "project-kamakura");
  assert.equal(sent.headers.get("X-NIHO-Studio-Subject"), auth.subject);
  const timestamp = sent.headers.get("X-NIHO-Studio-Timestamp");
  assert.ok(Math.abs(Number(timestamp) - Math.floor(Date.now() / 1000)) <= 5);
  const message = `v1\n${timestamp}\nGET\n${OVERVIEW_PATH}\n${createHash("sha256").update("").digest("hex")}\nproject-kamakura\n${auth.subject}`;
  assert.equal(sent.headers.get("X-NIHO-Studio-Signature"), `v1=${createHmac("sha256", Buffer.from(secret, "base64url")).update(message).digest("hex")}`);

  // 公開 URL が D1 の公開 origin と違う（切替の直後など）: URL だけ出さず、ほかの値は出す
  upstream = async () => Response.json({ ...upstreamOverview(), publishedUrl: "https://kamakura.niho.life" });
  const moved = await kamakura();
  assert.equal(moved.overview.status, "ready");
  assert.equal(moved.overview.data.publishedUrl, null);
  assert.equal(moved.overview.data.publicationStatus, "published");
  assert.equal(moved.overview.data.publishedPageCount, 62);

  // 判定できない値は null のまま通す
  upstream = async () => Response.json({ publicationStatus: "unknown", publishedUrl: null, lastPublishedAt: null, publishedPageCount: null, assetBytes: null, recentChanges: [] });
  assert.deepEqual((await kamakura()).overview, { status: "ready", data: { publicationStatus: "unknown", publishedUrl: null, lastPublishedAt: null, publishedPageCount: null, assetBytes: null, recentChanges: [] } });

  // 上流の失敗・形の誤りはすべて overview だけ unavailable（Dashboard は 200）
  const invalid = (patch) => async () => Response.json({ ...upstreamOverview(), ...patch });
  const failures = {
    "5xx": async () => Response.json({ error: "Studio ブリッジの処理を完了できませんでした" }, { status: 500 }),
    "503 secret": async () => Response.json({ error: "Studio ブリッジの設定がまだです" }, { status: 503 }),
    "404 not deployed": async () => Response.json({ error: "その API はありません" }, { status: 404 }),
    "401": async () => Response.json({ error: "署名" }, { status: 401 }),
    redirect: async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
    "service binding throws": async () => { throw new TypeError("network"); },
    "not JSON": async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
    "broken JSON": async () => new Response("{", { headers: { "Content-Type": "application/json" } }),
    "too large": async () => new Response(JSON.stringify({ ...upstreamOverview(), padding: "x".repeat(70 * 1024) }), { headers: { "Content-Type": "application/json" } }),
    array: async () => Response.json([upstreamOverview()]),
    "bad status": invalid({ publicationStatus: "live" }),
    "missing key": async () => { const value = upstreamOverview(); delete value.publishedPageCount; return Response.json(value); },
    "negative count": invalid({ publishedPageCount: -1 }),
    "fractional bytes": invalid({ assetBytes: 1.5 }),
    "url with status unknown": invalid({ publicationStatus: "unknown" }),
    "http url": invalid({ publishedUrl: "http://next-kamakura.niho.life" }),
    "url with path": invalid({ publishedUrl: "https://next-kamakura.niho.life/admin" }),
    "bad date": invalid({ lastPublishedAt: "2026-02-30T00:00:00Z" }),
    "date without zone": invalid({ lastPublishedAt: "2026-10-26T01:02:03" }),
    "id starting with digit": invalid({ recentChanges: [{ id: "a".repeat(40).replace(/^a/u, "1"), label: "x", changedAt: "2026-10-26T01:00:00Z" }] }),
    "duplicate id": invalid({ recentChanges: [{ id: "commit-a", label: "x", changedAt: "2026-10-26T01:00:00Z" }, { id: "commit-a", label: "y", changedAt: "2026-10-26T01:00:00Z" }] }),
    "control char label": invalid({ recentChanges: [{ id: "commit-a", label: "x\ny", changedAt: "2026-10-26T01:00:00Z" }] }),
    "blank label": invalid({ recentChanges: [{ id: "commit-a", label: "  ", changedAt: "2026-10-26T01:00:00Z" }] }),
    "too many changes": invalid({ recentChanges: Array.from({ length: 21 }, (_, index) => ({ id: `commit-${index}`, label: "x", changedAt: "2026-10-26T01:00:00Z" })) }),
  };
  for (const [name, respond] of Object.entries(failures)) {
    upstream = respond;
    assert.deepEqual((await kamakura()).overview, { status: "unavailable" }, name);
  }

  // timeout（8 秒）も unavailable。上流への要求は abort する
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  upstream = (request) => new Promise((_, reject) => {
    reached(request);
    request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const pending = kamakura();
  const hanging = await waiting;
  t.mock.timers.tick(8_000);
  assert.deepEqual((await pending).overview, { status: "unavailable" });
  assert.equal(hanging.signal.aborted, true);
  t.mock.timers.reset();

  // 秘密が無いと上流を呼ばずに unavailable
  const before = calls.length;
  assert.deepEqual((await kamakura({ ...env, KAMAKURA_STUDIO_BRIDGE_SECRET: undefined })).overview, { status: "unavailable" });
  assert.equal(calls.length, before);

  // メンバーの読み取りに失敗しても、公開情報は残り Dashboard は 200（members だけ unavailable）。保存値が壊れていても同じ
  upstream = async () => Response.json(upstreamOverview());
  for (const broken of [async () => { throw new Error("D1_ERROR"); }, async () => ({ success: false, results: [] }), async () => ({ success: true, results: [{ display_name: "x", role: "admin" }] }), async () => ({ success: true, results: [{ display_name: "   ", role: "owner" }] })]) {
    membersQuery = broken;
    const degraded = await kamakura();
    assert.deepEqual(degraded.members, { status: "unavailable" });
    assert.equal(degraded.overview.status, "ready");
  }
  membersQuery = async (projectId) => ({ success: true, results: memberRows[projectId] ?? [] });

  // メンバーの失敗のログは固定の文言と error の name だけ（表示名・subject・本文を出さない）
  const memberWarnings = warnings.filter(([label]) => label === "NIHO Studio dashboard members unavailable");
  assert.equal(memberWarnings.length, 4);
  for (const [, detail] of memberWarnings) assert.equal(detail, "Error");
  // ログは support ID・操作・分類・status だけ（秘密・署名・subject・本文を出さない）
  const bridgeWarnings = warnings.filter(([label]) => label === "NIHO Studio Kamakura bridge failure");
  assert.equal(bridgeWarnings.length + memberWarnings.length, warnings.length);
  assert.ok(bridgeWarnings.length >= Object.keys(failures).length + 2);
  const categories = new Set();
  for (const [label, detail] of bridgeWarnings) {
    assert.equal(label, "NIHO Studio Kamakura bridge failure");
    assert.equal(detail.operation, "site_overview");
    for (const key of Object.keys(detail)) assert.ok(["supportId", "operation", "category", "upstreamStatus"].includes(key), key);
    const text = JSON.stringify(detail);
    for (const forbidden of [auth.subject, secret, "v1=", "鎌倉", "evil.example"]) assert.equal(text.includes(forbidden), false, forbidden);
    categories.add(detail.category);
  }
  for (const category of ["upstream_server_error", "overview_endpoint_missing", "upstream_auth_rejected", "upstream_redirect_rejected", "service_binding_failed", "upstream_invalid_response", "upstream_contract_invalid", "service_binding_timeout", "bridge_secret_missing_or_invalid"]) {
    assert.ok(categories.has(category), category);
  }

  // Experience は今までどおり（上流を呼ばない・合成しない）
  const callsBefore = calls.length;
  const experience = await dashboard("project-experience", "experience");
  assert.equal(experience.status, "ready");
  assert.deepEqual(experience.overview, { status: "unavailable" });
  assert.deepEqual(experience.analytics, { status: "disconnected" });
  assert.deepEqual(experience.members, { status: "ready", data: [{ displayName: "編集者", role: "editor" }] });
  assert.equal(calls.length, callsBefore);
  assert.equal(parseProjectDashboardResult(experience, projectOf(rows["project-experience/experience"], auth.subject)).status, "ready");
});
