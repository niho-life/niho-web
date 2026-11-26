import { starterCollection } from "./managed-cms-model.js";
import { parseCmsReleaseAssetManifest, parseCmsRouteTable, type CmsItemRevision, type CmsPublicAsset, type CmsReleasePin, type CmsReleaseSnapshot, type CmsRouteTable, type CmsSchema } from "../src/cms-v2.js";
import type { AssetReference } from "../src/types.js";
import type { ManagedD1 } from "./managed-sites.js";

export type CmsBucket = {
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
  put(key: string, value: string, options: { onlyIf: Headers }): Promise<unknown>;
};
/** Resolve only existing, non-deleted images that the host permits this site to publish. */
export type CmsPublicAssetResolver = (input: {
  readonly siteId: string;
  readonly references: readonly Readonly<AssetReference>[];
}) => Promise<readonly CmsPublicAsset[]>;
export type CmsActor = { readonly id: string; readonly clientId?: string; readonly cli: boolean };
export type CmsCapability = "cms.read" | "cms.edit" | "cms.publish" | "cms.schema.apply";
export type CmsScope = { readonly projectId: string; readonly siteId: string; readonly actor: CmsActor };
export type ItemMeta = CmsReleasePin & { updatedAt: string; removedAt: string | null };
export type CmsState = {
  locale: string;
  schema: CmsSchema;
  items: Record<string, ItemMeta>;
  current: { id: string; at: string } | null;
  routeTableRevision?: string;
  retainedBytes: number;
};
export type Site = CmsScope & { readonly generation: string | null; readonly slug: string; readonly role: "owner" | "editor"; readonly state: CmsState };
export type JobPayload = { keys: readonly string[] } | { releaseId: string; expectedReleaseId: string | null; pins: readonly string[] };
export type Job = {
  id: string; site_id: string; project_id: string; actor_id: string; client_id: string | null;
  kind: "verify" | "release" | "schedule"; payload_json: string; scheduled_at: number; attempts: number;
  state: "pending" | "delivered" | "dead" | "cancelled"; lease_id: string | null;
};

type Receipt = { operation: string; input_digest: string; result_json: string; transaction_id: string };

export const MAX_ITEMS = 25;
export const MAX_BODY = 64 * 1024;
export const MAX_RETAINED_BYTES = 100 * 1024 * 1024;
export const MAX_SNAPSHOT = 2 * 1024 * 1024;
export const opaque = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
export const dateNow = () => iso(nowSeconds());
export const cmsPathReserved = (path: string) => path === "/cms" || path.startsWith("/cms/");
export const blobSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const itemBlobKey = (siteId: string, locale: string, pin: CmsReleasePin) =>
  `sites/${siteId}/items/${locale}/${pin.collectionId}/${pin.itemId}/${pin.revision}.json`;
export const snapshotKey = (siteId: string, releaseId: string) => `sites/${siteId}/releases/${releaseId}.json`;
export const routeTableKey = (siteId: string, locale: string, revision: string) => `sites/${siteId}/routes/${locale}/${revision}.json`;

function initialState(siteId: string, locale: string): CmsState {
  return {
    locale, schema: { contractVersion: 2, siteId, schemaRevision: "initial", collections: [starterCollection()], retiredFields: [] },
    items: {}, current: null, routeTableRevision: "routes_initial", retainedBytes: 0
  };
}

export async function digest(value: unknown): Promise<string> {
  const encoded = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Both paths resolve site and project together. Service tokens require a live grant from a current owner.
const AUTH = `
  FROM sites AS s JOIN managed_sites AS ms ON ms.site_id = s.id
  JOIN project_members AS m ON m.project_id = s.project_id
  LEFT JOIN studio_cli_grants AS g ON g.project_id = s.project_id AND g.site_id = s.id
       AND g.client_id = ?4 AND g.capability = ?5 AND g.delegated_by_subject = m.access_subject
 WHERE s.project_id = ?1 AND s.id = ?2 AND (
       (?4 IS NULL AND m.access_subject = ?3 AND m.role IN ('owner', 'editor') AND (?5 <> 'cms.schema.apply' OR m.role = 'owner'))
    OR (?4 IS NOT NULL AND m.role = 'owner' AND g.client_id IS NOT NULL AND (g.expires_at IS NULL OR g.expires_at > unixepoch()))
 )`;

function scopeValues(scope: CmsScope, capability: CmsCapability) {
  return [scope.projectId, scope.siteId, scope.actor.id, scope.actor.clientId ?? null, capability] as const;
}

export class CmsStore {
  constructor(readonly db: ManagedD1, readonly bucket: CmsBucket, readonly resolvePublicAssets?: CmsPublicAssetResolver) {}

  async site(scope: CmsScope, capability: CmsCapability): Promise<Site | null> {
    const row = await this.db.prepare(`SELECT ms.slug, m.role,
       (SELECT locale FROM managed_pages WHERE site_id = s.id AND page_id = 'home' ORDER BY locale LIMIT 1) AS locale,
       (SELECT generation FROM managed_cms_state WHERE site_id = s.id) AS generation,
       (SELECT state_json FROM managed_cms_state WHERE site_id = s.id) AS state_json
       ${AUTH} LIMIT 1`).bind(...scopeValues(scope, capability))
      .first<{ slug: string; role: Site["role"]; locale: string; generation: string | null; state_json: string | null }>();
    return row ? { ...scope, slug: row.slug, role: row.role, generation: row.generation,
      state: row.state_json === null ? initialState(scope.siteId, row.locale) : JSON.parse(row.state_json) as CmsState } : null;
  }

  async put(key: string, value: unknown) {
    const candidate = JSON.stringify(value);
    if (await this.bucket.put(key, candidate, { onlyIf: new Headers({ "If-None-Match": "*" }) }) !== null) return;
    const existing = await this.bucket.get(key);
    if (existing === null || JSON.stringify(await existing.json()) !== candidate) throw new Error("CMS immutable object collision");
  }

  async item(siteId: string, locale: string, pin: CmsReleasePin): Promise<CmsItemRevision> {
    const object = await this.bucket.get(itemBlobKey(siteId, locale, pin));
    if (!object) throw new Error("CMS revision unavailable");
    const item = await object.json<CmsItemRevision>();
    if (item.siteId !== siteId || item.locale !== locale || item.collectionId !== pin.collectionId || item.itemId !== pin.itemId || item.revision !== pin.revision)
      throw new Error("CMS revision scope mismatch");
    return item;
  }

  async snapshot(siteId: string, releaseId: string): Promise<CmsReleaseSnapshot> {
    const object = await this.bucket.get(snapshotKey(siteId, releaseId));
    if (!object) throw new Error("CMS snapshot unavailable");
    const snapshot = await object.json<CmsReleaseSnapshot>();
    if (snapshot.contractVersion !== 2 || snapshot.siteId !== siteId || snapshot.releaseId !== releaseId || snapshot.schema.siteId !== siteId)
      throw new Error("CMS snapshot scope mismatch");
    return { ...snapshot, assetManifest: parseCmsReleaseAssetManifest(snapshot.schema, snapshot.items, snapshot.assetManifest) };
  }

  async approvedPins(site: Site, pins: readonly CmsReleasePin[]) {
    if (!pins.length) return [];
    const rows = await this.db.prepare(`SELECT revision, collection_id, item_id, locale, schema_revision FROM managed_cms_revisions
       WHERE site_id = ?2 AND revision IN (${pins.map((_, i) => `?${i + 6}`).join(",")})
       AND EXISTS (SELECT 1 ${AUTH})`).bind(...scopeValues(site, "cms.publish"), ...pins.map((pin) => pin.revision)).all<{
        revision: string; collection_id: string; item_id: string; locale: string; schema_revision: string;
      }>();
    if (!rows.success || !rows.results) throw new Error("CMS revision lookup failed");
    return pins.filter((pin) => rows.results!.some((row) => row.revision === pin.revision && row.collection_id === pin.collectionId
      && row.item_id === pin.itemId && row.locale === site.state.locale && row.schema_revision === site.state.schema.schemaRevision));
  }

  async fixedRoutes(site: Site, capability: CmsCapability) {
    const results = await this.db.prepare(`SELECT path FROM managed_pages WHERE site_id = ?2 AND locale = ?6
      AND EXISTS (SELECT 1 ${AUTH})`).bind(...scopeValues(site, capability), site.state.locale).all<{ path: string }>();
    if (!results.success || !results.results) throw new Error("CMS route lookup failed");
    return new Set(results.results.map(({ path }) => path));
  }

  /** Compose the current CMS route snapshot with live, published fixed pages. */
  async routeTable(site: Site, capability: CmsCapability): Promise<CmsRouteTable> {
    let stored: CmsRouteTable | null = null;
    const revision = site.state.routeTableRevision;
    if (revision && revision !== "routes_initial") {
      const object = await this.bucket.get(routeTableKey(site.siteId, site.state.locale, revision));
      if (!object) throw new Error("CMS route table unavailable");
      stored = await object.json<CmsRouteTable>();
    }
    const snapshot = !stored && !revision && site.state.current ? await this.snapshot(site.siteId, site.state.current.id) : null;
    if (!stored && snapshot?.routeTable) stored = snapshot.routeTable;
    const legacyReservations = snapshot ? [
      ...snapshot.items.flatMap((item) => item.path ? [{ kind: "cms-item" as const, path: item.path,
        collectionId: item.collectionId, itemId: item.itemId }] : []),
      ...snapshot.redirects.map(({ from, to }) => ({ kind: "redirect" as const, path: from, targetPath: to, owner: "cms" as const }))
    ] : [];
    const base = stored ?? { siteId: site.siteId, locale: site.state.locale,
      revision: snapshot?.routeTableRevision ?? (snapshot ? `routes_${await digest(legacyReservations)}` : "routes_initial"),
      reservations: legacyReservations };
    const pages = await this.db.prepare(`SELECT page_id, path, visibility, published_revision FROM managed_pages WHERE site_id = ?2 AND locale = ?6
      AND EXISTS (SELECT 1 ${AUTH}) ORDER BY path, page_id`)
      .bind(...scopeValues(site, capability), site.state.locale).all<{ page_id: string; path: string; visibility: string; published_revision: number | null }>();
    if (!pages.success || !pages.results) throw new Error("CMS route lookup failed");
    const fixed = await Promise.all(pages.results.map(async ({ page_id, path, visibility, published_revision }) => ({
      kind: visibility === "public" && published_revision !== null ? "fixed-page" as const : "reserved" as const, path,
      reservationId: `managed_page_${(await digest({ siteId: site.siteId, locale: site.state.locale, page_id, path })).slice(0, 32)}`
    })));
    const withoutOldFixed = base.reservations.filter((reservation) => !((reservation.kind === "fixed-page" || reservation.kind === "reserved")
      && reservation.reservationId.startsWith("managed_page_")));
    const next = parseCmsRouteTable({ siteId: site.siteId, locale: site.state.locale, revision: base.revision,
      reservations: [...withoutOldFixed, ...fixed] }, site.siteId, site.state.locale);
    const unchanged = JSON.stringify(next.reservations) === JSON.stringify(base.reservations);
    return unchanged ? next : parseCmsRouteTable({ ...next, revision: `routes_${await digest(next.reservations)}` }, site.siteId, site.state.locale);
  }

  async receipt(site: Site, capability: CmsCapability, operationId: string) {
    return this.db.prepare(`SELECT operation, input_digest, result_json, transaction_id FROM managed_cms_receipts
      WHERE site_id = ?2 AND actor_id = ?3 AND operation_id = ?6 AND EXISTS (SELECT 1 ${AUTH})`)
      .bind(...scopeValues(site, capability), operationId).first<Receipt>();
  }

  async deliveryForReceipt(site: Site, id: string) {
    return this.db.prepare(`SELECT j.state, j.failure, r.released_at FROM managed_cms_outbox AS j
      LEFT JOIN managed_cms_releases AS r ON r.release_id = j.id AND r.site_id = j.site_id
      WHERE j.site_id = ?2 AND j.actor_id = ?3 AND j.receipt_id = ?6 AND j.kind = 'release' AND EXISTS (SELECT 1 ${AUTH})`)
      .bind(...scopeValues(site, "cms.read"), id).first<{ state: Job["state"]; failure: string | null; released_at: number | null }>();
  }

  async makeToken(site: Site, capability: CmsCapability, purpose: string, payload: unknown, expiresAt: number) {
    const token = opaque("token");
    const result = await this.db.prepare(`INSERT INTO managed_cms_tokens (token_hash, site_id, actor_id, purpose, payload_json, expires_at)
      SELECT ?6, ?2, ?3, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 ${AUTH}) AND
      (SELECT count(*) FROM managed_cms_tokens WHERE site_id = ?2 AND actor_id = ?3 AND purpose = ?7 AND expires_at > unixepoch()) < 100`)
      .bind(...scopeValues(site, capability), await digest(token), purpose, JSON.stringify(payload), expiresAt).all();
    if (!result.success) throw new Error("CMS token write failed");
    return result.meta?.changes === 1 ? token : null;
  }

  async readToken<T>(site: Site, capability: CmsCapability, purpose: string, token: string) {
    const row = await this.db.prepare(`SELECT payload_json, expires_at FROM managed_cms_tokens
      WHERE site_id = ?2 AND actor_id = ?3 AND token_hash = ?6 AND purpose = ?7 AND EXISTS (SELECT 1 ${AUTH})`)
      .bind(...scopeValues(site, capability), await digest(token), purpose).first<{ payload_json: string; expires_at: number }>();
    return row ? { payload: JSON.parse(row.payload_json) as T, expires: row.expires_at } : null;
  }

  async consumePreview(site: Site, token: string, purpose: "preview" | "page-preview" = "preview") {
    const found = await this.db.prepare(`DELETE FROM managed_cms_tokens WHERE token_hash = ?6 AND site_id = ?2
      AND actor_id = ?3 AND purpose = ?8 AND expires_at > unixepoch()
      AND (SELECT generation FROM managed_cms_state WHERE site_id = ?2) IS ?7 AND EXISTS (SELECT 1 ${AUTH}) RETURNING token_hash`)
      .bind(...scopeValues(site, "cms.read"), await digest(token), site.generation, purpose).first<{ token_hash: string }>();
    return found !== null;
  }

  async historicalSnapshot(site: Site, releaseId: string) {
    const row = await this.db.prepare(`SELECT release_id FROM managed_cms_releases
      WHERE site_id = ?2 AND release_id = ?6 AND EXISTS (SELECT 1 ${AUTH})`)
      .bind(...scopeValues(site, "cms.read"), releaseId).first<{ release_id: string }>();
    return row ? this.snapshot(site.siteId, row.release_id) : null;
  }

  async jobs(site: Site, capability: CmsCapability, id?: string) {
    const results = await this.db.prepare(`SELECT id, site_id, actor_id, kind, payload_json, scheduled_at, state
      FROM managed_cms_outbox WHERE site_id = ?2 AND kind IN ('release', 'schedule') AND
      ((?6 IS NULL AND state = 'pending') OR id = ?6) AND EXISTS (SELECT 1 ${AUTH}) ORDER BY scheduled_at, id`)
      .bind(...scopeValues(site, capability), id ?? null).all<Job>();
    if (!results.success || !results.results) throw new Error("CMS job lookup failed");
    return results.results;
  }

  async commit(site: Site, capability: CmsCapability, change: {
    operation: string; operationId: string; inputDigest: string; result: object; state: CmsState;
    revisions?: readonly CmsItemRevision[]; job?: { id: string; kind: Job["kind"]; at: number; payload: JobPayload };
    cancel?: string; tokenHash?: string; requireFreeSlot?: boolean; bindingsGeneration?: number;
  }): Promise<boolean> {
    const transactionId = opaque("tx"), auditGuard = "EXISTS (SELECT 1 FROM managed_cms_receipts WHERE transaction_id = ?1)";
    const { operation, operationId, inputDigest, state, result, job, revisions, cancel } = change;
    const statements = [
      this.db.prepare(`INSERT INTO managed_cms_receipts (site_id, actor_id, operation_id, operation, input_digest, transaction_id, result_json)
        SELECT ?2, ?3, ?6, ?7, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 ${AUTH})
          AND (SELECT generation FROM managed_cms_state WHERE site_id = ?2) IS ?11
          AND (?12 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_outbox WHERE site_id = ?2 AND id = ?12 AND kind = 'schedule' AND state = 'pending'))
          AND (?13 IS NULL OR EXISTS (SELECT 1 FROM managed_cms_tokens WHERE token_hash = ?13 AND site_id = ?2 AND actor_id = ?3 AND expires_at > unixepoch()))
          AND (?14 = 0 OR (SELECT count(*) FROM managed_cms_outbox WHERE site_id = ?2 AND state = 'pending' AND kind IN ('release', 'schedule')) < 25)
          AND (?15 IS NULL OR (SELECT bindings_generation FROM managed_sites WHERE site_id = ?2) = ?15)
        ON CONFLICT(site_id, actor_id, operation_id) DO NOTHING`).bind(...scopeValues(site, capability), operationId, operation,
        inputDigest, transactionId, JSON.stringify(result), site.generation, cancel ?? null, change.tokenHash ?? null, Number(change.requireFreeSlot ?? false), change.bindingsGeneration ?? null),
      this.db.prepare(`INSERT INTO managed_cms_state (site_id, generation, state_json) SELECT ?2, ?1, ?3 WHERE ${auditGuard}
        ON CONFLICT(site_id) DO UPDATE SET generation = excluded.generation, state_json = excluded.state_json`)
        .bind(transactionId, site.siteId, JSON.stringify(state)),
      this.db.prepare(`INSERT INTO managed_cms_audit (id, site_id, actor_id, operation) SELECT ?1, ?2, ?3, ?4 WHERE ${auditGuard}`)
        .bind(transactionId, site.siteId, site.actor.id, operation),
      ...(revisions ?? []).map((item) => this.db.prepare(`INSERT INTO managed_cms_revisions (site_id, revision, collection_id, item_id, locale, schema_revision)
        SELECT ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${auditGuard}`)
        .bind(transactionId, site.siteId, item.revision, item.collectionId, item.itemId, item.locale, item.schemaRevision)),
      this.db.prepare(`INSERT INTO managed_cms_outbox (id, site_id, actor_id, client_id, receipt_id, kind, payload_json, scheduled_at, available_at)
        SELECT ?2, ?3, ?4, ?5, ?1, ?6, ?7, ?8, ?8 WHERE ${auditGuard}`).bind(transactionId, job?.id ?? transactionId,
        site.siteId, site.actor.id, site.actor.clientId ?? null, job?.kind ?? "verify",
        JSON.stringify(job?.payload ?? { keys: (revisions ?? []).map((item) => itemBlobKey(site.siteId, item.locale, item)) }), job?.at ?? nowSeconds())
    ];
    if (cancel) statements.push(this.db.prepare(`UPDATE managed_cms_outbox SET state = 'cancelled', lease_id = NULL, lease_until = NULL
      WHERE id = ?2 AND site_id = ?3 AND ${auditGuard}`).bind(transactionId, cancel, site.siteId));
    const results = await this.db.batch(statements);
    if (results.length !== statements.length || results.some((entry) => !entry.success)) throw new Error("CMS transaction failed");
    return results[0]?.meta?.changes === 1;
  }

  async publish(site: Site, job: Job, snapshot: CmsReleaseSnapshot) {
    await this.put(routeTableKey(site.siteId, snapshot.locale, snapshot.routeTable.revision), snapshot.routeTable);
    const state: CmsState = { ...site.state, current: { id: snapshot.releaseId, at: dateNow() }, routeTableRevision: snapshot.routeTable.revision };
    const generation = opaque("tx");
    const guard = "EXISTS (SELECT 1 FROM managed_cms_state WHERE site_id = ?2 AND generation = ?1)";
    const result = await this.db.batch([
      this.db.prepare(`UPDATE managed_cms_state SET generation = ?6, state_json = ?7 WHERE site_id = ?2 AND generation = ?8
        AND EXISTS (SELECT 1 ${AUTH})
        AND EXISTS (SELECT 1 FROM managed_cms_outbox WHERE site_id = ?2 AND id = ?9 AND state = 'pending' AND lease_id = ?10
          AND lease_until > unixepoch())`).bind(...scopeValues(site, "cms.publish"), generation, JSON.stringify(state), site.generation, job.id, job.lease_id),
      this.db.prepare(`INSERT INTO managed_cms_releases (site_id, release_id) SELECT ?2, ?3 WHERE ${guard}`)
        .bind(generation, site.siteId, snapshot.releaseId),
      this.db.prepare(`INSERT INTO managed_cms_audit (id, site_id, actor_id, operation) SELECT ?1, ?2, ?3, 'cms.release.delivered' WHERE ${guard}`)
        .bind(generation, site.siteId, site.actor.id),
      this.db.prepare(`UPDATE managed_cms_outbox SET state = 'delivered', lease_id = NULL, lease_until = NULL, failure = NULL
        WHERE site_id = ?2 AND id = ?3 AND ${guard}`).bind(generation, site.siteId, job.id)
    ]);
    if (result.length !== 4 || result.some((entry) => !entry.success)) throw new Error("CMS publication transaction failed");
    return result[0]?.meta?.changes === 1;
  }
}
