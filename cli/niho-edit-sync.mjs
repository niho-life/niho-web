import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isEditingApiVersion, parseEditingPageDocumentEnvelope } from "../dist/editing-client.js";
import { siteStylesEdits } from "../dist/editing-site-styles.js";
import { parseSiteStyles } from "../dist/site-styles.js";
import { parseSiteStylesWithFrame } from "../dist/site-frame.js";
import { parseManagedSiteSeoSettings } from "../dist/managed-seo-settings.js";
import { parseManagedSiteRedirects } from "../dist/managed-site-redirects.js";

/*
 * Studio stays the source of truth. pull writes a site to a directory, check validates it without the
 * server, and push saves only the files that changed, each one through its own version check.
 * Versions and operation IDs live in .niho/state.json; the files an AI edits never contain them.
 */

const STATE_PATH = ".niho/state.json";
const CONTEXT_PATH = ".niho/context.json";
const SEO_PATH = "site/seo.json";
const REDIRECTS_PATH = "site/redirects.json";
const PUBLIC_PATH = "site/public.json";
const STYLES_PATH = "site/styles.json";
/** 1 page, normalized JSON. Larger pages are hard for an AI to read as a whole. */
export const PAGE_WARNING_BYTES = 200 * 1024;
const MAX_LOCAL_FILE_BYTES = 8 * 1024 * 1024;
const READ_CONCURRENCY = 8;
const SYNC_DIRECTORIES = ["pages", "cms", "site"];
const CONFLICT_HINT = "pull し直してサーバーの内容を確かめてください。ローカルの変更を捨てるならそのファイルを消してから pull し直します。";
const HEX_HASH = /^[0-9a-f]{64}$/u;
const timeout = () => AbortSignal.timeout(30_000);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}
/** Keys sorted recursively, 2 space indent, trailing newline. Array order is kept. */
export function canonicalJson(value) { return `${JSON.stringify(sortValue(value), null, 2)}\n`; }
const hashOf = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const errorCode = (payload) => typeof payload?.error === "string" && /^[a-z0-9_]{1,64}$/u.test(payload.error) ? payload.error : "request_failed";

/* ---------- paths ---------- */

function fail(deps, code, status = null) { return new deps.CliError(code, status); }
function pageFile(deps, locale, pageId) {
  if (!deps.validators.LOCALE.test(locale ?? "") || !deps.validators.IDENTIFIER.test(pageId ?? "")) throw fail(deps, "sync_invalid_id");
  return `pages/${locale}/${pageId}.json`;
}
function cmsFile(deps, collectionId, itemId) {
  if (!deps.validators.cmsCollection(collectionId) || !deps.validators.cmsItem(itemId)) throw fail(deps, "sync_invalid_id");
  return `cms/${collectionId}/${itemId}.json`;
}
/** The identity a path claims, or null when the path is not part of the layout. */
function classifyPath(deps, path) {
  const page = /^pages\/([^/]+)\/([^/]+)\.json$/u.exec(path);
  if (page) return deps.validators.LOCALE.test(page[1]) && deps.validators.IDENTIFIER.test(page[2]) ? { kind: "page", locale: page[1], pageId: page[2] } : null;
  const cms = /^cms\/([^/]+)\/([^/]+)\.json$/u.exec(path);
  if (cms) return deps.validators.cmsCollection(cms[1]) && deps.validators.cmsItem(cms[2]) ? { kind: "cms", collectionId: cms[1], itemId: cms[2] } : null;
  const fixed = { [SEO_PATH]: "seo", [REDIRECTS_PATH]: "redirects", [PUBLIC_PATH]: "public", [STYLES_PATH]: "styles" }[path];
  return fixed ? { kind: fixed } : null;
}
function entryPath(deps, entry) {
  if (!isRecord(entry)) throw fail(deps, "sync_state_invalid");
  switch (entry.kind) {
    case "page": return pageFile(deps, entry.locale, entry.pageId);
    case "cms": return cmsFile(deps, entry.collectionId, entry.itemId);
    case "seo": return SEO_PATH;
    case "redirects": return REDIRECTS_PATH;
    case "public": return PUBLIC_PATH;
    case "styles": return STYLES_PATH;
    default: throw fail(deps, "sync_state_invalid");
  }
}
function insidePath(root, path) {
  const full = resolve(root, ...path.split("/"));
  if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error("sync_path_outside");
  return full;
}
/** Every existing component below the directory must be a plain file or folder, never a link out of it. */
async function assertPlainPath(deps, root, path) {
  const full = insidePath(root, path);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return full; throw error; }
    if (info.isSymbolicLink()) throw fail(deps, "sync_path_symlink");
  }
  return full;
}
async function writeText(deps, root, path, text) {
  const full = await assertPlainPath(deps, root, path);
  await mkdir(dirname(full), { recursive: true });
  const temporary = `${full}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, "utf8"); await rename(temporary, full); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}
async function readLocal(deps, root, path) {
  let full;
  try { full = await assertPlainPath(deps, root, path); }
  catch (error) { if (error instanceof deps.CliError) return { exists: true, problem: error.code }; throw error; }
  let info;
  try { info = await lstat(full); }
  catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { exists: false }; throw error; }
  if (!info.isFile()) return { exists: true, problem: "not_a_file" };
  if (info.size > MAX_LOCAL_FILE_BYTES) return { exists: true, problem: "file_too_large" };
  let value;
  try { value = JSON.parse(await readFile(full, "utf8")); }
  catch { return { exists: true, problem: "invalid_json" }; }
  const text = canonicalJson(value);
  return { exists: true, value, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}
async function walkJson(root, path, depth, found) {
  let entries;
  try { entries = await readdir(resolve(root, ...path.split("/")), { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) found.push(`${path}/${entry.name}`);
    else if (entry.isDirectory() && depth < 2) await walkJson(root, `${path}/${entry.name}`, depth + 1, found);
  }
}

/* ---------- state ---------- */

function freshState(deps) { return { formatVersion: 1, origin: deps.origin, siteId: deps.siteId, files: {} }; }
function validEntry(deps, path, entry) {
  if (entryPath(deps, entry) !== path || typeof entry.hash !== "string" || !HEX_HASH.test(entry.hash)) return false;
  if (entry.pendingOperationId !== undefined && (typeof entry.pendingOperationId !== "string" || typeof entry.pendingHash !== "string")) return false;
  if (entry.kind === "public") {
    return hasExactKeys(entry.versions, ["domain", "origins"]) && hasExactKeys(entry.parts, ["domain", "origins"])
      && [...Object.values(entry.versions), ...Object.values(entry.parts)].every((value) => typeof value === "string" && value);
  }
  return typeof entry.version === "string" && entry.version.length > 0;
}
async function loadState(deps, root) {
  const local = await readLocal(deps, root, STATE_PATH);
  if (!local.exists) return null;
  const state = local.value;
  if (local.problem || !isRecord(state) || state.formatVersion !== 1 || typeof state.origin !== "string" || typeof state.siteId !== "string" || !isRecord(state.files)) {
    throw fail(deps, "sync_state_invalid");
  }
  for (const [path, entry] of Object.entries(state.files)) {
    let valid = false;
    try { valid = validEntry(deps, path, entry); } catch { valid = false; }
    if (!valid) throw fail(deps, "sync_state_invalid");
  }
  return state;
}
const saveState = (deps, root, state) => writeText(deps, root, STATE_PATH, canonicalJson(state));

/** Opens an existing synced directory, or (for pull) an empty or missing one. */
async function openDirectory(deps, directory, { create }) {
  const root = resolve(directory ?? ".");
  let info = null;
  try { info = await stat(root); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (info && !info.isDirectory()) throw fail(deps, "sync_dir_not_empty");
  const state = info ? await loadState(deps, root) : null;
  if (state) {
    if (state.origin !== deps.origin || state.siteId !== deps.siteId) throw fail(deps, "sync_dir_other_site");
    return { root, state, fresh: false };
  }
  if (!create) throw fail(deps, "sync_state_missing");
  if (info && (await readdir(root)).length) throw fail(deps, "sync_dir_not_empty");
  if (!info) await mkdir(root, { recursive: true });
  return { root, state: freshState(deps), fresh: true };
}

/* ---------- remote ---------- */

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
function optional(deps, run) {
  // A site without the operation answers 404; that is an empty result, anything else is a real failure.
  return run().catch((error) => { if (error instanceof deps.CliError && error.status === 404) return null; throw error; });
}
async function studioRead(deps, name, maximumBytes) {
  const { status, ok, payload } = await deps.studioOperation("GET", name, undefined, maximumBytes);
  if (!ok) throw fail(deps, errorCode(payload), status);
  return { status, payload };
}
const publicContent = (settings) => ({
  domain: { hostname: settings.domain.hostname, noindex: settings.domain.noindex },
  origins: { frameOrigins: settings.origins.frameOrigins, resourceOrigins: settings.origins.resourceOrigins }
});
function publicEntry(settings) {
  const content = publicContent(settings);
  return { kind: "public", versions: { domain: settings.domain.version, origins: settings.origins.version },
    parts: { domain: hashOf(content.domain), origins: hashOf(content.origins) }, hash: hashOf(content) };
}
const sitePath = (value) => typeof value === "string" && value ? (value.startsWith("/") ? value : `/${value}`) : null;

/** Reads everything first, so a failed read never leaves a half written directory. */
async function fetchRemote(deps) {
  const { client, siteId } = deps;
  const resources = new Map();
  const add = (path, entry, value) => { resources.set(path, { path, value, entry: { ...entry, hash: hashOf(value) } }); };

  const catalog = await deps.apiCall(() => client.readPageCatalog(timeout()));
  const snapshots = await mapLimit(catalog.pages, READ_CONCURRENCY, (page) =>
    deps.apiCall(() => client.read({ siteId, pageId: page.pageId, locale: page.locale }, timeout())));
  catalog.pages.forEach((page, index) => {
    add(pageFile(deps, page.locale, page.pageId), { kind: "page", pageId: page.pageId, locale: page.locale, version: snapshots[index].version }, snapshots[index].document);
  });

  const collections = (await optional(deps, () => deps.apiCall(() => client.readCmsSchema(timeout())))) ?? [];
  const cmsPaths = [];
  const itemTargets = [];
  for (const collection of collections) {
    const summaries = await deps.apiCall(() => client.listCmsItems(collection.id, timeout()));
    for (const summary of summaries) {
      itemTargets.push({ siteId, collectionId: collection.id, itemId: summary.id });
      if (sitePath(summary.path)) cmsPaths.push(sitePath(summary.path));
    }
  }
  const items = await mapLimit(itemTargets, READ_CONCURRENCY, (target) => deps.apiCall(() => client.readCmsItem(target, timeout())));
  itemTargets.forEach((target, index) => {
    add(cmsFile(deps, target.collectionId, target.itemId), { kind: "cms", collectionId: target.collectionId, itemId: target.itemId, version: items[index].version }, items[index].values);
  });

  const seo = (await studioRead(deps, "site.seo.read", 64 * 1024));
  if (!isRecord(seo.payload) || !parseManagedSiteSeoSettings(seo.payload.settings) || !isEditingApiVersion(seo.payload.version)) throw fail(deps, "invalid_response", seo.status);
  add(SEO_PATH, { kind: "seo", version: seo.payload.version }, parseManagedSiteSeoSettings(seo.payload.settings));

  const redirects = await studioRead(deps, "site.redirects.read", 512 * 1024);
  const parsedRedirects = isRecord(redirects.payload) ? parseManagedSiteRedirects(redirects.payload.redirects) : null;
  if (!parsedRedirects || !isEditingApiVersion(redirects.payload.version)) throw fail(deps, "invalid_response", redirects.status);
  add(REDIRECTS_PATH, { kind: "redirects", version: redirects.payload.version }, parsedRedirects);

  const publicRead = await studioRead(deps, "site.public.read", 16 * 1024);
  const publicSettings = isRecord(publicRead.payload) ? deps.parsePublicSettings(publicRead.payload) : null;
  if (!publicSettings) throw fail(deps, "invalid_response", publicRead.status);
  const publicValue = publicContent(publicSettings);
  resources.set(PUBLIC_PATH, { path: PUBLIC_PATH, value: publicValue, entry: publicEntry(publicSettings) });

  const styles = await deps.apiCall(() => client.readSiteStyles(timeout()));
  add(STYLES_PATH, { kind: "styles", version: styles.draft.version }, styles.draft.styles);

  const breakpoints = await optional(deps, () => deps.apiCall(() => client.readBreakpointSettings(timeout())));
  const publicPaths = [...new Set([...catalog.pages.map((page) => sitePath(page.path)), ...cmsPaths].filter(Boolean))].sort();
  const context = { formatVersion: 1, siteId, breakpointSettings: breakpoints ?? null, publicPaths,
    pages: catalog.pages.map((page) => ({ pageId: page.pageId, locale: page.locale, path: sitePath(page.path) })) };
  return { resources, context };
}

/* ---------- pull ---------- */

const sameVersion = (entry, other) => entry.kind === "public"
  ? entry.versions.domain === other.versions.domain && entry.versions.origins === other.versions.origins
  : entry.version === other.version;
const withServerVersion = (entry, server) => entry.kind === "public" ? { ...entry, versions: server.versions } : { ...entry, version: server.version };

export async function runPull(directory, deps) {
  const { root, state, fresh } = await openDirectory(deps, directory, { create: true });
  const remote = await fetchRemote(deps);
  if (fresh) await saveState(deps, root, state);
  const result = { written: [], kept: [], conflicts: [], removed: [], unchanged: [] };
  const files = state.files;
  try {
    for (const path of [...remote.resources.keys()].sort()) {
      const server = remote.resources.get(path);
      const known = files[path];
      const local = await readLocal(deps, root, path);
      const write = async () => { await writeText(deps, root, path, canonicalJson(server.value)); files[path] = server.entry; result.written.push(path); };
      if (!local.exists) { await write(); continue; }
      if (local.hash === server.entry.hash) { files[path] = server.entry; result.unchanged.push(path); continue; }
      if (!known) { result.conflicts.push({ path, reason: "untracked_local_file" }); continue; }
      const serverUnchanged = sameVersion(known, server.entry) || known.hash === server.entry.hash;
      if (local.hash === known.hash) {
        if (serverUnchanged) result.unchanged.push(path);
        else await write();
      } else if (serverUnchanged) {
        files[path] = withServerVersion(known, server.entry);
        result.kept.push(path);
      } else result.conflicts.push({ path, reason: "server_changed" });
    }
    for (const [path, known] of Object.entries(files)) {
      if (remote.resources.has(path)) continue;
      const local = await readLocal(deps, root, path);
      if (local.exists && local.hash !== known.hash) { result.conflicts.push({ path, reason: "deleted_on_server" }); continue; }
      if (local.exists) {
        await rm(insidePath(root, path), { force: true });
        await rmdir(dirname(insidePath(root, path))).catch(() => {});
      }
      delete files[path];
      result.removed.push(path);
    }
    await writeText(deps, root, CONTEXT_PATH, canonicalJson(remote.context));
  } finally { await saveState(deps, root, state); }
  deps.emit({
    counts: { written: result.written.length, kept: result.kept.length, conflicts: result.conflicts.length, removed: result.removed.length, unchanged: result.unchanged.length },
    written: result.written, kept: result.kept, conflicts: result.conflicts, removed: result.removed,
    ...(result.conflicts.length ? { hint: CONFLICT_HINT } : {})
  }, null, result.conflicts.length ? 1 : 0, "sync.pull");
}

/* ---------- local scan and check ---------- */

async function readContext(deps, root) {
  const local = await readLocal(deps, root, CONTEXT_PATH);
  const value = local.value;
  if (!local.exists || local.problem || !isRecord(value) || value.formatVersion !== 1) return { breakpointSettings: null, publicPaths: [], pages: [] };
  return { breakpointSettings: isRecord(value.breakpointSettings) ? value.breakpointSettings : null,
    publicPaths: Array.isArray(value.publicPaths) ? value.publicPaths.filter((path) => typeof path === "string") : [],
    pages: Array.isArray(value.pages) ? value.pages.filter(isRecord) : [] };
}

/** status: unchanged | changed | new | missing. A file that cannot be read counts as changed. */
async function scanLocal(deps, root, state) {
  const found = [];
  for (const name of SYNC_DIRECTORIES) await walkJson(root, name, 0, found);
  const items = [];
  for (const path of [...new Set([...Object.keys(state.files), ...found])].sort()) {
    const entry = state.files[path];
    const identity = entry ?? classifyPath(deps, path);
    if (!identity) continue;
    const local = await readLocal(deps, root, path);
    const status = !local.exists ? "missing" : !entry ? "new" : local.hash === entry.hash ? "unchanged" : "changed";
    if (!entry && !local.exists) continue;
    items.push({ path, entry, identity, local, status });
  }
  return items;
}

const problem = (code, message) => ({ code, message });
function messageOf(error) { return String(error instanceof Error ? error.message : error).slice(0, 400); }
function isPlainPublicValue(value) {
  return hasExactKeys(value, ["domain", "origins"]) && hasExactKeys(value.domain, ["hostname", "noindex"])
    && (value.domain.hostname === null || typeof value.domain.hostname === "string") && typeof value.domain.noindex === "boolean"
    && hasExactKeys(value.origins, ["frameOrigins", "resourceOrigins"])
    && [value.origins.frameOrigins, value.origins.resourceOrigins].every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"));
}
const placeholderComponent = () => null;
/** Every block used by the page renders as its empty `data-nw-block` wrapper; the contract is read off the page itself. */
function placeholderBlocks(document) {
  const blocks = {};
  const visit = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!isRecord(node)) continue;
      if (node.type === "component" && typeof node.block === "string") {
        const props = blocks[node.block]?.props ?? {};
        for (const [name, value] of Object.entries(isRecord(node.props) ? node.props : {})) {
          props[name] = { type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string" };
        }
        Object.defineProperty(blocks, node.block, { value: { props, component: placeholderComponent }, enumerable: true, configurable: true, writable: true });
      }
      visit(node.children);
    }
  };
  visit(document.body);
  return blocks;
}
const htmlShell = (document, body) => `<!doctype html>\n<html lang="${document.locale.replace(/[^A-Za-z0-9-]/gu, "")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<title>${document.title.replace(/[&<>"]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character])}</title></head><body>${body}</body></html>\n`;

/**
 * Local validation of the given files. No request is sent: it uses only the files and .niho/context.json.
 * Returns { results: [{ file, errors, warnings }], rendered: [paths] }.
 */
async function validateFiles(deps, root, targets, { all, html }) {
  const context = await readContext(deps, root);
  const results = new Map();
  const resultFor = (file) => { if (!results.has(file)) results.set(file, { file, errors: [], warnings: [] }); return results.get(file); };
  const documents = [];

  const stylesLocal = await readLocal(deps, root, STYLES_PATH);
  let siteStyles = {};
  if (stylesLocal.exists && !stylesLocal.problem && isRecord(stylesLocal.value)) {
    try { siteStyles = parseSiteStyles(stylesLocal.value); } catch { /* reported when site/styles.json itself is checked */ }
  }

  for (const item of targets) {
    const result = resultFor(item.path);
    if (item.local.problem) { result.errors.push(problem(item.local.problem, "ファイルを JSON として読めません")); continue; }
    const { value } = item.local;
    switch (item.identity.kind) {
      case "page": {
        let document;
        try { document = parseEditingPageDocumentEnvelope(value); }
        catch { result.errors.push(problem("invalid_document", "ページ文書の形式が正しくありません")); break; }
        if (document.siteId !== deps.siteId || document.pageId !== item.identity.pageId || document.locale !== item.identity.locale) {
          result.errors.push(problem("identity_mismatch", "文書の siteId・pageId・locale がファイルの場所と一致しません"));
          break;
        }
        if (item.local.bytes > PAGE_WARNING_BYTES) {
          result.warnings.push(problem("page_too_large", `ページが ${Math.round(item.local.bytes / 1024)}KB あります。${PAGE_WARNING_BYTES / 1024}KB 以下に分けることを検討してください`));
        }
        documents.push({ item, document });
        break;
      }
      case "cms":
        if (!isRecord(value)) result.errors.push(problem("invalid_cms_values", "CMS 項目の values は JSON オブジェクトにしてください"));
        break;
      case "seo":
        if (!parseManagedSiteSeoSettings(value)) result.errors.push(problem("invalid_seo", "SEO 設定の形式が正しくありません"));
        break;
      case "redirects":
        if (!parseManagedSiteRedirects(value)) result.errors.push(problem("invalid_redirects", "リダイレクトの形式が正しくありません（重複・ループ・不正な path を含みます）"));
        break;
      case "public":
        if (!isPlainPublicValue(value)) result.errors.push(problem("invalid_public", "domain と origins の形式が正しくありません"));
        break;
      case "styles":
        try { if (!isRecord(value)) throw new TypeError("styles must be an object"); parseSiteStylesWithFrame(value); }
        catch (error) { result.errors.push(problem("invalid_styles", messageOf(error))); }
        break;
    }
  }

  if (documents.length) {
    const { lintDocuments } = await import("../dist/normalize.js");
    const lintContext = { ...siteStyles, ...(context.breakpointSettings ? { breakpointSettings: context.breakpointSettings } : {}) };
    const keyOf = (target) => `${target.pageId}\u0000${target.locale}`;
    const byKey = new Map(documents.map((entry) => [keyOf(entry.document), entry]));
    let findings = [];
    try { findings = lintDocuments(documents.map((entry) => entry.document), lintContext); }
    catch {
      for (const entry of documents) {
        try { findings.push(...lintDocuments([entry.document], lintContext)); }
        catch (error) { resultFor(entry.item.path).errors.push(problem("invalid_document", messageOf(error))); }
      }
    }
    for (const { target, ...finding } of findings) {
      // Site-wide usage rules need every page; a partial set would report tokens as unused.
      if (!all && (finding.code === "unused-token" || finding.code === "unused-breakpoint")) continue;
      const owner = target ? byKey.get(keyOf(target))?.item.path : STYLES_PATH;
      if (owner) resultFor(owner).warnings.push(finding);
    }
  }

  const rendered = [];
  if (html) {
    const { renderPageToHtml } = await import("../dist/server.js");
    const { inspectManagedHtmlSeo } = await import("../dist/managed-html-seo-checks.js");
    const out = resolve(html);
    for (const { item, document } of documents) {
      const result = resultFor(item.path);
      if (result.errors.length) continue;
      let body;
      try { body = renderPageToHtml(document, placeholderBlocks(document), { siteStyles }); }
      catch (error) {
        result.warnings.push(problem("html_render_unavailable", `この環境では描画できませんでした: ${messageOf(error)}`));
        continue;
      }
      const path = context.pages.find((page) => page.pageId === document.pageId && page.locale === document.locale)?.path ?? "/";
      try {
        for (const warning of inspectManagedHtmlSeo(body, { locale: document.locale, pageUrl: `https://site.invalid${path}`, knownPaths: context.publicPaths })) result.warnings.push(warning);
      } catch (error) { result.warnings.push(problem("seo_check_unavailable", messageOf(error))); }
      const target = join(out, document.locale, `${document.pageId}.html`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, htmlShell(document, body), "utf8");
      rendered.push(target);
    }
  }
  return { results: [...results.values()], rendered };
}

export async function runCheck(directory, options, deps) {
  if (options.html !== undefined && (!options.html.trim() || options.html.includes("\u0000"))) throw fail(deps, "invalid_arguments");
  const { root, state } = await openDirectory(deps, directory, { create: false });
  const items = await scanLocal(deps, root, state);
  const targets = items.filter((item) => item.status !== "missing" && (options.all || item.status !== "unchanged"));
  const { results, rendered } = await validateFiles(deps, root, targets, { all: options.all, html: options.html });
  const errors = results.reduce((sum, result) => sum + result.errors.length, 0);
  const warnings = results.reduce((sum, result) => sum + result.warnings.length, 0);
  deps.emit({
    status: errors ? "errors" : warnings ? "warnings" : "clean",
    checked: targets.length, errors, warnings,
    files: results.filter((result) => result.errors.length || result.warnings.length),
    ...(options.html === undefined ? {} : { html: rendered })
  }, null, errors ? 1 : 0, "sync.check");
}

/* ---------- push ---------- */

function failureOf(deps, error) {
  if (error instanceof deps.CliError) {
    const reason = typeof error.details?.reason === "string" ? error.details.reason.slice(0, 400) : undefined;
    return { reason: error.code, ...(error.status ? { status: error.status } : {}), ...(reason ? { detail: reason } : {}) };
  }
  if (error instanceof TypeError) return { reason: "invalid_request", detail: messageOf(error) };
  throw error;
}
const orderOf = { page: 0, cms: 1, seo: 2, redirects: 3, public: 4, styles: 5 };

export async function runPush(directory, deps) {
  const { root, state } = await openDirectory(deps, directory, { create: false });
  const files = state.files;
  const out = { saved: [], conflicts: [], invalid: [], skipped: [], unchanged: [] };
  const items = await scanLocal(deps, root, state);
  const changed = [];
  for (const item of items) {
    if (item.status === "missing") out.skipped.push({ path: item.path, reason: "deleted-locally", hint: "削除は Studio の GUI か page-change で行います" });
    else if (item.status === "new") {
      out.skipped.push({ path: item.path, reason: "new-file",
        hint: item.identity.kind === "page" ? "新しいページは page-change で作成してから pull します" : item.identity.kind === "cms" ? "新しい CMS 項目は cms-create で作成してから pull します" : "このファイルは同期の対象ではありません" });
    } else if (item.status === "changed") changed.push(item);
  }
  const { results } = await validateFiles(deps, root, changed, { all: false, html: undefined });
  const checks = new Map(results.map((result) => [result.file, result]));
  const warnings = results.filter((result) => result.warnings.length).map(({ file, warnings: list }) => ({ file, warnings: list }));
  const ready = [];
  for (const item of changed.sort((a, b) => orderOf[a.entry.kind] - orderOf[b.entry.kind] || a.path.localeCompare(b.path))) {
    const errors = checks.get(item.path)?.errors ?? [];
    if (errors.length) out.invalid.push({ path: item.path, reason: "check_failed", errors });
    else ready.push(item);
  }
  const conflict = (item, extra = {}) => out.conflicts.push({ path: item.path, reason: "version_conflict", ...extra });
  const settle = async (item, entry, value, list = out.saved) => {
    await writeText(deps, root, item.path, canonicalJson(value));
    files[item.path] = entry;
    await saveState(deps, root, state);
    list.push(item.path);
  };
  const { client, siteId } = deps;

  for (const item of ready) {
    const { entry, local, path } = item;
    try {
      if (entry.kind === "page") {
        const document = parseEditingPageDocumentEnvelope(local.value);
        const result = await deps.apiCall(() => client.save({ siteId, pageId: entry.pageId, locale: entry.locale }, entry.version, document, timeout()));
        if (result.status === "conflict") conflict(item);
        else await settle(item, { kind: "page", pageId: entry.pageId, locale: entry.locale, version: result.version, hash: hashOf(result.document) }, result.document);
      } else if (entry.kind === "cms") {
        // A retry after a lost response must reuse the operation ID, or a save the server already applied is applied twice.
        const operationId = entry.pendingOperationId && entry.pendingHash === local.hash ? entry.pendingOperationId : randomUUID();
        files[path] = { ...entry, pendingOperationId: operationId, pendingHash: local.hash };
        await saveState(deps, root, state);
        let result;
        try { result = await deps.apiCall(() => client.saveCmsItem({ siteId, collectionId: entry.collectionId, itemId: entry.itemId }, entry.version, operationId, local.value, timeout())); }
        catch (error) {
          const undecided = error instanceof deps.CliError && (error.status === null || error.status >= 500);
          if (!undecided) { files[path] = entry; await saveState(deps, root, state); }
          throw error;
        }
        if (result.status === "conflict") { files[path] = entry; await saveState(deps, root, state); conflict(item, { currentVersion: result.current.version }); }
        else await settle(item, { kind: "cms", collectionId: entry.collectionId, itemId: entry.itemId, version: result.item.version, hash: hashOf(result.item.values) }, result.item.values);
      } else if (entry.kind === "seo") {
        const { status, ok, payload } = await deps.studioOperation("PUT", "site.seo.save", { expectedVersion: entry.version, settings: local.value }, 64 * 1024);
        if (!ok) { reportStudioFailure(out, item, status, payload); continue; }
        const settings = isRecord(payload) ? parseManagedSiteSeoSettings(payload.settings) : null;
        if (!settings || !isEditingApiVersion(payload.version)) throw fail(deps, "invalid_response", status);
        // The SEO settings and the allowed origins share one version in the server. Move the origins base along with it.
        const publicEntryState = files[PUBLIC_PATH];
        if (publicEntryState && publicEntryState.versions.origins === entry.version) publicEntryState.versions.origins = payload.version;
        await settle(item, { kind: "seo", version: payload.version, hash: hashOf(settings) }, settings);
      } else if (entry.kind === "redirects") {
        const { status, ok, payload } = await deps.studioOperation("PUT", "site.redirects.save", { expectedVersion: entry.version, redirects: local.value }, 512 * 1024);
        if (!ok) { reportStudioFailure(out, item, status, payload); continue; }
        const redirects = isRecord(payload) ? parseManagedSiteRedirects(payload.redirects) : null;
        if (!redirects || !isEditingApiVersion(payload.version)) throw fail(deps, "invalid_response", status);
        await settle(item, { kind: "redirects", version: payload.version, hash: hashOf(redirects) }, redirects);
      } else if (entry.kind === "public") await pushPublic(deps, root, state, item, out, settle);
      else if (entry.kind === "styles") await pushStyles(deps, item, out, settle);
    } catch (error) {
      const failure = failureOf(deps, error);
      out.invalid.push({ path, ...failure });
    }
  }

  const code = out.conflicts.length || out.invalid.length ? 1 : 0;
  deps.emit({
    counts: { saved: out.saved.length, conflicts: out.conflicts.length, invalid: out.invalid.length, skipped: out.skipped.length },
    saved: out.saved, conflicts: out.conflicts, invalid: out.invalid, skipped: out.skipped,
    ...(out.unchanged.length ? { unchanged: out.unchanged } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(out.conflicts.length ? { hint: CONFLICT_HINT } : {})
  }, null, code, "sync.push");
}

function reportStudioFailure(out, item, status, payload) {
  const reason = errorCode(payload);
  if (status === 409 && reason === "conflict") out.conflicts.push({ path: item.path, reason: "version_conflict", ...(typeof payload.part === "string" ? { part: payload.part } : {}) });
  else out.invalid.push({ path: item.path, reason, status });
}

async function pushPublic(deps, root, state, item, out, settle) {
  const { entry, local, path } = item;
  const files = state.files;
  const body = {};
  if (hashOf(local.value.domain) !== entry.parts.domain) body.domain = { ...local.value.domain, version: entry.versions.domain };
  if (hashOf(local.value.origins) !== entry.parts.origins) body.origins = { ...local.value.origins, version: entry.versions.origins };
  if (!Object.keys(body).length) { out.unchanged.push(path); return; }
  const { status, ok, payload } = await deps.studioOperation("PUT", "site.public.save", body, 16 * 1024);
  if (!ok) {
    if (payload?.error === "partial_save") {
      // The domain part is saved. Take over its new version so the next push sends only what is left.
      const fresh = await deps.studioOperation("GET", "site.public.read", undefined, 16 * 1024).catch(() => null);
      const settings = fresh?.ok && isRecord(fresh.payload) ? deps.parsePublicSettings(fresh.payload) : null;
      if (settings && body.domain && hashOf(publicContent(settings).domain) === hashOf(local.value.domain)) {
        files[path] = { ...entry, versions: { ...entry.versions, domain: settings.domain.version }, parts: { ...entry.parts, domain: hashOf(local.value.domain) } };
        await saveState(deps, root, state);
      }
      out.invalid.push({ path, reason: "partial_save", status, saved: payload.saved, failed: payload.failed, cause: payload.cause });
      return;
    }
    if (status === 409 && payload?.error === "domain_taken") { out.invalid.push({ path, reason: "domain_taken", status }); return; }
    reportStudioFailure(out, item, status, payload);
    return;
  }
  const settings = isRecord(payload) ? deps.parsePublicSettings(payload) : null;
  if (!settings) throw fail(deps, "invalid_response", status);
  const seoEntry = files[SEO_PATH];
  if (body.origins && seoEntry && seoEntry.version === entry.versions.origins) seoEntry.version = settings.origins.version;
  await settle(item, publicEntry(settings), publicContent(settings));
}

async function pushStyles(deps, item, out, settle) {
  const { entry, local, path } = item;
  const current = await deps.apiCall(() => deps.client.readSiteStyles(timeout()));
  const serverHash = hashOf(current.draft.styles);
  if (current.draft.version !== entry.version && serverHash !== entry.hash) { out.conflicts.push({ path, reason: "version_conflict" }); return; }
  const edits = siteStylesEdits(current.draft.styles, parseSiteStylesWithFrame(local.value));
  if (!edits.length) {
    await settle(item, { kind: "styles", version: current.draft.version, hash: serverHash }, current.draft.styles, out.unchanged);
    return;
  }
  const result = await deps.apiCall(() => deps.client.editSiteStyles({ expectedVersion: current.draft.version, edits }, timeout()));
  if (result.status === "conflict") out.conflicts.push({ path, reason: "version_conflict" });
  else if (result.status === "referenced") out.invalid.push({ path, reason: "referenced", usages: result.usages, hint: "使用中の共通値は削除できません。名前の変更は styles edit の rename を使います" });
  else await settle(item, { kind: "styles", version: result.version, hash: hashOf(result.styles) }, result.styles);
}
