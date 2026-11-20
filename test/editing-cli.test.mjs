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

function run(args, { status = 200, result, expectedMethod, expectedUrl, expectedBody } = {}) {
  const source = `globalThis.fetch = async (url, init) => {
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
      env: { ...process.env, NIHO_EDIT_TOKEN: "fixture-token" }
    });
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
  assert.deepEqual(EDITING_OPERATIONS.map(({ id }) => id), ["pages.read", "pages.save"]);
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
