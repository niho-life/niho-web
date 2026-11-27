import type { ManagedD1, ManagedPublicHtmlCache } from "./managed-sites.js";
import { MANAGED_EMBED_REF } from "./managed-embed-contract.js";

export type PublishedSiteReadObjectStore = {
  get(key: string): Promise<{ json<T>(): Promise<T>; text(): Promise<string> } | null>;
};
export type PublishedSiteObjectStore = PublishedSiteReadObjectStore & {
  put(key: string, value: string, options: { onlyIf: Headers }): Promise<unknown>;
};

export type PublishedRoute = {
  readonly pageId: string;
  readonly locale: string;
  readonly path: string;
  readonly sourceRevision: number;
  readonly artifactKey: string;
  readonly digest: string;
  readonly contentType: "text/html; charset=utf-8";
  readonly contentSecurityPolicy: string;
  readonly embeds?: readonly PublishedRouteEmbed[];
  readonly title?: string;
  readonly description?: string;
  readonly text?: string;
  readonly lastModified?: string;
  readonly noindex?: boolean;
};

export type PublishedRouteEmbed = { readonly refId: string; readonly src: string };
export type PublishedDiscoveryFile = {
  readonly path: "/sitemap.xml" | "/robots.txt" | "/llms.txt" | "/llms-full.txt";
  readonly artifactKey: string;
  readonly digest: string;
  readonly contentType: "application/xml; charset=utf-8" | "text/plain; charset=utf-8";
};

export type PublishedSiteManifest = {
  readonly formatVersion: 1;
  readonly siteId: string;
  readonly publicationId: string;
  readonly createdAt: string;
  readonly routes: readonly PublishedRoute[];
  readonly siteName?: string;
  readonly siteDescription?: string;
  readonly robotsPolicy?: "index" | "noindex";
  readonly discoveryFiles?: readonly PublishedDiscoveryFile[];
};

export type PreparedPublishedSite = {
  readonly expectedVersion: string;
  readonly manifestKey: string;
  readonly manifestVersion: string;
  readonly artifactKey: string;
  readonly artifactDigest: string;
  readonly contentSecurityPolicy: string;
};

export const DEFAULT_PUBLISHED_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; media-src https:; font-src https: data:; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%+-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%+-]+)*)?$/u;
const DISCOVERY_PATHS = ["/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parsePublishedEmbeds(value: unknown): readonly PublishedRouteEmbed[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const seen = new Set<string>(), embeds: PublishedRouteEmbed[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !exactKeys(candidate, ["refId", "src"])
      || typeof candidate.refId !== "string" || !MANAGED_EMBED_REF.test(candidate.refId)
      || seen.has(candidate.refId) || typeof candidate.src !== "string" || candidate.src.length > 8192) return null;
    let url: URL;
    try { url = new URL(candidate.src); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    seen.add(candidate.refId);
    embeds.push({ refId: candidate.refId, src: candidate.src });
  }
  return embeds;
}

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parsePublishedSiteManifest(value: unknown, siteId: string): PublishedSiteManifest | null {
  if (!SAFE_ID.test(siteId) || !isRecord(value) || !exactKeys(value, ["formatVersion", "siteId", "publicationId", "createdAt", "routes",
    ...(Object.hasOwn(value, "siteName") ? ["siteName"] : []), ...(Object.hasOwn(value, "siteDescription") ? ["siteDescription"] : []),
    ...(Object.hasOwn(value, "robotsPolicy") ? ["robotsPolicy"] : []), ...(Object.hasOwn(value, "discoveryFiles") ? ["discoveryFiles"] : [])])
    || value.formatVersion !== 1 || value.siteId !== siteId || typeof value.publicationId !== "string" || !SAFE_ID.test(value.publicationId)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.routes)
    || Object.hasOwn(value, "siteName") && (typeof value.siteName !== "string" || value.siteName.length > 300)
    || Object.hasOwn(value, "siteDescription") && (typeof value.siteDescription !== "string" || value.siteDescription.length > 1000)
    || Object.hasOwn(value, "robotsPolicy") && value.robotsPolicy !== "index" && value.robotsPolicy !== "noindex") return null;
  if (Object.hasOwn(value, "discoveryFiles")) {
    if (!Array.isArray(value.discoveryFiles) || value.discoveryFiles.length !== DISCOVERY_PATHS.length) return null;
    const seenFiles = new Set<string>();
    for (const candidate of value.discoveryFiles) {
      if (!isRecord(candidate) || !exactKeys(candidate, ["path", "artifactKey", "digest", "contentType"])
        || typeof candidate.path !== "string" || !(DISCOVERY_PATHS as readonly string[]).includes(candidate.path)
        || seenFiles.has(candidate.path) || typeof candidate.digest !== "string" || !HASH.test(candidate.digest)
        || candidate.artifactKey !== `managed-sites/${siteId}/artifacts/${candidate.digest}.${candidate.path.slice(1)}`
        || candidate.contentType !== (candidate.path === "/sitemap.xml" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8")) return null;
      seenFiles.add(candidate.path);
    }
    if (DISCOVERY_PATHS.some((path) => !seenFiles.has(path))) return null;
  }
  const seen = new Set<string>();
  const routes: PublishedRoute[] = [];
  for (const candidate of value.routes) {
    const hasEmbeds = isRecord(candidate) && Object.hasOwn(candidate, "embeds");
    const optionalRouteKeys = isRecord(candidate) ? ["title", "description", "text", "lastModified", "noindex"].filter((key) => Object.hasOwn(candidate, key)) : [];
    if (!isRecord(candidate) || !exactKeys(candidate, ["pageId", "locale", "path", "sourceRevision", "artifactKey", "digest", "contentType", "contentSecurityPolicy",
      ...(hasEmbeds ? ["embeds"] : []), ...optionalRouteKeys])
      || typeof candidate.pageId !== "string" || !SAFE_ID.test(candidate.pageId)
      || typeof candidate.locale !== "string" || !SAFE_LOCALE.test(candidate.locale)
      || typeof candidate.path !== "string" || !SAFE_PATH.test(candidate.path)
      || candidate.path !== "/" && candidate.path.endsWith("/")
      || !Number.isSafeInteger(candidate.sourceRevision) || Number(candidate.sourceRevision) < 1
      || typeof candidate.digest !== "string" || !HASH.test(candidate.digest)
      || candidate.artifactKey !== `managed-sites/${siteId}/artifacts/${candidate.digest}.html`
      || candidate.contentType !== "text/html; charset=utf-8"
      || typeof candidate.contentSecurityPolicy !== "string" || candidate.contentSecurityPolicy.length > 2048
      || /[\u0000-\u001f\u007f]/u.test(candidate.contentSecurityPolicy)
      || Object.hasOwn(candidate, "title") && (typeof candidate.title !== "string" || candidate.title.length > 500 || /[\u0000-\u001f\u007f]/u.test(candidate.title))
      || Object.hasOwn(candidate, "description") && (typeof candidate.description !== "string" || candidate.description.length > 1000 || /[\u0000-\u001f\u007f]/u.test(candidate.description))
      || Object.hasOwn(candidate, "text") && (typeof candidate.text !== "string" || candidate.text.length > 40_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(candidate.text))
      || Object.hasOwn(candidate, "lastModified") && (typeof candidate.lastModified !== "string" || !Number.isFinite(Date.parse(candidate.lastModified)))
      || Object.hasOwn(candidate, "noindex") && typeof candidate.noindex !== "boolean") return null;
    const embeds = hasEmbeds ? parsePublishedEmbeds(candidate.embeds) : undefined;
    if (hasEmbeds && !embeds) return null;
    const key = `${candidate.pageId}\u0000${candidate.locale}`;
    const pathKey = String(candidate.path);
    if (seen.has(key) || routes.some((route) => route.path === pathKey)) return null;
    seen.add(key);
    routes.push({
      pageId: candidate.pageId, locale: candidate.locale, path: candidate.path, sourceRevision: Number(candidate.sourceRevision),
      artifactKey: candidate.artifactKey, digest: candidate.digest, contentType: "text/html; charset=utf-8",
      contentSecurityPolicy: candidate.contentSecurityPolicy, ...(embeds ? { embeds } : {}),
      ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
      ...(typeof candidate.lastModified === "string" ? { lastModified: candidate.lastModified } : {}),
      ...(typeof candidate.noindex === "boolean" ? { noindex: candidate.noindex } : {})
    });
  }
  return value as unknown as PublishedSiteManifest;
}

async function putImmutable(bucket: PublishedSiteObjectStore, key: string, value: string): Promise<void> {
  const result = await bucket.put(key, value, { onlyIf: new Headers({ "If-None-Match": "*" }) });
  // A conditional conflict is expected for an identical content-addressed object.
  if (result === null) return;
}

export async function preparePublishedSite(input: {
  readonly bucket: PublishedSiteObjectStore;
  readonly siteId: string;
  readonly publicationId: string;
  readonly pageId: string;
  readonly locale: string;
  readonly path: string;
  readonly sourceRevision: number;
  readonly html: string;
  readonly contentSecurityPolicy?: string;
  readonly embeds?: readonly PublishedRouteEmbed[];
  readonly title?: string;
  readonly description?: string;
  readonly text?: string;
  readonly noindex?: boolean;
  readonly isPublic?: boolean;
  readonly siteName?: string;
  readonly siteDescription?: string;
  readonly robotsPolicy?: "index" | "noindex";
  readonly publicBaseUrl?: string;
  readonly activeRouteKeys?: readonly { readonly pageId: string; readonly locale: string }[];
  readonly expectedVersion: string;
  readonly currentManifestKey: string | null;
}): Promise<PreparedPublishedSite> {
  const { bucket, siteId, publicationId, pageId, locale, path, sourceRevision, html } = input;
  if (!SAFE_ID.test(siteId) || !SAFE_ID.test(publicationId) || !SAFE_ID.test(pageId) || !SAFE_LOCALE.test(locale)
    || !SAFE_PATH.test(path) || path !== "/" && path.endsWith("/")
    || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || !html || html.length > 2_000_000
    || !input.expectedVersion || input.expectedVersion.length > 200
    || input.title !== undefined && (input.title.length > 500 || /[\u0000-\u001f\u007f]/u.test(input.title))
    || input.description !== undefined && (input.description.length > 1000 || /[\u0000-\u001f\u007f]/u.test(input.description))
    || input.text !== undefined && (input.text.length > 40_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text))
    || input.siteName !== undefined && input.siteName.length > 300
    || input.siteDescription !== undefined && input.siteDescription.length > 1000
    || input.robotsPolicy !== undefined && input.robotsPolicy !== "index" && input.robotsPolicy !== "noindex") throw new Error("invalid managed publication input");
  const embeds = input.embeds === undefined ? undefined : parsePublishedEmbeds(input.embeds);
  if (input.embeds !== undefined && !embeds) throw new Error("invalid managed publication embeds");

  const artifactDigest = await sha256Text(html);
  const artifactKey = `managed-sites/${siteId}/artifacts/${artifactDigest}.html`;
  await putImmutable(bucket, artifactKey, html);

  let previousRoutes: readonly PublishedRoute[] = [];
  if (input.currentManifestKey) {
    if (!new RegExp(`^managed-sites/${siteId}/manifests/${HASH.source.slice(1, -1)}\\.json$`, "u").test(input.currentManifestKey)) {
      throw new Error("invalid current publication manifest key");
    }
    const object = await bucket.get(input.currentManifestKey);
    if (!object) throw new Error("current publication manifest missing");
    const previous = parsePublishedSiteManifest(await object.json<unknown>(), siteId);
    if (!previous) throw new Error("current publication manifest invalid");
    previousRoutes = previous.routes;
  }

  const contentSecurityPolicy = input.contentSecurityPolicy ?? DEFAULT_PUBLISHED_CSP;
  const activeRouteKeys = input.activeRouteKeys ? new Set(input.activeRouteKeys.map(({ pageId: activePageId, locale: activeLocale }) => `${activePageId}\u0000${activeLocale}`)) : null;
  const routes = previousRoutes.filter((route) => (route.pageId !== pageId || route.locale !== locale)
    && (!activeRouteKeys || activeRouteKeys.has(`${route.pageId}\u0000${route.locale}`)));
  if (routes.some((route) => route.path === path)) throw new Error("published route is already owned by another page");
  const createdAt = new Date().toISOString();
  if (input.isPublic !== false) routes.push({ pageId, locale, path, sourceRevision, artifactKey, digest: artifactDigest,
    contentType: "text/html; charset=utf-8", contentSecurityPolicy, ...(embeds ? { embeds } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}), lastModified: createdAt, ...(input.noindex ? { noindex: true } : {}) });
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.locale.localeCompare(b.locale) || a.pageId.localeCompare(b.pageId));
  let discoveryFiles: PublishedDiscoveryFile[] | undefined;
  if (input.publicBaseUrl) {
    discoveryFiles = await createDiscoveryFiles(bucket, siteId, routes, {
      publicBaseUrl: input.publicBaseUrl, siteName: input.siteName ?? "", siteDescription: input.siteDescription ?? "",
      robotsPolicy: input.robotsPolicy ?? "index"
    });
  }
  const manifest: PublishedSiteManifest = {
    formatVersion: 1, siteId, publicationId, createdAt, routes,
    ...(input.siteName !== undefined ? { siteName: input.siteName } : {}),
    ...(input.siteDescription !== undefined ? { siteDescription: input.siteDescription } : {}),
    ...(input.robotsPolicy !== undefined ? { robotsPolicy: input.robotsPolicy } : {}),
    ...(discoveryFiles ? { discoveryFiles } : {})
  };
  const manifestText = JSON.stringify(manifest);
  const manifestVersion = await sha256Text(manifestText);
  const manifestKey = `managed-sites/${siteId}/manifests/${manifestVersion}.json`;
  await putImmutable(bucket, manifestKey, manifestText);
  return { expectedVersion: input.expectedVersion, manifestKey, manifestVersion, artifactKey, artifactDigest, contentSecurityPolicy };
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function localePathIdentity(locale: string, path: string): string {
  const localePrefix = `/${locale.split("-")[0]!.toLowerCase()}`;
  return path === localePrefix ? "/" : path.startsWith(`${localePrefix}/`) ? path.slice(localePrefix.length) : path;
}

function markdownText(value: string, singleLine = false): string {
  const source = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
  return (singleLine ? source.replace(/\s+/gu, " ").trim() : source).replace(/[\\`*_{}\[\]()<>#+.!|\-]/gu, "\\$&");
}

async function createDiscoveryFiles(bucket: PublishedSiteObjectStore, siteId: string, allRoutes: readonly PublishedRoute[], input: {
  readonly publicBaseUrl: string; readonly siteName: string; readonly siteDescription: string; readonly robotsPolicy: "index" | "noindex";
}): Promise<PublishedDiscoveryFile[]> {
  let base: URL;
  try { base = new URL(input.publicBaseUrl); } catch { throw new Error("invalid managed publication public base URL"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("invalid managed publication public base URL");
  const routes = input.robotsPolicy === "noindex" ? [] : allRoutes.filter((route) => !route.noindex);
  const absolute = (route: PublishedRoute) => new URL(route.path.replace(/^\//u, ""), base.href.endsWith("/") ? base : `${base.href}/`).href;
  const groups = new Map<string, PublishedRoute[]>();
  for (const route of routes) {
    const key = localePathIdentity(route.locale, route.path);
    groups.set(key, [...(groups.get(key) ?? []), route]);
  }
  const sitemapEntries = routes.map((route) => {
    const alternatives = groups.get(localePathIdentity(route.locale, route.path)) ?? [];
    const languages = alternatives.length > 1 ? alternatives.map((other) =>
      `<xhtml:link rel="alternate" hreflang="${xmlEscape(other.locale.toLowerCase())}" href="${xmlEscape(absolute(other))}"/>`).join("") : "";
    const lastmod = route.lastModified && Number.isFinite(Date.parse(route.lastModified))
      ? `<lastmod>${xmlEscape(new Date(route.lastModified).toISOString())}</lastmod>` : "";
    return `<url><loc>${xmlEscape(absolute(route))}</loc>${lastmod}${languages}</url>`;
  }).join("");
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${sitemapEntries}</urlset>`;
  const robots = input.robotsPolicy === "noindex" ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nAllow: /\nSitemap: ${new URL("sitemap.xml", base.href.endsWith("/") ? base : `${base.href}/`).href}\n`;
  const pageLines = routes.map((route) => `- [${markdownText(route.title || route.path, true)}](${absolute(route)})${route.description ? `: ${markdownText(route.description, true)}` : ""}`);
  const siteName = markdownText(input.siteName || "Site", true);
  const siteDescription = markdownText(input.siteDescription, true);
  const markdown = [`# ${siteName}`, ...(siteDescription ? ["", siteDescription] : []), "", "## Pages", "", ...pageLines].join("\n");
  const fullParts = [markdown, "", "## Full text", "", ...routes.filter((route) => route.text).map((route) =>
    `### ${markdownText(route.title || route.path, true)}\n\n${markdownText(route.text!)}`)];
  const full = fullParts.join("\n").slice(0, 900_000);
  const bodies = new Map<string, { body: string; contentType: PublishedDiscoveryFile["contentType"] }>([
    ["/sitemap.xml", { body: sitemap, contentType: "application/xml; charset=utf-8" }],
    ["/robots.txt", { body: robots, contentType: "text/plain; charset=utf-8" }],
    ["/llms.txt", { body: markdown.slice(0, 900_000), contentType: "text/plain; charset=utf-8" }],
    ["/llms-full.txt", { body: full, contentType: "text/plain; charset=utf-8" }]
  ]);
  const files: PublishedDiscoveryFile[] = [];
  for (const path of DISCOVERY_PATHS) {
    const { body, contentType } = bodies.get(path)!;
    const digest = await sha256Text(body);
    const artifactKey = `managed-sites/${siteId}/artifacts/${digest}.${path.slice(1)}`;
    await putImmutable(bucket as PublishedSiteObjectStore, artifactKey, body);
    files.push({ path, artifactKey, digest, contentType });
  }
  return files;
}

type PublicDatabase = Pick<ManagedD1, "prepare"> & {
  prepare(query: string): {
    bind(...values: readonly unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ readonly success: boolean; readonly results?: readonly T[] }> };
  };
};
type PublicEnv = {
  readonly DB: PublicDatabase;
  readonly CMS_OBJECTS: PublishedSiteReadObjectStore;
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly PUBLIC_SITES_PREVIEW_ORIGIN?: string;
  readonly PUBLIC_HTML_CACHE?: ManagedPublicHtmlCache;
};
type HostRow = { readonly site_id: string; readonly path_prefix: string; readonly noindex: number };
type PointerRow = { readonly manifest_key: string | null };
type ArtifactRow = {
  readonly artifact_key: string; readonly digest: string; readonly content_type: string; readonly content_security_policy: string;
  readonly noindex: number;
};
type RedirectRow = { readonly to_path: string };
type CurrentRouteRow = {
  readonly page_id: string; readonly locale: string; readonly source_revision: number; readonly artifact_key: string;
  readonly digest: string; readonly content_type: string; readonly content_security_policy: string;
};
type CacheWriteContext = { waitUntil(promise: Promise<unknown>): void };

const LOOKUP_TTL_MS = 5_000;
const MAX_LOOKUPS = 256;
const EDGE_CACHE_SECONDS = 3600;
type Lookup<T> = Map<string, { readonly value: T; readonly expiresAt: number }>;
type PublicationLookups = { readonly pointers: Lookup<string> };
const lookupsByDatabase = new WeakMap<PublicDatabase, PublicationLookups>();

function publicationLookups(db: PublicDatabase): PublicationLookups {
  let lookups = lookupsByDatabase.get(db);
  if (!lookups) {
    lookups = { pointers: new Map() };
    lookupsByDatabase.set(db, lookups);
  }
  return lookups;
}

function cachedLookup<T>(entries: Lookup<T>, key: string): T | undefined {
  const entry = entries.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  entries.delete(key);
}

function rememberLookup<T>(entries: Lookup<T>, key: string, value: T, startedAt: number): void {
  entries.delete(key);
  if (entries.size >= MAX_LOOKUPS) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(key, { value, expiresAt: startedAt + LOOKUP_TTL_MS });
}

async function publicHosts(db: PublicDatabase, hostname: string): Promise<readonly HostRow[]> {
  const result = await db.prepare(`SELECT site_id, path_prefix, noindex FROM managed_site_hosts
    WHERE hostname = ?1 AND enabled = 1 ORDER BY length(path_prefix) DESC LIMIT 100`).bind(hostname).all<HostRow>();
  if (!result.success) throw new Error("managed site host query failed");
  return result.results ?? [];
}

async function publishedPointer(db: PublicDatabase, entries: Lookup<string>, siteId: string): Promise<string | null> {
  const startedAt = Date.now();
  const row = await db.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?1 LIMIT 1")
    .bind(siteId).first<PointerRow>();
  if (!row?.manifest_key) return null;
  rememberLookup(entries, siteId, row.manifest_key, startedAt);
  return row.manifest_key;
}

function noindexHeader(enabled: boolean): Headers {
  const headers = new Headers({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
  if (enabled) headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

function notFound(noindex: boolean): Response {
  const headers = noindexHeader(noindex);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response("Not Found", { status: 404, headers });
}

function xmlHeader(noindex: boolean): Headers {
  const headers = noindexHeader(noindex);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  return headers;
}

function unavailable(noindex: boolean): Response {
  const headers = noindexHeader(noindex);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response("Published page unavailable", { status: 503, headers });
}

function isConfiguredPreview(url: URL, env: PublicEnv): boolean {
  if (!env.PUBLIC_SITES_PREVIEW_ORIGIN) return false;
  try { return new URL(env.PUBLIC_SITES_PREVIEW_ORIGIN).origin === url.origin; }
  catch { return false; }
}

function resolveSitePath(pathname: string, prefix: string): { readonly path: string; readonly missingRootSlash: boolean } | null {
  if (prefix === "" || prefix === "/") return { path: pathname || "/", missingRootSlash: false };
  if (pathname === prefix) return { path: "/", missingRootSlash: true };
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return { path: pathname.slice(prefix.length) || "/", missingRootSlash: false };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header || header.length > 2048) return false;
  return header.split(",").some((candidate) => candidate.trim() === "*" || candidate.trim() === etag || candidate.trim() === `W/${etag}`);
}

async function matchPublishedPage(env: PublicEnv, hostname: string, host: HostRow, path: string, manifestKey: string) {
  const manifestObject = await env.CMS_OBJECTS.get(manifestKey);
  if (!manifestObject) return null;
  const manifest = parsePublishedSiteManifest(await manifestObject.json<unknown>(), host.site_id);
  if (!manifest) return null;
  const exact = manifest.routes.find((candidate) => candidate.path === path);
  const route = exact ?? manifest.routes.find((candidate) => path.endsWith("/") && candidate.path === path.slice(0, -1));
  if (!route) return null;

  // Recheck the route's current publication, visibility and host registration before serving any bytes.
  const row = await env.DB.prepare(`SELECT publication.artifact_key, publication.artifact_digest AS digest,
        publication.content_type, publication.content_security_policy, mapping.noindex
      FROM managed_page_publications AS publication
      JOIN managed_pages AS page
        ON page.site_id = publication.site_id AND page.page_id = publication.page_id AND page.locale = publication.locale
        AND page.published_publication_id = publication.id AND page.visibility = 'public'
      JOIN managed_site_hosts AS mapping ON mapping.site_id = publication.site_id
        AND mapping.hostname = ?6 AND mapping.path_prefix = ?7 AND mapping.enabled = 1
      JOIN managed_site_publication_state AS state ON state.site_id = publication.site_id AND state.manifest_key = ?8
     WHERE publication.site_id = ?1 AND publication.page_id = ?2 AND publication.locale = ?3
       AND publication.artifact_key = ?4 AND publication.artifact_digest = ?5 LIMIT 1`)
    .bind(host.site_id, route.pageId, route.locale, route.artifactKey, route.digest, hostname, host.path_prefix, manifestKey)
    .first<ArtifactRow>();
  if (!row || row.content_type !== route.contentType || row.content_security_policy !== route.contentSecurityPolicy) return null;
  return { route, row, robotsPolicy: manifest.robotsPolicy, publicationId: manifest.publicationId, trailingSlash: !exact };
}

async function htmlCache(env: PublicEnv): Promise<ManagedPublicHtmlCache | undefined> {
  if (env.PUBLIC_HTML_CACHE) return env.PUBLIC_HTML_CACHE;
  try {
    return await globalThis.caches?.open("niho-public-html-v1");
  } catch { return undefined; }
}

async function publishedHtml(request: Request, url: URL, env: PublicEnv, siteId: string, publicationId: string, row: ArtifactRow,
  noindex: boolean, context?: CacheWriteContext): Promise<Response> {
  const etag = `"${row.digest}"`;
  const headers = noindexHeader(noindex);
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Security-Policy", row.content_security_policy);
  headers.set("Cache-Control", "no-cache");
  headers.set("ETag", etag);
  const notModified = etagMatches(request.headers.get("If-None-Match"), etag);
  const status = notModified ? 304 : 200;
  const sendBody = !notModified && request.method !== "HEAD";
  const cache = await htmlCache(env);
  const key = new Request(`${url.origin}/_niho-cache/publication/${siteId}/${publicationId}/${row.digest}`);
  if (cache) {
    try {
      const cached = await cache.match(key);
      if (cached?.status === 200 && cached.headers.get("ETag") === etag && cached.body) {
        if (!sendBody) void cached.body.cancel().catch(() => undefined);
        return new Response(sendBody ? cached.body : null, { status, headers });
      }
    } catch { /* Cache API is an optional optimization. */ }
  }
  const object = await env.CMS_OBJECTS.get(row.artifact_key);
  if (!object) return unavailable(noindex);
  const html = await object.text();
  if (await sha256Text(html) !== row.digest) return unavailable(noindex);
  if (cache) {
    const stored = new Response(html, { headers: { "Cache-Control": `public, max-age=${EDGE_CACHE_SECONDS}`, "ETag": etag } });
    const write = Promise.resolve().then(() => cache.put(key, stored)).catch(() => undefined);
    if (context) context.waitUntil(write);
    else await write;
  }
  return new Response(sendBody ? html : null, { status, headers });
}

function redirectSlash(url: URL, pathname: string, noindex: boolean): Response {
  const target = new URL(url.href);
  target.pathname = pathname;
  const headers = noindexHeader(noindex);
  headers.set("Cache-Control", "no-store");
  headers.set("Location", target.href);
  return new Response(null, { status: 301, headers });
}

async function publishedDiscovery(request: Request, env: PublicEnv, path: string, host: HostRow, manifestKey: string,
  noindex: boolean): Promise<Response | null> {
  if (!(DISCOVERY_PATHS as readonly string[]).includes(path)) return null;
  const object = await env.CMS_OBJECTS.get(manifestKey);
  if (!object) return unavailable(noindex);
  const manifest = parsePublishedSiteManifest(await object.json<unknown>(), host.site_id);
  if (!manifest) return unavailable(noindex);
  const current = await env.DB.prepare(`SELECT page.page_id, page.locale, publication.source_revision, publication.artifact_key,
      publication.artifact_digest AS digest, publication.content_type, publication.content_security_policy
    FROM managed_pages AS page
    JOIN managed_page_publications AS publication ON publication.id = page.published_publication_id
      AND publication.site_id = page.site_id AND publication.page_id = page.page_id AND publication.locale = page.locale
    WHERE page.site_id = ?1 AND page.visibility = 'public' AND page.published_revision IS NOT NULL`)
    .bind(host.site_id).all<CurrentRouteRow>();
  if (!current.success) throw new Error("managed public discovery route query failed");
  const activeRoutes = current.results ?? [];
  if (manifest.routes.length !== activeRoutes.length || manifest.routes.some((route) => !activeRoutes.some((active) =>
    active.page_id === route.pageId && active.locale === route.locale && active.source_revision === route.sourceRevision
      && active.artifact_key === route.artifactKey && active.digest === route.digest
      && active.content_type === route.contentType && active.content_security_policy === route.contentSecurityPolicy))) return unavailable(noindex);
  const responseNoindex = noindex || manifest.robotsPolicy === "noindex";
  const file = manifest.discoveryFiles?.find((candidate) => candidate.path === path);
  if (!file) return notFound(noindex);
  const headers = path === "/sitemap.xml" ? xmlHeader(responseNoindex) : noindexHeader(responseNoindex);
  if (path !== "/sitemap.xml") headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  const etag = `"${file.digest}"`;
  headers.set("ETag", etag);
  if (path === "/robots.txt" && responseNoindex) {
    const body = "User-agent: *\nDisallow: /\n";
    const robotsEtag = `"${await sha256Text(body)}"`;
    headers.set("ETag", robotsEtag);
    const notModified = etagMatches(request.headers.get("If-None-Match"), robotsEtag);
    return new Response(request.method === "HEAD" || notModified ? null : body, { status: notModified ? 304 : 200, headers });
  }
  const notModified = etagMatches(request.headers.get("If-None-Match"), etag);
  if (notModified) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const artifact = await env.CMS_OBJECTS.get(file.artifactKey);
  if (!artifact) return unavailable(noindex);
  const body = await artifact.text();
  if (await sha256Text(body) !== file.digest) return unavailable(noindex);
  return new Response(body, { status: 200, headers });
}

async function publishedRedirect(env: PublicEnv, url: URL, host: HostRow, path: string, noindex: boolean): Promise<Response | null> {
  const row = await env.DB.prepare(`SELECT to_path FROM managed_site_redirects
    WHERE site_id = ?1 AND from_path = ?2 LIMIT 1`).bind(host.site_id, path).first<RedirectRow>();
  if (!row || !SAFE_PATH.test(row.to_path) || row.to_path.startsWith("//") || row.to_path === path) return null;
  const prefix = host.path_prefix === "/" ? "" : host.path_prefix.replace(/\/+$/u, "");
  const target = new URL(url.href);
  target.pathname = `${prefix}${row.to_path}`;
  const headers = noindexHeader(noindex);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Location", target.href);
  return new Response(null, { status: 301, headers });
}

export async function publishedSiteRequest(request: Request, env: PublicEnv, context?: CacheWriteContext): Promise<Response> {
  const url = new URL(request.url);
  const configuredPreview = isConfiguredPreview(url, env);
  if (/^\/_niho\/(?:niho-embeds|presentation)-[a-f0-9]{12}\.js$/u.test(url.pathname)) {
    if (!env.ASSETS || url.search || request.method !== "GET" && request.method !== "HEAD") return notFound(true);
    try {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 404) return notFound(true);
      if (!asset.ok) return unavailable(true);
      const headers = noindexHeader(true);
      headers.set("Content-Type", asset.headers.get("Content-Type") ?? "text/javascript; charset=utf-8");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(request.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
    } catch { return unavailable(true); }
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.length > 253 || /[^a-z0-9.-]/u.test(hostname)) return notFound(configuredPreview);
  const lookups = publicationLookups(env.DB);
  let hosts: readonly HostRow[];
  try {
    hosts = await publicHosts(env.DB, hostname);
  } catch (error) {
    if (configuredPreview) return unavailable(true);
    throw error;
  }
  let selected: { readonly host: HostRow; readonly path: string; readonly missingRootSlash: boolean } | null = null;
  for (const host of hosts) {
    const resolved = resolveSitePath(url.pathname, host.path_prefix);
    if (resolved) { selected = { host, ...resolved }; break; }
  }
  let noindex = configuredPreview || selected?.host.noindex === 1 || hosts.length > 0 && hosts.every((host) => host.noindex === 1);
  if (!selected) return notFound(noindex);
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(noindex);
  const { host, path, missingRootSlash } = selected;
  try {
    const cachedPointer = cachedLookup(lookups.pointers, host.site_id);
    let pointer = cachedPointer ?? await publishedPointer(env.DB, lookups.pointers, host.site_id);
    if (!pointer) return notFound(noindex);
    let discovery = await publishedDiscovery(request, env, path, host, pointer, noindex);
    if (discovery?.status === 503 && cachedPointer) {
      const latest = await publishedPointer(env.DB, lookups.pointers, host.site_id);
      if (latest && latest !== pointer) {
        pointer = latest;
        discovery = await publishedDiscovery(request, env, path, host, pointer, noindex);
      }
    }
    if (discovery) return discovery;
    let page = await matchPublishedPage(env, hostname, host, path, pointer);
    if (!page && cachedPointer) {
      // A new publication can move the pointer while this isolate still remembers its predecessor.
      const latest = await publishedPointer(env.DB, lookups.pointers, host.site_id);
      if (latest && latest !== pointer) page = await matchPublishedPage(env, hostname, host, path, latest);
    }
    if (!page) return await publishedRedirect(env, url, host, path, noindex) ?? notFound(noindex);
    const { route, row, robotsPolicy, publicationId, trailingSlash } = page;
    noindex = configuredPreview || row.noindex === 1 || route.noindex === true || robotsPolicy === "noindex";
    if (missingRootSlash) return redirectSlash(url, `${url.pathname}/`, noindex);
    if (trailingSlash) return redirectSlash(url, url.pathname.slice(0, -1), noindex);
    const embedRefs = url.searchParams.getAll("_niho_embed");
    if (embedRefs.length) {
      const requestedRef = embedRefs[0];
      if (embedRefs.length !== 1 || url.searchParams.size !== 1 || request.method !== "GET"
        || !requestedRef || !MANAGED_EMBED_REF.test(requestedRef)) return notFound(noindex);
      const embed = route.embeds?.find(({ refId }) => refId === requestedRef);
      if (!embed) return notFound(noindex);
      const headers = noindexHeader(noindex);
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ src: embed.src }), { status: 200, headers });
    }
    return await publishedHtml(request, url, env, host.site_id, publicationId, row, noindex, context);
  } catch (error) {
    if (noindex) return unavailable(true);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: PublicEnv, context: CacheWriteContext): Promise<Response> {
    try { return await publishedSiteRequest(request, env, context); }
    catch (error) {
      console.error("Published site request failed", error instanceof Error ? error.name : "UnknownError");
      const noindex = isConfiguredPreview(new URL(request.url), env);
      const headers = noindexHeader(noindex);
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Type", "text/plain; charset=utf-8");
      return new Response("Service Unavailable", { status: 503, headers });
    }
  }
};
