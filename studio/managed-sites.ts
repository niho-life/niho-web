import { parsePageDocument, type PageDocument, type PageNode } from "../src/core.js";
import { normalizePageChange, pageChangeProblems } from "../src/editor-model.js";
import type { EditorPage, EditorPageChange, EditorReleaseRequest, EditorTarget } from "../src/editor-types.js";
import { renderPageHead, resolvePageMetadata, validatePagePath } from "../src/pages.js";

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
export type ManagedActor = {
  readonly subject: string;
  readonly email: string;
  /** CLI はブラウザの Origin / Sec-Fetch-Site を持たない。 */
  readonly cli: boolean;
};
export type ManagedProjectRegistration = {
  readonly project_id: string;
  readonly site_id: string;
  readonly slug: string;
  readonly published_page_count: number;
  readonly published_path: string | null;
  readonly updated_at: number | null;
  readonly last_published_at: number | null;
};

type ManagedPageRow = {
  readonly project_id: string;
  readonly site_id: string;
  readonly slug: string;
  readonly page_id: string;
  readonly locale: string;
  readonly title: string;
  readonly path: string;
  readonly visibility: "public" | "private";
  readonly current_version: string;
  readonly current_revision: number;
  readonly published_revision: number | null;
  readonly document_json: string;
};
type StoredPlan = {
  readonly operation: "release.publish" | "release.rollback" | "page.create" | "page.update" | "page.visibility";
  readonly payload_json: string;
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const MAX_EDITOR_BODY = 600 * 1024;
const MAX_MUTATION_BODY = 16 * 1024;
const PLAN_SECONDS = 10 * 60;

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
function opaqueVersion(): string { return `p.${crypto.randomUUID()}`; }
function opaqueId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

export function publicSitesOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.origin === value && url.pathname === "/" && !url.search && !url.hash ? value : null;
  } catch { return null; }
}
export function managedPageUrl(origin: string, slug: string, path: string): string {
  return `${origin}/s/${slug}${path}`;
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

export async function createManagedProject(request: Request, db: ManagedD1, actor: ManagedActor, origin: string): Promise<Response> {
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["title", "slug", "locale"]) || !safeTitle(body.title)
    || typeof body.slug !== "string" || body.slug.length > 63 || !SLUG.test(body.slug)
    || typeof body.locale !== "string" || body.locale.length > 40 || !LOCALE.test(body.locale)) return json({ error: "invalid_request" }, 400);
  if (origin === new URL(request.url).origin) return json({ error: "public_origin_must_be_separate" }, 503);
  const existing = await db.prepare("SELECT 1 AS found FROM managed_sites WHERE slug = ?1 LIMIT 1").bind(body.slug).first<{ readonly found: number }>();
  if (existing) return json({ error: "slug_taken" }, 409);

  const projectId = opaqueId("project"), siteId = opaqueId("site"), pageId = "home", version = opaqueVersion();
  const document = initialDocument(siteId, pageId, body.locale, body.title);
  const displayName = actor.email.length <= 120 ? actor.email : "Project owner";
  let results: readonly D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare("INSERT INTO projects (id, name) VALUES (?1, ?2)").bind(projectId, body.title),
      db.prepare("INSERT INTO sites (id, project_id, name, public_origin) VALUES (?1, ?2, ?3, NULL)").bind(siteId, projectId, body.title),
      db.prepare("INSERT INTO project_members (project_id, access_subject, role, display_name, email) VALUES (?1, ?2, 'owner', ?3, ?4)").bind(projectId, actor.subject, displayName, actor.email),
      db.prepare("INSERT INTO managed_sites (site_id, slug, created_by_subject) VALUES (?1, ?2, ?3)").bind(siteId, body.slug, actor.subject),
      db.prepare("INSERT INTO managed_pages (site_id, page_id, locale, title, path, visibility, current_version, current_revision) VALUES (?1, ?2, ?3, ?4, '/', 'public', ?5, 1)")
        .bind(siteId, pageId, body.locale, body.title, version),
      db.prepare("INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject) VALUES (?1, ?2, ?3, 1, ?4, 'initial', ?5)")
        .bind(siteId, pageId, body.locale, JSON.stringify(document), actor.subject),
      db.prepare("INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id) VALUES (?1, ?2, ?3, ?4, 'site.created', 'home')")
        .bind(crypto.randomUUID(), projectId, siteId, actor.subject)
    ]);
  } catch (error) {
    if (error instanceof Error && /(?:UNIQUE|managed_sites\.slug)/iu.test(error.message)) return json({ error: "slug_taken" }, 409);
    throw error;
  }
  if (results.length !== 7 || results.some((result) => !result.success) || results.slice(0, 7).some((result) => result.meta?.changes !== 1)) throw new Error("managed project batch failed");
  return json({ status: "created", projectId, siteId, editorPath: `/projects/${projectId}/sites/${siteId}/editor` }, 201);
}

export async function managedRegistration(db: ManagedD1, projectId: string, siteId: string): Promise<{ readonly slug: string; readonly site_name: string } | null> {
  return db.prepare(`SELECT ms.slug, s.name AS site_name FROM managed_sites AS ms JOIN sites AS s ON s.id = ms.site_id WHERE s.project_id = ?1 AND s.id = ?2 LIMIT 1`)
    .bind(projectId, siteId).first<{ readonly slug: string; readonly site_name: string }>();
}

async function managedMemberRegistration(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string): Promise<{ readonly slug: string; readonly site_name: string } | null> {
  return db.prepare(`
    SELECT ms.slug, s.name AS site_name
      FROM project_members AS member
      JOIN sites AS s ON s.project_id = member.project_id
      JOIN managed_sites AS ms ON ms.site_id = s.id
     WHERE member.access_subject = ?1 AND member.project_id = ?2 AND s.id = ?3
       AND member.role IN ('owner', 'editor')
     LIMIT 1
  `).bind(actor.subject, projectId, siteId).first<{ readonly slug: string; readonly site_name: string }>();
}

export async function managedProjectRegistrations(db: ManagedD1, subject: string): Promise<Map<string, ManagedProjectRegistration>> {
  const result = await db.prepare(`
    SELECT p.id AS project_id, s.id AS site_id, ms.slug,
           (SELECT count(*) FROM managed_pages AS mp WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL) AS published_page_count,
           (SELECT mp.path FROM managed_pages AS mp
             WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
             ORDER BY CASE WHEN mp.path = '/' THEN 0 ELSE 1 END, mp.path LIMIT 1) AS published_path,
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

async function pageRow(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, pageId: string, locale?: string): Promise<ManagedPageRow | null> {
  return db.prepare(`
    SELECT p.id AS project_id, s.id AS site_id, ms.slug, mp.page_id, mp.locale, mp.title, mp.path, mp.visibility,
           mp.current_version, mp.current_revision, mp.published_revision, version.document_json
      FROM project_members AS member
      JOIN projects AS p ON p.id = member.project_id
      JOIN sites AS s ON s.project_id = p.id
      JOIN managed_sites AS ms ON ms.site_id = s.id
      JOIN managed_pages AS mp ON mp.site_id = s.id
      JOIN managed_page_versions AS version
        ON version.site_id = mp.site_id AND version.page_id = mp.page_id AND version.locale = mp.locale AND version.revision = mp.current_revision
     WHERE member.access_subject = ?1 AND p.id = ?2 AND s.id = ?3 AND mp.page_id = ?4
       AND (?5 IS NULL OR mp.locale = ?5)
     LIMIT 1
  `).bind(actor.subject, projectId, siteId, pageId, locale ?? null).first<ManagedPageRow>();
}

async function pages(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string): Promise<readonly EditorPage[] | null> {
  const result = await db.prepare(`
    SELECT mp.site_id, mp.page_id, mp.locale, mp.title, mp.path, mp.visibility, mp.published_revision
      FROM project_members AS member
      JOIN sites AS s ON s.project_id = member.project_id
      JOIN managed_sites AS ms ON ms.site_id = s.id
      JOIN managed_pages AS mp ON mp.site_id = s.id
     WHERE member.access_subject = ?1 AND member.project_id = ?2 AND s.id = ?3
     ORDER BY CASE mp.path WHEN '/' THEN 0 ELSE 1 END, mp.path, mp.page_id
     LIMIT 500
  `).bind(actor.subject, projectId, siteId).all<{
    readonly site_id: string; readonly page_id: string; readonly locale: string; readonly title: string; readonly path: string;
    readonly visibility: "public" | "private"; readonly published_revision: number | null;
  }>();
  if (!result.success) throw new Error("managed pages query failed");
  if (!result.results?.length) {
    const registered = await managedMemberRegistration(db, actor, projectId, siteId);
    return registered ? [] : null;
  }
  return result.results.map((page) => ({
    siteId: page.site_id, pageId: page.page_id, locale: page.locale, title: page.title, path: page.path,
    kind: "page", visibility: page.visibility, published: page.published_revision !== null
  }));
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

async function snapshot(db: ManagedD1, row: ManagedPageRow): Promise<Record<string, unknown>> {
  const document = parsePageDocument(JSON.parse(row.document_json) as unknown);
  if (document.siteId !== row.site_id || document.pageId !== row.page_id || document.locale !== row.locale || document.revision !== row.current_revision) throw new Error("invalid managed page storage");
  return { document, version: row.current_version, hasSavedDraft: true, releases: await releases(db, row) };
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function storePlan(db: ManagedD1, actor: ManagedActor, siteId: string, operation: StoredPlan["operation"], payload: unknown): Promise<string> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const [, result] = await db.batch([
    db.prepare("DELETE FROM managed_editor_plans WHERE site_id = ?1 AND expires_at <= unixepoch()").bind(siteId),
    db.prepare(`
    INSERT INTO managed_editor_plans (token_hash, site_id, actor_subject, operation, payload_json, expires_at)
    SELECT ?1, ms.site_id, ?3, ?4, ?5, unixepoch() + ?6
      FROM managed_sites AS ms
      JOIN sites AS s ON s.id = ms.site_id
      JOIN project_members AS member ON member.project_id = s.project_id
     WHERE ms.site_id = ?2 AND member.access_subject = ?3
  `).bind(await tokenHash(token), siteId, actor.subject, operation, JSON.stringify(payload), PLAN_SECONDS)
  ]);
  if (!changed(result)) throw new Error("managed plan was not stored");
  return token;
}
async function readPlan(db: ManagedD1, actor: ManagedActor, siteId: string, token: unknown): Promise<StoredPlan | null> {
  if (typeof token !== "string" || !token || token.length > 4096) return null;
  return db.prepare(`
    SELECT plan.operation, plan.payload_json
      FROM managed_editor_plans AS plan
      JOIN managed_sites AS ms ON ms.site_id = plan.site_id
      JOIN sites AS s ON s.id = ms.site_id
      JOIN project_members AS member ON member.project_id = s.project_id
     WHERE plan.token_hash = ?1 AND plan.site_id = ?2 AND plan.actor_subject = ?3
       AND plan.expires_at > unixepoch() AND member.access_subject = ?3
     LIMIT 1
  `).bind(await tokenHash(token), siteId, actor.subject).first<StoredPlan>();
}

function discardSupersededDraft(db: ManagedD1, row: ManagedPageRow, version: string): D1Statement {
  return db.prepare(`DELETE FROM managed_page_versions
     WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND revision = ?4
       AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND current_version = ?5)
       AND NOT EXISTS (SELECT 1 FROM managed_page_publications
                        WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND source_revision = ?4)`)
    .bind(row.site_id, row.page_id, row.locale, row.current_revision, version);
}

async function saveDraft(request: Request, db: ManagedD1, actor: ManagedActor, row: ManagedPageRow): Promise<Response> {
  const body = await readJson(request, actor, MAX_EDITOR_BODY);
  if (!body || !exactKeys(body, ["expectedVersion", "document"]) || typeof body.expectedVersion !== "string") return json({ error: "invalid_request" }, 400);
  if (body.expectedVersion !== row.current_version) return json({ status: "conflict" }, 409);
  let submitted: PageDocument;
  try { submitted = parsePageDocument(body.document); } catch { return json({ error: "invalid_document" }, 400); }
  if (submitted.siteId !== row.site_id || submitted.pageId !== row.page_id || submitted.locale !== row.locale || submitted.revision !== row.current_revision) return json({ error: "invalid_document" }, 400);
  const revision = row.current_revision + 1, version = opaqueVersion(), stored = { ...submitted, revision };
  const results = await db.batch([
    db.prepare(`UPDATE managed_pages SET current_version = ?1, current_revision = ?2, updated_at = unixepoch()
                 WHERE site_id = ?3 AND page_id = ?4 AND locale = ?5 AND current_version = ?6
                   AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
                                WHERE s.id = ?3 AND member.access_subject = ?7)`)
      .bind(version, revision, row.site_id, row.page_id, row.locale, body.expectedVersion, actor.subject),
    db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject)
                SELECT site_id, page_id, locale, ?2, ?3, 'save', ?4 FROM managed_pages
                 WHERE site_id = ?1 AND page_id = ?5 AND locale = ?6 AND current_version = ?7`)
      .bind(row.site_id, revision, JSON.stringify(stored), actor.subject, row.page_id, row.locale, version),
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
                SELECT ?1, s.project_id, s.id, ?2, 'page.saved', ?3 FROM sites AS s
                 WHERE s.id = ?4 AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = s.id AND page_id = ?3 AND locale = ?5 AND current_version = ?6)`)
      .bind(crypto.randomUUID(), actor.subject, row.page_id, row.site_id, row.locale, version),
    discardSupersededDraft(db, row, version)
  ]);
  if (!changed(results[0]) || !changed(results[1]) || !changed(results[2])) return json({ status: "conflict" }, 409);
  return json({ status: "saved", version, revision });
}

function releaseRequest(value: Record<string, unknown>, row: ManagedPageRow): EditorReleaseRequest | null {
  const target = record(value.target), action = value.action;
  if (!target || !exactKeys(value, ["target", "expectedVersion", "action", ...(action === "rollback" ? ["revision"] : [])])
    || target.siteId !== row.site_id || target.pageId !== row.page_id || target.locale !== row.locale
    || typeof value.expectedVersion !== "string" || value.expectedVersion !== row.current_version
    || action !== "publish" && action !== "rollback"
    || action === "publish" && value.revision !== undefined
    || action === "rollback" && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)) return null;
  return { target: target as EditorTarget, expectedVersion: value.expectedVersion, action, ...(action === "rollback" ? { revision: Number(value.revision) } : {}) };
}

async function prepareRelease(request: Request, db: ManagedD1, actor: ManagedActor, row: ManagedPageRow, origin: string): Promise<Response> {
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  const checked = body && releaseRequest(body, row);
  if (!checked) return json({ error: "invalid_request" }, 400);
  const sourceRevision = checked.action === "publish" ? row.current_revision : checked.revision!;
  if (checked.action === "rollback") {
    const published = await db.prepare(`SELECT 1 AS found FROM managed_page_publications WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND source_revision = ?4 LIMIT 1`)
      .bind(row.site_id, row.page_id, row.locale, sourceRevision).first<{ readonly found: number }>();
    if (!published) return json({ error: "revision_not_published" }, 409);
  }
  const payload = { projectId: row.project_id, pageId: row.page_id, locale: row.locale, expectedVersion: row.current_version, action: checked.action, sourceRevision };
  const token = await storePlan(db, actor, row.site_id, checked.action === "publish" ? "release.publish" : "release.rollback", payload);
  const url = managedPageUrl(origin, row.slug, row.path);
  return json({
    ...checked, confirmationToken: token, domain: origin, url,
    changes: [{ path: row.path, before: row.published_revision === null ? "未公開" : `公開版 ${row.published_revision}`, after: `版 ${sourceRevision}` }],
    affected: [{ kind: "page", name: row.title }]
  });
}

async function applyRelease(request: Request, db: ManagedD1, actor: ManagedActor, row: ManagedPageRow): Promise<Response> {
  const body = await readJson(request, actor, MAX_MUTATION_BODY);
  if (!body || !exactKeys(body, ["expectedVersion", "confirmationToken"]) || typeof body.expectedVersion !== "string") return json({ error: "invalid_request" }, 400);
  if (body.expectedVersion !== row.current_version) return json({ status: "conflict" }, 409);
  const plan = await readPlan(db, actor, row.site_id, body.confirmationToken);
  if (!plan) return json({ status: "conflict" }, 409);
  const payload = record(JSON.parse(plan.payload_json) as unknown);
  if (!payload || payload.projectId !== row.project_id || payload.pageId !== row.page_id || payload.locale !== row.locale
    || payload.expectedVersion !== row.current_version || !Number.isSafeInteger(payload.sourceRevision)
    || plan.operation !== `release.${payload.action}`) return json({ status: "conflict" }, 409);
  const publicationId = crypto.randomUUID(), token = await tokenHash(String(body.confirmationToken)), version = opaqueVersion();
  const action = payload.action === "rollback" ? "rollback" : "publish";
  const revision = action === "rollback" ? row.current_revision + 1 : row.current_revision;
  const auditAction = action === "rollback" ? "page.restored" : "page.published";
  const actorId = actor.subject;
  const restore = action === "rollback" ? [db.prepare(`
    INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject)
    SELECT mp.site_id, mp.page_id, mp.locale, ?1, json_set(prior.document_json, '$.revision', ?1), 'restore', ?2
      FROM managed_pages AS mp
      JOIN managed_page_versions AS prior
        ON prior.site_id = mp.site_id AND prior.page_id = mp.page_id AND prior.locale = mp.locale AND prior.revision = ?3
      JOIN managed_editor_plans AS plan ON plan.site_id = mp.site_id
     WHERE mp.site_id = ?4 AND mp.page_id = ?5 AND mp.locale = ?6 AND mp.current_version = ?7
       AND plan.token_hash = ?8 AND plan.actor_subject = ?9 AND plan.expires_at > unixepoch()
       AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
                    WHERE s.id = mp.site_id AND member.access_subject = ?9 AND member.role IN ('owner', 'editor'))
       AND EXISTS (SELECT 1 FROM managed_page_publications AS pub
                    WHERE pub.site_id = mp.site_id AND pub.page_id = mp.page_id AND pub.locale = mp.locale AND pub.source_revision = ?3)`)
    .bind(revision, actor.subject, payload.sourceRevision, row.site_id, row.page_id, row.locale, row.current_version, token, actorId)] : [];
  const results = await db.batch([
    ...restore,
    db.prepare(`INSERT INTO managed_page_publications (id, site_id, page_id, locale, source_revision, action, published_by_subject)
                SELECT ?1, mp.site_id, mp.page_id, mp.locale, ?2, ?3, ?4
                  FROM managed_pages AS mp JOIN managed_editor_plans AS plan ON plan.site_id = mp.site_id
                 WHERE mp.site_id = ?5 AND mp.page_id = ?6 AND mp.locale = ?7 AND mp.current_version = ?8
                   AND plan.token_hash = ?9 AND plan.actor_subject = ?10 AND plan.expires_at > unixepoch()
                   AND EXISTS (SELECT 1 FROM managed_page_versions AS version WHERE version.site_id = mp.site_id AND version.page_id = mp.page_id AND version.locale = mp.locale AND version.revision = ?2)
                   AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
                                WHERE s.id = mp.site_id AND member.access_subject = ?10 AND member.role IN ('owner', 'editor'))`)
      .bind(publicationId, revision, action, actor.subject, row.site_id, row.page_id, row.locale, row.current_version, token, actorId),
    db.prepare(`UPDATE managed_pages SET published_revision = ?1, current_revision = ?1, current_version = ?7, updated_at = unixepoch()
                 WHERE site_id = ?2 AND page_id = ?3 AND locale = ?4 AND current_version = ?5
                   AND EXISTS (SELECT 1 FROM managed_page_publications WHERE id = ?6)`)
      .bind(revision, row.site_id, row.page_id, row.locale, row.current_version, publicationId, version),
    db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
                SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM managed_page_publications WHERE id = ?7)`)
      .bind(crypto.randomUUID(), row.project_id, row.site_id, actor.subject, auditAction, row.page_id, publicationId),
    db.prepare("DELETE FROM managed_editor_plans WHERE token_hash = ?1 AND actor_subject = ?2 AND EXISTS (SELECT 1 FROM managed_page_publications WHERE id = ?3)")
      .bind(token, actorId, publicationId),
    ...(action === "rollback" ? [discardSupersededDraft(db, row, version)] : [])
  ]);
  if (!results.slice(0, restore.length + 4).every(changed)) return json({ status: "conflict" }, 409);
  const refreshed = await pageRow(db, actor, row.project_id, row.site_id, row.page_id, row.locale);
  if (!refreshed) return json({ error: "forbidden" }, 403);
  return json({ status: "released", snapshot: await snapshot(db, refreshed) });
}

function changeOperation(change: EditorPageChange): StoredPlan["operation"] {
  return change.action === "create" ? "page.create" : change.action === "update" ? "page.update" : "page.visibility";
}
async function linkedPages(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, target: EditorPage, targetPath: string, targetUrl: string) {
  const result = await db.prepare(`
    WITH links AS (
      SELECT mp.page_id, mp.locale, mp.title, link.value AS href,
             CASE WHEN substr(link.path, -6) = '.attrs'
                  THEN json_extract(version.document_json, substr(link.path, 1, length(link.path) - 6) || '.id')
             END AS node_id
        FROM project_members AS member
        JOIN sites AS s ON s.project_id = member.project_id
        JOIN managed_pages AS mp ON mp.site_id = s.id
        JOIN managed_page_versions AS version
          ON version.site_id = mp.site_id AND version.page_id = mp.page_id AND version.locale = mp.locale
             AND version.revision IN (mp.current_revision, mp.published_revision)
        JOIN json_tree(version.document_json, '$.body') AS link
       WHERE member.access_subject = ?1 AND s.project_id = ?2 AND s.id = ?3 AND mp.page_id <> ?4
         AND link.key = 'href' AND link.type = 'text'
    )
    SELECT page_id, locale, title, count(DISTINCT node_id) AS count
      FROM links
     WHERE node_id IS NOT NULL
       AND (href IN (?5, ?6) OR substr(href, 1, length(?5) + 1) IN (?5 || '?', ?5 || '#')
                            OR substr(href, 1, length(?6) + 1) IN (?6 || '?', ?6 || '#'))
     GROUP BY page_id, locale, title
     ORDER BY title, page_id, locale
     LIMIT 500
  `).bind(actor.subject, projectId, siteId, target.pageId, targetPath, targetUrl)
    .all<{ readonly page_id: string; readonly locale: string; readonly title: string; readonly count: number }>();
  if (!result.success) throw new Error("managed page links query failed");
  return (result.results ?? []).map(({ page_id, locale, title, count }) => ({ pageId: page_id, locale, title, count }));
}

async function preparePageChange(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Response> {
  const body = await readJson(request, actor, MAX_MUTATION_BODY), change = normalizePageChange(body?.change);
  const currentPages = await pages(db, actor, projectId, siteId), registration = await managedRegistration(db, projectId, siteId);
  if (!body || !exactKeys(body, ["change"]) || !change || change.action === "duplicate" || !currentPages || !registration) return json({ error: "invalid_request" }, 400);
  const problems = pageChangeProblems(change, currentPages, { id: siteId, name: "Managed site", domains: [origin] });
  if (problems.length) return json({ error: "invalid_page_change", field: problems[0]!.field, message: problems[0]!.message }, 400);
  const target = change.action === "create" ? null : currentPages.find((page) => page.pageId === change.target.pageId && page.locale === change.target.locale);
  const payload = { projectId, siteId, change, expectedVersion: target ? (await pageRow(db, actor, projectId, siteId, target.pageId, target.locale))?.current_version ?? null : null };
  const token = await storePlan(db, actor, siteId, changeOperation(change), payload);
  const makePrivate = change.action === "visibility" && change.visibility === "private";
  const moving = change.action === "update" && change.path !== target?.path;
  const before = target?.path ? managedPageUrl(origin, registration.slug, target.path) : undefined;
  const afterPath = change.action === "visibility" ? target?.path : change.path;
  const after = afterPath && !makePrivate ? managedPageUrl(origin, registration.slug, afterPath) : undefined;
  const linkedFrom = target?.path && before && (moving || makePrivate)
    ? await linkedPages(db, actor, projectId, siteId, target, target.path, before) : [];
  const notes = moving ? ["変更前のURLを指すリンクは、新しいURLへ更新してください。"]
    : makePrivate ? ["このページは公開URLから表示されなくなります。"] : [];
  return json({ change, confirmationToken: token, domain: origin, impact: {
    ...(before && target?.visibility !== "private" ? { before } : {}), ...(after ? { after } : {}), linkedFrom, navigation: [], notes
  } });
}

async function applyPageChange(request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string): Promise<Response> {
  const body = await readJson(request, actor, MAX_MUTATION_BODY), change = normalizePageChange(body?.change);
  if (!body || !exactKeys(body, ["change", "confirmationToken"]) || !change || change.action === "duplicate") return json({ error: "invalid_request" }, 400);
  const plan = await readPlan(db, actor, siteId, body.confirmationToken), payload = plan ? record(JSON.parse(plan.payload_json) as unknown) : null;
  if (!plan || !payload || payload.projectId !== projectId || payload.siteId !== siteId || plan.operation !== changeOperation(change)
    || JSON.stringify(payload.change) !== JSON.stringify(change)) return json({ status: "conflict" }, 409);
  const currentPages = await pages(db, actor, projectId, siteId);
  if (!currentPages || pageChangeProblems(change, currentPages, { id: siteId, name: "Managed site", domains: ["https://managed.invalid"] }).length) return json({ status: "conflict" }, 409);
  const token = await tokenHash(String(body.confirmationToken)), auditId = crypto.randomUUID();
  let results: readonly D1Result<unknown>[], resultPage: EditorPage;
  if (change.action === "create") {
    const pageId = opaqueId("page"), version = opaqueVersion(), document = initialDocument(siteId, pageId, change.locale, change.title);
    results = await db.batch([
      db.prepare(`INSERT INTO managed_pages (site_id, page_id, locale, title, path, visibility, current_version, current_revision)
                  SELECT ?1, ?2, ?3, ?4, ?5, 'public', ?6, 1
                   WHERE EXISTS (SELECT 1 FROM managed_editor_plans WHERE token_hash = ?7 AND actor_subject = ?8 AND expires_at > unixepoch())
                     AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id WHERE s.id = ?1 AND s.project_id = ?9 AND member.access_subject = ?8)
                     AND NOT EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?1 AND path = ?5)`)
        .bind(siteId, pageId, change.locale, change.title, change.path, version, token, actor.subject, projectId),
      db.prepare(`INSERT INTO managed_page_versions (site_id, page_id, locale, revision, document_json, kind, created_by_subject)
                  SELECT site_id, page_id, locale, 1, ?1, 'initial', ?2 FROM managed_pages WHERE site_id = ?3 AND page_id = ?4 AND locale = ?5`)
        .bind(JSON.stringify(document), actor.subject, siteId, pageId, change.locale),
      db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
                  SELECT ?1, ?2, ?3, ?4, 'page.created', ?5 WHERE EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?3 AND page_id = ?5 AND locale = ?6)`)
        .bind(auditId, projectId, siteId, actor.subject, pageId, change.locale),
      db.prepare(`DELETE FROM managed_editor_plans WHERE token_hash = ?1 AND actor_subject = ?2
                   AND EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?3 AND page_id = ?4 AND locale = ?5)`)
        .bind(token, actor.subject, siteId, pageId, change.locale)
    ]);
    resultPage = { siteId, pageId, locale: change.locale, title: change.title, path: change.path, kind: "page", visibility: "public", published: false };
  } else {
    const target = change.target, expectedVersion = payload.expectedVersion, version = opaqueVersion();
    if (typeof expectedVersion !== "string") return json({ status: "conflict" }, 409);
    const update = change.action === "update"
      ? db.prepare(`UPDATE managed_pages SET title = ?1, path = ?2, current_version = ?9, updated_at = unixepoch()
                     WHERE site_id = ?3 AND page_id = ?4 AND locale = ?5 AND current_version = ?6
                       AND EXISTS (SELECT 1 FROM managed_editor_plans WHERE token_hash = ?7 AND actor_subject = ?8 AND expires_at > unixepoch())
                       AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
                                    WHERE s.id = ?3 AND member.access_subject = ?8 AND member.role IN ('owner', 'editor'))
                       AND NOT EXISTS (SELECT 1 FROM managed_pages WHERE site_id = ?3 AND path = ?2 AND page_id <> ?4)`)
        .bind(change.title, change.path, siteId, target.pageId, target.locale, expectedVersion, token, actor.subject, version)
      : db.prepare(`UPDATE managed_pages SET visibility = ?1, current_version = ?8, updated_at = unixepoch()
                     WHERE site_id = ?2 AND page_id = ?3 AND locale = ?4 AND current_version = ?5
                       AND EXISTS (SELECT 1 FROM managed_editor_plans WHERE token_hash = ?6 AND actor_subject = ?7 AND expires_at > unixepoch())
                       AND EXISTS (SELECT 1 FROM sites AS s JOIN project_members AS member ON member.project_id = s.project_id
                                    WHERE s.id = ?2 AND member.access_subject = ?7 AND member.role IN ('owner', 'editor'))`)
        .bind(change.visibility, siteId, target.pageId, target.locale, expectedVersion, token, actor.subject, version);
    const action = change.action === "update" ? "page.updated" : "page.visibility";
    results = await db.batch([
      update,
      db.prepare(`INSERT INTO managed_site_audit (id, project_id, site_id, actor_subject, action, page_id)
                  SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1`)
        .bind(auditId, projectId, siteId, actor.subject, action, target.pageId),
      db.prepare("DELETE FROM managed_editor_plans WHERE token_hash = ?1 AND actor_subject = ?2 AND EXISTS (SELECT 1 FROM managed_site_audit WHERE id = ?3)")
        .bind(token, actor.subject, auditId)
    ]);
    const previous = currentPages.find((page) => page.pageId === target.pageId && page.locale === target.locale)!;
    resultPage = change.action === "update" ? { ...previous, title: change.title, path: change.path } : { ...previous, visibility: change.visibility };
  }
  if (results.some((result) => !changed(result))) return json({ status: "conflict" }, 409);
  return json({ status: "applied", page: resultPage });
}

/** GUI と CLI が共有する managed page operation dispatcher。 */
export async function managedEditorOperation(
  request: Request, db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, action: string, origin: string
): Promise<Response> {
  const registration = await managedMemberRegistration(db, actor, projectId, siteId);
  if (!registration) return json({ error: "forbidden" }, 403);
  if (action === "/editor/catalog") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const list = await pages(db, actor, projectId, siteId);
    if (list === null) return json({ error: "forbidden" }, 403);
    return json({ sites: [{ id: siteId, name: registration.site_name, domains: [origin] }], pages: list, pageChangeActions: ["create", "update", "visibility"], pagePathEditable: true });
  }
  if (action === "/editor/page-changes/prepare") return request.method === "POST" ? preparePageChange(request, db, actor, projectId, siteId, origin) : json({ error: "method_not_allowed" }, 405);
  if (action === "/editor/page-changes/apply") return request.method === "POST" ? applyPageChange(request, db, actor, projectId, siteId) : json({ error: "method_not_allowed" }, 405);
  const match = /^\/editor\/([A-Za-z][A-Za-z0-9_-]{0,79})(\/draft|\/release-plan|\/release)?$/u.exec(action);
  if (!match) return json({ error: "not_found" }, 404);
  const row = await pageRow(db, actor, projectId, siteId, match[1]!);
  if (!row) return json({ error: "forbidden" }, 403);
  if (!match[2]) return request.method === "GET" ? json(await snapshot(db, row)) : json({ error: "method_not_allowed" }, 405);
  if (match[2] === "/draft") return request.method === "PUT" ? saveDraft(request, db, actor, row) : json({ error: "method_not_allowed" }, 405);
  if (match[2] === "/release-plan") return request.method === "POST" ? prepareRelease(request, db, actor, row, origin) : json({ error: "method_not_allowed" }, 405);
  return request.method === "POST" ? applyRelease(request, db, actor, row) : json({ error: "method_not_allowed" }, 405);
}

export const MANAGED_CLI_OPERATION_IDS = new Set([
  "pages.catalog", "pages.read", "pages.save", "pages.release-plan", "pages.release", "pages.change-prepare", "pages.change-apply"
]);

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
function prefixedDocument(document: PageDocument, prefix: string): PageDocument {
  const copy = structuredClone(document);
  copy.body = prefixedNodes(copy.body, prefix);
  if (copy.meta?.favicon?.startsWith("/") && !copy.meta.favicon.startsWith("//")) copy.meta.favicon = `${prefix}${copy.meta.favicon}`;
  if (copy.meta?.ogImage && "src" in copy.meta.ogImage && copy.meta.ogImage.src.startsWith("/") && !copy.meta.ogImage.src.startsWith("//")) {
    copy.meta.ogImage.src = `${prefix}${copy.meta.ogImage.src}`;
  }
  return parsePageDocument(copy);
}
function escapeAttribute(value: string): string { return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }

/** PUBLIC_SITES_ORIGIN でだけ呼ぶ。対象外pathも常に404にして管理originのassetを漏らさない。 */
export async function managedPublicRequest(request: Request, db: ManagedD1, origin: string): Promise<Response> {
  if (new URL(request.url).origin !== origin || request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  const url = new URL(request.url), match = /^\/s\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(.*))?$/u.exec(url.pathname);
  if (!match) return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  const path = match[2] ? `/${match[2]}` : "/";
  if (validatePagePath(path) !== null) return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  const row = await db.prepare(`
    SELECT mp.site_id, mp.page_id, mp.locale, mp.title, mp.path, version.document_json
      FROM managed_sites AS ms
      JOIN managed_pages AS mp ON mp.site_id = ms.site_id
      JOIN managed_page_versions AS version
        ON version.site_id = mp.site_id AND version.page_id = mp.page_id AND version.locale = mp.locale AND version.revision = mp.published_revision
     WHERE ms.slug = ?1 AND mp.path = ?2 AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
     LIMIT 1
  `).bind(match[1]!, path).first<Pick<ManagedPageRow, "site_id" | "page_id" | "locale" | "title" | "path" | "document_json">>();
  if (!row) return new Response(null, { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  if (match[2] === undefined) {
    url.pathname += "/";
    const headers = responseHeaders("text/plain; charset=utf-8");
    headers.set("Location", url.href);
    return new Response(null, { status: 308, headers });
  }
  const document = parsePageDocument(JSON.parse(row.document_json) as unknown), prefix = `/s/${match[1]}`;
  const rendered = prefixedDocument(document, prefix), publicPath = `${prefix}${path}`;
  // PageDocument の path 契約では home は `/`。共有公開prefixは配信層の責務なので、
  // metadata を通常pathで検証してから canonical / og:url だけを実URLへ射影する。
  const resolvedMetadata = resolvePageMetadata({ document: rendered, domain: origin, path: row.path, visibility: "public" });
  const publicUrl = `${origin}${publicPath}`;
  const metadata = {
    ...resolvedMetadata,
    ...(resolvedMetadata.canonical ? { canonical: publicUrl } : {}),
    openGraph: { ...resolvedMetadata.openGraph, url: publicUrl }
  };
  const { renderPageToHtml } = await import("../src/server.js");
  const head = renderPageHead(metadata), content = renderPageToHtml(rendered);
  const html = `<!doctype html><html lang="${escapeAttribute(rendered.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${content}</body></html>`;
  const headers = responseHeaders("text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; media-src https:; font-src https: data:; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}

export async function managedDashboardOverview(db: ManagedD1, actor: ManagedActor, projectId: string, siteId: string, origin: string): Promise<Record<string, unknown> | null> {
  const registration = await db.prepare(`
    SELECT ms.slug,
           (SELECT mp.path FROM managed_pages AS mp
             WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL
             ORDER BY CASE WHEN mp.path = '/' THEN 0 ELSE 1 END, mp.path LIMIT 1) AS published_path,
           (SELECT count(*) FROM managed_pages AS mp WHERE mp.site_id = s.id AND mp.visibility = 'public' AND mp.published_revision IS NOT NULL) AS published_page_count,
           (SELECT max(pub.created_at) FROM managed_page_publications AS pub WHERE pub.site_id = s.id) AS last_published_at
      FROM project_members AS member JOIN sites AS s ON s.project_id = member.project_id JOIN managed_sites AS ms ON ms.site_id = s.id
     WHERE member.access_subject = ?1 AND member.project_id = ?2 AND s.id = ?3 LIMIT 1
  `).bind(actor.subject, projectId, siteId).first<{ readonly slug: string; readonly published_path: string | null; readonly published_page_count: number; readonly last_published_at: number | null }>();
  if (!registration) return null;
  const audit = await db.prepare(`SELECT id, action, page_id, created_at FROM managed_site_audit WHERE site_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20`)
    .bind(siteId).all<{ readonly id: string; readonly action: string; readonly page_id: string | null; readonly created_at: number }>();
  if (!audit.success) throw new Error("managed audit query failed");
  const labels: Record<string, string> = { "site.created": "サイトを作成", "page.created": "ページを作成", "page.saved": "下書きを保存", "page.published": "ページを公開", "page.restored": "公開版を復元", "page.updated": "ページ情報を更新", "page.visibility": "公開範囲を更新" };
  return {
    publicationStatus: registration.published_page_count > 0 ? "published" : "unpublished",
    publishedUrl: registration.published_path ? managedPageUrl(origin, registration.slug, registration.published_path) : null,
    lastPublishedAt: registration.last_published_at === null ? null : new Date(registration.last_published_at * 1000).toISOString(),
    publishedPageCount: registration.published_page_count,
    assetBytes: null,
    recentChanges: (audit.results ?? []).map((entry) => ({ id: `change_${entry.id.replaceAll("-", "")}`, label: `${labels[entry.action] ?? "サイトを更新"}${entry.page_id ? `: ${entry.page_id}` : ""}`, changedAt: new Date(entry.created_at * 1000).toISOString() }))
  };
}
