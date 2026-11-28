import { resolvePageDocument } from "./components.js";
import { walkNodes } from "./node-tree.js";
import { assetKey } from "./assets.js";
import { parseCmsPublicAssets } from "./cms-v2-assets.js";
import { collectCmsLocalizationUnits, createCmsLocalizationOverlay, editCmsLocalizedValue, reviewCmsLocalizedValue, STUDIO_CMS_LOCALIZATION_OPTIONS } from "./cms-v2-localization.js";
import { cmsTimestamp } from "./cms-v2-release.js";
import { managedBlockContracts } from "./managed-embed-block.js";
import { parseManagedSiteRedirects } from "./managed-site-redirects.js";
import { cmsArray, cmsId, parseCmsSchema, uniqueCmsKeys, type CmsItemRevision, type CmsSchema } from "./cms-v2-schema.js";
import { isSafeHttpsOrigin, isSafePublicUrl, fail, identifier, keys, localeCode, parseAssetReference, record } from "./validation-utils.js";

export const SITE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const SITE_IMPORT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const SITE_IMPORT_DIGEST = /^[a-f0-9]{64}$/u;
export const SITE_IMPORT_ASSET_PROVIDER = "kamakura-source";

export async function siteImportDigest(value: unknown): Promise<string> {
  const json = JSON.stringify(value, (_key, entry: unknown) => !entry || typeof entry !== "object" || Array.isArray(entry)
    ? entry : Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function siteImportResourceId(prefix: "page" | "item" | "asset", siteId: string, sourceKey: string) {
  return `${prefix === "asset" ? "src" : prefix}_${await siteImportDigest([siteId, prefix, sourceKey])}`;
}

export function importPageUrl(raw: unknown, origin: string, path: string): string {
  if (!isSafePublicUrl(raw) || !raw.startsWith("https://")) fail(path, "expected an absolute source URL");
  const url = new URL(raw);
  if (url.origin !== origin || url.search || url.hash || url.href !== raw) fail(path, "source URL is outside the export origin");
  return raw;
}

export function importPublicAssetUrl(value: unknown, path: string): string {
  if (!isSafePublicUrl(value) || !value.startsWith("https://")) fail(path, "expected a public HTTPS media URL");
  const url = new URL(value);
  if (url.hash || [...url.searchParams.keys()].some((key) => /(?:token|secret|credential|signature|password|^auth$|^key$)/iu.test(key))) {
    fail(path, "media URL includes private parameters");
  }
  return value;
}

export function parseSiteImportPlan(input: unknown, siteId: string) {
  const plan = record(input, "plan");
  keys(plan, ["sourceOrigin", "sourceSiteId", "locale", "assets", "assetVariants", "pages", "cms", "redirects", "scheduled"], "plan");
  const { sourceOrigin } = plan;
  if (!isSafeHttpsOrigin(sourceOrigin)) fail("plan.sourceOrigin", "expected an HTTPS origin");
  const locale = localeCode(plan.locale, "plan.locale"), sourceSiteId = identifier(plan.sourceSiteId, "plan.sourceSiteId");
  if (sourceSiteId === siteId) fail("plan.sourceSiteId", "source and destination sites must differ");
  const digest = (input: unknown, at: string) => {
    if (typeof input !== "string" || !SITE_IMPORT_DIGEST.test(input)) fail(at, "invalid resource digest");
    return input;
  };
  const pages = cmsArray(plan.pages, "plan.pages", 500).map((input, index) => {
    const at = `plan.pages[${index}]`, entry = record(input, at);
    keys(entry, ["sourceUrl", "digest"], at);
    return { sourceUrl: importPageUrl(entry.sourceUrl, sourceOrigin, `${at}.sourceUrl`), digest: digest(entry.digest, `${at}.digest`) };
  });
  uniqueCmsKeys(pages.map(({ sourceUrl }) => sourceUrl), "plan.pages");
  const assets = cmsArray(plan.assets, "plan.assets", 5000).map((input, index) => {
    const at = `plan.assets[${index}]`, entry = record(input, at);
    keys(entry, ["source", "target", "contentSha256", "byteLength", "aliases"], at);
    const { byteLength } = entry;
    if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > SITE_IMPORT_MAX_ASSET_BYTES) {
      fail(at, "invalid original asset size");
    }
    const aliases = cmsArray(entry.aliases, `${at}.aliases`, 5000).map((url) => importPublicAssetUrl(url, `${at}.aliases`));
    return { source: parseAssetReference(entry.source, `${at}.source`), target: entry.target, aliases,
      contentSha256: digest(entry.contentSha256, `${at}.contentSha256`), byteLength };
  });
  uniqueCmsKeys(assets.map(({ source }) => assetKey(source)), "plan.assets");
  const lengths = new Map<string, number>();
  for (const { byteLength, contentSha256 } of assets) {
    if (lengths.has(contentSha256) && lengths.get(contentSha256) !== byteLength) fail("plan.assets", "conflicting size for the same original");
    lengths.set(contentSha256, byteLength);
  }
  const parsedAssets = [...parseCmsPublicAssets(assets.map(({ target }) => target)).values()];
  for (const { url } of parsedAssets) importPublicAssetUrl(url, "plan.assets.url");
  uniqueCmsKeys([...parsedAssets.map(({ url }) => url), ...assets.flatMap(({ aliases }) => aliases)], "plan.assets.aliases");
  if (parsedAssets.some(({ reference }) => reference.provider !== SITE_IMPORT_ASSET_PROVIDER || !/^src_[a-f0-9]{64}$/u.test(reference.id))) {
    fail("plan.assets", "invalid imported asset target");
  }
  const assetVariants = cmsArray(plan.assetVariants, "plan.assetVariants", 10_000).map((input, index) => {
    const at = `plan.assetVariants[${index}]`, entry = record(input, at);
    keys(entry, ["source", "original"], at);
    return { source: parseAssetReference(entry.source, `${at}.source`), original: parseAssetReference(entry.original, `${at}.original`) };
  });
  const assetKeys = new Set(assets.map(({ source }) => assetKey(source)));
  uniqueCmsKeys([...assetKeys, ...assetVariants.map(({ source }) => assetKey(source))], "plan.assetVariants");
  if (assetVariants.some(({ original }) => !assetKeys.has(assetKey(original)))) fail("plan.assetVariants", "unknown original asset");
  const redirects = parseManagedSiteRedirects(plan.redirects);
  if (!redirects) fail("plan.redirects", "invalid redirects");
  const cms = plan.cms === null ? null : record(plan.cms, "plan.cms");
  if (cms) keys(cms, ["schema", "items"], "plan.cms");
  const schema = cms && parseCmsSchema(cms.schema);
  if (schema && schema.siteId !== siteId) fail("plan.cms.schema", "target site mismatch");
  const items = cms ? cmsArray(cms.items, "plan.cms.items", 500).map((input, index) => {
    const at = `plan.cms.items[${index}]`, entry = record(input, at);
    keys(entry, ["collectionId", "itemId", "digest"], at);
    return { collectionId: cmsId(entry.collectionId, `${at}.collectionId`), itemId: cmsId(entry.itemId, `${at}.itemId`), digest: digest(entry.digest, `${at}.digest`) };
  }) : [];
  const itemKeys = items.map(({ collectionId, itemId }) => `${collectionId}/${itemId}`);
  uniqueCmsKeys(itemKeys, "plan.cms.items");
  const scheduled = cmsArray(plan.scheduled, "plan.scheduled", 1000).map((input, index) => {
    const at = `plan.scheduled[${index}]`, entry = record(input, at);
    if (entry.kind === "page") {
      keys(entry, ["kind", "sourceUrl", "at"], at);
      const sourceUrl = importPageUrl(entry.sourceUrl, sourceOrigin, `${at}.sourceUrl`);
      if (!pages.some((page) => page.sourceUrl === sourceUrl)) fail(at, "scheduled page is outside the import");
      return { kind: "page" as const, sourceUrl, at: cmsTimestamp(entry.at, `${at}.at`) };
    }
    if (entry.kind !== "cms") fail(at, "unknown scheduled resource");
    keys(entry, ["kind", "collectionId", "itemId", "at"], at);
    const collectionId = cmsId(entry.collectionId, `${at}.collectionId`), itemId = cmsId(entry.itemId, `${at}.itemId`);
    if (!itemKeys.includes(`${collectionId}/${itemId}`)) fail(at, "scheduled CMS item is outside the import");
    return { kind: "cms" as const, collectionId, itemId, at: cmsTimestamp(entry.at, `${at}.at`) };
  });
  return { sourceOrigin, sourceSiteId, locale, pages, assets: assets.map((entry, index) => ({ ...entry, target: parsedAssets[index]! })), assetVariants,
    cms: schema ? { schema, items } : null, redirects, scheduled };
}

export function parseSiteImportTarget(input: unknown) {
  const value = record(input, "target");
  keys(value, ["projectId", "siteId", "verificationOrigin"], "target");
  if (!isSafeHttpsOrigin(value.verificationOrigin)) fail("target.verificationOrigin", "expected an HTTPS origin");
  return {
    projectId: identifier(value.projectId, "target.projectId"), siteId: identifier(value.siteId, "target.siteId"),
    verificationOrigin: value.verificationOrigin
  };
}

export async function buildSiteImportCmsLocalization(schema: CmsSchema, published: CmsItemRevision | null, draft: CmsItemRevision, input: unknown) {
  if (input === undefined) return null;
  const source = record(input, "translations");
  keys(source, ["targetLocale", "published", "draft"], "translations");
  const { targetLocale } = source;
  const family = draft.locale.split("-", 1)[0];
  if (typeof targetLocale !== "string" || targetLocale !== (family === "ja" ? "en" : family === "en" ? "ja" : undefined)) {
    fail("translations.targetLocale", "unsupported Studio translation locale");
  }
  async function overlay(item: CmsItemRevision | null, raw: unknown, path: string) {
    if (raw === null) return null;
    if (!item) fail(path, "translation requires the corresponding source revision");
    const values = record(raw, path);
    const collection = await collectCmsLocalizationUnits(schema, item, targetLocale, STUDIO_CMS_LOCALIZATION_OPTIONS);
    keys(values, collection.fields.map(({ identity }) => identity.fieldId), path);
    let result = createCmsLocalizationOverlay(collection);
    for (const [fieldId, rawField] of Object.entries(values)) {
      const at = `${path}.${fieldId}`, field = record(rawField, at);
      keys(field, ["value", "reviewed"], at);
      if (typeof field.value !== "string" || typeof field.reviewed !== "boolean") fail(at, "invalid translation value");
      result = editCmsLocalizedValue(result, collection, { fieldId, expectedVersion: result.version, value: field.value });
      if (field.reviewed) result = reviewCmsLocalizedValue(result, collection, { fieldId, expectedVersion: result.version });
    }
    return result;
  }
  return { targetLocale, published: await overlay(published, source.published, "translations.published"),
    draft: await overlay(draft, source.draft, "translations.draft") };
}

const DEFERRED_CMS_BLOCKS = new Set(["KamakuraCmsList", "KamakuraCompanyDirectory", "KamakuraRecentArticles", "KamakuraCmsDetail"]);

export function resolveSiteImportSourceVersion(input: unknown, scope: { siteId: string; pageId: string; locale: string }, at: string) {
  const version = record(input, at);
  keys(version, ["document", "sourceBlocks", "sourceComponents", "sourceStyles", "presentation", "replacements", "frameOrigins"], at);
  const document = record(version.document, `${at}.document`);
  if (document.siteId !== scope.siteId || document.pageId !== scope.pageId || document.locale !== scope.locale) fail(at, "source document scope mismatch");
  if (version.sourceComponents !== undefined && record(version.sourceComponents, `${at}.sourceComponents`).siteId !== scope.siteId) {
    fail(at, "component library scope mismatch");
  }
  const blocks = version.sourceBlocks === undefined ? managedBlockContracts : record(version.sourceBlocks, `${at}.sourceBlocks`);
  const resolved = resolvePageDocument(document, version.sourceComponents, blocks as Parameters<typeof resolvePageDocument>[2],
    version.sourceStyles as Parameters<typeof resolvePageDocument>[3]).document;
  const deferredCms = walkNodes(resolved).some(({ node }) => node.type === "component" && DEFERRED_CMS_BLOCKS.has(node.block));
  return { version, resolved, deferredCms };
}
