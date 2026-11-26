import {
  CMS_DELIVERY_EVENT_LIMIT, CMS_DELIVERY_HEADERS, CMS_DELIVERY_JSON_BYTES, CMS_DELIVERY_RENDERER_VERSION, CMS_DELIVERY_SNAPSHOT_BYTES,
  cmsDeliveryCredentialId, cmsDeliveryEtag, cmsDeliveryHash, cmsDeliveryJson, cmsDeliverySequence, cmsDeliverySitePath,
  isCmsDeliveryJson, parseCmsDeliveryAck, parseCmsDeliveryEvent, parseCmsDeliverySnapshot, readCmsDeliveryBytes, signCmsDeliveryRequest,
  type CmsDeliveryAck, type CmsDeliveryEvent
} from "./cms-delivery-contract.js";
import type { CmsReleaseEntry, CmsReleaseSnapshot } from "./cms-v2-release.js";
import { cmsArray, cmsId } from "./cms-v2-schema.js";
import { fail, keys, localeCode, record } from "./validation-utils.js";

export { CMS_DELIVERY_RENDERER_VERSION, type CmsDeliveryAck, type CmsDeliveryEvent };
export type CmsDeliverySnapshot = {
  readonly snapshot: CmsReleaseSnapshot;
  readonly snapshotDigest: string;
  readonly rendererContractVersion: typeof CMS_DELIVERY_RENDERER_VERSION;
  readonly etag: string;
};

export type CmsDeliveryCacheEntry = { readonly etag: string; readonly body: string };
export type CmsDeliveryCache = {
  read(key: string): Promise<CmsDeliveryCacheEntry | null>;
  write(key: string, snapshot: CmsDeliveryCacheEntry): Promise<void>;
};
export type CmsDeliveryClientOptions = {
  readonly origin: string;
  readonly siteId: string;
  readonly credentialId: string;
  readonly secret: string;
  readonly rendererContractVersion: number;
  readonly cache?: CmsDeliveryCache;
  readonly fetch?: typeof fetch;
};

function verifyRenderer(version: unknown) {
  if (version !== CMS_DELIVERY_RENDERER_VERSION) fail("rendererContractVersion", "unsupported CMS renderer version");
}

export function createCmsDeliveryClient(options: CmsDeliveryClientOptions) {
  const origin = new URL(options.origin), sitePath = cmsDeliverySitePath(options.siteId);
  if (origin.protocol !== "https:" || origin.origin !== options.origin) fail("origin", "expected an exact HTTPS origin");
  verifyRenderer(options.rendererContractVersion);
  const { siteId, secret, cache } = options, credentialId = cmsDeliveryCredentialId(options.credentialId);
  const send = options.fetch ?? globalThis.fetch;

  async function request(method: "GET" | "POST", path: string, body: string | null, etag?: string) {
    const timestamp = String(Math.floor(Date.now() / 1000)), headers = new Headers({ Accept: "application/json",
      [CMS_DELIVERY_HEADERS.credential]: credentialId, [CMS_DELIVERY_HEADERS.timestamp]: timestamp,
      [CMS_DELIVERY_HEADERS.signature]: await signCmsDeliveryRequest(secret, { method, siteId, path, timestamp, credentialId, body: body ?? "" }) });
    if (etag !== undefined) headers.set("If-None-Match", etag);
    if (body !== null) headers.set("Content-Type", "application/json");
    const response = await send(new URL(path, origin), {
      method, headers, body, cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000)
    });
    if (response.redirected) throw new Error("CMS delivery redirected");
    return response;
  }

  async function verifySnapshot(bytes: Uint8Array<ArrayBuffer>, etag: string | null, locale: string, releaseId?: string): Promise<CmsDeliverySnapshot> {
    const snapshotDigest = await cmsDeliveryHash(bytes);
    if (etag !== cmsDeliveryEtag(snapshotDigest)) throw new Error("CMS snapshot digest does not match its ETag");
    const snapshot = parseCmsDeliverySnapshot(cmsDeliveryJson(bytes), siteId, locale);
    if (releaseId !== undefined && snapshot.releaseId !== releaseId) throw new Error("CMS snapshot release mismatch");
    return { snapshot, snapshotDigest, rendererContractVersion: CMS_DELIVERY_RENDERER_VERSION, etag };
  }

  return {
    /** For build-time use. An unavailable Studio aborts this build, even if a cache entry is present. */
    async snapshot(localeInput: string, releaseInput?: string): Promise<CmsDeliverySnapshot> {
      const locale = localeCode(localeInput, "locale"), releaseId = releaseInput === undefined ? undefined : cmsId(releaseInput, "releaseId");
      const path = `${sitePath}/${locale}/snapshot${releaseId === undefined ? "" : `/${releaseId}`}`;
      const cacheKey = `${origin.origin}${path}`, cached = await cache?.read(cacheKey);
      let previous: CmsDeliverySnapshot | undefined;
      if (cached && typeof cached.body === "string" && cached.body.length <= CMS_DELIVERY_SNAPSHOT_BYTES) {
        const bytes = new TextEncoder().encode(cached.body);
        if (bytes.length <= CMS_DELIVERY_SNAPSHOT_BYTES) {
          try { previous = await verifySnapshot(bytes, cached.etag, locale, releaseId); }
          catch { /* A corrupt cache will be replaced after a verified 200 response. */ }
        }
      }
      const response = await request("GET", path, null, previous?.etag);
      if (response.status !== 200 && response.status !== 304) throw new Error(`CMS snapshot request failed (${response.status})`);
      if (response.headers.get(CMS_DELIVERY_HEADERS.renderer) !== String(CMS_DELIVERY_RENDERER_VERSION))
        fail("rendererContractVersion", "unsupported CMS renderer version");
      if (response.status === 304) {
        if (!previous || response.headers.get("ETag") !== previous.etag) throw new Error("CMS snapshot revalidation has no matching cache entry");
        return previous;
      }
      if (!isCmsDeliveryJson(response)) throw new Error("CMS snapshot response is not JSON");
      const bytes = await readCmsDeliveryBytes(response, CMS_DELIVERY_SNAPSHOT_BYTES);
      const result = await verifySnapshot(bytes, response.headers.get("ETag"), locale, releaseId);
      await cache?.write(cacheKey, { body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), etag: result.etag });
      return result;
    },

    /** Store the cursor only after durably accepting each notification. A retry can see the same events. */
    async events(afterSequence = 0): Promise<{ readonly events: readonly CmsDeliveryEvent[]; readonly nextSequence: number }> {
      const after = cmsDeliverySequence(afterSequence);
      const response = await request("POST", `${sitePath}/events`, JSON.stringify({ afterSequence: after }));
      if (response.status !== 200 || !isCmsDeliveryJson(response)) throw new Error(`CMS event request failed (${response.status})`);
      const result = record(cmsDeliveryJson(await readCmsDeliveryBytes(response, CMS_DELIVERY_JSON_BYTES)), "events");
      keys(result, ["events", "nextSequence"], "events");
      const entries = cmsArray(result.events, "events", CMS_DELIVERY_EVENT_LIMIT).map((entry) => parseCmsDeliveryEvent(entry, siteId));
      let cursor = after;
      for (const entry of entries) {
        if (entry.sequence <= cursor) fail("events", "nonmonotonic CMS delivery sequence");
        cursor = entry.sequence;
      }
      if (cmsDeliverySequence(result.nextSequence) !== cursor) fail("events", "CMS event cursor mismatch");
      return { events: entries, nextSequence: cursor };
    },

    /** Call from the deployment process after the artifact is live, or report a failed build or deployment. */
    async acknowledge(localeInput: string, input: CmsDeliveryAck): Promise<void> {
      const locale = localeCode(localeInput, "locale");
      const ack = parseCmsDeliveryAck(input);
      const response = await request("POST", `${sitePath}/${locale}/ack`, JSON.stringify(ack));
      if (response.status !== 200 || !isCmsDeliveryJson(response)) throw new Error(`CMS acknowledgement rejected (${response.status})`);
      // Drain the small response. The ack status can be read independently by Studio members.
      await readCmsDeliveryBytes(response, CMS_DELIVERY_JSON_BYTES);
    }
  };
}

/** CMS data for static list pages, item paths and redirects. Authenticated fetches belong only in the build. */
export function cmsDeliveryRoutes(snapshot: CmsReleaseSnapshot) {
  const itemsByCollection = new Map<string, CmsReleaseEntry[]>();
  for (const item of snapshot.items) {
    const items = itemsByCollection.get(item.collectionId);
    if (items) items.push(item);
    else itemsByCollection.set(item.collectionId, [item]);
  }
  return {
    lists: snapshot.schema.collections.flatMap((collection) => collection.pathPrefix === null ? [] : [{
      path: collection.pathPrefix.slice(0, -1) || "/", collection, items: itemsByCollection.get(collection.id) ?? []
    }]),
    details: snapshot.items.flatMap((item) => item.path === null ? [] : [{ path: item.path, item }]),
    redirects: snapshot.redirects
  };
}
