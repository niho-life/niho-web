import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseProjectDirectoryResult } from "@niho/web/project-read-model";

async function accessFixture() {
  const issuer = "https://directory-test.example", audience = "directory-test", subject = "directory-subject-7", kid = "directory-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 600, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

const row = (id, origin) => ({ project_id: `project-${id}`, project_name: `Project ${id}`, site_id: id, site_name: `Site ${id}`, public_origin: origin, display_name: "編集者" });

test("Studio directory reads only bounded allowlisted OG images and degrades each failure to null", async (t) => {
  const auth = await accessFixture();
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  let projectRows = [
    row("kamakura", "https://next-kamakura.niho.life"),
    row("experience", "https://experience.niho.life"),
    row("private", "https://internal.example.test")
  ];
  let memberRows = [
    { project_id: "project-kamakura", display_name: "オーナー（架空）", role: "owner" },
    { project_id: "project-kamakura", display_name: "編集者（架空）", role: "editor" },
    { project_id: "project-experience", display_name: "体験編集者（架空）", role: "editor" },
    { project_id: "project-private", display_name: "非公開編集者（架空）", role: "editor" }
  ];
  let membersQuerySuccess = true;
  let membersQueryCalls = 0;
  const publicCalls = [];
  let publicResponse = async (url, options) => {
    if (url === "https://next-kamakura.niho.life/") return new Response('<meta content="https://kamakura-media.niho.life/og/current.jpg?width=1200&amp;format=webp" property="og:image">', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url === "https://experience.niho.life/") return new Response(null, { status: 302, headers: { Location: "https://evil.example.test/" } });
    throw new Error(`unexpected public fetch ${url}`);
  };
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = String(input);
    if (url === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    publicCalls.push({ url, options });
    return publicResponse(url, options);
  });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    DB: { prepare(query) { const membersQuery = query.includes("WITH visible_projects"); return { bind(...values) { assert.deepEqual(values, [auth.subject]); return this; }, async all() { if (membersQuery) { membersQueryCalls += 1; return { success: membersQuerySuccess, results: memberRows }; } return { success: true, results: projectRows }; } }; } },
    ASSETS: { async fetch() { return new Response("unused"); } }
  };
  const directory = async () => {
    const response = await worker.fetch(new Request("https://studio.niho.life/api/projects", { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), env);
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await directory();
  assert.equal(first.status, "ready");
  assert.equal(membersQueryCalls, 1);
  assert.deepEqual(first.entries.map((entry) => entry.summary.thumbnail), [
    { url: "https://kamakura-media.niho.life/og/current.jpg?width=1200&format=webp", alt: "Site kamakuraのプレビュー" },
    null,
    null
  ]);
  assert.deepEqual(first.entries.map((entry) => [entry.summary.publicationStatus, entry.summary.publishedUrl]), [
    ["published", "https://next-kamakura.niho.life"],
    ["unknown", null],
    ["unknown", null]
  ]);
  assert.deepEqual(first.entries.map((entry) => entry.summary.members), [
    { status: "ready", data: [{ displayName: "オーナー（架空）", role: "owner" }, { displayName: "編集者（架空）", role: "editor" }] },
    { status: "ready", data: [{ displayName: "体験編集者（架空）", role: "editor" }] },
    { status: "ready", data: [{ displayName: "非公開編集者（架空）", role: "editor" }] }
  ]);
  const memberPayload = JSON.stringify(first.entries.map((entry) => entry.summary.members));
  assert.equal(memberPayload.includes(auth.subject), false);
  assert.equal(memberPayload.includes("editor@example.test"), false);
  assert.deepEqual(publicCalls.map((call) => call.url).sort(), ["https://experience.niho.life/", "https://next-kamakura.niho.life/"]);
  for (const call of publicCalls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.referrerPolicy, "no-referrer");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  const parsed = parseProjectDirectoryResult(first, (url) => new URL(url).origin === "https://kamakura-media.niho.life");
  assert.equal(parsed.entries[0].summary.thumbnail.url, "https://kamakura-media.niho.life/og/current.jpg?width=1200&format=webp");
  assert.equal(parsed.entries[0].summary.members.data[0].role, "owner");

  membersQuerySuccess = false;
  assert.deepEqual((await directory()).entries.map((entry) => entry.summary.members), [{ status: "unavailable" }, { status: "unavailable" }, { status: "unavailable" }]);
  assert.deepEqual(warnings, [["NIHO Studio directory members unavailable", "Error"]]);
  membersQuerySuccess = true;

  projectRows = [row("kamakura", "https://next-kamakura.niho.life")];
  publicResponse = async () => new Response('<meta property="og:image" content="https://evil.example.test/private.png">', { headers: { "Content-Type": "text/html" } });
  const unsafeImage = (await directory()).entries[0].summary;
  assert.equal(unsafeImage.thumbnail, null);
  assert.equal(unsafeImage.publicationStatus, "published");
  publicResponse = async () => new Response(`<meta property="og:image" content="https://next-kamakura.niho.life/og.png">${"x".repeat(260 * 1024)}`, { headers: { "Content-Type": "text/html" } });
  assert.equal((await directory()).entries[0].summary.thumbnail, null);

  // 100 Projectでも、同じ公開originは共有し、外部fetchは固定allowlistの3件だけ。
  const allowedOrigins = ["https://next-kamakura.niho.life", "https://kamakura.niho.life", "https://experience.niho.life"];
  projectRows = Array.from({ length: 100 }, (_, index) => ({
    project_id: `project-p${index}`, project_name: `Project ${String(index).padStart(3, "0")}`,
    site_id: `site${index}`, site_name: `Site ${index}`, public_origin: allowedOrigins[index % allowedOrigins.length], display_name: "現在の利用者"
  }));
  memberRows = projectRows.map((projectRow, index) => ({ project_id: projectRow.project_id, display_name: `参加者 ${index}`, role: index % 2 === 0 ? "owner" : "editor" }));
  publicResponse = async (url) => new Response(`<meta property="og:image" content="${new URL(url).origin}/og.png">`, { headers: { "Content-Type": "text/html" } });
  const callsBeforeMany = publicCalls.length;
  const memberCallsBeforeMany = membersQueryCalls;
  const many = await directory();
  assert.equal(many.entries.length, 100);
  assert.equal(publicCalls.length - callsBeforeMany, 3);
  assert.equal(membersQueryCalls - memberCallsBeforeMany, 1);
  assert.deepEqual(new Set(publicCalls.slice(callsBeforeMany).map((call) => call.url)), new Set(allowedOrigins.map((origin) => `${origin}/`)));
  assert.ok(many.entries.every((entry) => entry.summary.thumbnail !== null));
  assert.ok(many.entries.every((entry) => entry.summary.members.status === "ready" && entry.summary.members.data.length === 1));

  // timeout は一覧全体を失敗させず、進行中の公開ページ fetch を abort する。
  projectRows = [row("kamakura", "https://next-kamakura.niho.life")];
  memberRows = [{ project_id: "project-kamakura", display_name: "編集者", role: "editor" }];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requested, reached;
  const requestStarted = new Promise((resolve) => { reached = resolve; });
  publicResponse = async (_url, options) => new Promise((_, reject) => {
    requested = options.signal;
    reached();
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const pending = directory();
  await requestStarted;
  t.mock.timers.tick(2_000);
  assert.equal((await pending).entries[0].summary.thumbnail, null);
  assert.equal(requested.aborted, true);
  t.mock.timers.reset();
});
