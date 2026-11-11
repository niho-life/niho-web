import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { OPERATIONS, OPERATION_KEY_HEADER } from "../cli/operations.mjs";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";

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
const REQUEST_KEY = "a0000000-0000-4000-a000-000000000001";
const migrationDirectory = new URL("../studio/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
const migrations = await Promise.all(migrationNames.map((name) => readFile(new URL(name, migrationDirectory), "utf8")));
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../studio/worker.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false
});
const worker = (await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`)).default;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

async function fixture(t, { previewOrigin } = {}) {
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
  let beforeBatch;

  const env = {
    DB: {
      prepare(query) {
        const statement = db.prepare(query);
        let params = [];
        return {
          bind(...values) { params = values; return this; },
          async first() { return statement.get(...params) ?? null; },
          execute() {
            if (/^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(query)) return { success: true, meta: statement.run(...params) };
            return { success: true, results: statement.all(...params) };
          },
          async all() { return this.execute(); }
        };
      },
      async batch(statements) {
        const before = beforeBatch;
        beforeBatch = undefined;
        before?.();
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    },
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: SECRET.toString("base64url"),
    KAMAKURA_CLI_PREVIEW_ORIGIN: previewOrigin,
    ASSETS: { async fetch() { return new Response("public asset"); } },
    KAMAKURA_SITE: {
      async fetch(request) {
        const body = await request.text();
        const { origin, pathname: path } = new URL(request.url);
        calls.push({ origin, path, body, method: request.method, headers: request.headers });
        return respond(calls.at(-1));
      }
    }
  };
  const insert = db.prepare(`INSERT INTO studio_cli_grants
    (client_id, project_id, site_id, capability, delegated_by_subject, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const grant = (capability, options = {}) => insert.run(options.client ?? CLIENT, options.project ?? PROJECT, options.site ?? SITE, capability, options.owner ?? OWNER, now - 600, options.expiry === undefined ? now + 600 : options.expiry);
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
    beforeNextBatch: (callback) => { beforeBatch = callback; },
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
      { id: "pages.read", capability: "pages.read", method: "GET", parameters: ["pageId"] },
      { id: "pages.embed-status", capability: "pages.read", method: "POST", parameters: ["pageId"] }
    ]
  });
  await check(await h.send("GET", "/api/cli/v1/projects/project-experience/sites/experience/capabilities"), 404, "not_found");
  await check(await h.send("GET", "/api/cli/v1/projects/project-experience/sites/kamakura/capabilities"), 404, "not_found");
  await check(await h.send("GET", "/api/cli/v1/projects/project-kamakura/sites/experience/capabilities"), 404, "not_found");
  await check(await h.request("GET", "pages.read/fixture-page?next=https://other.example"), 400, "invalid_request");
  await check(await h.request("POST", "pages.read/fixture-page", {}), 405, "method_not_allowed");
  await check(await h.request("GET", "pages.read/fixture%2Fpage"), 404, "not_found");
  await check(await h.request("POST", "assets.upload-intent", {}), 403, "forbidden");
  await check(await h.request("POST", "pages.embed-import/fixture-page", {}), 403, "forbidden");
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

testWithD1("a keyed CLI operation dispatches once and exposes only its receipt status after a lost response", async (t) => {
  const h = await fixture(t);
  h.grant("pages.edit");
  h.grant("pages.read");
  h.grant("pages.edit", { client: OTHER_CLIENT });
  const endpoint = `${SCOPE}/operation-status/${REQUEST_KEY}`;
  const options = { headers: { [OPERATION_KEY_HEADER]: REQUEST_KEY } };
  const hostEntered = Promise.withResolvers();
  const hostResponse = Promise.withResolvers();
  h.replyWith((call) => {
    hostEntered.resolve(call);
    return hostResponse.promise;
  });
  const body = { expectedVersion: "test-version", document: { title: "private draft fixture" } };

  await check(await h.send("GET", endpoint), 404, "not_found");
  await check(await h.send("GET", `${SCOPE}/operation-status/malformed`), 400, "invalid_request");
  await check(await h.send("POST", endpoint, {}), 405, "method_not_allowed");
  await check(await h.send("GET", endpoint, undefined, { token: h.humanToken }), 401, "authentication_required");
  await check(await h.request("PUT", "pages.save/fixture-page", body, { headers: { [OPERATION_KEY_HEADER]: "malformed" } }), 400, "invalid_request");
  assert.equal(h.audit().length, 0);

  const initial = h.request("PUT", "pages.save/fixture-page", body, options);
  try {
    const call = await Promise.race([hostEntered.promise, initial.then(() => assert.fail("host not dispatched"))]);
    assert.equal(call.headers.get(OPERATION_KEY_HEADER), null);
    const [row] = h.audit();
    assert.equal(row.request_key, REQUEST_KEY);
    assert.notEqual(row.id, REQUEST_KEY);
    assert.equal(row.id, call.headers.get("X-NIHO-Studio-Request-ID"));
    const received = await check(await h.send("GET", `${SCOPE}/operation-status/${REQUEST_KEY.toUpperCase()}`), 200);
    assert.deepEqual(received, {
      status: "received", operationId: row.id, operation: "pages.save",
      startedAt: new Date(row.started_at * 1000).toISOString(), httpStatus: null
    });

    const duplicates = await Promise.all([
      h.request("PUT", "pages.save/fixture-page", body, options),
      h.request("PUT", "pages.save/other-page", body, { headers: { [OPERATION_KEY_HEADER]: REQUEST_KEY.toUpperCase() } }),
      h.request("GET", "pages.read/fixture-page", undefined, options)
    ]);
    for (const response of duplicates) await check(response, 409, "duplicate_operation");
    await check(await h.request("POST", "pages.release-plan/fixture-page", {}, options), 403, "forbidden");
    await check(await h.send("GET", endpoint, undefined, { token: h.jwt({ common_name: OTHER_CLIENT }) }), 404, "not_found");
    await check(await h.send("GET", endpoint.replace("/sites/kamakura/", "/sites/other/")), 404, "not_found");
    assert.equal(h.calls.length, 1);
    assert.equal(h.audit().length, 1);

    // Drop the original response; receipt status must remain independently retrievable.
    hostResponse.resolve(Response.json({ version: "fixture-result-must-not-be-replayed" }));
    await (await initial).body.cancel();
    const completed = await check(await h.send("GET", endpoint), 200);
    assert.deepEqual(completed, { ...received, status: "completed", httpStatus: 200 });
    assert.equal(h.calls.length, 1);

    h.db.prepare("DELETE FROM studio_cli_grants WHERE client_id = ? AND capability = ?").run(CLIENT, "pages.edit");
    await check(await h.send("GET", endpoint), 404, "not_found");
    await check(await h.request("PUT", "pages.save/fixture-page", body, options), 403, "forbidden");
    await check(await h.request("GET", "pages.read/fixture-page", undefined, options), 403, "forbidden");
    assert.equal(h.calls.length, 1);
  } finally {
    hostResponse.resolve(Response.json({ status: "ready" }));
    await initial;
  }
});

testWithD1("operation key migration preserves existing audit rows without requiring a key", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const migrationIndex = migrationNames.findIndex((name) => name.startsWith("0008_"));
  for (const migration of migrations.slice(0, migrationIndex)) db.exec(migration);
  db.prepare(`
    INSERT INTO studio_cli_audit (id, actor_subject, delegated_by_subject, project_id, site_id, capability, operation, target_json, http_status)
    VALUES ('legacy-audit', ?, ?, ?, ?, 'pages.read', 'pages.read', '{}', 200)
  `).run(CLI_SUBJECT, OWNER, PROJECT, SITE);
  db.exec(migrations[migrationIndex]);
  const row = db.prepare("SELECT id, http_status, request_key FROM studio_cli_audit").get();
  assert.deepEqual({ ...row }, { id: "legacy-audit", http_status: 200, request_key: null });
});

testWithD1("CLI breakpoint grants are independent and recheck the delegating owner inside the version CAS", async (t) => {
  const h = await fixture(t);
  h.grant("site.settings.read", { expiry: null, owner: "fixture-second-owner" });
  h.grant("site.settings.write", { expiry: h.now - 1 });
  const read = () => h.request("GET", "site.breakpoints.read");
  const save = (body) => h.request("PUT", "site.breakpoints.save", body);
  const initial = await check(await read(), 200);
  assert.equal(initial.version, "b.1");
  const settings = structuredClone(initial.settings);
  settings.breakpoints[1].minWidth = 1000;
  settings.breakpoints[1].previewWidth = 1000;
  await check(await save({ settings, expectedVersion: initial.version }), 403, "forbidden");
  assert.equal(h.audit().at(-1).delegated_by_subject, "fixture-second-owner");

  const deleteGrant = h.db.prepare("DELETE FROM studio_cli_grants WHERE client_id = ? AND capability = ?");
  deleteGrant.run(CLIENT, "site.settings.write");
  h.grant("site.settings.write", { expiry: null });
  const discover = await check(await h.send("GET", `${SCOPE}/capabilities`), 200);
  assert.deepEqual(discover.capabilities, ["site.settings.read", "site.settings.write"]);
  await check(await save({ settings, expectedVersion: "b.1", delegatedBySubject: "fixture-second-owner" }), 400, "invalid_request");
  await check(await save({ settings: {}, expectedVersion: "b.1" }), 400, "invalid_request");
  assert.deepEqual(await check(await save({ settings, expectedVersion: "b.1" }), 200), { status: "saved", version: "b.2" });
  await check(await save({ settings, expectedVersion: "b.1" }), 409, "conflict");
  assert.deepEqual(await check(await read(), 200), { settings, version: "b.2" });

  // Revoke the delegator after the CLI audit reservation and before the settings batch.
  h.beforeNextBatch(() => h.db.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND access_subject = ?").run(PROJECT, OWNER));
  await check(await save({ settings: initial.settings, expectedVersion: "b.2" }), 403, "forbidden");
  assert.deepEqual(await check(await read(), 200), { settings, version: "b.2" });
  await check(await save({ settings, expectedVersion: "b.2" }), 403, "forbidden");
  assert.equal(h.calls.length, 0);
});

testWithD1("CLI membership management reuses owner guards and records the machine as the actor", async (t) => {
  const h = await fixture(t);
  h.grant("site.members.read");
  const members = () => h.request("GET", "site.members.read");
  const mutate = (operation, body) => h.request("POST", operation, body);
  const invitation = { email: "invitee@example.test", role: "editor", expiresInDays: 3 };
  await check(await mutate("site.invitations.create", invitation), 403, "forbidden");
  const first = await check(await members(), 200);
  assert.ok(first.members.some(({ subject, role }) => subject === OWNER && role === "owner"));
  assert.ok(first.members.every(({ isCurrent }) => !isCurrent));

  h.grant("site.members.manage", { expiry: null });
  await check(await mutate("site.members.role", { subject: CLI_SUBJECT, role: "owner" }), 400, "invalid_request");
  await check(await mutate("site.invitations.create", { ...invitation, email: CLI_EMAIL }), 400, "invalid_request");
  await check(await mutate("site.invitations.accept", { token: "unused" }), 404, "not_found");
  await check(await mutate("site.grants.create", {}), 404, "not_found");
  const created = await check(await mutate("site.invitations.create", invitation), 201);
  assert.equal(new URL(created.invitationUrl).origin, ORIGIN);
  assert.equal(created.invitation.email, invitation.email);
  await check(await mutate("site.invitations.create", invitation), 409, "operation_rejected");
  const inviteId = created.invitation.id;
  await check(await mutate("site.invitations.revoke", { invitationId: inviteId }), 200);
  await check(await mutate("site.invitations.revoke", { invitationId: inviteId }), 409, "operation_rejected");
  const inviteRow = h.db.prepare("SELECT invited_by_subject, revoked_by_subject FROM project_invitations WHERE id = ?").get(inviteId);
  assert.deepEqual({ ...inviteRow }, { invited_by_subject: CLI_SUBJECT, revoked_by_subject: CLI_SUBJECT });
  const listing = await check(await members(), 200);
  assert.equal(listing.invitations.find(({ id }) => id === inviteId).status, "revoked");
  assert.ok(!JSON.stringify(listing).includes(new URL(created.invitationUrl).searchParams.get("token")));

  await check(await mutate("site.members.role", { subject: HUMAN, role: "owner" }), 200);
  await check(await mutate("site.members.role", { subject: HUMAN, role: "editor" }), 200);
  await check(await mutate("site.members.remove", { subject: "fixture-second-owner" }), 200);
  await check(await mutate("site.members.role", { subject: OWNER, role: "editor" }), 409, "final_owner_required");
  await check(await mutate("site.members.remove", { subject: OWNER }), 409, "final_owner_required");
  const membershipAudit = h.db.prepare("SELECT actor_subject, action, target FROM studio_audit_records ORDER BY id").all();
  assert.deepEqual(membershipAudit.map(({ actor_subject, action, target }) => [actor_subject, action, target]), [
    [CLI_SUBJECT, "invitation.created.editor", invitation.email],
    [CLI_SUBJECT, "invitation.revoked", inviteId],
    [CLI_SUBJECT, "member.promoted", HUMAN],
    [CLI_SUBJECT, "member.demoted", HUMAN],
    [CLI_SUBJECT, "member.removed", "fixture-second-owner"]
  ]);
  const cliAudit = h.audit();
  assert.ok(cliAudit.every(({ actor_subject, delegated_by_subject }) => actor_subject === CLI_SUBJECT && delegated_by_subject === OWNER));
  assert.ok(!JSON.stringify(cliAudit).includes(created.invitationUrl));
  assert.equal(h.calls.length, 0);
});

testWithD1("human membership operations keep Access, the CSRF boundary and invitation acceptance", async (t) => {
  const h = await fixture(t);
  const browser = `/api/projects/${PROJECT}/sites/${SITE}`;
  const ownerToken = h.jwt({ sub: OWNER, common_name: undefined, email: "owner@example.test" });
  const owner = { token: ownerToken };
  const sameOrigin = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
  const listing = await check(await h.send("GET", `${browser}/membership`, undefined, owner), 200);
  assert.deepEqual(listing.members.filter(({ isCurrent }) => isCurrent).map(({ subject }) => subject), [OWNER]);
  await check(await h.send("GET", `${browser}/membership`, undefined, { token: h.humanToken }), 403, "forbidden");
  const body = { email: "new-member@example.test", role: "editor", expiresInDays: 1 };
  await check(await h.send("POST", `${browser}/invitations`, body, owner), 400, "invalid_request");
  const invite = await check(await h.send("POST", `${browser}/invitations`, body, { ...owner, headers: sameOrigin }), 201);
  const token = new URL(invite.invitationUrl).searchParams.get("token");
  await check(await h.send("POST", `${browser}/invitations/accept`, { token }, { headers: sameOrigin }), 401, "session_expired");
  const invitee = h.jwt({ sub: "new-human", common_name: undefined, email: body.email });
  await check(await h.send("POST", `${browser}/invitations/accept`, { token }, { token: invitee, headers: sameOrigin }), 200);
  assert.deepEqual(h.db.prepare("SELECT actor_subject FROM studio_audit_records ORDER BY id").all().map((row) => row.actor_subject), [OWNER, "new-human"]);
  assert.equal(h.audit().length, 0);
});

testWithD1("site administration migration preserves finite grants and audits with owner and foreign-key safeguards", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const migrationIndex = migrationNames.findIndex((name) => name.startsWith("0009_"));
  for (const migration of migrations.slice(0, migrationIndex)) db.exec(migration);
  const add = db.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name) VALUES (?, ?, ?, ?)");
  add.run(PROJECT, OWNER, "owner", "Owner");
  add.run(PROJECT, "second-owner", "owner", "Second owner");
  add.run(PROJECT, HUMAN, "editor", "Editor");
  const insert = () => db.prepare(`INSERT INTO studio_cli_grants
    (client_id, project_id, site_id, capability, delegated_by_subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert().run(CLIENT, PROJECT, SITE, "pages.read", OWNER, 100, 200);
  db.prepare(`INSERT INTO studio_cli_audit
    (id, actor_subject, delegated_by_subject, project_id, site_id, capability, operation, target_json, http_status, request_key)
    VALUES ('legacy-audit', ?, ?, ?, ?, 'pages.read', 'pages.read', '{}', 200, ?)`).run(CLI_SUBJECT, OWNER, PROJECT, SITE, REQUEST_KEY);

  db.exec(migrations[migrationIndex]);
  const row = db.prepare("SELECT * FROM studio_cli_grants").get();
  assert.deepEqual({ ...row }, { client_id: CLIENT, project_id: PROJECT, site_id: SITE, capability: "pages.read", delegated_by_subject: OWNER, created_at: 100, expires_at: 200 });
  const audit = db.prepare("SELECT id, http_status, request_key FROM studio_cli_audit").get();
  assert.deepEqual({ ...audit }, { id: "legacy-audit", http_status: 200, request_key: REQUEST_KEY });
  insert().run(CLIENT, PROJECT, SITE, "site.members.manage", OWNER, 100, null);
  assert.throws(() => insert().run(CLIENT, PROJECT, SITE, "site.settings.read", HUMAN, 100, null), /require a project owner/u);
  assert.throws(() => insert().run(CLIENT, PROJECT, "experience", "site.settings.read", OWNER, 100, null), /FOREIGN KEY/u);
  assert.throws(() => db.prepare("UPDATE studio_cli_grants SET expires_at = NULL WHERE capability = 'pages.read'").run(), /replace a CLI grant/u);
  db.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND access_subject = ?").run(PROJECT, OWNER);
  assert.equal(db.prepare("SELECT count(*) AS total FROM studio_cli_grants").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) AS total FROM studio_cli_audit").get().total, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

testWithD1("CLI upload intents are bound to the configured preview origin while browser uploads retain the production origin", async (t) => {
  const previewOrigin = "https://site-preview.example";
  const productionOrigin = "https://next-kamakura.niho.life";
  const h = await fixture(t, { previewOrigin });
  const uploadId = "a0000000-0000-4000-a000-000000000003";
  const image = { name: "fixture.png", mimeType: "image/png", bytes: 123 };
  const browserScope = `/api/projects/${PROJECT}/sites/${SITE}`;
  const browser = { token: h.humanToken, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } };
  const routes = [
    { operation: "cms.upload-intent", capability: "cms.edit", route: "/cms/uploads/intent", uploadPath: "cms-upload", idKey: "uploadId", body: { ...image, collectionId: "posts" } },
    { operation: "translations.upload-intent", capability: "translations.edit", route: "/localization/uploads/intent", uploadPath: "localization-upload", idKey: "uploadId", body: { ...image, itemKey: "fixture-item", unitId: "image" } },
    { operation: "assets.upload-intent", capability: "assets.edit", route: "/editor/assets/upload-intent", uploadPath: "asset-upload", idKey: "assetId", body: { ...image, siteId: SITE, folderId: null, provider: "kamakura-upload" } }
  ];
  for (const { operation, capability, route, uploadPath, idKey, body } of routes) {
    h.grant(capability);
    const intent = (origin) => ({ uploadUrl: `${origin}/internal/studio/${uploadPath}/${uploadId}`, uploadToken: "fixture-upload-token", [idKey]: uploadId });
    const reply = (origin) => h.replyWith(() => Response.json(intent(origin), { status: 201 }));
    reply(previewOrigin);
    assert.deepEqual(await check(await h.request("POST", operation, body, {
      headers: { "X-Preview-Origin": "https://untrusted.example" }
    }), 201), intent(previewOrigin));
    assert.equal(h.calls.at(-1).origin, previewOrigin);
    assert.equal(h.calls.at(-1).headers.get("X-Preview-Origin"), null);
    assert.equal(h.calls.at(-1).headers.get("X-NIHO-Studio-Subject"), CLI_SUBJECT);

    for (const origin of [productionOrigin, "https://untrusted.example"]) {
      reply(origin);
      const denied = await check(await h.request("POST", operation, body), 502, "upstream_contract_invalid");
      assert.deepEqual(Object.keys(denied).sort(), ["error", "supportId"]);
      assert.equal(h.calls.at(-1).origin, previewOrigin);
    }
    reply(previewOrigin);
    await check(await h.send("POST", browserScope + route, body, browser), 502, "upstream_contract_invalid");
    assert.equal(h.calls.at(-1).origin, productionOrigin);
    reply(productionOrigin);
    assert.deepEqual(await check(await h.send("POST", browserScope + route, body, browser), 201), intent(productionOrigin));
    assert.equal(h.calls.at(-1).origin, productionOrigin);
  }

  h.grant("translations.read");
  const frameUrl = `${previewOrigin}/_studio/localization-preview`;
  const { adapter } = createLocalizationMemory({ frameUrl });
  h.replyWith(async () => Response.json(await adapter.loadOverview(new AbortController().signal)));
  const overview = await check(await h.request("POST", "translations.overview", {}), 200);
  assert.equal(overview.overview.preview.frameUrl, frameUrl);
  assert.equal(h.calls.at(-1).origin, previewOrigin);
  await check(await h.send("POST", browserScope + "/localization/overview", {}, browser), 502, "upstream_contract_invalid");
  assert.equal(h.calls.at(-1).origin, productionOrigin);
});

testWithD1("invalid CLI preview origins fail closed before the Kamakura binding is called", async (t) => {
  for (const previewOrigin of ["https://site-preview.example/path", "https://next-kamakura.niho.life"]) {
    await t.test(previewOrigin, async (t) => {
      const h = await fixture(t, { previewOrigin });
      h.grant("cms.edit");
      await check(await h.request("POST", "cms.upload-intent", { name: "a.png", mimeType: "image/png", bytes: 100, collectionId: "posts" }), 503, "service_unavailable");
      assert.equal(h.calls.length, 0);
    });
  }
});

testWithD1("all advertised CLI capabilities fit the migration and have unique operation IDs", async (t) => {
  const h = await fixture(t);
  const ids = OPERATIONS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const capability of new Set(OPERATIONS.map((spec) => spec.capability))) h.grant(capability);
  const discovery = await check(await h.send("GET", `${SCOPE}/capabilities`), 200);
  assert.deepEqual(discovery.operations.map(({ id }) => id), ids);
  assert.deepEqual(discovery.operations.filter(({ upload }) => upload).map(({ id, upload }) => [id, upload]), [
    ["cms.upload-intent", "cms"], ["assets.upload-intent", "asset"], ["translations.upload-intent", "localization"]
  ]);
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

test("CLI sends an explicit operation key and can look up the receipt after a transport failure", async () => {
  const attempt = await cli(["request", "pages.read", "fixture-page", "--operation-id", REQUEST_KEY.toUpperCase()], {
    fetchImpl: `async (url, init) => {
      if (url !== "${ORIGIN}${SCOPE}/operations/pages.read/fixture-page" || init.method !== "GET" ||
        init.headers["${OPERATION_KEY_HEADER}"] !== "${REQUEST_KEY}") return Response.json({ error: "bad request" }, { status: 400 });
      throw new Error("lost response");
    }`
  });
  assert.equal(attempt.exitCode, 1);
  assert.deepEqual(JSON.parse(attempt.stdout), { apiVersion: "v1", httpStatus: null, operationId: null, result: { error: "transport_error" } });
  const receipt = { status: "completed", operationId: "00000000-0000-4000-8000-000000000001", operation: "pages.read", startedAt: "2026-11-11T00:00:00.000Z", httpStatus: 200 };
  const status = await cli(["status", REQUEST_KEY.toUpperCase()], {
    fetchImpl: `async (url, init) => {
      if (url !== "${ORIGIN}${SCOPE}/operation-status/${REQUEST_KEY}" || init.method !== "GET" || init.body !== undefined ||
        init.headers["CF-Access-Client-Id"] !== "${CLIENT}" || Object.hasOwn(init.headers, "${OPERATION_KEY_HEADER}")) throw new Error("bad status request");
      return Response.json(${JSON.stringify(receipt)});
    }`
  });
  assert.equal(status.exitCode, 0);
  assert.deepEqual(JSON.parse(status.stdout), { apiVersion: "v1", httpStatus: 200, operationId: null, result: receipt });
  for (const [args, error] of [
    [["status", "wrong-id"], "invalid_operation_id"],
    [["request", "pages.read", "fixture-page", "--operation-id", "wrong-id"], "invalid_operation_id"],
    [["discover", "--operation-id", REQUEST_KEY], "invalid_arguments"]
  ]) {
    const rejected = await cli(args);
    assert.equal(rejected.exitCode, 2);
    assert.equal(JSON.parse(rejected.stdout).result.error, error);
  }
});

test("CLI uploads a file with only the one-use token and rejects a different upload origin", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studio-cli-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "cover.png");
  await writeFile(path, Buffer.from([1, 2, 3]));
  const args = ["upload", "cms.upload-intent", "--file", path, "--upload-origin", "https://media.example", "--json", "-", "--operation-id", REQUEST_KEY];
  const input = '{"collectionId":"posts","mimeType":"image/png"}';
  const id = "00000000-0000-4000-8000-000000000001";
  const destination = `https://media.example/internal/studio/cms-upload/${id}`;
  const result = await cli(args, {
    input,
    fetchImpl: `async (url, init) => {
      if (url === "${ORIGIN}${SCOPE}/operations/cms.upload-intent") {
        if (init.method !== "POST" || init.headers["CF-Access-Client-Secret"] !== "fixture-secret" ||
          init.headers["${OPERATION_KEY_HEADER}"] !== "${REQUEST_KEY}" || init.body !== '{"name":"cover.png","collectionId":"posts","mimeType":"image/png","bytes":3}') throw new Error("bad intent");
        return Response.json({ uploadUrl: "${destination}", uploadToken: "fixture-upload-token", uploadId: "${id}" }, {
          status: 201, headers: { "X-Studio-Operation-Id": "${id}" }
        });
      }
      if (url !== "${destination}" || init.method !== "PUT" || init.redirect !== "manual" || init.credentials !== "omit" ||
        Object.keys(init.headers).sort().join(",") !== "Authorization,Content-Type,Origin" ||
        init.headers.Authorization !== "Bearer fixture-upload-token" || init.headers.Origin !== "${ORIGIN}" ||
        init.headers["Content-Type"] !== "image/png" || String(new Uint8Array(await init.body.arrayBuffer())) !== "1,2,3") throw new Error("bad transfer");
      return Response.json({ url: "https://media.example/cover.png" }, { status: 201 });
    }`
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 201, operationId: id, result: { url: "https://media.example/cover.png" } });
  const rejected = await cli(args, {
    input,
    fetchImpl: `async (url) => {
      if (url !== "${ORIGIN}${SCOPE}/operations/cms.upload-intent") throw new Error("unexpected upload");
      return Response.json({ uploadUrl: "${destination.replace("media.example", "outside.example")}", uploadToken: "fixture-upload-token", uploadId: "${id}" }, { status: 201 });
    }`
  });
  assert.equal(rejected.exitCode, 1);
  assert.deepEqual(JSON.parse(rejected.stdout).result, { error: "invalid_upload_intent" });

  const duplicate = await cli(args, {
    input,
    fetchImpl: `async (url) => {
      if (url !== "${ORIGIN}${SCOPE}/operations/cms.upload-intent") throw new Error("unexpected upload");
      return Response.json({ error: "duplicate_operation" }, { status: 409 });
    }`
  });
  assert.equal(duplicate.exitCode, 1);
  assert.deepEqual(JSON.parse(duplicate.stdout), { apiVersion: "v1", httpStatus: 409, operationId: null, result: { error: "duplicate_operation" } });
});
