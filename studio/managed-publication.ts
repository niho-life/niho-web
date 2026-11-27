import type { ManagedD1 } from "./managed-sites.js";

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
};

export type PublishedSiteManifest = {
  readonly formatVersion: 1;
  readonly siteId: string;
  readonly publicationId: string;
  readonly createdAt: string;
  readonly routes: readonly PublishedRoute[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parsePublishedSiteManifest(value: unknown, siteId: string): PublishedSiteManifest | null {
  if (!SAFE_ID.test(siteId) || !isRecord(value) || !exactKeys(value, ["formatVersion", "siteId", "publicationId", "createdAt", "routes"])
    || value.formatVersion !== 1 || value.siteId !== siteId || typeof value.publicationId !== "string" || !SAFE_ID.test(value.publicationId)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.routes)) return null;
  const seen = new Set<string>();
  const routes: PublishedRoute[] = [];
  for (const candidate of value.routes) {
    if (!isRecord(candidate) || !exactKeys(candidate, ["pageId", "locale", "path", "sourceRevision", "artifactKey", "digest", "contentType", "contentSecurityPolicy"])
      || typeof candidate.pageId !== "string" || !SAFE_ID.test(candidate.pageId)
      || typeof candidate.locale !== "string" || !SAFE_LOCALE.test(candidate.locale)
      || typeof candidate.path !== "string" || !SAFE_PATH.test(candidate.path)
      || candidate.path !== "/" && candidate.path.endsWith("/")
      || !Number.isSafeInteger(candidate.sourceRevision) || Number(candidate.sourceRevision) < 1
      || typeof candidate.digest !== "string" || !HASH.test(candidate.digest)
      || candidate.artifactKey !== `managed-sites/${siteId}/artifacts/${candidate.digest}.html`
      || candidate.contentType !== "text/html; charset=utf-8"
      || typeof candidate.contentSecurityPolicy !== "string" || candidate.contentSecurityPolicy.length > 2048
      || /[\u0000-\u001f\u007f]/u.test(candidate.contentSecurityPolicy)) return null;
    const key = `${candidate.pageId}\u0000${candidate.locale}`;
    const pathKey = String(candidate.path);
    if (seen.has(key) || routes.some((route) => route.path === pathKey)) return null;
    seen.add(key);
    routes.push(candidate as unknown as PublishedRoute);
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
  readonly expectedVersion: string;
  readonly currentManifestKey: string | null;
}): Promise<PreparedPublishedSite> {
  const { bucket, siteId, publicationId, pageId, locale, path, sourceRevision, html } = input;
  if (!SAFE_ID.test(siteId) || !SAFE_ID.test(publicationId) || !SAFE_ID.test(pageId) || !SAFE_LOCALE.test(locale)
    || !SAFE_PATH.test(path) || path !== "/" && path.endsWith("/")
    || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || !html || html.length > 2_000_000
    || !input.expectedVersion || input.expectedVersion.length > 200) throw new Error("invalid managed publication input");

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
  const routes = previousRoutes.filter((route) => route.pageId !== pageId || route.locale !== locale);
  if (routes.some((route) => route.path === path)) throw new Error("published route is already owned by another page");
  routes.push({ pageId, locale, path, sourceRevision, artifactKey, digest: artifactDigest,
    contentType: "text/html; charset=utf-8", contentSecurityPolicy });
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.locale.localeCompare(b.locale) || a.pageId.localeCompare(b.pageId));
  const manifest: PublishedSiteManifest = {
    formatVersion: 1, siteId, publicationId, createdAt: new Date().toISOString(), routes
  };
  const manifestText = JSON.stringify(manifest);
  const manifestVersion = await sha256Text(manifestText);
  const manifestKey = `managed-sites/${siteId}/manifests/${manifestVersion}.json`;
  await putImmutable(bucket, manifestKey, manifestText);
  return { expectedVersion: input.expectedVersion, manifestKey, manifestVersion, artifactKey, artifactDigest, contentSecurityPolicy };
}

type PublicDatabase = Pick<ManagedD1, "prepare"> & {
  prepare(query: string): {
    bind(...values: readonly unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ readonly success: boolean; readonly results?: readonly T[] }> };
  };
};
type PublicEnv = {
  readonly DB: PublicDatabase;
  readonly CMS_OBJECTS: PublishedSiteReadObjectStore;
  readonly PUBLIC_SITES_PREVIEW_ORIGIN?: string;
};
type HostRow = { readonly site_id: string; readonly path_prefix: string; readonly noindex: number };
type PointerRow = { readonly manifest_key: string | null };
type ArtifactRow = { readonly artifact_key: string; readonly digest: string; readonly content_type: string; readonly content_security_policy: string };

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

export async function publishedSiteRequest(request: Request, env: PublicEnv): Promise<Response> {
  const url = new URL(request.url);
  const configuredPreview = isConfiguredPreview(url, env);
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.length > 253 || /[^a-z0-9.-]/u.test(hostname)) return notFound(configuredPreview);
  let hostResult: { readonly success: boolean; readonly results?: readonly HostRow[] };
  try {
    hostResult = await env.DB.prepare(`SELECT site_id, path_prefix, noindex FROM managed_site_hosts
      WHERE hostname = ?1 AND enabled = 1 ORDER BY length(path_prefix) DESC LIMIT 100`).bind(hostname).all<HostRow>();
  } catch (error) {
    if (configuredPreview) return unavailable(true);
    throw error;
  }
  if (!hostResult.success) {
    if (configuredPreview) return unavailable(true);
    throw new Error("managed site host query failed");
  }
  const hosts = hostResult.results ?? [];
  let selected: { readonly host: HostRow; readonly path: string; readonly missingRootSlash: boolean } | null = null;
  for (const host of hosts) {
    const resolved = resolveSitePath(url.pathname, host.path_prefix);
    if (resolved) { selected = { host, ...resolved }; break; }
  }
  const noindex = configuredPreview || selected?.host.noindex === 1 || hosts.length > 0 && hosts.every((host) => host.noindex === 1);
  if (!selected) return notFound(noindex);
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(noindex);
  const { host, path, missingRootSlash } = selected;
  try {
    const pointer = await env.DB.prepare("SELECT manifest_key FROM managed_site_publication_state WHERE site_id = ?1 LIMIT 1")
      .bind(host.site_id).first<PointerRow>();
    if (!pointer?.manifest_key) return notFound(noindex);
    const manifestObject = await env.CMS_OBJECTS.get(pointer.manifest_key);
    if (!manifestObject) return notFound(noindex);
    const manifest = parsePublishedSiteManifest(await manifestObject.json<unknown>(), host.site_id);
    if (!manifest) return notFound(noindex);

    if (missingRootSlash) {
      const headers = noindexHeader(host.noindex === 1);
      headers.set("Cache-Control", "no-store");
      const target = new URL(url.href);
      target.pathname += "/";
      headers.set("Location", target.href);
      if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(null, { status: 307, headers });
    }

    let route = manifest.routes.find((candidate) => candidate.path === path);
    if (!route && path !== "/" && path.endsWith("/")) {
      route = manifest.routes.find((candidate) => candidate.path === path.slice(0, -1));
      if (route) {
        const headers = noindexHeader(noindex);
        headers.set("Cache-Control", "no-store");
        const target = new URL(url.href);
        target.pathname = target.pathname.slice(0, -1);
        headers.set("Location", target.href);
        return new Response(null, { status: 307, headers });
      }
    }
    if (!route) return notFound(noindex);

    const row = await env.DB.prepare(`SELECT artifact_key, artifact_digest AS digest, content_type, content_security_policy
      FROM managed_page_publications
     WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND artifact_key = ?4 AND artifact_digest = ?5
       AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3
                   AND published_publication_id = managed_page_publications.id AND visibility = 'public')
     ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(host.site_id, route.pageId, route.locale, route.artifactKey, route.digest)
      .first<ArtifactRow>();
    if (!row || row.content_type !== route.contentType || row.content_security_policy !== route.contentSecurityPolicy) return notFound(noindex);
    const object = await env.CMS_OBJECTS.get(row.artifact_key);
    if (!object) return unavailable(noindex);
    const html = await object.text();
    if (await sha256Text(html) !== row.digest) return unavailable(noindex);
    const etag = `"${row.digest}"`;
    const headers = noindexHeader(noindex);
    headers.set("Content-Type", row.content_type);
    headers.set("Content-Security-Policy", row.content_security_policy);
    headers.set("Cache-Control", "no-cache");
    headers.set("ETag", etag);
    if (etagMatches(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
  } catch (error) {
    if (noindex) return unavailable(true);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: PublicEnv): Promise<Response> {
    try { return await publishedSiteRequest(request, env); }
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
