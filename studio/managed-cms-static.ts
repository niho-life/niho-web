import { assetKey } from "../src/assets.js";
import { galleryEntries, type CollectionImageValue } from "../src/collection-model.js";
import type { CmsPublicAsset, CmsReleaseSnapshot } from "../src/cms-v2.js";
import { managedVerificationTags } from "../src/managed-seo-settings.js";
import { escapeHtml } from "./managed-cms-model.js";
import { emptyManagedPublicPolicy, type ManagedPublicPolicy } from "./managed-embed-contract.js";
import { managedPublicHead, publicResourceSource } from "./managed-public-policy.js";
import { ManagedPagePublicationError } from "./managed-page-publication.js";
import { sha256Text, type PublishedRoute, type PublishedRouteInput } from "./managed-publication.js";

export function cmsCollectionPath(prefix: string | null): string | null {
  return prefix === null ? null : prefix.slice(0, -1);
}

export function previewCmsContent(schema: CmsReleaseSnapshot["schema"], item: CmsReleaseSnapshot["items"][number]) {
  const collection = schema.collections.find(({ id }) => id === item.collectionId)!;
  const title = String(item.values[collection.titleField] ?? "");
  const fields = collection.fields.filter(({ fieldId, type }) => fieldId !== collection.titleField && fieldId !== collection.slugField
    && ["text", "longText", "richText", "datetime"].includes(type));
  return { title, fields: fields.map((field) => ({ label: field.label, text: String(item.values[field.fieldId] ?? "") })) };
}

type RouteKind = "root" | "list" | "item";
type CmsStaticRoute = Omit<PublishedRouteInput, "html"> & { readonly kind: RouteKind; readonly collectionId?: string; readonly itemId?: string };

function routePath(snapshot: CmsReleaseSnapshot, kind: RouteKind, collectionId?: string, itemId?: string): string | null {
  if (kind === "root") return snapshot.sourceLocale && snapshot.sourceLocale !== snapshot.locale ? `/${snapshot.locale}/cms` : "/cms";
  if (kind === "list") {
    const collection = snapshot.schema.collections.find(({ id }) => id === collectionId);
    return collection ? cmsCollectionPath(collection.pathPrefix) : null;
  }
  return snapshot.items.find((item) => item.collectionId === collectionId && item.itemId === itemId)?.path ?? null;
}

function publicImage(image: CollectionImageValue | null, assets: ReadonlyMap<string, CmsPublicAsset>, include: (url: string) => boolean): string {
  const asset = image === null || typeof image === "string" ? undefined : assets.get(assetKey(image));
  if (!asset || !include(asset.url)) return "";
  const width = asset.width === null ? "" : ` width="${asset.width}"`;
  const height = asset.height === null ? "" : ` height="${asset.height}"`;
  return `<img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.altText)}"${width}${height}>`;
}

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")}</script>`;
}

function cmsMetadata(snapshot: CmsReleaseSnapshot, kind: RouteKind, collectionId?: string, itemId?: string): { title: string; description: string } {
  if (kind === "root") return { title: "CMS", description: "" };
  const collection = snapshot.schema.collections.find(({ id }) => id === collectionId);
  if (!collection) return { title: "CMS", description: "" };
  if (kind === "list") return { title: collection.label, description: "" };
  const item = snapshot.items.find((candidate) => candidate.collectionId === collectionId && candidate.itemId === itemId);
  if (!item) return { title: collection.label, description: "" };
  const presentation = previewCmsContent(snapshot.schema, item);
  const text = presentation.fields.map(({ text: value }) => value).filter(Boolean).join(" ");
  return { title: presentation.title, description: text.trim().slice(0, 500) };
}

async function cmsPageId(snapshot: CmsReleaseSnapshot, kind: RouteKind, collectionId?: string, itemId?: string) {
  const digest = await sha256Text(`${snapshot.locale}\u0000${kind}\u0000${collectionId ?? ""}\u0000${itemId ?? ""}`);
  return `cms_${digest.slice(0, 40)}`;
}

async function routeCandidates(snapshot: CmsReleaseSnapshot): Promise<CmsStaticRoute[]> {
  const candidates: CmsStaticRoute[] = [];
  const add = async (kind: RouteKind, collectionId?: string, itemId?: string) => {
    const path = routePath(snapshot, kind, collectionId, itemId);
    if (!path) return;
    const pageId = await cmsPageId(snapshot, kind, collectionId, itemId);
    const metadata = cmsMetadata(snapshot, kind, collectionId, itemId);
    candidates.push({ pageId, locale: snapshot.locale, path, sourceRevision: 1, title: metadata.title, description: metadata.description,
      kind, ...(collectionId ? { collectionId } : {}), ...(itemId ? { itemId } : {}) });
  };
  await add("root");
  for (const collection of snapshot.schema.collections) await add("list", collection.id);
  for (const item of snapshot.items) if (item.path) await add("item", item.collectionId, item.itemId);
  return candidates;
}

async function renderCmsRoute(snapshot: CmsReleaseSnapshot, candidate: CmsStaticRoute, input: {
  readonly origin: string;
  readonly prefix: string;
  readonly siteName: string;
  readonly policy: ManagedPublicPolicy;
  readonly alternates: readonly CmsReleaseSnapshot[];
}) {
  const { origin, prefix, siteName, policy } = input;
  const { path, kind } = candidate;
  const entry = kind === "item" ? snapshot.items.find((item) => item.itemId === candidate.itemId
    && item.collectionId === candidate.collectionId) : undefined;
  const collection = kind === "root" ? undefined : snapshot.schema.collections.find(({ id }) => id === candidate.collectionId);
  const publicUrl = `${origin}${prefix}${path}`;
  const imageSources = new Set<string>();
  const approvedAssetUrls = new Set(snapshot.assetManifest.map(({ url }) => new URL(url, origin).href));
  const include = (url: string) => {
    const source = publicResourceSource(url, origin, policy.resourceOrigins, approvedAssetUrls);
    if (source) imageSources.add(source);
    return source !== undefined;
  };
  let body: string;
  let description = candidate.description;
  if (entry && collection) {
    const assets = new Map(snapshot.assetManifest.map((asset) => [assetKey(asset.reference), asset] as const));
    body = collection.fields.filter(({ fieldId }) => fieldId !== collection.titleField && fieldId !== collection.slugField)
      .map(({ fieldId, type }) => {
        const value = entry.values[fieldId];
        if (type === "image" && value && typeof value === "object" && "provider" in value) return publicImage(value, assets, include);
        if (type === "gallery") return galleryEntries(value).map(({ image, caption }) => {
          const rendered = publicImage(image, assets, include);
          return rendered ? `<figure>${rendered}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>` : "";
        }).join("");
        if (typeof value !== "string" || !["text", "longText", "richText", "datetime"].includes(type)) return "";
        return `<p>${type === "richText" ? value : escapeHtml(value).replaceAll("\n", "<br>")}</p>`;
      }).join("");
  } else {
    const links = kind === "list" && collection
      ? snapshot.items.filter((item) => item.collectionId === collection.id && item.path).map((item) => ({ path: item.path!, title: String(item.values[collection.titleField] ?? "") }))
      : snapshot.schema.collections.flatMap((item) => {
        const collectionRoute = cmsCollectionPath(item.pathPrefix);
        return collectionRoute ? [{ path: collectionRoute, title: item.label }] : [];
      });
    body = `<ul>${links.map((link) => `<li><a href="${escapeHtml(prefix + link.path)}">${escapeHtml(link.title)}</a></li>`).join("")}</ul>`;
  }
  const head = await managedPublicHead({ measurementId: policy.seo.ga4MeasurementId, imageSources });
  const seo = policy.seo, effectiveSiteName = seo.siteName ?? siteName;
  description ||= seo.description ?? "";
  const noindex = seo.robotsPolicy === "noindex";
  const ogImageCandidate = seo.defaultOgImage && (/^https:\/\//iu.test(seo.defaultOgImage)
    ? seo.defaultOgImage : `${prefix}${seo.defaultOgImage}`);
  const ogImage = ogImageCandidate && (include(ogImageCandidate) ? ogImageCandidate : undefined);
  const metadata = [
    `<meta name="robots" content="${noindex ? "noindex, nofollow" : "index, follow"}">`,
    ...(description ? [`<meta name="description" content="${escapeHtml(description)}">`, `<meta property="og:description" content="${escapeHtml(description)}">`] : []),
    `<meta property="og:type" content="${kind === "item" ? "article" : "website"}">`,
    `<meta property="og:title" content="${escapeHtml(candidate.title ?? "CMS")}">`, `<meta property="og:locale" content="${escapeHtml(snapshot.locale)}">`,
    `<meta property="og:site_name" content="${escapeHtml(effectiveSiteName)}">`, `<meta property="og:url" content="${escapeHtml(publicUrl)}">`,
    ...(ogImage ? [`<meta property="og:image" content="${escapeHtml(/^https:\/\//iu.test(ogImage) ? ogImage : `${origin}${ogImage}`)}">`, `<meta property="og:image:alt" content="${escapeHtml(effectiveSiteName)}">`] : []),
    ...(!noindex ? [`<link rel="canonical" href="${escapeHtml(publicUrl)}">`] : [])
  ].join("") + managedVerificationTags(seo);
  const alternatives: { locale: string; url: string }[] = [];
  for (const other of input.alternates.slice(0, 3)) {
    const otherPath = routePath(other, kind, candidate.collectionId, candidate.itemId);
    if (otherPath) alternatives.push({ locale: other.locale.toLowerCase(), url: `${origin}${prefix}${otherPath}` });
  }
  if (!noindex && alternatives.length > 1) {
    const fallback = alternatives.find(({ locale }) => locale === "ja") ?? alternatives[0]!;
    const links = alternatives.map(({ locale, url }) => `<link rel="alternate" hreflang="${escapeHtml(locale)}" href="${escapeHtml(url)}">`).join("");
    const structured = jsonLd({ "@context": "https://schema.org", "@graph": [
      { "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/`, name: effectiveSiteName, ...(seo.description ? { description: seo.description } : {}) },
      ...(seo.organization ? [{ "@type": "Organization", "@id": `${origin}/#organization`, name: seo.organization.name, url: seo.organization.url,
        ...(seo.organization.logo ? { logo: seo.organization.logo } : {}), ...(seo.organization.sameAs.length ? { sameAs: seo.organization.sameAs } : {}) }] : []),
      { "@type": kind === "item" ? "Article" : "CollectionPage", "@id": `${publicUrl}#page`, url: publicUrl, headline: candidate.title ?? "CMS",
        inLanguage: snapshot.locale, isPartOf: { "@id": `${origin}/#website` }, ...(description ? { description } : {}) }
    ] });
    return { html: `<!doctype html><html lang="${escapeHtml(snapshot.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(candidate.title ?? "CMS")}</title>${metadata}${links}<link rel="alternate" hreflang="x-default" href="${escapeHtml(fallback.url)}">${structured}${head.scripts}</head><body><main><h1>${escapeHtml(candidate.title ?? "CMS")}</h1>${body}</main></body></html>`,
      contentSecurityPolicy: head.csp, noindex };
  }
  const structured = jsonLd({ "@context": "https://schema.org", "@graph": [
    { "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/`, name: effectiveSiteName, ...(seo.description ? { description: seo.description } : {}) },
    ...(seo.organization ? [{ "@type": "Organization", "@id": `${origin}/#organization`, name: seo.organization.name, url: seo.organization.url,
      ...(seo.organization.logo ? { logo: seo.organization.logo } : {}), ...(seo.organization.sameAs.length ? { sameAs: seo.organization.sameAs } : {}) }] : []),
    { "@type": kind === "item" ? "Article" : "CollectionPage", "@id": `${publicUrl}#page`, url: publicUrl, headline: candidate.title ?? "CMS",
      inLanguage: snapshot.locale, isPartOf: { "@id": `${origin}/#website` }, ...(description ? { description } : {}) }
  ] });
  return { html: `<!doctype html><html lang="${escapeHtml(snapshot.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(candidate.title ?? "CMS")}</title>${metadata}${structured}${head.scripts}</head><body><main><h1>${escapeHtml(candidate.title ?? "CMS")}</h1>${body}</main></body></html>`,
    contentSecurityPolicy: head.csp, noindex };
}

/** Enumerate route metadata, then render each stored CMS snapshot one URL at a time. */
export async function prepareManagedCmsStaticRoutes(input: {
  readonly snapshots: readonly CmsReleaseSnapshot[];
  readonly previousRoutes: readonly PublishedRoute[];
  readonly updatedLocale?: string;
  readonly origin: string;
  readonly prefix: string;
  readonly siteName: string;
  readonly policy?: ManagedPublicPolicy;
}) {
  const policy = input.policy ?? emptyManagedPublicPolicy();
  const candidates = await Promise.all(input.snapshots.map(async (snapshot) => ({ snapshot, routes: await routeCandidates(snapshot) })));
  const previousPaths = new Map(input.previousRoutes.map((route) => [route.path, route]));
  async function* renderRoutes(): AsyncGenerator<PublishedRouteInput> {
    for (const { snapshot, routes } of candidates) for (const route of routes) {
      try {
        const rendered = await renderCmsRoute(snapshot, route, { origin: input.origin, prefix: input.prefix, siteName: input.siteName,
          policy, alternates: input.snapshots });
        const previous = previousPaths.get(route.path);
        const lastModified = snapshot.locale !== input.updatedLocale && previous?.pageId === route.pageId ? previous.lastModified : undefined;
        const { kind: _kind, collectionId: _collectionId, itemId: _itemId, ...metadata } = route;
        yield { ...metadata, html: rendered.html, contentSecurityPolicy: rendered.contentSecurityPolicy, noindex: rendered.noindex,
          cmsReleaseId: snapshot.releaseId,
          description: route.description || policy.seo.description || "", ...(lastModified ? { lastModified } : {}) };
      } catch (error) {
        throw new ManagedPagePublicationError(input.origin + input.prefix + route.path, { cause: error });
      }
    }
  }
  return { routes: renderRoutes(), paths: candidates.flatMap(({ routes }) => routes.map(({ path }) => path)) };
}
