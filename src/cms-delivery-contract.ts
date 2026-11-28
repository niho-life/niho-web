import { parseCmsReleaseAssetManifest } from "./cms-v2-assets.js";
import { collectionPublicPath } from "./collection-model.js";
import type { CmsReleaseSnapshot } from "./cms-v2-release.js";
import { parseCmsRoutePath, parseCmsRouteRevision, parseCmsRouteTable, type CmsRouteReservation } from "./cms-v2-routes.js";
import { cmsArray, cmsId, cmsItemKey, cmsReferenceProblems, parseCmsItemRevision, parseCmsSchema, uniqueCmsKeys } from "./cms-v2-schema.js";
import { fail, identifier, keys, localeCode, record } from "./validation-utils.js";

export const CMS_DELIVERY_RENDERER_VERSION = 1;
export const CMS_DELIVERY_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const CMS_DELIVERY_JSON_BYTES = 16 * 1024;
export const CMS_DELIVERY_WINDOW_SECONDS = 120;
export const CMS_DELIVERY_EVENT_LIMIT = 25;
export const CMS_DELIVERY_PREFIX = "/api/cms-delivery/v1/sites/";
export const CMS_DELIVERY_HEADERS = {
  credential: "X-Cms-Credential",
  timestamp: "X-Cms-Timestamp",
  signature: "X-Cms-Signature",
  renderer: "X-Cms-Renderer-Version"
} as const;

const encode = new TextEncoder();
const sha256Pattern = /^[0-9a-f]{64}$/u;
const credentialPattern = /^delivery_[0-9a-f]{32}$/u;

export function cmsDeliveryCredentialId(value: unknown): string {
  if (typeof value !== "string" || !credentialPattern.test(value)) fail("credentialId", "invalid CMS delivery credential");
  return value;
}

export function cmsDeliveryDigest(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) fail("snapshotDigest", "invalid CMS delivery digest");
  return value;
}

export function cmsDeliverySequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("sequence", "invalid delivery sequence");
  return value;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secretBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!sha256Pattern.test(value)) fail("credential", "invalid CMS delivery key");
  return Uint8Array.from(value.match(/../gu)!, (byte) => Number.parseInt(byte, 16));
}

export async function cmsDeliveryHash(body: Uint8Array<ArrayBuffer> | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof body === "string" ? encode.encode(body) : body));
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function deriveCmsDeliverySecret(master: string, siteId: string, credentialId: string): Promise<string> {
  const context = ["niho-cms-delivery-key-v1", siteId, credentialId].join("\n");
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(master, "sign"), encode.encode(context)));
}

type SignedRequest = {
  readonly method: string;
  readonly siteId: string;
  readonly path: string;
  readonly timestamp: string;
  readonly credentialId: string;
  readonly body: Uint8Array<ArrayBuffer> | string;
};

async function requestMessage(input: SignedRequest): Promise<Uint8Array<ArrayBuffer>> {
  return encode.encode(["niho-cms-delivery-v1", input.method, input.siteId, input.path, input.timestamp,
    input.credentialId, await cmsDeliveryHash(input.body)].join("\n"));
}

export async function signCmsDeliveryRequest(secret: string, input: SignedRequest): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), await requestMessage(input)));
}

export async function verifyCmsDeliveryRequest(secret: string, signature: string, input: SignedRequest): Promise<boolean> {
  if (!sha256Pattern.test(signature)) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), secretBytes(signature), await requestMessage(input));
}

export const cmsDeliveryEtag = (digest: string): string => `"sha256-${digest}"`;

function cmsRoute(reservation: CmsRouteReservation): boolean {
  return reservation.kind === "cms-item" || (reservation.kind === "redirect" && reservation.owner === "cms");
}

/** Publish only CMS routes. The internal registry can also contain unpublished fixed-page reservations. */
export function projectCmsDeliverySnapshot(snapshot: CmsReleaseSnapshot): CmsReleaseSnapshot {
  return parseCmsDeliverySnapshot({
    ...snapshot, routeTable: { ...snapshot.routeTable, reservations: snapshot.routeTable.reservations.filter(cmsRoute) }
  }, snapshot.siteId, snapshot.locale);
}

export function parseCmsDeliverySnapshot(input: unknown, siteId: string, locale: string): CmsReleaseSnapshot {
  const raw = record(input, "snapshot");
  keys(raw, ["contractVersion", "releaseId", "siteId", "locale", "sourceLocale", "routeTableRevision", "routeTable",
    "schema", "items", "redirects", "assetManifest"], "snapshot");
  if (raw.contractVersion !== 2 || raw.siteId !== siteId || raw.locale !== locale) fail("snapshot", "CMS snapshot version or scope mismatch");
  const schema = parseCmsSchema(raw.schema), routeTable = parseCmsRouteTable(raw.routeTable, siteId, locale);
  const sourceLocale = raw.sourceLocale === undefined ? undefined : localeCode(raw.sourceLocale, "snapshot.sourceLocale");
  if (schema.siteId !== siteId || routeTable.reservations.some((route) => !cmsRoute(route))) fail("snapshot", "CMS snapshot contains an out-of-scope schema or route");
  const collections = new Map(schema.collections.map((collection) => [collection.id, collection]));
  const localizedPathPrefix = sourceLocale && sourceLocale !== locale ? `/${locale}` : "";
  const items = cmsArray(raw.items, "snapshot.items", 25_000).map((entry) => {
    const { path, ...revision } = record(entry, "snapshot.items");
    const item = parseCmsItemRevision(revision, schema);
    const collection = collections.get(item.collectionId)!;
    const expectedPath = collectionPublicPath(collection, item.values, localizedPathPrefix);
    if (item.locale !== locale || path !== expectedPath || expectedPath === null && (collection.pathField || collection.pathPrefix !== null))
      fail("snapshot.items", "CMS item locale or path mismatch");
    return { ...item, path: path === null ? null : parseCmsRoutePath(path, "snapshot.items.path") };
  });
  uniqueCmsKeys(items.map(cmsItemKey), "snapshot.items");
  if (cmsReferenceProblems(schema, items).length) fail("snapshot.items", "invalid published item reference");
  const redirects = cmsArray(raw.redirects, "snapshot.redirects", 25_000).map((entry) => {
    const redirect = record(entry, "snapshot.redirects");
    keys(redirect, ["from", "to"], "snapshot.redirects");
    return { from: parseCmsRoutePath(redirect.from, "snapshot.redirects.from"), to: parseCmsRoutePath(redirect.to, "snapshot.redirects.to") };
  });
  const routes = new Map(routeTable.reservations.map((route) => [route.path, route]));
  const itemRoutes = items.filter((item) => item.path !== null);
  const lists = schema.collections.flatMap(({ pathPrefix }) => pathPrefix === null ? [] : [parseCmsRoutePath(pathPrefix.slice(0, -1) || "/", "snapshot.schema.pathPrefix")]);
  uniqueCmsKeys([...lists, ...itemRoutes.map(({ path }) => path!), ...redirects.map(({ from }) => from)], "snapshot.routes");
  if (routes.size !== routeTable.reservations.length || routes.size !== itemRoutes.length + redirects.length ||
      itemRoutes.some((item) => {
        const route = routes.get(item.path!);
        return route?.kind !== "cms-item" || cmsItemKey(route) !== cmsItemKey(item);
      }) || redirects.some(({ from, to }) => {
        const route = routes.get(from);
        return route?.kind !== "redirect" || route.targetPath !== to;
      })) fail("snapshot.routeTable", "CMS routes do not match published items and redirects");
  return { contractVersion: 2, siteId, locale, releaseId: cmsId(raw.releaseId, "snapshot.releaseId"),
    ...(sourceLocale === undefined ? {} : { sourceLocale }),
    routeTableRevision: parseCmsRouteRevision(raw.routeTableRevision, "snapshot.routeTableRevision"),
    routeTable, schema, items, redirects, assetManifest: parseCmsReleaseAssetManifest(schema, items, raw.assetManifest) };
}

export async function serializeCmsDeliverySnapshot(snapshot: CmsReleaseSnapshot) {
  const legacy = snapshot as unknown as { readonly routeTable?: CmsReleaseSnapshot["routeTable"]; readonly routeTableRevision?: string };
  const revision = legacy.routeTableRevision ?? legacy.routeTable?.revision ?? `legacy_${snapshot.releaseId.slice(0, 72)}`;
  const reservations = [
    ...snapshot.items.flatMap((item) => item.path ? [{ kind: "cms-item" as const, path: item.path,
      collectionId: item.collectionId, itemId: item.itemId }] : []),
    ...snapshot.redirects.map(({ from, to }) => ({ kind: "redirect" as const, path: from, targetPath: to, owner: "cms" as const }))
  ];
  const routeTable = legacy.routeTable ?? parseCmsRouteTable({ siteId: snapshot.siteId, locale: snapshot.locale, revision, reservations }, snapshot.siteId, snapshot.locale);
  const body = JSON.stringify(projectCmsDeliverySnapshot({ ...snapshot, routeTableRevision: revision, routeTable }));
  return { body, snapshotDigest: await cmsDeliveryHash(body) };
}

export type CmsDeliveryAck = {
  readonly releaseId: string;
  readonly snapshotDigest: string;
  readonly rendererContractVersion: typeof CMS_DELIVERY_RENDERER_VERSION;
} & ({ readonly state: "deployed"; readonly artifactId: string } | { readonly state: "failed" });

export function parseCmsDeliveryAck(input: unknown): CmsDeliveryAck {
  const raw = record(input, "ack");
  keys(raw, ["releaseId", "snapshotDigest", "rendererContractVersion", "state", ...(raw.state === "deployed" ? ["artifactId"] : [])], "ack");
  if (raw.state !== "deployed" && raw.state !== "failed") fail("ack.state", "invalid deployment state");
  if (raw.rendererContractVersion !== CMS_DELIVERY_RENDERER_VERSION) fail("ack.rendererContractVersion", "unsupported CMS renderer version");
  return { releaseId: cmsId(raw.releaseId, "ack.releaseId"), snapshotDigest: cmsDeliveryDigest(raw.snapshotDigest),
    rendererContractVersion: CMS_DELIVERY_RENDERER_VERSION,
    ...(raw.state === "deployed" ? { state: raw.state, artifactId: cmsId(raw.artifactId, "ack.artifactId") } : { state: raw.state }) };
}

export type CmsDeliveryEvent = {
  readonly siteId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly locale: string;
  readonly releaseId: string;
  readonly snapshotDigest: string;
  readonly rendererContractVersion: typeof CMS_DELIVERY_RENDERER_VERSION;
};
export function parseCmsDeliveryEvent(input: unknown, siteId: string): CmsDeliveryEvent {
  const raw = record(input, "event");
  keys(raw, ["siteId", "eventId", "sequence", "locale", "releaseId", "snapshotDigest", "rendererContractVersion"], "event");
  const releaseId = cmsId(raw.releaseId, "event.releaseId"), sequence = cmsDeliverySequence(raw.sequence);
  if (raw.siteId !== siteId || raw.eventId !== releaseId || sequence === 0 || raw.rendererContractVersion !== CMS_DELIVERY_RENDERER_VERSION)
    fail("event", "CMS event scope, identity or version mismatch");
  return { siteId, eventId: releaseId, sequence, locale: localeCode(raw.locale, "event.locale"),
    releaseId, snapshotDigest: cmsDeliveryDigest(raw.snapshotDigest), rendererContractVersion: CMS_DELIVERY_RENDERER_VERSION };
}

export function cmsDeliverySitePath(siteId: string): string {
  return CMS_DELIVERY_PREFIX + identifier(siteId, "siteId");
}

/** Read at most the wire limit, regardless of the declared content length. */
export async function readCmsDeliveryBytes(input: Request | Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = input.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) fail("body", "CMS delivery body exceeds its limit");
  if (input.body === null) return new Uint8Array();
  const reader = input.body.getReader(), bytes = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.length > limit) {
        await reader.cancel();
        fail("body", "CMS delivery body exceeds its limit");
      }
      bytes.set(chunk.value, size);
      size += chunk.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}

export function cmsDeliveryJson(bytes: Uint8Array<ArrayBuffer>): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("body", "invalid CMS delivery JSON"); }
}

export function isCmsDeliveryJson(input: Request | Response): boolean {
  return /^application\/json(?:;\s*charset=utf-8)?$/iu.test(input.headers.get("Content-Type") ?? "");
}
