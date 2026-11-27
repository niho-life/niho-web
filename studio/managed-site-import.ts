import { assetKey, uniqueAssetReferences } from "../src/assets.js";
import { cmsLocalizationItemKey } from "../src/cms-v2-localization.js";
import { cmsReleaseAssetUses } from "../src/cms-v2-assets.js";
import { cmsArray, cmsCollection, cmsId, cmsItemKey, parseCmsValues, type CmsItemRevision } from "../src/cms-v2-schema.js";
import { parsePageDocument, type PageDocument } from "../src/core.js";
import { buildSiteImportCmsLocalization, importPageUrl, parseSiteImportPlan, parseSiteImportTarget, resolveSiteImportSourceVersion, SITE_IMPORT_DIGEST, siteImportDigest, siteImportResourceId } from "../src/managed-site-import.js";
import { MANAGED_EMBED_REF, managedBlockContracts, parseManagedPublicPolicy, registeredNihoEmbed } from "./managed-embed-contract.js";
import { walkNodes } from "../src/node-tree.js";
import { validatePagePath } from "../src/pages.js";
import { fail, identifier, keys, line, localeCode, record } from "../src/validation-utils.js";
import { blobSize, cmsPathReserved, dateNow, itemBlobKey, localizationBlobKey, MAX_RETAINED_BYTES, migratedAssetManifestKey, type CmsState, type CmsStore } from "./managed-cms-store.js";
import { storePageSource } from "./managed-page-source.js";
import type { ManagedD1 } from "./managed-sites.js";

type Target = ReturnType<typeof parseSiteImportTarget>;
type Plan = ReturnType<typeof parseSiteImportPlan>;
type Run = { site_id: string; source_digest: string; plan_digest: string; actor_subject: string; verification_origin: string; home_version: string; setup_id: string };
type Scope = { db: ManagedD1; store: CmsStore; target: Target; run: Run; plan: Plan };

// Also used inside each committing statement so member, host and publication checks cover races during R2 writes.
const verificationFence = `EXISTS (
  SELECT 1 FROM sites AS site JOIN managed_sites AS managed ON managed.site_id = site.id
  JOIN project_members AS member ON member.project_id = site.project_id
  JOIN managed_site_hosts AS host ON host.site_id = site.id
  JOIN managed_site_publication_state AS publication ON publication.site_id = site.id
  WHERE site.id = ?1 AND site.project_id = ?2 AND member.access_subject = ?3 AND member.role = 'owner'
    AND host.hostname = ?4 AND host.path_prefix = '/s/' || managed.slug AND host.enabled = 1 AND host.noindex = 1
    AND publication.manifest_key IS NULL
    AND NOT EXISTS (SELECT 1 FROM managed_page_publications WHERE site_id = site.id)
    AND NOT EXISTS (SELECT 1 FROM managed_cms_releases WHERE site_id = site.id)
)`;
const planKey = (run: Run) => `sites/${run.site_id}/migration/plans/${run.plan_digest}.json`;
const runFence = `EXISTS (SELECT 1 FROM managed_site_imports WHERE site_id = ?1 AND plan_digest = ?5 AND actor_subject = ?3)`;
const guardValues = ({ target, run }: Scope) => [target.siteId, target.projectId, run.actor_subject, new URL(target.verificationOrigin).hostname, run.plan_digest] as const;
const conflict = () => ({ error: "migration_conflict" });

async function draftVersion(planDigest: string, sourceUrl: string, revision: number): Promise<string> {
  const hash = await siteImportDigest([planDigest, sourceUrl, revision]);
  return `p.${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function begin(db: ManagedD1, store: CmsStore, target: Target, subject: string, sourceDigest: string, value: unknown) {
  const plan = parseSiteImportPlan(value, target.siteId);
  if (new URL(plan.sourceOrigin).hostname === new URL(target.verificationOrigin).hostname) return conflict();
  for (const { source, target: asset } of plan.assets) {
    if (asset.reference.id !== await siteImportResourceId("asset", target.siteId, assetKey(source))) return conflict();
  }
  if (plan.cms && blobSize(plan.cms.schema) > 256 * 1024) return { error: "invalid_import" };
  const values = [target.siteId, target.projectId, subject, new URL(target.verificationOrigin).hostname] as const;
  const planDigest = await siteImportDigest(plan);
  const existing = await db.prepare("SELECT * FROM managed_site_imports WHERE site_id = ?1").bind(target.siteId).first<Run>();
  let run: Run;
  if (existing) {
    if (existing.plan_digest !== planDigest || existing.source_digest !== sourceDigest || existing.actor_subject !== subject
      || existing.verification_origin !== target.verificationOrigin) return conflict();
    run = existing;
  } else {
    const home = await db.prepare(`SELECT current_version FROM managed_pages WHERE site_id = ?1 AND page_id = 'home' AND locale = ?2
      AND path = '/' AND current_revision = 1`).bind(target.siteId, plan.locale).first<{ current_version: string }>();
    if (!home || await store.bucket.get(migratedAssetManifestKey(target.siteId))) return conflict();
    const starter = await store.site({ ...target, actor: { id: subject, cli: true } }, "cms.schema.apply");
    if (!starter || starter.generation !== null) return conflict();
    const state = plan.cms && { ...starter.state, schema: plan.cms.schema };
    const setupId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(`INSERT INTO managed_site_imports (site_id, source_digest, plan_digest, actor_subject, verification_origin, home_version, setup_id)
        SELECT ?1, ?5, ?6, ?3, ?7, ?8, ?10 WHERE ${verificationFence}
          AND (SELECT count(*) FROM managed_pages WHERE site_id = ?1) = 1
          AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND page_id = 'home' AND locale = ?9 AND current_version = ?8)
          AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?1 AND page_catalog_version = 'initial' AND redirect_version = 'initial')
          AND NOT EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM managed_site_redirects WHERE site_id = ?1)
        ON CONFLICT(site_id) DO NOTHING`).bind(...values, sourceDigest, planDigest, target.verificationOrigin, home.current_version, plan.locale, setupId),
      ...(state ? [db.prepare(`INSERT INTO managed_cms_state (site_id, generation, state_json)
        SELECT site_id, ?2, ?3 FROM managed_site_imports WHERE site_id = ?1 AND setup_id = ?4
        ON CONFLICT(site_id) DO NOTHING`).bind(target.siteId, `import_${planDigest}`, JSON.stringify(state), setupId)] : []),
      ...(plan.redirects.length ? [db.prepare(`INSERT INTO managed_site_redirects (site_id, locale, from_path, to_path)
        SELECT ?1, json_extract(value, '$.locale'), json_extract(value, '$.fromPath'), json_extract(value, '$.toPath')
        FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM managed_site_imports WHERE site_id = ?1 AND setup_id = ?3)
        ON CONFLICT(site_id, from_path) DO NOTHING`).bind(target.siteId, JSON.stringify(plan.redirects), setupId),
      db.prepare(`UPDATE managed_sites SET redirect_version = ?2 WHERE site_id = ?1 AND redirect_version = 'initial'
        AND EXISTS (SELECT 1 FROM managed_site_imports WHERE site_id = ?1 AND setup_id = ?3)`)
        .bind(target.siteId, `import_${planDigest}`, setupId)] : [])
    ]);
    if (results.some((result) => !result.success)) throw new Error("migration setup failed");
    if (results[0]?.meta?.changes !== 1) return conflict();
    run = { site_id: target.siteId, source_digest: sourceDigest, plan_digest: planDigest, actor_subject: subject,
      verification_origin: target.verificationOrigin, home_version: home.current_version, setup_id: setupId };
  }
  await store.put(planKey(run), plan);
  if (plan.assets.length) {
    await store.put(migratedAssetManifestKey(target.siteId), { formatVersion: 1, siteId: target.siteId, assets: plan.assets.map(({ target: asset }) => asset) });
  }
  return { status: "prepared", siteId: target.siteId, sourceDigest, planDigest };
}

async function existingReceipt<T>(scope: Scope, kind: "page" | "cms", sourceKey: string) {
  const row = await scope.db.prepare("SELECT receipt_json FROM managed_site_import_resources WHERE site_id = ?1 AND kind = ?2 AND source_key = ?3")
    .bind(scope.target.siteId, kind, sourceKey).first<{ receipt_json: string }>();
  return row ? JSON.parse(row.receipt_json) as T : null;
}

async function archiveDeferredPage(scope: Scope, input: Record<string, unknown>, page: { sourceUrl: string; pageId: string; locale: string; path: string }) {
  if (input.published !== undefined || input.draft !== undefined || input.connections !== undefined) return { error: "invalid_import" };
  const { db, store, target, plan, run } = scope;
  const deferred = record(input.deferred, "page.deferred");
  keys(deferred, ["sourcePageId", "published", "draft"], "page.deferred");
  const pageId = identifier(deferred.sourcePageId, "page.deferred.sourcePageId");
  const sourceScope = { siteId: plan.sourceSiteId, pageId, locale: page.locale };
  const published = deferred.published === null ? null : resolveSiteImportSourceVersion(deferred.published, sourceScope, "page.deferred.published");
  const draft = resolveSiteImportSourceVersion(deferred.draft, sourceScope, "page.deferred.draft");
  if (!published?.deferredCms && !draft.deferredCms) return { error: "invalid_import" };
  const prior = await existingReceipt<{ status: "deferred" }>(scope, "page", page.sourceUrl);
  if (prior) return prior.status === "deferred" ? prior : conflict();
  await store.put(`sites/${target.siteId}/migration/deferred-pages/${run.plan_digest}/${page.pageId}.json`, deferred);
  const receipt = { ...page, status: "deferred", reason: "cms-block-conversion" };
  const result = await db.prepare(`INSERT INTO managed_site_import_resources (site_id, kind, source_key, target_id, receipt_json, transaction_id)
    SELECT ?1, 'page', ?6, ?7, ?8, ?9 WHERE ${verificationFence} AND ${runFence} ON CONFLICT DO NOTHING`)
    .bind(...guardValues(scope), page.sourceUrl, page.pageId, JSON.stringify(receipt), crypto.randomUUID()).all();
  if (!result.success) throw new Error("migration deferred page transaction failed");
  return result.meta?.changes === 1 ? receipt : conflict();
}

async function importPage(scope: Scope, value: unknown) {
  const { db, target, run, plan } = scope;
  const input = record(value, "page");
  keys(input, ["sourceUrl", "path", "locale", "title", "visibility", "published", "draft", "connections", "deferred"], "page");
  const sourceUrl = importPageUrl(input.sourceUrl, plan.sourceOrigin, "page.sourceUrl"), { path, visibility } = input;
  const locale = localeCode(input.locale, "page.locale"), title = line(input.title, "page.title", 120);
  if (typeof path !== "string" || validatePagePath(path) || cmsPathReserved(path) || path === "/" && locale !== plan.locale
    || plan.redirects.some(({ fromPath }) => fromPath === path) || visibility !== "public" && visibility !== "private") return { error: "invalid_import" };
  const digest = await siteImportDigest(input);
  if (!plan.pages.some((page) => page.sourceUrl === sourceUrl && page.digest === digest)) return conflict();
  const pageId = path === "/" ? "home" : await siteImportResourceId("page", target.siteId, sourceUrl);
  if (input.deferred !== undefined) return archiveDeferredPage(scope, input, { sourceUrl, pageId, locale, path });
  const firstRevision = pageId === "home" ? 2 : 1;
  const publishedRevision = input.published === null ? null : firstRevision;
  const draftRevision = publishedRevision === null ? firstRevision : firstRevision + 1;
  const parseDocument = (raw: unknown, revision: number) => {
    const document = parsePageDocument(raw, managedBlockContracts);
    if (document.siteId !== target.siteId || document.pageId !== pageId || document.locale !== locale || document.revision !== revision) {
      fail("page", "document does not belong to the planned target revision");
    }
    const assets = new Set(plan.assets.map(({ target: asset }) => assetKey(asset.reference)));
    if (uniqueAssetReferences(document).some((reference) => !assets.has(assetKey(reference)))) fail("page", "unmapped page asset");
    return document;
  };
  const published = publishedRevision === null ? null : parseDocument(input.published, publishedRevision);
  const draft = parseDocument(input.draft, draftRevision);
  const refs = new Set([draft, ...(published ? [published] : [])].flatMap((document) => walkNodes(document).flatMap(({ node }) =>
    node.type === "component" && node.block === "ManagedEmbed" ? [node.props.refId] : [])));
  const policy = refs.size ? await db.prepare("SELECT slug, public_policy_json, public_policy_version FROM managed_sites WHERE site_id = ?1")
    .bind(target.siteId).first<{ slug: string; public_policy_json: string; public_policy_version: string }>() : null;
  const frameOrigins = policy && parseManagedPublicPolicy(JSON.parse(policy.public_policy_json), target.verificationOrigin)?.frameOrigins;
  const publicPath = policy ? `/s/${policy.slug}${path}` : "";
  const connections = cmsArray(input.connections ?? [], "page.connections", 100).map((raw, index) => {
    const at = `page.connections[${index}]`, entry = record(raw, at);
    keys(entry, ["refId", "src"], at);
    if (typeof entry.refId !== "string" || !MANAGED_EMBED_REF.test(entry.refId) || !refs.delete(entry.refId)) fail(at, "unexpected embed reference");
    const src = registeredNihoEmbed(entry.src, target.verificationOrigin, publicPath);
    if (!src || !frameOrigins?.includes(src.origin)) fail(at, "embed connection is outside the configured verification scope");
    return { refId: entry.refId, src: src.href };
  });
  if (refs.size) return { error: "invalid_import" };
  const prior = await existingReceipt<{ version: string }>(scope, "page", sourceUrl);
  if (prior) {
    const current = await db.prepare("SELECT current_version FROM managed_pages WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3")
      .bind(target.siteId, pageId, locale).first<{ current_version: string }>();
    return current?.current_version === prior.version ? prior : conflict();
  }
  const version = await draftVersion(run.plan_digest, sourceUrl, draftRevision), transaction = crypto.randomUUID(), documents: { document: PageDocument; version: string }[] = [
    ...(published ? [{ document: published, version: await draftVersion(run.plan_digest, sourceUrl, published.revision) }] : []), { document: draft, version }
  ];
  const sources = [];
  for (const entry of documents) {
    const source = await storePageSource(scope.store.bucket, entry.document, entry.version);
    if (!source) return { error: "invalid_import" };
    sources.push({ revision: entry.document.revision, ...source });
  }
  const receipt = { status: "imported", sourceUrl, pageId, locale, path, version, publishedRevision, draftRevision };
  const receiptFence = "EXISTS (SELECT 1 FROM managed_site_import_resources WHERE site_id = ?1 AND kind = 'page' AND source_key = ?2 AND transaction_id = ?3)";
  const results = await db.batch([
    db.prepare(`INSERT INTO managed_site_import_resources (site_id, kind, source_key, target_id, receipt_json, transaction_id)
      SELECT ?1, 'page', ?6, ?7, ?8, ?12 WHERE ${verificationFence} AND ${runFence}
        AND (?13 IS NULL OR EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?1 AND public_policy_version = ?13))
        AND NOT EXISTS (SELECT 1 FROM managed_embed_connections WHERE site_id = ?1 AND ref_id IN (SELECT value FROM json_each(?14)))
        AND ((?7 = 'home' AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND page_id = ?7 AND locale = ?9 AND current_version = ?11))
          OR (?7 <> 'home' AND NOT EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND (page_id = ?7 OR path = ?10))))
      ON CONFLICT DO NOTHING`).bind(...guardValues(scope), sourceUrl, pageId, JSON.stringify(receipt), locale, path, run.home_version, transaction, policy?.public_policy_version ?? null,
        JSON.stringify(connections.map(({ refId }) => refId))),
    ...(pageId === "home" ? [db.prepare(`UPDATE managed_pages SET title = ?4, visibility = ?5, current_revision = ?6, current_version = ?8, updated_at = unixepoch()
      WHERE site_id = ?1 AND page_id = 'home' AND locale = ?7 AND ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, title, visibility, draftRevision, locale, version)] : [db.prepare(`INSERT INTO managed_pages
      (site_id, page_id, locale, title, path, visibility, current_version, current_revision)
      SELECT ?1, ?4, ?5, ?6, ?7, ?8, ?10, ?9 WHERE ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, pageId, locale, title, path, visibility, draftRevision, version)]),
    ...(connections.length ? [db.prepare(`INSERT INTO managed_embed_connections (site_id, page_id, locale, ref_id, parent_origin, public_path, src)
      SELECT ?1, ?4, ?5, json_extract(value, '$.refId'), ?6, ?7, json_extract(value, '$.src')
      FROM json_each(?8) WHERE ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, pageId, locale, target.verificationOrigin, publicPath, JSON.stringify(connections))] : []),
    ...sources.map(({ revision, key, digest, linkIndex }) => db.prepare(`INSERT INTO managed_page_versions
      (site_id, page_id, locale, revision, document_json, kind, created_by_subject, document_key, document_digest, link_index_json)
      SELECT ?1, ?4, ?5, ?6, '{}', 'initial', ?7, ?8, ?9, ?10 WHERE ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, pageId, locale, revision, run.actor_subject, key, digest, linkIndex)),
    ...(pageId === "home" ? [db.prepare(`DELETE FROM managed_page_versions WHERE site_id = ?1 AND page_id = 'home' AND locale = ?4 AND revision = 1 AND ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, locale)] : []),
    db.prepare(`UPDATE managed_sites SET page_catalog_version = ?4 WHERE site_id = ?1 AND ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, `catalog.${version}`),
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
      SELECT ?4, ?5, ?1, ?6, 'page.saved', ?7 WHERE ${receiptFence}`)
      .bind(target.siteId, sourceUrl, transaction, crypto.randomUUID(), target.projectId, run.actor_subject, pageId)
  ]);
  if (results.some((result) => !result.success)) throw new Error("migration page transaction failed");
  return results[0]?.meta?.changes === 1 ? receipt : conflict();
}

async function importCmsItem(scope: Scope, value: unknown) {
  const { db, store, target, run, plan } = scope;
  if (!plan.cms) return conflict();
  const input = record(value, "item");
  keys(input, ["collectionId", "itemId", "published", "draft", "translations"], "item");
  const collectionId = cmsId(input.collectionId, "item.collectionId"), sourceItemId = cmsId(input.itemId, "item.itemId");
  const sourceKey = cmsItemKey({ collectionId, itemId: sourceItemId });
  const digest = await siteImportDigest(input);
  if (!plan.cms.items.some((item) => cmsItemKey(item) === sourceKey && item.digest === digest)) return conflict();
  const itemId = await siteImportResourceId("item", target.siteId, sourceKey), itemKey = cmsItemKey({ collectionId, itemId });
  const site = await store.site({ ...target, actor: { id: run.actor_subject, cli: true } }, "cms.schema.apply");
  if (!site || await siteImportDigest(site.state.schema) !== await siteImportDigest(plan.cms.schema)) return conflict();
  const localizationKey = cmsLocalizationItemKey(collectionId, itemId);
  const prior = await existingReceipt<{ draftRevision: string; draftLocalizationRevision?: string | null }>(scope, "cms", sourceKey);
  if (prior) return site.state.items[itemKey]?.revision === prior.draftRevision && site.state.items[itemKey]?.removedAt === null
    && (prior.draftLocalizationRevision ?? null) === (site.state.localizations?.[localizationKey]?.revision ?? null) ? prior : conflict();
  if (site.state.items[itemKey] || Object.keys(site.state.items).length >= 500) return conflict();
  const collection = cmsCollection(plan.cms.schema, collectionId);
  const makeRevision = (raw: unknown, version: "published" | "draft"): CmsItemRevision => ({
    siteId: target.siteId, schemaRevision: plan.cms!.schema.schemaRevision, collectionId, itemId, locale: plan.locale,
    revision: `rev_${version}_${digest}_${itemId.slice(5, 36)}`, values: parseCmsValues(raw, collection)
  });
  const published = input.published === null ? null : makeRevision(input.published, "published");
  const draft = makeRevision(input.draft, "draft"), revisions = [...(published ? [published] : []), draft];
  const assets = new Set(plan.assets.map(({ target: asset }) => assetKey(asset.reference)));
  for (const { reference } of cmsReleaseAssetUses(plan.cms.schema, revisions)) {
    if (reference === null || !assets.has(assetKey(reference))) return { error: "invalid_import" };
  }
  const translation = await buildSiteImportCmsLocalization(plan.cms.schema, published, draft, input.translations);
  const publishedLocalizationRevision = translation?.published && published ? published.revision : null;
  const draftLocalizationRevision = translation?.draft ? draft.revision : null;
  const retainedBytes = site.state.retainedBytes + revisions.reduce((total, revision) => total + blobSize(revision), 0)
    + (translation?.published ? blobSize(translation.published) : 0) + (translation?.draft ? blobSize(translation.draft) : 0);
  if (retainedBytes > MAX_RETAINED_BYTES) return conflict();
  for (const revision of revisions) await store.put(itemBlobKey(target.siteId, plan.locale, revision), revision);
  if (translation?.published && publishedLocalizationRevision) await store.put(localizationBlobKey(target.siteId, translation.targetLocale,
    localizationKey, publishedLocalizationRevision), translation.published);
  if (translation?.draft && draftLocalizationRevision) await store.put(localizationBlobKey(target.siteId, translation.targetLocale,
    localizationKey, draftLocalizationRevision), translation.draft);
  const state: CmsState = { ...site.state, retainedBytes, items: { ...site.state.items,
    [itemKey]: { collectionId, itemId, revision: draft.revision, updatedAt: dateNow(), removedAt: null }
  }, ...(translation?.draft && draftLocalizationRevision ? { localizations: { ...site.state.localizations,
    [localizationKey]: { revision: draftLocalizationRevision, version: translation.draft.version }
  } } : {}) };
  const receipt = { status: "imported", collectionId, sourceItemId, itemId, publishedRevision: published?.revision ?? null, draftRevision: draft.revision,
    ...(translation ? { targetLocale: translation.targetLocale, publishedLocalizationRevision, draftLocalizationRevision } : {}) };
  const generation = crypto.randomUUID();
  const receiptFence = "EXISTS (SELECT 1 FROM managed_site_import_resources WHERE site_id = ?1 AND kind = 'cms' AND source_key = ?2)";
  const stateFence = `EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = ?1 AND generation = ?2)`;
  const results = await db.batch([
    db.prepare(`UPDATE managed_cms_state SET generation = ?8, state_json = ?9
      WHERE site_id = ?1 AND generation = ?6 AND ${verificationFence} AND ${runFence}
        AND NOT EXISTS (SELECT 1 FROM managed_site_import_resources WHERE site_id = ?1 AND kind = 'cms' AND source_key = ?7)`)
      .bind(...guardValues(scope), site.generation, sourceKey, generation, JSON.stringify(state)),
    db.prepare(`INSERT INTO managed_site_import_resources (site_id, kind, source_key, target_id, receipt_json, transaction_id)
      SELECT ?1, 'cms', ?3, ?4, ?5, ?2 WHERE ${stateFence}`).bind(target.siteId, generation, sourceKey, itemId, JSON.stringify(receipt)),
    ...revisions.map((revision) => db.prepare(`INSERT INTO managed_cms_revisions (site_id, revision, collection_id, item_id, locale, schema_revision)
      SELECT ?1, ?3, ?4, ?5, ?6, ?7 WHERE ${receiptFence} AND EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = ?1 AND generation = ?8)`)
      .bind(target.siteId, sourceKey, revision.revision, collectionId, itemId, plan.locale, revision.schemaRevision, generation)),
    db.prepare(`INSERT INTO managed_cms_audit (id, site_id, actor_id, operation) SELECT ?2, ?1, ?3, 'cms.migration-import' WHERE ${stateFence}`)
      .bind(target.siteId, generation, run.actor_subject)
  ]);
  if (results.some((result) => !result.success)) throw new Error("migration CMS transaction failed");
  return results[0]?.meta?.changes === 1 ? receipt : conflict();
}

async function verifiedTarget(store: CmsStore, siteId: string, projectId: string, subject: string, previewOrigin: string | null, target: Target) {
  if (!previewOrigin || target.verificationOrigin !== previewOrigin || target.siteId !== siteId || target.projectId !== projectId) return false;
  return !!await store.db.prepare(`SELECT 1 AS allowed WHERE ${verificationFence}`)
    .bind(siteId, projectId, subject, new URL(previewOrigin).hostname).first<{ allowed: number }>();
}

async function importScope(store: CmsStore, target: Target, subject: string, sourceDigest: string): Promise<Scope | null> {
  const { db } = store, { siteId, verificationOrigin } = target;
  const run = await db.prepare("SELECT * FROM managed_site_imports WHERE site_id = ?1").bind(siteId).first<Run>();
  if (!run || run.source_digest !== sourceDigest || run.actor_subject !== subject || run.verification_origin !== verificationOrigin) return null;
  const object = await store.bucket.get(planKey(run));
  if (!object) return null;
  const plan = parseSiteImportPlan(await object.json(), siteId);
  if (await siteImportDigest(plan) !== run.plan_digest) return null;
  return { db, store, target, run, plan };
}

export async function managedSiteImportAsset(store: CmsStore, siteId: string, projectId: string, subject: string,
  previewOrigin: string | null, request: Request, contentDigest: string) {
  let target: Target;
  try {
    target = parseSiteImportTarget({ projectId: request.headers.get("X-Import-Project"), siteId,
      verificationOrigin: request.headers.get("X-Import-Verification-Origin") });
  } catch { return { error: "invalid_import" }; }
  const sourceDigest = request.headers.get("X-Import-Source-Digest");
  if (!sourceDigest || !SITE_IMPORT_DIGEST.test(sourceDigest) || request.headers.get("Content-Type") !== "application/octet-stream") {
    return { error: "invalid_import" };
  }
  if (!await verifiedTarget(store, siteId, projectId, subject, previewOrigin, target)) return { error: "verification_target_required" };
  const scope = await importScope(store, target, subject, sourceDigest);
  const asset = scope?.plan.assets.find(({ contentSha256 }) => contentSha256 === contentDigest);
  if (!scope || !asset) return conflict();
  const expectedLength = request.headers.get("Content-Length"), reader = request.body?.getReader();
  if (!reader || expectedLength !== null && expectedLength !== String(asset.byteLength)) return { error: "invalid_import" };
  const bytes = new Uint8Array(asset.byteLength);
  let offset = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength > bytes.length - offset) { await reader.cancel(); return { error: "invalid_import" }; }
    bytes.set(chunk.value, offset);
    offset += chunk.value.byteLength;
  }
  const sha256 = async (source: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (offset !== bytes.length || await sha256(bytes.buffer) !== contentDigest) return { error: "invalid_import" };
  const key = `sites/${siteId}/migration/assets/${contentDigest}`;
  const existing = await store.db.prepare("SELECT 1 AS found FROM managed_site_import_asset_blobs WHERE site_id = ?1 AND content_digest = ?2")
    .bind(siteId, contentDigest).first<{ found: number }>();
  if (existing || await store.bucket.put(key, bytes.buffer, { onlyIf: new Headers({ "If-None-Match": "*" }) }) === null) {
    const prior = await store.bucket.get(key);
    if (!prior || await sha256(await prior.arrayBuffer()) !== contentDigest) return conflict();
  }
  if (!existing) {
    const result = await store.db.prepare(`INSERT INTO managed_site_import_asset_blobs (site_id, content_digest)
      SELECT ?1, ?6 WHERE ${verificationFence} AND ${runFence} ON CONFLICT DO NOTHING`)
      .bind(...guardValues(scope), contentDigest).all();
    if (!result.success) throw new Error("migration asset transaction failed");
    if (result.meta?.changes !== 1 && !await verifiedTarget(store, siteId, projectId, subject, previewOrigin, target)) return conflict();
  }
  return { status: "imported", contentSha256: contentDigest };
}

export async function managedSiteImport(store: CmsStore, siteId: string, projectId: string, subject: string,
  previewOrigin: string | null, body: Record<string, unknown>) {
  const { db } = store;
  let target: Target;
  try {
    keys(body, ["target", "sourceDigest", "action", "payload"], "import");
    target = parseSiteImportTarget(body.target);
    if (typeof body.sourceDigest !== "string" || !SITE_IMPORT_DIGEST.test(body.sourceDigest)) return { error: "invalid_import" };
  } catch { return { error: "invalid_import" }; }
  if (!await verifiedTarget(store, siteId, projectId, subject, previewOrigin, target)) return { error: "verification_target_required" };
  if (body.action === "begin") return begin(db, store, target, subject, body.sourceDigest, body.payload);
  if (body.action !== "page" && body.action !== "cms") return { error: "invalid_import" };
  const scope = await importScope(store, target, subject, body.sourceDigest);
  if (!scope) return conflict();
  const { plan } = scope;
  if (plan.assets.length) {
    const count = await db.prepare("SELECT count(*) AS count FROM managed_site_import_asset_blobs WHERE site_id = ?1")
      .bind(siteId).first<{ count: number }>();
    if (count?.count !== new Set(plan.assets.map(({ contentSha256 }) => contentSha256)).size) return conflict();
    const assets = await store.bucket.get(migratedAssetManifestKey(siteId));
    if (!assets || await siteImportDigest(await assets.json()) !== await siteImportDigest({ formatVersion: 1, siteId, assets: plan.assets.map(({ target }) => target) })) return conflict();
  }
  return body.action === "page" ? importPage(scope, body.payload) : importCmsItem(scope, body.payload);
}
