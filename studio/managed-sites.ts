import { CmsStore, cmsPathReserved, digest, nowSeconds, type CmsPublishCommit, type Site } from "./managed-cms-store.js";
import { ManagedPagePublicationError, prepareManagedPagePublicationBatch, type ManagedPagePublicationTarget } from "./managed-page-publication.js";
import { loadPublishedSiteManifest, preparePublishedManifest, type PreparedPublishedManifest, type PublishedRoute, type PublishedSiteManifest } from "./managed-publication.js";
import { prepareManagedCmsStaticRoutes } from "./managed-cms-static.js";
import { MAX_MANAGED_PAGE_BYTES, readPageSource, readPageSourceObject, storePageSource, type PageSourceRow } from "./managed-page-source.js";
import { parsePageDocument, type PageDocument } from "../src/core.js";
import { cmsPageBindingProblems, parseCmsPageBindings, resolveCmsPageBindings, type CmsPageBindingsDocument } from "../src/cms-page-bindings.js";
import { cmsId, cmsItemKey } from "../src/cms-v2-schema.js";
import type { CmsReleaseSnapshot } from "../src/cms-v2.js";
import { isEditingApiVersion } from "../src/editing-client.js";
import { createPageEditingApi, type EditingActor, type EditingCapability, type EditingPageTarget,
  type EditingPublicationChanges, type EditingSitePublishInput, type EditingSitePublishResult } from "../src/editing-api.js";
import type { EditingPageApplied } from "../src/editing-page-operations.js";
import { normalizePageChange, pageChangeProblems } from "../src/editor-model.js";
import type { EditorPage, EditorPageChange, EditorPublishPageInput } from "../src/editor-types.js";
import { matchesTemplatePath, validatePagePath } from "../src/pages.js";
import { emptyManagedPublicPolicy, managedBlockContracts, parseManagedPublicPolicy, registeredNihoEmbed } from "./managed-embed-contract.js";
import type { ManagedPublicPolicy } from "./managed-embed-contract.js";
import { parseManagedSiteSeoSettings } from "../src/managed-seo-settings.js";
import { parseManagedSiteRedirects, type ManagedSiteRedirect } from "../src/managed-site-redirects.js";
import { managedSiteStylesAdapter, readManagedPublishedSiteStyles, readManagedSiteStyles } from "./managed-site-styles.js";
import type { EditingSiteStylesPublishRequest, EditingSiteStylesPublishResult } from "../src/editing-site-styles.js";

type D1Meta = { readonly changes?: number };
type D1Result<T> = { readonly results?: readonly T[]; readonly success: boolean; readonly meta?: D1Meta };
type D1Statement = {
  bind(...values: readonly unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
};
export type ManagedD1 = {
  prepare(query: string): D1Statement;
  batch<T>(statements: readonly D1Statement[]): Promise<readonly D1Result<T>[]>;
};
export type ManagedPublicHtmlCache = {
  match(request: Request): Promise<Response | undefined | null>;
  put(request: Request, response: Response): Promise<void>;
};
export type ManagedActor = {
  readonly subject: string;
  readonly email: string;
  readonly cliClientId?: string;
  /** CLI はブラウザの Origin / Sec-Fetch-Site を持たない。 */
  readonly cli: boolean;
};
export type ManagedProjectRegistration = {
  readonly project_id: string;
  readonly site_id: string;
  readonly slug: string;
  readonly public_domain: string | null;
  readonly published_page_count: number;
  readonly published_path: string | null;
  readonly updated_at: number | null;
  readonly last_published_at: number | null;
};

type ManagedPageRow = PageSourceRow & {
  readonly project_id: string;
  readonly site_id: string;
  readonly slug: string;
  readonly public_domain: string | null;
  readonly cms_locale: string;
  readonly title: string;
  readonly path: string;
  readonly visibility: "public" | "private";
  readonly current_version: string;
  readonly page_catalog_version: string;
  readonly current_revision: number;
  readonly published_revision: number | null;
  readonly bindings_json: string | null;
};

const CMS_DETAIL_SLUG = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const MANIFEST_VERSION = /^[0-9a-f]{64}$/u;
const PRIMARY_DOMAIN = "(SELECT host.hostname FROM managed_site_hosts AS host WHERE host.site_id = ms.site_id AND host.is_primary = 1 AND host.path_prefix = '' LIMIT 1)";
const MAX_EDITOR_BODY = MAX_MANAGED_PAGE_BYTES;
const MAX_MUTATION_BODY = 16 * 1024;


function responseHeaders(contentType = "application/json; charset=utf-8"): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders() });
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function changed(result: D1Result<unknown> | undefined): boolean {
  return result?.success === true && result.meta?.changes === 1;
}
function safeTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value);
}
type ManagedSeoWarning = { code: "missing-description" | "missing-alt" | "japanese-in-english" | "duplicate-title" | "duplicate-description" | "broken-internal-link"; message: string };

function boundedManagedSeoWarnings(warnings: readonly ManagedSeoWarning[]): ManagedSeoWarning[] {
  return warnings.slice(0, 100).map((warning) => ({ ...warning,
    message: warning.message.length <= 1000 ? warning.message : `${warning.message.slice(0, 999).replace(/[\uD800-\uDBFF]$/u, "")}…`
  }));
}

function seoComparisonKey(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  return normalized || null;
}

function opaqueVersion(): string { return `p.${crypto.randomUUID()}`; }
function opaqueId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function managedProjectD1FailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/CHECK constraint/iu.test(message)) return "d1-check-constraint";
  if (/FOREIGN KEY constraint/iu.test(message)) return "d1-foreign-key-constraint";
  if (/UNIQUE constraint/iu.test(message)) return "d1-unique-constraint";
  return "d1-error";
}

export function publicSitesOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.origin === value && url.pathname === "/" && !url.search && !url.hash ? value : null;
  } catch { return null; }
}
export function managedPageUrl(origin: string, slug: string, path: string, customDomain?: string | null): string {
  return customDomain ? `https://${customDomain}${path}` : `${origin}/s/${slug}${path}`;
}

function normalizeManagedPublicDomain(value: unknown, requestHost: string, publicHost: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 253 || value !== value.trim() || /[\u0000-\u0020\u007f/:?#@\\]/u.test(value)) return null;
  const domain = value.toLowerCase();
  if (domain.length < 4 || domain === requestHost || domain === publicHost ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) return null;
  return domain;
}

export async function readJson(request: Request, actor: ManagedActor, maximum: number): Promise<Record<string, unknown> | null> {
  if (!actor.cli && (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("Sec-Fetch-Site") !== "same-origin")) return null;
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) return null;
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); }
  catch { return null; }
}

function initialDocument(siteId: string, pageId: string, locale: string, title: string): PageDocument {
  return parsePageDocument({
    schemaVersion: 1, siteId, pageId, locale, revision: 1, title, tokens: {},
    body: [{ type: "element", id: "main", tag: "main", children: [
      { type: "element", id: "heading", tag: "h1", children: [{ type: "text", text: title }] }
    ] }]
  });
}

export async function createManagedProject(request: Request, store: CmsStore, actor: ManagedActor, origin: string, previewOrigin?: string | null): Promise<Response> {
  const { db, bucket } = store;
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["title", "slug", "locale"]) || !safeTitle(body.title)
    || typeof body.slug !== "string" || body.slug.length > 63 || !SLUG.test(body.slug)
    || typeof body.locale !== "string" || body.locale.length > 40 || !LOCALE.test(body.locale)) return json({ error: "invalid_request" }, 400);
  if (origin === new URL(request.url).origin) return json({ error: "public_origin_must_be_separate" }, 503);
  const existing = await db.prepare("SELECT 1 AS found FROM managed_sites WHERE slug = ?1 LIMIT 1").bind(body.slug).first<{ readonly found: number }>();
  if (existing) return json({ error: "slug_taken" }, 409);

  const projectId = opaqueId("project"), siteId = opaqueId("site"), pageId = "home", version = opaqueVersion();
  const document = initialDocument(siteId, pageId, body.locale, body.title);
  const source = await storePageSource(bucket, document, version);
  if (!source) return json({ error: "invalid_document" }, 400);
  const displayName = actor.email.length <= 120 ? actor.email : "Project owner";
  const hostname = new URL(origin).hostname.toLowerCase(), previewHostname = previewOrigin ? new URL(previewOrigin).hostname.toLowerCase() : null;
  const expectedStatementCount = 8 + (previewHostname && previewHostname !== hostname ? 1 : 0);
  let results: readonly D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare("INSERT INTO projects (id, name) VALUES (?1, ?2)").bind(projectId, body.title),
      db.prepare("INSERT INTO sites (id, project_id, name, public_origin) VALUES (?1, ?2, ?3, NULL)").bind(siteId, projectId, body.title),
      db.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?1, ?2, 'owner', ?3, ?4)").bind(projectId, actor.subject, displayName, actor.email),
      db.prepare("INSERT INTO managed_sites (site_id, slug, created_by_subject) VALUES (?1, ?2, ?3)").bind(siteId, body.slug, actor.subject),
      db.prepare("INSERT INTO managed_pages (site_id, page_id, locale, title, path, visibility, current_version, current_revision) VALUES (?1, ?2, ?3, ?4, '/', 'public', ?5, 1)")
        .bind(siteId, pageId, body.locale, body.title, version),
      db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject,
                                                       document_key, document_digest, link_index_json)
                  VALUES (?1, ?2, ?3, 1, '{}', 'initial', ?4, ?5, ?6, ?7)`)
        .bind(siteId, pageId, body.locale, actor.subject, source.key, source.digest, source.linkIndex),
      db.prepare("INSERT INTO managed_site_hosts (hostname, path_prefix, site_id, noindex, is_primary) VALUES (?1, ?2, ?3, 0, 1)")
        .bind(hostname, `/s/${body.slug}`, siteId),
      ...(previewHostname && previewHostname !== hostname ? [db.prepare("INSERT INTO managed_site_hosts (hostname, path_prefix, site_id, noindex) VALUES (?1, ?2, ?3, 1)")
        .bind(previewHostname, `/s/${body.slug}`, siteId)] : []),
      db.prepare("INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id) VALUES (?1, ?2, ?3, ?4, 'site.created', 'home')")
        .bind(crypto.randomUUID(), projectId, siteId, actor.subject)
    ]);
  } catch (error) {
    if (error instanceof Error && /(?:UNIQUE|managed_sites\.slug)/iu.test(error.message)) return json({ error: "slug_taken" }, 409);
    console.error("NIHO Studio managed project D1 batch failed", managedProjectD1FailureKind(error));
    throw error;
  }
  const failedStatements = results.flatMap((result, index) => result.success ? [] : [index]);
  if (results.length !== expectedStatementCount || failedStatements.length) {
    console.error("NIHO Studio managed project D1 batch returned an invalid result", failedStatements.length ? failedStatements : "statement-count-mismatch");
    throw new Error("managed project batch failed");
  }
  return json({ status: "created", projectId, siteId, editorPath: `/projects/${projectId}/sites/${siteId}/editor` }, 201);
}

export async function managedRegistration(db: ManagedD1, projectId: string, siteId: string): Promise<{ readonly slug: string; readonly public_domain: string | null; readonly site_name: string } | null> {
  return db.prepare(`SELECT ms.slug, ${PRIMARY_DOMAIN} AS public_domain, s.name AS site_name FROM managed_sites AS ms JOIN sites AS s ON s.id = ms.site_id WHERE s.project_id = ?1 AND s.id = ?2 LIMIT 1`)
    .bind(projectId, siteId).first<{ readonly slug: string; readonly public_domain: string | null; readonly site_name: string }>();
}

async function managedMemberRegistration(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string): Promise<{ readonly slug: string; readonly public_domain: string | null; readonly site_name: string } | null> {
  return db.prepare(`
    SELECT ms.slug, ${PRIMARY_DOMAIN} AS public_domain, s.name AS site_name
      FROM project_members AS member
      JOIN sites AS s ON s.project_id = member.project_id
      JOIN managed_sites AS ms ON ms.site_id = s.id
     WHERE member.access_subject = ?1 AND member.project_id = ?2 AND s.id = ?3
       AND member.role IN ('owner', 'editor')
     LIMIT 1
  `).bind(actor.subject, projectId, siteId).first<{ readonly slug: string; readonly public_domain: string | null; readonly site_name: string }>();
}

async function managedPublicSettings(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Response> {
  const ownerScope = `EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
    WHERE s.id = ?1 AND s.project_id = ?2 AND member.access_subject = ?3 AND member.role = 'owner')`;
  if (request.method === "GET") {
    const row = await db.prepare(`SELECT public_policy_json, public_policy_version FROM managed_sites WHERE site_id = ?1 AND ${ownerScope}`)
      .bind(siteId, projectId, actor.subject).first<{ public_policy_json: string; public_policy_version: string }>();
    if (!row) return json({ error: "forbidden" }, 403);
    const settings = parseManagedPublicPolicy(JSON.parse(row.public_policy_json), origin);
    return settings ? json({ settings, version: row.public_policy_version }) : json({ error: "invalid_settings" }, 500);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const owner = await db.prepare(`SELECT 1 AS allowed WHERE ${ownerScope}`)
    .bind(siteId, projectId, actor.subject).first<{ allowed: number }>();
  if (!owner) return json({ error: "forbidden" }, 403);
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["settings", "expectedVersion"]) || typeof body.expectedVersion !== "string") return json({ error: "invalid_request" }, 400);
  let settingsInput = body.settings;
  if (settingsInput && typeof settingsInput === "object" && !Array.isArray(settingsInput) && !Object.hasOwn(settingsInput, "seo")) {
    const current = await db.prepare(`SELECT public_policy_json FROM managed_sites WHERE site_id = ?1 AND ${ownerScope}`)
      .bind(siteId, projectId, actor.subject).first<{ public_policy_json: string }>();
    try {
      const currentPolicy = current && parseManagedPublicPolicy(JSON.parse(current.public_policy_json), origin);
      if (currentPolicy) settingsInput = { ...settingsInput,
        seo: { ...currentPolicy.seo, ...(Object.hasOwn(settingsInput, "ga4MeasurementId") ? { ga4MeasurementId: (settingsInput as Record<string, unknown>).ga4MeasurementId as string | null } : {}) } };
    } catch { return json({ error: "invalid_settings" }, 500); }
  }
  const settings = parseManagedPublicPolicy(settingsInput, origin);
  if (!settings) return json({ error: "invalid_settings" }, 422);
  const version = opaqueVersion();
  const [result] = await db.batch([db.prepare(`UPDATE managed_sites SET public_policy_json = ?4, public_policy_version = ?5
    WHERE site_id = ?1 AND public_policy_version = ?6 AND ${ownerScope}`)
    .bind(siteId, projectId, actor.subject, JSON.stringify({ ...settings, ga4MeasurementId: settings.seo.ga4MeasurementId }), version, body.expectedVersion)]);
  return changed(result) ? json({ settings, version }) : json({ error: "conflict" }, 409);
}

async function managedPublicSeoSettings(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Response> {
  const ownerScope = `EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
    WHERE s.id = ?1 AND s.project_id = ?2 AND member.access_subject = ?3 AND member.role = 'owner')`;
  if (request.method === "GET") {
    const row = await db.prepare(`SELECT public_policy_json, public_policy_version FROM managed_sites WHERE site_id = ?1 AND ${ownerScope}`)
      .bind(siteId, projectId, actor.subject).first<{ public_policy_json: string; public_policy_version: string }>();
    if (!row) return json({ error: "forbidden" }, 403);
    try {
      const policy = parseManagedPublicPolicy(JSON.parse(row.public_policy_json), origin);
      return policy ? json({ settings: policy.seo, version: row.public_policy_version }) : json({ error: "invalid_settings" }, 500);
    } catch { return json({ error: "invalid_settings" }, 500); }
  }
  if (request.method !== "POST" && request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["settings", "expectedVersion"]) || typeof body.expectedVersion !== "string") return json({ error: "invalid_request" }, 400);
  const seo = parseManagedSiteSeoSettings(body.settings);
  if (!seo) return json({ error: "invalid_settings" }, 422);
  const current = await db.prepare(`SELECT public_policy_json, public_policy_version FROM managed_sites WHERE site_id = ?1 AND ${ownerScope}`)
    .bind(siteId, projectId, actor.subject).first<{ public_policy_json: string; public_policy_version: string }>();
  if (!current) return json({ error: "forbidden" }, 403);
  let policy: ManagedPublicPolicy;
  try {
    const parsed = parseManagedPublicPolicy(JSON.parse(current.public_policy_json), origin);
    if (!parsed) return json({ error: "invalid_settings" }, 500);
    policy = { ...parsed, seo };
    if (!parseManagedPublicPolicy(policy, origin)) return json({ error: "invalid_settings" }, 422);
  } catch { return json({ error: "invalid_settings" }, 500); }
  const version = opaqueVersion();
  const [result] = await db.batch([db.prepare(`UPDATE managed_sites SET public_policy_json = ?4, public_policy_version = ?5
    WHERE site_id = ?1 AND public_policy_version = ?6 AND ${ownerScope}`)
    .bind(siteId, projectId, actor.subject, JSON.stringify({ ...policy, ga4MeasurementId: seo.ga4MeasurementId }), version, body.expectedVersion)]);
  return changed(result) ? json({ settings: seo, version }) : json({ error: "conflict" }, 409);
}

async function managedSiteRedirects(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string,
  origin: string, store?: CmsStore): Promise<Response> {
  const ownerScope = `EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
    WHERE s.id = ?1 AND s.project_id = ?2 AND member.access_subject = ?3 AND member.role = 'owner')`;
  if (request.method === "GET") {
    const result = await db.prepare(`SELECT ms.redirect_version, redirect.locale, redirect.from_path, redirect.to_path
      FROM managed_sites AS ms LEFT JOIN managed_site_redirects AS redirect ON redirect.site_id = ms.site_id
      WHERE ms.site_id = ?1 AND ${ownerScope} ORDER BY redirect.from_path`)
      .bind(siteId, projectId, actor.subject).all<{ redirect_version: string; locale: string | null; from_path: string | null; to_path: string | null }>();
    const rows = result.results ?? [];
    if (!rows.length) return json({ error: "forbidden" }, 403);
    const redirects = rows.flatMap((row): ManagedSiteRedirect[] => row.locale === null || row.from_path === null || row.to_path === null
      ? [] : [{ locale: row.locale, fromPath: row.from_path, toPath: row.to_path }]);
    return json({ redirects, version: rows[0]!.redirect_version });
  }
  if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
  const body = await readJson(request, actor, 512 * 1024);
  if (!body || !exactKeys(body, ["redirects", "expectedVersion"]) || typeof body.expectedVersion !== "string") return json({ error: "invalid_request" }, 400);
  const redirects = parseManagedSiteRedirects(body.redirects);
  if (!redirects) return json({ error: "invalid_redirects" }, 422);
  const current = await db.prepare(`SELECT redirect_version FROM managed_sites WHERE site_id = ?1 AND ${ownerScope}`)
    .bind(siteId, projectId, actor.subject).first<{ redirect_version: string }>();
  if (!current) return json({ error: "forbidden" }, 403);
  const [registration, state] = await Promise.all([
    managedRegistration(db, projectId, siteId),
    db.prepare("SELECT version, manifest_key FROM managed_site_publication_state WHERE site_id = ?1 LIMIT 1")
      .bind(siteId).first<{ version: string; manifest_key: string | null }>()
  ]);
  if (!registration) return json({ error: "forbidden" }, 403);
  let preparedManifest: PreparedPublishedManifest | null = null;
  if (state?.manifest_key) {
    if (!store) return json({ error: "publication_storage_unavailable" }, 503);
    try {
      preparedManifest = await preparePublishedManifest({ bucket: store.bucket, siteId, publicationId: crypto.randomUUID(),
        expectedVersion: state.version, currentManifestKey: state.manifest_key, redirects,
        publicBaseUrl: registration.public_domain ? `https://${registration.public_domain}` : `${origin}/s/${registration.slug}` });
    } catch { return json({ error: "publication_artifact_generation_failed" }, 503); }
  }
  const version = opaqueVersion();
  const expectedVersion = body.expectedVersion;
  const results = await db.batch([
    db.prepare(`DELETE FROM managed_site_redirects WHERE site_id = ?1 AND EXISTS (
      SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.redirect_version = ?2 AND EXISTS (
        SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?1 AND s.project_id = ?3 AND member.access_subject = ?4 AND member.role = 'owner')
        AND (?5 IS NULL OR EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?1 AND version = ?5)))`)
      .bind(siteId, expectedVersion, projectId, actor.subject, preparedManifest?.expectedVersion ?? null),
    db.prepare(`INSERT INTO managed_site_redirects (site_id, locale, from_path, to_path)
      SELECT ?1, json_extract(value, '$.locale'), json_extract(value, '$.fromPath'), json_extract(value, '$.toPath') FROM json_each(?2)
      WHERE EXISTS (SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.redirect_version = ?3 AND EXISTS (
        SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?1 AND s.project_id = ?4 AND member.access_subject = ?5 AND member.role = 'owner')
        AND (?6 IS NULL OR EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?1 AND version = ?6)))`)
      .bind(siteId, JSON.stringify(redirects), expectedVersion, projectId, actor.subject, preparedManifest?.expectedVersion ?? null),
    db.prepare(`UPDATE managed_sites SET redirect_version = ?1
      WHERE site_id = ?2 AND redirect_version = ?3 AND EXISTS (SELECT 1 FROM sites AS s
        JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?2 AND s.project_id = ?4 AND member.access_subject = ?5 AND member.role = 'owner')
        AND (?6 IS NULL OR EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?2 AND version = ?6))`)
      .bind(version, siteId, expectedVersion, projectId, actor.subject, preparedManifest?.expectedVersion ?? null),
    ...(preparedManifest ? [db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
      WHERE site_id = ?3 AND version = ?4 AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?3 AND redirect_version = ?5)`)
      .bind(preparedManifest.manifestVersion, preparedManifest.manifestKey, siteId, preparedManifest.expectedVersion, version)] : [])
  ]);
  return changed(results[2]!) && (!preparedManifest || changed(results[3]!))
    ? json({ redirects, version }) : json({ error: "conflict" }, 409);
}

async function managedPublicDomain(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Response> {
  const ownerScope = `EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
    WHERE s.id = ?1 AND s.project_id = ?2 AND member.access_subject = ?3 AND member.role = 'owner')`;
  const sharedHostname = new URL(origin).hostname.toLowerCase();
  if (request.method === "GET") {
    const row = await db.prepare(`SELECT ${PRIMARY_DOMAIN} AS domain,
        COALESCE((SELECT host.noindex FROM managed_site_hosts AS host WHERE host.site_id = ms.site_id AND host.is_primary = 1 AND host.path_prefix = '' LIMIT 1), 1) AS noindex,
        ms.public_domain_version AS version
      FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ${ownerScope}`)
      .bind(siteId, projectId, actor.subject).first<{ domain: string | null; noindex: number; version: string }>();
    return row ? json({ domain: row.domain, noindex: row.noindex === 1, version: row.version }) : json({ error: "forbidden" }, 403);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const owner = await db.prepare(`SELECT 1 AS allowed WHERE ${ownerScope}`)
    .bind(siteId, projectId, actor.subject).first<{ allowed: number }>();
  if (!owner) return json({ error: "forbidden" }, 403);
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["domain", "expectedVersion", "noindex"]) || typeof body.expectedVersion !== "string" || typeof body.noindex !== "boolean") return json({ error: "invalid_request" }, 400);
  const domain = normalizeManagedPublicDomain(body.domain, new URL(request.url).hostname, new URL(origin).hostname);
  if (body.domain !== null && !domain) return json({ error: "invalid_domain" }, 422);
  const version = opaqueVersion();
  let results: readonly D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(`DELETE FROM managed_site_hosts WHERE site_id = ?1 AND path_prefix = '' AND EXISTS (
        SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.public_domain_version = ?6 AND ${ownerScope})`)
        .bind(siteId, projectId, actor.subject, domain, version, body.expectedVersion),
      db.prepare(`UPDATE managed_site_hosts SET is_primary = CASE WHEN ?4 IS NULL THEN 1 ELSE 0 END
        WHERE site_id = ?1 AND hostname = ?7 AND path_prefix = (SELECT '/s/' || slug FROM managed_sites WHERE site_id = ?1)
          AND EXISTS (SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.public_domain_version = ?6 AND ${ownerScope})`)
        .bind(siteId, projectId, actor.subject, domain, version, body.expectedVersion, sharedHostname),
      ...(domain ? [db.prepare(`INSERT INTO managed_site_hosts (hostname, path_prefix, site_id, noindex, is_primary)
        SELECT ?4, '', ?1, ?7, 1 WHERE EXISTS (
          SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.public_domain_version = ?6 AND ${ownerScope})`)
        .bind(siteId, projectId, actor.subject, domain, version, body.expectedVersion, body.noindex ? 1 : 0)] : []),
      db.prepare(`UPDATE managed_sites SET public_domain_version = ?5
        WHERE site_id = ?1 AND public_domain_version = ?6 AND ${ownerScope}`)
        .bind(siteId, projectId, actor.subject, domain, version, body.expectedVersion)
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: managed_site_hosts\./u.test(error.message)) return json({ error: "domain_taken" }, 409);
    throw error;
  }
  if (results.length && changed(results[results.length - 1])) return json({ domain, noindex: domain ? body.noindex : true, version });
  return json({ error: "conflict" }, 409);
}

async function registerManagedEmbed(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, pageId: string, origin: string): Promise<Response> {
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["src", "locale"]) || typeof body.locale !== "string" || !LOCALE.test(body.locale)) return json({ error: "invalid_request" }, 400);
  const row = await pageRow(db, projectId, siteId, pageId, body.locale);
  if (!row) return json({ error: "forbidden" }, 403);
  const publicOrigin = row.public_domain ? `https://${row.public_domain}` : origin;
  const publicPath = new URL(managedPageUrl(origin, row.slug, row.path, row.public_domain)).pathname;
  const url = registeredNihoEmbed(body.src, publicOrigin, publicPath);
  if (!url) return json({ error: "invalid_embed_url" }, 422);
  const policyRow = await db.prepare("SELECT public_policy_json, public_policy_version FROM managed_sites WHERE site_id = ?1")
    .bind(row.site_id).first<{ public_policy_json: string; public_policy_version: string }>();
  const policy = policyRow && parseManagedPublicPolicy(JSON.parse(policyRow.public_policy_json), origin);
  if (!policy?.frameOrigins.includes(url.origin)) return json({ error: "embed_origin_not_allowed" }, 422);
  const refId = opaqueId("emb");
  const [result] = await db.batch([db.prepare(`INSERT INTO managed_embed_connections (site_id, page_id, locale, ref_id, parent_origin, public_path, src)
    SELECT p.site_id, p.page_id, p.locale, ?1, ?2, ?3, ?4
    FROM managed_pages AS p JOIN managed_sites AS ms ON ms.site_id = p.site_id JOIN sites AS s ON s.id = p.site_id
    JOIN project_members AS member ON member.project_id = s.project_id
    WHERE p.site_id = ?5 AND p.page_id = ?6 AND p.locale = ?7 AND p.path = ?8 AND ms.public_policy_version = ?9
      AND s.project_id = ?10 AND member.access_subject = ?11 AND member.role IN ('owner', 'editor')`)
    .bind(refId, publicOrigin, publicPath, url.href, row.site_id, row.page_id, row.locale, row.path, policyRow!.public_policy_version, row.project_id, actor.subject)]);
  return changed(result) ? json({ refId }, 201) : json({ error: "conflict" }, 409);
}

export async function managedProjectRegistrations(db: ManagedD1, subject: string): Promise<Map<string, ManagedProjectRegistration>> {
  const result = await db.prepare(`
    SELECT p.id AS project_id, s.id AS site_id, ms.slug, ${PRIMARY_DOMAIN} AS public_domain,
           (SELECT count(*) FROM managed_pages AS mp WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL) AS published_page_count,
           (SELECT publication.published_path FROM managed_pages AS mp JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
             WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
             ORDER BY CASE WHEN publication.published_path = '/' THEN 0 ELSE 1 END, publication.published_path LIMIT 1) AS published_path,
           (SELECT max(mp.updated_at) FROM managed_pages AS mp WHERE mp.site_id = s.id) AS updated_at,
           (SELECT max(pub.created_at) FROM managed_page_publications AS pub WHERE pub.site_id = s.id) AS last_published_at
      FROM project_members AS member
      JOIN projects AS p ON p.id = member.project_id
      JOIN sites AS s ON s.project_id = p.id
      JOIN managed_sites AS ms ON ms.site_id = s.id
     WHERE member.access_subject = ?1
     ORDER BY p.name COLLATE NOCASE, p.id
     LIMIT 100
  `).bind(subject).all<ManagedProjectRegistration>();
  if (!result.success) throw new Error("managed registration query failed");
  return new Map((result.results ?? []).map((row) => [`${row.project_id}\u0000${row.site_id}`, row]));
}

async function pageRow(db: ManagedD1, projectId: string, siteId: string, pageId: string, locale?: string): Promise<ManagedPageRow | null> {
  return db.prepare(`
    SELECT s.project_id AS project_id, s.id AS site_id, ms.slug, ${PRIMARY_DOMAIN} AS public_domain, mp.page_id, mp.locale, mp.title, mp.path, mp.visibility,
           (SELECT locale FROM managed_pages WHERE site_id = s.id AND page_id = 'home' ORDER BY locale LIMIT 1) AS cms_locale,
           mp.current_version, ms.page_catalog_version, mp.current_revision, mp.published_revision, version.revision, version.document_json, version.document_key, version.document_digest, version.bindings_json
      FROM sites AS s
      JOIN managed_sites AS ms ON ms.site_id = s.id
      JOIN managed_pages AS mp ON mp.site_id = s.id
      JOIN managed_page_versions AS version
        ON version.site_id = mp.site_id AND version.page_id = mp.page_id AND version.locale = mp.locale AND version.revision = mp.current_revision
     WHERE s.project_id = ?1 AND s.id = ?2 AND mp.page_id = ?3
       AND (?4 IS NULL OR mp.locale = ?4)
     LIMIT 1
  `).bind(projectId, siteId, pageId, locale ?? null).first<ManagedPageRow>();
}

async function pageCatalog(db: ManagedD1, siteId: string) {
  const result = await db.prepare(`
    SELECT ms.page_catalog_version, mp.page_id, mp.locale, mp.title, mp.path, mp.visibility, mp.published_revision, mp.current_version
      FROM managed_sites AS ms
      JOIN managed_pages AS mp ON mp.site_id = ms.site_id
     WHERE ms.site_id = ?1
     ORDER BY CASE mp.path WHEN '/' THEN 0 ELSE 1 END, mp.path, mp.page_id
     LIMIT 500
  `).bind(siteId).all<{
    page_catalog_version: string; page_id: string; locale: string; title: string; path: string;
    visibility: "public" | "private"; published_revision: number | null; current_version: string;
  }>();
  if (!result.success || !result.results?.length) throw new Error("managed pages query failed");
  return { version: result.results[0]!.page_catalog_version, pages: result.results.map((page) => ({
    siteId, pageId: page.page_id, locale: page.locale, title: page.title, path: page.path, version: page.current_version,
    kind: "page" as const, visibility: page.visibility, published: page.published_revision !== null
  })) };
}

async function releases(db: ManagedD1, row: ManagedPageRow): Promise<readonly { revision: number; label: string }[]> {
  const result = await db.prepare(`
    SELECT source_revision, created_at
      FROM managed_page_publications
     WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3
     ORDER BY created_at DESC, id DESC
     LIMIT 50
  `).bind(row.site_id, row.page_id, row.locale).all<{ readonly source_revision: number; readonly created_at: number }>();
  if (!result.success) throw new Error("managed release history query failed");
  const seen = new Set<number>();
  return (result.results ?? []).flatMap((entry) => {
    if (seen.has(entry.source_revision)) return [];
    seen.add(entry.source_revision);
    return [{ revision: entry.source_revision, label: `版 ${entry.source_revision}（${new Date(entry.created_at * 1000).toLocaleString("ja-JP")}）` }];
  });
}

async function pageRevisionHistory(db: ManagedD1, row: ManagedPageRow, cursor?: string) {
  const before = cursor === undefined ? null : /^rev-([1-9]\d{0,8})$/u.exec(cursor);
  if (cursor !== undefined && !before) return null;
  const result = await db.prepare(`
    SELECT version.revision, version.kind, version.created_at,
           (SELECT max(publication.created_at) FROM managed_page_publications AS publication
             WHERE publication.site_id = version.site_id AND publication.page_id = version.page_id
               AND publication.locale = version.locale AND publication.source_revision = version.revision) AS published_at
      FROM managed_page_versions AS version
     WHERE version.site_id = ?1 AND version.page_id = ?2 AND version.locale = ?3
       AND (?4 IS NULL OR version.revision < ?4)
     ORDER BY version.revision DESC LIMIT 51
  `).bind(row.site_id, row.page_id, row.locale, before ? Number(before[1]) : null)
    .all<{ revision: number; kind: "initial" | "save" | "restore"; created_at: number; published_at: number | null }>();
  if (!result.success) throw new Error("managed page history query failed");
  const entries = (result.results ?? []).slice(0, 50).map((entry) => ({
    id: `rev-${entry.revision}`, revision: entry.revision,
    kind: entry.kind === "restore" ? "rollback" as const : entry.published_at === null ? "draft" as const : "publish" as const,
    createdAt: new Date((entry.published_at ?? entry.created_at) * 1000).toISOString(), actor: "スタッフ",
    label: `版 ${entry.revision}`, snapshotAvailable: true
  }));
  const hasMore = (result.results?.length ?? 0) > 50;
  const next = hasMore && entries.length ? `rev-${entries.at(-1)!.revision}` : undefined;
  return { entries, ...(next ? { next } : {}) };
}

async function pageRevision(db: ManagedD1, row: ManagedPageRow, id: string, store?: CmsStore, siteStyles?: import("../src/site-styles.js").SiteStyles) {
  const match = /^rev-([1-9]\d{0,8})$/u.exec(id);
  if (!match) return null;
  const version = await db.prepare(`SELECT site_id, page_id, locale, revision, document_json, document_key, document_digest FROM managed_page_versions
    WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4 LIMIT 1`)
    .bind(row.site_id, row.page_id, row.locale, Number(match[1])).first<PageSourceRow>();
  if (!version) return null;
  const currentStyles = siteStyles ?? (store ? (await readManagedSiteStyles(store, row.site_id)).draft.styles : undefined);
  const document = await readPageSource(store, version, currentStyles);
  return { document };
}

async function snapshot(db: ManagedD1, row: ManagedPageRow, store?: CmsStore): Promise<Record<string, unknown>> {
  const siteStyles = store ? (await readManagedSiteStyles(store, row.site_id)).draft.styles : undefined;
  const document = await readPageSource(store, row, siteStyles);
  return { document, ...(row.bindings_json ? { cmsBindings: parseCmsPageBindings(JSON.parse(row.bindings_json), document) }
    : store && row.locale === row.cms_locale ? { cmsBindings: null } : {}),
    version: row.current_version, hasSavedDraft: true, releases: await releases(db, row) };
}

async function cmsSite(store: CmsStore | undefined, actor: ManagedActor, row: ManagedPageRow): Promise<Site | null> {
  const site = await store?.site({ projectId: row.project_id, siteId: row.site_id, actor: { id: actor.subject, cli: actor.cli } }, "cms.read");
  return site?.state.locale === row.locale ? site : null;
}

function pageBindings(input: unknown, page: PageDocument, path: string): CmsPageBindingsDocument | null {
  if (input === null) return null;
  const bindings = parseCmsPageBindings(input, page);
  if (bindings.detail && (path === "/" || validatePagePath(path + "/item") !== null)) throw new Error("詳細ページの URL を設定してください。");
  return bindings.lists.length || bindings.detail ? bindings : null;
}

async function cmsBindingOptions(store: CmsStore, site: Site) {
  const items = await Promise.all(Object.values(site.state.items).filter(({ removedAt }) => removedAt === null).map(async (pin) => {
    const collection = site.state.schema.collections.find(({ id }) => id === pin.collectionId);
    if (!collection) throw new Error("CMS collection unavailable");
    const item = await store.item(site.siteId, site.state.locale, pin);
    return { collectionId: pin.collectionId, itemId: pin.itemId, revision: pin.revision, label: String(item.values[collection.titleField] ?? pin.itemId).slice(0, 200) };
  }));
  return json({ schema: site.state.schema, items });
}

async function cmsBindingPreview(request: Request, store: CmsStore, site: Site, actor: ManagedActor, row: ManagedPageRow, read: boolean) {
  const body = await readJson(request, actor, MAX_EDITOR_BODY);
  if (!body || !exactKeys(body, ["expectedVersion", "collectionId", "itemId", "revision", "document", "cmsBindings", ...(read ? ["previewId"] : [])])) return json({ error: "invalid_request" }, 400);
  if (body.expectedVersion !== row.current_version) return json({ status: "conflict" }, 409);
  let document: PageDocument, bindings: CmsPageBindingsDocument | null, key: string;
  let siteStyles: import("../src/site-styles.js").SiteStyles;
  try {
    siteStyles = (await readManagedSiteStyles(store, row.site_id)).draft.styles;
    document = parsePageDocument(body.document, managedBlockContracts, { siteStyles });
    bindings = pageBindings(body.cmsBindings, document, row.path);
    key = cmsItemKey({ collectionId: cmsId(body.collectionId, "collectionId"), itemId: cmsId(body.itemId, "itemId") });
  } catch { return json({ error: "invalid_cms_bindings" }, 422); }
  if (document.siteId !== row.site_id || document.pageId !== row.page_id || document.locale !== row.locale || document.revision !== row.current_revision) return json({ error: "invalid_document" }, 400);
  if (!bindings || (bindings.detail ? bindings.detail.collectionId !== body.collectionId : !bindings.lists.some(({ collectionId }) => collectionId === body.collectionId))) return json({ error: "invalid_cms_bindings" }, 422);
  const problems = cmsPageBindingProblems(document, bindings, site.state.schema);
  if (problems.length) return json({ error: "invalid_cms_bindings", problems }, 422);
  const pin = site.state.items[key];
  if (!pin || pin.removedAt !== null || pin.revision !== body.revision) return json({ error: "not_found" }, 404);
  const scope = await digest({ pageId: row.page_id, locale: row.locale, expectedVersion: row.current_version, schemaRevision: site.state.schema.schemaRevision,
    collectionId: pin.collectionId, itemId: pin.itemId, revision: pin.revision, document, bindings });
  if (!read) {
    const previewId = await store.makeToken(site, "cms.read", "page-preview", { scope }, nowSeconds() + 300);
    return previewId ? json({ previewId }) : json({ error: "preview_unavailable" }, 409);
  }
  if (typeof body.previewId !== "string" || !/^token_[a-f0-9]{32}$/u.test(body.previewId)) return json({ error: "invalid_request" }, 400);
  const token = await store.readToken<{ scope: string }>(site, "cms.read", "page-preview", body.previewId);
  if (!token || token.expires <= nowSeconds() || token.payload.scope !== scope) return json({ error: "not_found" }, 404);
  const item = await store.item(site.siteId, site.state.locale, pin);
  let projected: PageDocument | null;
  try { projected = resolveCmsPageBindings(document, bindings, { schema: site.state.schema, items: [item] }, {
    detail: { itemId: item.itemId }, blocks: managedBlockContracts, page: { siteStyles }
  }); }
  catch { return json({ error: "invalid_cms_binding_values" }, 422); }
  if (!projected || !await store.consumePreview(site, body.previewId, "page-preview")) return json({ error: "not_found" }, 404);
  return json({ document: projected });
}

function discardSupersededDraft(db: ManagedD1, row: ManagedPageRow, version: string): D1Statement {
  return db.prepare(`DELETE FROM managed_page_versions
     WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4
       AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND current_version = ?5)
       AND NOT EXISTS (SELECT 1 FROM managed_page_publications
                        WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND source_revision = ?4)`)
    .bind(row.site_id, row.page_id, row.locale, row.current_revision, version);
}

async function saveDraft(request: Request, actor: ManagedActor, row: ManagedPageRow, store?: CmsStore): Promise<Response> {
  const body = await readJson(request, actor, MAX_EDITOR_BODY);
  if (!body || !exactKeys(body, ["expectedVersion", "document", ...(Object.hasOwn(body, "cmsBindings") ? ["cmsBindings"] : [])]) || typeof body.expectedVersion !== "string") return json({ error: "invalid_request" }, 400);
  if (body.expectedVersion !== row.current_version) return json({ status: "conflict" }, 409);
  let submitted: PageDocument;
  try {
    const siteStyles = store ? (await readManagedSiteStyles(store, row.site_id)).draft.styles : undefined;
    submitted = parsePageDocument(body.document, managedBlockContracts, siteStyles ? { siteStyles } : {});
  } catch { return json({ error: "invalid_document" }, 400); }
  if (submitted.siteId !== row.site_id || submitted.pageId !== row.page_id || submitted.locale !== row.locale || submitted.revision !== row.current_revision) return json({ error: "invalid_document" }, 400);
  let bindings: CmsPageBindingsDocument | null;
  try { bindings = pageBindings(Object.hasOwn(body, "cmsBindings") ? body.cmsBindings : row.bindings_json ? JSON.parse(row.bindings_json) : null, submitted, row.path); }
  catch { return json({ error: "invalid_cms_bindings" }, 422); }
  const site = bindings ? await cmsSite(store, actor, row) : null;
  if (bindings && !site) return json({ error: "cms_bindings_unavailable" }, 409);
  const problems = bindings && site ? cmsPageBindingProblems(submitted, bindings, site.state.schema) : [];
  if (problems.length) return json({ error: "invalid_cms_bindings", problems }, 422);
  if (!store) return json({ error: "page_storage_unavailable" }, 503);
  const saved = await persistDraft(store, actor, row, submitted, bindings, site);
  if (saved === "too_large") return json({ error: "invalid_document" }, 400);
  return saved ? json({ status: "saved", version: saved.version, revision: saved.revision }) : json({ status: "conflict" }, 409);
}

type DraftReceipt = { actorId: string; operationId: string; inputHash: string };
async function persistDraft(store: CmsStore, actor: ManagedActor, row: ManagedPageRow, submitted: PageDocument,
  bindings: CmsPageBindingsDocument | null, site: Site | null, receipt?: DraftReceipt): Promise<EditingPageApplied | "too_large" | null> {
  const { db, bucket } = store;
  const revision = row.current_revision + 1, version = opaqueVersion(), stored = { ...submitted, revision };
  const bindingsJson = bindings ? JSON.stringify(bindings) : null;
  const source = await storePageSource(bucket, stored, version);
  if (!source) return "too_large";
  if (new TextEncoder().encode((bindingsJson ?? "")).length > MAX_EDITOR_BODY) return "too_large";
  const result = { status: "applied", version, revision } as const;
  const receiptJson = receipt ? JSON.stringify({ ...result, documentKey: source.key, documentDigest: source.digest }) : null;
  const results = await db.batch([
    db.prepare(`UPDATE managed_pages SET current_version = ?1, current_revision = ?2, updated_at = unixepoch()
                 WHERE site_id = ?3 AND page_id = ?4 AND locale = ?5 AND current_version = ?6
                   AND (?8 IS NULL OR ?8 = COALESCE((SELECT json_extract(state_json, '$.schema.schemaRevision')
                     FROM managed_cms_state WHERE site_id = ?3), 'initial'))
                   AND (?9 IS NULL OR NOT EXISTS (SELECT 1 FROM managed_page_operations WHERE site_id = ?3 AND actor_id = ?9 AND operation_id = ?10))
                   AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
                                WHERE s.id = ?3 AND member.access_subject = ?7 AND member.role IN ('owner', 'editor')
                                  AND (?11 IS NULL OR member.role = 'owner' AND EXISTS (SELECT 1 FROM studio_cli_grants AS grant
                                    WHERE grant.site_id = ?3 AND grant.project_id = s.project_id AND grant.delegated_by_subject = ?7
                                      AND grant.client_id = ?11 AND grant.capability = 'pages.edit' AND (grant.expires_at IS NULL OR grant.expires_at > unixepoch()))))`)
      .bind(version, revision, row.site_id, row.page_id, row.locale, row.current_version, actor.subject, site?.state.schema.schemaRevision ?? null,
        receipt?.actorId ?? null, receipt?.operationId ?? null, actor.cliClientId ?? null),
    db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject, bindings_json,
                                                     document_key, document_digest, link_index_json)
                SELECT site_id, page_id, locale, ?2, '{}', 'save', ?3, ?7, ?8, ?9, ?10 FROM managed_pages
                 WHERE site_id = ?1 AND page_id = ?4 AND locale = ?5 AND current_version = ?6`)
      .bind(row.site_id, revision, actor.subject, row.page_id, row.locale, version, bindingsJson, source.key, source.digest, source.linkIndex),
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
                SELECT ?1, s.project_id, s.id, ?2, 'page.saved', ?3 FROM sites AS s
                 WHERE s.id = ?4 AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = s.id AND page_id = ?3 AND locale = ?5 AND current_version = ?6)`)
      .bind(crypto.randomUUID(), actor.subject, row.page_id, row.site_id, row.locale, version),
    discardSupersededDraft(db, row, version),
    ...(receipt ? [db.prepare(`INSERT INTO managed_page_operations (site_id, actor_id, operation_id, input_hash, result_json)
      SELECT site_id, ?1, ?2, ?3, ?4 FROM managed_pages WHERE site_id = ?5 AND page_id = ?6 AND locale = ?7 AND current_version = ?8`)
      .bind(receipt.actorId, receipt.operationId, receipt.inputHash, receiptJson, row.site_id, row.page_id, row.locale, version)] : [])
  ]);
  if (!changed(results[0]) || !changed(results[1]) || !changed(results[2]) || receipt && !changed(results[4])) return null;
  return { ...result, document: stored };
}

export function managedPageEditingApi(request: Request, store: CmsStore, projectId: string, siteId: string, publicOrigin: string | null, editingActor: EditingActor,
  actorFor: (capability: EditingCapability) => Promise<ManagedActor | null>): Promise<Response> {
  const db = store.db;
  let actor: ManagedActor | null = null;
  const publishSiteStyles = async (managedActor: ManagedActor, targetSiteId: string,
    input: EditingSiteStylesPublishRequest): Promise<EditingSiteStylesPublishResult> => {
    if (!publicOrigin || targetSiteId !== siteId) return { status: "conflict" };
    const snapshot = await managedPublicationSnapshot(store, managedActor, projectId, targetSiteId);
    if (!snapshot || snapshot.styles.draft.version !== input.expectedDraftVersion
      || snapshot.styles.published.version !== input.expectedPublishedVersion
      || input.expectedDraftVersion === input.expectedPublishedVersion) return { status: "conflict" };
    const result = await publishManagedPages(store, managedActor, projectId, targetSiteId, publicOrigin,
      { expectedVersion: snapshot.changes.version, scope: "site" }, undefined, input);
    if (result.status === "conflict") return { status: "conflict" };
    if (result.status === "failed") return { status: "failed", failedUrl: result.failedUrl, message: result.message };
    return { status: "published", version: input.expectedDraftVersion, styles: snapshot.styles.draft.styles,
      urls: result.urls, elapsedMs: result.elapsedMs, warnings: result.warnings };
  };
  const styleStorage = managedSiteStylesAdapter(store, projectId, publishSiteStyles);
  const load = (target: EditingPageTarget) => actor ? pageRow(db, projectId, siteId, target.pageId, target.locale) : Promise.resolve(null);
  const draftStyles = async () => (await readManagedSiteStyles(store, siteId)).draft.styles;
  const doc = async (row: ManagedPageRow) => readPageSource(store, row, await draftStyles());
  const bindings = (row: ManagedPageRow, page: PageDocument) => row.bindings_json ? parseCmsPageBindings(JSON.parse(row.bindings_json), page) : null;
  return createPageEditingApi({
    pageCmsBindings: true,
    validationContext: async () => ({ blocks: managedBlockContracts, siteStyles: await draftStyles() }),
    authenticate: async () => editingActor,
    async authorize(_editingActor, capability, scope) {
      if (scope.siteId !== siteId || !["pages.read", "pages.edit", "pages.history.read", "pages.publish", "assets.read", "site.settings.read", "site.settings.write"].includes(capability)) return false;
      actor = await actorFor(capability);
      return actor !== null && !!await managedMemberRegistration(db, actor, projectId, siteId);
    },
    async resolveAssets(_editingActor, _siteId, references) {
      return store.resolveMigratedAssets(siteId, references);
    },
    async readPage(_editingActor, target) {
      const row = await load(target);
      if (!row) return null;
      const document = await doc(row);
      return { document, version: row.current_version, editorState: { releases: await releases(db, row) }, ...(row.locale === row.cms_locale ? { cmsBindings: bindings(row, document) } : {}) };
    },
    async savePage(_editingActor, target, expectedVersion, submitted) {
      const row = await load(target);
      if (!row || !actor || row.current_version !== expectedVersion || row.current_revision !== submitted.revision) return { status: "conflict" };
      const current = bindings(row, submitted), site = current ? await cmsSite(store, actor, row) : null;
      if (current && (!site || cmsPageBindingProblems(submitted, current, site.state.schema).length)) return { status: "conflict" };
      const saved = await persistDraft(store, actor, row, submitted, current, site);
      if (saved === "too_large") return { status: "conflict" };
      return saved ? { status: "saved", version: saved.version, document: saved.document } : { status: "conflict" };
    },
    async listPageHistory(_editingActor, target, cursor) {
      const row = await load(target);
      return row ? pageRevisionHistory(db, row, cursor) : null;
    },
    async readPageHistoryRevision(_editingActor, target, id) {
      const row = await load(target);
      return row ? pageRevision(db, row, id, store, await draftStyles()) : null;
    },
    async readPageCatalog() {
      const catalog = await pageCatalog(db, siteId);
      return { version: catalog.version, pages: catalog.pages.map(({ version: _version, ...page }) => page) };
    },
    async readPublicationChanges() {
      if (!actor) return null;
      return (await managedPublicationSnapshot(store, actor, projectId, siteId))?.changes ?? null;
    },
    async publishSiteNow(_editingActor, requestedSiteId, input) {
      if (!publicOrigin || !actor || requestedSiteId !== siteId) return { status: "conflict" };
      return publishManagedPages(store, actor, projectId, siteId, publicOrigin, input);
    },
    async changePageNow(_editingActor, _siteId, expectedVersion, change) {
      if (!actor) return { status: "invalid" };
      const result = await changePageOnce(store, actor, projectId, siteId, publicOrigin, expectedVersion, change);
      if (!(result instanceof Response)) return result;
      if (result.status === 409) return { status: "conflict" };
      if (result.status === 400) return { status: "invalid" };
      throw new Error("managed page change failed");
    },
    async publishPageNow(_editingActor, target, input) {
      if (!publicOrigin) throw new Error("managed public site origin unavailable");
      if (!actor || target.siteId !== siteId || input.action === "restore" && (!Number.isSafeInteger(input.revision) || input.revision! < 1)
        || input.action === "publish" && input.revision !== undefined) return { status: "conflict" };
      const row = await load(target);
      if (!row) return { status: "conflict" };
      const result = await publishPageOnce(store, actor, row, publicOrigin, input);
      if (result instanceof Response) {
        if (result.status === 409) return { status: "conflict" };
        if (result.status === 503) {
          const value = await result.json() as { failedUrl?: string; message?: string };
          if (value.failedUrl) return { status: "failed", failedUrl: value.failedUrl, message: value.message ?? "ページの公開生成に失敗しました。" };
        }
        throw new Error("managed direct publish failed");
      }
      const { document, version, releases, cmsBindings } = result.snapshot;
      return { ...result, snapshot: { document, version, editorState: { releases },
        ...(cmsBindings === undefined ? {} : { cmsBindings }) } };
    },
    pageOperations: { async transact(actorIdentity, target, transaction) {
      const { operationId, inputHash, dryRun } = transaction;
      const receipt = { actorId: actorIdentity.subject, operationId, inputHash };
      const lookup = async () => {
        if (dryRun) return null;
        const existing = await db.prepare(`SELECT input_hash, result_json FROM managed_page_operations WHERE site_id = ?1 AND actor_id = ?2 AND operation_id = ?3`)
          .bind(siteId, receipt.actorId, operationId).first<{ input_hash: string; result_json: string }>();
        if (!existing) return null;
        if (existing.input_hash !== inputHash) return { status: "duplicate_operation" as const };
        const result = JSON.parse(existing.result_json) as EditingPageApplied | (Omit<EditingPageApplied, "document"> & { documentKey: string; documentDigest: string });
        if ("document" in result) return result;
        const { documentKey, documentDigest, ...applied } = result;
        const document = await readPageSourceObject(store.bucket, {
          site_id: target.siteId, page_id: target.pageId, locale: target.locale, revision: applied.revision
        }, documentKey, documentDigest, await draftStyles());
        return { ...applied, document };
      };
      const row = await load(target);
      if (!row || !actor) return { status: "not_found" };
      const repeated = await lookup();
      if (repeated) return repeated;
      const document = await doc(row), site = await cmsSite(store, actor, row);
      const proposed = transaction.prepare({ document, version: row.current_version, ...(site ? { cmsBindings: bindings(row, document) } : {}) },
        { blocks: managedBlockContracts, siteStyles: await draftStyles(), ...(site ? { cmsSchema: site.state.schema, cmsPagePath: row.path } : {}) });
      if (proposed.status !== "ready") return proposed;
      let sidecar: CmsPageBindingsDocument | null;
      try { sidecar = pageBindings(proposed.cmsBindings ?? null, proposed.document, row.path); }
      catch { return { status: "validation_failed", index: Math.max(0, proposed.journal.input.operations.length - 1), reason: "詳細ページの URL を設定してください。" }; }
      if (!store) return { status: "not_found" };
      const result = await persistDraft(store, actor, row, proposed.document, sidecar, sidecar ? site : null, receipt);
      if (result === "too_large") return { status: "validation_failed", index: Math.max(0, proposed.journal.input.operations.length - 1), reason: "ページ本文がサイズ上限を超えています。" };
      return result ?? await lookup() ?? { status: "conflict" };
    } },
    siteStyles: {
      read: async (_editingActor, targetSiteId) => actor ? styleStorage.read(actor, targetSiteId) : null,
      edit: async (_editingActor, targetSiteId, input) => actor
        ? styleStorage.edit(actor, targetSiteId, input) : { status: "conflict" },
      publish: async (_editingActor, targetSiteId, input) => actor
        ? styleStorage.publish(actor, targetSiteId, input) : { status: "conflict" }
    },
  }, { maxPageBodyBytes: MAX_MANAGED_PAGE_BYTES, trustedPageStorage: true })(request);
}

/** Fence mutations against membership changes or revoked CLI delegation during artifact generation. */
function pagePublishAccess(site: string, project: string, subject: string, client: string): string {
  return `EXISTS (SELECT 1 FROM project_members AS member
    WHERE member.project_id = ${project} AND member.access_subject = ${subject} AND member.role IN ('owner', 'editor')
      AND (${client} IS NULL OR member.role = 'owner' AND EXISTS (SELECT 1 FROM studio_cli_grants AS grant
        WHERE grant.site_id = ${site} AND grant.project_id = ${project} AND grant.delegated_by_subject = ${subject}
          AND grant.client_id = ${client} AND grant.capability = 'pages.publish'
          AND (grant.expires_at IS NULL OR grant.expires_at > unixepoch()))))`;
}

type ManagedPagePublicationWrite = {
  readonly row: ManagedPageRow;
  readonly expectedVersion: string;
  readonly sourceRevision: number;
  readonly revision: number;
  readonly action: "publish" | "rollback";
  readonly auditAction: "page.published" | "page.restored";
  readonly publicationId: string;
  readonly cmsReleaseId: string | null;
  readonly cmsSchemaRevision: string | null;
  readonly publishedPath: string;
  readonly artifactKey: string | null;
  readonly artifactDigest: string | null;
  readonly contentSecurityPolicy: string | null;
  readonly updateCurrent: boolean;
  readonly currentVersion?: string;
  readonly copy?: { readonly kind: "save" | "restore"; readonly bindingsJson: string | null;
    readonly documentKey: string; readonly documentDigest: string; readonly linkIndex: string };
};

/** Commit all page history and the new manifest pointer in one D1 transaction. */
async function commitManagedPagePublicationBatch(input: {
  readonly db: ManagedD1;
  readonly actor: ManagedActor;
  readonly siteId: string;
  readonly projectId: string;
  readonly catalogVersion: string;
  readonly cmsGeneration: string | null;
  readonly prepared: { readonly expectedVersion: string; readonly manifestVersion: string; readonly manifestKey: string;
    readonly policyVersion: string; readonly domainVersion: string; readonly expectedPolicyVersion: string;
    readonly expectedDomainVersion: string; readonly expectedSiteStyleDraftVersion: string;
    readonly expectedSiteStylePublishedVersion: string; readonly siteStylesVersion: string; readonly publishSiteStyles: boolean;
    readonly artifacts: ReadonlyMap<string,
      { readonly pageId: string; readonly locale: string; readonly path: string; readonly artifactKey: string;
        readonly artifactDigest: string; readonly contentSecurityPolicy: string }>; };
  readonly writes: readonly ManagedPagePublicationWrite[];
}): Promise<boolean> {
  const { db, actor, siteId, projectId, catalogVersion, cmsGeneration, prepared, writes } = input;
  if (new Set(writes.map(({ row }) => `${row.page_id}\u0000${row.locale}`)).size !== writes.length) return false;
  if (!writes.length) {
    const results = await db.batch([
      db.prepare(`UPDATE managed_site_styles SET
          published_version = CASE WHEN ?4 = 1 THEN draft_version ELSE published_version END,
          published_key = CASE WHEN ?4 = 1 THEN draft_key ELSE published_key END,
          published_digest = CASE WHEN ?4 = 1 THEN draft_digest ELSE published_digest END,
          updated_at = CASE WHEN ?4 = 1 THEN unixepoch() ELSE updated_at END,
          updated_by_subject = CASE WHEN ?4 = 1 THEN ?8 ELSE updated_by_subject END
        WHERE site_id = ?1 AND draft_version = ?2 AND published_version = ?3
          AND (?4 = 0 OR draft_version = ?5 AND draft_version <> published_version)
          AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?1 AND version = ?6)
          AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?1 AND page_catalog_version = ?9
            AND public_policy_version = ?10 AND public_domain_version = ?11)
          AND EXISTS (SELECT 1 FROM sites WHERE id = ?1 AND project_id = ?7)
          AND ${pagePublishAccess("?1", "?7", "?8", "?12")}`)
        .bind(siteId, prepared.expectedSiteStyleDraftVersion, prepared.expectedSiteStylePublishedVersion,
          prepared.publishSiteStyles ? 1 : 0, prepared.siteStylesVersion, prepared.expectedVersion,
          projectId, actor.subject, catalogVersion, prepared.expectedPolicyVersion, prepared.expectedDomainVersion, actor.cliClientId ?? null),
      db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
        WHERE site_id = ?3 AND version = ?4 AND changes() = 1
          AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?3 AND page_catalog_version = ?5
            AND public_policy_version = ?6 AND public_domain_version = ?7)
          AND EXISTS (SELECT 1 FROM sites WHERE id = ?3 AND project_id = ?8)
          AND EXISTS (SELECT 1 FROM managed_site_styles WHERE site_id = ?3 AND published_version = ?9)
          AND ${pagePublishAccess("?3", "?8", "?10", "?11")}`)
        .bind(prepared.manifestVersion, prepared.manifestKey, siteId, prepared.expectedVersion, catalogVersion,
          prepared.expectedPolicyVersion, prepared.expectedDomainVersion, projectId, prepared.siteStylesVersion,
          actor.subject, actor.cliClientId ?? null)
    ]);
    if (results.some((result) => !result.success)) throw new Error("managed page publication batch failed");
    return changed(results[1]);
  }
  const auditIds = writes.map(() => crypto.randomUUID());
  const entries = writes.map((write, index) => ({
    auditId: auditIds[index], pageId: write.row.page_id, locale: write.row.locale, expectedVersion: write.expectedVersion,
    sourceRevision: write.sourceRevision, revision: write.revision, action: write.action, auditAction: write.auditAction,
    publicationId: write.publicationId, cmsReleaseId: write.cmsReleaseId, cmsSchemaRevision: write.cmsSchemaRevision,
    publishedPath: write.publishedPath, artifactKey: write.artifactKey, artifactDigest: write.artifactDigest,
    manifestKey: prepared.manifestKey, contentType: write.artifactKey ? "text/html; charset=utf-8" : null,
    contentSecurityPolicy: write.contentSecurityPolicy, updateCurrent: write.updateCurrent,
    currentVersion: write.currentVersion ?? null, copy: write.copy ?? null,
    expectedSiteStyleDraftVersion: prepared.expectedSiteStyleDraftVersion,
    expectedSiteStylePublishedVersion: prepared.expectedSiteStylePublishedVersion
  }));
  const payload = JSON.stringify(entries), expectedCount = entries.length, nextCatalogVersion = `catalog.${opaqueVersion()}`;
  const auditCount = (payloadParameter: string) =>
    `(SELECT count(*) FROM managed_site_audit WHERE id IN (SELECT json_extract(value, '$.auditId') FROM json_each(${payloadParameter})))`;
  const candidateAccess = pagePublishAccess("candidate.site_id", "candidate_site.project_id", "?3", "?6");
  const candidateGuard = `?11 = (SELECT count(*) FROM json_each(?1) AS expected
      JOIN managed_pages AS candidate ON candidate.site_id = ?2
        AND candidate.page_id = json_extract(expected.value, '$.pageId') AND candidate.locale = json_extract(expected.value, '$.locale')
      JOIN managed_sites AS candidate_managed ON candidate_managed.site_id = candidate.site_id
      JOIN sites AS candidate_site ON candidate_site.id = candidate.site_id
      WHERE candidate_site.project_id = ?4 AND candidate.current_version = json_extract(expected.value, '$.expectedVersion')
        AND candidate_managed.page_catalog_version = ?5 AND ${candidateAccess}
        AND (?7 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = candidate.site_id AND generation = ?7))
        AND (json_extract(expected.value, '$.cmsReleaseId') IS NULL OR EXISTS (
          SELECT 1 FROM managed_cms_releases WHERE site_id = candidate.site_id AND release_id = json_extract(expected.value, '$.cmsReleaseId')))
        AND candidate_managed.public_policy_version = ?8 AND candidate_managed.public_domain_version = ?9
        AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = candidate.site_id AND version = ?10)
        AND EXISTS (SELECT 1 FROM managed_site_styles WHERE site_id = candidate.site_id
          AND draft_version = json_extract(expected.value, '$.expectedSiteStyleDraftVersion')
          AND published_version = json_extract(expected.value, '$.expectedSiteStylePublishedVersion'))
        AND EXISTS (SELECT 1 FROM managed_page_versions WHERE site_id = candidate.site_id AND page_id = candidate.page_id
          AND locale = candidate.locale AND revision = json_extract(expected.value, '$.sourceRevision')))`;
  const access = pagePublishAccess("mp.site_id", "s.project_id", "?3", "?6");
  const results = await db.batch([
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
      SELECT json_extract(entry.value, '$.auditId'), s.project_id, mp.site_id, ?3,
        json_extract(entry.value, '$.auditAction'), mp.page_id
      FROM json_each(?1) AS entry
      JOIN managed_pages AS mp ON mp.site_id = ?2 AND mp.page_id = json_extract(entry.value, '$.pageId')
        AND mp.locale = json_extract(entry.value, '$.locale')
      JOIN managed_sites AS ms ON ms.site_id = mp.site_id JOIN sites AS s ON s.id = mp.site_id
      WHERE s.project_id = ?4 AND mp.current_version = json_extract(entry.value, '$.expectedVersion')
        AND ms.page_catalog_version = ?5 AND ${access}
        AND (?7 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = mp.site_id AND generation = ?7))
        AND (json_extract(entry.value, '$.cmsReleaseId') IS NULL OR EXISTS (
          SELECT 1 FROM managed_cms_releases WHERE site_id = mp.site_id AND release_id = json_extract(entry.value, '$.cmsReleaseId')))
        AND ms.public_policy_version = ?8 AND ms.public_domain_version = ?9
        AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = mp.site_id AND version = ?10)
        AND EXISTS (SELECT 1 FROM managed_site_styles WHERE site_id = mp.site_id
          AND draft_version = json_extract(entry.value, '$.expectedSiteStyleDraftVersion')
          AND published_version = json_extract(entry.value, '$.expectedSiteStylePublishedVersion'))
        AND EXISTS (SELECT 1 FROM managed_page_versions WHERE site_id = mp.site_id AND page_id = mp.page_id
          AND locale = mp.locale AND revision = json_extract(entry.value, '$.sourceRevision'))
        AND ${candidateGuard}`)
      .bind(payload, siteId, actor.subject, projectId, catalogVersion, actor.cliClientId ?? null, cmsGeneration,
        prepared.expectedPolicyVersion, prepared.expectedDomainVersion, prepared.expectedVersion, expectedCount),
    db.prepare(`UPDATE managed_site_styles SET
        published_version = CASE WHEN ?4 = 1 THEN draft_version ELSE published_version END,
        published_key = CASE WHEN ?4 = 1 THEN draft_key ELSE published_key END,
        published_digest = CASE WHEN ?4 = 1 THEN draft_digest ELSE published_digest END,
        updated_at = CASE WHEN ?4 = 1 THEN unixepoch() ELSE updated_at END,
        updated_by_subject = CASE WHEN ?4 = 1 THEN ?11 ELSE updated_by_subject END
      WHERE site_id = ?1 AND draft_version = ?2 AND published_version = ?3
        AND (?4 = 0 OR draft_version = ?5 AND draft_version <> published_version)
        AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?1 AND version = ?6)
        AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?1 AND page_catalog_version = ?7
          AND public_policy_version = ?8 AND public_domain_version = ?9)
        AND EXISTS (SELECT 1 FROM sites WHERE id = ?1 AND project_id = ?10)
        AND ${pagePublishAccess("?1", "?10", "?11", "?12")}
        AND ${auditCount("?13")} = ?14`)
      .bind(siteId, prepared.expectedSiteStyleDraftVersion, prepared.expectedSiteStylePublishedVersion,
        prepared.publishSiteStyles ? 1 : 0, prepared.siteStylesVersion, prepared.expectedVersion, catalogVersion,
        prepared.expectedPolicyVersion, prepared.expectedDomainVersion, projectId, actor.subject,
        actor.cliClientId ?? null, payload, expectedCount),
    db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject,
        bindings_json, document_key, document_digest, link_index_json)
      SELECT ?2, json_extract(entry.value, '$.pageId'), json_extract(entry.value, '$.locale'),
        json_extract(entry.value, '$.revision'), '{}', json_extract(entry.value, '$.copy.kind'), ?3,
        json_extract(entry.value, '$.copy.bindingsJson'), json_extract(entry.value, '$.copy.documentKey'),
        json_extract(entry.value, '$.copy.documentDigest'), json_extract(entry.value, '$.copy.linkIndex')
      FROM json_each(?1) AS entry JOIN managed_site_audit AS audit ON audit.id = json_extract(entry.value, '$.auditId')
      WHERE json_type(entry.value, '$.copy') = 'object' AND ${auditCount("?1")} = ?4 AND changes() = 1`)
      .bind(payload, siteId, actor.subject, expectedCount),
    db.prepare(`INSERT INTO managed_page_publications (id, site_id, page_id, locale, source_revision, action, published_by_subject,
        cms_release_id, cms_schema_revision, published_path, path, artifact_key, artifact_digest, manifest_key, content_type, content_security_policy)
      SELECT json_extract(entry.value, '$.publicationId'), ?2, json_extract(entry.value, '$.pageId'), json_extract(entry.value, '$.locale'),
        json_extract(entry.value, '$.revision'), json_extract(entry.value, '$.action'), ?3,
        json_extract(entry.value, '$.cmsReleaseId'), json_extract(entry.value, '$.cmsSchemaRevision'),
        json_extract(entry.value, '$.publishedPath'), json_extract(entry.value, '$.publishedPath'),
        json_extract(entry.value, '$.artifactKey'), json_extract(entry.value, '$.artifactDigest'), json_extract(entry.value, '$.manifestKey'),
        json_extract(entry.value, '$.contentType'), json_extract(entry.value, '$.contentSecurityPolicy')
      FROM json_each(?1) AS entry JOIN managed_site_audit AS audit ON audit.id = json_extract(entry.value, '$.auditId')
      WHERE ${auditCount("?1")} = ?4
        AND EXISTS (SELECT 1 FROM managed_site_styles WHERE site_id = ?2 AND published_version = ?5)`)
      .bind(payload, siteId, actor.subject, expectedCount, prepared.siteStylesVersion),
    db.prepare(`UPDATE managed_pages AS mp SET
        published_revision = json_extract(entry.value, '$.revision'),
        published_publication_id = json_extract(entry.value, '$.publicationId'),
        current_revision = CASE WHEN json_extract(entry.value, '$.updateCurrent') = 1
          THEN json_extract(entry.value, '$.revision') ELSE mp.current_revision END,
        current_version = CASE WHEN json_extract(entry.value, '$.updateCurrent') = 1
          THEN json_extract(entry.value, '$.currentVersion') ELSE mp.current_version END,
        updated_at = unixepoch()
      FROM json_each(?1) AS entry JOIN managed_site_audit AS audit ON audit.id = json_extract(entry.value, '$.auditId')
      WHERE mp.site_id = ?2 AND mp.page_id = json_extract(entry.value, '$.pageId') AND mp.locale = json_extract(entry.value, '$.locale')
        AND ${auditCount("?1")} = ?3 AND changes() = ?3`)
      .bind(payload, siteId, expectedCount),
    db.prepare(`UPDATE managed_sites SET page_catalog_version = ?1 WHERE site_id = ?2 AND page_catalog_version = ?3
      AND ${auditCount("?5")} = ?4 AND changes() = ?4`).bind(nextCatalogVersion, siteId, catalogVersion, expectedCount, payload),
    db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
      WHERE site_id = ?3 AND version = ?4 AND changes() = 1
        AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?3 AND page_catalog_version = ?5)
        AND EXISTS (SELECT 1 FROM managed_site_styles WHERE site_id = ?3 AND published_version = ?8)
        AND ${auditCount("?7")} = ?6`)
      .bind(prepared.manifestVersion, prepared.manifestKey, siteId, prepared.expectedVersion, nextCatalogVersion, expectedCount, payload, prepared.siteStylesVersion),
    ...writes.flatMap((write) => write.copy && write.currentVersion
      ? [discardSupersededDraft(db, write.row, write.currentVersion)] : [])
  ]);
  if (results.some((result) => !result.success)) throw new Error("managed page publication batch failed");
  return results[0]?.meta?.changes === expectedCount && changed(results[1]) && results[3]?.meta?.changes === expectedCount
    && results[4]?.meta?.changes === expectedCount && changed(results[5]) && changed(results[6]);
}

type ManagedPublicationCandidate = {
  readonly project_id: string; readonly site_id: string; readonly slug: string; readonly public_domain: string | null;
  readonly cms_locale: string; readonly page_id: string; readonly locale: string; readonly title: string; readonly path: string;
  readonly visibility: "public" | "private"; readonly current_version: string; readonly page_catalog_version: string;
  readonly current_revision: number; readonly published_revision: number | null;
  readonly current_document_json: string; readonly current_document_key: string | null; readonly current_document_digest: string | null;
  readonly current_bindings_json: string | null;
  readonly published_document_json: string | null; readonly published_document_key: string | null; readonly published_document_digest: string | null;
  readonly published_bindings_json: string | null; readonly published_path: string | null; readonly published_at: number | null;
  readonly published_manifest_key: string | null;
  readonly cms_release_id: string | null; readonly cms_schema_revision: string | null;
};

type ManagedPublicationSnapshot = {
  readonly version: string; readonly publicationVersion: string; readonly manifestKey: string | null;
  readonly catalogVersion: string; readonly policyVersion: string; readonly domainVersion: string;
  readonly policyJson: string; readonly slug: string; readonly siteName: string; readonly publicDomain: string | null;
  readonly manifest: PublishedSiteManifest | null; readonly pages: readonly ManagedPublicationCandidate[];
  readonly styles: Awaited<ReturnType<typeof readManagedSiteStyles>>;
  readonly changes: EditingPublicationChanges;
};

async function managedPublicationSnapshot(store: CmsStore, actor: ManagedActor, projectId: string, siteId: string): Promise<ManagedPublicationSnapshot | null> {
  const { db } = store;
  const registration = await managedMemberRegistration(db, actor, projectId, siteId);
  if (!registration) return null;
  const state = await db.prepare(`SELECT state.version AS publication_version, state.manifest_key,
      ms.page_catalog_version, ms.public_policy_json, ms.public_policy_version, ms.public_domain_version,
      ms.slug, ${PRIMARY_DOMAIN} AS public_domain, s.name AS site_name
    FROM managed_site_publication_state AS state JOIN managed_sites AS ms ON ms.site_id = state.site_id
    JOIN sites AS s ON s.id = ms.site_id WHERE state.site_id = ?1 AND s.project_id = ?2`)
    .bind(siteId, projectId).first<{ publication_version: string; manifest_key: string | null; page_catalog_version: string;
      public_policy_json: string; public_policy_version: string; public_domain_version: string; slug: string;
      public_domain: string | null; site_name: string }>();
  if (!state) return null;
  const pageResult = await db.prepare(`SELECT s.project_id, mp.site_id, ms.slug, ${PRIMARY_DOMAIN} AS public_domain,
      COALESCE((SELECT locale FROM managed_pages WHERE site_id = mp.site_id AND page_id = 'home' ORDER BY locale LIMIT 1), mp.locale) AS cms_locale,
      mp.page_id, mp.locale, mp.title, mp.path, mp.visibility, mp.current_version, ms.page_catalog_version,
      mp.current_revision, mp.published_revision,
      current_version.document_json AS current_document_json, current_version.document_key AS current_document_key,
      current_version.document_digest AS current_document_digest, current_version.bindings_json AS current_bindings_json,
      published_version.document_json AS published_document_json, published_version.document_key AS published_document_key,
      published_version.document_digest AS published_document_digest, published_version.bindings_json AS published_bindings_json,
      publication.published_path, publication.created_at AS published_at, publication.manifest_key AS published_manifest_key,
      publication.cms_release_id, publication.cms_schema_revision
    FROM managed_pages AS mp JOIN managed_sites AS ms ON ms.site_id = mp.site_id JOIN sites AS s ON s.id = mp.site_id
    JOIN managed_page_versions AS current_version ON current_version.site_id = mp.site_id AND current_version.page_id = mp.page_id
      AND current_version.locale = mp.locale AND current_version.revision = mp.current_revision
    LEFT JOIN managed_page_versions AS published_version ON published_version.site_id = mp.site_id AND published_version.page_id = mp.page_id
      AND published_version.locale = mp.locale AND published_version.revision = mp.published_revision
    LEFT JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
      AND publication.site_id = mp.site_id AND publication.page_id = mp.page_id AND publication.locale = mp.locale
    WHERE mp.site_id = ?1 AND s.project_id = ?2 ORDER BY mp.path, mp.locale LIMIT 500`)
    .bind(siteId, projectId).all<ManagedPublicationCandidate>();
  if (!pageResult.success || !pageResult.results) throw new Error("managed publication page lookup failed");
  const manifest = await loadPublishedSiteManifest(store.bucket, siteId, state.manifest_key);
  const styles = await readManagedSiteStyles(store, siteId);
  const routeKeys = new Set((manifest?.routes ?? []).map((route) => `${route.pageId}\u0000${route.locale}`));
  const changes: EditingPublicationChanges["changes"][number][] = [];
  for (const page of pageResult.results) {
    const key = `${page.page_id}\u0000${page.locale}`;
    const wasPublic = routeKeys.has(key) || !manifest && page.published_revision !== null && page.visibility === "public";
    const publishedRoute = manifest?.routes.find((route) => route.pageId === page.page_id && route.locale === page.locale);
    const publishedPath = publishedRoute?.sourcePath ?? publishedRoute?.path ?? page.published_path;
    let reason: "new" | "draft" | "path" | "visibility" | null = null;
    if (page.visibility === "private" && wasPublic || page.visibility === "public" && !wasPublic && page.published_revision !== null) reason = "visibility";
    else if (page.visibility === "public" && !wasPublic && page.published_revision === null) reason = "new";
    else if (page.visibility === "public" && wasPublic && publishedPath !== undefined && publishedPath !== page.path) reason = "path";
    else if (page.visibility === "public" && (!wasPublic || page.published_revision === null || page.current_revision !== (publishedRoute?.sourceRevision ?? page.published_revision))) reason = page.published_revision === null ? "new" : "draft";
    if (reason) changes.push({ kind: "page", target: { siteId, pageId: page.page_id, locale: page.locale }, title: page.title, path: page.path, reason });
  }
  if (manifest?.publicPolicyVersion !== state.public_policy_version) {
    changes.push({ kind: "shared", id: "public-policy", label: "サイト共通設定", appliesToAllPages: true });
  }
  if (manifest?.publicDomainVersion !== state.public_domain_version) {
    changes.push({ kind: "shared", id: "public-domain", label: "公開ドメイン", appliesToAllPages: true });
  }
  if (manifest?.siteStylesVersion !== styles.draft.version) {
    changes.push({ kind: "shared", id: "site-styles", label: "サイト共通スタイル", appliesToAllPages: true });
  }
  const version = `changes.${await digest({ publicationVersion: state.publication_version, manifestKey: state.manifest_key,
    catalogVersion: state.page_catalog_version, policyVersion: state.public_policy_version, domainVersion: state.public_domain_version,
    styleDraftVersion: styles.draft.version, stylePublishedVersion: styles.published.version,
    pages: pageResult.results.map(({ page_id, locale, current_version, current_revision, published_revision, path, visibility }) =>
      [page_id, locale, current_version, current_revision, published_revision, path, visibility]) })}`;
  return { version, publicationVersion: state.publication_version, manifestKey: state.manifest_key,
    catalogVersion: state.page_catalog_version, policyVersion: state.public_policy_version, domainVersion: state.public_domain_version,
    policyJson: state.public_policy_json, slug: state.slug, siteName: state.site_name, publicDomain: state.public_domain,
    manifest, pages: pageResult.results, styles, changes: { version, changes } };
}

function publicationSource(page: ManagedPublicationCandidate, current: boolean): PageSourceRow | null {
  const revision = current ? page.current_revision : page.published_revision;
  if (revision === null) return null;
  return { site_id: page.site_id, page_id: page.page_id, locale: page.locale, revision,
    document_json: current ? page.current_document_json : page.published_document_json ?? "{}",
    document_key: current ? page.current_document_key : page.published_document_key,
    document_digest: current ? page.current_document_digest : page.published_document_digest };
}

function publicationBindings(page: ManagedPublicationCandidate, current: boolean): string | null {
  return current ? page.current_bindings_json : page.published_bindings_json;
}

function publicationRoute(page: Pick<ManagedPublicationCandidate, "page_id" | "locale">, manifest: PublishedSiteManifest | null) {
  return manifest?.routes.find((route) => route.pageId === page.page_id && route.locale === page.locale);
}

async function historicalPublishedSource(store: CmsStore, source: PageSourceRow & { bindings_json: string | null }, revision: number) {
  if (source.revision === revision) return source;
  const row = await store.db.prepare(`SELECT site_id, page_id, locale, revision, document_json, document_key, document_digest, bindings_json
    FROM managed_page_versions WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4`)
    .bind(source.site_id, source.page_id, source.locale, revision).first<PageSourceRow & { bindings_json: string | null }>();
  if (!row) throw new Error("historical published page is unavailable");
  return row;
}

function pageIsPublished(page: ManagedPublicationCandidate, publishedKeys: ReadonlySet<string>, hasManifest: boolean): boolean {
  return page.published_revision !== null && (publishedKeys.has(page.page_id + "\u0000" + page.locale)
    || page.visibility === "public" && (!hasManifest || page.published_bindings_json !== null));
}

async function publishedCmsSnapshots(store: CmsStore, siteId: string, next?: CmsReleaseSnapshot) {
  const row = await store.db.prepare("SELECT state_json FROM managed_cms_state WHERE site_id = ?1").bind(siteId).first<{ state_json: string }>();
  const state = row ? JSON.parse(row.state_json) as Site["state"] : null;
  const refs = new Map(Object.entries(state?.localizedReleases ?? {}).map(([locale, release]) => [locale, release.id]));
  if (state?.current) refs.set(state.locale, state.current.id);
  if (next) refs.set(next.locale, next.releaseId);
  return Promise.all([...refs.values()].map((id) => next?.releaseId === id ? next : store.snapshot(siteId, id)));
}

function publicReleaseRedirects(pageRedirects: readonly ManagedSiteRedirect[], cmsSnapshots: readonly CmsReleaseSnapshot[]): ManagedSiteRedirect[] {
  const redirects = new Map<string, ManagedSiteRedirect>();
  for (const redirect of pageRedirects) redirects.set(redirect.locale + "\u0000" + redirect.fromPath, redirect);
  for (const snapshot of cmsSnapshots) for (const { from, to } of snapshot.redirects)
    redirects.set(snapshot.locale + "\u0000" + from, { locale: snapshot.locale, fromPath: from, toPath: to });
  return [...redirects.values()];
}

function publishedMetadataWarnings(routes: readonly PublishedRoute[], changedPaths: readonly string[]): ManagedSeoWarning[] {
  const changed = new Set(changedPaths), warnings: ManagedSeoWarning[] = [];
  const indexed = routes.filter((route) => !route.noindex);
  for (const route of indexed) {
    if (!changed.has(route.path)) continue;
    const title = seoComparisonKey(route.title), description = seoComparisonKey(route.description);
    for (const peer of indexed) {
      if (peer === route || peer.locale !== route.locale) continue;
      if (title && title === seoComparisonKey(peer.title)) warnings.push({ code: "duplicate-title", message: "公開ページ「" + peer.path + "」と title が重複しています。" });
      if (description && description === seoComparisonKey(peer.description)) warnings.push({ code: "duplicate-description", message: "公開ページ「" + peer.path + "」と description が重複しています。" });
      if (warnings.length >= 100) return warnings.slice(0, 100);
    }
  }
  return warnings;
}

type PublishedPageMutation = Pick<ManagedPagePublicationTarget, "pageId" | "locale" | "path" | "public"> | ManagedPagePublicationTarget;

/** Rebuild the live edition with one explicitly changed source or route. */
async function prepareManagedPublishedPageMutation(store: CmsStore, edition: ManagedPublicationSnapshot, siteId: string,
  origin: string, publicationId: string, mutation: PublishedPageMutation, redirects?: readonly ManagedSiteRedirect[]) {
  const base = new URL(edition.manifest?.publicBaseUrl ?? managedPageUrl(origin, edition.slug, "/", edition.publicDomain));
  const prefix = base.pathname.replace(/\/$/u, "");
  const snapshots = await publishedCmsSnapshots(store, siteId);
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.releaseId, snapshot]));
  const previousRoutes = edition.manifest?.routes ?? [];
  const publishedKeys = new Set(previousRoutes.map((route) => route.pageId + "\u0000" + route.locale));
  const targets: ManagedPagePublicationTarget[] = "readDocument" in mutation ? [mutation] : [];
  for (const page of edition.pages) {
    const selected = page.page_id === mutation.pageId && page.locale === mutation.locale;
    if (selected ? "readDocument" in mutation || !mutation.public
      : !pageIsPublished(page, publishedKeys, edition.manifest !== null)) continue;
    const route = publicationRoute(page, edition.manifest);
    const previousPath = route?.sourcePath ?? route?.path ?? page.published_path ?? page.path;
    const path = selected ? mutation.path : previousPath;
    try {
      const source = publicationSource(page, false);
      if (!source) throw new Error("missing published page source");
      const version = { ...source, bindings_json: page.published_bindings_json };
      const pinned = route ? await historicalPublishedSource(store, version, route.sourceRevision) : version;
      const identity = { siteId, pageId: page.page_id, locale: page.locale };
      const bindings = pinned.bindings_json ? parseCmsPageBindings(JSON.parse(pinned.bindings_json), identity) : null;
      const releaseId = route?.cmsReleaseId ?? page.cms_release_id;
      const cms = bindings && releaseId ? snapshotsById.get(releaseId) ?? await store.snapshot(siteId, releaseId) : null;
      if (bindings && (!cms || cms.locale !== page.locale)) throw new Error("missing CMS release");
      if (cms) snapshotsById.set(cms.releaseId, cms);
      const original = selected && !route && page.published_manifest_key
        ? publicationRoute(page, await loadPublishedSiteManifest(store.bucket, siteId, page.published_manifest_key).catch(() => null)) : undefined;
      const lastModified = original?.lastModified
        ?? (page.published_at === null ? undefined : new Date(page.published_at * 1000).toISOString());
      targets.push({ ...identity, path, public: true, sourceRevision: pinned.revision,
        ...(bindings ? { bindings } : {}), ...(cms ? { cmsSnapshot: cms } : {}),
        ...(selected ? { previousPath, ...(lastModified ? { lastModified } : {}) } : {}),
        readDocument: () => readPageSource(store, pinned, edition.styles.published.styles) });
    } catch (error) { throw new ManagedPagePublicationError(base.origin + prefix + path, { cause: error }); }
  }
  const policy = parseManagedPublicPolicy(edition.manifest?.publicPolicy ?? JSON.parse(edition.policyJson), base.origin) ?? emptyManagedPublicPolicy();
  const cms = await prepareManagedCmsStaticRoutes({ snapshots, previousRoutes, origin: base.origin, prefix, siteName: edition.siteName, policy });
  const prepared = await prepareManagedPagePublicationBatch({ store, siteId, targets, replacePages: [], replaceAll: true,
    expectedVersion: edition.publicationVersion, publicationId, publicUrl: base, publicPrefix: prefix, policyMode: "published",
    siteStyles: edition.styles.published.styles, siteStylesVersion: edition.styles.published.version,
    additionalRoutes: cms.routes, additionalPaths: cms.paths,
    redirects: publicReleaseRedirects(redirects ?? edition.manifest?.redirects ?? [], snapshots) });
  if (!prepared || prepared.expectedPolicyVersion !== edition.policyVersion || prepared.expectedDomainVersion !== edition.domainVersion) return null;
  return { ...prepared, url: base.origin + prefix + mutation.path, urls: prepared.changedPaths.map((path) => base.origin + prefix + path) };
}

async function publishManagedPages(store: CmsStore, actor: ManagedActor, projectId: string, siteId: string,
  publicOrigin: string, input: EditingSitePublishInput,
  requested?: { readonly target: EditingPageTarget; readonly expectedVersion: string },
  expectedSiteStyleVersions?: EditingSiteStylesPublishRequest): Promise<EditingSitePublishResult & { readonly pageSnapshot?: unknown; readonly pageUrl?: string }> {
  const { db } = store;
  const startedAt = Date.now();
  const styleOnly = expectedSiteStyleVersions !== undefined;
  const edition = await managedPublicationSnapshot(store, actor, projectId, siteId);
  if (!edition) return { status: "conflict" };
  if (expectedSiteStyleVersions && (edition.styles.draft.version !== expectedSiteStyleVersions.expectedDraftVersion
    || edition.styles.published.version !== expectedSiteStyleVersions.expectedPublishedVersion
    || edition.styles.draft.version === edition.styles.published.version)) return { status: "conflict" };
  if (!requested && edition.version !== input.expectedVersion) return { status: "conflict" };

  const selected = new Set<string>();
  let requestedPage: ManagedPublicationCandidate | undefined;
  if (requested) {
    requestedPage = edition.pages.find((page) => page.page_id === requested.target.pageId && page.locale === requested.target.locale);
    if (!requestedPage || requestedPage.current_version !== requested.expectedVersion || requested.target.siteId !== siteId) return { status: "conflict" };
    selected.add(requestedPage.page_id + "\u0000" + requestedPage.locale);
  } else if (input.scope === "pages") {
    for (const { pageId, locale } of input.pages) {
      if (!edition.pages.some((page) => page.page_id === pageId && page.locale === locale)) return { status: "conflict" };
      selected.add(pageId + "\u0000" + locale);
    }
  } else if (input.scope === "changed" && !styleOnly) {
    for (const change of edition.changes.changes) if (change.kind === "page") selected.add(change.target.pageId + "\u0000" + change.target.locale);
  }
  const publishShared = !requested && !styleOnly && (input.scope === "site" || input.scope === "changed")
    && edition.changes.changes.some((change) => change.kind === "shared");
  const publishStyles = (publishShared || styleOnly) && edition.styles.draft.version !== edition.styles.published.version;
  if (!selected.size && !publishShared && !styleOnly && input.scope !== "all") {
    return { status: "released", urls: [], elapsedMs: Date.now() - startedAt, warnings: [] };
  }
  const styles = publishStyles ? edition.styles.draft : edition.styles.published;
  const baseUrl = publishShared ? managedPageUrl(publicOrigin, edition.slug, "/", edition.publicDomain)
    : edition.manifest?.publicBaseUrl ?? managedPageUrl(publicOrigin, edition.slug, "/", edition.publicDomain);
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/u, "");
  const publishedKeys = new Set((edition.manifest?.routes ?? []).map((route) => route.pageId + "\u0000" + route.locale));
  const targets: ManagedPagePublicationTarget[] = [];
  const writes: ManagedPagePublicationWrite[] = [];
  let requestedDocument: PageDocument | undefined, requestedBindings: CmsPageBindingsDocument | null = null;
  let prepared: NonNullable<Awaited<ReturnType<typeof prepareManagedPagePublicationBatch>>>;
  try {
    const cmsSnapshots = await publishedCmsSnapshots(store, siteId);
    const cmsById = new Map(cmsSnapshots.map((snapshot) => [snapshot.releaseId, snapshot]));
    const cmsByLocale = new Map(cmsSnapshots.map((snapshot) => [snapshot.locale, snapshot]));
    for (const page of edition.pages) {
      const current = selected.has(page.page_id + "\u0000" + page.locale);
      if (!current && !pageIsPublished(page, publishedKeys, edition.manifest !== null)) continue;
      const source = publicationSource(page, current);
      if (!source) continue;
      const route = current ? undefined : publicationRoute(page, edition.manifest);
      const path = current ? page.path : route?.sourcePath ?? route?.path ?? page.published_path ?? page.path;
      try {
        const version = { ...source, bindings_json: publicationBindings(page, current) };
        const pinned = route ? await historicalPublishedSource(store, version, route.sourceRevision) : version;
        const bindingsJson = pinned.bindings_json;
        const releaseId = route?.cmsReleaseId ?? page.cms_release_id;
        const target = { siteId, pageId: page.page_id, locale: page.locale };
        const bindings = bindingsJson ? parseCmsPageBindings(JSON.parse(bindingsJson), target) : null;
        const cms = bindings ? current ? cmsByLocale.get(page.locale)
          : releaseId ? cmsById.get(releaseId) ?? await store.snapshot(siteId, releaseId) : undefined : undefined;
        if (bindings && (!cms || cms.locale !== page.locale)) throw new Error("missing CMS release");
        if (cms) cmsById.set(cms.releaseId, cms);
        targets.push({ ...target, path, public: current ? page.visibility === "public" : true, sourceRevision: route?.sourceRevision ?? source.revision,
          ...(bindings ? { bindings } : {}), ...(cms ? { cmsSnapshot: cms } : {}),
          readDocument: async () => {
            if (page === requestedPage && requestedDocument) return requestedDocument;
            const document = await readPageSource(store, pinned, styles.styles);
            if (page === requestedPage) { requestedDocument = document; requestedBindings = bindings; }
            return document;
          } });
        if (!current) continue;
        const row: ManagedPageRow = { ...source, project_id: page.project_id, site_id: page.site_id, slug: page.slug,
          public_domain: page.public_domain, cms_locale: page.cms_locale, title: page.title, path, visibility: page.visibility,
          current_version: page.current_version, page_catalog_version: page.page_catalog_version, current_revision: page.current_revision,
          published_revision: page.published_revision, bindings_json: bindingsJson };
        writes.push({ row, expectedVersion: page.current_version, sourceRevision: source.revision, revision: source.revision,
          action: "publish", auditAction: "page.published", publicationId: crypto.randomUUID(),
          cmsReleaseId: cms?.releaseId ?? null, cmsSchemaRevision: cms?.schema.schemaRevision ?? null,
          publishedPath: path, artifactKey: null, artifactDigest: null, contentSecurityPolicy: null,
          updateCurrent: true, currentVersion: opaqueVersion() });
      } catch (error) { throw new ManagedPagePublicationError(base.origin + prefix + path, { cause: error }); }
    }
    const policyMode = publishShared ? "current" : "published";
    const policy = parseManagedPublicPolicy(policyMode === "published" && edition.manifest?.publicPolicy
      ? edition.manifest.publicPolicy : JSON.parse(edition.policyJson), base.origin) ?? emptyManagedPublicPolicy();
    const cms = await prepareManagedCmsStaticRoutes({ snapshots: cmsSnapshots, previousRoutes: edition.manifest?.routes ?? [],
      origin: base.origin, prefix, siteName: edition.siteName, policy });
    const redirectRows = await db.prepare(`SELECT locale, from_path AS fromPath, to_path AS toPath
      FROM managed_site_redirects WHERE site_id = ?1 ORDER BY from_path`).bind(siteId).all<ManagedSiteRedirect>();
    if (!redirectRows.success) throw new Error("managed redirect lookup failed");
    const redirectSources = publishShared || !edition.manifest ? redirectRows.results ?? [] : edition.manifest.redirects ?? [];
    const result = await prepareManagedPagePublicationBatch({ store, siteId, targets, replacePages: [], replaceAll: true,
      expectedVersion: edition.publicationVersion, publicationId: crypto.randomUUID(), publicUrl: base, publicPrefix: prefix,
      policyMode, siteStyles: styles.styles, siteStylesVersion: styles.version, publishSiteStyles: publishStyles,
      additionalRoutes: cms.routes, additionalPaths: cms.paths, redirects: publicReleaseRedirects(redirectSources, cmsSnapshots) });
    if (!result || result.expectedPolicyVersion !== edition.policyVersion || result.expectedDomainVersion !== edition.domainVersion) return { status: "conflict" };
    prepared = result;
  } catch (error) {
    return { status: "failed", failedUrl: error instanceof ManagedPagePublicationError ? error.url : baseUrl,
      message: "ページの公開生成に失敗しました。" };
  }

  const writtenPages = writes.map((write) => {
    const artifact = [...prepared.artifacts.values()].find(({ pageId, locale }) => pageId === write.row.page_id && locale === write.row.locale);
    return { ...write, artifactKey: artifact?.artifactKey ?? null, artifactDigest: artifact?.artifactDigest ?? null,
      contentSecurityPolicy: artifact?.contentSecurityPolicy ?? null };
  });
  if (!await commitManagedPagePublicationBatch({ db, actor, siteId, projectId, catalogVersion: edition.catalogVersion,
    cmsGeneration: null, prepared, writes: writtenPages })) return { status: "conflict" };

  const urls = prepared.changedPaths.map((path) => base.origin + prefix + path);
  const warnings = boundedManagedSeoWarnings([...prepared.warnings, ...publishedMetadataWarnings(prepared.routes, prepared.changedPaths)]);
  const output = { status: "released" as const, urls, elapsedMs: Date.now() - startedAt, warnings };
  if (!requestedPage || !requestedDocument) return output;
  const row = await pageRow(db, projectId, siteId, requestedPage.page_id, requestedPage.locale);
  if (!row) return output;
  return { ...output, pageSnapshot: { document: requestedDocument, version: row.current_version, hasSavedDraft: true, releases: await releases(db, row),
    ...(row.locale === row.cms_locale ? { cmsBindings: requestedBindings } : {}) }, pageUrl: base.origin + prefix + requestedPage.path };
}

type ManagedCmsBoundPage = ManagedPageRow & {
  readonly cms_locale: string;
  readonly published_publication_id: string;
  readonly published_path: string | null;
  readonly cms_release_id: string | null;
};

/** Render the current site with the new CMS snapshot before either pointer changes. */
export async function prepareManagedCmsPublication(store: CmsStore, site: Site, next: CmsReleaseSnapshot): Promise<CmsPublishCommit | undefined> {
  const { db } = store, siteId = site.siteId, actor: ManagedActor = {
    subject: site.actor.id, email: "", cli: site.actor.cli,
    ...(site.actor.clientId ? { cliClientId: site.actor.clientId } : {})
  };
  const state = await db.prepare(`SELECT state.version, state.manifest_key, ms.page_catalog_version, ms.public_policy_version,
      ms.public_domain_version, ms.public_policy_json, ms.slug, ${PRIMARY_DOMAIN} AS public_domain, s.name AS site_name
    FROM managed_site_publication_state AS state JOIN managed_sites AS ms ON ms.site_id = state.site_id
    JOIN sites AS s ON s.id = ms.site_id WHERE state.site_id = ?1 AND s.project_id = ?2`)
    .bind(siteId, site.projectId).first<{ version: string; manifest_key: string | null; page_catalog_version: string;
      public_policy_version: string; public_domain_version: string; public_policy_json: string; slug: string; public_domain: string | null; site_name: string }>();
  if (!state) return undefined;
  const manifest = state.manifest_key ? await loadPublishedSiteManifest(store.bucket, siteId, state.manifest_key) : null;
  if (state.manifest_key && !manifest) throw new Error("published site manifest unavailable for CMS publication");
  const pageResult = await db.prepare(`SELECT s.project_id, mp.site_id, ms.slug, ${PRIMARY_DOMAIN} AS public_domain,
      mp.locale AS cms_locale, mp.page_id, mp.locale, mp.title, mp.path, mp.visibility, mp.current_version, ms.page_catalog_version,
      mp.current_revision, mp.published_revision, version.document_json, version.document_key, version.document_digest,
      version.bindings_json, publication.id AS published_publication_id, publication.published_path, publication.cms_release_id
    FROM managed_pages AS mp JOIN managed_sites AS ms ON ms.site_id = mp.site_id JOIN sites AS s ON s.id = ms.site_id
    JOIN managed_page_versions AS version ON version.site_id = mp.site_id AND version.page_id = mp.page_id
      AND version.locale = mp.locale AND version.revision = mp.published_revision
    JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
      AND publication.site_id = mp.site_id AND publication.page_id = mp.page_id AND publication.locale = mp.locale
    WHERE mp.site_id = ?1 AND s.project_id = ?2 AND mp.published_revision IS NOT NULL
    ORDER BY mp.path, mp.locale LIMIT 500`).bind(siteId, site.projectId).all<ManagedCmsBoundPage>();
  if (!pageResult.success || !pageResult.results) throw new Error("managed published page lookup failed");

  const sharedHost = await db.prepare(`SELECT hostname FROM managed_site_hosts WHERE site_id = ?1
    AND path_prefix = ?2 AND noindex = 0 AND enabled = 1 LIMIT 1`).bind(siteId, "/s/" + state.slug).first<{ hostname: string }>();
  const baseUrl = manifest?.publicBaseUrl ?? (state.public_domain ? "https://" + state.public_domain + "/"
    : sharedHost ? "https://" + sharedHost.hostname + "/s/" + state.slug
    : store.publicOrigin ? managedPageUrl(store.publicOrigin, state.slug, "/", null) : null);
  if (!baseUrl) throw new Error("managed public origin unavailable");
  const base = new URL(baseUrl), prefix = base.pathname.replace(/\/$/u, "");
  const styles = await readManagedPublishedSiteStyles(store, siteId);
  const snapshots = await publishedCmsSnapshots(store, siteId, next);
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.releaseId, snapshot]));
  const publishedKeys = new Set((manifest?.routes ?? []).map((route) => route.pageId + "\u0000" + route.locale));
  const targets: ManagedPagePublicationTarget[] = [], updatedBindings: ManagedPagePublicationTarget[] = [];
  const rows = new Map<string, ManagedCmsBoundPage>();
  for (const page of pageResult.results) {
    const key = page.page_id + "\u0000" + page.locale;
    if (!publishedKeys.has(key) && (page.visibility !== "public" || manifest && !page.bindings_json)) continue;
    const source: PageSourceRow = { site_id: siteId, page_id: page.page_id, locale: page.locale,
      revision: page.published_revision!, document_json: page.document_json, document_key: page.document_key, document_digest: page.document_digest };
    const route = publicationRoute(page, manifest);
    const path = route?.sourcePath ?? route?.path ?? page.published_path ?? page.path;
    try {
      const version = { ...source, bindings_json: page.bindings_json };
      const pinned = route ? await historicalPublishedSource(store, version, route.sourceRevision) : version;
      const bindingsJson = pinned.bindings_json;
      const releaseId = route?.cmsReleaseId ?? page.cms_release_id;
      const identity = { siteId, pageId: page.page_id, locale: page.locale };
      const bindings = bindingsJson ? parseCmsPageBindings(JSON.parse(bindingsJson), identity) : null;
      const bindingUpdated = !!bindings && page.locale === next.locale;
      const cms = !bindings ? undefined : bindingUpdated ? next : releaseId
        ? snapshotsById.get(releaseId) ?? await store.snapshot(siteId, releaseId) : undefined;
      if (bindings && !cms) throw new Error("missing CMS release");
      if (cms) snapshotsById.set(cms.releaseId, cms);
      const target = { ...identity, path, sourceRevision: route?.sourceRevision ?? source.revision, public: true,
        ...(bindings ? { bindings } : {}), ...(cms ? { cmsSnapshot: cms } : {}),
        readDocument: () => readPageSource(store, pinned, styles) };
      targets.push(target);
      if (bindingUpdated && target.sourceRevision === page.published_revision) {
        updatedBindings.push(target);
        rows.set(key, page);
      }
    } catch (error) { throw new ManagedPagePublicationError(base.origin + prefix + path, { cause: error }); }
  }

  const policy = parseManagedPublicPolicy(manifest?.publicPolicy ?? JSON.parse(state.public_policy_json), base.origin) ?? emptyManagedPublicPolicy();
  const cms = await prepareManagedCmsStaticRoutes({ snapshots, previousRoutes: manifest?.routes ?? [], updatedLocale: next.locale,
    origin: base.origin, prefix, siteName: state.site_name, policy });
  const pageRedirects = (manifest?.redirects ?? []).filter(({ fromPath }) => !/^\/(?:[A-Za-z]{2,3}\/)?cms(?:\/|$)/u.test(fromPath));
  const prepared = await prepareManagedPagePublicationBatch({ store, siteId, targets, replacePages: [], replaceAll: true,
    expectedVersion: state.version, publicationId: crypto.randomUUID(), publicUrl: base, publicPrefix: prefix,
    additionalRoutes: cms.routes, additionalPaths: cms.paths, policyMode: "published",
    redirects: publicReleaseRedirects(pageRedirects, snapshots) });
  if (!prepared) throw new Error("managed CMS publication version changed");
  const entries = updatedBindings.map((target) => {
    const row = rows.get(`${target.pageId}\u0000${target.locale}`)!;
    const artifact = [...prepared.artifacts.values()].find((candidate) => candidate.pageId === target.pageId && candidate.locale === target.locale);
    return { auditId: crypto.randomUUID(), pageId: target.pageId, locale: target.locale, expectedVersion: row.current_version,
      sourceRevision: target.sourceRevision, revision: target.sourceRevision, publicationId: crypto.randomUUID(), cmsReleaseId: next.releaseId,
      cmsSchemaRevision: next.schema.schemaRevision, publishedPath: target.path, artifactKey: artifact?.artifactKey ?? null,
      artifactDigest: artifact?.artifactDigest ?? null, contentSecurityPolicy: artifact?.contentSecurityPolicy ?? null,
      manifestKey: prepared.manifestKey, publishedPublicationId: row.published_publication_id, publishedRevision: row.published_revision };
  });
  const payload = JSON.stringify(entries), expectedCount = entries.length;
  const auditCount = (payloadParameter: string) => `(SELECT count(*) FROM managed_site_audit WHERE id IN
    (SELECT json_extract(value, '$.auditId') FROM json_each(${payloadParameter})))`;
  const gateSql = `EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?2 AND version = ?11 AND manifest_key IS ?12)
    AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?2 AND page_catalog_version = ?13
      AND public_policy_version = ?14 AND public_domain_version = ?15)
    AND ?17 = (SELECT count(*) FROM json_each(?16) AS expected
      JOIN managed_pages AS page ON page.site_id = ?2 AND page.page_id = json_extract(expected.value, '$.pageId')
        AND page.locale = json_extract(expected.value, '$.locale')
      WHERE page.current_version = json_extract(expected.value, '$.expectedVersion')
        AND page.published_revision = json_extract(expected.value, '$.publishedRevision')
        AND page.published_publication_id = json_extract(expected.value, '$.publishedPublicationId')
        AND EXISTS (SELECT 1 FROM managed_page_versions AS version WHERE version.site_id = page.site_id
          AND version.page_id = page.page_id AND version.locale = page.locale AND version.revision = json_extract(expected.value, '$.sourceRevision')))`;
  const statementValues = [payload, siteId, actor.subject, site.projectId, state.page_catalog_version, state.version,
    state.manifest_key, state.public_policy_version, state.public_domain_version];
  return { gateSql, gateValues: [state.version, state.manifest_key, state.page_catalog_version, state.public_policy_version,
    state.public_domain_version, payload, expectedCount], statements: (generation: string) => [
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
      SELECT json_extract(entry.value, '$.auditId'), ?4, ?2, ?3, 'page.published', json_extract(entry.value, '$.pageId')
      FROM json_each(?1) AS entry JOIN managed_pages AS page ON page.site_id = ?2
        AND page.page_id = json_extract(entry.value, '$.pageId') AND page.locale = json_extract(entry.value, '$.locale')
      JOIN managed_sites AS managed ON managed.site_id = page.site_id
      WHERE page.current_version = json_extract(entry.value, '$.expectedVersion') AND managed.page_catalog_version = ?5
        AND managed.public_policy_version = ?8 AND managed.public_domain_version = ?9
        AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?2 AND version = ?6 AND manifest_key IS ?7)
        AND EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = ?2 AND generation = ?10)
        AND ?11 = (SELECT count(*) FROM json_each(?1))`)
      .bind(...statementValues, generation, expectedCount),
    db.prepare(`INSERT INTO managed_page_publications (id, site_id, page_id, locale, source_revision, action, published_by_subject,
        cms_release_id, cms_schema_revision, published_path, path, artifact_key, artifact_digest, manifest_key, content_type, content_security_policy)
      SELECT json_extract(entry.value, '$.publicationId'), ?2, json_extract(entry.value, '$.pageId'), json_extract(entry.value, '$.locale'),
        json_extract(entry.value, '$.revision'), 'publish', ?3, json_extract(entry.value, '$.cmsReleaseId'),
        json_extract(entry.value, '$.cmsSchemaRevision'), json_extract(entry.value, '$.publishedPath'), json_extract(entry.value, '$.publishedPath'),
        json_extract(entry.value, '$.artifactKey'), json_extract(entry.value, '$.artifactDigest'), json_extract(entry.value, '$.manifestKey'),
        CASE WHEN json_extract(entry.value, '$.artifactKey') IS NULL THEN NULL ELSE 'text/html; charset=utf-8' END,
        json_extract(entry.value, '$.contentSecurityPolicy')
      FROM json_each(?1) AS entry JOIN managed_site_audit AS audit ON audit.id = json_extract(entry.value, '$.auditId')
      WHERE ${auditCount("?1")} = ?4`).bind(payload, siteId, actor.subject, expectedCount),
    db.prepare(`UPDATE managed_pages AS page SET published_revision = json_extract(entry.value, '$.revision'),
        published_publication_id = json_extract(entry.value, '$.publicationId'), updated_at = unixepoch()
      FROM json_each(?1) AS entry JOIN managed_site_audit AS audit ON audit.id = json_extract(entry.value, '$.auditId')
      WHERE page.site_id = ?2 AND page.page_id = json_extract(entry.value, '$.pageId') AND page.locale = json_extract(entry.value, '$.locale')
        AND ${auditCount("?1")} = ?3`).bind(payload, siteId, expectedCount),
    db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
      WHERE site_id = ?3 AND version = ?4 AND manifest_key IS ?5 AND EXISTS (
        SELECT 1 FROM managed_sites WHERE site_id = ?3 AND page_catalog_version = ?6
          AND public_policy_version = ?7 AND public_domain_version = ?8)
        AND EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = ?3 AND generation = ?9)
        AND ${auditCount("?11")} = ?10`)
      .bind(prepared.manifestVersion, prepared.manifestKey, siteId, prepared.expectedVersion, state.manifest_key,
        state.page_catalog_version, prepared.expectedPolicyVersion, prepared.expectedDomainVersion, generation, expectedCount, payload)
  ] };
}

async function publishPageOnce(store: CmsStore, actor: ManagedActor, row: ManagedPageRow, origin: string, input: EditorPublishPageInput) {
  if (input.expectedVersion !== row.current_version) return json({ error: "version_conflict" }, 409);
  if (input.action === "publish") {
    if (row.bindings_json) {
      const site = await cmsSite(store, actor, row), releaseId = site?.state.current?.id;
      if (!site || !releaseId) return json({ error: "cms_release_required" }, 409);
      const released = await store.historicalSnapshot(site, releaseId);
      if (!released || released.locale !== row.locale) return json({ error: "cms_release_required" }, 409);
      let routes;
      try { routes = await store.routeTable(site, "cms.read"); }
      catch { return json({ error: "cms_route_table_unavailable" }, 409); }
      let document: PageDocument, bindings: CmsPageBindingsDocument;
      try {
        const siteStyles = await readManagedPublishedSiteStyles(store, row.site_id);
        document = await readPageSource(store, row, siteStyles);
        bindings = pageBindings(JSON.parse(row.bindings_json), document, row.path)!;
      } catch { return json({ error: "invalid_cms_bindings" }, 422); }
      if (!bindings) return json({ error: "invalid_cms_bindings" }, 422);
      const problems = cmsPageBindingProblems(document, bindings, released.schema);
      if (problems.length) return json({ error: "invalid_cms_bindings", problems }, 422);
      try {
        if (bindings.detail) {
          const { collectionId, slugFieldId } = bindings.detail, slugs = new Set<string>();
          for (const item of released.items.filter((entry) => entry.collectionId === collectionId)) {
            const slug = item.values[slugFieldId];
            if (typeof slug !== "string" || !CMS_DETAIL_SLUG.test(slug)
              || validatePagePath(`${row.path}/${slug.toLowerCase()}`) !== null || slugs.has(slug)) throw new Error("invalid detail URL");
            const detailPath = `${row.path}/${slug}`;
            if (routes.reservations.some((reservation) => reservation.kind === "template"
              ? matchesTemplatePath(reservation.path, detailPath) : reservation.path === detailPath)) throw new Error("reserved detail URL");
            slugs.add(slug);
          }
        }
      } catch { return json({ error: "invalid_cms_binding_values" }, 422); }
    }
    const result = await publishManagedPages(store, actor, row.project_id, row.site_id, origin,
      { expectedVersion: input.expectedVersion, scope: "changed" },
      { target: { siteId: row.site_id, pageId: row.page_id, locale: row.locale }, expectedVersion: input.expectedVersion });
    if (result.status === "conflict") return json({ error: "version_conflict" }, 409);
    if (result.status === "failed") return json({ error: "publication_artifact_generation_failed", failedUrl: result.failedUrl, message: result.message }, 503);
    const page = result.pageSnapshot as { document: PageDocument; version: string; releases: readonly { revision: number; label: string }[]; cmsBindings?: CmsPageBindingsDocument | null } | undefined;
    if (!page) return json({ error: "publication_snapshot_unavailable" }, 503);
    return { status: "released" as const, url: result.pageUrl ?? managedPageUrl(origin, row.slug, row.path, row.public_domain), warnings: result.warnings, urls: result.urls, elapsedMs: result.elapsedMs,
      snapshot: { document: page.document, version: page.version, hasSavedDraft: true, releases: page.releases, ...(page.cmsBindings === undefined ? {} : { cmsBindings: page.cmsBindings }) } };
  }
  const { db } = store;
  const startedAt = Date.now();
  const sourceRevision = input.revision!;
  const published = await db.prepare(`SELECT cms_release_id, cms_schema_revision FROM managed_page_publications
      WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND source_revision = ?4 ORDER BY rowid DESC LIMIT 1`)
    .bind(row.site_id, row.page_id, row.locale, sourceRevision).first<{ cms_release_id: string | null; cms_schema_revision: string | null }>();
  if (!published) return json({ error: "revision_not_published" }, 409);
  const { cms_release_id: cmsReleaseId, cms_schema_revision: cmsSchemaRevision } = published;
  let cmsGeneration: string | null = null;
  if (cmsReleaseId) {
    const site = await cmsSite(store, actor, row);
    if (!site) return json({ error: "cms_release_required" }, 409);
    try { await store.routeTable(site, "cms.read"); }
    catch { return json({ error: "cms_route_table_unavailable" }, 409); }
    cmsGeneration = site.generation;
  }
  const publicationId = crypto.randomUUID(), auditId = crypto.randomUUID(), version = opaqueVersion();
  const revision = row.current_revision + 1;
  const source = sourceRevision === row.current_revision ? row
    : await db.prepare(`SELECT site_id, page_id, locale, revision, document_json, document_key, document_digest, bindings_json
        FROM managed_page_versions WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4`)
      .bind(row.site_id, row.page_id, row.locale, sourceRevision).first<PageSourceRow & { bindings_json: string | null }>();
  if (!source) return json({ error: "version_conflict" }, 409);
  const fallbackUrl = managedPageUrl(origin, row.slug, row.path, row.public_domain);
  let preparedPublication: Awaited<ReturnType<typeof prepareManagedPublishedPageMutation>>;
  let document: PageDocument, bindings: CmsPageBindingsDocument | null;
  try {
    const edition = await managedPublicationSnapshot(store, actor, row.project_id, row.site_id);
    if (!edition || edition.catalogVersion !== row.page_catalog_version) return json({ error: "version_conflict" }, 409);
    const siteStyles = edition.styles.published.styles;
    document = parsePageDocument({ ...(await readPageSource(store, source, siteStyles)), revision }, managedBlockContracts, { siteStyles });
    bindings = source.bindings_json === null ? null : parseCmsPageBindings(JSON.parse(source.bindings_json), document);
    const cmsSnapshot = bindings && cmsReleaseId ? await store.snapshot(row.site_id, cmsReleaseId) : null;
    if (bindings && (!cmsSnapshot || cmsSnapshot.locale !== row.locale)) return json({ error: "cms_release_required" }, 409);
    preparedPublication = await prepareManagedPublishedPageMutation(store, edition, row.site_id, origin, publicationId,
      { siteId: row.site_id, pageId: row.page_id, locale: row.locale, path: row.path, sourceRevision: revision,
        public: row.visibility === "public", ...(bindings ? { bindings } : {}), ...(cmsSnapshot ? { cmsSnapshot } : {}),
        readDocument: async () => document });
    if (!preparedPublication) return json({ error: "version_conflict" }, 409);
  } catch (error) {
    return json({ error: "publication_artifact_generation_failed", failedUrl: error instanceof ManagedPagePublicationError ? error.url : fallbackUrl }, 503);
  }
  const preparedArtifact = [...preparedPublication.artifacts.values()].find(({ pageId, locale }) => pageId === row.page_id && locale === row.locale);
  const restoredSource = await storePageSource(store.bucket, document, version);
  if (!restoredSource) return json({ error: "page_storage_unavailable" }, 503);
  // The guarded audit insert admits the whole transaction. All later writes depend on its unique ID.
  const results = await db.batch([
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
       SELECT ?1, s.project_id, mp.site_id, ?2, ?3, mp.page_id FROM managed_pages AS mp
       JOIN managed_sites AS ms ON ms.site_id = mp.site_id
       JOIN sites AS s ON s.id = mp.site_id
       WHERE mp.site_id = ?4 AND mp.page_id = ?5 AND mp.locale = ?6 AND mp.current_version = ?7 AND s.project_id = ?8
         AND ms.page_catalog_version = ?9
         AND ${pagePublishAccess("mp.site_id", "s.project_id", "?2", "?16")}
         AND (?10 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = mp.site_id AND generation = ?10))
         AND (?11 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_releases WHERE site_id = mp.site_id AND release_id = ?11))
         AND ms.public_policy_version = ?13 AND ms.public_domain_version = ?14
         AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = mp.site_id AND version = ?12)
         AND EXISTS (SELECT 1 FROM managed_page_versions WHERE site_id = mp.site_id AND page_id = mp.page_id AND locale = mp.locale AND revision = ?15)`)
      .bind(auditId, actor.subject, "page.restored", row.site_id, row.page_id, row.locale, input.expectedVersion, row.project_id,
        row.page_catalog_version, cmsGeneration, cmsReleaseId, preparedPublication.expectedVersion,
        preparedPublication.expectedPolicyVersion, preparedPublication.expectedDomainVersion, sourceRevision, actor.cliClientId ?? null),
    db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json,
            kind, created_by_subject, bindings_json, document_key, document_digest, link_index_json)
          SELECT ?1, ?2, ?3, ?4, '{}', ?5, ?6, ?7, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?11)`)
      .bind(row.site_id, row.page_id, row.locale, revision, "restore", actor.subject,
        source.bindings_json, restoredSource.key, restoredSource.digest, restoredSource.linkIndex, auditId),
    db.prepare(`INSERT INTO managed_page_publications (id, site_id, page_id, locale, source_revision, action, published_by_subject,
        cms_release_id, cms_schema_revision, published_path, path, artifact_key, artifact_digest, manifest_key, content_type, content_security_policy)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14, ?15
        WHERE EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?16)`)
      .bind(publicationId, row.site_id, row.page_id, row.locale, revision, "rollback", actor.subject, cmsReleaseId, cmsSchemaRevision,
        row.path, preparedArtifact?.artifactKey ?? null, preparedArtifact?.artifactDigest ?? null, preparedPublication.manifestKey,
        preparedArtifact ? "text/html; charset=utf-8" : null, preparedArtifact?.contentSecurityPolicy ?? null, auditId),
    db.prepare(`UPDATE managed_pages
       SET published_revision = ?1, published_publication_id = ?2, current_revision = ?1, current_version = ?3, updated_at = unixepoch()
       WHERE site_id = ?4 AND page_id = ?5 AND locale = ?6 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?7)`)
      .bind(revision, publicationId, version, row.site_id, row.page_id, row.locale, auditId),
    db.prepare(`UPDATE managed_sites SET page_catalog_version = ?1 WHERE site_id = ?2
      AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?3)`).bind(`catalog.${version}`, row.site_id, auditId),
    db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
      WHERE site_id = ?3 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?4)`)
      .bind(preparedPublication.manifestVersion, preparedPublication.manifestKey, row.site_id, auditId),
    discardSupersededDraft(db, row, version)
  ]);
  if (results.some((result) => !result.success)) throw new Error("managed page mutation batch failed");
  if (!changed(results[0])) return json({ error: "version_conflict" }, 409);
  const warnings = boundedManagedSeoWarnings([...preparedPublication.warnings, ...publishedMetadataWarnings(preparedPublication.routes, preparedPublication.changedPaths)]);
  return { status: "released" as const, snapshot: { document, version, hasSavedDraft: true, releases: await releases(db, row),
    ...(row.locale === row.cms_locale ? { cmsBindings: bindings } : {}) }, url: preparedPublication.url,
    urls: preparedPublication.urls, elapsedMs: Date.now() - startedAt, warnings };
}

type ManagedPageChange = Exclude<EditorPageChange, { action: "duplicate" }>;

async function changePageOnce(store: CmsStore, actor: ManagedActor, projectId: string, siteId: string,
  publicOrigin: string | null, expectedVersion: string, change: ManagedPageChange) {
  const { db } = store;
  const catalog = await pageCatalog(db, siteId);
  const previous = change.action === "create" ? undefined : catalog.pages.find((page) =>
    page.siteId === change.target.siteId && page.pageId === change.target.pageId && page.locale === change.target.locale);
  if ((change.action === "create" ? catalog.version : previous?.version) !== expectedVersion)
    return json({ error: "version_conflict" }, 409);
  const [problem] = pageChangeProblems(change, catalog.pages, { id: siteId, name: "Managed site", domains: [] });
  if (problem) return json({ error: "invalid_page_change", field: problem.field, message: problem.message }, 400);
  if ((change.action === "create" || change.action === "update" && change.path !== previous?.path) && cmsPathReserved(change.path))
    return json({ error: "invalid_page_change", field: "path", message: "/cms は CMS の公開 URL に使います。" }, 400);
  if (change.action === "update" && previous?.path === "/" && change.path !== "/")
    return json({ error: "invalid_page_change", field: "path", message: "ホームのURLは変更できません。" }, 400);

  const auditId = crypto.randomUUID(), version = opaqueVersion();
  let resultPage: EditorPage;
  let statements: D1Statement[];
  if (change.action === "create") {
    const pageId = opaqueId("page"), { locale, title, path } = change;
    const source = await storePageSource(store.bucket, initialDocument(siteId, pageId, locale, title), version);
    if (!source) return json({ error: "invalid_document" }, 400);
    statements = [
      db.prepare(`INSERT INTO managed_pages (site_id, page_id, locale, title, path, visibility, current_version, current_revision)
          SELECT ?1, ?2, ?3, ?4, ?5, 'public', ?6, 1
          FROM managed_sites AS ms JOIN sites AS s ON s.id = ms.site_id
          WHERE ms.site_id = ?1 AND s.project_id = ?7 AND ms.page_catalog_version = ?8
            AND ${pagePublishAccess("?1", "?7", "?9", "?10")}
            AND NOT EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND path = ?5)`)
        .bind(siteId, pageId, locale, title, path, version, projectId, expectedVersion, actor.subject, actor.cliClientId ?? null),
      db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject,
           document_key, document_digest, link_index_json)
          SELECT site_id, page_id, locale, 1, '{}', 'initial', ?1, ?2, ?3, ?4 FROM managed_pages WHERE site_id = ?5 AND page_id = ?6 AND locale = ?7`)
        .bind(actor.subject, source.key, source.digest, source.linkIndex, siteId, pageId, locale),
      db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
          SELECT ?1, ?2, ?3, ?4, 'page.created', ?5 WHERE EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?3 AND page_id = ?5 AND locale = ?6)`)
        .bind(auditId, projectId, siteId, actor.subject, pageId, locale)
    ];
    resultPage = { siteId, pageId, locale, title, path, kind: "page", visibility: "public", published: false };
  } else {
    const { pageId, locale } = change.target;
    const current = previous!;
    const { title, path, visibility } = change.action === "update" ? { ...current, title: change.title, path: change.path } : { ...current, visibility: change.visibility };
    const movedFrom = path === current.path ? null : current.path;
    const auditAction = change.action === "update" ? "page.updated" : "page.visibility";
    const currentIsPublic = current.visibility === "public";
    const nextIsPublic = visibility === "public";
    const changesPublishedRouteMetadata = current.published && (movedFrom !== null || currentIsPublic !== nextIsPublic);
    const changesPublishedRoute = current.published && (currentIsPublic !== nextIsPublic
      || currentIsPublic && nextIsPublic && movedFrom !== null);
    let prepared: Awaited<ReturnType<typeof prepareManagedPublishedPageMutation>> = null;
    let redirectVersion: string | null = null;
    let redirects: ManagedSiteRedirect[] | null = null;
    let redirectsChanged = false;

    if (changesPublishedRouteMetadata) {
      const redirectState = await db.prepare("SELECT redirect_version FROM managed_sites WHERE site_id = ?1 LIMIT 1")
        .bind(siteId).first<{ redirect_version: string }>();
      const redirectRows = await db.prepare(`SELECT locale, from_path AS fromPath, to_path AS toPath
        FROM managed_site_redirects WHERE site_id = ?1 ORDER BY from_path`).bind(siteId).all<ManagedSiteRedirect>();
      if (!redirectState || !redirectRows.success) return json({ error: "publication_storage_unavailable" }, 503);
      redirectVersion = redirectState.redirect_version;
      const originalRedirects = [...(redirectRows.results ?? [])];
      redirects = originalRedirects.filter(({ fromPath }) => fromPath !== path);
      if (currentIsPublic && nextIsPublic && movedFrom !== null) {
        redirects = redirects.map((redirect) => redirect.toPath === current.path ? { ...redirect, toPath: path } : redirect)
          .filter(({ fromPath }) => fromPath !== current.path);
        redirects.push({ locale, fromPath: current.path, toPath: path });
      } else if (!nextIsPublic) {
        redirects = redirects.filter(({ fromPath }) => fromPath !== current.path);
      }
      redirects.sort((first, second) => first.fromPath.localeCompare(second.fromPath));
      const parsedRedirects = parseManagedSiteRedirects(redirects);
      if (!parsedRedirects) return json({ error: "invalid_redirects" }, 422);
      redirects = parsedRedirects;
      redirectsChanged = JSON.stringify(originalRedirects.sort((a, b) => a.fromPath.localeCompare(b.fromPath)))
        !== JSON.stringify(redirects);

      if (changesPublishedRoute) {
        if (!publicOrigin) return json({ error: "managed_public_origin_unavailable" }, 503);
        try {
          const edition = await managedPublicationSnapshot(store, actor, projectId, siteId);
          if (!edition || edition.catalogVersion !== catalog.version) return json({ error: "version_conflict" }, 409);
          prepared = await prepareManagedPublishedPageMutation(store, edition, siteId, publicOrigin, crypto.randomUUID(),
            { pageId, locale, path, public: nextIsPublic }, redirects);
          if (!prepared) return json({ error: "version_conflict" }, 409);
        } catch (error) {
          return json({ error: "publication_artifact_generation_failed", ...(error instanceof ManagedPagePublicationError ? { failedUrl: error.url } : {}) }, 503);
        }
      }
    }

    const currentCatalogVersion = catalog.version;
    statements = [
      db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6 FROM managed_pages AS page
          JOIN managed_sites AS ms ON ms.site_id = page.site_id
          JOIN sites AS s ON s.id = page.site_id
          WHERE page.site_id = ?3 AND page.page_id = ?6 AND page.locale = ?7 AND page.current_version = ?8
            AND ms.page_catalog_version = ?9 AND s.project_id = ?2
            AND ${pagePublishAccess("page.site_id", "s.project_id", "?4", "?10")}
            AND (?11 IS NULL OR EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = ?3 AND version = ?11))
            AND (?12 IS NULL OR ms.redirect_version = ?12)
            AND (?13 IS NULL OR ms.public_policy_version = ?13)
            AND (?14 IS NULL OR ms.public_domain_version = ?14)`)
        .bind(auditId, projectId, siteId, actor.subject, auditAction, pageId, locale, expectedVersion, currentCatalogVersion,
          actor.cliClientId ?? null, prepared?.expectedVersion ?? null, redirectVersion, prepared?.expectedPolicyVersion ?? null, prepared?.expectedDomainVersion ?? null),
      db.prepare(`UPDATE managed_pages SET title = ?1, path = ?2, visibility = ?3, current_version = ?4, updated_at = unixepoch()
          WHERE site_id = ?5 AND page_id = ?6 AND locale = ?7 AND current_version = ?8
            AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?9)
            AND NOT EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?5 AND path = ?2 AND (page_id <> ?6 OR locale <> ?7))`)
        .bind(title, path, visibility, version, siteId, pageId, locale, expectedVersion, auditId),
      ...(redirectsChanged && redirects && redirectVersion ? [
        db.prepare(`DELETE FROM managed_site_redirects WHERE site_id = ?1 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?2)
          AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?1 AND redirect_version = ?3)`)
          .bind(siteId, auditId, redirectVersion),
        db.prepare(`INSERT INTO managed_site_redirects (site_id, locale, from_path, to_path)
          SELECT ?1, json_extract(value, '$.locale'), json_extract(value, '$.fromPath'), json_extract(value, '$.toPath')
          FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?3)
            AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?1 AND redirect_version = ?4)`)
          .bind(siteId, JSON.stringify(redirects), auditId, redirectVersion),
        db.prepare(`UPDATE managed_sites SET redirect_version = ?1 WHERE site_id = ?2 AND redirect_version = ?3
          AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?4)`)
          .bind(version, siteId, redirectVersion, auditId)
      ] : []),
      db.prepare(`UPDATE managed_sites SET page_catalog_version = ?1 WHERE site_id = ?2 AND page_catalog_version = ?3
        AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?4)`)
        .bind(`catalog.${version}`, siteId, currentCatalogVersion, auditId),
      ...(prepared ? [db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
        WHERE site_id = ?3 AND version = ?4 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?5)
          AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?3 AND page_id = ?6 AND locale = ?7 AND current_version = ?8)
          AND EXISTS (SELECT 1 FROM managed_sites WHERE site_id = ?3 AND page_catalog_version = ?9)`)
        .bind(prepared.manifestVersion, prepared.manifestKey, siteId, prepared.expectedVersion, auditId, pageId, locale, version, `catalog.${version}`)] : [])
    ];
    const { version: _version, ...page } = current;
    resultPage = { ...page, title, path, visibility };
  }
  const results = await db.batch(change.action === "create" ? [...statements, db.prepare(`UPDATE managed_sites SET page_catalog_version = ?1 WHERE site_id = ?2
      AND page_catalog_version = ?3 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?4)`)
      .bind(`catalog.${version}`, siteId, catalog.version, auditId)] : statements);
  if (results.some((result) => !result.success)) throw new Error("managed page mutation batch failed");
  if (!changed(results[0])) return json({ error: "version_conflict" }, 409);
  if (change.action !== "create" && !changed(results[1])) return json({ error: "version_conflict" }, 409);
  return { status: "applied" as const, page: resultPage };
}

async function managedSitePublicationHistory(db: ManagedD1, siteId: string): Promise<Response> {
  const result = await db.prepare(`SELECT state.version AS current_release_id, history.release_id,
      history.created_at, history.release_id = state.version AS current
    FROM managed_site_publication_state AS state
    LEFT JOIN managed_site_publication_history AS history ON history.site_id = state.site_id
    WHERE state.site_id = ?1
    ORDER BY history.created_at DESC, history.release_id DESC LIMIT 50`).bind(siteId)
    .all<{ readonly current_release_id: string; readonly release_id: string | null; readonly created_at: number | null; readonly current: number | null }>();
  if (!result.success) return json({ error: "publication_history_unavailable" }, 503);
  const rows = result.results ?? [];
  return json({
    currentReleaseId: rows[0]?.current_release_id && rows[0].current_release_id !== "initial" ? rows[0].current_release_id : null,
    releases: rows.flatMap(({ release_id, created_at, current }) => release_id && created_at !== null
      ? [{ releaseId: release_id, createdAt: created_at, current: current === 1 }] : [])
  });
}

async function rollbackManagedSitePublication(request: Request, db: ManagedD1, actor: ManagedActor,
  projectId: string, siteId: string): Promise<Response> {
  const body = await readJson(request, actor, 8 * 1024);
  if (!body || !exactKeys(body, ["expectedVersion", "releaseId"])
    || typeof body.expectedVersion !== "string" || body.expectedVersion.length > 200
    || typeof body.releaseId !== "string" || !MANIFEST_VERSION.test(body.releaseId)
    || body.releaseId === body.expectedVersion) return json({ error: "invalid_request" }, 400);
  const result = await db.batch([db.prepare(`UPDATE managed_site_publication_state
    SET version = ?1, manifest_key = (SELECT history.manifest_key FROM managed_site_publication_history AS history
      WHERE history.site_id = ?2 AND history.release_id = ?1), updated_at = unixepoch()
    WHERE site_id = ?2 AND version = ?3
      AND EXISTS (SELECT 1 FROM managed_site_publication_history AS history
        WHERE history.site_id = ?2 AND history.release_id = ?1)
      AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?2 AND s.project_id = ?4 AND member.access_subject = ?5 AND member.role IN ('owner', 'editor'))`)
    .bind(body.releaseId, siteId, body.expectedVersion, projectId, actor.subject)]);
  if (!changed(result[0])) return json({ status: "conflict" }, 409);
  return json({ status: "rolled_back", releaseId: body.releaseId });
}

/** GUI と CLI が共有する managed page operation dispatcher。 */
export async function managedEditorOperation(
  request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, action: string, origin: string, store?: CmsStore
): Promise<Response> {
  const registration = await managedMemberRegistration(db, actor, projectId, siteId);
  if (!registration) return json({ error: "forbidden" }, 403);
  if (action === "/editor/public-settings") return managedPublicSettings(request, db, actor, projectId, siteId, origin);
  if (action === "/editor/seo-settings") return managedPublicSeoSettings(request, db, actor, projectId, siteId, origin);
  if (action === "/editor/redirects") return managedSiteRedirects(request, db, actor, projectId, siteId, origin, store);
  if (action === "/editor/public-domain") return managedPublicDomain(request, db, actor, projectId, siteId, origin);
  if (action === "/editor/publication-history") return request.method === "GET"
    ? managedSitePublicationHistory(db, siteId) : json({ error: "method_not_allowed" }, 405);
  if (action === "/editor/rollback") return request.method === "POST"
    ? rollbackManagedSitePublication(request, db, actor, projectId, siteId) : json({ error: "method_not_allowed" }, 405);
  if (action === "/editor/catalog") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const catalog = await pageCatalog(db, siteId);
    const domains = registration.public_domain ? [`https://${registration.public_domain}`, origin] : [origin];
    return json({ sites: [{ id: siteId, name: registration.site_name, domains }], ...catalog, pageChangeActions: ["create", "update", "visibility"], pagePathEditable: true });
  }
  if (action === "/editor/page-changes") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!store) return json({ error: "page_storage_unavailable" }, 503);
    const body = await readJson(request, actor, MAX_MUTATION_BODY), change = normalizePageChange(body?.change);
    if (!body || !exactKeys(body, ["expectedVersion", "change"]) || !isEditingApiVersion(body.expectedVersion) || !change || change.action === "duplicate")
      return json({ error: "invalid_request" }, 400);
    const result = await changePageOnce(store, actor, projectId, siteId, origin, body.expectedVersion, change);
    return result instanceof Response ? result : json(result);
  }
  const match = /^\/editor\/([A-Za-z][A-Za-z0-9_-]{0,79})(\/draft|\/publish|\/history|\/history-read|\/embed-connection|\/cms-bindings|\/cms-preview-plan|\/cms-preview)?$/u.exec(action);
  if (!match) return json({ error: "not_found" }, 404);
  const pageId = match[1]!;
  if (match[2] === "/embed-connection") return request.method === "POST" ? registerManagedEmbed(request, db, actor, projectId, siteId, pageId, origin) : json({ error: "method_not_allowed" }, 405);
  const row = await pageRow(db, projectId, siteId, pageId);
  if (!row) return json({ error: "forbidden" }, 403);
  if (!match[2]) return request.method === "GET" ? json(await snapshot(db, row, store)) : json({ error: "method_not_allowed" }, 405);
  if (match[2] === "/draft") return request.method === "PUT" ? saveDraft(request, actor, row, store) : json({ error: "method_not_allowed" }, 405);
  if (match[2] === "/publish") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!store) return json({ error: "page_storage_unavailable" }, 503);
    const body = await readJson(request, actor, MAX_MUTATION_BODY);
    if (!body || body.action !== "publish" && body.action !== "restore" || !isEditingApiVersion(body.expectedVersion)
      || !exactKeys(body, body.action === "restore" ? ["action", "revision", "expectedVersion"] : ["action", "expectedVersion"])
      || body.action === "restore" && (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1))
      return json({ error: "invalid_request" }, 400);
    const result = await publishPageOnce(store, actor, row, origin, { expectedVersion: body.expectedVersion, action: body.action,
      ...(body.action === "restore" ? { revision: Number(body.revision) } : {}) });
    return result instanceof Response ? result : json(result);
  }
  if (match[2] === "/history") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const url = new URL(request.url), cursorValues = url.searchParams.getAll("cursor");
    if ([...url.searchParams.keys()].some((key) => key !== "cursor") || cursorValues.length > 1) return json({ error: "invalid_request" }, 400);
    const history = await pageRevisionHistory(db, row, cursorValues[0]);
    return history ? json(history) : json({ error: "invalid_request" }, 400);
  }
  if (match[2] === "/history-read") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await readJson(request, actor, 8 * 1024);
    if (!body || !exactKeys(body, ["id"]) || typeof body.id !== "string") return json({ error: "invalid_request" }, 400);
    const history = await pageRevision(db, row, body.id, store);
    return history ? json(history) : json({ error: "not_found" }, 404);
  }
  const site = await cmsSite(store, actor, row);
  if (!store || !site) return json({ error: "not_found" }, 404);
  if (match[2] === "/cms-bindings") return request.method === "GET" ? cmsBindingOptions(store, site) : json({ error: "method_not_allowed" }, 405);
  return request.method === "POST" ? cmsBindingPreview(request, store, site, actor, row, match[2] === "/cms-preview") : json({ error: "method_not_allowed" }, 405);
}

export async function managedDashboardOverview(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Record<string, unknown> | null> {
  const registration = await db.prepare(`
    SELECT ms.slug, ${PRIMARY_DOMAIN} AS public_domain,
           (SELECT publication.published_path FROM managed_pages AS mp JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
             WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
             ORDER BY CASE WHEN publication.published_path = '/' THEN 0 ELSE 1 END, publication.published_path LIMIT 1) AS published_path,
           (SELECT count(*) FROM managed_pages AS mp WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL) AS published_page_count,
           (SELECT max(pub.created_at) FROM managed_page_publications AS pub WHERE pub.site_id = s.id) AS last_published_at
      FROM project_members AS member JOIN sites AS s ON s.project_id = member.project_id JOIN managed_sites AS ms ON ms.site_id = s.id
     WHERE member.access_subject = ?1 AND member.project_id = ?2 AND s.id = ?3 LIMIT 1
  `).bind(actor.subject, projectId, siteId).first<{ readonly slug: string; readonly public_domain: string | null; readonly published_path: string | null; readonly published_page_count: number; readonly last_published_at: number | null }>();
  if (!registration) return null;
  const audit = await db.prepare(`SELECT id, action, page_id, created_at FROM managed_site_audit WHERE site_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20`)
    .bind(siteId).all<{ readonly id: string; readonly action: string; readonly page_id: string | null; readonly created_at: number }>();
  if (!audit.success) throw new Error("managed audit query failed");
  const labels: Record<string, string> = { "site.created": "サイトを作成", "page.created": "ページを作成", "page.saved": "下書きを保存", "page.published": "ページを公開", "page.restored": "公開版を復元", "page.updated": "ページ情報を更新", "page.visibility": "公開範囲を更新" };
  return {
    publicationStatus: registration.published_page_count > 0 ? "published" : "unpublished",
    publishedUrl: registration.published_path ? managedPageUrl(origin, registration.slug, registration.published_path, registration.public_domain) : null,
    lastPublishedAt: registration.last_published_at === null ? null : new Date(registration.last_published_at * 1000).toISOString(),
    publishedPageCount: registration.published_page_count,
    assetBytes: null,
    recentChanges: (audit.results ?? []).map((entry) => ({ id: `change_${entry.id.replaceAll("-", "")}`, label: `${labels[entry.action] ?? "サイトを更新"}${entry.page_id ? `: ${entry.page_id}` : ""}`, changedAt: new Date(entry.created_at * 1000).toISOString() }))
  };
}
