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

test("Experience editor routes close while Kamakura reads and site freeze reporting remain available", async (t) => {
  const auth = await accessFixture();
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const workerSource = bundled.outputFiles[0].text;
  for (const forbidden of ["https://api.niho.life", "https://api-stg.niho.life"]) assert.equal(workerSource.includes(forbidden), false, forbidden);
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  const roles = new Map(), upstream = [], kamakuraCalls = [], editingRequests = [], assets = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    upstream.push(String(url));
    return Response.json({ shouldNotBeCalled: true });
  });
  const site = { id: "kamakura", name: "鎌倉サイト", domains: ["https://next-kamakura.niho.life"] };
  const catalog = { project: { id: "kamakura-site", name: "NIHO kamakura", site }, sites: [site], pages: [{ siteId: "kamakura", pageId: "home", locale: "ja", title: "NIHO kamakura", path: "/", kind: "page" }], legacy: [], nativePresentationPages: ["home"], blockContracts: { KamakuraLegacyForm: { props: { formId: { type: "enum", values: ["community-dinner"] } } } } };
  const readOnly = { reason: "サイトの見た目の編集は凍結中です。" };
  const writeResponse = () => Response.json({ error: "visual_editor_frozen", message: "凍結中" }, { status: 409 });
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: Buffer.alloc(32, 23).toString("base64url"),
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() { const role = roles.get(`${this.values[1]}/${this.values[2]}`); return role && (!/m\.role = 'owner'/u.test(query) || role === "owner") ? { allowed: 1 } : null; } }; } },
    ASSETS: { async fetch(request) { assets.push(request.url); if (new URL(request.url).pathname !== "/index.html") return new Response(null, { status: 404 }); return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch(request) {
      const requestUrl = new URL(request.url), path = requestUrl.pathname;
      kamakuraCalls.push(`${request.method} ${path}`);
      if (path.endsWith("/catalog")) return Response.json(catalog);
      if (path === "/api/edit/v1/sites/kamakura/operations/pages.read/home") {
        const locale = requestUrl.searchParams.get("locale") ?? "ja";
        const document = { schemaVersion: 1, siteId: "kamakura", pageId: "home", locale, revision: 2, title: locale === "en" ? "Home" : "トップ", tokens: {}, body: [] };
        const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/u, "");
        const scope = token?.split(".")[1];
        if (scope) editingRequests.push({ locale, scope: JSON.parse(Buffer.from(scope, "base64url").toString("utf8")).scope });
        if (locale === "en") {
          const presentation = { schemaVersion: 1, siteId: "kamakura", locale: "en", version: "presentation-en-v1", reset: "neutral-v1", tokens: {}, fonts: [],
            shared: { header: { ...document, pageId: "site-header" }, footer: { ...document, pageId: "site-footer" } },
            links: { origin: "https://next-kamakura.niho.life", sourcePath: "/en", paths: { "/old-home": "/en" } } };
          return Response.json({ document, version: `l.${"a".repeat(64)}`, presentationVersion: presentation.version, presentation });
        }
        return Response.json({ document, version: "v1", presentation: {}, editorState: { readOnly } });
      }
      if (request.method === "GET") return Response.json({ document: { siteId: "kamakura", pageId: "home", locale: "ja" }, version: "v1", readOnly });
      return writeResponse();
    } },
  };
  const call = (path, options = {}) => worker.fetch(new Request(`https://studio.niho.life${path}`, { ...options, headers: { "Cf-Access-Jwt-Assertion": auth.jwt, ...options.headers } }), env);
  const write = (path, method = "PUT") => call(path, { method, headers: { Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: "{}" });
  const experience = "/api/projects/project-experience/sites/experience";
  const kamakura = "/api/projects/project-kamakura/sites/kamakura";

  assert.equal((await worker.fetch(new Request(`https://studio.niho.life${experience}/editor/sites`), env)).status, 401);
  assert.equal((await call(`${experience}/editor/sites`)).status, 404);
  assert.equal((await call(`${kamakura}/editor/catalog`)).status, 403);
  assert.equal((await write(`${kamakura}/editor/home/english-publication-retry`, "POST")).status, 403);
  assert.equal(kamakuraCalls.length, 0);
  roles.set("project-experience/experience", "editor");
  roles.set("project-kamakura/kamakura", "editor");
  for (const path of [`${experience}/editor/sites`, `${experience}/editor/sites/experience/pages/home/en`]) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error, "not_found");
  }
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 404);
  roles.set("project-experience/experience", "owner");
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 404);

  const catalogResponse = await call(`${kamakura}/editor/catalog`);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual((await catalogResponse.json()).nativePresentationPages, ["home"]);
  assert.equal((await call(`${kamakura}/editor/home`)).status, 404, "旧ページsnapshot routeをBFFから削除");
  const page = await call(`${kamakura}/editor/editing-api/v1/sites/kamakura/operations/pages.read/home?locale=ja`, {
    headers: { Accept: "application/json; profile=niho-editor-snapshot-v1" }
  });
  assert.equal(page.status, 200);
  assert.deepEqual((await page.json()).editorState.readOnly, readOnly);
  const englishPage = await call(`${kamakura}/editor/editing-api/v1/sites/kamakura/operations/pages.read/home?locale=en`, {
    headers: { Accept: "application/json; profile=niho-editor-snapshot-v1" }
  });
  assert.equal(englishPage.status, 200);
  assert.deepEqual((await englishPage.json()).presentation.links.paths, { "/old-home": "/en" });
  assert.deepEqual(editingRequests.at(-1), { locale: "en", scope: ["pages.read"] }, "English page reads delegate only read permission");
  const callsBeforeEnglishWrite = kamakuraCalls.length;
  assert.equal((await write(`${kamakura}/editor/editing-api/v1/sites/kamakura/operations/pages.save/home?locale=en`, "PUT")).status, 404);
  assert.equal(kamakuraCalls.length, callsBeforeEnglishWrite, "the English read exception does not authorize page writes");
  const applied = await write(`${kamakura}/editor/editing-api/v1/sites/kamakura/operations/pages.apply/home?locale=ja`, "POST");
  assert.equal(applied.status, 409);
  assert.deepEqual(await applied.json(), { error: "visual_editor_frozen", message: "凍結中" });
  for (const [path, method] of [["draft", "PUT"], ["release-plan", "POST"], ["release", "POST"]]) {
    const response = await write(`${kamakura}/editor/home/${path}`, method);
    assert.equal(response.status, 404, path);
  }
  assert.equal((await call(`${kamakura}/editor/home?upstream=https://untrusted.example`)).status, 400);
  assert.equal((await call(`${kamakura}/editor-staging/catalog`)).status, 404);
  assert.deepEqual(kamakuraCalls, [
    "GET /internal/studio/web-content/catalog",
    "GET /api/edit/v1/sites/kamakura/operations/pages.read/home",
    "GET /api/edit/v1/sites/kamakura/operations/pages.read/home",
    "POST /api/edit/v1/sites/kamakura/operations/pages.apply/home",
  ]);

  for (const path of [
    "/projects/project-experience/sites/experience/editor",
    "/projects/niho-experience/admin/editor",
    "/projects/project-experience/sites/experience/editor/staging",
    "/projects/niho-experience/admin/editor/staging",
  ]) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /frame-src|'unsafe-inline'|next-kamakura/u, path);
  }
  for (const path of ["/projects/project-kamakura/sites/kamakura/editor", "/projects/kamakura-site/admin/editor"]) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    const csp = response.headers.get("Content-Security-Policy");
    assert.match(csp, /connect-src 'self' https:\/\/next-kamakura\.niho\.life;/u, path);
    assert.match(csp, /script-src 'self' https:\/\/www\.instagram\.com\/embed\.js;/u, path); assert.doesNotMatch(csp, /script-src[^;]*(?:facebook|platform\.twitter\.com)/iu, path);
    assert.match(csp, /font-src 'self' https:\/\/kamakura-media\.niho\.life\/niho-web\/fonts\/v1\//u, path);
    assert.match(csp, /frame-src 'self' https:;/u, path);
    assert.doesNotMatch(csp, /frame-src[^;]*platform\.twitter\.com/iu, path);
  }
  assert.equal((await call("/api/session")).status, 200);
  assert.equal(upstream.length, 0);
  assert.ok(assets.length >= 6);
});
