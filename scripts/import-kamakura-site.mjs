import { createHash } from "node:crypto";
import { join } from "node:path";
import { open, readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assetKey } from "../dist/assets.js";
import { cmsArray, cmsCollection, cmsId, cmsItemKey, parseCmsSchema, parseCmsValues, uniqueCmsKeys } from "../dist/cms-v2-schema.js";
import { parseGalleryEntries } from "../dist/collection-model.js";
import { parsePageDocument } from "../dist/document.js";
import { MANAGED_EMBED_REF, managedBlockContracts } from "../dist/managed-embed-block.js";
import { buildSiteImportCmsLocalization, importPageUrl, importPublicAssetUrl, parseSiteImportPlan, parseSiteImportTarget, resolveSiteImportSourceVersion, SITE_IMPORT_ASSET_PROVIDER, SITE_IMPORT_DIGEST, SITE_IMPORT_MAX_BYTES, siteImportDigest, siteImportResourceId } from "../dist/managed-site-import.js";
import { walkNodes } from "../dist/node-tree.js";
import { editDocumentById } from "@niho/web/editor-model";
import { decodeNormalizationOperations, planNormalization, verifyNormalization } from "@niho/web/normalize";
import { validatePagePath } from "../dist/pages.js";
import { fail, identifier, isSafeHttpsOrigin, keys, line, localeCode, parseAssetReference, record } from "../dist/validation-utils.js";
import { migrateKamakuraBlocks } from "./migrate-kamakura-blocks.mjs";

const IMPORT_PAGE_DOCUMENT_HARD_MAX_BYTES = 2 * 1024 * 1024;

function sourceAssetUrl(raw, sourceOrigin) {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? new URL(raw, sourceOrigin).href : raw;
}

function mapAsset(raw, bySource, byUrl, path, sourceOrigin) {
  const asset = typeof raw === "string" ? byUrl.get(sourceAssetUrl(raw, sourceOrigin)) : bySource.get(assetKey(parseAssetReference(raw, path)));
  if (!asset) fail(path, "missing source asset mapping");
  return { ...asset };
}

function mapPage(document, bySource, byUrl, publicAssetUrls, paths, sourceOrigin) {
  const update = (asset) => mapAsset(asset, bySource, byUrl, "page.asset", sourceOrigin);
  function style(value) {
    for (const declarations of [value?.base, ...(value?.responsive ?? []).map(({ declarations }) => declarations)]) {
      if (declarations?.backgroundImage && declarations.backgroundImage !== "none") {
        declarations.backgroundImage.asset = update(declarations.backgroundImage.asset);
      }
    }
  }
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === "text") continue;
      style(node.style);
      if (node.type === "component") {
        for (const slot of Object.values(node.slots ?? {})) style(slot);
        continue;
      }
      if (node.asset) node.asset = update(node.asset);
      if (node.attrs) {
        const attrs = node.attrs, match = byUrl.get(sourceAssetUrl(attrs.src, sourceOrigin));
        if (match && (node.tag === "video" || node.tag === "img" && (!attrs.srcSet || byUrl.get(sourceAssetUrl(attrs.srcSet, sourceOrigin)) === match))) {
          node.asset = { ...match };
          delete attrs.src;
          if (node.tag === "img") delete attrs.srcSet;
        }
        for (const key of ["src", "srcSet", "poster", "href"]) {
          const original = publicAssetUrls.get(sourceAssetUrl(attrs[key], sourceOrigin));
          if (original) attrs[key] = original;
        }
      }
      if (node.tag === "a" && typeof node.attrs?.href === "string" && /^https:\/\/|^\/(?!\/)/u.test(node.attrs.href)) {
        const link = new URL(node.attrs.href, sourceOrigin), path = paths.get(link.origin + link.pathname);
        if (path) node.attrs.href = path + link.search + link.hash;
      }
      visit(node.children);
    }
  }
  const cover = document.meta?.ogImage;
  if (cover?.asset) cover.asset = update(cover.asset);
  const coverRef = byUrl.get(sourceAssetUrl(cover?.src, sourceOrigin));
  if (coverRef) document.meta.ogImage = { asset: { ...coverRef }, alt: cover.alt };
  const favicon = publicAssetUrls.get(sourceAssetUrl(document.meta?.favicon, sourceOrigin));
  if (favicon) document.meta.favicon = favicon;
  visit(document.body);
  return parsePageDocument(document, managedBlockContracts);
}

function mapCmsValues(raw, collection, bySource, byUrl, byItem, path, sourceOrigin) {
  const values = parseCmsValues(raw, collection, path);
  for (const field of collection.fields) {
    const { fieldId, type } = field;
    const value = values[fieldId];
    if (value == null || value === "") continue;
    const at = `${path}.${fieldId}`;
    if (type === "image") values[fieldId] = mapAsset(value, bySource, byUrl, at, sourceOrigin);
    if (type === "gallery") values[fieldId] = parseGalleryEntries(value, at).map((entry) => ({
      ...entry, image: entry.image === null ? null : mapAsset(entry.image, bySource, byUrl, at, sourceOrigin)
    }));
    if (type === "reference") values[fieldId] = value.map((sourceItemId, index) => {
      const targetItemId = byItem.get(cmsItemKey({ collectionId: field.collectionId, itemId: sourceItemId }));
      if (!targetItemId) fail(`${at}[${index}]`, "missing CMS item mapping");
      return targetItemId;
    });
  }
  return parseCmsValues(values, collection, path);
}

// 一覧の `includes` が参照の field を絞るときは、CMS の参照の値と同じ対応で移行先の項目 ID に直す。select の option id はそのまま。
function mapListFilterReferences(bindings, schema, byItem, path) {
  if (!schema || !bindings.lists.some((list) => list.filter && "includes" in list.filter)) return bindings;
  return { ...bindings, lists: bindings.lists.map((list, index) => {
    if (!list.filter || !("includes" in list.filter)) return list;
    const field = cmsCollection(schema, list.collectionId).fields.find(({ fieldId }) => fieldId === list.filter.fieldId);
    if (field?.type !== "reference") return list;
    const includes = byItem.get(cmsItemKey({ collectionId: field.collectionId, itemId: list.filter.includes }));
    if (!includes) fail(`${path}.cmsBindings.lists[${index}].filter.includes`, "missing CMS item mapping");
    return { ...list, filter: { ...list.filter, includes } };
  }) };
}

function normalizeImportedPage(document, path) {
  const beforeBytes = Buffer.byteLength(JSON.stringify(document));
  if (beforeBytes > IMPORT_PAGE_DOCUMENT_HARD_MAX_BYTES) fail(path, "page document exceeds hard size limit");
  const input = { documents: [document], blocks: managedBlockContracts };
  let normalized = document, operations;
  try {
    const plan = planNormalization(input);
    operations = plan.proposals.flatMap((proposal) => "operations" in proposal && proposal.classification === "lossless"
      ? decodeNormalizationOperations(proposal.operations) : []);
    normalized = operations.reduce((current, operation) => editDocumentById(current, operation, managedBlockContracts, [], undefined, undefined, false), document);
  } catch {
    fail(path, "lossless page normalization failed");
  }
  if (verifyNormalization(input, [normalized]).status !== "equivalent") fail(path, "lossless page normalization could not be verified");
  const afterBytes = Buffer.byteLength(JSON.stringify(normalized));
  return { document: normalized, documentBytes: { before: beforeBytes, after: afterBytes, losslessOperations: operations.length } };
}

export async function prepareKamakuraSiteImport(bytes, expectedDigest, targetValue, embedConnections = []) {
  const sourceDigest = createHash("sha256").update(bytes).digest("hex");
  if (!SITE_IMPORT_DIGEST.test(expectedDigest ?? "") || sourceDigest !== expectedDigest) throw new Error("source_checksum_mismatch");
  const target = parseSiteImportTarget(targetValue);
  const input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "source");
  keys(input, ["formatVersion", "siteId", "origin", "locale", "pages", "assets", "assetVariants", "cms", "redirects", "scheduled", "frame"], "source");
  const sourceId = identifier(input.siteId, "source.siteId"), locale = localeCode(input.locale, "source.locale");
  if (input.formatVersion !== 1 || !isSafeHttpsOrigin(input.origin) || sourceId === target.siteId
    || new URL(input.origin).hostname === new URL(target.verificationOrigin).hostname) fail("source", "invalid source scope");
  const assets = [], bySource = new Map(), byUrl = new Map(), publicAssetUrls = new Map();
  for (const [index, value] of cmsArray(input.assets ?? [], "source.assets", 5000).entries()) {
    const at = `source.assets[${index}]`, entry = record(value, at);
    keys(entry, ["source", "url", "width", "height", "altText", "contentSha256", "byteLength", "aliases"], at);
    const source = parseAssetReference(entry.source, `${at}.source`), key = assetKey(source);
    if (bySource.has(key)) fail(at, "duplicate original asset");
    const reference = { provider: SITE_IMPORT_ASSET_PROVIDER, id: await siteImportResourceId("asset", target.siteId, key) };
    const url = importPublicAssetUrl(entry.url, `${at}.url`);
    const aliases = cmsArray(entry.aliases ?? [], `${at}.aliases`, 5000).map((alias) => importPublicAssetUrl(alias, `${at}.aliases`));
    assets.push({ source, aliases, contentSha256: entry.contentSha256, byteLength: entry.byteLength, target: { reference, url, width: entry.width, height: entry.height, altText: entry.altText } });
    bySource.set(key, reference);
    for (const spelling of [url, ...aliases]) {
      if (byUrl.has(spelling)) fail(at, "duplicate original asset URL or alias");
      byUrl.set(spelling, reference);
      publicAssetUrls.set(spelling, url);
    }
  }
  const assetVariants = cmsArray(input.assetVariants ?? [], "source.assetVariants", 10_000).map((value, index) => {
    const at = `source.assetVariants[${index}]`, entry = record(value, at);
    keys(entry, ["source", "original"], at);
    const source = parseAssetReference(entry.source, `${at}.source`), original = parseAssetReference(entry.original, `${at}.original`);
    return { source, original };
  });
  const originals = new Map(bySource);
  for (const { source, original } of assetVariants) {
    const key = assetKey(source), originalRef = originals.get(assetKey(original));
    if (!originalRef || bySource.has(key)) fail("source.assetVariants", "ambiguous asset variant");
    bySource.set(key, originalRef);
  }
  const rawPages = cmsArray(input.pages, "source.pages", 500).map((value, index) => {
    const at = `source.pages[${index}]`, entry = record(value, at);
    keys(entry, ["sourceUrl", "sourcePageId", "path", "locale", "title", "visibility", "published", "draft"], at);
    const sourceUrl = importPageUrl(entry.sourceUrl, input.origin, `${at}.sourceUrl`);
    const pageLocale = localeCode(entry.locale, `${at}.locale`);
    if (validatePagePath(entry.path) !== null || entry.path === "/cms" || entry.path.startsWith("/cms/")
      || entry.path === "/" && pageLocale !== locale || !["public", "private"].includes(entry.visibility)) fail(at, "invalid target page route");
    return { ...entry, sourceUrl, locale: pageLocale, sourcePageId: identifier(entry.sourcePageId, `${at}.sourcePageId`) };
  });
  uniqueCmsKeys(rawPages.map(({ sourceUrl }) => sourceUrl), "source.pages.sourceUrl");
  uniqueCmsKeys(rawPages.map(({ path }) => path), "source.pages.path");
  const connections = new Map();
  for (const [index, raw] of cmsArray(embedConnections, "embedConnections", 500).entries()) {
    const at = `embedConnections[${index}]`, entry = record(raw, at);
    keys(entry, ["sourceUrl", "refId", "src"], at);
    const sourceUrl = importPageUrl(entry.sourceUrl, input.origin, `${at}.sourceUrl`);
    if (!rawPages.some((page) => page.sourceUrl === sourceUrl) || typeof entry.refId !== "string" || !MANAGED_EMBED_REF.test(entry.refId)
      || typeof entry.src !== "string" || entry.src.length > 8192 || !entry.src.startsWith("https://")) fail(at, "invalid target embed connection");
    const page = connections.get(sourceUrl) ?? [];
    if (page.some(({ refId }) => refId === entry.refId)) fail(at, "duplicate embed connection");
    page.push({ refId: entry.refId, src: entry.src });
    connections.set(sourceUrl, page);
  }
  const paths = new Map(rawPages.map(({ sourceUrl, path }) => [sourceUrl, path])), pageMap = [], pages = [];
  const rawCms = input.cms == null ? null : record(input.cms, "source.cms");
  const cmsEntries = [], cmsItems = [], itemMap = [], targetItemIds = new Map();
  let schema;
  if (rawCms) {
    keys(rawCms, ["schema", "items"], "source.cms");
    const sourceSchema = parseCmsSchema(rawCms.schema);
    if (sourceSchema.siteId !== sourceId) fail("source.cms.schema", "source site mismatch");
    schema = parseCmsSchema({ ...sourceSchema, siteId: target.siteId, schemaRevision: `import_${sourceDigest}`, retiredFields: [] });
    const sourceItems = cmsArray(rawCms.items, "source.cms.items", 500);
    for (const [index, value] of sourceItems.entries()) {
      const at = `source.cms.items[${index}]`, raw = record(value, at);
      keys(raw, ["collectionId", "itemId", "published", "draft", "translations"], at);
      const collectionId = cmsId(raw.collectionId, `${at}.collectionId`), itemId = cmsId(raw.itemId, `${at}.itemId`);
      const sourceKey = cmsItemKey({ collectionId, itemId });
      if (targetItemIds.has(sourceKey)) fail(at, "duplicate original CMS item");
      targetItemIds.set(sourceKey, await siteImportResourceId("item", target.siteId, sourceKey));
    }
    for (const [index, value] of sourceItems.entries()) {
      const at = `source.cms.items[${index}]`, raw = record(value, at);
      keys(raw, ["collectionId", "itemId", "published", "draft", "translations"], at);
      const collectionId = cmsId(raw.collectionId, `${at}.collectionId`), itemId = cmsId(raw.itemId, `${at}.itemId`);
      const collection = cmsCollection(schema, collectionId);
      const item = { collectionId, itemId, published: raw.published === null ? null : mapCmsValues(raw.published, collection, bySource, byUrl, targetItemIds, `${at}.published`, input.origin),
        draft: mapCmsValues(raw.draft, collection, bySource, byUrl, targetItemIds, `${at}.draft`, input.origin),
        ...(raw.translations === undefined ? {} : { translations: raw.translations }) };
      const targetItemId = targetItemIds.get(cmsItemKey(item));
      if (!targetItemId) fail(at, "missing target CMS item mapping");
      if (item.translations !== undefined) {
        const revision = (values, revision) => ({ siteId: target.siteId, schemaRevision: schema.schemaRevision, collectionId, itemId: targetItemId, locale, revision, values });
        await buildSiteImportCmsLocalization(schema, item.published === null ? null : revision(item.published, "public-import"),
          revision(item.draft, "draft-import"), item.translations);
      }
      const digest = await siteImportDigest(item);
      cmsEntries.push({ collectionId, itemId, digest });
      cmsItems.push(item);
      itemMap.push({ collectionId, sourceItemId: itemId, itemId: targetItemId });
    }
  }
  for (const [index, page] of rawPages.entries()) {
    const pageId = page.path === "/" ? "home" : await siteImportResourceId("page", target.siteId, page.sourceUrl);
    const firstRevision = pageId === "home" ? 2 : 1;
    const sourceScope = { siteId: sourceId, pageId: page.sourcePageId, locale: page.locale };
    const at = `source.pages[${index}]`;
    const publicSource = page.published === null ? null : resolveSiteImportSourceVersion(page.published, sourceScope, `${at}.published`);
    const draftSource = resolveSiteImportSourceVersion(page.draft, sourceScope, `${at}.draft`);
    function convert(source, revision, versionName) {
      const { version } = source, at = `source.pages[${index}].${versionName}`;
      const scope = { siteId: target.siteId, pageId, locale: page.locale, revision };
      let ready, cmsBindings;
      if (version.replacements !== undefined) {
        if (!Array.isArray(version.replacements) || version.replacements.some((entry) => !["carousel", "cms-detail", "cms-list", "frame", "managed-embed"].includes(entry?.kind)
          || entry.kind === "managed-embed" && !MANAGED_EMBED_REF.test(entry.refId ?? ""))) fail(at, "invalid replacement");
        const result = migrateKamakuraBlocks({ ...version, sourceBlocks: version.sourceBlocks ?? managedBlockContracts,
          ...(schema ? { cmsSchema: schema } : {}), target: { ...scope, version: "import" } });
        if (result.status !== "ready") fail(at, result.blocked.map(({ nodeId, reason }) => `${nodeId}: ${reason}`).join(", "));
        ready = result.snapshot.document;
        cmsBindings = result.cmsBindings && mapListFilterReferences(result.cmsBindings, schema, targetItemIds, at);
      } else {
        ready = parsePageDocument({ ...source.resolved, ...scope }, managedBlockContracts);
      }
      const mapped = mapPage(ready, bySource, byUrl, publicAssetUrls, paths, input.origin);
      const normalized = normalizeImportedPage(mapped, at);
      return { ...normalized, ...(cmsBindings ? { cmsBindings } : {}) };
    }
    const published = publicSource === null ? null : convert(publicSource, firstRevision, "published");
    const draft = convert(draftSource, firstRevision + Number(published !== null), "draft");
    const pageConnections = connections.get(page.sourceUrl) ?? [];
    const refs = new Set([draft.document, ...(published ? [published.document] : [])].flatMap((document) => walkNodes(document).flatMap(({ node }) =>
      node.type === "component" && node.block === "ManagedEmbed" ? [node.props.refId] : [])));
    if (pageConnections.length !== refs.size || pageConnections.some(({ refId }) => !refs.has(refId))) {
      fail(`source.pages[${index}]`, "expected a target-scoped connection for each managed embed");
    }
    pages.push({ sourceUrl: page.sourceUrl, path: page.path, locale: page.locale, title: line(page.title ?? draft.document.title, "page.title", 120),
      visibility: page.visibility, published: published?.document ?? null, draft: draft.document,
      ...(published?.cmsBindings ? { publishedCmsBindings: published.cmsBindings } : {}),
      ...(draft.cmsBindings ? { draftCmsBindings: draft.cmsBindings } : {}),
      ...(pageConnections.length ? { connections: pageConnections } : {}) });
    pageMap.push({ sourceUrl: page.sourceUrl, pageId, locale: page.locale, path: page.path,
      documentBytes: { published: published?.documentBytes ?? null, draft: draft.documentBytes } });
  }
  // 共通の枠（任意）。各言語の header・footer は、ページと同じ素材・リンクの対応で移行先の形に直す。
  let frame;
  if (input.frame !== undefined) {
    frame = {};
    for (const [frameLocale, value] of Object.entries(record(input.frame, "source.frame"))) {
      const at = `source.frame.${frameLocale}`, entry = record(value, at);
      keys(entry, ["header", "footer", "tokens", "textStyles", "layout"], at);
      const part = (name) => mapPage(parsePageDocument({ schemaVersion: 1, siteId: "frame", pageId: `frame-${name}`, locale: localeCode(frameLocale, at),
        revision: 1, title: "Frame", tokens: entry.tokens ?? {}, ...(entry.textStyles ? { textStyles: entry.textStyles } : {}), body: entry[name] },
      managedBlockContracts), bySource, byUrl, publicAssetUrls, paths, input.origin).body;
      frame[frameLocale] = { ...entry, header: part("header"), footer: part("footer") };
    }
  }
  const plan = parseSiteImportPlan({ sourceOrigin: input.origin, sourceSiteId: sourceId, locale, assets, assetVariants,
    pages: await Promise.all(pages.map(async (page) => ({ sourceUrl: page.sourceUrl, digest: await siteImportDigest(page) }))),
    cms: schema ? { schema, items: cmsEntries } : null, redirects: input.redirects ?? [], scheduled: input.scheduled ?? [], ...(frame ? { frame } : {}) }, target.siteId);
  for (const { fromPath } of plan.redirects) if (paths.has(new URL(fromPath, input.origin).href) || pages.some(({ path }) => path === fromPath)) {
    fail("source.redirects", "redirect conflicts with an imported page");
  }
  const result = { target, sourceDigest, plan, pages, cmsItems, mapping: { pages: pageMap, cmsItems: itemMap,
    assets: assets.map(({ source, target, aliases, contentSha256 }) => ({ source, reference: target.reference, sourceUrl: target.url, aliases, contentSha256 }))
      .concat(assetVariants.map(({ source }) => ({ source, reference: bySource.get(assetKey(source)) }))) } };
  for (const [action, payload] of [["begin", plan], ...pages.map((page) => ["page", page]), ...cmsItems.map((item) => ["cms", item])]) {
    if (Buffer.byteLength(JSON.stringify({ target, sourceDigest, action, payload })) > SITE_IMPORT_MAX_BYTES) fail("source", "resource exceeds import size limit");
  }
  return result;
}

export async function readKamakuraImportAsset(assetDir, digest, byteLength) {
  if (!assetDir || !SITE_IMPORT_DIGEST.test(digest)) throw new Error("source_asset_directory_required");
  const file = await open(join(assetDir, digest), "r");
  try {
    const { size } = await file.stat();
    if (size !== byteLength) throw new Error("source_asset_size_mismatch");
    const bytes = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("source_asset_size_mismatch");
      offset += bytesRead;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("source_asset_checksum_mismatch");
    return bytes;
  } finally { await file.close(); }
}

function originalAssets(plan) {
  return new Map(plan.assets.map(({ contentSha256, byteLength }) => [contentSha256, byteLength]));
}

function importClient(prepared, origin, token, fetcher) {
  if (!isSafeHttpsOrigin(origin) || origin === prepared.target.verificationOrigin) throw new Error("invalid_studio_origin");
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(token)) throw new Error("missing_studio_token");
  const { target, sourceDigest } = prepared;
  const endpoint = `${origin}/api/edit/v2/sites/${encodeURIComponent(target.siteId)}/operations/site.migration-import`;
  async function request(action, payload, index, timeout = 30_000) {
    const response = await fetcher(endpoint, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(timeout), headers: { "cf-access-token": token, "content-type": "application/json" },
      body: JSON.stringify({ target, sourceDigest, action, payload }) });
    if (!response.ok) throw new Error(`import_${action}${index === undefined ? "" : `[${index}]`}: HTTP ${response.status}`);
    return response.json();
  }
  return { endpoint, request };
}

/** 取込を終えたサイトの公開版を、次の全ページ公開の対象にします。公開はしません。 */
export async function finalizeKamakuraSiteImport(prepared, origin, token, fetcher = fetch) {
  const { request } = importClient(prepared, origin, token, fetcher);
  const planDigest = await siteImportDigest(prepared.plan);
  const receipt = await request("finalize", {}, undefined, 90_000);
  if (receipt.status !== "finalized" || receipt.siteId !== prepared.target.siteId || receipt.sourceDigest !== prepared.sourceDigest
    || receipt.planDigest !== planDigest || receipt.publishedPages !== prepared.pages.filter((page) => page.published).length) {
    throw new Error("invalid_finalize_receipt");
  }
  return receipt;
}

export async function applyKamakuraSiteImport(prepared, origin, token, fetcher = fetch, loadAsset) {
  const { endpoint, request } = importClient(prepared, origin, token, fetcher);
  const { target, sourceDigest, plan, pages, cmsItems, mapping } = prepared;
  const originals = originalAssets(plan);
  async function original(digest, length) {
    if (!loadAsset) throw new Error("source_asset_directory_required");
    const bytes = await loadAsset(digest, length);
    if (bytes.byteLength !== length || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("source_asset_checksum_mismatch");
    return bytes;
  }
  for (const [digest, length] of originals) await original(digest, length);
  const started = await request("begin", plan);
  if (started.status !== "prepared" || started.siteId !== target.siteId || started.sourceDigest !== sourceDigest
    || started.planDigest !== await siteImportDigest(plan)) throw new Error("invalid_import_receipt");
  for (const [digest, length] of originals) {
    const response = await fetcher(`${endpoint}/${digest}`, { method: "PUT", redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(90_000), headers: { "cf-access-token": token, "content-type": "application/octet-stream",
        "x-import-project": target.projectId, "x-import-verification-origin": target.verificationOrigin, "x-import-source-digest": sourceDigest },
      body: await original(digest, length) });
    if (!response.ok) throw new Error(`import_asset: HTTP ${response.status}`);
    const receipt = await response.json();
    if (receipt.status !== "imported" || receipt.contentSha256 !== digest) throw new Error("invalid_asset_receipt");
  }
  const pageReceipts = [], itemReceipts = [];
  for (const [index, page] of pages.entries()) {
    const item = await request("page", page, index);
    const expected = mapping.pages[index];
    if (item.sourceUrl !== expected.sourceUrl || item.pageId !== expected.pageId || item.locale !== expected.locale || item.path !== expected.path) {
      throw new Error("invalid_page_receipt");
    }
    if (page.deferred) {
      if (item.status !== "deferred" || item.reason !== expected.deferred) throw new Error("invalid_page_receipt");
      pageReceipts.push(expected);
      continue;
    }
    if (item.status !== "imported" || item.draftRevision !== page.draft.revision || item.publishedRevision !== (page.published?.revision ?? null)) {
      throw new Error("invalid_page_receipt");
    }
    const { version, draftRevision, publishedRevision } = item;
    pageReceipts.push({ ...expected, version, draftRevision, publishedRevision });
  }
  for (const [index, item] of cmsItems.entries()) {
    const received = await request("cms", item, index);
    const expected = mapping.cmsItems[index];
    if (received.status !== "imported" || received.collectionId !== expected.collectionId || received.sourceItemId !== expected.sourceItemId
      || received.itemId !== expected.itemId || typeof received.draftRevision !== "string"
      || (item.published === null ? received.publishedRevision !== null : typeof received.publishedRevision !== "string")) throw new Error("invalid_cms_receipt");
    itemReceipts.push({ ...expected, draftRevision: received.draftRevision, publishedRevision: received.publishedRevision,
      ...(item.translations === undefined ? {} : {
        targetLocale: received.targetLocale, publishedLocalizationRevision: received.publishedLocalizationRevision,
        draftLocalizationRevision: received.draftLocalizationRevision
      }) });
  }
  return { status: "imported", target, sourceDigest, planDigest: started.planDigest,
    mapping: { ...mapping, pages: pageReceipts, cmsItems: itemReceipts } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      sha256: { type: "string" }, origin: { type: "string" }, project: { type: "string" }, site: { type: "string" },
      "verification-origin": { type: "string" }, "asset-dir": { type: "string" }, "embed-connections": { type: "string" }, apply: { type: "boolean" },
      finalize: { type: "boolean" }
    } });
    if (positionals.length !== 1 || values.apply && values.finalize
      || !values.apply && !values.finalize && values.origin !== undefined) throw new Error("invalid_arguments");
    if ((await stat(positionals[0])).size > 128 * 1024 * 1024) throw new Error("source_export_too_large");
    const connectionsFile = values["embed-connections"];
    if (connectionsFile && (await stat(connectionsFile)).size > 4 * 1024 * 1024) throw new Error("embed_connections_too_large");
    const connections = connectionsFile ? JSON.parse(await readFile(connectionsFile, "utf8")) : [];
    const prepared = await prepareKamakuraSiteImport(await readFile(positionals[0]), values.sha256, {
      projectId: values.project, siteId: values.site, verificationOrigin: values["verification-origin"]
    }, connections);
    const loadAsset = (digest, length) => readKamakuraImportAsset(values["asset-dir"], digest, length);
    if (!values.apply && !values.finalize) for (const [digest, length] of originalAssets(prepared.plan)) await loadAsset(digest, length);
    const result = values.apply ? await applyKamakuraSiteImport(prepared, values.origin, process.env.NIHO_EDIT_TOKEN, fetch, loadAsset)
      : values.finalize ? await finalizeKamakuraSiteImport(prepared, values.origin, process.env.NIHO_EDIT_TOKEN) : {
      status: "verified", target: prepared.target, sourceDigest: prepared.sourceDigest, planDigest: await siteImportDigest(prepared.plan), mapping: prepared.mapping
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error?.code) console.error("invalid_import_input_or_transport_error");
    else console.error(error instanceof Error ? error.message : "import_failed");
    process.exitCode = 1;
  }
}
