import { assetKey } from "../src/assets.js";
import { galleryEntries, type CollectionImageValue } from "../src/collection-model.js";
import { revalidateCmsRelease, type CmsProblem, type CmsPublicAsset, type CmsReleaseContext, type CmsReleasePin, type CmsReleaseSnapshot } from "../src/cms-v2.js";
import { cmsItemKey } from "../src/cms-v2-schema.js";
import type { ManagedD1 } from "./managed-sites.js";
import { escapeHtml } from "./managed-cms-model.js";
import {
  CmsStore, MAX_ITEMS, cmsPathReserved, nowSeconds, opaque, type Site, type Job, type JobPayload
} from "./managed-cms-store.js";

export { escapeHtml };

export function collectionPath(prefix: string | null): string | null {
  return prefix === null ? null : prefix.slice(0, -1);
}

export function releaseImpacts(snapshot: CmsReleaseSnapshot, fixedRoutes: Set<string>): CmsProblem[] {
  const listPaths = snapshot.schema.collections.flatMap(({ pathPrefix }) => {
    const path = collectionPath(pathPrefix);
    return path === null ? [] : [path];
  });
  const root = snapshot.sourceLocale && snapshot.sourceLocale !== snapshot.locale ? `/${snapshot.locale}/cms` : "/cms";
  const localized = snapshot.sourceLocale !== undefined && snapshot.sourceLocale !== snapshot.locale;
  const allowedCmsPath = localized
    ? (path: string) => path === root || path.startsWith(`${root}/`)
    : cmsPathReserved;
  const paths = [root, ...listPaths, ...snapshot.items.flatMap(({ path }) => path ? [path] : []), ...snapshot.redirects.map(({ from }) => from)];
  return paths.filter((path, i) => !allowedCmsPath(path) || fixedRoutes.has(path) || paths.indexOf(path) !== i)
    .map((path): CmsProblem => ({ code: "route", path, message: "CMS の一覧・詳細・転送パスが固定ページまたは別の CMS パスと重複しています。" }));
}

export async function releaseContext(store: CmsStore, site: Site, pins: readonly CmsReleasePin[]): Promise<CmsReleaseContext> {
  const [approved, routeTable] = await Promise.all([
    store.approvedPins(site, pins), store.routeTable(site, "cms.publish")
  ]);
  const fixedRoutes = new Set(routeTable.reservations.flatMap((entry) =>
    entry.kind === "fixed-page" || (entry.kind === "reserved" && !entry.reservationId.startsWith("cms_route_")) ? [entry.path] : []));
  const revisions = new Map(await Promise.all(approved.map(async (pin) =>
    [pin.revision, await store.item(site.siteId, site.state.locale, pin)] as const)));
  const publicAssets = await store.publicAssets(site.state.schema, [...revisions.values()]);
  return {
    schema: site.state.schema, locale: site.state.locale, currentReleaseId: site.state.current?.id ?? null,
    routeTable, publicAssets,
    readRevision: (pin) => revisions.get(pin.revision),
    isRemoved: (pin) => !site.state.items[cmsItemKey(pin)] || site.state.items[cmsItemKey(pin)]!.removedAt !== null,
    impact: (snapshot) => releaseImpacts(snapshot, fixedRoutes),
    // Worker runs without a DOM parser. This initial renderer preserves rich text as inert text.
    publicRichText: ({ html }) => escapeHtml(html)
  };
}

const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 60;
const REQUEST_JOB_BUDGET = 45;
const MAX_JOB_BUDGET = 10 + MAX_ITEMS;

// Keep request-time delivery small; Cron can verify the full maximum item set in one bounded pass.
const JOB_COST = `CASE kind WHEN 'verify' THEN 3 + json_array_length(payload_json, '$.keys')
                     ELSE 10 + json_array_length(payload_json, '$.pins') END`;
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
      const { releaseId, expectedReleaseId } = JSON.parse(job.payload_json) as Extract<JobPayload, { releaseId: string }>;
      const site = await store.site({
        siteId: job.site_id, projectId: job.project_id,
        actor: { id: job.actor_id, cli: job.client_id !== null, ...(job.client_id === null ? {} : { clientId: job.client_id }) }
      }, "cms.publish");
      if (!site || (site.state.current?.id ?? null) !== expectedReleaseId) {
        outcome = "conflict";
      } else {
        const snapshot = await store.snapshot(site.siteId, releaseId);
        if (snapshot.schema.schemaRevision !== site.state.schema.schemaRevision) {
          outcome = "conflict";
        } else {
          // Scheduled releases recheck their pins. Any release with assets also rechecks public eligibility before switching the pointer.
          const valid = job.kind === "schedule" || snapshot.assetManifest.length > 0
            ? revalidateCmsRelease({ expectedReleaseId, snapshot }, await releaseContext(store, site, snapshot.items)).status === "allowed"
            : snapshot.items.every((pin) => site.state.items[cmsItemKey(pin)]?.removedAt === null)
              && releaseImpacts(snapshot, await store.fixedRoutes(site, "cms.publish")).length === 0;
          if (!valid) outcome = "conflict";
          else if (await store.publish(site, job, snapshot)) return job.cost;
          else outcome = "unavailable";
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
  for (let index = 0; index < 4 && budget >= 3; index++) {
    const cost = await deliverCmsJob(store, null, at, budget);
    if (cost === 0) break;
    budget -= cost;
  }
}

export function previewContent(schema: CmsReleaseSnapshot["schema"], item: CmsReleaseSnapshot["items"][number]) {
  const collection = schema.collections.find(({ id }) => id === item.collectionId)!;
  const title = String(item.values[collection.titleField] ?? "");
  const text = collection.fields.filter(({ fieldId, type }) => fieldId !== collection.titleField && fieldId !== collection.slugField
    && ["text", "longText", "richText", "datetime"].includes(type));
  return { title, fields: text.map((field) => ({ label: field.label, text: String(item.values[field.fieldId] ?? "") })) };
}

const publicHeaders = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

function publicImage(image: CollectionImageValue | null, assets: ReadonlyMap<string, CmsPublicAsset>): string {
  const asset = image === null || typeof image === "string" ? undefined : assets.get(assetKey(image));
  if (!asset) return "";
  const width = asset.width === null ? "" : ` width="${asset.width}"`;
  const height = asset.height === null ? "" : ` height="${asset.height}"`;
  return `<img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.altText)}"${width}${height}>`;
}

export async function managedCmsPublic(request: Request, store: CmsStore, origin: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin !== origin || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const match = /^\/s\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(ja|en))?(\/cms(?:\/[a-z0-9_-]+)*)$/u.exec(url.pathname);
  if (!match) return null;
  const [, slug, prefixedLocale, cmsPath] = match, prefix = `/s/${slug}`;
  const current = await store.db.prepare(`SELECT ms.site_id, c.state_json
    FROM managed_cms_state AS c JOIN managed_sites AS ms ON ms.site_id = c.site_id WHERE ms.slug = ?1`)
    .bind(slug).first<{ site_id: string; state_json: string }>();
  if (!current) return null;
  const state = JSON.parse(current.state_json) as Site["state"];
  const locale = prefixedLocale ?? state.locale;
  if (prefixedLocale === state.locale) return null;
  const published = locale === state.locale ? state.current : state.localizedReleases?.[locale] ?? null;
  if (!published) return null;
  const routePath = prefixedLocale ? `/${prefixedLocale}${cmsPath}` : cmsPath;
  const snapshot = await store.snapshot(current.site_id, published.id);
  const redirect = snapshot.redirects.find(({ from }) => from === routePath);
  if (redirect) return new Response(null, { status: 308, headers: { ...publicHeaders, Location: `${prefix}${redirect.to}` } });
  const entry = snapshot.items.find((item) => item.path === routePath);
  const collection = snapshot.schema.collections.find(({ pathPrefix }) => collectionPath(pathPrefix) === routePath);
  let title: string, body: string;
  if (entry) {
    const presentation = previewContent(snapshot.schema, entry);
    title = presentation.title;
    const definition = snapshot.schema.collections.find(({ id }) => id === entry.collectionId)!;
    const assets = new Map(snapshot.assetManifest.map((asset) => [assetKey(asset.reference), asset] as const));
    body = definition.fields.filter(({ fieldId }) => fieldId !== definition.titleField && fieldId !== definition.slugField)
      .map(({ fieldId, type }) => {
        const value = entry.values[fieldId];
        if (type === "image" && value && typeof value === "object" && "provider" in value) return publicImage(value, assets);
        if (type === "gallery") return galleryEntries(value).map(({ image, caption }) => {
          const rendered = publicImage(image, assets);
          return rendered ? `<figure>${rendered}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>` : "";
        }).join("");
        if (typeof value !== "string" || !["text", "longText", "richText", "datetime"].includes(type)) return "";
        return `<p>${type === "richText" ? value : escapeHtml(value).replaceAll("\n", "<br>")}</p>`;
      }).join("");
  } else if (routePath === (snapshot.sourceLocale && snapshot.sourceLocale !== snapshot.locale ? `/${snapshot.locale}/cms` : "/cms") || collection) {
    title = collection?.label ?? "CMS";
    const links = collection
      ? snapshot.items.filter((item) => item.collectionId === collection.id && item.path).map((item) =>
        ({ path: item.path!, title: String(item.values[collection.titleField] ?? "") }))
      : snapshot.schema.collections.flatMap((item) => {
        const path = collectionPath(item.pathPrefix);
        return path ? [{ path, title: item.label }] : [];
      });
    body = `<ul>${links.map((link) => `<li><a href="${escapeHtml(prefix + link.path)}">${escapeHtml(link.title)}</a></li>`).join("")}</ul>`;
  } else return null;
  const content = `<!doctype html><html lang="${escapeHtml(snapshot.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(request.method === "HEAD" ? null : content, { headers: publicHeaders });
}
