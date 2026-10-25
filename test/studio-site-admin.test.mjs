import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseProjectAliasPath, projectRoutePath, projectShortcutTarget } from "../studio/project-routes.mjs";
import { siteAdmin } from "../studio/site-admin.mjs";

async function accessFixture() {
  const issuer = "https://site-admin-test.example", audience = "site-admin-test", subject = "site-admin-subject", kid = "site-admin-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 300, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

test("サイト機能の画面は alias の URL で開け、/project/<別名> は alias の URL へ移す", () => {
  assert.deepEqual(parseProjectAliasPath("/projects/kamakura-site/admin/cms"), { slug: "kamakura-site", projectId: "project-kamakura", siteId: "kamakura", page: "cms" });
  assert.equal(parseProjectAliasPath("/projects/kamakura-site/admin/translations/")?.page, "translations");
  assert.equal(parseProjectAliasPath("/projects/kamakura-site/admin/unknown"), null);
  assert.equal(projectRoutePath("/projects/project-kamakura/sites/kamakura", "project-kamakura", "kamakura", "assets"), "/projects/kamakura-site/admin/assets");
  assert.equal(projectRoutePath("/projects/project-kamakura/sites/kamakura", "project-kamakura", "kamakura", "dashboard"), "/projects/project-kamakura/sites/kamakura");
  assert.equal(projectRoutePath("/projects/kamakura-site/admin/cms", "project-kamakura", "kamakura", "dashboard"), "/projects/kamakura-site/admin");
  assert.equal(projectShortcutTarget("/project/kamakura-site"), "/projects/kamakura-site/admin");
  assert.equal(projectShortcutTarget("/project/kamakura-site/cms/"), "/projects/kamakura-site/admin/cms");
  assert.equal(projectShortcutTarget("/project/unknown"), null);
  assert.equal(projectShortcutTarget("/project/kamakura-site/editor/x"), null);
});

test("管理画面の origin は設定値の https の origin だけを使い、接続の無いサイトは null", () => {
  assert.deepEqual(siteAdmin({ KAMAKURA_ADMIN_ORIGIN: "https://admin.example.test" }, "project-kamakura", "kamakura"), { origin: "https://admin.example.test", paths: { cms: "/admin", translations: "/admin/localization" } });
  for (const value of [undefined, "", "http://admin.example.test", "https://admin.example.test/admin", "https://user:pass@admin.example.test", "https://admin.example.test?x=1", "not a url"]) {
    assert.equal(siteAdmin({ KAMAKURA_ADMIN_ORIGIN: value }, "project-kamakura", "kamakura"), null, String(value));
  }
  assert.equal(siteAdmin({ KAMAKURA_ADMIN_ORIGIN: "https://admin.example.test" }, "project-experience", "experience"), null);
});

test("Worker: 参加者にだけ管理画面の origin を返し、Dashboard だけ枠をその origin に許し、/project/<別名> は 301", async (t) => {
  const auth = await accessFixture();
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const roles = new Map();
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    KAMAKURA_ADMIN_ORIGIN: "https://admin.example.test",
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() { const role = roles.get(`${this.values[1]}/${this.values[2]}`); return role && (!/m\.role = 'owner'/u.test(query) || role === "owner") ? { allowed: 1 } : null; } }; } },
    ASSETS: { async fetch() { return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch() { throw new Error("kamakura-site should not be called"); } }
  };
  const call = (path) => worker.fetch(new Request(`https://studio.niho.life${path}`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), env);
  const api = "/api/projects/project-kamakura/sites/kamakura/site-admin";

  assert.equal((await worker.fetch(new Request(`https://studio.niho.life${api}`), env)).status, 401);
  assert.equal((await call(api)).status, 403);
  roles.set("project-kamakura/kamakura", "editor");
  const admin = await call(api);
  assert.equal(admin.status, 200);
  assert.deepEqual(await admin.json(), { origin: "https://admin.example.test", paths: { cms: "/admin", translations: "/admin/localization" } });
  roles.set("project-experience/experience", "editor");
  assert.equal((await call("/api/projects/project-experience/sites/experience/site-admin")).status, 404);
  assert.equal((await worker.fetch(new Request(`https://studio.niho.life${api}`, { headers: { "Cf-Access-Jwt-Assertion": auth.jwt } }), { ...env, KAMAKURA_ADMIN_ORIGIN: undefined })).status, 404);

  for (const path of ["/projects/kamakura-site/admin", "/projects/kamakura-site/admin/cms", "/projects/project-kamakura/sites/kamakura"]) {
    const page = await call(path);
    assert.equal(page.status, 200, path);
    const csp = page.headers.get("Content-Security-Policy");
    assert.match(csp, / frame-src https:\/\/admin\.example\.test https:\/\/site-admin-test\.example;/u, path);
    assert.match(csp, /frame-ancestors 'none'/u, path);
  }
  for (const path of ["/", "/projects/niho-experience/admin", "/projects/project-experience/sites/experience"]) {
    assert.doesNotMatch((await call(path)).headers.get("Content-Security-Policy"), /frame-src/u, path);
  }
  const editor = (await call("/projects/kamakura-site/admin/editor")).headers.get("Content-Security-Policy");
  assert.doesNotMatch(editor, /admin\.example\.test/u);

  const shortcut = await call("/project/kamakura-site");
  assert.equal(shortcut.status, 301);
  assert.equal(shortcut.headers.get("Location"), "/projects/kamakura-site/admin");
  assert.equal((await call("/project/kamakura-site/translations")).headers.get("Location"), "/projects/kamakura-site/admin/translations");
  assert.equal((await worker.fetch(new Request("https://studio.niho.life/project/kamakura-site"), env)).status, 401);
});
