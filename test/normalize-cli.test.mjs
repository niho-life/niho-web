import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = fileURLToPath(new URL("../cli/niho-edit.mjs", import.meta.url));
const origin = "https://normalize.example", siteId = "sample";
const styles = { tokens: { brand: { type: "color", value: "#123" } } };
const breakpoints = { version: "breakpoints-1", settings: { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [
  { name: "Tablet", minWidth: 768, previewWidth: 800 },
  { name: "Small", minWidth: 1000, previewWidth: 1024 },
  { name: "PC", minWidth: 1280, previewWidth: 1360 }
] } };
function fixture(pageId, responsive = true) {
  return { document: { schemaVersion: 1, siteId, pageId, locale: "ja", revision: 1, title: pageId, tokens: {},
    body: [{ type: "element", id: "a", tag: "p", style: { base: { color: "#123", opacity: 0.8 },
      ...(responsive ? { responsive: [{ minWidth: 768, declarations: { opacity: 0.8 } }] } : {}) }, children: [] },
    { type: "element", id: "b", tag: "p", style: { base: { color: "#123" } }, children: [] }]
  }, version: "page-1" };
}

function run(args, { stdin = "", mock = null } = {}) {
  const env = { ...process.env };
  for (const key of ["NIHO_EDIT_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) delete env[key];
  if (mock) env.NIHO_EDIT_TOKEN = "normalize-fixture-secret";
  const network = mock ? ["--import", pathToFileURL(mock).href] : ["--import", "data:text/javascript,globalThis.fetch=()=>{throw Error('offline')}"];
  const scope = mock ? ["--origin", origin, "--site", siteId] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...network, cli, ...scope, "normalize", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(stdin);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      try { resolve({ code, output: JSON.parse(stdout) }); }
      catch (error) { reject(new Error(`invalid CLI output (${code}): ${stderr}\n${stdout}`, { cause: error })); }
    });
  });
}

async function sandbox(t, documents, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), "niho-normalize-cli-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const mock = join(directory, "mock.mjs"), statePath = join(directory, "server.json");
  const load = async () => JSON.parse(await readFile(statePath, "utf8"));
  const write = (data) => writeFile(statePath, JSON.stringify(data));
  await write({ documents: Object.fromEntries(documents.map((entry) => [entry.document.pageId, entry])), operations: {}, log: [], ...settings });
  await writeFile(mock, `
    import assert from "node:assert/strict";
    import {readFileSync, writeFileSync} from "node:fs";
    import { EDITING_OPERATIONS, SITE_STYLES_FEATURE, withSiteStylesFeature } from ${JSON.stringify(new URL("../dist/editing-api.js", import.meta.url).href)};
    import { editDocumentById } from ${JSON.stringify(new URL("../dist/editor-model.js", import.meta.url).href)};
    import { decodeNormalizationOperations } from ${JSON.stringify(new URL("../dist/normalize.js", import.meta.url).href)};
    const location = ${JSON.stringify(statePath)};
    const answer = (result, status = 200) => new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json" } });
    globalThis.fetch = async (url, init) => {
      const target = new URL(url), method = init.method, path = target.pathname.split("/");
      assert.equal(target.origin, ${JSON.stringify(origin)});
      assert.equal(path[5], ${JSON.stringify(siteId)});
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer normalize-fixture-secret");
      const operation = path.at(-2)?.includes("pages.") ? path.at(-2) : path.at(-1);
      const body = init.body && JSON.parse(init.body);
      const state = JSON.parse(readFileSync(location, "utf8"));
      const persist = () => writeFileSync(location, JSON.stringify(state));
      state.log.push({ method, operation, ...(body ? { body } : {}) });
      persist();
      const requestingStyles = target.searchParams.get("features") === SITE_STYLES_FEATURE;
      const featured = state.styles !== undefined && requestingStyles;
      if (operation === "capabilities") {
        if (requestingStyles && !featured) return answer({ error: "not_found" }, 404);
        const operations = EDITING_OPERATIONS.filter(({ id }) => featured ? ["pages.apply", "site.styles.read"].includes(id) : id === "pages.apply");
        return answer({ apiVersion: "v1", siteId: ${JSON.stringify(siteId)}, operations: featured ? operations.map(withSiteStylesFeature) : operations });
      }
      const styleVersion = state.styleVersion ?? "styles-1";
      if (operation === "site.styles.read") return answer({ sitePublicationEpoch: "epoch-1", draft: { version: styleVersion, styles: state.styles }, published: { stylesVersion: "public-1", styles: {} } });
      if (operation === "site.breakpoints.read") return answer(state.breakpoints);
      if (operation === "site.breakpoints.save") {
        if (body.expectedVersion !== state.breakpoints.version) return answer({ error: "version_conflict" }, 409);
        const version = state.breakpoints.version + "-next";
        state.breakpoints = { version, settings: body.settings };
        const loseResponse = state.loseResponse === "site.breakpoints.save";
        if (loseResponse) delete state.loseResponse;
        persist();
        if (loseResponse) throw new Error("transport stopped after breakpoint update");
        return answer({ status: "saved", version });
      }
      const snapshot = state.documents[path.at(-1)];
      assert.equal(target.searchParams.get("locale"), snapshot.document.locale);
      assert.equal(featured, Boolean(state.styles));
      if (operation === "pages.read") return answer({ ...snapshot, ...(featured ? { draftStylesVersion: styleVersion } : {}) });
      const version = snapshot.version + "-next", revision = snapshot.document.revision + 1;
      if (operation === "pages.save") {
        if (featured) assert.equal(body.draftStylesVersion, styleVersion);
        if (body.expectedVersion !== snapshot.version) return answer({ error: "version_conflict" }, 409);
        const document = { ...body.document, revision };
        state.documents[path.at(-1)] = { ...snapshot, version, document };
        persist();
        return answer({ status: "saved", version, document });
      }
      assert.equal(operation, "pages.apply");
      if (state.operations[body.operationId]) return answer(state.operations[body.operationId]);
      if (body.baseVersion !== snapshot.version || featured && body.draftStylesVersion !== styleVersion) return answer({ error: "version_conflict" }, 409);
      const edited = decodeNormalizationOperations(body.operations).reduce((page, change) => editDocumentById(page, change, {}, [], undefined, state.styles), snapshot.document);
      const document = { ...edited, revision };
      const result = { status: "applied", version, revision, document };
      state.documents[path.at(-1)] = { ...snapshot, version, document };
      state.operations[body.operationId] = result;
      const loseResponse = state.loseResponse === path.at(-1);
      if (loseResponse) delete state.loseResponse;
      persist();
      if (loseResponse) throw new Error("transport stopped after commit");
      return answer(result);
    };
  `);
  return { mock, directory, load, write, checkpoint: join(directory, "progress.json"), bundle: join(directory, "plan.json") };
}

async function planFor(path, input) {
  const { code, output } = await run(["plan", "--json", "-"], { stdin: JSON.stringify(input) });
  assert.equal(code, 0, JSON.stringify(output));
  await writeFile(path, JSON.stringify(output));
  return output;
}

test("normalize analyzes and plans offline, enforcing closed options and rejecting unapproved writes", async (t) => {
  const original = fixture("copy", false);
  const input = { documents: [original] };
  const analyzed = await run(["analyze", "--json", "-"], { stdin: JSON.stringify(input) });
  assert.equal(analyzed.code, 0);
  assert.equal(analyzed.output.colors[0].count, 2);
  const invalid = await run(["plan", "--json", "-", "--approve", "irrelevant"], { stdin: JSON.stringify(input) });
  assert.equal(invalid.output.result.error, "invalid_arguments");
  const server = await sandbox(t, [original]);
  const bundle = await planFor(server.bundle, input);
  assert.deepEqual(bundle.input, input);
  const flags = ["apply", "--json", server.bundle, "--checkpoint", server.checkpoint];
  const refused = await run(flags, server);
  assert.equal(refused.output.result.error, "normalization_nothing_selected");
  assert.equal((await server.load()).log.length, 0);
  const tampered = structuredClone(bundle);
  tampered.plan.proposals[0].classification = "lossless";
  await writeFile(server.bundle, JSON.stringify(tampered));
  const mismatch = await run(flags, server);
  assert.equal(mismatch.output.result.error, "normalization_plan_mismatch");
  assert.equal((await server.load()).log.length, 0);
  const piped = await run(["apply", "--json", "-", "--checkpoint", server.checkpoint], { mock: server.mock, stdin: JSON.stringify(bundle) });
  assert.equal(piped.output.result.error, "invalid_arguments");
});

test("normalize refuses an initial CAS conflict before sending any page batch", async (t) => {
  const original = fixture("copy");
  const server = await sandbox(t, [{ ...original, version: "concurrent-revision" }]);
  await planFor(server.bundle, { documents: [original] });
  const result = await run(["apply", "--json", server.bundle, "--checkpoint", server.checkpoint], server);
  assert.equal(result.output.result.error, "version_conflict");
  assert.deepEqual((await server.load()).log.map(({ operation }) => operation), ["capabilities", "capabilities", "pages.read"]);
  assert.equal(JSON.parse(await readFile(server.checkpoint, "utf8")).pages[0].state, "pending");
});

test("normalize requires the draft style version on hosts that expose site.styles", async (t) => {
  const original = fixture("copy");
  const server = await sandbox(t, [original], { styles: {} });
  await planFor(server.bundle, { documents: [original] });
  const result = await run(["apply", "--json", server.bundle, "--checkpoint", server.checkpoint], server);
  assert.equal(result.output.result.error, "normalization_draft_styles_required");
  assert.deepEqual((await server.load()).log.map(({ operation }) => operation), ["capabilities", "site.styles.read"]);
});

test("normalize resumes the fixed operation ID after a lost response and verifies saved revisions", async (t) => {
  const originals = [fixture("first"), fixture("second")];
  const server = await sandbox(t, originals, { styles, loseResponse: "first" });
  await planFor(server.bundle, { documents: originals, siteStyles: styles, siteStylesRevision: { stage: "draft", version: "styles-1" } });
  const apply = await run(["apply", "--json", server.bundle, "--checkpoint", server.checkpoint], server);
  assert.equal(apply.output.result.error, "transport_error");
  assert.equal((await stat(server.checkpoint)).mode & 0o777, 0o600);
  const checkpointText = await readFile(server.checkpoint, "utf8");
  assert.ok(!checkpointText.includes("normalize-fixture-secret"));
  const checkpoint = JSON.parse(checkpointText);
  assert.deepEqual(checkpoint.pages.map(({ state }) => state), ["sent", "pending"]);
  const resume = await run(["resume", "--json", server.checkpoint], server);
  assert.equal(resume.code, 0, JSON.stringify(resume.output));
  assert.deepEqual(resume.output.pages.map(({ state }) => state), ["applied", "applied"]);
  const state = await server.load();
  const requests = state.log.filter(({ operation }) => operation === "pages.apply");
  assert.deepEqual(requests.map(({ body }) => body.operationId), [
    checkpoint.pages[0].operationId, checkpoint.pages[0].operationId, checkpoint.pages[1].operationId
  ]);
  assert.ok(requests.every(({ body }) => body.draftStylesVersion === "styles-1" && body.baseVersion === "page-1"));
  assert.deepEqual(Object.values(state.documents).map(({ document }) => document.revision), [2, 2]);
  const verify = await run(["verify", "--json", server.checkpoint], server);
  assert.deepEqual(verify.output, { status: "equivalent", documentsChecked: 2 });

  const updated = await server.load();
  updated.documents.first.version = "intervening-edit";
  await server.write(updated);
  const undo = await run(["undo", "--json", server.checkpoint], server);
  assert.equal(undo.output.result.error, "version_conflict");
  const partial = JSON.parse(await readFile(server.checkpoint, "utf8"));
  assert.deepEqual(partial.pages.map(({ state }) => state), ["applied", "restored"]);
  assert.equal((await server.load()).log.filter(({ operation }) => operation === "pages.save").length, 1);
});

test("normalize composes explicit site setting approvals into one CAS write and undoes it", async (t) => {
  const original = fixture("copy", false);
  const server = await sandbox(t, [original], { breakpoints, loseResponse: "site.breakpoints.save" });
  const plan = await planFor(server.bundle, { documents: [original], breakpointSettings: breakpoints });
  const approved = plan.plan.proposals.filter(({ kind, siteSettingsChanges }) => kind === "remove-breakpoint" && siteSettingsChanges).map(({ id }) => id);
  assert.equal(approved.length, 2);
  const apply = await run(["apply", "--json", server.bundle, "--checkpoint", server.checkpoint, ...approved.flatMap((id) => ["--approve", id])], server);
  assert.equal(apply.output.result.error, "transport_error");
  const resume = await run(["resume", "--json", server.checkpoint], server);
  assert.equal(resume.code, 0, JSON.stringify(resume.output));
  assert.equal(resume.output.breakpoints.state, "applied");
  const state = await server.load();
  const updates = state.log.filter(({ operation }) => operation === "site.breakpoints.save");
  assert.deepEqual(updates, [{ method: "PUT", operation: "site.breakpoints.save", body: {
    expectedVersion: "breakpoints-1", settings: { ...breakpoints.settings, breakpoints: [breakpoints.settings.breakpoints.at(-1)] }
  } }]);
  assert.ok(!state.log.some(({ operation }) => operation === "pages.apply"));
  const undone = await run(["undo", "--json", server.checkpoint], server);
  assert.equal(undone.code, 0, JSON.stringify(undone.output));
  assert.equal(undone.output.breakpoints.state, "restored");
  assert.deepEqual((await server.load()).breakpoints.settings, breakpoints.settings);
});

test("normalize recovers a committed page even if draft styles advanced after the response was lost", async (t) => {
  const original = fixture("copy");
  const server = await sandbox(t, [original], { styles, loseResponse: "copy" });
  await planFor(server.bundle, { documents: [original], siteStyles: styles, siteStylesRevision: { stage: "draft", version: "styles-1" } });
  const apply = await run(["apply", "--json", server.bundle, "--checkpoint", server.checkpoint], server);
  assert.equal(apply.output.result.error, "transport_error");
  const state = await server.load();
  state.styleVersion = "styles-2";
  await server.write(state);
  const resume = await run(["resume", "--json", server.checkpoint], server);
  assert.equal(resume.code, 0, JSON.stringify(resume.output));
  assert.equal(resume.output.pages[0].state, "applied");
  const requests = (await server.load()).log.filter(({ operation }) => operation === "pages.apply");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, requests[1].body);
});

test("normalize undo reconciles a sent page before restoring it", async (t) => {
  const original = fixture("copy");
  const server = await sandbox(t, [original], { loseResponse: "copy" });
  await planFor(server.bundle, { documents: [original] });
  const apply = await run(["apply", "--json", server.bundle, "--checkpoint", server.checkpoint], server);
  assert.equal(apply.output.result.error, "transport_error");
  const undone = await run(["undo", "--json", server.checkpoint], server);
  assert.equal(undone.code, 0, JSON.stringify(undone.output));
  assert.equal(undone.output.pages[0].state, "restored");
  const serverState = await server.load();
  assert.deepEqual(serverState.documents.copy.document.body, original.document.body);
  assert.equal(serverState.log.filter(({ operation }) => operation === "pages.apply").length, 2);
});
