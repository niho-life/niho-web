import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const STUDIO = "https://studio.niho.life";
const BASE = "/api/projects/project-kamakura/sites/kamakura/breakpoints";
const SETTINGS = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [
  { name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "Small", minWidth: 991, previewWidth: 991 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }
] };

async function fixture() {
  const issuer = `https://breakpoints-${crypto.randomUUID()}.example`, audience = "breakpoints-test", subject = "breakpoints-subject", kid = "breakpoints-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 600, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" }, worker: (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default };
}

function harness(auth) {
  let role = null, version = 1, settings = structuredClone(SETTINGS), exists = true;
  const env = {
    ACCESS_ISSUER: auth.issuer, ACCESS_AUDIENCE: auth.audience,
    DB: {
      prepare(query) { return { values: [], bind(...values) { this.values = values; return this; }, async first() {
        if (query.includes("FROM project_members AS m")) return role && this.values[1] === "project-kamakura" && this.values[2] === "kamakura" ? { allowed: 1 } : null;
        if (query.includes("FROM site_breakpoint_settings")) return exists ? { settings_json: JSON.stringify(settings), version } : null;
        throw new Error(`unexpected D1 first: ${query}`);
      } }; },
      async batch(statements) {
        const statement = statements[0], [json, siteId, expected, subject, projectId] = statement.values;
        const changed = exists && role && siteId === "kamakura" && expected === version && subject === auth.subject && projectId === "project-kamakura";
        if (changed) { settings = JSON.parse(json); version += 1; }
        return [{ success: true, meta: { changes: changed ? 1 : 0 }, results: [] }];
      }
    },
    ASSETS: { async fetch() { return new Response(""); } }, KAMAKURA_SITE: { async fetch() { throw new Error("not used"); } }
  };
  const send = (method, path = BASE, body, headers = {}) => auth.worker.fetch(new Request(`${STUDIO}${path}`, {
    method, headers: { "Cf-Access-Jwt-Assertion": auth.jwt, ...(method === "PUT" ? { Origin: STUDIO, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" } : {}), ...headers },
    ...(method === "PUT" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  }), env);
  return { send, setRole: (value) => { role = value; }, setVersion: (value) => { version = value; }, setExists: (value) => { exists = value; }, current: () => ({ settings, version }) };
}

const json = async (response, status) => { const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); assert.equal(response.headers.get("Cache-Control"), "no-store"); return value; };

test("site breakpoints API は鎌倉の owner/editor だけに GET/PUT を許し、D1 の version で CAS する", async (t) => {
  const auth = await fixture();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    throw new Error(`unexpected network request: ${url}`);
  });
  const h = harness(auth);
  assert.equal((await json(await h.send("GET"), 403)).error, "forbidden");
  h.setRole("editor");
  assert.deepEqual(await json(await h.send("GET"), 200), { settings: SETTINGS, version: "b.1" });
  const next = structuredClone(SETTINGS); next.breakpoints[1] = { name: "Small", minWidth: 1000, previewWidth: 1000 };
  assert.deepEqual(await json(await h.send("PUT", BASE, { settings: next, expectedVersion: "b.1" }), 200), { status: "saved", version: "b.2" });
  assert.deepEqual(h.current(), { settings: next, version: 2 });
  assert.equal((await json(await h.send("PUT", BASE, { settings: SETTINGS, expectedVersion: "b.1" }), 409)).error, "conflict");
  h.setRole("owner");
  assert.deepEqual(await json(await h.send("PUT", BASE, { settings: SETTINGS, expectedVersion: "b.2" }), 200), { status: "saved", version: "b.3" });
  h.setExists(false);
  assert.equal((await json(await h.send("GET"), 404)).error, "not_found");
});

test("site breakpoints API は別サイト・method・query・CSRF・不正な設定を閉じる", async (t) => {
  const auth = await fixture();
  t.mock.method(globalThis, "fetch", async (url) => String(url) === `${auth.issuer}/cdn-cgi/access/certs` ? Response.json({ keys: [auth.jwk] }) : Promise.reject(new Error("unexpected network")));
  const h = harness(auth); h.setRole("editor");
  assert.equal((await json(await h.send("GET", "/api/projects/project-experience/sites/experience/breakpoints"), 404)).error, "not_found");
  assert.equal((await json(await h.send("POST"), 405)).error, "method_not_allowed");
  assert.equal((await json(await h.send("GET", `${BASE}?x=1`), 400)).error, "invalid_request");
  assert.equal((await json(await h.send("PUT", BASE, { settings: SETTINGS, expectedVersion: "b.1" }, { Origin: "https://evil.example" }), 400)).error, "invalid_request");
  const invalid = structuredClone(SETTINGS); invalid.breakpoints[0].previewWidth = 1000;
  for (const body of [{ settings: invalid, expectedVersion: "b.1" }, { settings: SETTINGS, expectedVersion: "1" }, { settings: SETTINGS, expectedVersion: "b.1", extra: true }]) {
    assert.equal((await json(await h.send("PUT", BASE, body), 400)).error, "invalid_request");
  }
});
