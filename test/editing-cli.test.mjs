import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { EDITING_OPERATIONS } from "@niho/web/editing-api";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const command = fileURLToPath(new URL("../cli/niho-edit.mjs", import.meta.url));
const origin = "https://site.example", siteId = fixture.siteId, pageId = fixture.pageId, locale = fixture.locale;

function run(args, { status = 200, result, expectedMethod, expectedUrl, expectedBody, stdin, assertInputBeforeTimeout = false } = {}) {
  const timeoutGuard = assertInputBeforeTimeout ? `let stdinEnded = false;
    process.stdin.once("end", () => { stdinEnded = true; });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms) => { if (!stdinEnded) throw new Error("timeout started before stdin completed"); return originalTimeout(ms); };
  ` : "";
  const source = `${timeoutGuard}globalThis.fetch = async (url, init) => {
    if (String(url) !== ${JSON.stringify(expectedUrl)}) throw new Error("unexpected URL");
    if (init.method !== ${JSON.stringify(expectedMethod)}) throw new Error("unexpected method");
    if (new Headers(init.headers).get("Authorization") !== "Bearer fixture-token") throw new Error("missing authorization");
    const body = init.body ? JSON.parse(init.body) : null;
    if (JSON.stringify(body) !== ${JSON.stringify(JSON.stringify(expectedBody ?? null))}) throw new Error("unexpected body");
    return new Response(${JSON.stringify(JSON.stringify(result))}, { status: ${status}, headers: { "Content-Type": "application/json" } });
  };`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, command, "--origin", origin, "--site", siteId, ...args], {
      env: { ...process.env, NIHO_EDIT_TOKEN: "fixture-token" }, stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(stdin ?? "");
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runUpload(args, { uploadUrl, expectedBytes, asset, trustedUploadOrigin = origin }) {
  const source = `let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (calls === 1) {
        if (String(url) !== ${JSON.stringify(`${origin}/api/edit/v1/sites/${siteId}/operations/assets.upload-intent`)} || init.method !== "POST") throw new Error("unexpected intent request");
        if (new Headers(init.headers).get("Authorization") !== "Bearer fixture-token") throw new Error("missing editing token");
        const body = JSON.parse(init.body);
        if (JSON.stringify(body) !== ${JSON.stringify(JSON.stringify({ name: "sea.png", mimeType: "image/png", bytes: expectedBytes.length, folderId: null, provider: "kamakura-upload" }))}) throw new Error("invalid upload metadata");
        return new Response(JSON.stringify({ uploadUrl: ${JSON.stringify(uploadUrl)}, uploadToken: "short-lived", assetId: ${JSON.stringify(asset.id)} }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (calls !== 2 || String(url) !== ${JSON.stringify(uploadUrl)} || init.method !== "PUT" || init.credentials !== "omit" || init.redirect !== "error") throw new Error("unexpected upload PUT");
      if (new Headers(init.headers).get("Authorization") !== "Bearer short-lived" || new Headers(init.headers).get("Content-Type") !== "image/png") throw new Error("unsafe upload headers");
      if (!Buffer.from(init.body).equals(Buffer.from(${JSON.stringify(Buffer.from(expectedBytes).toString("base64"))}, "base64"))) throw new Error("upload bytes differ");
      return new Response(JSON.stringify({ asset: ${JSON.stringify(asset)} }), { status: 201, headers: { "Content-Type": "application/json" } });
    };
    process.on("beforeExit", () => { if (calls !== ${new URL(uploadUrl).origin === origin || new URL(uploadUrl).origin === trustedUploadOrigin ? 2 : 1}) throw new Error("unexpected upload request count"); });`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, command, "--origin", origin, "--site", siteId, ...args], {
      env: { ...process.env, NIHO_EDIT_TOKEN: "fixture-token", NIHO_EDIT_UPLOAD_ORIGIN: trustedUploadOrigin }, stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end("");
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("niho-edit reads a page over the host API without Studio or a browser", async () => {
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${path}`, result: { document: fixture, version: "v1" }
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { document: fixture, version: "v1" });
  assert.deepEqual(EDITING_OPERATIONS.map(({ id }) => id), ["pages.read", "pages.save", "pages.release-plan", "pages.release", "pages.catalog", "pages.change-prepare", "pages.change-apply",
    "cms.schema", "cms.list", "cms.read", "cms.create", "cms.save", "cms.publish-plan", "cms.publish", "cms.operation-status", "site.breakpoints.read", "site.breakpoints.save",
    "assets.list", "assets.usages", "assets.resolve", "assets.update", "assets.upload-intent", "assets.delete", "assets.restore"]);
});

test("niho-edit lists and updates stable assets through the shared host API", async (t) => {
  const listed = await run(["assets-list", "--search", "sea", "--kind", "image", "--provider", "uploads", "--limit", "1", "--recent"], {
    expectedMethod: "GET", expectedUrl: `${origin}/api/edit/v1/sites/${siteId}/operations/assets.list?search=sea&kind=image&limit=1&provider=uploads&recent=true`, result: { assets: [], folders: [] }
  });
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), { assets: [], folders: [] });

  const directory = await mkdtemp(join(tmpdir(), "niho-edit-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "asset.json");
  await writeFile(snapshotPath, JSON.stringify({ version: "etag-v1", changes: { alt: "海辺" } }));
  const updatePath = `/api/edit/v1/sites/${siteId}/operations/assets.update/uploads/sea`;
  const asset = { provider: "uploads", id: "sea", siteId, kind: "image", status: "ready", name: "sea.webp", mimeType: "image/webp", bytes: 12, alt: "海辺", version: "etag-v2", updatedAt: "2026-11-20T00:00:00Z" };
  const updated = await run(["assets-update", "uploads", "sea", "--json", snapshotPath], {
    expectedMethod: "PUT", expectedUrl: `${origin}${updatePath}`, expectedBody: { expectedVersion: "etag-v1", changes: { alt: "海辺" } }, result: { status: "saved", asset }
  });
  assert.equal(updated.exitCode, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), { apiVersion: "v1", httpStatus: 200, operation: "assets.update", result: { status: "saved", asset } });
});

test("niho-edit uploads bytes with a same-origin one-time asset token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-asset-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sea.png"), bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(file, bytes);
  const asset = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000", siteId, kind: "image", status: "ready", name: "sea.png", mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, alt: "", version: "etag-v1", updatedAt: "2026-11-20T00:00:00Z" };
  const uploadUrl = `${origin}/internal/studio/asset-upload/${asset.id}`;
  const result = await runUpload(["assets-upload", file, "--mime-type", "image/png", "--provider", asset.provider], { uploadUrl, expectedBytes: bytes, asset });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 201, operation: "assets.upload", result: { status: "uploaded", asset } });
});

test("niho-edit uploads to a configured host upload origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-asset-upload-trusted-origin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sea.png"), bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(file, bytes);
  const asset = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000", siteId, kind: "image", status: "ready", name: "sea.png", mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, alt: "", version: "etag-v1", updatedAt: "2026-11-20T00:00:00Z" };
  const trustedUploadOrigin = "https://next-site.example";
  const uploadUrl = `${trustedUploadOrigin}/internal/studio/asset-upload/${asset.id}`;
  const result = await runUpload(["assets-upload", file, "--mime-type", "image/png", "--provider", asset.provider, "--upload-origin", trustedUploadOrigin], { uploadUrl, expectedBytes: bytes, asset, trustedUploadOrigin });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result, { status: "uploaded", asset });
});

test("niho-edit refuses to send an upload token to an unconfigured different origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-asset-upload-origin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sea.png");
  await writeFile(file, Buffer.from([1, 2, 3]));
  const asset = { provider: "kamakura-upload", id: "123e4567-e89b-42d3-a456-426614174000", siteId, kind: "image", status: "ready", name: "sea.png", mimeType: "image/png", bytes: 3, alt: "", version: "etag-v1", updatedAt: "2026-11-20T00:00:00Z" };
  const result = await runUpload(["assets-upload", file, "--mime-type", "image/png", "--provider", asset.provider], { uploadUrl: "https://evil.example/upload", expectedBytes: Buffer.from([1, 2, 3]), asset });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout).result, { error: "invalid_upload_intent" });
});

test("niho-edit lists pages directly from the host API", async () => {
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.catalog`;
  const catalog = { version: "registry-v1", pages: [{ siteId, pageId, locale: "ja", title: "Home", path: "/", kind: "page", visibility: "public", published: true }] };
  const result = await run(["pages-catalog"], { expectedMethod: "GET", expectedUrl: `${origin}${path}`, result: catalog });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), catalog);
});

test("niho-edit applies a reviewed page-management plan directly to the host API", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-page-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const change = { action: "create", siteId, locale: "ja", title: "New page", path: "/new-page" };
  const plan = { expectedVersion: "registry-v1", operationId, change, confirmationToken: "page-change-token", domain: origin,
    impact: { linkedFrom: Array.from({ length: 250 }, (_, index) => ({ pageId: `link-${index}`, locale: "ja", title: `参照元ページ ${index} ${"説明文".repeat(12)}`, count: 1 })), navigation: [], notes: ["新しいページを作成します"] } };
  const planPath = join(directory, "plan.json");
  const serializedPlan = JSON.stringify(plan);
  assert.ok(Buffer.byteLength(serializedPlan) > 16 * 1024, "valid plans with many linked pages can exceed the change input limit");
  await writeFile(planPath, serializedPlan);
  const apiPath = `/api/edit/v1/sites/${siteId}/operations/pages.change-apply`;
  const page = { siteId, pageId: "new-page", locale: "ja", title: change.title, path: change.path, kind: "page", visibility: "public", published: false };
  const result = await run(["page-change-apply", "--json", planPath], {
    expectedMethod: "POST", expectedUrl: `${origin}${apiPath}`,
    expectedBody: { expectedVersion: plan.expectedVersion, operationId, confirmationToken: plan.confirmationToken, change },
    result: { status: "applied", operationId, page }
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { apiVersion: "v1", httpStatus: 200, operation: "pages.change-apply", result: { status: "applied", page, operationId } });
});

test("niho-edit reads and CAS-saves site breakpoints over the host API", async (t) => {
  const settings = { base: { name: "Mobile", previewWidth: 480 }, breakpoints: [{ name: "Tablet", minWidth: 691, previewWidth: 840 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }] };
  const readPath = `/api/edit/v1/sites/${siteId}/operations/site.breakpoints.read`;
  const read = await run(["breakpoints-read"], { expectedMethod: "GET", expectedUrl: `${origin}${readPath}`, result: { settings, version: "b.1" } });
  assert.equal(read.exitCode, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { settings, version: "b.1" });

  const directory = await mkdtemp(join(tmpdir(), "niho-edit-breakpoints-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "settings.json");
  await writeFile(snapshotPath, JSON.stringify({ settings, version: "b.1" }));
  const savePath = `/api/edit/v1/sites/${siteId}/operations/site.breakpoints.save`;
  const next = structuredClone(settings); next.breakpoints[0].previewWidth = 800;
  await writeFile(snapshotPath, JSON.stringify({ settings: next, version: "b.1" }));
  const saved = await run(["breakpoints-save", "--json", snapshotPath], {
    expectedMethod: "PUT", expectedUrl: `${origin}${savePath}`, expectedBody: { expectedVersion: "b.1", settings: next },
    result: { status: "saved", version: "b.2" }
  });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { apiVersion: "v1", httpStatus: 200, operation: "site.breakpoints.save", result: { status: "saved", version: "b.2" } });

  const conflict = await run(["breakpoints-save", "--json", snapshotPath], {
    status: 409, expectedMethod: "PUT", expectedUrl: `${origin}${savePath}`, expectedBody: { expectedVersion: "b.1", settings: next },
    result: { error: "version_conflict" }
  });
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(JSON.parse(conflict.stdout), { apiVersion: "v1", httpStatus: 409, operation: "site.breakpoints.save", result: { error: "version_conflict" } });
});

test("niho-edit preserves host-specific component blocks on read and save", async (t) => {
  const custom = structuredClone(fixture);
  custom.body.push({ type: "component", id: "booking-panel", block: "booking-panel", props: { title: "Book a visit" } });
  const readPath = `/api/edit/v1/sites/${siteId}/operations/pages.read/${pageId}?locale=${encodeURIComponent(locale)}`;
  const read = await run(["read", pageId, "--locale", locale], {
    expectedMethod: "GET", expectedUrl: `${origin}${readPath}`, result: { document: custom, version: "v1" }
  });
  assert.equal(read.exitCode, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).document, custom);

  const directory = await mkdtemp(join(tmpdir(), "niho-edit-custom-block-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({ document: custom, version: "v1" }));
  const savePath = `/api/edit/v1/sites/${siteId}/operations/pages.save/${pageId}?locale=${encodeURIComponent(locale)}`;
  const savedDocument = { ...custom, revision: custom.revision + 1 };
  const saved = await run(["save", pageId, "--locale", locale, "--json", snapshotPath], {
    expectedMethod: "PUT", expectedUrl: `${origin}${savePath}`, expectedBody: { expectedVersion: "v1", document: custom },
    result: { status: "saved", version: "v2", document: savedDocument }
  });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { document: savedDocument, version: "v2" });
});

test("niho-edit saves the edited document with the snapshot version and reports conflicts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const changed = structuredClone(fixture); changed.title = "Edited by CLI";
  changed.body[0].style.base.backgroundColor = "#e8f0e8";
  changed.body[0].children.push({ type: "element", id: "contact-form", tag: "form", attrs: { name: "contact" }, children: [
    { type: "element", id: "contact-name-label", tag: "label", attrs: { htmlFor: "contact-name" }, children: [{ type: "text", text: "Name" }] },
    { type: "element", id: "contact-name", tag: "input", attrs: { type: "text", name: "name", id: "contact-name", required: true }, children: [] }
  ] });
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({ document: changed, version: "v1" }));
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.save/${pageId}?locale=${encodeURIComponent(locale)}`;
  const args = ["save", pageId, "--locale", locale, "--json", snapshotPath];
  const body = { expectedVersion: "v1", document: changed };
  const savedDocument = { ...changed, revision: changed.revision + 1 };
  const saved = await run(args, { expectedMethod: "PUT", expectedUrl: `${origin}${path}`, expectedBody: body, result: { status: "saved", version: "v2", document: savedDocument } });
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { document: savedDocument, version: "v2" });

  const conflict = await run(args, { status: 409, expectedMethod: "PUT", expectedUrl: `${origin}${path}`, expectedBody: body, result: { error: "version_conflict" } });
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(JSON.parse(conflict.stdout).result, { error: "version_conflict" });
  assert.equal(JSON.parse(conflict.stdout).httpStatus, 409);
});

test("niho-edit starts the save timeout after reading a stdin snapshot", async () => {
  const document = structuredClone(fixture);
  const path = `/api/edit/v1/sites/${siteId}/operations/pages.save/${pageId}?locale=${encodeURIComponent(locale)}`;
  const savedDocument = { ...document, revision: document.revision + 1 };
  const result = await run(["save", pageId, "--locale", locale, "--json", "-"], {
    expectedMethod: "PUT", expectedUrl: `${origin}${path}`, expectedBody: { expectedVersion: "v1", document },
    result: { status: "saved", version: "v2", document: savedDocument }, stdin: JSON.stringify({ document, version: "v1" }),
    assertInputBeforeTimeout: true
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { document: savedDocument, version: "v2" });
});

test("niho-edit reviews a release plan and retries publication with the same operation ID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "niho-edit-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { siteId, pageId, locale };
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({ document: fixture, version: "v2", componentsVersion: "components-v1", presentationVersion: "presentation-v1" }));
  const plan = { target, expectedVersion: "v2", action: "publish", componentsVersion: "components-v1", presentationVersion: "presentation-v1", confirmationToken: "one-use-token", domain: "https://site.example", changes: [] };
  const preparePath = `/api/edit/v1/sites/${siteId}/operations/pages.release-plan/${pageId}?locale=${encodeURIComponent(locale)}`;
  const prepared = await run(["release-plan", pageId, "--locale", locale, "--action", "publish", "--json", snapshotPath], {
    expectedMethod: "POST", expectedUrl: `${origin}${preparePath}`, expectedBody: { expectedVersion: "v2", action: "publish", componentsVersion: "components-v1", presentationVersion: "presentation-v1" }, result: { plan }
  });
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), plan);

  const planPath = join(directory, "release-plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const applyPath = `/api/edit/v1/sites/${siteId}/operations/pages.release/${pageId}?locale=${encodeURIComponent(locale)}`;
  const result = { status: "released", operationId, version: "v3", document: fixture };
  const args = ["release", pageId, "--locale", locale, "--json", planPath, "--operation-id", operationId];
  const applied = await run(args, { expectedMethod: "POST", expectedUrl: `${origin}${applyPath}`, expectedBody: { expectedVersion: "v2", confirmationToken: plan.confirmationToken, operationId }, result });
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).result, result);
  const retried = await run(args, { expectedMethod: "POST", expectedUrl: `${origin}${applyPath}`, expectedBody: { expectedVersion: "v2", confirmationToken: plan.confirmationToken, operationId }, result });
  assert.equal(retried.exitCode, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout).result, result);
});
