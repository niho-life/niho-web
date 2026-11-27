import type { ManagedD1, ManagedPublicHtmlCache } from "./managed-sites.js";
import { MANAGED_EMBED_REF } from "./managed-embed-contract.js";
import { parseManagedSiteRedirects, type ManagedSiteRedirect } from "../src/managed-site-redirects.js";

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
  /** Legacy manifests may contain page text until the next publication. */
  readonly text?: string;
  readonly textArtifactKey?: string;
  readonly textDigest?: string;
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
  readonly redirects?: readonly ManagedSiteRedirect[];
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
export type PreparedPublishedManifest = {
  readonly expectedVersion: string;
  readonly manifestKey: string;
  readonly manifestVersion: string;
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
    ...(Object.hasOwn(value, "robotsPolicy") ? ["robotsPolicy"] : []), ...(Object.hasOwn(value, "discoveryFiles") ? ["discoveryFiles"] : []),
    ...(Object.hasOwn(value, "redirects") ? ["redirects"] : [])])
    || value.formatVersion !== 1 || value.siteId !== siteId || typeof value.publicationId !== "string" || !SAFE_ID.test(value.publicationId)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.routes)
    || Object.hasOwn(value, "siteName") && (typeof value.siteName !== "string" || value.siteName.length > 300)
    || Object.hasOwn(value, "siteDescription") && (typeof value.siteDescription !== "string" || value.siteDescription.length > 1000)
    || Object.hasOwn(value, "robotsPolicy") && value.robotsPolicy !== "index" && value.robotsPolicy !== "noindex") return null;
  if (Object.hasOwn(value, "redirects") && !parseManagedSiteRedirects(value.redirects)) return null;
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
    const optionalRouteKeys = isRecord(candidate)
      ? ["title", "description", "text", "textArtifactKey", "textDigest", "lastModified", "noindex"].filter((key) => Object.hasOwn(candidate, key)) : [];
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
      || Object.hasOwn(candidate, "text") && Object.hasOwn(candidate, "textArtifactKey")
      || Object.hasOwn(candidate, "textArtifactKey") !== Object.hasOwn(candidate, "textDigest")
      || Object.hasOwn(candidate, "textDigest") && (typeof candidate.textDigest !== "string" || !HASH.test(candidate.textDigest)
        || candidate.textArtifactKey !== `managed-sites/${siteId}/texts/${candidate.textDigest}.txt`)
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
      ...(typeof candidate.textArtifactKey === "string" && typeof candidate.textDigest === "string"
        ? { textArtifactKey: candidate.textArtifactKey, textDigest: candidate.textDigest } : {}),
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

async function moveLegacyTextOutOfManifest(bucket: PublishedSiteObjectStore, siteId: string,
  routes: readonly PublishedRoute[]): Promise<PublishedRoute[]> {
  const migrated: PublishedRoute[] = [];
  for (const route of routes) {
    if (route.text === undefined) {
      migrated.push(route);
      continue;
    }
    const textDigest = await sha256Text(route.text);
    const textArtifactKey = `managed-sites/${siteId}/texts/${textDigest}.txt`;
    await putImmutable(bucket, textArtifactKey, route.text);
    const { text: _legacyText, ...withoutLegacyText } = route;
    migrated.push({ ...withoutLegacyText, textArtifactKey, textDigest });
  }
  return migrated;
}

export async function preparePublishedManifest(input: {
  readonly bucket: PublishedSiteObjectStore;
  readonly siteId: string;
  readonly publicationId: string;
  readonly expectedVersion: string;
  readonly currentManifestKey: string | null;
  readonly publicBaseUrl: string;
  readonly redirects?: readonly ManagedSiteRedirect[];
  readonly omitRoute?: { readonly pageId: string; readonly locale: string };
}): Promise<PreparedPublishedManifest> {
  const { bucket, siteId, publicationId } = input;
  if (!SAFE_ID.test(siteId) || !SAFE_ID.test(publicationId) || !input.expectedVersion || input.expectedVersion.length > 200
    || !input.currentManifestKey
    || !new RegExp(`^managed-sites/${siteId}/manifests/${HASH.source.slice(1, -1)}\\.json$`, "u").test(input.currentManifestKey)) {
    throw new Error("invalid managed manifest update input");
  }
  const object = await bucket.get(input.currentManifestKey);
  if (!object) throw new Error("current publication manifest missing");
  const previous = parsePublishedSiteManifest(await object.json<unknown>(), siteId);
  if (!previous) throw new Error("current publication manifest invalid");
  const routes = await moveLegacyTextOutOfManifest(bucket, siteId, previous.routes);
  const omitRoute = input.omitRoute;
  const activeRoutes = omitRoute
    ? routes.filter((route) => route.pageId !== omitRoute.pageId || route.locale !== omitRoute.locale)
    : routes;
  const redirects = input.redirects === undefined ? previous.redirects : parseManagedSiteRedirects(input.redirects);
  if (input.redirects !== undefined && !redirects) throw new Error("invalid managed publication redirects");
  const createdAt = new Date().toISOString();
  const discoveryFiles = await createDiscoveryFiles(bucket, siteId, activeRoutes, {
    publicBaseUrl: input.publicBaseUrl, siteName: previous.siteName ?? "", siteDescription: previous.siteDescription ?? "",
    robotsPolicy: previous.robotsPolicy ?? "index"
  });
  const manifest: PublishedSiteManifest = {
    formatVersion: 1, siteId, publicationId, createdAt, routes: activeRoutes,
    ...(redirects ? { redirects } : {}),
    ...(previous.siteName !== undefined ? { siteName: previous.siteName } : {}),
    ...(previous.siteDescription !== undefined ? { siteDescription: previous.siteDescription } : {}),
    ...(previous.robotsPolicy !== undefined ? { robotsPolicy: previous.robotsPolicy } : {}),
    discoveryFiles
  };
  const manifestText = JSON.stringify(manifest);
  const manifestVersion = await sha256Text(manifestText);
  const manifestKey = `managed-sites/${siteId}/manifests/${manifestVersion}.json`;
  await putImmutable(bucket, manifestKey, manifestText);
  return { expectedVersion: input.expectedVersion, manifestKey, manifestVersion };
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
  readonly redirects?: readonly ManagedSiteRedirect[];
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

  let previousRoutes: PublishedRoute[] = [];
  if (input.currentManifestKey) {
    if (!new RegExp(`^managed-sites/${siteId}/manifests/${HASH.source.slice(1, -1)}\\.json$`, "u").test(input.currentManifestKey)) {
      throw new Error("invalid current publication manifest key");
    }
    const object = await bucket.get(input.currentManifestKey);
    if (!object) throw new Error("current publication manifest missing");
    const previous = parsePublishedSiteManifest(await object.json<unknown>(), siteId);
    if (!previous) throw new Error("current publication manifest invalid");
    previousRoutes = await moveLegacyTextOutOfManifest(bucket, siteId, previous.routes);
  }

  const contentSecurityPolicy = input.contentSecurityPolicy ?? DEFAULT_PUBLISHED_CSP;
  const activeRouteKeys = input.activeRouteKeys ? new Set(input.activeRouteKeys.map(({ pageId: activePageId, locale: activeLocale }) => `${activePageId}\u0000${activeLocale}`)) : null;
  const routes = previousRoutes.filter((route) => (route.pageId !== pageId || route.locale !== locale)
    && (!activeRouteKeys || activeRouteKeys.has(`${route.pageId}\u0000${route.locale}`)));
  if (routes.some((route) => route.path === path)) throw new Error("published route is already owned by another page");
  const createdAt = new Date().toISOString();
  if (input.isPublic !== false) {
    let textArtifact: { readonly textArtifactKey: string; readonly textDigest: string } | undefined;
    if (input.text !== undefined) {
      const textDigest = await sha256Text(input.text);
      const textArtifactKey = `managed-sites/${siteId}/texts/${textDigest}.txt`;
      await putImmutable(bucket, textArtifactKey, input.text);
      textArtifact = { textArtifactKey, textDigest };
    }
    routes.push({ pageId, locale, path, sourceRevision, artifactKey, digest: artifactDigest,
      contentType: "text/html; charset=utf-8", contentSecurityPolicy, ...(embeds ? { embeds } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}),
      ...(textArtifact ?? {}), lastModified: createdAt, ...(input.noindex ? { noindex: true } : {}) });
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.locale.localeCompare(b.locale) || a.pageId.localeCompare(b.pageId));
  let discoveryFiles: PublishedDiscoveryFile[] | undefined;
  if (input.publicBaseUrl) {
    discoveryFiles = await createDiscoveryFiles(bucket, siteId, routes, {
      publicBaseUrl: input.publicBaseUrl, siteName: input.siteName ?? "", siteDescription: input.siteDescription ?? "",
      robotsPolicy: input.robotsPolicy ?? "index"
    });
  }
  const redirects = input.redirects === undefined ? undefined : parseManagedSiteRedirects(input.redirects);
  if (input.redirects !== undefined && !redirects) throw new Error("invalid managed publication redirects");
  const manifest: PublishedSiteManifest = {
    formatVersion: 1, siteId, publicationId, createdAt, routes, ...(redirects ? { redirects } : {}),
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

async function publishedText(bucket: PublishedSiteObjectStore, route: PublishedRoute): Promise<string> {
  if (route.text !== undefined) return route.text;
  if (!route.textArtifactKey || !route.textDigest) return "";
  const object = await bucket.get(route.textArtifactKey);
  if (!object) throw new Error("published text artifact missing");
  const text = await object.text();
  if (await sha256Text(text) !== route.textDigest) throw new Error("published text artifact invalid");
  return text;
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
  const fullParts = [markdown, "", "## Full text", ""];
  let fullLength = fullParts.reduce((length, part) => length + part.length + 1, 0);
  for (const route of routes) {
    if (fullLength >= 900_000) break;
    const text = await publishedText(bucket as PublishedSiteObjectStore, route);
    if (!text) continue;
    const section = `### ${markdownText(route.title || route.path, true)}\n\n${markdownText(text)}`;
    fullParts.push(section.slice(0, 900_000 - fullLength));
    fullLength += section.length + 1;
  }
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
type HostRow = { readonly site_id: string; readonly path_prefix: string; readonly noindex: number; readonly slug: string };
type PointerRow = { readonly manifest_key: string | null };
type CacheWriteContext = { waitUntil(promise: Promise<unknown>): void };
export type PublishedSiteHost = HostRow & { readonly path: string; readonly missingRootSlash: boolean };

const LOOKUP_TTL_MS = 5_000;
const MAX_LOOKUPS = 256;
const MAX_CACHED_MANIFESTS = 32;
const EDGE_CACHE_SECONDS = 3600;
const NOINDEX_DISCOVERY_ETAGS: Readonly<Record<string, string>> = {
  "/sitemap.xml": '"418dbdd4fc8c089c5e66a57636e085689ab9f24e3a9393b6fa7cf854ccb07bac"',
  "/robots.txt": '"331ea9090db0c9f6f597bd9840fd5b171830f6e0b3ba1cb24dfa91f0c95aedc1"',
  "/llms.txt": '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
  "/llms-full.txt": '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"'
};
type Lookup<T> = Map<string, { readonly value: T; readonly expiresAt: number }>;
type PublicationLookups = {
  readonly hosts: Lookup<readonly HostRow[]>;
  readonly pointers: Lookup<string | null>;
  readonly manifests: Map<string, PublishedSiteManifest>;
};
const lookupsByDatabase = new WeakMap<PublicDatabase, PublicationLookups>();

function publicationLookups(db: PublicDatabase): PublicationLookups {
  let lookups = lookupsByDatabase.get(db);
  if (!lookups) {
    lookups = { hosts: new Map(), pointers: new Map(), manifests: new Map() };
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

async function publicHosts(db: PublicDatabase, entries: Lookup<readonly HostRow[]>, hostname: string, refresh = false): Promise<readonly HostRow[]> {
  const cached = refresh ? undefined : cachedLookup(entries, hostname);
  if (cached !== undefined) return cached;
  const startedAt = Date.now();
  const result = await db.prepare(`SELECT host.site_id, host.path_prefix, host.noindex, site.slug FROM managed_site_hosts AS host
    JOIN managed_sites AS site ON site.site_id = host.site_id
    WHERE host.hostname = ?1 AND host.enabled = 1 ORDER BY length(host.path_prefix) DESC LIMIT 100`).bind(hostname).all<HostRow>();
  if (!result.success) throw new Error("managed site host query failed");
  const hosts = result.results ?? [];
  rememberLookup(entries, hostname, hosts, startedAt);
  return hosts;
}

/** Resolve a registered host through the same short-lived lookup cache as public delivery. */
export async function resolvePublishedSiteHost(request: Request, db: PublicDatabase, refresh = false): Promise<PublishedSiteHost | null> {
  const url = new URL(request.url), hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.length > 253 || /[^a-z0-9.-]/u.test(hostname)) return null;
  const hosts = await publicHosts(db, publicationLookups(db).hosts, hostname, refresh);
  for (const host of hosts) {
    const resolved = resolveSitePath(url.pathname, host.path_prefix);
    if (resolved) return { ...host, ...resolved };
  }
  return null;
}

async function publishedPointer(db: PublicDatabase, entries: Lookup<string | null>, siteId: string, refresh = false): Promise<string | null> {
  const cached = refresh ? undefined : cachedLookup(entries, siteId);
  if (cached !== undefined) return cached;
  const startedAt = Date.now();
  const row = await db.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?1 LIMIT 1")
    .bind(siteId).first<PointerRow>();
  if (row?.manifest_key) rememberLookup(entries, siteId, row.manifest_key, startedAt);
  else entries.delete(siteId);
  return row?.manifest_key ?? null;
}

async function publishedManifest(env: PublicEnv, entries: PublicationLookups, siteId: string, key: string): Promise<PublishedSiteManifest | null> {
  const cached = entries.manifests.get(key);
  if (cached) return cached;
  const object = await env.CMS_OBJECTS.get(key);
  if (!object) return null;
  const manifest = parsePublishedSiteManifest(await object.json<unknown>(), siteId);
  if (!manifest) return null;
  if (entries.manifests.size >= MAX_CACHED_MANIFESTS) {
    const oldest = entries.manifests.keys().next();
    if (!oldest.done) entries.manifests.delete(oldest.value);
  }
  entries.manifests.set(key, manifest);
  return manifest;
}

function noindexHeader(enabled: boolean): Headers {
  const headers = new Headers({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
  if (enabled) headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

function notFound(noindex: boolean): Response {
  const headers = noindexHeader(noindex);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return new Response("<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex, nofollow\"><title>ページが見つかりません</title><main><h1>ページが見つかりません</h1><p>お探しのページは移動したか、公開を終了しました。</p></main></html>", { status: 404, headers });
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

function matchPublishedPage(manifest: PublishedSiteManifest, path: string) {
  const exact = manifest.routes.find((candidate) => candidate.path === path);
  const route = exact ?? manifest.routes.find((candidate) => path.endsWith("/") && candidate.path === path.slice(0, -1));
  if (!route) return null;
  return { route, robotsPolicy: manifest.robotsPolicy, publicationId: manifest.publicationId, trailingSlash: !exact };
}

async function htmlCache(env: PublicEnv): Promise<ManagedPublicHtmlCache | undefined> {
  if (env.PUBLIC_HTML_CACHE) return env.PUBLIC_HTML_CACHE;
  try {
    return await globalThis.caches?.open("niho-public-html-v1");
  } catch { return undefined; }
}

async function publishedHtml(request: Request, url: URL, env: PublicEnv, siteId: string, publicationId: string, route: PublishedRoute,
  noindex: boolean, context?: CacheWriteContext): Promise<Response> {
  const etag = `"${route.digest}"`;
  const headers = noindexHeader(noindex);
  headers.set("Content-Type", route.contentType);
  headers.set("Content-Security-Policy", route.contentSecurityPolicy);
  headers.set("Cache-Control", "no-cache");
  headers.set("ETag", etag);
  const notModified = etagMatches(request.headers.get("If-None-Match"), etag);
  const status = notModified ? 304 : 200;
  const sendBody = !notModified && request.method !== "HEAD";
  const cache = await htmlCache(env);
  const key = new Request(`${url.origin}/_niho-cache/publication/${siteId}/${publicationId}/${route.digest}`);
  if (cache) {
    try {
      const cached = await cache.match(key);
      if (cached?.status === 200 && cached.headers.get("ETag") === etag && cached.body) {
        if (!sendBody) void cached.body.cancel().catch(() => undefined);
        return new Response(sendBody ? cached.body : null, { status, headers });
      }
    } catch { /* Cache API is an optional optimization. */ }
  }
  const object = await env.CMS_OBJECTS.get(route.artifactKey);
  if (!object) return unavailable(noindex);
  const html = await object.text();
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
  return new Response(null, { status: 308, headers });
}

async function publishedDiscovery(request: Request, env: PublicEnv, path: string, manifest: PublishedSiteManifest,
  noindex: boolean): Promise<Response | null> {
  if (!(DISCOVERY_PATHS as readonly string[]).includes(path)) return null;
  const responseNoindex = noindex || manifest.robotsPolicy === "noindex";
  const file = manifest.discoveryFiles?.find((candidate) => candidate.path === path);
  if (!file) return notFound(noindex);
  const headers = path === "/sitemap.xml" ? xmlHeader(responseNoindex) : noindexHeader(responseNoindex);
  if (path !== "/sitemap.xml") headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  if (responseNoindex) {
    const body = path === "/sitemap.xml"
      ? `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"></urlset>`
      : path === "/robots.txt" ? "User-agent: *\nDisallow: /\n" : "";
    const etag = NOINDEX_DISCOVERY_ETAGS[path]!;
    headers.set("ETag", etag);
    const notModified = etagMatches(request.headers.get("If-None-Match"), etag);
    return new Response(request.method === "HEAD" || notModified ? null : body, { status: notModified ? 304 : 200, headers });
  }
  const etag = `"${file.digest}"`;
  headers.set("ETag", etag);
  const notModified = etagMatches(request.headers.get("If-None-Match"), etag);
  if (notModified) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const artifact = await env.CMS_OBJECTS.get(file.artifactKey);
  if (!artifact) return unavailable(noindex);
  const body = await artifact.text();
  return new Response(body, { status: 200, headers });
}

function publishedRedirect(url: URL, host: HostRow, manifest: PublishedSiteManifest, path: string, noindex: boolean): Response | null {
  const redirect = manifest.redirects?.find((candidate) => candidate.fromPath === path);
  if (!redirect) return null;
  const prefix = host.path_prefix === "/" ? "" : host.path_prefix.replace(/\/+$/u, "");
  const target = new URL(url.href);
  target.pathname = `${prefix}${redirect.toPath}`;
  const headers = noindexHeader(noindex);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Location", target.href);
  return new Response(null, { status: 301, headers });
}

export async function publishedSiteRequest(request: Request, env: PublicEnv, context?: CacheWriteContext,
  resolvedHost?: PublishedSiteHost): Promise<Response> {
  const url = new URL(request.url);
  const configuredPreview = isConfiguredPreview(url, env);
  const bypassCache = request.headers.get("Cache-Control")?.toLowerCase().split(",").some((value) => value.trim() === "no-cache") ?? false;
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
  const lookups = publicationLookups(env.DB);
  let hosts: readonly HostRow[] = [];
  let selected: { readonly host: HostRow; readonly path: string; readonly missingRootSlash: boolean } | null = resolvedHost
    ? { host: resolvedHost, path: resolvedHost.path, missingRootSlash: resolvedHost.missingRootSlash } : null;
  if (!selected) {
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname.length > 253 || /[^a-z0-9.-]/u.test(hostname)) return notFound(configuredPreview);
    try {
      hosts = await publicHosts(env.DB, lookups.hosts, hostname, bypassCache);
    } catch (error) {
      if (configuredPreview) return unavailable(true);
      throw error;
    }
    for (const host of hosts) {
      const resolved = resolveSitePath(url.pathname, host.path_prefix);
      if (resolved) { selected = { host, ...resolved }; break; }
    }
  }
  let noindex = configuredPreview || selected?.host.noindex === 1 || hosts.length > 0 && hosts.every((host) => host.noindex === 1);
  if (!selected) return notFound(noindex);
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(noindex);
  const { host, path, missingRootSlash } = selected;
  try {
    const cachedPointer = bypassCache ? undefined : cachedLookup(lookups.pointers, host.site_id);
    let pointer = await publishedPointer(env.DB, lookups.pointers, host.site_id, bypassCache);
    if (!pointer) return notFound(noindex);
    let manifest = await publishedManifest(env, lookups, host.site_id, pointer);
    if (!manifest) return unavailable(noindex);
    const discovery = await publishedDiscovery(request, env, path, manifest, noindex);
    if (discovery) return discovery;
    let page = matchPublishedPage(manifest, path);
    if (!page && cachedPointer && !bypassCache) {
      const latest = await publishedPointer(env.DB, lookups.pointers, host.site_id, true);
      if (latest && latest !== pointer) {
        pointer = latest;
        manifest = await publishedManifest(env, lookups, host.site_id, pointer) ?? manifest;
        page = matchPublishedPage(manifest, path);
      }
    }
    if (!page) return publishedRedirect(url, host, manifest, path, noindex) ?? notFound(noindex);
    const { route, robotsPolicy, publicationId, trailingSlash } = page;
    noindex = configuredPreview || host.noindex === 1 || route.noindex === true || robotsPolicy === "noindex";
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
    return await publishedHtml(request, url, env, host.site_id, publicationId, route, noindex, context);
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
