import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function accessFixture() {
  const issuer = "https://frozen-editor-test.example", audience = "frozen-editor-test", subject = "frozen-editor-subject", kid = "frozen-editor-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 300, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

test("Experience editor stays frozen while Kamakura reads pass and site freezes stay explicit", async (t) => {
  const auth = await accessFixture();
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const workerSource = bundled.outputFiles[0].text;
  for (const forbidden of ["https://api.niho.life", "https://api-stg.niho.life"]) assert.equal(workerSource.includes(forbidden), false, forbidden);
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  const roles = new Map(), upstream = [], kamakuraCalls = [], assets = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    upstream.push(String(url));
    return Response.json({ shouldNotBeCalled: true });
  });
  const site = { id: "kamakura", name: "鎌倉サイト（新サイト確認用）", domains: ["https://next-kamakura.niho.life"] };
  const catalog = { project: { id: "kamakura-site", name: "NIHO kamakura", site }, sites: [site], pages: [{ siteId: "kamakura", pageId: "home", locale: "ja", title: "NIHO kamakura", path: "/", kind: "page" }], legacy: [], nativePresentationPages: ["home"], blockContracts: { KamakuraLegacyForm: { props: { formId: { type: "enum", values: ["community-dinner"] } } } } };
  const readOnly = { reason: "サイトの見た目の編集は凍結中です。" };
  let writeResponse = () => Response.json({ error: "visual_editor_frozen", message: "凍結中" }, { status: 409 });
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: Buffer.alloc(32, 23).toString("base64url"),
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() { const role = roles.get(`${this.values[1]}/${this.values[2]}`); return role && (!/m\.role = 'owner'/u.test(query) || role === "owner") ? { allowed: 1 } : null; } }; } },
    ASSETS: { async fetch(request) { assets.push(request.url); return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch(request) {
      const path = new URL(request.url).pathname;
      kamakuraCalls.push(`${request.method} ${path}`);
      if (path.endsWith("/catalog")) return Response.json(catalog);
      if (request.method === "GET") return Response.json({ document: { siteId: "kamakura", pageId: "home", locale: "ja" }, version: "v1", readOnly });
      return writeResponse();
    } },
  };
  const call = (path, options = {}) => worker.fetch(new Request(`https://studio.niho.life${path}`, { ...options, headers: { "Cf-Access-Jwt-Assertion": auth.jwt, ...options.headers } }), env);
  const write = (path, method = "PUT") => call(path, { method, headers: { Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: "{}" });
  const experience = "/api/projects/project-experience/sites/experience";
  const kamakura = "/api/projects/project-kamakura/sites/kamakura";

  assert.equal((await worker.fetch(new Request(`https://studio.niho.life${experience}/editor/sites`), env)).status, 401);
  assert.equal((await call(`${experience}/editor/sites`)).status, 403);
  assert.equal((await call(`${kamakura}/editor/catalog`)).status, 403);
  assert.equal(kamakuraCalls.length, 0);
  roles.set("project-experience/experience", "editor");
  roles.set("project-kamakura/kamakura", "editor");
  for (const path of [`${experience}/editor/sites`, `${experience}/editor/sites/experience/pages/home/en`]) {
    const response = await call(path);
    assert.equal(response.status, 409, path);
    assert.equal((await response.json()).error, "visual_editor_frozen");
  }
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 403);
  roles.set("project-experience/experience", "owner");
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 409);

  const catalogResponse = await call(`${kamakura}/editor/catalog`);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual((await catalogResponse.json()).nativePresentationPages, ["home"]);
  const page = await call(`${kamakura}/editor/home`);
  assert.equal(page.status, 200);
  assert.deepEqual((await page.json()).readOnly, readOnly);
  for (const [path, method] of [[`${kamakura}/editor/home/draft`, "PUT"], [`${kamakura}/editor/home/release-plan`, "POST"], [`${kamakura}/editor/home/release`, "POST"]]) {
    const response = await write(path, method);
    assert.equal(response.status, 409, path);
    assert.deepEqual(await response.json(), { error: "visual_editor_frozen" }, path);
  }
  writeResponse = () => Response.json({ error: "ほかの変更が入りました。" }, { status: 409 });
  const conflict = await write(`${kamakura}/editor/home/draft`);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "conflict" });
  assert.equal((await call(`${kamakura}/editor/home?upstream=https://untrusted.example`)).status, 400);
  assert.equal((await call(`${kamakura}/editor-staging/catalog`)).status, 404);
  assert.deepEqual(kamakuraCalls, [
    "GET /internal/studio/web-content/catalog",
    "GET /internal/studio/web-content/home",
    "PUT /internal/studio/web-content/home/draft",
    "POST /internal/studio/web-content/home/release-plan",
    "POST /internal/studio/web-content/home/release",
    "PUT /internal/studio/web-content/home/draft",
  ]);

  for (const path of [
    "/projects/project-experience/sites/experience/editor",
    "/projects/niho-experience/admin/editor",
    "/projects/project-experience/sites/experience/editor/staging",
    "/projects/niho-experience/admin/editor/staging",
  ]) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /frame-src|'unsafe-inline'|next-kamakura/u, path);
  }
  for (const path of ["/projects/project-kamakura/sites/kamakura/editor", "/projects/kamakura-site/admin/editor"]) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    const csp = response.headers.get("Content-Security-Policy");
    assert.match(csp, /connect-src 'self' https:\/\/next-kamakura\.niho\.life;/u, path);
    assert.match(csp, /font-src 'self' https:\/\/kamakura-media\.niho\.life\/niho-web\/fonts\/v1\//u, path);
    assert.match(csp, /frame-src 'self' https:\/\/kamakura-media\.niho\.life\/niho-web\/embeds\/v1\/ https:\/\/www\.google\.com\/maps\/embed https:\/\/www\.youtube-nocookie\.com\/embed\/ https:\/\/player\.vimeo\.com\/video\/ https:\/\/lottie\.host\/embed\/;/u, path);
  }
  assert.equal((await call("/api/session")).status, 200);
  assert.equal(upstream.length, 0);
  assert.ok(assets.length >= 6);
});

test("Studio client bundle includes the Kamakura editor but not the frozen Experience editor", async () => {
  const result = await build({ entryPoints: [new URL("../studio/client.tsx", import.meta.url).pathname], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, define: { "process.env.NODE_ENV": '"production"' } });
  const inputs = Object.keys(result.metafile.inputs);
  for (const pattern of [/studio\/integration-entry\.tsx$/u, /studio\/experience-editor\.tsx$/u]) {
    assert.equal(inputs.some((input) => pattern.test(input)), false, pattern.source);
  }
  for (const pattern of [/studio\/kamakura-editor\.tsx$/u, /src\/editor\.tsx$/u]) {
    assert.equal(inputs.some((input) => pattern.test(input)), true, pattern.source);
  }
});
