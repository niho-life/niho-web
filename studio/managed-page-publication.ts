import { uniqueAssetReferences } from "../src/assets.js";
import { parsePageDocument, type PageDocument, type PageNode } from "../src/core.js";
import { createBlankEmbedRegistry } from "../src/embeds.js";
import { managedVerificationTags, type ManagedSiteSeoSettings } from "../src/managed-seo-settings.js";
import type { SiteStyles } from "../src/site-styles.js";
import { renderPageHead, resolvePageMetadata, type PageMetadata } from "../src/pages.js";
import type { CmsPublicAsset } from "../src/cms-v2.js";
import type { CmsStore } from "./managed-cms-store.js";
import { emptyManagedPublicPolicy, managedBlockContracts, parseManagedPublicPolicy, type ManagedPublicPolicy } from "./managed-embed-contract.js";
import { readPageSource, type PageSourceRow } from "./managed-page-source.js";
import { managedPublicBlocks, planManagedPublicRender, resolvePublishedEmbeds } from "./managed-public-policy.js";
import { readManagedPublishedSiteStyles } from "./managed-site-styles.js";
import { kamakuraImageUrl } from "./kamakura-public-images.js";
import { preparePublishedManifest, preparePublishedSite } from "./managed-publication.js";
import type { ManagedSiteRedirect } from "../src/managed-site-redirects.js";
import type { ManagedD1 } from "./managed-sites.js";

function prefixedNodes(nodes: readonly PageNode[], prefix: string): PageNode[] {
  return nodes.map((node): PageNode => {
    if (node.type !== "element") return structuredClone(node);
    const copy = structuredClone(node), attrs = copy.attrs;
    if (attrs) {
      for (const name of ["href", "src", "srcSet", "poster"] as const) {
        const value = attrs[name];
        if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) attrs[name] = `${prefix}${value}`;
      }
    }
    copy.children = prefixedNodes(copy.children, prefix);
    return copy;
  });
}
function prefixedDocument(document: PageDocument, prefix: string, siteStyles?: SiteStyles): PageDocument {
  const copy = structuredClone(document);
  copy.body = prefixedNodes(copy.body, prefix);
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

async function managedPageHreflang(db: ManagedD1, siteId: string, locale: string, path: string, origin: string, prefix: string, hidden: boolean, store?: CmsStore, candidate?: PageDocument): Promise<string> {
  if (hidden) return "";
  const siteStyles = store ? await readManagedPublishedSiteStyles(store, siteId) : undefined;
  const result = await db.prepare(`SELECT mp.site_id, mp.page_id, mp.locale, version.revision, publication.published_path AS path,
      version.document_json, version.document_key, version.document_digest FROM managed_pages AS mp
    JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
    JOIN managed_page_versions AS version ON version.site_id = mp.site_id AND version.page_id = mp.page_id
      AND version.locale = mp.locale AND version.revision = mp.published_revision
    WHERE mp.site_id = ?1 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
    ORDER BY mp.locale`).bind(siteId).all<PageSourceRow & { locale: string; path: string }>();
  const alternates: { locale: string; url: string }[] = [];
  for (const row of result.results ?? []) {
    if (candidate && row.page_id === candidate.pageId && row.locale === candidate.locale) continue;
    if (localizedPathIdentity(row.locale, row.path) !== localizedPathIdentity(locale, path)) continue;
    try {
      const document = await readPageSource(store, row, siteStyles);
      if (!document.meta?.noindex) alternates.push({ locale: row.locale.toLowerCase(), url: `${origin}${prefix}${row.path}` });
    } catch { /* invalid historical documents are omitted from hreflang */ }
  }
  if (candidate) alternates.push({ locale: candidate.locale.toLowerCase(), url: `${origin}${prefix}${path}` });
  alternates.sort((first, second) => first.locale.localeCompare(second.locale));
  if (alternates.length < 2) return "";
  const tags = alternates.map(({ locale, url }) => `<link rel="alternate" hreflang="${escapeAttribute(locale)}" href="${escapeAttribute(url)}">`);
  const fallback = alternates.find(({ locale }) => locale === "ja") ?? alternates[0]!;
  tags.push(`<link rel="alternate" hreflang="x-default" href="${escapeAttribute(fallback.url)}">`);
  return tags.join("");
}

export function pageText(nodes: readonly PageNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.text : node.type === "element" ? pageText(node.children) : "").join(" ").replace(/\s+/gu, " ").trim();
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
      metadata.robots === "noindex, nofollow", store, input.includeCandidate ? document : undefined),
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

export async function prepareManagedPageArtifact(input: {
  readonly store: CmsStore;
  readonly document: PageDocument;
  readonly publicationId: string;
  readonly path: string;
  readonly isPublic: boolean;
  readonly publicUrl: URL;
  readonly publicPrefix: string;
  readonly redirects?: readonly ManagedSiteRedirect[];
}) {
  const { store, document, path, publicUrl, publicPrefix } = input;
  const state = await store.db.prepare(`SELECT state.version, state.manifest_key, ms.public_policy_json,
      ms.public_policy_version, ms.public_domain_version, s.name AS site_name
    FROM managed_site_publication_state AS state JOIN managed_sites AS ms ON ms.site_id = state.site_id
    JOIN sites AS s ON s.id = ms.site_id WHERE state.site_id = ?1`)
    .bind(document.siteId).first<{ version: string; manifest_key: string | null; public_policy_json: string;
      public_policy_version: string; public_domain_version: string; site_name: string }>();
  if (!state) throw new Error("publication state unavailable");
  const origin = publicUrl.origin, publicPath = publicUrl.pathname;
  const policy = parseManagedPublicPolicy(JSON.parse(state.public_policy_json), origin) ?? emptyManagedPublicPolicy();
  const siteStyles = await readManagedPublishedSiteStyles(store, document.siteId);
  const embeds = await resolvePublishedEmbeds(store.db, document, {
    siteId: document.siteId, pageId: document.pageId, locale: document.locale, parentOrigin: origin, publicPath
  }, policy);
  const rendered = await renderManagedPage({
    db: store.db, store, document, policy, origin, prefix: publicPrefix, path, alternatePath: path, publicPath,
    siteName: state.site_name, embeds, siteStyles, assets: await store.migratedPublicAssets(document.siteId, uniqueAssetReferences(document)),
    includeCandidate: input.isPublic
  });
  const activeRoutes = await store.db.prepare(`SELECT page_id, locale FROM managed_pages
    WHERE site_id = ?1 AND visibility = 'public' AND published_revision IS NOT NULL`)
    .bind(document.siteId).all<{ page_id: string; locale: string }>();
  if (!activeRoutes.success) throw new Error("public route lookup failed");
  const redirectRows = input.redirects === undefined ? await store.db.prepare(`SELECT locale, from_path AS fromPath, to_path AS toPath
    FROM managed_site_redirects WHERE site_id = ?1 ORDER BY from_path`).bind(document.siteId).all<ManagedSiteRedirect>() : null;
  if (redirectRows && !redirectRows.success) throw new Error("public redirect lookup failed");
  const activeRouteKeys = (activeRoutes.results ?? []).filter(({ page_id, locale }) => page_id !== document.pageId || locale !== document.locale)
    .map(({ page_id, locale }) => ({ pageId: page_id, locale }));
  if (input.isPublic) activeRouteKeys.push({ pageId: document.pageId, locale: document.locale });
  const prepared = await preparePublishedSite({ bucket: store.bucket, siteId: document.siteId, publicationId: input.publicationId,
    pageId: document.pageId, locale: document.locale, path, sourceRevision: document.revision, html: rendered.html,
    contentSecurityPolicy: rendered.contentSecurityPolicy, embeds: embeds.map(({ refId, src }) => ({ refId, src: src.href })),
    title: rendered.document.title, description: rendered.metadata.description ?? "",
    text: pageText(rendered.document.body).slice(0, 40_000).replace(/[\uD800-\uDBFF]$/u, ""),
    noindex: rendered.metadata.robots === "noindex, nofollow", isPublic: input.isPublic, activeRouteKeys,
    redirects: input.redirects ?? redirectRows?.results ?? [],
    siteName: policy.seo.siteName ?? state.site_name, siteDescription: policy.seo.description ?? "",
    robotsPolicy: policy.seo.robotsPolicy, publicBaseUrl: `${origin}${publicPrefix}`,
    expectedVersion: state.version, currentManifestKey: state.manifest_key });
  return { ...prepared, policyVersion: state.public_policy_version, domainVersion: state.public_domain_version };
}

/** CMS binding へ切り替えたページの旧固定 route を、artifact を作らず manifest から除く。 */
export async function prepareManagedPageManifestRemoval(input: {
  readonly store: CmsStore;
  readonly siteId: string;
  readonly pageId: string;
  readonly locale: string;
  readonly publicBaseUrl: string;
}) {
  const state = await input.store.db.prepare(`SELECT state.version, state.manifest_key,
      ms.public_policy_version, ms.public_domain_version
    FROM managed_site_publication_state AS state JOIN managed_sites AS ms ON ms.site_id = state.site_id
    WHERE state.site_id = ?1`)
    .bind(input.siteId).first<{ version: string; manifest_key: string | null; public_policy_version: string; public_domain_version: string }>();
  if (!state) throw new Error("publication state unavailable");
  if (!state.manifest_key) return null;
  const prepared = await preparePublishedManifest({ bucket: input.store.bucket, siteId: input.siteId,
    publicationId: crypto.randomUUID(), expectedVersion: state.version, currentManifestKey: state.manifest_key,
    publicBaseUrl: input.publicBaseUrl, omitRoute: { pageId: input.pageId, locale: input.locale } });
  return { ...prepared, policyVersion: state.public_policy_version, domainVersion: state.public_domain_version };
}
