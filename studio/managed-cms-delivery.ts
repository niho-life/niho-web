import {
  CMS_DELIVERY_EVENT_LIMIT, CMS_DELIVERY_HEADERS, CMS_DELIVERY_JSON_BYTES, CMS_DELIVERY_PREFIX,
  CMS_DELIVERY_RENDERER_VERSION, CMS_DELIVERY_SNAPSHOT_BYTES, CMS_DELIVERY_WINDOW_SECONDS, cmsDeliveryCredentialId,
  cmsDeliveryDigest, cmsDeliveryEtag, cmsDeliveryHash, cmsDeliveryJson, cmsDeliverySequence, deriveCmsDeliverySecret,
  isCmsDeliveryJson, parseCmsDeliveryAck, readCmsDeliveryBytes, serializeCmsDeliverySnapshot, verifyCmsDeliveryRequest,
  type CmsDeliveryAck, type CmsDeliveryEvent
} from "../src/cms-delivery-contract.js";
import { cmsId } from "../src/cms-v2-schema.js";
import { DocumentValidationError, keys, localeCode, record } from "../src/validation-utils.js";
import { CmsStore, nowSeconds, opaque, type CmsScope } from "./managed-cms-store.js";

const SITE_PATH = /^([A-Za-z][A-Za-z0-9_-]{0,79})\/(.+)$/u;
const LOCALE_PATH = /^([a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)\/(snapshot(?:\/([A-Za-z0-9_][A-Za-z0-9._~-]{0,127}))?|ack)$/u;
const CREDENTIALS = "managed_cms_delivery_credentials";
const EVENTS = "managed_cms_delivery_events";
const ACKS = "managed_cms_delivery_acks";
const MAX_CREDENTIALS = 8;
const OWNER = `SELECT 1 FROM sites AS s JOIN managed_sites AS ms ON ms.site_id = s.id
  JOIN project_members AS m ON m.project_id = s.project_id
  WHERE s.id = ?1 AND s.project_id = ?2 AND m.access_subject = ?3 AND m.role = 'owner'`;

// Match JSON keys by value so the locale never becomes an interpolated SQLite JSON path.
const CURRENT_RELEASE = `SELECT CASE WHEN json_extract(state_json, '$.locale') = ?2
  THEN json_extract(state_json, '$.current.id')
  ELSE (SELECT json_extract(value, '$.id') FROM json_each(state_json, '$.localizedReleases') WHERE key = ?2)
  END AS release_id FROM managed_cms_state WHERE site_id = ?1`;

type Credential = { readonly id: string; readonly hash: string };
type EventRow = { sequence: number; release_id: string; locale: string; snapshot_digest: string; renderer_version: typeof CMS_DELIVERY_RENDERER_VERSION };
type AckRow = { release_id: string; snapshot_digest: string; renderer_version: typeof CMS_DELIVERY_RENDERER_VERSION;
  state: CmsDeliveryAck["state"]; artifact_id: string | null; recorded_at: number };

function headers(): Headers {
  return new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-transform",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: headers() });
}
const error = (code: string, status: number) => json({ error: code }, status);
const notFound = () => error("not_found", 404);

function currentRelease(store: CmsStore, siteId: string, locale: string) {
  return store.db.prepare(CURRENT_RELEASE).bind(siteId, locale).first<{ release_id: string | null }>();
}

function ackResponse(row: AckRow) {
  return { releaseId: row.release_id, snapshotDigest: row.snapshot_digest, rendererContractVersion: row.renderer_version,
    state: row.state, ...(row.state === "deployed" ? { artifactId: row.artifact_id } : {}), recordedAt: row.recorded_at };
}

async function authorize(store: CmsStore, request: Request, url: URL, master: string, siteId: string, body: Uint8Array<ArrayBuffer>): Promise<Credential | null> {
  const timestamp = request.headers.get(CMS_DELIVERY_HEADERS.timestamp) ?? "";
  const signature = request.headers.get(CMS_DELIVERY_HEADERS.signature) ?? "";
  if (!/^\d{10}$/u.test(timestamp) || Math.abs(nowSeconds() - Number(timestamp)) > CMS_DELIVERY_WINDOW_SECONDS || !/^[0-9a-f]{64}$/u.test(signature)) return null;
  let id: string;
  try { id = cmsDeliveryCredentialId(request.headers.get(CMS_DELIVERY_HEADERS.credential)); }
  catch { return null; }
  const row = await store.db.prepare(`SELECT secret_hash FROM ${CREDENTIALS} WHERE site_id = ?1 AND credential_id = ?2`)
    .bind(siteId, id).first<{ secret_hash: string }>();
  if (!row) return null;
  const secret = await deriveCmsDeliverySecret(master, siteId, id);
  if (await cmsDeliveryHash(secret) !== row.secret_hash) return null;
  if (!await verifyCmsDeliveryRequest(secret, signature, { method: request.method, siteId, path: url.pathname, timestamp, credentialId: id, body })) return null;
  return { id, hash: row.secret_hash };
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  if (request.body === null) return true;
  try { return (await readCmsDeliveryBytes(request, 1)).byteLength === 0; }
  catch { return false; }
}

async function events(store: CmsStore, siteId: string, input: unknown): Promise<Response> {
  const body = record(input, "events");
  keys(body, ["afterSequence"], "events");
  const cursor = cmsDeliverySequence(body.afterSequence);
  const query = await store.db.prepare(`SELECT sequence, release_id, locale, snapshot_digest, renderer_version FROM ${EVENTS}
    WHERE site_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT ?3`).bind(siteId, cursor, CMS_DELIVERY_EVENT_LIMIT).all<EventRow>();
  if (!query.success || !query.results) throw new Error("CMS delivery event lookup failed");
  const events: CmsDeliveryEvent[] = query.results.map((row) => ({ siteId, eventId: row.release_id, sequence: row.sequence,
    locale: row.locale, releaseId: row.release_id, snapshotDigest: row.snapshot_digest, rendererContractVersion: row.renderer_version }));
  return json({ events, nextSequence: events.at(-1)?.sequence ?? cursor });
}

async function snapshotRepresentation(store: CmsStore, siteId: string, locale: string, releaseId: string) {
  const snapshot = await store.snapshot(siteId, releaseId);
  if (snapshot.locale !== locale) throw new Error("CMS delivery snapshot locale mismatch");
  const representation = await serializeCmsDeliverySnapshot(snapshot);
  if (new TextEncoder().encode(representation.body).length > CMS_DELIVERY_SNAPSHOT_BYTES)
    throw new Error("CMS delivery snapshot size exceeded");
  return representation;
}

async function deliveredSnapshot(request: Request, store: CmsStore, siteId: string, locale: string, releaseId: string | undefined) {
  const current = await currentRelease(store, siteId, locale);
  const id = releaseId ?? current?.release_id;
  if (!id) return notFound();
  const event = await store.db.prepare(`SELECT snapshot_digest FROM ${EVENTS} WHERE site_id = ?1 AND locale = ?2 AND release_id = ?3`)
    .bind(siteId, locale, id).first<{ snapshot_digest: string }>();
  // Before the delivery schema, the current pointer was the only locale index.
  if (!event && id !== current?.release_id) return notFound();
  const { body, snapshotDigest } = await snapshotRepresentation(store, siteId, locale, id);
  if (event && cmsDeliveryDigest(event.snapshot_digest) !== snapshotDigest) throw new Error("CMS delivery snapshot digest mismatch");
  const resultHeaders = headers(), etag = cmsDeliveryEtag(snapshotDigest);
  resultHeaders.set("ETag", etag);
  resultHeaders.set(CMS_DELIVERY_HEADERS.renderer, String(CMS_DELIVERY_RENDERER_VERSION));
  return request.headers.get("If-None-Match") === etag
    ? new Response(null, { status: 304, headers: resultHeaders })
    : new Response(body, { headers: resultHeaders });
}

async function acknowledge(store: CmsStore, siteId: string, locale: string, credential: Credential, input: unknown): Promise<Response> {
  const ack = parseCmsDeliveryAck(input);
  const current = await currentRelease(store, siteId, locale);
  if (current?.release_id !== ack.releaseId) return error("release_conflict", 409);
  const event = await store.db.prepare(`SELECT snapshot_digest, renderer_version FROM ${EVENTS}
    WHERE site_id = ?1 AND locale = ?2 AND release_id = ?3`)
    .bind(siteId, locale, ack.releaseId).first<{ snapshot_digest: string; renderer_version: number }>();
  const expected = event ?? {
    snapshot_digest: (await snapshotRepresentation(store, siteId, locale, ack.releaseId)).snapshotDigest,
    renderer_version: CMS_DELIVERY_RENDERER_VERSION
  };
  if (ack.snapshotDigest !== expected.snapshot_digest || ack.rendererContractVersion !== expected.renderer_version) return error("release_conflict", 409);
  // Check both the published pointer and the live credential again in the update itself.
  const row = await store.db.prepare(`INSERT INTO ${ACKS} (site_id, locale, release_id, snapshot_digest, renderer_version, state, artifact_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE (${CURRENT_RELEASE}) = ?3
      AND EXISTS (SELECT 1 FROM ${CREDENTIALS} WHERE site_id = ?1 AND credential_id = ?8 AND secret_hash = ?9)
      AND EXISTS (SELECT 1 FROM managed_cms_releases WHERE site_id = ?1 AND release_id = ?3)
    ON CONFLICT(site_id, locale, release_id) DO UPDATE SET state = excluded.state, artifact_id = excluded.artifact_id,
      recorded_at = CASE WHEN ${ACKS}.state = excluded.state THEN ${ACKS}.recorded_at ELSE unixepoch() END
    WHERE ${ACKS}.snapshot_digest = excluded.snapshot_digest AND ${ACKS}.renderer_version = excluded.renderer_version
      AND (${ACKS}.state = 'failed' OR (${ACKS}.state = excluded.state AND ${ACKS}.artifact_id IS excluded.artifact_id))
    RETURNING release_id, snapshot_digest, renderer_version, state, artifact_id, recorded_at`)
    .bind(siteId, locale, ack.releaseId, ack.snapshotDigest, ack.rendererContractVersion, ack.state,
      ack.state === "deployed" ? ack.artifactId : null, credential.id, credential.hash).first<AckRow>();
  return row ? json(ackResponse(row)) : error("release_conflict", 409);
}

export async function managedCmsDelivery(request: Request, store: CmsStore, masterKey: string | undefined): Promise<Response> {
  const url = new URL(request.url), match = SITE_PATH.exec(url.pathname.slice(CMS_DELIVERY_PREFIX.length));
  if (!url.pathname.startsWith(CMS_DELIVERY_PREFIX) || url.protocol !== "https:" || url.href.includes("?") || !match) return notFound();
  const [, siteId, action] = match;
  const localeAction = LOCALE_PATH.exec(action!);
  if (action !== "events" && !localeAction) return notFound();
  if (!masterKey) return notFound();
  const method = localeAction?.[2]?.startsWith("snapshot") ? "GET" : "POST";
  if (request.method !== method) return error("method_not_allowed", 405);
  if (method === "GET" ? request.body !== null : !isCmsDeliveryJson(request)) return error("invalid_request", 400);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readCmsDeliveryBytes(request, CMS_DELIVERY_JSON_BYTES); }
  catch (failure) {
    if (failure instanceof DocumentValidationError) return error("invalid_request", 400);
    throw failure;
  }
  const credential = await authorize(store, request, url, masterKey, siteId!, bytes);
  if (!credential) return error("authentication_required", 401);
  try {
    if (action === "events") return await events(store, siteId!, cmsDeliveryJson(bytes));
    const locale = localeCode(localeAction![1], "locale");
    if (method === "GET") return deliveredSnapshot(request, store, siteId!, locale,
      localeAction?.[3] === undefined ? undefined : cmsId(localeAction[3], "releaseId"));
    return await acknowledge(store, siteId!, locale, credential, cmsDeliveryJson(bytes));
  } catch (failure) {
    if (failure instanceof DocumentValidationError) return error("invalid_request", 400);
    throw failure;
  }
}

export async function managedCmsDeliveryAdmin(request: Request, store: CmsStore, scope: CmsScope, action: string,
  masterKey: string | undefined): Promise<Response> {
  const url = new URL(request.url);
  if (url.href.includes("?")) return notFound();
  const { siteId, projectId, actor } = scope;
  const status = /^\/cms\/delivery\/([a-zA-Z0-9-]+)\/status$/u.exec(action);
  if (status) {
    if (request.method !== "GET") return error("method_not_allowed", 405);
    const site = await store.site(scope, "cms.read");
    if (!site) return notFound();
    let locale: string;
    try { locale = localeCode(status[1], "locale"); }
    catch { return notFound(); }
    const row = await store.db.prepare(`WITH current_release AS (${CURRENT_RELEASE})
      SELECT c.release_id, a.snapshot_digest, a.renderer_version, a.state, a.artifact_id, a.recorded_at
      FROM current_release AS c LEFT JOIN ${ACKS} AS a ON a.site_id = ?1 AND a.locale = ?2 AND a.release_id = c.release_id`)
      .bind(siteId, locale).first<AckRow | { release_id: string | null; state: null }>();
    if (!row?.release_id) return json({ state: "idle" });
    return json(row.state === null ? { state: "pending", releaseId: row.release_id } : ackResponse(row));
  }

  const credentials = "/cms/delivery/credentials";
  const issuing = action === credentials, deleting = action.startsWith(`${credentials}/`);
  if (!issuing && !deleting) return notFound();
  if (issuing && request.method === "GET") {
    if (!await store.db.prepare(OWNER).bind(siteId, projectId, actor.id).first()) return notFound();
    const list = await store.db.prepare(`SELECT credential_id AS credentialId, created_at AS createdAt FROM ${CREDENTIALS}
      WHERE site_id = ?1 AND EXISTS (${OWNER}) ORDER BY created_at, credential_id`)
      .bind(siteId, projectId, actor.id).all<{ credentialId: string; createdAt: number }>();
    if (!list.success || !list.results) throw new Error("CMS delivery credential listing failed");
    return json({ credentials: list.results });
  }
  if (request.method !== (issuing ? "POST" : "DELETE")) return error("method_not_allowed", 405);
  if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") !== "same-origin" || !await hasEmptyBody(request))
    return error("invalid_request", 400);
  if (!await store.db.prepare(OWNER).bind(siteId, projectId, actor.id).first()) return notFound();
  if (issuing) {
    if (!masterKey) return error("delivery_unavailable", 503);
    const credentialId = opaque("delivery"), secret = await deriveCmsDeliverySecret(masterKey, siteId, credentialId);
    const statements = [
      store.db.prepare(`INSERT INTO ${CREDENTIALS} (site_id, credential_id, secret_hash)
        SELECT ?1, ?4, ?5 WHERE EXISTS (${OWNER}) AND (SELECT count(*) FROM ${CREDENTIALS} WHERE site_id = ?1) < ?6`)
        .bind(siteId, projectId, actor.id, credentialId, await cmsDeliveryHash(secret), MAX_CREDENTIALS),
      store.db.prepare(`INSERT INTO managed_cms_audit (id, site_id, actor_id, operation)
        SELECT ?4, ?1, ?2, 'cms.delivery.credential.issued' WHERE EXISTS
          (SELECT 1 FROM ${CREDENTIALS} WHERE site_id = ?1 AND credential_id = ?3)`)
        .bind(siteId, actor.id, credentialId, opaque("audit"))
    ];
    const result = await store.db.batch(statements);
    if (result.length !== statements.length || result.some((entry) => !entry.success)) throw new Error("CMS delivery credential issuance failed");
    if (result[0]?.meta?.changes !== 1) return error("credential_not_issued", 409);
    return json({ credentialId, secret }, 201);
  }
  let id: string;
  try { id = cmsDeliveryCredentialId(action.slice(credentials.length + 1)); }
  catch { return notFound(); }
  const statements = [
    store.db.prepare(`INSERT INTO managed_cms_audit (id, site_id, actor_id, operation)
      SELECT ?5, ?1, ?3, 'cms.delivery.credential.revoked' WHERE EXISTS (${OWNER})
        AND EXISTS (SELECT 1 FROM ${CREDENTIALS} WHERE site_id = ?1 AND credential_id = ?4)`)
      .bind(siteId, projectId, actor.id, id, opaque("audit")),
    store.db.prepare(`DELETE FROM ${CREDENTIALS}
      WHERE site_id = ?1 AND credential_id = ?4 AND EXISTS (${OWNER})`).bind(siteId, projectId, actor.id, id)
  ];
  const result = await store.db.batch(statements);
  if (result.length !== statements.length || result.some((entry) => !entry.success)) throw new Error("CMS delivery credential revocation failed");
  return result[1]?.meta?.changes === 1 ? new Response(null, { status: 204, headers: headers() }) : notFound();
}
