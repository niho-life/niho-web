import { parseSiteStyles, type SiteStyles, type SiteStylesSnapshot } from "../src/site-styles.js";
import { renameSiteStyle, type EditingSiteStylesEditRequest, type EditingSiteStylesHostAdapter, type EditingSiteStylesPublishRequest,
  type EditingSiteStylesPublishResult } from "../src/editing-site-styles.js";
import type { CmsStore } from "./managed-cms-store.js";
import type { ManagedActor, ManagedD1 } from "./managed-sites.js";
import { readPageSource, type PageSourceRow } from "./managed-page-source.js";

const INITIAL_VERSION = "initial";
const MAX_STYLE_BYTES = 256 * 1024;
const MAX_RETAINED_STYLE_BYTES = 100 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const VERSION = /^style\.[0-9a-f-]{36}$/u;
const EMPTY_STYLES: SiteStyles = Object.freeze({});

type StyleState = {
  readonly draft_version: string;
  readonly draft_key: string | null;
  readonly draft_digest: string | null;
  readonly published_version: string;
  readonly published_key: string | null;
  readonly published_digest: string | null;
  readonly retained_bytes: number;
};

type Access = { readonly projectId: string; readonly siteId: string; readonly actor: ManagedActor; readonly capabilities: readonly string[] };

function styleKey(siteId: string, version: string): string {
  return `sites/${encodeURIComponent(siteId)}/site-styles/${version}.json`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function statePointer(siteId: string, version: string, key: string | null, digest: string | null): { version: string; key: string | null; digest: string | null } {
  if (version === INITIAL_VERSION) {
    if (key !== null || digest !== null) throw new Error("invalid initial site style pointer");
    return { version, key, digest };
  }
  if (!VERSION.test(version) || key !== styleKey(siteId, version) || !digest || !DIGEST.test(digest)) throw new Error("invalid site style pointer");
  return { version, key, digest };
}

function accessSql(access: Access, alias: string, start: number): { readonly sql: string; readonly values: readonly unknown[] } {
  const project = `?${start}`, subject = `?${start + 1}`, client = `?${start + 2}`;
  const grants = access.capabilities.map((capability) => `EXISTS (
    SELECT 1 FROM studio_cli_grants AS style_grant
     WHERE style_grant.site_id = ${alias}.site_id AND style_grant.project_id = style_site.project_id
       AND style_grant.delegated_by_subject = style_member.access_subject AND style_grant.client_id = ${client}
       AND style_grant.capability = '${capability}'
       AND (style_grant.expires_at IS NULL OR style_grant.expires_at > unixepoch())
  )`).join(" AND ");
  return {
    sql: `EXISTS (
      SELECT 1 FROM managed_sites AS style_managed
      JOIN sites AS style_site ON style_site.id = style_managed.site_id
      JOIN project_members AS style_member ON style_member.project_id = style_site.project_id
       WHERE style_managed.site_id = ${alias}.site_id AND style_site.project_id = ${project}
         AND style_member.access_subject = ${subject} AND style_member.role IN ('owner', 'editor')
         AND (${client} IS NULL OR (style_member.role = 'owner' AND ${grants}))
    )`,
    values: [access.projectId, access.actor.subject, access.actor.cliClientId ?? null]
  };
}

async function scopedState(db: ManagedD1, access: Access): Promise<StyleState | null> {
  const scope = accessSql(access, "managed_site_styles", 2);
  return db.prepare(`SELECT draft_version, draft_key, draft_digest, published_version, published_key, published_digest, retained_bytes
    FROM managed_site_styles WHERE site_id = ?1 AND ${scope.sql} LIMIT 1`)
    .bind(access.siteId, ...scope.values).first<StyleState>();
}

async function readPointer(store: CmsStore, siteId: string, version: string, key: string | null, digest: string | null): Promise<SiteStyles> {
  const pointer = statePointer(siteId, version, key, digest);
  if (pointer.key === null) return parseSiteStyles(EMPTY_STYLES);
  const object = await store.bucket.get(pointer.key);
  if (!object) throw new Error("managed site styles unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > MAX_STYLE_BYTES || await sha256(bytes) !== pointer.digest) throw new Error("managed site styles digest mismatch");
  const styles = parseSiteStyles(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as SiteStyles);
  if (new TextEncoder().encode(JSON.stringify(styles)).byteLength > MAX_STYLE_BYTES) throw new Error("managed site styles exceed size limit");
  return styles;
}

async function snapshotFromState(store: CmsStore, siteId: string, state: StyleState): Promise<SiteStylesSnapshot> {
  const draftPointer = statePointer(siteId, state.draft_version, state.draft_key, state.draft_digest);
  const publishedPointer = statePointer(siteId, state.published_version, state.published_key, state.published_digest);
  const draft = await readPointer(store, siteId, draftPointer.version, draftPointer.key, draftPointer.digest);
  const published = draftPointer.version === publishedPointer.version && draftPointer.key === publishedPointer.key
    ? draft : await readPointer(store, siteId, publishedPointer.version, publishedPointer.key, publishedPointer.digest);
  return { draft: { version: draftPointer.version, styles: draft }, published: { version: publishedPointer.version, styles: published } };
}

export async function readManagedSiteStyles(store: CmsStore, siteId: string): Promise<SiteStylesSnapshot> {
  const state = await store.db.prepare(`SELECT draft_version, draft_key, draft_digest, published_version, published_key, published_digest, retained_bytes
    FROM managed_site_styles WHERE site_id = ?1 LIMIT 1`).bind(siteId).first<StyleState>();
  if (!state) throw new Error("managed site styles unavailable");
  return snapshotFromState(store, siteId, state);
}

export async function readManagedPublishedSiteStyles(store: CmsStore, siteId: string): Promise<SiteStyles> {
  return (await readManagedSiteStyles(store, siteId)).published.styles;
}

function containsReference(value: unknown, styleKind: "token" | "textStyle", name: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsReference(entry, styleKind, name));
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (styleKind === "token" && Object.keys(source).length === 1 && source.token === name) return true;
  if (styleKind === "textStyle" && source.textStyle === name) return true;
  return Object.values(source).some((entry) => containsReference(entry, styleKind, name));
}

async function pageUsages(store: CmsStore, access: Access, styleKind: "token" | "textStyle", name: string, styles: SiteStyles) {
  const scope = accessSql(access, "page", 2);
  const rows = await store.db.prepare(`SELECT DISTINCT page.site_id, page.page_id, page.locale, page.path,
      version.revision, version.document_json, version.document_key, version.document_digest
    FROM managed_pages AS page
    JOIN managed_page_versions AS version ON version.site_id = page.site_id AND version.page_id = page.page_id AND version.locale = page.locale
      AND (version.revision = page.current_revision OR version.revision = page.published_revision)
    WHERE page.site_id = ?1 AND ${scope.sql} ORDER BY page.page_id, page.locale, version.revision LIMIT 10001`)
    .bind(access.siteId, ...scope.values).all<PageSourceRow & { readonly path: string }>();
  if (!rows.success || !rows.results || rows.results.length > 10000) throw new Error("managed site style usage lookup failed");
  const usages = new Map<string, { readonly kind: "page"; readonly id: string; readonly locale: string; readonly path: string }>();
  for (const row of rows.results) {
    const document = await readPageSource(store, row, styles);
    if (containsReference(document, styleKind, name)) {
      const key = `${row.page_id}\u0000${row.locale}`;
      usages.set(key, { kind: "page", id: row.page_id, locale: row.locale, path: row.path });
    }
  }
  return [...usages.values()];
}

function applyEdits(current: SiteStyles, input: EditingSiteStylesEditRequest): { readonly styles: SiteStyles; readonly changed: boolean } {
  let styles: SiteStyles = parseSiteStyles(current);
  for (const edit of input.edits) {
    if (edit.type === "set") {
      if (edit.styleKind === "token") {
        const before = styles.tokens?.[edit.name];
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(edit.value)) continue;
        styles = { ...styles, tokens: { ...styles.tokens, [edit.name]: edit.value } };
      } else {
        const before = styles.textStyles?.[edit.name];
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(edit.value)) continue;
        styles = { ...styles, textStyles: { ...styles.textStyles, [edit.name]: edit.value } };
      }
      continue;
    }
    if (edit.type === "rename") {
      styles = renameSiteStyle(styles, edit.styleKind, edit.from, edit.to);
      continue;
    }
    if (edit.styleKind === "token") {
      if (!styles.tokens || !Object.hasOwn(styles.tokens, edit.name)) throw new Error("site style does not exist");
      const tokens = { ...styles.tokens };
      delete tokens[edit.name];
      styles = { ...styles, tokens };
    } else {
      if (!styles.textStyles || !Object.hasOwn(styles.textStyles, edit.name)) throw new Error("site style does not exist");
      const textStyles = { ...styles.textStyles };
      delete textStyles[edit.name];
      styles = { ...styles, textStyles };
    }
  }
  return { styles, changed: JSON.stringify(styles) !== JSON.stringify(current) };
}

async function putStyles(store: CmsStore, siteId: string, styles: SiteStyles): Promise<{ readonly version: string; readonly key: string; readonly digest: string; readonly bytes: number }> {
  const json = JSON.stringify(parseSiteStyles(styles)), bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_STYLE_BYTES) throw new Error("managed site styles exceed size limit");
  const version = `style.${crypto.randomUUID()}`, key = styleKey(siteId, version), digest = await sha256(bytes);
  if (await store.bucket.put(key, json, { onlyIf: new Headers({ "If-None-Match": "*" }) }) === null) {
    const existing = await store.bucket.get(key);
    const stored = existing && new Uint8Array(await existing.arrayBuffer());
    if (!stored || stored.length !== bytes.length || stored.some((byte, index) => byte !== bytes[index])) throw new Error("managed site styles immutable object collision");
  }
  return { version, key, digest, bytes: bytes.byteLength };
}

export function managedSiteStylesAdapter(store: CmsStore, projectId: string,
  publishSiteStyles: (actor: ManagedActor, siteId: string, input: EditingSiteStylesPublishRequest) => Promise<EditingSiteStylesPublishResult>): EditingSiteStylesHostAdapter<ManagedActor> {
  const accessFor = (actor: ManagedActor, siteId: string, capabilities: readonly string[]): Access => ({ projectId, siteId, actor, capabilities });
  return {
    async read(actor, siteId) {
      const state = await scopedState(store.db, accessFor(actor, siteId, ["site.settings.read"]));
      return state ? snapshotFromState(store, siteId, state) : null;
    },
    async edit(actor, siteId, input) {
      const access = accessFor(actor, siteId, ["site.settings.write"]);
      const state = await scopedState(store.db, access);
      if (!state) throw new Error("managed site styles unavailable");
      if (state.draft_version !== input.expectedVersion) return { status: "conflict" };
      const current = await readPointer(store, siteId, state.draft_version, state.draft_key, state.draft_digest);
      for (const edit of input.edits) if (edit.type === "delete" || edit.type === "rename") {
        const usages = await pageUsages(store, access, edit.styleKind, edit.type === "delete" ? edit.name : edit.from, current);
        if (usages.length) return { status: "referenced", usages };
      }
      const applied = applyEdits(current, input);
      if (!applied.changed) return { status: "conflict" };
      for (const edit of input.edits) if (edit.type === "delete" && edit.styleKind === "token") {
        const styleUsages = Object.entries(applied.styles.textStyles ?? {}).filter(([, style]) => containsReference(style, "token", edit.name))
          .map(([styleName]) => ({ kind: "siteStyle" as const, id: siteId, path: `textStyles.${styleName}` }));
        if (styleUsages.length) return { status: "referenced", usages: styleUsages };
      }
      const styles = parseSiteStyles(applied.styles);
      const object = await putStyles(store, siteId, styles);
      if (state.retained_bytes + object.bytes > MAX_RETAINED_STYLE_BYTES) throw new Error("managed site styles retained size limit exceeded");
      const scope = accessSql(access, "managed_site_styles", 8);
      const result = await store.db.prepare(`UPDATE managed_site_styles
        SET draft_version = ?1, draft_key = ?2, draft_digest = ?3, retained_bytes = retained_bytes + ?4,
            updated_at = unixepoch(), updated_by_subject = ?5
        WHERE site_id = ?6 AND draft_version = ?7 AND retained_bytes + ?4 <= ${MAX_RETAINED_STYLE_BYTES} AND ${scope.sql}`)
        .bind(object.version, object.key, object.digest, object.bytes, actor.subject, siteId, input.expectedVersion, ...scope.values).all();
      if (!result.success) throw new Error("managed site style update failed");
      if (result.meta?.changes !== 1) return { status: "conflict" };
      return { status: "saved", version: object.version, styles };
    },
    publish: publishSiteStyles
  };
}

