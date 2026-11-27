import { CmsStore, cmsPathReserved, digest, nowSeconds, type Site } from "./managed-cms-store.js";
import { localizedPathIdentity, pageText, prepareManagedPageArtifact, renderManagedPage } from "./managed-page-publication.js";
import { MAX_MANAGED_PAGE_BYTES, readPageSource, readPageSourceObject, storePageSource, type PageSourceRow } from "./managed-page-source.js";
import { parsePageDocument, type PageDocument, type PageNode } from "../src/core.js";
import { cmsPageBindingProblems, parseCmsPageBindings, resolveCmsPageBindings, type CmsPageBindingsDocument } from "../src/cms-page-bindings.js";
import { cmsId, cmsItemKey } from "../src/cms-v2-schema.js";
import type { CmsPublicAsset } from "../src/cms-v2.js";
import { isEditingApiVersion } from "../src/editing-client.js";
import { createPageEditingApi, type EditingActor, type EditingCapability, type EditingPageTarget } from "../src/editing-api.js";
import type { EditingPageApplied } from "../src/editing-page-operations.js";
import { normalizePageChange, pageChangeProblems } from "../src/editor-model.js";
import type { EditorPage, EditorPageChange, EditorPublishPageInput } from "../src/editor-types.js";
import { matchesTemplatePath, validatePagePath } from "../src/pages.js";
import { emptyManagedPublicPolicy, MANAGED_EMBED_REF, managedBlockContracts, parseManagedPublicPolicy, registeredNihoEmbed } from "./managed-embed-contract.js";
import type { ManagedPublicPolicy } from "./managed-embed-contract.js";
import { parseManagedSiteSeoSettings, type ManagedSiteSeoSettings } from "../src/managed-seo-settings.js";
import { parseManagedSiteRedirects, type ManagedSiteRedirect } from "../src/managed-site-redirects.js";
import { resolvePublishedEmbeds } from "./managed-public-policy.js";
import { revalidatePublicResponse, withPublicEtag } from "./managed-public-http.js";

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

function managedSeoWarnings(document: PageDocument): ManagedSeoWarning[] {
  const warnings: ManagedSeoWarning[] = [];
  if (!document.meta?.description?.trim()) warnings.push({ code: "missing-description", message: "検索結果に出す説明文がありません。" });
  const visit = (nodes: readonly PageNode[]) => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (node.tag === "img" && !(typeof node.attrs?.alt === "string" && node.attrs.alt.trim())) {
        warnings.push({ code: "missing-alt", message: `画像「${node.id}」に代替テキストがありません。` });
      }
      visit(node.children);
    }
  };
  visit(document.body);
  if (document.locale.toLowerCase().startsWith("en") && /[ぁ-ゖァ-ヺ一-龯]/u.test(pageText(document.body))) {
    warnings.push({ code: "japanese-in-english", message: "英語ページの本文に日本語が残っています。" });
  }
  return warnings.slice(0, 100);
}

function seoComparisonKey(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  return normalized || null;
}

function collectInternalLinks(nodes: readonly PageNode[], output: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tag === "a" && typeof node.attrs?.href === "string") output.push(node.attrs.href);
    collectInternalLinks(node.children, output);
  }
  return output;
}

function normalizedRoutePath(path: string, prefix: string): string {
  let local = path;
  if (prefix && (local === prefix || local === `${prefix}/`)) local = "/";
  else if (prefix && local.startsWith(`${prefix}/`)) local = local.slice(prefix.length);
  return local.length > 1 ? local.replace(/\/+$/u, "") : local;
}

async function managedReleaseSeoWarnings(db: ManagedD1, row: ManagedPageRow, document: PageDocument, origin: string,
  store?: CmsStore, actor?: ManagedActor): Promise<ManagedSeoWarning[]> {
  let siteDescription: string | undefined;
  try {
    const settings = await db.prepare("SELECT public_policy_json FROM managed_sites WHERE site_id = ?1 LIMIT 1")
      .bind(row.site_id).first<{ public_policy_json: string }>();
    const policy = settings && record(JSON.parse(settings.public_policy_json) as unknown), seo = record(policy?.seo);
    if (typeof seo?.description === "string" && seo.description.trim()) siteDescription = seo.description;
  } catch { /* settings are optional for non-blocking warnings */ }
  const warnings = managedSeoWarnings(document).filter(({ code }) => code !== "missing-description" || !siteDescription);
  const peers = await db.prepare(`SELECT mp.site_id, mp.page_id, mp.locale, version.revision, version.document_json, version.document_key, version.document_digest,
      COALESCE(publication.published_path, mp.path) AS path
    FROM managed_pages AS mp
    JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
    JOIN managed_page_versions AS version ON version.site_id = mp.site_id AND version.page_id = mp.page_id
      AND version.locale = mp.locale AND version.revision = mp.published_revision
    WHERE mp.site_id = ?1 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
    ORDER BY publication.published_path, mp.locale LIMIT 500`).bind(row.site_id).all<{
      site_id: string; page_id: string; locale: string; revision: number; document_json: string; document_key: string | null; document_digest: string | null; path: string;
    }>();
  const peerDocuments: { pageId: string; locale: string; path: string; document: PageDocument }[] = [];
  if (peers.success) for (const peer of peers.results ?? []) try {
    const other = await readPageSource(store, peer);
    if (other.siteId === row.site_id && other.pageId === peer.page_id && other.locale === peer.locale) {
      peerDocuments.push({ pageId: peer.page_id, locale: peer.locale, path: peer.path, document: other });
    }
  } catch { /* invalid historical documents are ignored by non-blocking SEO warnings */ }

  if (!document.meta?.noindex) {
    const title = seoComparisonKey(document.title), description = seoComparisonKey(document.meta?.description ?? siteDescription);
    for (const peer of peerDocuments) {
      if (peer.pageId === row.page_id && peer.locale === row.locale || peer.locale !== row.locale || peer.document.meta?.noindex) continue;
      if (title && title === seoComparisonKey(peer.document.title)) warnings.push({ code: "duplicate-title", message: `公開ページ「${peer.path}」と title が重複しています。` });
      if (description && description === seoComparisonKey(peer.document.meta?.description ?? siteDescription)) warnings.push({ code: "duplicate-description", message: `公開ページ「${peer.path}」と description が重複しています。` });
    }
  }

  const prefix = row.public_domain ? "" : `/s/${row.slug}`;
  const publicUrl = managedPageUrl(origin, row.slug, row.path, row.public_domain);
  const knownPaths = new Set([row.path, ...peerDocuments.filter((peer) => peer.locale === row.locale).map((peer) => peer.path)]
    .map((path) => normalizedRoutePath(path, prefix)));
  const templatePaths: string[] = [];
  if (store && actor) try {
    const site = await cmsSite(store, actor, row);
    if (site) {
      const routes = await store.routeTable(site, "cms.read", row.locale);
      for (const route of routes.reservations) {
        if (["fixed-page", "cms-item", "redirect"].includes(route.kind)) knownPaths.add(normalizedRoutePath(route.path, prefix));
        else if (route.kind === "template") templatePaths.push(normalizedRoutePath(route.path, prefix));
      }
    }
  } catch { /* CMS route lookup is optional for non-blocking warnings */ }

  for (const href of collectInternalLinks(document.body)) try {
    if (!href.trim() || href.startsWith("#") || href.startsWith("//")) continue;
    const rootRelative = href.startsWith("/") && prefix ? `${prefix}${href}` : href;
    const target = new URL(rootRelative, publicUrl);
    const base = new URL(publicUrl);
    if (target.origin !== base.origin || !["https:", "http:"].includes(target.protocol)) continue;
    const path = normalizedRoutePath(target.pathname, prefix);
    if (!knownPaths.has(path) && !templatePaths.some((template) => matchesTemplatePath(template, path))) {
      warnings.push({ code: "broken-internal-link", message: `公開中のページ・CMS route が見つかりません: ${path}` });
    }
  } catch { /* malformed links are handled by document validation */ }
  return boundedManagedSeoWarnings(warnings);
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

async function readJson(request: Request, actor: ManagedActor, maximum: number): Promise<Record<string, unknown> | null> {
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
      db.prepare("INSERT INTO managed_site_hosts (hostname, path_prefix, site_id, noindex) VALUES (?1, ?2, ?3, 0)")
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
  return db.prepare(`SELECT ms.slug, ms.public_domain, s.name AS site_name FROM managed_sites AS ms JOIN sites AS s ON s.id = ms.site_id WHERE s.project_id = ?1 AND s.id = ?2 LIMIT 1`)
    .bind(projectId, siteId).first<{ readonly slug: string; readonly public_domain: string | null; readonly site_name: string }>();
}

async function managedMemberRegistration(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string): Promise<{ readonly slug: string; readonly public_domain: string | null; readonly site_name: string } | null> {
  return db.prepare(`
    SELECT ms.slug, ms.public_domain, s.name AS site_name
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

async function managedSiteRedirects(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string): Promise<Response> {
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
  const version = opaqueVersion();
  const expectedVersion = body.expectedVersion;
  const results = await db.batch([
    db.prepare(`DELETE FROM managed_site_redirects WHERE site_id = ?1 AND EXISTS (
      SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.redirect_version = ?2 AND EXISTS (
        SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?1 AND s.project_id = ?3 AND member.access_subject = ?4 AND member.role = 'owner'))`)
      .bind(siteId, expectedVersion, projectId, actor.subject),
    db.prepare(`INSERT INTO managed_site_redirects (site_id, locale, from_path, to_path)
      SELECT ?1, json_extract(value, '$.locale'), json_extract(value, '$.fromPath'), json_extract(value, '$.toPath') FROM json_each(?2)
      WHERE EXISTS (SELECT 1 FROM managed_sites AS ms WHERE ms.site_id = ?1 AND ms.redirect_version = ?3 AND EXISTS (
        SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?1 AND s.project_id = ?4 AND member.access_subject = ?5 AND member.role = 'owner'))`)
      .bind(siteId, JSON.stringify(redirects), expectedVersion, projectId, actor.subject),
    db.prepare(`UPDATE managed_sites SET redirect_version = ?1
      WHERE site_id = ?2 AND redirect_version = ?3 AND EXISTS (SELECT 1 FROM sites AS s
        JOIN project_members AS member ON member.project_id = s.project_id
        WHERE s.id = ?2 AND s.project_id = ?4 AND member.access_subject = ?5 AND member.role = 'owner')`)
      .bind(version, siteId, expectedVersion, projectId, actor.subject)
  ]);
  return changed(results[2]!) ? json({ redirects, version }) : json({ error: "conflict" }, 409);
}

async function managedPublicDomain(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Response> {
  const ownerScope = `EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
    WHERE s.id = ?1 AND s.project_id = ?2 AND member.access_subject = ?3 AND member.role = 'owner')`;
  if (request.method === "GET") {
    const row = await db.prepare(`SELECT public_domain, public_domain_noindex, public_domain_version FROM managed_sites WHERE site_id = ?1 AND ${ownerScope}`)
      .bind(siteId, projectId, actor.subject).first<{ public_domain: string | null; public_domain_noindex: number; public_domain_version: string }>();
    return row ? json({ domain: row.public_domain, noindex: row.public_domain_noindex === 1, version: row.public_domain_version }) : json({ error: "forbidden" }, 403);
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
  let result: D1Result<unknown> | undefined;
  try {
    [result] = await db.batch([db.prepare(`UPDATE managed_sites SET public_domain = ?4, public_domain_version = ?5, public_domain_noindex = ?6
      WHERE site_id = ?1 AND public_domain_version = ?7 AND ${ownerScope}`)
      .bind(siteId, projectId, actor.subject, domain, version, body.noindex ? 1 : 0, body.expectedVersion)]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: managed_sites\.public_domain/u.test(error.message)) return json({ error: "domain_taken" }, 409);
    throw error;
  }
  if (changed(result)) return json({ domain, noindex: body.noindex, version });
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
    SELECT p.id AS project_id, s.id AS site_id, ms.slug, ms.public_domain,
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
    SELECT s.project_id, s.id AS site_id, ms.slug, ms.public_domain, mp.page_id, mp.locale, mp.title, mp.path, mp.visibility,
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

async function pageRevision(db: ManagedD1, row: ManagedPageRow, id: string, store?: CmsStore) {
  const match = /^rev-([1-9]\d{0,8})$/u.exec(id);
  if (!match) return null;
  const version = await db.prepare(`SELECT site_id, page_id, locale, revision, document_json, document_key, document_digest FROM managed_page_versions
    WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4 LIMIT 1`)
    .bind(row.site_id, row.page_id, row.locale, Number(match[1])).first<PageSourceRow>();
  if (!version) return null;
  const document = await readPageSource(store, version);
  return { document };
}

async function snapshot(db: ManagedD1, row: ManagedPageRow, store?: CmsStore): Promise<Record<string, unknown>> {
  const document = await readPageSource(store, row);
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
  try {
    document = parsePageDocument(body.document, managedBlockContracts);
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
  try { projected = resolveCmsPageBindings(document, bindings, { schema: site.state.schema, items: [item] }, { detail: { itemId: item.itemId }, blocks: managedBlockContracts }); }
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
  try { submitted = parsePageDocument(body.document, managedBlockContracts); } catch { return json({ error: "invalid_document" }, 400); }
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
  const load = (target: EditingPageTarget) => actor ? pageRow(db, projectId, siteId, target.pageId, target.locale) : Promise.resolve(null);
  const doc = (row: ManagedPageRow) => readPageSource(store, row);
  const bindings = (row: ManagedPageRow, page: PageDocument) => row.bindings_json ? parseCmsPageBindings(JSON.parse(row.bindings_json), page) : null;
  return createPageEditingApi({
    pageCmsBindings: true,
    validationContext: async () => ({ blocks: managedBlockContracts }),
    authenticate: async () => editingActor,
    async authorize(_editingActor, capability, scope) {
      if (scope.siteId !== siteId || !["pages.read", "pages.edit", "pages.history.read", "pages.publish"].includes(capability)) return false;
      actor = await actorFor(capability);
      return actor !== null && !!await managedMemberRegistration(db, actor, projectId, siteId);
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
      return row ? pageRevision(db, row, id, store) : null;
    },
    async readPageCatalog() {
      const catalog = await pageCatalog(db, siteId);
      return { version: catalog.version, pages: catalog.pages.map(({ version: _version, ...page }) => page) };
    },
    async changePageNow(_editingActor, _siteId, expectedVersion, change) {
      if (!actor) return { status: "invalid" };
      const result = await changePageOnce(store, actor, projectId, siteId, expectedVersion, change);
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
        throw new Error("managed direct publish failed");
      }
      const { document, version, releases, cmsBindings } = result.snapshot;
      return { ...result, snapshot: { document, version, editorState: { releases }, ...(cmsBindings === undefined ? {} : { cmsBindings }) } };
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
        }, documentKey, documentDigest);
        return { ...applied, document };
      };
      const row = await load(target);
      if (!row || !actor) return { status: "not_found" };
      const repeated = await lookup();
      if (repeated) return repeated;
      const document = await doc(row), site = await cmsSite(store, actor, row);
      const proposed = transaction.prepare({ document, version: row.current_version, ...(site ? { cmsBindings: bindings(row, document) } : {}) },
        { blocks: managedBlockContracts, ...(site ? { cmsSchema: site.state.schema, cmsPagePath: row.path } : {}) });
      if (proposed.status !== "ready") return proposed;
      let sidecar: CmsPageBindingsDocument | null;
      try { sidecar = pageBindings(proposed.cmsBindings ?? null, proposed.document, row.path); }
      catch { return { status: "validation_failed", index: Math.max(0, proposed.journal.input.operations.length - 1), reason: "詳細ページの URL を設定してください。" }; }
      if (!store) return { status: "not_found" };
      const result = await persistDraft(store, actor, row, proposed.document, sidecar, sidecar ? site : null, receipt);
      if (result === "too_large") return { status: "validation_failed", index: Math.max(0, proposed.journal.input.operations.length - 1), reason: "ページ本文がサイズ上限を超えています。" };
      return result ?? await lookup() ?? { status: "conflict" };
    } },
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

async function publishPageOnce(store: CmsStore, actor: ManagedActor, row: ManagedPageRow, origin: string, input: EditorPublishPageInput) {
  if (input.expectedVersion !== row.current_version) return json({ error: "version_conflict" }, 409);
  const { db } = store;
  const action = input.action === "restore" ? "rollback" : "publish";
  const sourceRevision = input.action === "restore" ? input.revision! : row.current_revision;
  const draft = action === "publish" ? await readPageSource(store, row) : null;
  const warnings = draft ? await managedReleaseSeoWarnings(db, row, draft, origin, store, actor) : [];
  let cmsReleaseId: string | null = null, cmsSchemaRevision: string | null = null, cmsGeneration: string | null = null;
  if (action === "rollback") {
    const published = await db.prepare(`SELECT cms_release_id, cms_schema_revision FROM managed_page_publications
      WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND source_revision = ?4 ORDER BY rowid DESC LIMIT 1`)
      .bind(row.site_id, row.page_id, row.locale, sourceRevision).first<{ cms_release_id: string | null; cms_schema_revision: string | null }>();
    if (!published) return json({ error: "revision_not_published" }, 409);
    cmsReleaseId = published.cms_release_id;
    cmsSchemaRevision = published.cms_schema_revision;
    if (cmsReleaseId) {
      const site = await cmsSite(store, actor, row);
      if (!site) return json({ error: "cms_release_required" }, 409);
      try { await store.routeTable(site, "cms.read"); }
      catch { return json({ error: "cms_route_table_unavailable" }, 409); }
      cmsGeneration = site.generation;
    }
  } else if (row.bindings_json) {
    const site = await cmsSite(store, actor, row), releaseId = site?.state.current?.id;
    if (!site || !releaseId || !draft) return json({ error: "cms_release_required" }, 409);
    const released = await store.historicalSnapshot(site, releaseId);
    if (!released || released.locale !== row.locale) return json({ error: "cms_release_required" }, 409);
    let currentRoutes;
    try { currentRoutes = await store.routeTable(site, "cms.read"); }
    catch { return json({ error: "cms_route_table_unavailable" }, 409); }
    cmsGeneration = site.generation;
    const page = draft;
    let bindings: CmsPageBindingsDocument;
    try { bindings = pageBindings(JSON.parse(row.bindings_json), page, row.path)!; }
    catch { return json({ error: "invalid_cms_bindings" }, 422); }
    const problems = cmsPageBindingProblems(page, bindings, released.schema);
    if (problems.length) return json({ error: "invalid_cms_bindings", problems }, 422);
    try {
      if (bindings.detail) {
        const { collectionId, slugFieldId } = bindings.detail;
        const slugs = new Set<string>();
        for (const item of released.items.filter((entry) => entry.collectionId === collectionId)) {
          const slug = item.values[slugFieldId];
          if (typeof slug !== "string" || !CMS_DETAIL_SLUG.test(slug) || validatePagePath(row.path + "/" + slug.toLowerCase()) !== null || slugs.has(slug)) throw new Error("invalid detail URL");
          const detailPath = row.path + "/" + slug;
          if (currentRoutes.reservations.some((reservation) => reservation.kind === "template"
            ? matchesTemplatePath(reservation.path, detailPath) : reservation.path === detailPath)) throw new Error("reserved detail URL");
          slugs.add(slug);
          resolveCmsPageBindings(page, bindings, released, { detail: { slug }, blocks: managedBlockContracts });
        }
      } else resolveCmsPageBindings(page, bindings, released, { blocks: managedBlockContracts });
    } catch { return json({ error: "invalid_cms_binding_values" }, 422); }
    cmsReleaseId = released.releaseId;
    cmsSchemaRevision = released.schema.schemaRevision;
  }
  const publicationId = crypto.randomUUID(), auditId = crypto.randomUUID(), version = opaqueVersion();
  const copyVersion = action === "rollback" || row.current_revision === row.published_revision && cmsReleaseId !== null;
  const revision = copyVersion ? row.current_revision + 1 : row.current_revision;
  const auditAction = action === "rollback" ? "page.restored" : "page.published";
  const source = sourceRevision === row.current_revision ? row
    : await db.prepare(`SELECT site_id, page_id, locale, revision, document_json, document_key, document_digest, bindings_json
        FROM managed_page_versions WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4`)
      .bind(row.site_id, row.page_id, row.locale, sourceRevision).first<PageSourceRow & { bindings_json: string | null }>();
  if (!source) return json({ error: "version_conflict" }, 409);
  let document: PageDocument;
  try { document = parsePageDocument({ ...(draft ?? await readPageSource(store, source)), revision }, managedBlockContracts); }
  catch { return json({ error: "invalid_managed_page_storage" }, 503); }
  const cmsBindings = row.locale === row.cms_locale
    ? { cmsBindings: source.bindings_json === null ? null : parseCmsPageBindings(JSON.parse(source.bindings_json), document) } : {};
  const url = managedPageUrl(origin, row.slug, row.path, row.public_domain);
  let prepared: Awaited<ReturnType<typeof prepareManagedPageArtifact>> | null = null;
  if (!cmsReleaseId && !source.bindings_json) {
    try {
      prepared = await prepareManagedPageArtifact({ store, document, publicationId, path: row.path, isPublic: row.visibility === "public",
        publicUrl: new URL(url), publicPrefix: row.public_domain ? "" : `/s/${row.slug}` });
    } catch { return json({ error: "publication_artifact_generation_failed" }, 503); }
  }
  const restoredSource = copyVersion ? await storePageSource(store.bucket, document, version) : null;
  if (copyVersion && !restoredSource) return json({ error: "page_storage_unavailable" }, 503);

  // The guarded audit insert admits the whole transaction. All later writes depend on its unique ID.
  const results = await db.batch([
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
       SELECT ?1, s.project_id, mp.site_id, ?2, ?3, mp.page_id FROM managed_pages AS mp
       JOIN managed_sites AS ms ON ms.site_id = mp.site_id
       JOIN sites AS s ON s.id = mp.site_id
       WHERE mp.site_id = ?4 AND mp.page_id = ?5 AND mp.locale = ?6 AND mp.current_version = ?7 AND s.project_id = ?8
         AND ms.public_domain IS ?9
         AND ms.page_catalog_version = ?10
         AND ${pagePublishAccess("mp.site_id", "s.project_id", "?2", "?17")}
         AND (?11 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = mp.site_id AND generation = ?11))
         AND (?12 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_releases WHERE site_id = mp.site_id AND release_id = ?12))
         AND (?13 IS NULL OR (ms.public_policy_version = ?14 AND ms.public_domain_version = ?15
           AND EXISTS (SELECT 1 FROM managed_site_publication_state WHERE site_id = mp.site_id AND version = ?13)))
         AND EXISTS (SELECT 1 FROM managed_page_versions WHERE site_id = mp.site_id AND page_id = mp.page_id AND locale = mp.locale AND revision = ?16)`)
      .bind(auditId, actor.subject, auditAction, row.site_id, row.page_id, row.locale, input.expectedVersion, row.project_id,
        row.public_domain, row.page_catalog_version, cmsGeneration, cmsReleaseId, prepared?.expectedVersion ?? null,
        prepared?.policyVersion ?? null, prepared?.domainVersion ?? null, sourceRevision, actor.cliClientId ?? null),
    ...(restoredSource ? [db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json,
            kind, created_by_subject, bindings_json, document_key, document_digest, link_index_json)
          SELECT ?1, ?2, ?3, ?4, '{}', ?5, ?6, ?7, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?11)`)
      .bind(row.site_id, row.page_id, row.locale, revision, action === "rollback" ? "restore" : "save", actor.subject,
        source.bindings_json, restoredSource.key, restoredSource.digest, restoredSource.linkIndex, auditId)] : []),
    db.prepare(`INSERT INTO managed_page_publications (id, site_id, page_id, locale, source_revision, action, published_by_subject,
        cms_release_id, cms_schema_revision, published_path, path, artifact_key, artifact_digest, manifest_key, content_type, content_security_policy)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14, ?15
        WHERE EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?16)`)
      .bind(publicationId, row.site_id, row.page_id, row.locale, revision, action, actor.subject, cmsReleaseId, cmsSchemaRevision,
        row.path, prepared?.artifactKey ?? null, prepared?.artifactDigest ?? null, prepared?.manifestKey ?? null,
        prepared ? "text/html; charset=utf-8" : null, prepared?.contentSecurityPolicy ?? null, auditId),
    db.prepare(`UPDATE managed_pages
       SET published_revision = ?1, published_publication_id = ?2, current_revision = ?1, current_version = ?3, updated_at = unixepoch()
       WHERE site_id = ?4 AND page_id = ?5 AND locale = ?6 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?7)`)
      .bind(revision, publicationId, version, row.site_id, row.page_id, row.locale, auditId),
    db.prepare(`UPDATE managed_sites SET page_catalog_version = ?1 WHERE site_id = ?2
      AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?3)`).bind(`catalog.${version}`, row.site_id, auditId),
    ...(prepared ? [db.prepare(`UPDATE managed_site_publication_state SET version = ?1, manifest_key = ?2, updated_at = unixepoch()
      WHERE site_id = ?3 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?4)`)
      .bind(prepared.manifestVersion, prepared.manifestKey, row.site_id, auditId)] : []),
    ...(copyVersion ? [discardSupersededDraft(db, row, version)] : [])
  ]);
  if (results.some((result) => !result.success)) throw new Error("managed page mutation batch failed");
  if (!changed(results[0])) return json({ error: "version_conflict" }, 409);
  return { status: "released" as const, snapshot: { document, version, hasSavedDraft: true, releases: await releases(db, row), ...cmsBindings }, url, warnings };
}

type ManagedPageChange = Exclude<EditorPageChange, { action: "duplicate" }>;

async function changePageOnce(store: CmsStore, actor: ManagedActor, projectId: string, siteId: string,
  expectedVersion: string, change: ManagedPageChange) {
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
    statements = [
      db.prepare(`UPDATE managed_pages SET title = ?1, path = ?2, visibility = ?3, current_version = ?4, updated_at = unixepoch()
          WHERE site_id = ?5 AND page_id = ?6 AND locale = ?7 AND current_version = ?8
            AND EXISTS (SELECT 1 FROM sites WHERE id = ?5 AND project_id = ?9)
            AND ${pagePublishAccess("?5", "?9", "?10", "?11")}
            AND NOT EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?5 AND path = ?2 AND (page_id <> ?6 OR locale <> ?7))`)
        .bind(title, path, visibility, version, siteId, pageId, locale, expectedVersion, projectId, actor.subject, actor.cliClientId ?? null),
      db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (
            SELECT 1 FROM managed_pages WHERE site_id = ?3 AND page_id = ?6 AND locale = ?7 AND current_version = ?8)`)
        .bind(auditId, projectId, siteId, actor.subject, auditAction, pageId, locale, version),
      ...(movedFrom ? [db.prepare(`INSERT OR REPLACE INTO managed_site_redirects (site_id, locale, from_path, to_path)
          SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?5)`)
        .bind(siteId, locale, movedFrom, path, auditId),
      db.prepare(`UPDATE managed_sites SET redirect_version = ?2 WHERE site_id = ?1
          AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?3)`).bind(siteId, version, auditId)] : [])
    ];
    const { version: _version, ...page } = current;
    resultPage = { ...page, title, path, visibility };
  }
  const results = await db.batch([...statements, db.prepare(`UPDATE managed_sites SET page_catalog_version = ?1 WHERE site_id = ?2
      AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?3)`).bind(`catalog.${version}`, siteId, auditId)]);
  if (results.some((result) => !result.success)) throw new Error("managed page mutation batch failed");
  if (!changed(results[0])) return json({ error: "version_conflict" }, 409);
  return { status: "applied" as const, page: resultPage };
}

/** GUI と CLI が共有する managed page operation dispatcher。 */
export async function managedEditorOperation(
  request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, action: string, origin: string, store?: CmsStore
): Promise<Response> {
  const registration = await managedMemberRegistration(db, actor, projectId, siteId);
  if (!registration) return json({ error: "forbidden" }, 403);
  if (action === "/editor/public-settings") return managedPublicSettings(request, db, actor, projectId, siteId, origin);
  if (action === "/editor/seo-settings") return managedPublicSeoSettings(request, db, actor, projectId, siteId, origin);
  if (action === "/editor/redirects") return managedSiteRedirects(request, db, actor, projectId, siteId);
  if (action === "/editor/public-domain") return managedPublicDomain(request, db, actor, projectId, siteId, origin);
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
    const result = await changePageOnce(store, actor, projectId, siteId, body.expectedVersion, change);
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

type SeoPage = { locale: string; path: string; title: string; text: string; group: string; lastmod?: string };
function xml(value: string): string { return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!); }
function managedCollectionPath(prefix: string | null): string | null { return prefix === null ? null : prefix.slice(0, -1); }

/** Managed pages and their immutable CMS snapshots are the only inputs to public discovery files. */
export async function managedPublicSeoResponse(request: Request, db: ManagedD1, origin: string, store?: CmsStore,
  customRoute?: { readonly slug: string; readonly prefix: ""; readonly noindex?: boolean }): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let slug: string, prefix: string, noindex = false, name: string;
  if (customRoute) { slug = customRoute.slug; prefix = customRoute.prefix; noindex = customRoute.noindex === true; }
  else {
    if (url.origin !== origin) return null;
    const match = /^\/s\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/(?:sitemap\.xml|robots\.txt|llms\.txt|llms-full\.txt))$/u.exec(url.pathname);
    if (!match) return null;
    slug = match[1]!; prefix = `/s/${slug}`;
  }
  const suffix = customRoute ? url.pathname : url.pathname.slice(prefix.length);
  if (!["/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt"].includes(suffix)) return null;
  const site = await db.prepare(`SELECT s.id AS site_id, s.name, ms.public_domain_noindex, ms.public_policy_json FROM managed_sites AS ms
    JOIN sites AS s ON s.id = ms.site_id WHERE ms.slug = ?1 LIMIT 1`).bind(slug)
    .first<{ site_id: string; name: string; public_domain_noindex: number; public_policy_json: string }>();
  if (!site) return null;
  let seo: ManagedSiteSeoSettings;
  try {
    const policy = parseManagedPublicPolicy(JSON.parse(site.public_policy_json), origin);
    if (!policy) return null;
    seo = policy.seo;
  } catch { return null; }
  name = seo.siteName ?? site.name;
  if (customRoute && site.public_domain_noindex === 1 || seo.robotsPolicy === "noindex") noindex = true;
  if (suffix === "/robots.txt") {
    const body = noindex ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nAllow: /\nSitemap: ${url.origin}${prefix}/sitemap.xml\n`;
    const headers = responseHeaders("text/plain; charset=utf-8");
    if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(request.method === "HEAD" ? null : body, { headers });
  }

  const rows = await db.prepare(`SELECT mp.site_id, mp.page_id, mp.locale, version.revision, publication.published_path AS path,
      version.document_json, version.document_key, version.document_digest,
      publication.created_at AS published_at
    FROM managed_sites AS ms JOIN managed_pages AS mp ON mp.site_id = ms.site_id
    JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
    JOIN managed_page_versions AS version ON version.site_id = mp.site_id AND version.page_id = mp.page_id
      AND version.locale = mp.locale AND version.revision = mp.published_revision
    WHERE ms.slug = ?1 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
    ORDER BY publication.published_path, mp.locale LIMIT 500`).bind(slug).all<PageSourceRow & {
      path: string; published_at: number | null;
    }>();
  const pages: SeoPage[] = [];
  for (const row of rows.results ?? []) {
    try {
      const document = await readPageSource(store, row);
      if (noindex || document.meta?.noindex) continue;
      pages.push({ locale: row.locale, path: row.path, title: document.title, text: pageText(document.body), group: `page:${localizedPathIdentity(row.locale, row.path)}`,
        ...(row.published_at ? { lastmod: new Date(row.published_at * 1000).toISOString() } : {}) });
    } catch { /* invalid historical pages are omitted from public discovery output */ }
  }
  if (store) {
    const stateRow = await db.prepare(`SELECT ms.site_id, cms.state_json FROM managed_sites AS ms
      JOIN managed_cms_state AS cms ON cms.site_id = ms.site_id WHERE ms.slug = ?1 LIMIT 1`).bind(slug)
      .first<{ site_id: string; state_json: string }>();
    if (stateRow) {
      const state = JSON.parse(stateRow.state_json) as Site["state"];
      const releases = [
        ...(state.current ? [{ locale: state.locale, id: state.current.id }] : []),
        ...Object.entries(state.localizedReleases ?? {}).map(([locale, release]) => ({ locale, id: release.id }))
      ];
      for (const release of releases.slice(0, 3)) try {
        const snapshot = await store.snapshot(stateRow.site_id, release.id);
        const cmsPrefix = snapshot.sourceLocale && snapshot.sourceLocale !== snapshot.locale ? `/${snapshot.locale}/cms` : "/cms";
        pages.push({ locale: snapshot.locale, path: cmsPrefix, title: "CMS", text: "", group: "cms:root" });
        for (const collection of snapshot.schema.collections) {
          const path = managedCollectionPath(collection.pathPrefix);
          if (path) pages.push({ locale: snapshot.locale, path, title: collection.label, text: "", group: `cms:list:${collection.id}` });
        }
        for (const item of snapshot.items) if (item.path) {
          const collection = snapshot.schema.collections.find(({ id }) => id === item.collectionId);
          const title = collection ? String(item.values[collection.titleField] ?? "") : "";
          const textFields = collection?.fields.filter(({ fieldId, type }) => fieldId !== collection.titleField && ["text", "longText", "richText", "datetime"].includes(type)) ?? [];
          const body = textFields.map(({ fieldId }) => String(item.values[fieldId] ?? "")).join(" ");
          pages.push({ locale: snapshot.locale, path: item.path, title, text: body, group: `cms:item:${item.collectionId}:${item.itemId}` });
        }
      } catch { /* unpublished or unavailable CMS snapshots are omitted */ }
    }
  }
  const absolute = (page: SeoPage) => `${url.origin}${prefix}${page.path}`;
  if (suffix === "/sitemap.xml") {
    const groups = new Map<string, SeoPage[]>();
    for (const page of pages) groups.set(page.group, [...(groups.get(page.group) ?? []), page]);
    const entries = pages.map((page) => {
      const alternatives = [...(groups.get(page.group) ?? [])];
      const languages = alternatives.length > 1 ? alternatives.map((other) => `<xhtml:link rel="alternate" hreflang="${xml(other.locale.toLowerCase())}" href="${xml(absolute(other))}"/>`).join("") : "";
      const lastmod = page.lastmod ? `<lastmod>${xml(page.lastmod)}</lastmod>` : "";
      return `<url><loc>${xml(absolute(page))}</loc>${lastmod}${languages}</url>`;
    }).join("");
    const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries}</urlset>`;
    const headers = responseHeaders("application/xml; charset=utf-8");
    if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(request.method === "HEAD" ? null : body, { headers });
  }
  const markdown = [
    `# ${name}`, "", "## Pages", "",
    ...pages.map((page) => `- [${page.title || page.path}](${absolute(page)})${page.text ? `: ${page.text.slice(0, 240)}` : ""}`)
  ].join("\n");
  const full = suffix === "/llms-full.txt" ? [markdown, "", "## Full text", "", ...pages.filter(({ text }) => text).map((page) => `### ${page.title}\n\n${page.text}`)].join("\n") : markdown;
  const headers = responseHeaders("text/plain; charset=utf-8");
  if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(request.method === "HEAD" ? null : full, { headers });
}

/** 共有originのslug routeか、host照合済みの独自domainでだけ呼ぶ。 */
export async function managedPublicRequest(request: Request, db: ManagedD1, origin: string, store?: CmsStore,
  customRoute?: { readonly slug: string; readonly prefix: ""; readonly noindex?: boolean }, cache?: ManagedPublicHtmlCache): Promise<Response> {
  if (!customRoute && new URL(request.url).origin !== origin || request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  const url = new URL(request.url), match = customRoute ? null : /^\/s\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(.*))?$/u.exec(url.pathname);
  if (!customRoute && !match) return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  const slug = customRoute?.slug ?? match![1]!;
  const prefix = customRoute?.prefix ?? `/s/${slug}`;
  const path = customRoute ? (url.pathname || "/") : match![2] ? `/${match![2]}` : "/";
  const redirectTo = (target: string, status = 301) => {
    const headers = responseHeaders("text/plain; charset=utf-8");
    headers.set("Location", `${url.origin}${prefix}${target}${url.search}`);
    headers.set("Cache-Control", "public, max-age=300");
    return new Response(null, { status, headers });
  };
  if (path.length > 1 && path.endsWith("/")) return redirectTo(path.replace(/\/+$/u, ""));
  const caseFoldedPath = /^[A-Za-z0-9/_-]+$/u.test(path) ? path.toLowerCase() : path;
  if (validatePagePath(caseFoldedPath) !== null) return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  const parentPath = path.slice(0, path.lastIndexOf("/")), notFound = () => {
    const headers = responseHeaders("text/html; charset=utf-8");
    headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return new Response("<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex, nofollow\"><title>ページが見つかりません</title><main><h1>ページが見つかりません</h1><p>お探しのページは移動したか、公開を終了しました。</p></main></html>", { status: 404, headers });
  };
  const row = await db.prepare(`
    SELECT mp.site_id, mp.page_id, mp.locale, mp.title, publication.published_path AS path, mp.published_revision, version.revision, version.bindings_json,
           version.document_json, version.document_key, version.document_digest,
           publication.id AS publication_id, publication.cms_release_id, publication.cms_schema_revision,
           ms.public_policy_json, ms.public_policy_version, ms.public_domain_noindex, ms.public_domain_version, s.name AS site_name
      FROM managed_sites AS ms
      JOIN sites AS s ON s.id = ms.site_id
      JOIN managed_pages AS mp ON mp.site_id = ms.site_id
      JOIN managed_page_versions AS version
        ON version.site_id = mp.site_id AND version.page_id = mp.page_id AND version.locale = mp.locale AND version.revision = mp.published_revision
      LEFT JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
        AND publication.site_id = mp.site_id AND publication.page_id = mp.page_id AND publication.locale = mp.locale
        AND publication.source_revision = mp.published_revision
     WHERE ms.slug = ?1 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
       AND (COALESCE(publication.published_path, mp.path) = ?2
         OR (COALESCE(publication.published_path, mp.path) = ?3 AND json_type(version.bindings_json, '$.detail') = 'object'))
     ORDER BY (COALESCE(publication.published_path, mp.path) = ?2) DESC
     LIMIT 1
  `).bind(slug, path, parentPath).first<PageSourceRow & Pick<ManagedPageRow, "title" | "path" | "bindings_json"> & {
    published_revision: number; publication_id: string | null; cms_release_id: string | null; cms_schema_revision: string | null;
    public_policy_json: string; public_policy_version: string; public_domain_noindex: number; public_domain_version: string; site_name: string;
  }>();
  if (!row) {
    const redirect = await db.prepare(`SELECT r.to_path FROM managed_site_redirects AS r JOIN managed_sites AS ms ON ms.site_id = r.site_id
      WHERE ms.slug = ?1 AND r.from_path = ?2 LIMIT 1`).bind(slug, path).first<{ to_path: string }>();
    if (redirect) return redirectTo(redirect.to_path);
    if (path !== caseFoldedPath) {
      const lower = await db.prepare(`SELECT 1 AS found FROM managed_sites AS ms JOIN managed_pages AS mp ON mp.site_id = ms.site_id
        JOIN managed_page_publications AS publication ON publication.id = mp.published_publication_id
        WHERE ms.slug = ?1 AND publication.published_path = ?2 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL LIMIT 1`)
        .bind(slug, caseFoldedPath).first<{ found: number }>();
      if (lower) return redirectTo(caseFoldedPath);
    }
    return notFound();
  }
  const hasUppercaseRoute = /[A-Z]/u.test(path);
  if (hasUppercaseRoute && (row.path !== parentPath || !row.bindings_json)) return notFound();
  if (!customRoute && match![2] === undefined) {
    url.pathname += "/";
    const headers = responseHeaders("text/plain; charset=utf-8");
    headers.set("Location", url.href);
    return new Response(null, { status: 308, headers });
  }
  const refs = url.searchParams.getAll("_niho_embed");
  const requestedRef = refs[0];
  if (refs.length && (refs.length !== 1 || url.searchParams.size !== 1 || request.method !== "GET" ||
    !requestedRef || !MANAGED_EMBED_REF.test(requestedRef))) return notFound();
  let cacheKey: Request | undefined;
  if (!requestedRef && request.method === "GET" && cache) {
    const key = await digest({ origin: url.origin, path: `${prefix}${path}`, site: row.site_id, page: row.page_id,
      locale: row.locale, revision: row.published_revision, publication: row.publication_id,
      cmsRelease: row.cms_release_id, cmsSchema: row.cms_schema_revision, policy: row.public_policy_version,
      domainVersion: row.public_domain_version, domainNoindex: customRoute?.noindex === true });
    cacheKey = new Request(`${url.origin}/_niho-cache/${key}`);
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return revalidatePublicResponse(request, cached);
    } catch { /* edge cache is an optional optimization */ }
  }
  let document: PageDocument;
  try { document = await readPageSource(store, row); }
  catch { return json({ error: "invalid_managed_page_storage" }, 503); }
  const publicPath = `${prefix}${path}`;
  let assetManifest: readonly CmsPublicAsset[] = [];
  if (row.bindings_json) {
    if (!store || !row.cms_release_id || !row.cms_schema_revision) return notFound();
    const bindings = parseCmsPageBindings(JSON.parse(row.bindings_json), document);
    if (hasUppercaseRoute && !bindings.detail) return notFound();
    if (bindings.detail && row.path === path) return notFound();
    const released = await store.snapshot(row.site_id, row.cms_release_id);
    if (released.schema.schemaRevision !== row.cms_schema_revision || released.locale !== row.locale) return notFound();
    const projected = resolveCmsPageBindings(document, bindings, released, {
      blocks: managedBlockContracts, ...(bindings.detail ? { detail: { slug: path.slice(parentPath.length + 1) } } : {})
    });
    if (!projected) return notFound();
    document = projected;
    assetManifest = released.assetManifest;
  }
  const policy = parseManagedPublicPolicy(JSON.parse(row.public_policy_json), origin) ?? emptyManagedPublicPolicy();
  const embeds = await resolvePublishedEmbeds(db, document, { siteId: row.site_id, pageId: row.page_id, locale: row.locale, parentOrigin: origin, publicPath }, policy);
  if (requestedRef) {
    const embed = embeds.find(({ refId }) => refId === requestedRef);
    return embed ? json({ src: embed.src.href }) : notFound();
  }
  const hostNoindex = customRoute?.noindex === true;
  const rendered = await renderManagedPage({ db, store, document, policy, origin, prefix,
    path: hasUppercaseRoute ? path.toLowerCase() : path, alternatePath: row.path, publicPath,
    siteName: row.site_name, embeds, assets: assetManifest, forceNoindex: hostNoindex });
  const headers = responseHeaders("text/html; charset=utf-8");
  headers.set("Cache-Control", "public, no-cache, s-maxage=300, stale-while-revalidate=60");
  headers.set("Content-Security-Policy", rendered.contentSecurityPolicy);
  if (hostNoindex || policy.seo.robotsPolicy === "noindex") headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  const fullResponse = await withPublicEtag(rendered.html, headers);
  if (cacheKey && cache) try { await cache.put(cacheKey, fullResponse.clone()); } catch { /* edge cache is an optional optimization */ }
  const response = revalidatePublicResponse(request, fullResponse);
  return request.method === "HEAD" && response.status !== 304 ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export async function managedDashboardOverview(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Record<string, unknown> | null> {
  const registration = await db.prepare(`
    SELECT ms.slug, ms.public_domain,
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
