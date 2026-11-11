import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { OPERATIONS } from "../cli/operations.mjs";

const { DatabaseSync } = await import("node:sqlite").catch((error) => {
  if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
  return {};
});
const testWithD1 = DatabaseSync ? test : test.skip;

const ORIGIN = "https://studio.example";
const PROJECT = "project-kamakura";
const SITE = "kamakura";
const SCOPE = `/api/cli/v1/projects/${PROJECT}/sites/${SITE}`;
const CLIENT = `${"a".repeat(32)}.access`;
const OTHER_CLIENT = `${"b".repeat(32)}.access`;
const CLI_SUBJECT = `studio-cli:${CLIENT}`;
const CLI_EMAIL = `cli-${CLIENT}@studio.invalid`;
const OWNER = "fixture-owner";
const HUMAN = "fixture-editor";
const SECRET = Buffer.alloc(32, 17);
const migrationDirectory = new URL("../studio/migrations/", import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFile(new URL(name, migrationDirectory), "utf8")));
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../studio/worker.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false
});
const worker = (await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`)).default;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

async function fixture(t) {
  const issuer = `https://access-${crypto.randomUUID()}.example`;
  const audience = "test-audience";
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function jwt(claims = {}, header = {}) {
    const value = { iss: issuer, aud: [audience], exp: now + 600, iat: now, type: "app", sub: "", common_name: CLIENT, ...claims };
    const input = `${encode({ alg: "RS256", kid: jwk.kid, typ: "JWT", ...header })}.${encode(value)}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  }
  const token = jwt(), humanToken = jwt({ sub: HUMAN, common_name: undefined, email: "editor@example.test" });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });

  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const sql of migrations) db.exec(sql);
  const member = db.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, ?, ?)");
  member.run(PROJECT, OWNER, "owner", "Fixture owner");
  member.run(PROJECT, "fixture-second-owner", "owner", "Fixture second owner");
  member.run(PROJECT, HUMAN, "editor", "Fixture editor");
  member.run("project-experience", OWNER, "owner", "Fixture owner");
  const calls = [];
  let respond = () => Response.json({ status: "ready" });

  const env = {
    DB: {
      prepare(query) {
        const statement = db.prepare(query);
        let params = [];
        return {
          bind(...values) { params = values; return this; },
          async first() { return statement.get(...params) ?? null; },
          async all() {
            if (/^UPDATE\b/u.test(query)) return { success: true, meta: statement.run(...params) };
            return { success: true, results: statement.all(...params) };
          }
        };
      }
    },
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: SECRET.toString("base64url"),
    ASSETS: { async fetch() { return new Response("public asset"); } },
    KAMAKURA_SITE: {
      async fetch(request) {
        const body = await request.text();
        const path = new URL(request.url).pathname;
        calls.push({ path, body, method: request.method, headers: request.headers });
        return respond(calls.at(-1));
      }
    }
  };
  const insert = db.prepare(`INSERT INTO studio_cli_grants
    (client_id, project_id, site_id, capability, delegated_by_subject, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const grant = (capability, options = {}) => insert.run(options.client ?? CLIENT, options.project ?? PROJECT, options.site ?? SITE, capability, options.owner ?? OWNER, now - 600, options.expiry ?? now + 600);
  function send(method, path, body, options = {}) {
    const headers = new Headers({
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    });
    if (options.token !== "") headers.set("Cf-Access-Jwt-Assertion", options.token ?? token);
    return worker.fetch(new Request(`${ORIGIN}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
  }
  const request = (method, operation, body, options) => send(method, `${SCOPE}/operations/${operation}`, body, options);
  return {
    calls, db, jwt, now, grant, send, request, token, humanToken,
    replyWith: (next) => { respond = next; },
    audit: () => db.prepare("SELECT * FROM studio_cli_audit ORDER BY rowid").all()
  };
}

async function check(response, status, error) {
  const json = await response.json();
  assert.equal(response.status, status, JSON.stringify(json));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  if (error !== undefined) assert.equal(json.error, error);
  return json;
}

testWithD1("CLI validates signed service application assertions and keeps service and browser routes separate", async (t) => {
  const h = await fixture(t);
  h.grant("pages.read");
  const discovery = `${SCOPE}/capabilities`;
  const [header, claims, signature] = h.token.split(".");
  const invalid = [
    "", h.humanToken, h.jwt({ iss: "https://other.example" }), h.jwt({ aud: ["other"] }),
    h.jwt({ type: "org" }), h.jwt({ exp: h.now, iat: h.now - 10 }), h.jwt({ iat: h.now + 180 }),
    h.jwt({ nbf: h.now + 180 }), h.jwt({ common_name: CLIENT.toUpperCase() }), h.jwt({ sub: undefined }),
    h.jwt({ email: null }), h.jwt({ sub: OWNER, email: "owner@example.test" }),
    h.jwt({}, { alg: "HS256" }), `${header}.${claims}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`
  ];
  for (const token of invalid) await check(await h.send("GET", discovery, undefined, { token }), 401, "authentication_required");

  await check(await h.send("GET", "/api/session"), 401, "session_expired");
  await check(await h.send("GET", "/api/projects/project-kamakura/sites/kamakura/editor/fixture-page"), 401, "session_expired");
  assert.equal((await h.send("GET", "/")).status, 401);
  await check(await h.send("GET", "/api/session", undefined, {
    token: h.jwt({ sub: CLI_SUBJECT, common_name: undefined, email: CLI_EMAIL })
  }), 401, "session_expired");
  assert.deepEqual(await check(await h.send("GET", "/api/session", undefined, { token: h.humanToken }), 200), {
    status: "authenticated", subject: HUMAN, email: "editor@example.test"
  });
  assert.equal(h.calls.length, 0);
});

testWithD1("CLI grants are isolated by client, project, site, capability, expiry and current owner", async (t) => {
  const h = await fixture(t);
  h.grant("pages.read");
  h.grant("cms.read", { client: OTHER_CLIENT });
  h.grant("pages.edit", { expiry: h.now - 1 });
  h.grant("pages.read", { project: "project-experience", site: "experience" });
  assert.throws(() => h.grant("cms.edit", { owner: HUMAN }), /require a project owner/u);
  assert.throws(() => h.grant("pages.read", { project: "project-experience" }), /FOREIGN KEY/u);
  assert.throws(() => h.grant("arbitrary.*"), /CHECK constraint/u);
  const discovery = await check(await h.send("GET", `${SCOPE}/capabilities`), 200);
  assert.deepEqual(discovery, {
    apiVersion: "v1", projectId: PROJECT, siteId: SITE, capabilities: ["pages.read"],
    operations: [
      { id: "pages.catalog", capability: "pages.read", method: "GET", parameters: [] },
      { id: "pages.read", capability: "pages.read", method: "GET", parameters: ["pageId"] }
    ]
  });
  await check(await h.send("GET", "/api/cli/v1/projects/project-experience/sites/experience/capabilities"), 404, "not_found");
  await check(await h.send("GET", "/api/cli/v1/projects/project-experience/sites/kamakura/capabilities"), 404, "not_found");
  await check(await h.send("GET", "/api/cli/v1/projects/project-kamakura/sites/experience/capabilities"), 404, "not_found");
  await check(await h.request("GET", "pages.read/fixture-page?next=https://other.example"), 400, "invalid_request");
  await check(await h.request("POST", "pages.read/fixture-page", {}), 405, "method_not_allowed");
  await check(await h.request("GET", "pages.read/fixture%2Fpage"), 404, "not_found");
  await check(await h.request("POST", "assets.upload-intent", {}), 404, "not_found");
  await check(await h.request("GET", "cms.schema"), 403, "forbidden");
  await check(await h.request("PUT", "pages.save/fixture-page", {}), 403, "forbidden");
  await check(await h.request("POST", "pages.release-plan/fixture-page", {}), 403, "forbidden");
  assert.equal(h.calls.length, 0);
  assert.equal(h.audit().length, 0);

  await check(await h.request("GET", "pages.read/fixture-page"), 200);
  h.db.prepare("DELETE FROM studio_cli_grants WHERE client_id = ? AND capability = ?").run(CLIENT, "pages.read");
  await check(await h.request("GET", "pages.read/fixture-page"), 403, "forbidden");
  h.grant("pages.read");
  h.db.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND access_subject = ?").run(PROJECT, OWNER);
  h.db.prepare("UPDATE project_members SET role = 'owner' WHERE project_id = ? AND access_subject = ?").run(PROJECT, OWNER);
  await check(await h.request("GET", "pages.read/fixture-page"), 403, "forbidden");
  assert.equal(h.calls.length, 1);
});

testWithD1("CLI calls the existing CMS bridge as a distinct actor and audits the validated operation", async (t) => {
  const h = await fixture(t);
  h.grant("cms.edit");
  const target = "cms.save/posts/example-item";
  const body = { version: "version-1", values: { title: "Fixture draft" } };
  h.replyWith(() => Response.json({
    status: "saved",
    item: {
      id: "example-item", title: "Fixture draft", subtitle: null, imageUrl: null, path: null,
      status: "draft", publishedAt: null, updatedAt: "2026-11-10T09:00:00Z", updatedBy: null,
      scheduledAt: null, publishFailed: false, order: null, version: "version-2", values: body.values
    }
  }));
  await check(await h.send("PUT", "/api/projects/project-kamakura/sites/kamakura/cms/collections/posts/items/example-item/draft", body, { token: h.humanToken }), 400, "invalid_request");
  await check(await h.request("PUT", target, { ...body, actor: { email: "someone@example.test" } }), 400, "invalid_request");
  await check(await h.request("PUT", target, body, { headers: { "Content-Type": "text/plain" } }), 400, "invalid_request");
  const response = await h.request("PUT", target, body, {
    headers: { "CF-Access-Client-Id": CLIENT, "CF-Access-Client-Secret": "fixture-secret", Cookie: "fixture-cookie=secret" }
  });
  const result = await check(response, 200);
  assert.equal(result.item.version, "version-2");
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.path, "/internal/studio/cms/collections/posts/items/example-item/draft");
  assert.equal(call.headers.get("X-NIHO-Studio-Subject"), CLI_SUBJECT);
  assert.deepEqual(JSON.parse(call.body), { ...body, actor: { email: CLI_EMAIL } });
  for (const header of ["Cf-Access-Jwt-Assertion", "CF-Access-Client-Id", "CF-Access-Client-Secret", "Cookie", "Origin", "Sec-Fetch-Site"]) {
    assert.equal(call.headers.get(header), null);
  }
  const signatureInput = ["v1", call.headers.get("X-NIHO-Studio-Timestamp"), call.method, call.path,
    createHash("sha256").update(call.body).digest("hex"), PROJECT, CLI_SUBJECT].join("\n");
  assert.equal(call.headers.get("X-NIHO-Studio-Signature"), `v1=${createHmac("sha256", SECRET).update(signatureInput).digest("hex")}`);

  const rows = h.audit();
  assert.deepEqual(rows.map(({ http_status }) => http_status), [400, 400, 200]);
  const row = rows.at(-1);
  assert.equal(row.id, call.headers.get("X-NIHO-Studio-Request-ID"));
  assert.equal(row.id, response.headers.get("X-Studio-Operation-Id"));
  assert.equal(row.actor_subject, CLI_SUBJECT);
  assert.equal(row.delegated_by_subject, OWNER);
  assert.equal(row.project_id, PROJECT);
  assert.equal(row.site_id, SITE);
  assert.equal(row.capability, "cms.edit");
  assert.equal(row.operation, "cms.save");
  assert.deepEqual(JSON.parse(row.target_json), { collectionId: "posts", itemId: "example-item" });
  assert.ok(!JSON.stringify(rows).includes("Fixture draft"));
  assert.ok(!JSON.stringify(rows).includes("fixture-secret"));
});

testWithD1("CLI separates localization reads, edits, reviews, translation and publication", async (t) => {
  const h = await fixture(t);
  h.grant("translations.read");
  h.grant("translations.edit");
  const resumeToken = "test-release-resume";
  const state = {
    status: "ready", current: null, history: [], pending: {
      operation: "publish", stage: "apply", progress: { done: 1, total: 2 }, resumeToken, releaseId: null,
      startedAt: "2026-11-10T09:00:00Z", startedBy: null
    }
  };
  h.replyWith(() => Response.json(state));
  const history = await check(await h.request("POST", "translations.release-history", {}), 200);
  assert.deepEqual(history, { ...state, pending: null });
  await check(await h.request("POST", "translations.release-state", {}), 403, "forbidden");
  await check(await h.request("POST", "translations.catalog-advance", {}), 403, "forbidden");
  await check(await h.request("POST", "translations.job/fixture-job", {}), 403, "forbidden");
  const review = {
    action: "review-current", itemKey: "test-item", unitId: "title",
    operationId: "operation-1234567", expectedVersion: "v1", expectedSourceVersion: "v2"
  };
  await check(await h.request("POST", "translations.review-current/test-item", review), 403, "forbidden");
  await check(await h.request("POST", "translations.set-value/test-item", review), 400, "invalid_request");
  assert.equal(h.calls.length, 1);

  h.grant("translations.review");
  h.replyWith(() => Response.json({ status: "invalid", message: "Fixture no longer reviewable" }));
  await check(await h.request("POST", "translations.review-current/test-item", review), 200);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body).actor, { email: CLI_EMAIL, role: "editor" });

  h.grant("translations.publish");
  h.replyWith(() => Response.json(state));
  assert.deepEqual(await check(await h.request("POST", "translations.release-state", {}), 200), state);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body).actor, { email: CLI_EMAIL, role: "editor" });
  h.replyWith(() => Response.json({ status: "conflict" }));
  await check(await h.request("POST", "translations.release-apply", { confirmationToken: null, resumeToken }), 200);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body).actor, { email: CLI_EMAIL, role: "owner" });
  await check(await h.request("PUT", "translations.settings", {}), 403, "forbidden");
  assert.ok(!JSON.stringify(h.audit()).includes(resumeToken));
});

testWithD1("all advertised CLI capabilities fit the migration and have unique operation IDs", async (t) => {
  const h = await fixture(t);
  const ids = OPERATIONS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const capability of new Set(OPERATIONS.map((spec) => spec.capability))) h.grant(capability);
  const discovery = await check(await h.send("GET", `${SCOPE}/capabilities`), 200);
  assert.deepEqual(discovery.operations.map(({ id }) => id), ids);
});

function cli(args, { input = "", fetchImpl } = {}) {
  const preload = fetchImpl ? ["--import", `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${fetchImpl};`)}`] : [];
  const command = fileURLToPath(new URL("../cli/niho-studio.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preload, command, "--origin", ORIGIN, "--project", PROJECT, "--site", SITE, ...args], {
      env: { ...process.env, CF_ACCESS_CLIENT_ID: CLIENT, CF_ACCESS_CLIENT_SECRET: "fixture-secret" }
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("CLI uses JSON input and a fixed HTTPS origin and never follows Access redirects", async () => {
  const result = await cli(["request", "translations.review-current", "test-item", "--json", "-"], {
    input: '{"itemKey":"test-item"}',
    fetchImpl: `async (url, init) => {
      if (url !== "${ORIGIN}${SCOPE}/operations/translations.review-current/test-item"
        || init.method !== "POST" || init.redirect !== "manual" || init.credentials !== "omit"
        || init.headers["CF-Access-Client-Id"] !== "${CLIENT}"
        || init.headers["CF-Access-Client-Secret"] !== "fixture-secret"
        || Object.hasOwn(init.headers, "Origin") || Object.hasOwn(init.headers, "Sec-Fetch-Site")
        || init.body !== '{"itemKey":"test-item","action":"review-current"}') throw new Error("bad request");
      return Response.json({ status: "ready" }, { headers: { "X-Studio-Operation-Id": "00000000-0000-4000-8000-000000000001" } });
    }`
  });
  assert.deepEqual(result, { exitCode: 0, stdout: '{"apiVersion":"v1","httpStatus":200,"operationId":"00000000-0000-4000-8000-000000000001","result":{"status":"ready"}}\n', stderr: "" });

  const redirect = await cli(["discover"], {
    fetchImpl: `async (url, init) => {
      if (url !== "${ORIGIN}${SCOPE}/capabilities" || init.redirect !== "manual") throw new Error("bad request");
      return Response.redirect("https://outside.example/fixture-secret", 302);
    }`
  });
  assert.deepEqual(redirect, { exitCode: 1, stdout: '{"apiVersion":"v1","httpStatus":302,"operationId":null,"result":{"error":"access_redirect"}}\n', stderr: "" });

  const bad = await cli(["request", "pages.read", "fixture-page", "--origin", "http://wrong.example"]);
  assert.deepEqual(bad, { exitCode: 2, stdout: '{"apiVersion":"v1","httpStatus":null,"operationId":null,"result":{"error":"invalid_origin"}}\n', stderr: "" });
});
