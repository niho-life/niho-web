import { assetKey, uniqueAssetReferences } from "../src/assets.js";
import { parsePageDocument, type PageDocument, type PageNode } from "../src/core.js";
import { createBlankEmbedRegistry } from "../src/embeds.js";
import { managedVerificationTags, type ManagedSiteSeoSettings } from "../src/managed-seo-settings.js";
import type { SiteStyles } from "../src/site-styles.js";
import { renderPageHead, resolvePageMetadata, validatePagePath, type PageMetadata } from "../src/pages.js";
import type { CmsPublicAsset, CmsReleaseSnapshot } from "../src/cms-v2.js";
import { resolveCmsPageBindings, type CmsPageBindingsDocument } from "../src/cms-page-bindings.js";
import type { CmsStore } from "./managed-cms-store.js";
import { emptyManagedPublicPolicy, managedBlockContracts, parseManagedPublicPolicy, type ManagedPublicPolicy } from "./managed-embed-contract.js";
import { readPageSource, type PageSourceRow } from "./managed-page-source.js";
import { managedPublicBlocks, planManagedPublicRender, resolvePublishedEmbeds } from "./managed-public-policy.js";
import { readManagedPublishedSiteStyles, readManagedSiteStyles } from "./managed-site-styles.js";
import { kamakuraImageUrl } from "./kamakura-public-images.js";
import { loadPublishedSiteManifest, preparePublishedSiteBatch, type PublishedRouteInput } from "./managed-publication.js";
import type { ManagedSiteRedirect } from "../src/managed-site-redirects.js";
import { inspectManagedHtmlSeo } from "../src/managed-html-seo-checks.js";
import type { EditorReleaseWarning } from "../src/editor-types.js";
import type { ManagedD1 } from "./managed-sites.js";

function prefixedNodes(nodes: readonly PageNode[], prefix: string): PageNode[] {
  return nodes.map((node): PageNode => {
    if (node.type !== "element") return node;
    const attrs = node.attrs && { ...node.attrs };
    if (attrs) {
      for (const name of ["href", "src", "srcSet", "poster"] as const) {
        const value = attrs[name];
        if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) attrs[name] = `${prefix}${value}`;
      }
    }
    return { ...node, ...(attrs ? { attrs } : {}), children: prefixedNodes(node.children, prefix) };
  });
}
function prefixedDocument(document: PageDocument, prefix: string, siteStyles?: SiteStyles): PageDocument {
  const meta = document.meta && structuredClone(document.meta);
  const copy = { ...document, ...(meta ? { meta } : {}), body: prefixedNodes(document.body, prefix) };
  if (copy.meta?.favicon?.startsWith("/") && !copy.meta.favicon.startsWith("//")) copy.meta.favicon = `${prefix}${copy.meta.favicon}`;
  if (copy.meta?.ogImage && "src" in copy.meta.ogImage && copy.meta.ogImage.src.startsWith("/") && !copy.meta.ogImage.src.startsWith("//")) {
    copy.meta.ogImage.src = `${prefix}${copy.meta.ogImage.src}`;
  }
  return parsePageDocument(copy, managedBlockContracts, siteStyles ? { siteStyles } : {});
}
function escapeAttribute(value: string): string { return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
const PUBLIC_SYSTEM_FONT_STYLE = '<style>html{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic","Meiryo",sans-serif}</style>';

function managedSeoImageUrl(value: string, origin: string, prefix: string): string {
  const source = /^https:\/\//iu.test(value) ? value
    : `${origin}${prefix && value.startsWith("/") && value !== prefix && !value.startsWith(`${prefix}/`) ? `${prefix}${value}` : value}`;
  return kamakuraImageUrl(source, 1200);
}

function managedSiteMetadata(metadata: PageMetadata, seo: ManagedSiteSeoSettings, fallbackSiteName: string, origin: string, prefix: string,
  publicUrl: string, forceNoindex = false): PageMetadata {
  const siteName = seo.siteName ?? fallbackSiteName;
  const description = metadata.description ?? seo.description ?? metadata.openGraph.description;
  const image = metadata.openGraph.image ?? (seo.defaultOgImage ? { url: managedSeoImageUrl(seo.defaultOgImage, origin, prefix), alt: siteName } : undefined);
  const noindex = forceNoindex || seo.robotsPolicy === "noindex" || metadata.robots === "noindex, nofollow";
  const { canonical, ...withoutCanonical } = metadata;
  return {
    ...withoutCanonical,
    ...(noindex ? {} : canonical ? { canonical: publicUrl } : {}),
    ...(description ? { description } : {}),
    robots: noindex ? "noindex, nofollow" : "index, follow",
    openGraph: { ...metadata.openGraph, ...(description ? { description } : {}), siteName, url: publicUrl, ...(image ? { image } : {}) }
  };
}

function managedStructuredData(document: PageDocument, publicUrl: string, origin: string, fallbackSiteName: string, seo = emptyManagedPublicPolicy().seo): string {
  const siteName = seo.siteName ?? fallbackSiteName;
  const graph: Record<string, unknown>[] = [
    { "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/`, name: siteName, inLanguage: document.locale, ...(seo.description ? { description: seo.description } : {}) },
    { "@type": "WebPage", "@id": `${publicUrl}#webpage`, url: publicUrl, name: document.title,
      inLanguage: document.locale, isPartOf: { "@id": `${origin}/#website` }, ...((document.meta?.description ?? seo.description) ? { description: document.meta?.description ?? seo.description } : {}) }
  ];
  if (seo.organization) graph.push({ "@type": "Organization", "@id": `${origin}/#organization`, name: seo.organization.name,
    url: seo.organization.url, ...(seo.organization.logo ? { logo: seo.organization.logo } : {}), ...(seo.organization.sameAs.length ? { sameAs: seo.organization.sameAs } : {}) });
  const types: Record<string, string> = { organization: "Organization", localBusiness: "LocalBusiness", website: "WebSite", webPage: "WebPage", article: "Article" };
  for (const id of document.meta?.structuredData ?? []) {
    if (id === "organization" && seo.organization) continue;
    const type = types[id];
    if (type) graph.push({ "@type": type, "@id": `${publicUrl}#${id}`, name: siteName, url: origin,
      ...((document.meta?.description ?? seo.description) ? { description: document.meta?.description ?? seo.description } : {}) });
  }
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
    .replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")}</script>`;
}

export function localizedPathIdentity(locale: string, path: string): string {
  const localePrefix = `/${locale.split("-")[0]!.toLowerCase()}`;
  return path === localePrefix ? "/" : path.startsWith(`${localePrefix}/`) ? path.slice(localePrefix.length) : path;
}

export type ManagedPageAlternate = { readonly pageId: string; readonly locale: string; readonly path: string; readonly noindex?: boolean };

async function managedPageHreflang(db: ManagedD1, siteId: string, locale: string, path: string, origin: string, prefix: string,
  hidden: boolean, store?: CmsStore, candidate?: PageDocument,
  candidatePages?: readonly ManagedPageAlternate[], replacedPages: readonly Pick<ManagedPageAlternate, "pageId" | "locale">[] = []): Promise<string> {
  if (hidden) return "";
  const replaced = new Set(replacedPages.map(({ pageId, locale: pageLocale }) => `${pageId}\u0000${pageLocale}`));
  const alternates: { locale: string; url: string }[] = [];
  const identity = localizedPathIdentity(locale, path);
  if (candidatePages !== undefined) {
    for (const page of candidatePages) {
      if (page.noindex || localizedPathIdentity(page.locale, page.path) !== identity) continue;
      alternates.push({ locale: page.locale.toLowerCase(), url: `${origin}${prefix}${page.path}` });
    }
  } else {
    const siteStyles = store ? await readManagedPublishedSiteStyles(store, siteId) : undefined;
    const result = await db.prepare(`SELECT mp.site_id, mp.page_id, mp.locale, version.revision, publication.published_path AS path,
        version.document_json, version.document_key, version.document_digest FROM managed_pages AS mp
      JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
      JOIN managed_page_versions AS version ON version.site_id = mp.site_id AND version.page_id = mp.page_id
        AND version.locale = mp.locale AND version.revision = mp.published_revision
      WHERE mp.site_id = ?1 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
      ORDER BY mp.locale`).bind(siteId).all<PageSourceRow & { locale: string; path: string }>();
    for (const row of result.results ?? []) {
      if (replaced.has(`${row.page_id}\u0000${row.locale}`)) continue;
      if (localizedPathIdentity(row.locale, row.path) !== identity) continue;
      try {
        const document = await readPageSource(store, row, siteStyles);
        if (!document.meta?.noindex) alternates.push({ locale: row.locale.toLowerCase(), url: `${origin}${prefix}${row.path}` });
      } catch { /* invalid historical documents are omitted from hreflang */ }
    }
  }
  if (candidate && !alternates.some(({ locale: alternateLocale, url }) => alternateLocale === candidate.locale.toLowerCase()
    && url === `${origin}${prefix}${path}`)) alternates.push({ locale: candidate.locale.toLowerCase(), url: `${origin}${prefix}${path}` });
  alternates.sort((first, second) => first.locale.localeCompare(second.locale));
  if (alternates.length < 2) return "";
  const tags = alternates.map(({ locale, url }) => `<link rel="alternate" hreflang="${escapeAttribute(locale)}" href="${escapeAttribute(url)}">`);
  const fallback = alternates.find(({ locale }) => locale === "ja") ?? alternates[0]!;
  tags.push(`<link rel="alternate" hreflang="x-default" href="${escapeAttribute(fallback.url)}">`);
  return tags.join("");
}

/** Shared by the immutable publication writer and the public fallback renderer. */
export async function renderManagedPage(input: {
  readonly db: ManagedD1;
  readonly store?: CmsStore | undefined;
  readonly document: PageDocument;
  readonly policy: ManagedPublicPolicy;
  readonly origin: string;
  readonly prefix: string;
  readonly path: string;
  readonly alternatePath: string;
  readonly publicPath: string;
  readonly siteName: string;
  readonly embeds: Awaited<ReturnType<typeof resolvePublishedEmbeds>>;
  readonly assets?: readonly CmsPublicAsset[];
  readonly siteStyles?: SiteStyles;
  readonly forceNoindex?: boolean;
  readonly includeCandidate?: boolean;
  readonly alternatePages?: readonly ManagedPageAlternate[];
  readonly replacedPages?: readonly Pick<ManagedPageAlternate, "pageId" | "locale">[];
}) {
  const { db, store, document, policy, origin, prefix, path, alternatePath, publicPath, siteName, embeds, forceNoindex } = input;
  const plan = planManagedPublicRender(prefixedDocument(document, prefix, input.siteStyles), policy, origin, embeds, input.assets);
  const rendered = plan.document;
  // Validate the document path before projecting canonical and OpenGraph URLs onto the shared prefix.
  const resolved = resolvePageMetadata({ document: rendered, domain: origin, path, visibility: "public", assets: plan.assets });
  const publicUrl = `${origin}${publicPath}`;
  const metadata = managedSiteMetadata(resolved, policy.seo, siteName, origin, prefix, publicUrl, forceNoindex);
  const [{ renderPageToHtml }, alternates, runtime] = await Promise.all([
    import("../src/server.js"),
    managedPageHreflang(db, document.siteId, document.locale, alternatePath, origin, prefix,
      metadata.robots === "noindex, nofollow", store, input.includeCandidate ? document : undefined,
      input.alternatePages, input.replacedPages),
    plan.head(policy.seo.ga4MeasurementId)
  ]);
  const head = renderPageHead(metadata) + alternates + managedVerificationTags(policy.seo)
    + managedStructuredData(rendered, publicUrl, origin, siteName, policy.seo);
  const body = renderPageToHtml(rendered, managedPublicBlocks, {
    blankEmbeds: createBlankEmbedRegistry({ parentOrigin: origin, entries: [] }), assets: plan.assets,
    imageHints: plan.imageHints,
    ...(input.siteStyles ? { siteStyles: input.siteStyles } : {})
  });
  const html = `<!doctype html><html lang="${escapeAttribute(rendered.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${PUBLIC_SYSTEM_FONT_STYLE}${head}${runtime.scripts}</head><body>${body}</body></html>`;
  return { html, contentSecurityPolicy: runtime.csp, metadata, document: rendered };
}

export type ManagedPagePublicationTarget = {
  readonly siteId: string;
  readonly pageId: string;
  readonly locale: string;
  readonly path: string;
  readonly sourceRevision: number;
  readonly public: boolean;
  readonly bindings?: CmsPageBindingsDocument | null;
  readonly cmsSnapshot?: CmsReleaseSnapshot | null;
  readonly previousPath?: string;
  readonly lastModified?: string;
  readonly readDocument: () => Promise<PageDocument>;
};

const CMS_DETAIL_SLUG = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u;

function publicationPaths(target: ManagedPagePublicationTarget): string[] {
  if (!target.public) return [];
  if (!target.bindings) return [target.path];
  if (!target.cmsSnapshot) return [];
  const bindings = target.bindings;
  const paths: string[] = [];
  if (!bindings.detail) return bindings.lists.length ? [target.path] : [];
  for (const item of target.cmsSnapshot.items) {
    if (item.collectionId !== bindings.detail.collectionId) continue;
    const slug = item.values[bindings.detail.slugFieldId];
    if (typeof slug !== "string" || !CMS_DETAIL_SLUG.test(slug)
      || validatePagePath(`${target.path}/${slug.toLowerCase()}`) !== null) continue;
    paths.push(`${target.path}/${slug}`);
  }
  return paths;
}

export class ManagedPagePublicationError extends Error {
  constructor(readonly url: string, options?: ErrorOptions) {
    super("managed page artifact generation failed", options);
    this.name = "ManagedPagePublicationError";
  }
}

/** Render fixed and CMS pages sequentially, then write one manifest. */
export async function prepareManagedPagePublicationBatch(input: {
  readonly store: CmsStore;
  readonly targets: readonly ManagedPagePublicationTarget[];
  readonly siteId?: string;
  readonly policyMode?: "current" | "published";
  readonly replacePages: readonly Pick<ManagedPageAlternate, "pageId" | "locale">[];
  readonly replaceAll?: boolean;
  readonly expectedVersion?: string;
  readonly activePages?: readonly Pick<ManagedPageAlternate, "pageId" | "locale">[];
  readonly siteStyles?: SiteStyles;
  readonly siteStylesVersion?: string;
  readonly publishSiteStyles?: boolean;
  readonly publicationId: string;
  readonly publicUrl: URL;
  readonly publicPrefix: string;
  readonly additionalRoutes?: AsyncIterable<PublishedRouteInput>;
  readonly additionalPaths?: readonly string[];
  readonly redirects?: readonly ManagedSiteRedirect[];
}) {
  const { store, targets, publicUrl, publicPrefix } = input;
  const siteId = input.siteId ?? targets[0]?.siteId;
  if (!siteId || targets.some((target) => target.siteId !== siteId)) throw new Error("managed publication target scope mismatch");
  const state = await store.db.prepare(`SELECT state.version, state.manifest_key, ms.public_policy_json,
      ms.public_policy_version, ms.public_domain_version, s.name AS site_name
    FROM managed_site_publication_state AS state JOIN managed_sites AS ms ON ms.site_id = state.site_id
    JOIN sites AS s ON s.id = ms.site_id WHERE state.site_id = ?1`)
    .bind(siteId).first<{ version: string; manifest_key: string | null; public_policy_json: string;
      public_policy_version: string; public_domain_version: string; site_name: string }>();
  if (!state) throw new Error("publication state unavailable");
  if (input.expectedVersion !== undefined && state.version !== input.expectedVersion) return null;
  const origin = publicUrl.origin;
  const siteName = state.site_name;
  const styleSnapshot = await readManagedSiteStyles(store, siteId);
  const siteStyles = input.siteStyles ?? styleSnapshot.published.styles;
  const siteStylesVersion = input.siteStylesVersion ?? styleSnapshot.published.version;
  const manifest = await loadPublishedSiteManifest(store.bucket, siteId, state.manifest_key);
  const currentPolicy = parseManagedPublicPolicy(JSON.parse(state.public_policy_json), origin) ?? emptyManagedPublicPolicy();
  const policy = input.policyMode === "published" && manifest?.publicPolicy
    ? parseManagedPublicPolicy(manifest.publicPolicy, origin) ?? currentPolicy : currentPolicy;
  const policyVersion = input.policyMode === "published" ? manifest?.publicPolicyVersion ?? state.public_policy_version : state.public_policy_version;
  const domainVersion = input.policyMode === "published" ? manifest?.publicDomainVersion ?? state.public_domain_version : state.public_domain_version;
  const redirectRows = input.redirects === undefined ? await store.db.prepare(`SELECT locale, from_path AS fromPath, to_path AS toPath
    FROM managed_site_redirects WHERE site_id = ?1 ORDER BY from_path`).bind(siteId).all<ManagedSiteRedirect>() : null;
  if (redirectRows && !redirectRows.success) throw new Error("public redirect lookup failed");

  const replaced = new Set(input.replacePages.map(({ pageId, locale }) => `${pageId}\u0000${locale}`));
  const alternatePages: ManagedPageAlternate[] = (input.replaceAll ? [] : manifest?.routes ?? [])
    .filter((route) => !replaced.has(`${route.pageId}\u0000${route.locale}`))
    .map((route) => ({ pageId: route.pageId, locale: route.locale, path: route.path, ...(route.noindex === undefined ? {} : { noindex: route.noindex }) }));
  for (const target of targets) {
    const paths = publicationPaths(target);
    const previous = manifest?.routes.find((route) => route.pageId === target.pageId
      && route.locale === target.locale && route.sourceRevision === target.sourceRevision);
    const sourceNoindex = policy.seo.robotsPolicy === "noindex" ? true
      : !paths.length ? false
      : previous && manifest?.robotsPolicy !== "noindex" ? previous.noindex === true
      : await target.readDocument().then((document) => document.meta?.noindex === true).catch((error) => {
        throw new ManagedPagePublicationError(`${origin}${publicPrefix}${target.path}`, { cause: error });
      });
    alternatePages.push(...paths.map((path) => ({ pageId: target.pageId, locale: target.locale, path, noindex: sourceNoindex })));
  }

  const redirects = input.redirects ?? redirectRows?.results ?? [];
  const knownPaths = [...alternatePages.map(({ path }) => path), ...(input.additionalPaths ?? []),
    ...redirects.map(({ fromPath }) => fromPath)].map((path) => publicPrefix + path);
  const warnings: EditorReleaseWarning[] = [];
  function inspect(route: PublishedRouteInput) {
    if (warnings.length >= 100) return;
    const pageUrl = origin + publicPrefix + route.path;
    if (!route.description?.trim()) warnings.push({ code: "missing-description", message: "検索結果に出す説明文がありません: " + route.path });
    warnings.push(...inspectManagedHtmlSeo(route.html, { locale: route.locale, pageUrl, knownPaths }));
  }

  let activeUrl = origin + publicPrefix + "/";
  async function* routes(): AsyncGenerator<PublishedRouteInput> {
    for (const target of targets) {
      let document: PageDocument;
      try { document = await target.readDocument(); }
      catch (error) { throw new ManagedPagePublicationError(`${origin}${publicPrefix}${target.path}`, { cause: error }); }
      if (!target.public) continue;
      const bindings = target.bindings ?? null;
      const snapshot = target.cmsSnapshot;
      if (bindings && !snapshot) throw new ManagedPagePublicationError(`${origin}${publicPrefix}${target.path}`);
      for (const path of publicationPaths(target)) {
        activeUrl = `${origin}${publicPrefix}${path}`;
        try {
          const projected = bindings && snapshot
            ? resolveCmsPageBindings(document, bindings, { schema: snapshot.schema, items: snapshot.items }, {
              blocks: managedBlockContracts, page: { siteStyles },
              ...(bindings.detail ? { detail: { slug: path.slice(target.path.length + 1) } } : {})
            })
            : document;
          if (!projected) continue;
          const publicPath = `${publicPrefix}${path}`;
          const embeds = await resolvePublishedEmbeds(store.db, projected, {
            siteId: projected.siteId, pageId: projected.pageId, locale: projected.locale, parentOrigin: origin, publicPath
          }, policy);
          const assets = new Map((await store.migratedPublicAssets(projected.siteId, uniqueAssetReferences(projected)))
            .map((asset) => [assetKey(asset.reference), asset] as const));
          for (const asset of snapshot?.assetManifest ?? []) assets.set(assetKey(asset.reference), asset);
          const canonicalPath = /[A-Z]/u.test(path) ? path.toLowerCase() : path;
          const rendered = await renderManagedPage({ db: store.db, store, document: projected, policy, origin, prefix: publicPrefix,
            path: canonicalPath, alternatePath: path, publicPath, siteName, embeds, assets: [...assets.values()],
            siteStyles, alternatePages, replacedPages: input.replacePages });
          const previousPath = target.previousPath === undefined ? path : target.previousPath + path.slice(target.path.length);
          const previousRoute = manifest?.routes.find((route) => route.pageId === target.pageId && route.locale === target.locale
            && route.path === previousPath && route.sourceRevision === target.sourceRevision);
          const lastModified = !previousRoute || previousRoute.cmsReleaseId === snapshot?.releaseId
            ? previousRoute?.lastModified ?? target.lastModified : undefined;
          const route: PublishedRouteInput = { pageId: target.pageId, locale: target.locale, path, sourceRevision: target.sourceRevision,
            html: rendered.html, contentSecurityPolicy: rendered.contentSecurityPolicy,
            embeds: embeds.map(({ refId, src }) => ({ refId, src: src.href })), title: rendered.document.title,
            description: rendered.metadata.description ?? "",
            noindex: rendered.metadata.robots === "noindex, nofollow",
            ...(lastModified ? { lastModified } : {}), ...(bindings && snapshot ? { caseSensitive: true, sourcePath: target.path, cmsReleaseId: snapshot.releaseId } : {}) };
          inspect(route);
          yield route;
        } catch (error) { throw new ManagedPagePublicationError(activeUrl, { cause: error }); }
      }
    }
    for await (const route of input.additionalRoutes ?? []) {
      activeUrl = origin + publicPrefix + route.path;
      inspect(route);
      yield route;
    }
  }
  let prepared: Awaited<ReturnType<typeof preparePublishedSiteBatch>>;
  try {
    prepared = await preparePublishedSiteBatch({ bucket: store.bucket, siteId, publicationId: input.publicationId,
      expectedVersion: state.version, currentManifestKey: state.manifest_key, replacePages: input.replacePages,
      ...(input.replaceAll ? { replaceAll: true } : {}),
      publicPolicyVersion: policyVersion, publicDomainVersion: domainVersion, publicPolicy: policy,
      siteStylesVersion,
      ...(input.activePages ? { activePages: input.activePages } : {}), routes: routes(), redirects,
      siteName: policy.seo.siteName ?? siteName, siteDescription: policy.seo.description ?? "",
      robotsPolicy: policy.seo.robotsPolicy, publicBaseUrl: `${origin}${publicPrefix}` });
  } catch (error) {
    if (error instanceof ManagedPagePublicationError) throw error;
    throw new ManagedPagePublicationError(activeUrl, { cause: error });
  }
  return { ...prepared, policyVersion, domainVersion, expectedPolicyVersion: state.public_policy_version,
    expectedDomainVersion: state.public_domain_version,
    expectedSiteStyleDraftVersion: styleSnapshot.draft.version,
    expectedSiteStylePublishedVersion: styleSnapshot.published.version,
    siteStylesVersion, publishSiteStyles: input.publishSiteStyles === true,
    warnings: warnings.slice(0, 100) };
}
