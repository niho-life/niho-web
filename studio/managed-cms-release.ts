import { revalidateCmsRelease, type CmsProblem, type CmsReleaseContext, type CmsReleasePin, type CmsReleaseSnapshot, type CmsRouteTable } from "../src/cms-v2.js";
import { cmsItemKey } from "../src/cms-v2-schema.js";
import { cmsLocalizedSchema } from "./managed-cms-localization.js";
import { prepareManagedCmsPublication, type ManagedD1 } from "./managed-sites.js";
import { escapeHtml } from "./managed-cms-model.js";
import { cmsCollectionPath as collectionPath, previewCmsContent as previewContent } from "./managed-cms-static.js";
import {
  CmsStore, MAX_ITEMS, cmsPathReserved, nowSeconds, opaque, type Site, type Job, type JobPayload
} from "./managed-cms-store.js";

export { escapeHtml };

export { collectionPath, previewContent };

export function releaseImpacts(snapshot: CmsReleaseSnapshot, currentRoutes: CmsRouteTable): CmsProblem[] {
  const listPaths = snapshot.schema.collections.flatMap(({ pathPrefix }) => {
    const path = collectionPath(pathPrefix);
    return path === null ? [] : [path];
  });
  const root = snapshot.sourceLocale && snapshot.sourceLocale !== snapshot.locale ? `/${snapshot.locale}/cms` : "/cms";
  const localized = snapshot.sourceLocale !== undefined && snapshot.sourceLocale !== snapshot.locale;
  const allowedCmsPath = localized
    ? (path: string) => path === root || path.startsWith(`${root}/`)
    : cmsPathReserved;
  const fixedRoutes = new Set<string>(), priorCmsPaths = new Set<string>();
  for (const entry of currentRoutes.reservations) {
    if (entry.kind === "cms-item" || entry.kind === "redirect" && entry.owner === "cms") priorCmsPaths.add(entry.path);
    else if (entry.kind !== "reserved" || !entry.reservationId.startsWith("cms_route_")) fixedRoutes.add(entry.path);
  }
  const explicitCollections = new Set(snapshot.schema.collections.filter(({ pathField }) => pathField).map(({ id }) => id));
  const explicitItemPaths = new Set<string>();
  const paths = [root, ...listPaths].map((path) => ({ path, allowed: allowedCmsPath(path) }));
  for (const { path, collectionId } of snapshot.items) {
    if (path === null) continue;
    if (explicitCollections.has(collectionId)) explicitItemPaths.add(path);
    paths.push({ path, allowed: explicitItemPaths.has(path) || allowedCmsPath(path) });
  }
  paths.push(...snapshot.redirects.map(({ from, to }) => ({ path: from,
    allowed: allowedCmsPath(from) || explicitItemPaths.has(to) || priorCmsPaths.has(from) })));
  const seen = new Set<string>();
  return paths.flatMap(({ path, allowed }): CmsProblem[] => {
    const invalid = !allowed || fixedRoutes.has(path) || seen.has(path);
    seen.add(path);
    return invalid ? [{ code: "route", path, message: "CMS の一覧・詳細・転送パスが固定ページまたは別の CMS パスと重複しています。" }] : [];
  });
}

export async function releaseContext(store: CmsStore, site: Site, pins: readonly CmsReleasePin[]): Promise<CmsReleaseContext> {
  const [approved, routeTable] = await Promise.all([
    store.approvedPins(site, pins), store.routeTable(site, "cms.publish")
  ]);
  const revisions = new Map(await Promise.all(approved.map(async (pin) =>
    [pin.revision, await store.item(site.siteId, site.state.locale, pin)] as const)));
  const publicAssets = await store.publicAssets(site.state.schema, [...revisions.values()]);
  return {
    schema: site.state.schema, locale: site.state.locale, currentReleaseId: site.state.current?.id ?? null,
    routeTable, publicAssets,
    readRevision: (pin) => revisions.get(pin.revision),
    isRemoved: (pin) => !site.state.items[cmsItemKey(pin)] || site.state.items[cmsItemKey(pin)]!.removedAt !== null,
    impact: (snapshot) => releaseImpacts(snapshot, routeTable),
    // Worker runs without a DOM parser. This initial renderer preserves rich text as inert text.
    publicRichText: ({ html }) => escapeHtml(html)
  };
}

const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 60;
const RELEASE_JOB_OVERHEAD = 10;
const REQUEST_JOB_BUDGET = 45;
const MAX_JOB_BUDGET = RELEASE_JOB_OVERHEAD + MAX_ITEMS;

// Keep request-time delivery small; Cron can verify the full maximum item set in one bounded pass.
const JOB_COST = `CASE kind WHEN 'verify' THEN 3 + json_array_length(payload_json, '$.keys')
                     ELSE ${RELEASE_JOB_OVERHEAD} + json_array_length(payload_json, '$.pins') END`;

async function localizedReleaseContext(store: CmsStore, site: Site, snapshot: CmsReleaseSnapshot): Promise<CmsReleaseContext> {
  const [routeTable, revisions] = await Promise.all([
    store.routeTable(site, "cms.publish", snapshot.locale),
    Promise.all(snapshot.items.map((pin) => store.item(site.siteId, snapshot.locale, pin)))
  ]);
  const revisionByKey = new Map(revisions.map((item) => [cmsItemKey(item), item]));
  return { schema: cmsLocalizedSchema(site.state.schema, snapshot.locale), locale: snapshot.locale, sourceLocale: site.state.locale,
    currentReleaseId: site.state.localizedReleases?.[snapshot.locale]?.id ?? null, routeTable,
    publicAssets: await store.publicAssets(snapshot.schema, revisions), readRevision: (pin) => revisionByKey.get(cmsItemKey(pin)),
    isRemoved: (pin) => !site.state.items[cmsItemKey(pin)] || site.state.items[cmsItemKey(pin)]!.removedAt !== null,
    impact: (candidate) => releaseImpacts(candidate, routeTable), publicRichText: ({ html }) => escapeHtml(html) };
}

async function claim(db: ManagedD1, id: string | null, at: number, budget: number) {
  const lease = opaque("lease");
  return db.prepare(`UPDATE managed_cms_outbox SET lease_id = ?1, lease_until = ?2, attempts = attempts + 1
    WHERE id = (SELECT id FROM managed_cms_outbox WHERE (?3 IS NULL OR id = ?3) AND state = 'pending'
      AND available_at <= ?4 AND (lease_until IS NULL OR lease_until <= ?4) AND (${JOB_COST}) <= ?5
      ORDER BY available_at, id LIMIT 1)
    RETURNING *, (${JOB_COST}) AS cost, (SELECT project_id FROM sites WHERE id = site_id) AS project_id`)
    .bind(lease, at + LEASE_SECONDS, id, at, budget).first<Job & { cost: number }>();
}

async function endAttempt(store: CmsStore, job: Job, at: number, outcome: "verified" | "conflict" | "unavailable") {
  const state = outcome === "verified" ? "delivered" : outcome === "conflict" || job.attempts >= MAX_ATTEMPTS ? "dead" : "pending";
  const next = at + Math.min(15 * 60, 2 ** job.attempts * 15);
  const result = await store.db.prepare(`UPDATE managed_cms_outbox SET state = ?3, available_at = ?4, lease_until = NULL, lease_id = NULL, failure = ?5
    WHERE id = ?1 AND lease_id = ?2 AND state = 'pending'`)
    .bind(job.id, job.lease_id, state, next, outcome === "verified" ? null : outcome).all();
  if (!result.success) throw new Error("CMS job acknowledgement failed");
}

/** Local publication has no network side effect: the immutable snapshot and its D1 pointer are the delivery. */
export async function deliverCmsJob(store: CmsStore, id: string | null = null, at = nowSeconds(), budget = REQUEST_JOB_BUDGET): Promise<number> {
  const job = await claim(store.db, id, at, budget);
  if (!job) return 0;
  if (job.attempts > MAX_ATTEMPTS) {
    await endAttempt(store, job, at, "unavailable");
    return job.cost;
  }
  let outcome: "verified" | "conflict" | "unavailable";
  try {
    if (job.kind === "verify") {
      const { keys } = JSON.parse(job.payload_json) as Extract<JobPayload, { keys: unknown }>;
      if ((await Promise.all(keys.map((key) => store.bucket.get(key)))).some((object) => object === null)) throw new Error("CMS outbox revision unavailable");
      outcome = "verified";
    } else {
      const payload = JSON.parse(job.payload_json) as Extract<JobPayload, { releaseId: string }>;
      const { releaseId, expectedReleaseId } = payload;
      const site = await store.site({
        siteId: job.site_id, projectId: job.project_id,
        actor: { id: job.actor_id, cli: job.client_id !== null, ...(job.client_id === null ? {} : { clientId: job.client_id }) }
      }, "cms.publish");
      const locale = payload.locale ?? site?.state.locale;
      const currentRelease = site && locale === site.state.locale ? site.state.current : site?.state.localizedReleases?.[locale!];
      const sourceReleaseChanged = site && Object.hasOwn(payload, "sourceReleaseId")
        && (site.state.current?.id ?? null) !== payload.sourceReleaseId;
      if (!site || !locale || (currentRelease?.id ?? null) !== expectedReleaseId || sourceReleaseChanged) {
        outcome = "conflict";
      } else {
        const snapshot = await store.snapshot(site.siteId, releaseId);
        if (snapshot.locale !== locale || snapshot.schema.schemaRevision !== site.state.schema.schemaRevision) {
          outcome = "conflict";
        } else {
          // Scheduled releases recheck their pins. Any release with assets also rechecks public eligibility before switching the pointer.
          const context = snapshot.locale === site.state.locale
            ? await releaseContext(store, site, snapshot.items) : await localizedReleaseContext(store, site, snapshot);
          const valid = job.kind === "schedule" || snapshot.assetManifest.length > 0
            ? revalidateCmsRelease({ expectedReleaseId, snapshot }, context).status === "allowed"
            : snapshot.items.every((pin) => context.isRemoved(pin) === false)
              && context.impact?.(snapshot)?.length === 0;
          if (!valid) outcome = "conflict";
          else {
            const staticPublication = await prepareManagedCmsPublication(store, site, snapshot);
            if (await store.publish(site, job, snapshot, staticPublication)) return job.cost;
            outcome = "unavailable";
          }
        }
      }
    }
  } catch {
    outcome = "unavailable";
  }
  await endAttempt(store, job, at, outcome);
  return job.cost;
}

export async function runCmsCron(store: CmsStore) {
  const at = nowSeconds();
  await store.db.prepare("DELETE FROM managed_cms_tokens WHERE expires_at <= ?1").bind(at).all();
  // Only one leased job is worked at a time. The lease also recovers an interrupted invocation.
  let budget = MAX_JOB_BUDGET;
  while (budget >= 3) {
    const cost = await deliverCmsJob(store, null, at, budget);
    if (cost === 0) break;
    budget -= cost;
  }
}
