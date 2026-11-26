import {
  CMS_V2_OPERATIONS, checkCmsReleaseApply, checkCmsScheduleCreate, checkCmsSchemaApply, checkCmsWriteVersion,
  cmsLegacyCollections, cmsRoleCapabilities, cmsWorkspaceItem, discoverCmsContract, parseCmsApplyInput,
  parseCmsDraftWrite, parseCmsReleaseInput, parseCmsScheduleRequest, parseCmsSchemaPlanInput,
  planCmsMigrationWithRouteTables, planCmsRelease, planCmsSchedule, revalidateCmsRelease,
  cmsLocalizationItemKey, cmsLocalizationStatus, collectCmsLocalizationUnits, materializeCmsLocalizedItem,
  createCmsLocalizationOverlay, editCmsLocalizedValue, parseCmsLocalizationItemKey, parseCmsLocalizationOverlay,
  reviewCmsLocalizedValue, type CmsItemRevision, type CmsLocalizationOverlay, type CmsSchema,
  type CmsMigrationDraft, type CmsProblem, type CmsReleaseInput, type CmsReleaseProposal, type CmsRouteBoundMigration,
  type CmsPublicAsset, type CmsReleaseContext, type CmsSchedule, type CmsV2Operation
} from "../src/cms-v2.js";
import { parseEditingLocalizationInput } from "../src/editing-localization.js";
import { cmsCollection, cmsId, cmsItemKey, parseCmsValues } from "../src/cms-v2-schema.js";
import { cmsPageBindingProblems, parseCmsPageBindings } from "../src/cms-page-bindings.js";
import { parsePageDocument } from "../src/document.js";
import { parseCollectionValues, type CollectionItem, type CollectionValues } from "../src/collection-model.js";
import { DocumentValidationError, keys, record } from "../src/validation-utils.js";
import { validatePagePath } from "../src/pages.js";
import { OPERATION_KEY_HEADER, UUID_V4 } from "../cli/operations.mjs";
import {
  CmsStore, MAX_BODY, MAX_ITEMS, MAX_REDIRECTS, MAX_RELEASE_BODY, MAX_RETAINED_BYTES, MAX_SNAPSHOT, blobSize, cmsPathReserved, dateNow, digest,
  iso, itemBlobKey, localizationBlobKey, nowSeconds, opaque, routeTableKey, snapshotKey, type CmsCapability, type CmsScope, type ItemMeta, type JobPayload, type Site
} from "./managed-cms-store.js";
import { collectionPath, deliverCmsJob, escapeHtml, previewContent, releaseContext, releaseImpacts } from "./managed-cms-release.js";
import { cmsLocalizationItem, cmsLocalizationOverview, cmsLocalizationSummary, cmsLocalizationTargetLocale, type CmsLocalizationView } from "./managed-cms-localization.js";

const PLAN_TTL = 10 * 60;
const PREVIEW_TTL = 5 * 60;
const LIST_SIZE = 10;
const MAX_ITEM_SAVE_BODY = 128 * 1024;
const VERSION_HEADER = "X-Studio-CMS-Version";
const LEGACY = {
  "cms.schema": ["GET", "cms.read", 0],
  "cms.list": ["GET", "cms.read", 1],
  "cms.read": ["GET", "cms.read", 2],
  "cms.create": ["POST", "cms.edit", 1],
  "cms.save": ["PUT", "cms.edit", 2],
  "cms.publish-plan": ["POST", "cms.publish", 2],
  "cms.publish": ["POST", "cms.publish", 2],
  "cms.operation-status": ["GET", "cms.read", 1]
} as const;
type LegacyOp = keyof typeof LEGACY;
const EXTRA = {
  "cms.items.create": "cms.edit", "cms.items.list": "cms.read", "cms.items.read": "cms.read",
  "cms.preview.prepare": "cms.read", "cms.preview.read": "cms.read",
  "cms.release.current": "cms.read", "cms.release.snapshot": "cms.read"
} as const;
type Operation = CmsV2Operation | keyof typeof EXTRA;
const MUTATIONS = new Set<Operation>([
  "cms.items.create", "cms.items.save", "cms.items.remove", "cms.items.restore", "cms.schema.apply",
  "cms.release.apply", "cms.schedule.create", "cms.schedule.cancel", "cms.localization.items.command", "cms.localization.release.apply"
]);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin", "X-Robots-Tag": "noindex"
} });
const error = (code: string, status: number) => json({ error: code }, status);
const conflict = () => json({ status: "conflict" }, 409);
const notFound = () => error("not_found", 404);
const forbidden = () => error("forbidden", 403);
const invalid = () => error("invalid_request", 400);
const tokenId = (value: unknown) => typeof value === "string" && /^token_[a-f0-9]{32}$/u.test(value);
const parseOperationId = (value: unknown) => cmsId(value, "operationId");

function exact(value: Record<string, unknown>, names: readonly string[]) {
  keys(value, names, "request");
  if (Object.keys(value).length !== names.length) throw new DocumentValidationError("request", "missing key");
}

async function readBody(request: Request, scope: CmsScope, maxBytes = MAX_BODY) {
  if (!scope.actor.cli && (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("Sec-Fetch-Site") !== "same-origin")) return null;
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) return null;
  const reader = request.body?.getReader(), bytes = new Uint8Array(maxBytes);
  if (!reader) return null;
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (size + chunk.value.length > maxBytes) { await reader.cancel(); return null; }
    bytes.set(chunk.value, size);
    size += chunk.value.length;
  }
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))), "request"); }
  catch { return null; }
}

type Mutation = { readonly site: Site; readonly capability: CmsCapability; readonly operation: string; readonly operationId: string; readonly inputDigest: string };
async function mutationObjectId(prefix: string, mutation: Mutation, target: { collectionId?: string; itemId?: string } = {}) {
  const { site, operationId, inputDigest } = mutation;
  const stable = await digest({ siteId: site.siteId, actorId: site.actor.id, operationId, inputDigest, ...target });
  return `${prefix}_${stable.slice(0, 32)}`;
}
async function replay(store: CmsStore, mutation: Mutation) {
  const { site, capability, operationId, operation, inputDigest } = mutation;
  const receipt = await store.receipt(site, capability, operationId);
  return receipt === null ? null : receipt.operation === operation && receipt.input_digest === inputDigest
    ? json(JSON.parse(receipt.result_json) as unknown) : error("duplicate_operation", 409);
}

async function mutate(store: CmsStore, mutation: Mutation, change: Omit<Parameters<CmsStore["commit"]>[2], "operation" | "operationId" | "inputDigest">) {
  const { site, capability, ...scope } = mutation;
  if (change.state.retainedBytes > MAX_RETAINED_BYTES || blobSize(change.state) > 256 * 1024) return error("quota_exceeded", 409);
  const committed = await store.commit(site, capability, { ...scope, ...change });
  if (!committed) {
    const same = await replay(store, mutation);
    if (same) return same;
    return await store.site(site, capability) ? conflict() : forbidden();
  }
  if (change.job?.kind === "release") await deliverCmsJob(store, change.job.id).catch(() => {});
  return json(change.result);
}

async function currentSnapshot(store: CmsStore, site: Site) {
  return site.state.current ? store.snapshot(site.siteId, site.state.current.id) : null;
}

function storedItem(site: Site, collectionId: string, itemId: string) {
  return site.state.items[cmsItemKey({ collectionId, itemId })] ?? null;
}

async function cmsLocalizationView(store: CmsStore, site: Site, collectionId: string, itemId: string, targetLocale: string): Promise<CmsLocalizationView | null> {
  const meta = storedItem(site, collectionId, itemId);
  if (!meta || meta.removedAt !== null) return null;
  const source = await store.item(site.siteId, site.state.locale, meta);
  if (targetLocale === source.locale) throw new DocumentValidationError("targetLocale", "source and target locales must differ");
  const collection = await collectCmsLocalizationUnits(site.state.schema, source, targetLocale);
  const overlay = await cmsLocalizationOverlay(store, site, collection);
  return { schema: site.state.schema, source, collection, overlay, updatedAt: meta.updatedAt };
}

async function cmsLocalizationOverlay(store: CmsStore, site: Site, collection: Awaited<ReturnType<typeof collectCmsLocalizationUnits>>): Promise<CmsLocalizationOverlay> {
  const itemKey = cmsLocalizationItemKey(collection.identity.collectionId, collection.identity.itemId);
  const pointer = site.state.localizations?.[itemKey];
  let overlay: CmsLocalizationOverlay;
  if (!pointer) overlay = createCmsLocalizationOverlay(collection);
  else {
    const blob = await store.bucket.get(localizationBlobKey(site.siteId, collection.identity.targetLocale, itemKey, pointer.revision));
    if (!blob) throw new Error("CMS localization overlay unavailable");
    overlay = parseCmsLocalizationOverlay(await blob.json(), collection);
    if (overlay.version !== pointer.version) throw new Error("CMS localization overlay version mismatch");
  }
  return overlay;
}

async function cmsLocalizationViews(store: CmsStore, site: Site): Promise<CmsLocalizationView[]> {
  const targetLocale = cmsLocalizationTargetLocale(site.state.locale);
  const metas = Object.values(site.state.items).filter((meta) => meta.removedAt === null);
  const views = await Promise.all(metas.map((meta) => cmsLocalizationView(store, site, meta.collectionId, meta.itemId, targetLocale)));
  return views.filter((view): view is CmsLocalizationView => view !== null);
}

async function editorContext(store: CmsStore, site: Site, capability: CmsCapability) {
  const [current, jobs] = await Promise.all([currentSnapshot(store, site), store.jobs(site, capability)]);
  return {
    current,
    jobs: jobs.map((job) => ({ id: job.id, kind: job.kind, at: iso(job.scheduled_at),
      payload: JSON.parse(job.payload_json) as Extract<JobPayload, { releaseId: string }> }))
  };
}

type EditorContext = Awaited<ReturnType<typeof editorContext>>;
function workspaceItem(site: Site, item: CmsItemRevision, meta: ItemMeta, context: EditorContext): CollectionItem {
  const collection = cmsCollection(site.state.schema, item.collectionId);
  const selected = context.current?.items.find((pin) => cmsItemKey(pin) === cmsItemKey(item));
  const schedule = context.jobs.find((job) => job.kind === "schedule" && job.payload.pins.includes(cmsItemKey(item)));
  const pending = context.jobs.find((job) => job.kind === "release"
    && (job.payload.pins.includes(cmsItemKey(item)) || selected !== undefined));
  const slug = collection.slugField === null ? null : item.values[collection.slugField];
  const candidatePath = slug && collection.pathPrefix ? `${collection.pathPrefix}${String(slug)}` : null;
  const subtitle = collection.subtitleField === null ? null : item.values[collection.subtitleField];
  return cmsWorkspaceItem(site.state.schema, item, {
    draftRevision: item.revision, publishedRevision: selected?.revision ?? null, publishedAt: selected ? site.state.current?.at ?? null : null,
    deliveryState: pending ? { state: "pending", releaseId: pending.payload.releaseId } : { state: "idle" },
    schedule: schedule ? { id: schedule.id, at: schedule.at, state: "scheduled" } : null, tombstone: null
  }, { subtitle: typeof subtitle === "string" && subtitle ? subtitle : null, imageUrl: null,
    path: candidatePath && validatePagePath(candidatePath) === null ? candidatePath : null,
    updatedAt: meta.updatedAt, updatedBy: null, order: null })!;
}

async function saveDraft(store: CmsStore, mutation: Mutation, input: {
  collectionId: string; itemId: string; values: CollectionValues; create: boolean; legacy: boolean;
}) {
  const { site, capability } = mutation;
  const itemId = input.create ? await mutationObjectId("item", mutation) : input.itemId;
  const item: CmsItemRevision = {
    siteId: site.siteId, schemaRevision: site.state.schema.schemaRevision, collectionId: input.collectionId, itemId,
    locale: site.state.locale, revision: await mutationObjectId("rev", mutation, { collectionId: input.collectionId, itemId }), values: input.values
  };
  const meta: ItemMeta = { collectionId: item.collectionId, itemId: item.itemId, revision: item.revision, updatedAt: dateNow(), removedAt: null };
  const state = { ...site.state, items: { ...site.state.items, [cmsItemKey(meta)]: meta }, retainedBytes: site.state.retainedBytes + blobSize(item) };
  if (Object.keys(state.items).length > MAX_ITEMS || state.retainedBytes > MAX_RETAINED_BYTES) return error("quota_exceeded", 409);
  const result = input.legacy ? {
    ...(input.create ? {} : { status: "saved" }), item: workspaceItem(site, item, meta, await editorContext(store, site, capability))
  } : { status: input.create ? "created" : "saved", item };
  await store.put(itemBlobKey(site.siteId, item.locale, item), item);
  return mutate(store, mutation, { state, revisions: [item], result });
}

async function storePlan<T>(store: CmsStore, site: Site, capability: CmsCapability, operation: string,
  operationId: string, candidate: T) {
  const expires = nowSeconds() + PLAN_TTL, payload = { operation, operationId, candidate };
  if (blobSize(payload) > MAX_SNAPSHOT - MAX_BODY) return null;
  const confirmationToken = await store.makeToken(site, capability, operation, payload, expires);
  return confirmationToken ? { ...payload, siteId: site.siteId, actorId: site.actor.id, expiresAt: iso(expires), confirmationToken } : null;
}

async function readPlan<T>(store: CmsStore, site: Site, capability: CmsCapability, operation: string,
  operationId: string, token: unknown) {
  if (!tokenId(token)) return null;
  const row = await store.readToken<{ operationId: string; candidate: T }>(site, capability, operation, token as string);
  if (!row || row.payload.operationId !== operationId) return null;
  return { siteId: site.siteId, actorId: site.actor.id, operationId, operation, candidate: row.payload.candidate,
    expiresAt: iso(row.expires), confirmationToken: token as string };
}

async function queueRelease(store: CmsStore, mutation: Mutation, proposal: CmsReleaseProposal, token: string, result: object, schedule?: CmsSchedule) {
  const site = mutation.site, { snapshot, expectedReleaseId } = proposal;
  const size = blobSize(snapshot), routeTableSize = blobSize(snapshot.routeTable);
  const state = { ...site.state, retainedBytes: site.state.retainedBytes + size + routeTableSize };
  if (size > MAX_SNAPSHOT || state.retainedBytes > MAX_RETAINED_BYTES) return error("quota_exceeded", 409);
  await store.put(routeTableKey(site.siteId, snapshot.locale, snapshot.routeTable.revision), snapshot.routeTable);
  await store.put(snapshotKey(site.siteId, snapshot.releaseId), snapshot);
  return mutate(store, mutation, { state, result, tokenHash: await digest(token), requireFreeSlot: true, job: {
    kind: schedule ? "schedule" : "release", id: schedule?.id ?? snapshot.releaseId, at: schedule ? Math.ceil(Date.parse(schedule.at) / 1000) : nowSeconds(),
    payload: { releaseId: snapshot.releaseId, expectedReleaseId, pins: snapshot.items.map(cmsItemKey) }
  } });
}

async function migrationContext(store: CmsStore, site: Site, capability: CmsCapability) {
  const [drafts, routeTable, pages] = await Promise.all([
    Promise.all(Object.values(site.state.items).map(async (meta): Promise<CmsMigrationDraft> => ({
      item: await store.item(site.siteId, site.state.locale, meta), tombstoned: meta.removedAt !== null
    }))),
    store.routeTable(site, capability),
    store.db.prepare(`SELECT ms.bindings_generation, bound.document_json, bound.bindings_json
      FROM managed_sites AS ms LEFT JOIN (
        SELECT p.site_id, v.document_json, v.bindings_json FROM managed_pages AS p
        JOIN managed_page_versions AS v ON v.site_id = p.site_id AND v.page_id = p.page_id
          AND v.locale = p.locale AND v.revision = p.current_revision WHERE v.bindings_json IS NOT NULL
      ) AS bound ON bound.site_id = ms.site_id WHERE ms.site_id = ?`)
      .bind(site.siteId).all<{ bindings_generation: number; document_json: string | null; bindings_json: string | null }>()
  ]);
  if (!pages.success || !pages.results?.length) throw new Error("managed CMS binding lookup failed");
  const bindingsGeneration = pages.results[0]!.bindings_generation;
  const bindings = pages.results.flatMap((row) => {
    if (row.document_json === null || row.bindings_json === null) return [];
    const page = parsePageDocument(JSON.parse(row.document_json));
    return [{ page, bindings: parseCmsPageBindings(JSON.parse(row.bindings_json), page) }];
  });
  const fixed = new Set(routeTable.reservations.flatMap((entry) =>
    entry.kind === "fixed-page" || (entry.kind === "reserved" && !entry.reservationId.startsWith("cms_route_")) ? [entry.path] : []));
  return { drafts, routeTables: [routeTable], bindingsGeneration, impact: (_before: Site["state"]["schema"], after: Site["state"]["schema"]): CmsProblem[] => {
    const paths = after.collections.flatMap(({ pathPrefix }) => {
      const path = collectionPath(pathPrefix);
      return path === null ? [] : [path];
    });
    return [
      ...paths.filter((path, i) => !cmsPathReserved(path) || path === "/cms" || fixed.has(path) || paths.indexOf(path) !== i)
        .map((path): CmsProblem => ({ code: "route", path, message: "一覧 URL を /cms 配下の空いているパスに指定してください。" })),
      ...bindings.flatMap(({ page, bindings }) => cmsPageBindingProblems(page, bindings, after))
    ];
  } };
}

async function schemaOperation(store: CmsStore, site: Site, capability: CmsCapability, operation: "cms.schema.plan" | "cms.schema.apply",
  body: Record<string, unknown>, mutation: Mutation | null) {
  if (operation === "cms.schema.plan") {
    const input = parseCmsSchemaPlanInput(body, site.siteId);
    if (input.expectedSchemaRevision !== site.state.schema.schemaRevision) return conflict();
    const { drafts, routeTables, impact } = await migrationContext(store, site, capability);
    const proposed = { ...input.nextSchema, schemaRevision: opaque("schema") };
    const migration = planCmsMigrationWithRouteTables({ before: site.state.schema, next: proposed, items: drafts,
      replacements: input.replacements, routeTables, expectedRouteTableVersions: input.routeTableVersions, impact });
    if (!migration) return conflict();
    if (migration.problems.length) return json({ status: "invalid", problems: migration.problems }, 422);
    const plan = await storePlan(store, site, capability, "cms.schema.apply", opaque("op"), { migration, replacements: input.replacements });
    if (!plan) return error("plan_unavailable", 409);
    return json({ status: "ready", plan: { ...plan, candidate: migration } });
  }
  const input = parseCmsApplyInput(body, site.siteId);
  const plan = await readPlan<{ migration: CmsRouteBoundMigration; replacements: ReturnType<typeof parseCmsSchemaPlanInput>["replacements"] }>(
    store, site, capability, operation, input.operationId, input.confirmationToken);
  if (!plan) return notFound();
  const { drafts, routeTables, impact, bindingsGeneration } = await migrationContext(store, site, capability);
  const check = checkCmsSchemaApply(siteScope(site), input, { ...plan, operation, candidate: plan.candidate.migration }, dateNow(),
    site.state.schema, drafts, routeTables, plan.candidate.replacements, impact);
  if (check.status !== "allowed") return json(check, 409);
  const items: Site["state"]["items"] = {}, revisions = await Promise.all(check.candidate.items.map(async (draft): Promise<CmsItemRevision> => {
    const { collectionId, itemId, values, locale } = draft;
    const prior = site.state.items[cmsItemKey(draft)]!;
    const revision = await mutationObjectId("rev", mutation!, { collectionId, itemId });
    items[cmsItemKey(draft)] = { ...prior, revision, updatedAt: dateNow() };
    return { siteId: site.siteId, schemaRevision: check.candidate.schema.schemaRevision, collectionId, itemId, revision, locale, values };
  }));
  const state = { ...site.state, schema: check.candidate.schema, items,
    retainedBytes: site.state.retainedBytes + revisions.reduce((total, revision) => total + blobSize(revision), 0) };
  if (state.retainedBytes > MAX_RETAINED_BYTES || blobSize(state) > 256 * 1024) return error("quota_exceeded", 409);
  await Promise.all(revisions.map((item) => store.put(itemBlobKey(site.siteId, item.locale, item), item)));
  return mutate(store, mutation!, { state, revisions, bindingsGeneration, tokenHash: await digest(input.confirmationToken),
    result: { status: "recorded", operationId: input.operationId, result: { schemaRevision: state.schema.schemaRevision } } });
}

const siteScope = (site: Site) => ({ siteId: site.siteId, actorId: site.actor.id });

async function releaseOperation(store: CmsStore, site: Site, capability: CmsCapability,
  operation: "cms.release.plan" | "cms.release.apply" | "cms.schedule.create", body: Record<string, unknown>, mutation: Mutation | null) {
  if (operation === "cms.release.plan") {
    const scheduled = Object.hasOwn(body, "at"), input = scheduled ? parseCmsScheduleRequest(body) : parseCmsReleaseInput(body);
    if (input.locale !== site.state.locale || input.items.length > MAX_ITEMS || input.redirects.length > MAX_REDIRECTS) return invalid();
    const { ...selection } = input as CmsReleaseInput & { at?: string };
    delete selection.at;
    const ready = planCmsRelease(selection, opaque("release"), await releaseContext(store, site, input.items));
    if (ready.status !== "ready") return json(ready, ready.status === "invalid" ? 422 : 409);
    const candidate = scheduled ? planCmsSchedule(opaque("schedule"), (input as ReturnType<typeof parseCmsScheduleRequest>).at, dateNow(), ready.proposal) : ready.proposal;
    const plan = await storePlan(store, site, capability, scheduled ? "cms.schedule.create" : "cms.release.apply", opaque("op"), candidate);
    return plan ? json({ status: "ready", plan }) : error("plan_unavailable", 409);
  }
  const input = parseCmsApplyInput(body, site.siteId);
  if (operation === "cms.release.apply") {
    const plan = await readPlan<CmsReleaseProposal>(store, site, capability, operation, input.operationId, input.confirmationToken);
    if (!plan) return notFound();
    const checked = checkCmsReleaseApply(siteScope(site), input, { ...plan, operation }, dateNow(),
      await releaseContext(store, site, plan.candidate.snapshot.items));
    if (checked.status !== "allowed") return json(checked, 409);
    const { releaseId, locale } = checked.candidate.snapshot;
    return queueRelease(store, mutation!, checked.candidate, input.confirmationToken,
      { status: "recorded", operationId: input.operationId, result: { releaseId, locale } });
  }
  const plan = await readPlan<CmsSchedule>(store, site, capability, operation, input.operationId, input.confirmationToken);
  if (!plan) return notFound();
  const checked = checkCmsScheduleCreate(siteScope(site), input, { ...plan, operation }, dateNow(),
    await releaseContext(store, site, plan.candidate.proposal.snapshot.items));
  if (checked.status !== "allowed") return json(checked, 409);
  const { proposal, id, at } = checked.candidate;
  return queueRelease(store, mutation!, proposal, input.confirmationToken,
    { status: "recorded", operationId: input.operationId, result: { scheduleId: id, at, releaseId: proposal.snapshot.releaseId } }, checked.candidate);
}

function itemSummary(site: Site, draft: CmsItemRevision, meta: ItemMeta, context: EditorContext) {
  const { values: _values, version: _version, ...summary } = workspaceItem(site, draft, meta, context);
  const schedule = context.jobs.find((job) => job.kind === "schedule" && job.payload.pins.includes(cmsItemKey(meta)));
  return { ...summary, revision: draft.revision, removedAt: meta.removedAt, scheduleId: schedule?.id ?? null };
}

async function readItems(store: CmsStore, site: Site, body: Record<string, unknown>) {
  const { collectionId, deleted, cursor } = body;
  exact(body, cursor === undefined ? ["siteId", "collectionId", "deleted"] : ["siteId", "collectionId", "deleted", "cursor"]);
  if (typeof deleted !== "boolean" || (cursor !== undefined && !tokenId(cursor))) return invalid();
  const id = cmsId(collectionId, "collectionId"), collection = site.state.schema.collections.find(({ id: entry }) => entry === id);
  if (!collection) return notFound();
  const items = Object.values(site.state.items).filter((item) => item.collectionId === collection.id && (item.removedAt !== null) === deleted)
    .sort((a, b) => a.itemId < b.itemId ? -1 : 1);
  let last = "";
  if (typeof cursor === "string") {
    const entry = await store.readToken<{ collectionId: string; deleted: boolean; generation: string | null; last: string }>(site, "cms.read", "cursor", cursor);
    if (!entry || entry.expires <= nowSeconds() || entry.payload.collectionId !== collection.id || entry.payload.deleted !== deleted) return notFound();
    if (entry.payload.generation !== site.generation) return conflict();
    last = entry.payload.last;
  }
  const page = items.filter((item) => item.itemId > last).slice(0, LIST_SIZE + 1);
  const context = await editorContext(store, site, "cms.read");
  const result = await Promise.all(page.slice(0, LIST_SIZE).map(async (item) =>
    itemSummary(site, await store.item(site.siteId, site.state.locale, item), item, context)));
  const nextCursor = page.length > LIST_SIZE
    ? await store.makeToken(site, "cms.read", "cursor", { collectionId, deleted, generation: site.generation, last: page[LIST_SIZE - 1]!.itemId }, nowSeconds() + PREVIEW_TTL)
    : null;
  return json({ collectionId, items: result, nextCursor });
}

async function itemOperation(store: CmsStore, site: Site, operation: Operation, body: Record<string, unknown>, mutation: Mutation | null) {
  if (operation === "cms.items.list") return readItems(store, site, body);
  const id = cmsId(body.collectionId, "collectionId"), collection = site.state.schema.collections.find(({ id: entry }) => entry === id);
  if (!collection) return notFound();
  if (operation === "cms.items.create") {
    exact(body, ["siteId", "collectionId", "contractVersion", "expectedSchemaRevision"]);
    if (body.contractVersion !== 2) return error("unsupported_version", 409);
    if (body.expectedSchemaRevision !== site.state.schema.schemaRevision) return conflict();
    if (!collection.capabilities.create) return forbidden();
    return saveDraft(store, mutation!, { collectionId: collection.id, itemId: opaque("item"), values: parseCmsValues({}, collection), create: true, legacy: false });
  }
  const itemId = cmsId(body.itemId, "itemId");
  const item = storedItem(site, collection.id, itemId);
  if (operation === "cms.items.read") {
    exact(body, ["siteId", "collectionId", "itemId"]);
    if (!item || item.removedAt !== null) return notFound();
    const [draft, context] = await Promise.all([store.item(site.siteId, site.state.locale, item), editorContext(store, site, "cms.read")]);
    return json({ item: draft, summary: itemSummary(site, draft, item, context) });
  }
  if (!item || (operation === "cms.items.restore" ? item.removedAt === null : item.removedAt !== null)) return notFound();
  if (body.contractVersion !== 2) return error("unsupported_version", 409);
  if (body.expectedSchemaRevision !== site.state.schema.schemaRevision || body.expectedRevision !== item.revision) return conflict();
  const action = operation === "cms.items.save" ? "save" : operation === "cms.items.remove" ? "remove" : "restore";
  exact(body, ["siteId", "contractVersion", "expectedSchemaRevision", "expectedRevision", "locale", "collectionId", "itemId", ...(action === "save" ? ["values"] : [])]);
  if (body.locale !== site.state.locale) return notFound();
  if (action === "save") {
    const input = parseCmsDraftWrite(body, site.state.schema, action);
    return saveDraft(store, mutation!, { collectionId: collection.id, itemId, values: input.values, create: false, legacy: false });
  }
  parseCmsDraftWrite(body, site.state.schema, action);
  if (action === "remove") {
    if (!collection.capabilities.remove) return forbidden();
    const { current, jobs } = await editorContext(store, site, "cms.edit"), key = cmsItemKey(item);
    if (current?.items.some((pin) => cmsItemKey(pin) === key) || jobs.some((job) => job.payload.pins.includes(key))) return conflict();
  }
  const next = { ...item, removedAt: action === "remove" ? dateNow() : null, updatedAt: dateNow() };
  return mutate(store, mutation!, { state: { ...site.state, items: { ...site.state.items, [cmsItemKey(item)]: next } },
    result: { status: action === "remove" ? "removed" : "restored" } });
}

async function localizationOperation(store: CmsStore, site: Site, operation: Operation, body: Record<string, unknown>, mutation: Mutation | null) {
  if (operation === "cms.localization.overview" || operation === "cms.localization.items.list") {
    exact(body, ["siteId"]);
    const views = await cmsLocalizationViews(store, site);
    if (operation === "cms.localization.overview") return json({ status: "ready", overview: cmsLocalizationOverview({
      schema: site.state.schema, sourceLocale: site.state.locale, views, canEdit: site.role === "owner" || site.role === "editor"
    }) });
    const items = views.map(cmsLocalizationSummary).sort((a, b) => a.groupId.localeCompare(b.groupId) || a.key.localeCompare(b.key));
    return json({ status: "ready", items, nextCursor: null });
  }
  if (operation === "cms.localization.items.read") {
    exact(body, ["siteId", "itemKey"]);
    const identity = parseCmsLocalizationItemKey(body.itemKey), targetLocale = cmsLocalizationTargetLocale(site.state.locale);
    const view = await cmsLocalizationView(store, site, identity.collectionId, identity.itemId, targetLocale);
    return view ? json({ status: "ready", item: cmsLocalizationItem(view) }) : json({ status: "not_found" }, 404);
  }
  if (operation !== "cms.localization.items.command") return notFound();
  const input = parseEditingLocalizationInput("localization.items.command", Object.fromEntries(Object.entries(body).filter(([key]) => key !== "siteId")));
  if (input.operationId !== mutation?.operationId) return invalid();
  const identity = parseCmsLocalizationItemKey(input.itemKey), targetLocale = cmsLocalizationTargetLocale(site.state.locale);
  const view = await cmsLocalizationView(store, site, identity.collectionId, identity.itemId, targetLocale);
  if (!view) return notFound();
  const item = cmsLocalizationItem(view), unit = item.units.find((entry) => entry.unitId === input.unitId);
  if (!unit) return notFound();
  const field = view.collection.fields.find((entry) => entry.unitId === input.unitId);
  if (!field) return notFound();
  const conflictResult = (current: CmsLocalizationView) => {
    const currentItem = cmsLocalizationItem(current), currentUnit = currentItem.units.find((entry) => entry.unitId === input.unitId);
    return currentUnit ? json({ status: "conflict", unit: currentUnit, summary: cmsLocalizationSummary(current) }, 409) : notFound();
  };
  if (input.expectedSourceVersion !== view.source.revision || input.expectedVersion !== String(view.overlay.version)) return conflictResult(view);
  let overlay: CmsLocalizationOverlay;
  switch (input.action) {
    case "set-value":
      overlay = editCmsLocalizedValue(view.overlay, view.collection, { fieldId: field.identity.fieldId, value: input.value, expectedVersion: view.overlay.version });
      break;
    case "review-current":
      overlay = reviewCmsLocalizedValue(view.overlay, view.collection, { fieldId: field.identity.fieldId, expectedVersion: view.overlay.version });
      break;
    case "adopt-candidate": {
      const candidate = "candidate" in unit && unit.candidate?.candidateId === input.candidateId ? unit.candidate : null;
      if (!candidate) return conflictResult(view);
      overlay = editCmsLocalizedValue(view.overlay, view.collection, { fieldId: field.identity.fieldId, value: candidate.value, expectedVersion: view.overlay.version });
      break;
    }
    case "clear-value":
      overlay = parseCmsLocalizationOverlay({ ...view.overlay, version: view.overlay.version + 1,
        entries: view.overlay.entries.filter((entry) => entry.unitId !== input.unitId) }, view.collection);
      break;
    default:
      return json({ status: "invalid", message: "CMS 翻訳ではこの操作を使えません。" }, 422);
  }
  const itemKey = cmsLocalizationItemKey(identity.collectionId, identity.itemId), revision = await mutationObjectId("loc", mutation!, {
    collectionId: identity.collectionId, itemId: identity.itemId
  });
  const size = blobSize(overlay), retainedBytes = site.state.retainedBytes + size;
  if (retainedBytes > MAX_RETAINED_BYTES) return error("quota_exceeded", 409);
  await store.put(localizationBlobKey(site.siteId, targetLocale, itemKey, revision), overlay);
  const localizations = { ...(site.state.localizations ?? {}), [itemKey]: { revision, version: overlay.version } };
  const nextView = { ...view, overlay };
  const nextItem = cmsLocalizationItem(nextView), nextUnit = nextItem.units.find((entry) => entry.unitId === input.unitId);
  if (!nextUnit) return notFound();
  const result = { status: "applied", unit: nextUnit, summary: cmsLocalizationSummary(nextView) };
  const committed = await store.commit(site, "cms.edit", { operation: mutation!.operation, operationId: mutation!.operationId,
    inputDigest: mutation!.inputDigest, result, state: { ...site.state, localizations, retainedBytes } });
  if (committed) return json(result);
  const repeated = await replay(store, mutation!);
  if (repeated) return repeated;
  const latest = await store.site({ projectId: site.projectId, siteId: site.siteId, actor: site.actor }, "cms.edit");
  if (!latest) return forbidden();
  const current = await cmsLocalizationView(store, latest, identity.collectionId, identity.itemId, targetLocale);
  return current ? conflictResult(current) : notFound();
}

async function localizationReleaseContext(store: CmsStore, site: Site, targetLocale: string,
  revisions: readonly CmsItemRevision[] = []): Promise<CmsReleaseContext> {
  const schema = cmsLocalizedSchema(site.state.schema, targetLocale);
  const [routeTable, fixedRoutes, publicAssets] = await Promise.all([
    store.routeTable(site, "cms.publish", targetLocale), store.fixedRoutes(site, "cms.publish", targetLocale),
    store.publicAssets(schema, revisions)
  ]);
  const revisionByKey = new Map(revisions.map((item) => [cmsItemKey(item), item]));
  return {
    schema, locale: targetLocale, sourceLocale: site.state.locale,
    currentReleaseId: site.state.localizedReleases?.[targetLocale]?.id ?? null, routeTable, publicAssets,
    readRevision: (pin) => revisionByKey.get(cmsItemKey(pin)), isRemoved: () => false,
    impact: (snapshot) => releaseImpacts(snapshot, fixedRoutes),
    publicRichText: ({ html }) => escapeHtml(html)
  };
}

function cmsLocalizedSchema(schema: CmsSchema, targetLocale: string): CmsSchema {
  const root = `/${targetLocale}/cms`;
  return { ...schema, collections: schema.collections.map((collection) => {
    if (collection.pathPrefix === null) return collection;
    let relative = collection.pathPrefix.replace(/^\/cms(?=\/)/u, "");
    if (relative === "/") relative = `/${collection.id.toLowerCase()}/`;
    if (!relative.startsWith("/")) relative = `/${relative}`;
    return { ...collection, pathPrefix: `${root}${relative}` };
  }) };
}

type CmsLocalizationReleasePlan =
  | { readonly status: "ready"; readonly proposal: CmsReleaseProposal; readonly revisions: readonly CmsItemRevision[];
      readonly omittedItems: readonly { readonly collectionId: string; readonly itemId: string; readonly missingFieldIds: readonly string[] }[] }
  | { readonly status: "invalid"; readonly problems: readonly CmsProblem[] }
  | { readonly status: "conflict" };

async function planCmsLocalizationRelease(input: {
  readonly schema: CmsSchema;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly sourceItems: readonly CmsItemRevision[];
  readonly overlays: readonly CmsLocalizationOverlay[];
  readonly targetRevisions: readonly { readonly collectionId: string; readonly itemId: string; readonly revision: string }[];
  readonly redirects: CmsReleaseInput["redirects"];
  readonly routeTableRevision: string;
  readonly expectedReleaseId: string | null;
  readonly releaseId: string;
  readonly context: CmsReleaseContext;
  readonly publicAssets: (schema: CmsSchema, items: readonly CmsItemRevision[]) => Promise<readonly CmsPublicAsset[]>;
}): Promise<CmsLocalizationReleasePlan> {
  if (input.sourceItems.length !== input.overlays.length || input.sourceItems.length !== input.targetRevisions.length) return { status: "conflict" };
  const revisions: CmsItemRevision[] = [], omittedItems: { collectionId: string; itemId: string; missingFieldIds: readonly string[] }[] = [], problems: CmsProblem[] = [];
  for (let index = 0; index < input.sourceItems.length; index++) {
    const source = input.sourceItems[index]!, overlay = input.overlays[index]!, target = input.targetRevisions[index]!;
    if (target.collectionId !== source.collectionId || target.itemId !== source.itemId) return { status: "conflict" };
    const collection = await collectCmsLocalizationUnits(input.schema, source, input.targetLocale);
    const status = cmsLocalizationStatus(overlay, collection);
    if (!status.complete) {
      const stateByUnit = new Map(status.details.map(({ unitId, state }) => [unitId, state]));
      const missingFieldIds = [...collection.fields.filter(({ unitId }) => stateByUnit.get(unitId) !== "reviewed").map(({ identity }) => identity.fieldId),
        ...collection.issues.map(({ fieldId }) => fieldId)];
      omittedItems.push({ collectionId: source.collectionId, itemId: source.itemId, missingFieldIds: [...new Set(missingFieldIds)] });
      continue;
    }
    const materialized = materializeCmsLocalizedItem(overlay, collection, { revision: target.revision, fallback: "omit" });
    if (materialized.status === "omitted") {
      omittedItems.push({ collectionId: source.collectionId, itemId: source.itemId, missingFieldIds: materialized.missingFieldIds });
    } else if (materialized.status === "invalid") {
      problems.push(...materialized.problems.map((problem) => ({ ...problem, collectionId: source.collectionId, itemId: source.itemId })));
    } else revisions.push(materialized.item);
  }
  if (problems.length) return { status: "invalid", problems };
  const schema = cmsLocalizedSchema(input.schema, input.targetLocale);
  const revisionByKey = new Map(revisions.map((item) => [cmsItemKey(item), item]));
  const planned = planCmsRelease({ siteId: schema.siteId, locale: input.targetLocale, schemaRevision: schema.schemaRevision,
    routeTableRevision: input.routeTableRevision, expectedReleaseId: input.expectedReleaseId,
    items: revisions.map(({ collectionId, itemId, revision }) => ({ collectionId, itemId, revision })), redirects: input.redirects },
  input.releaseId, { ...input.context, schema, locale: input.targetLocale, sourceLocale: input.sourceLocale,
    publicAssets: await input.publicAssets(schema, revisions), readRevision: (pin) => revisionByKey.get(cmsItemKey(pin)) });
  if (planned.status !== "ready") return planned.status === "invalid"
    ? { status: "invalid", problems: planned.problems } : { status: "conflict" };
  return { status: "ready", proposal: planned.proposal, revisions, omittedItems };
}

type CmsLocalizationReleaseCandidate = {
  readonly proposal: CmsReleaseProposal;
  readonly revisions: readonly CmsItemRevision[];
  readonly expectedGeneration: string | null;
  readonly targetLocale: string;
  readonly omittedItems: readonly { readonly collectionId: string; readonly itemId: string; readonly missingFieldIds: readonly string[] }[];
};

async function localizationReleaseOperation(store: CmsStore, site: Site, operation: Operation,
  body: Record<string, unknown>, mutation: Mutation | null) {
  const targetLocale = cmsLocalizationTargetLocale(site.state.locale);
  if (operation === "cms.localization.release.current") {
    exact(body, ["siteId"]);
    const current = site.state.localizedReleases?.[targetLocale] ?? null;
    return json({ snapshot: current ? await store.snapshot(site.siteId, current.id) : null, sourceLocale: site.state.locale,
      locale: targetLocale, releaseId: current?.id ?? null, routeTableRevision: (await store.routeTable(site, "cms.read", targetLocale)).revision,
      collectionRoot: `/s/${site.slug}/${targetLocale}/cms` });
  }
  if (operation === "cms.localization.release.plan") {
    exact(body, body.operationId === undefined ? ["siteId"] : ["siteId", "operationId"]);
    const sourceSnapshot = await currentSnapshot(store, site);
    if (sourceSnapshot && sourceSnapshot.locale !== site.state.locale) return conflict();
    const sourceItems = sourceSnapshot ? await Promise.all(sourceSnapshot.items.map((pin) => store.item(site.siteId, site.state.locale, pin))) : [];
    const collections = await Promise.all(sourceItems.map((item) => collectCmsLocalizationUnits(site.state.schema, item, targetLocale)));
    const overlays = await Promise.all(collections.map((collection) => cmsLocalizationOverlay(store, site, collection)));
    const targetRevisions = sourceItems.map((item) => ({ collectionId: item.collectionId, itemId: item.itemId, revision: opaque("rev") }));
    const context = await localizationReleaseContext(store, site, targetLocale);
    const planned = await planCmsLocalizationRelease({ schema: site.state.schema, sourceLocale: site.state.locale, targetLocale,
      sourceItems, overlays, targetRevisions, redirects: [], routeTableRevision: context.routeTable.revision,
      expectedReleaseId: context.currentReleaseId, releaseId: opaque("release"), context,
      publicAssets: (schema, items) => store.publicAssets(schema, items) });
    if (planned.status === "conflict") return conflict();
    if (planned.status === "invalid") return json(planned, 422);
    const candidate: CmsLocalizationReleaseCandidate = { proposal: planned.proposal, revisions: planned.revisions, expectedGeneration: site.generation,
      targetLocale, omittedItems: planned.omittedItems.map(({ collectionId, itemId, missingFieldIds }) => ({ collectionId, itemId, missingFieldIds })) };
    const saved = await storePlan(store, site, "cms.publish", "cms.localization.release.apply",
      body.operationId === undefined ? opaque("op") : parseOperationId(body.operationId), candidate);
    if (!saved) return error("plan_unavailable", 409);
    return json({ status: "ready", plan: saved, locale: targetLocale, releaseId: planned.proposal.snapshot.releaseId,
      includedItems: planned.proposal.snapshot.items.length, omittedItems: planned.omittedItems });
  }
  if (operation !== "cms.localization.release.apply") return notFound();
  exact(body, body.operationId === undefined ? ["siteId", "confirmationToken"] : ["siteId", "operationId", "confirmationToken"]);
  if (body.operationId !== undefined && body.operationId !== mutation?.operationId) return invalid();
  if (typeof body.confirmationToken !== "string" || !mutation) return invalid();
  const saved = await store.readToken<{ operationId: string; candidate: CmsLocalizationReleaseCandidate }>(
    site, "cms.publish", operation, body.confirmationToken);
  if (!saved || saved.expires <= nowSeconds()) return notFound();
  const candidate = saved.payload.candidate, current = site.state.localizedReleases?.[targetLocale] ?? null;
  if (candidate.targetLocale !== targetLocale || candidate.expectedGeneration !== site.generation
    || (current?.id ?? null) !== candidate.proposal.expectedReleaseId) return conflict();
  const context = await localizationReleaseContext(store, site, targetLocale, candidate.revisions);
  const checked = revalidateCmsRelease(candidate.proposal, context);
  if (checked.status !== "allowed") return conflict();
  const snapshot = checked.candidate.snapshot, revisions = candidate.revisions;
  if (revisions.length !== snapshot.items.length || revisions.some((item) => !snapshot.items.some((entry) =>
    entry.collectionId === item.collectionId && entry.itemId === item.itemId && entry.revision === item.revision && entry.locale === targetLocale))) return conflict();
  const snapshotBytes = blobSize(snapshot), routeBytes = blobSize(snapshot.routeTable), itemBytes = revisions.reduce((sum, item) => sum + blobSize(item), 0);
  const retainedBytes = site.state.retainedBytes + snapshotBytes + routeBytes + itemBytes;
  if (snapshotBytes > MAX_SNAPSHOT || retainedBytes > MAX_RETAINED_BYTES) return error("quota_exceeded", 409);
  await Promise.all([
    store.put(routeTableKey(site.siteId, targetLocale, snapshot.routeTable.revision), snapshot.routeTable),
    store.put(snapshotKey(site.siteId, snapshot.releaseId), snapshot),
    ...revisions.map((item) => store.put(itemBlobKey(site.siteId, targetLocale, item), item))
  ]);
  if (await digest(await store.snapshot(site.siteId, snapshot.releaseId)) !== await digest(snapshot))
    throw new Error("CMS localized snapshot verification failed");
  const localizedReleases = { ...(site.state.localizedReleases ?? {}), [targetLocale]: {
    id: snapshot.releaseId, at: dateNow(), routeTableRevision: snapshot.routeTable.revision
  } };
  const result = { status: "published", operationId: mutation.operationId, result: { releaseId: snapshot.releaseId,
    locale: targetLocale, itemCount: snapshot.items.length, omittedItems: candidate.omittedItems } };
  return mutate(store, mutation!, { state: { ...site.state, localizedReleases, retainedBytes }, revisions,
    publishedSnapshot: snapshot, tokenHash: await digest(body.confirmationToken),
    job: { kind: "verify", id: opaque("verify"), at: nowSeconds(), payload: { keys: [
      snapshotKey(site.siteId, snapshot.releaseId), routeTableKey(site.siteId, targetLocale, snapshot.routeTable.revision),
      ...revisions.map((item) => itemBlobKey(site.siteId, targetLocale, item))
    ] } }, result });
}

async function previewOperation(store: CmsStore, site: Site, operation: "cms.preview.prepare" | "cms.preview.read", body: Record<string, unknown>) {
  if (operation === "cms.preview.prepare") {
    exact(body, ["siteId", "collectionId", "itemId", "revision"]);
    const item = storedItem(site, cmsId(body.collectionId, "collectionId"), cmsId(body.itemId, "itemId"));
    if (!item || item.removedAt !== null || item.revision !== body.revision) return notFound();
    const expires = nowSeconds() + PREVIEW_TTL;
    const token = await store.makeToken(site, "cms.read", "preview", { ...item, schemaRevision: site.state.schema.schemaRevision }, expires);
    return token ? json({ previewId: token, expiresAt: iso(expires) }) : forbidden();
  }
  exact(body, ["siteId", "previewId"]);
  if (!tokenId(body.previewId)) return invalid();
  const entry = await store.readToken<ItemMeta & { schemaRevision: string }>(site, "cms.read", "preview", body.previewId as string);
  if (!entry || entry.expires <= nowSeconds() || entry.payload.schemaRevision !== site.state.schema.schemaRevision) return notFound();
  const current = storedItem(site, entry.payload.collectionId, entry.payload.itemId);
  if (!current || current.removedAt !== null || current.revision !== entry.payload.revision) return notFound();
  const item = await store.item(site.siteId, site.state.locale, entry.payload);
  if (!await store.consumePreview(site, body.previewId as string)) return notFound();
  return json({ preview: previewContent(site.state.schema, { ...item, path: null }), expiresAt: iso(entry.expires) });
}

async function executeV2(request: Request, store: CmsStore, scope: CmsScope, route: string) {
  const operation = route as Operation;
  const capability = Object.hasOwn(CMS_V2_OPERATIONS, operation) ? CMS_V2_OPERATIONS[operation as CmsV2Operation]
    : Object.hasOwn(EXTRA, operation) ? EXTRA[operation as keyof typeof EXTRA] : null;
  if (!capability && route !== "discover") return notFound();
  if (route === "discover") {
    if (request.method !== "GET") return error("method_not_allowed", 405);
    if (request.body !== null) return invalid();
    if (scope.actor.clientId !== undefined) {
      const capabilities = ["cms.read", "cms.edit", "cms.publish"] as const;
      const granted = await Promise.all(capabilities.map((cap) => store.site(scope, cap)));
      const site = granted.find((entry) => entry !== null);
      return site ? json(discoverCmsContract(site.state.schema, capabilities.filter((_, index) => granted[index] !== null))) : forbidden();
    }
    const site = await store.site(scope, "cms.read");
    return site ? json(discoverCmsContract(site.state.schema, cmsRoleCapabilities(site.role))) : forbidden();
  }
  const site = await store.site(scope, capability!);
  if (!site) return forbidden();
  if (request.method !== "POST") return error("method_not_allowed", 405);
  const maxBody = operation === "cms.release.plan" || operation === "cms.schedule.create"
    ? MAX_RELEASE_BODY : operation === "cms.items.save" ? MAX_ITEM_SAVE_BODY : MAX_BODY;
  const body = await readBody(request, scope, maxBody);
  if (!body || body.siteId !== site.siteId) return invalid();
  const cap = capability!;
  let mutation: Mutation | null = null;
  if (MUTATIONS.has(operation)) {
    if (operation === "cms.localization.release.apply" && typeof body.confirmationToken !== "string") return invalid();
    const header = request.headers.get(OPERATION_KEY_HEADER);
    const operationId = operation === "cms.localization.release.apply"
      ? body.operationId === undefined
        ? `cmsloc_${(await digest(body.confirmationToken)).slice(0, 32)}`
        : parseOperationId(body.operationId)
      : operation === "cms.schema.apply" || operation === "cms.release.apply" || operation === "cms.schedule.create"
        ? parseCmsApplyInput(body, scope.siteId).operationId : parseOperationId(header);
    if (header !== null && header !== operationId) return invalid();
    mutation = { site, capability: cap, operation, operationId, inputDigest: await digest(body) };
    const same = await replay(store, mutation);
    if (same) return same;
  }
  switch (operation) {
    case "cms.schema.read":
      exact(body, ["siteId"]);
      return json(site.state.schema);
    case "cms.schema.plan":
    case "cms.schema.apply":
      return schemaOperation(store, site, cap, operation, body, mutation);
    case "cms.release.plan":
    case "cms.release.apply":
    case "cms.schedule.create":
      return releaseOperation(store, site, cap, operation, body, mutation);
    case "cms.release.status": {
      exact(body, ["siteId", "operationId"]);
      const receipt = await store.receipt(site, cap, parseOperationId(body.operationId));
      if (receipt?.operation !== "cms.release.apply") return json({ status: "not_found" }, 404);
      const delivery = await store.deliveryForReceipt(site, receipt.transaction_id);
      if (!delivery) return json({ status: "not_found" }, 404);
      return json({ ...record(JSON.parse(receipt.result_json), "receipt"), delivery: {
        state: delivery.state, failure: delivery.failure, deliveredAt: delivery.released_at === null ? null : iso(delivery.released_at)
      } });
    }
    case "cms.release.current":
      exact(body, ["siteId"]);
      return json({ snapshot: await currentSnapshot(store, site), locale: site.state.locale,
        routeTableRevision: (await store.routeTable(site, cap)).revision, collectionRoot: `/s/${site.slug}/cms` });
    case "cms.release.snapshot": {
      exact(body, ["siteId", "releaseId"]);
      const snapshot = await store.historicalSnapshot(site, cmsId(body.releaseId, "releaseId"));
      return snapshot ? json({ snapshot }) : notFound();
    }
    case "cms.preview.prepare":
    case "cms.preview.read":
      return previewOperation(store, site, operation, body);
    case "cms.localization.overview":
    case "cms.localization.items.list":
    case "cms.localization.items.read":
    case "cms.localization.items.command":
      return localizationOperation(store, site, operation, body, mutation);
    case "cms.localization.release.current":
    case "cms.localization.release.plan":
    case "cms.localization.release.apply":
      return localizationReleaseOperation(store, site, operation, body, mutation);
    case "cms.schedule.status":
    case "cms.schedule.cancel": {
      exact(body, ["siteId", "scheduleId"]);
      const id = cmsId(body.scheduleId, "scheduleId");
      const [job] = await store.jobs(site, cap, id);
      if (!job || job.kind !== "schedule") return notFound();
      if (operation === "cms.schedule.cancel") {
        if (job.state !== "pending") return conflict();
        return mutate(store, mutation!, { state: site.state, result: { status: "cancelled" }, cancel: id });
      }
      const { releaseId } = JSON.parse(job.payload_json) as Extract<JobPayload, { releaseId: string }>;
      const status = { pending: "scheduled", delivered: "released", dead: "failed", cancelled: "cancelled" }[job.state];
      return json({ status, schedule: { scheduleId: id, at: iso(job.scheduled_at), releaseId } });
    }
    default:
      return itemOperation(store, site, operation, body, mutation);
  }
}

function legacyFields(site: Site, problems: readonly CmsProblem[]) {
  return problems.map((problem) => ({ field: site.state.schema.collections.find(({ id }) => id === problem.collectionId)?.fields
    .find(({ fieldId }) => fieldId === problem.fieldId)?.key ?? "_base", message: problem.message }));
}

type LegacyPlan = { expectedVersion: string; collectionId: string; itemId: string; redirect?: boolean; proposal: CmsReleaseProposal };
async function legacyPublish(store: CmsStore, site: Site, operation: "cms.publish-plan" | "cms.publish",
  draft: CmsItemRevision, item: CollectionItem, body: Record<string, unknown>, mutation: Mutation, context: EditorContext) {
  exact(body, ["expectedVersion", "operationId", ...(operation === "cms.publish" ? ["confirmationToken"] : []), ...(Object.hasOwn(body, "redirect") ? ["redirect"] : [])]);
  if (body.redirect !== undefined && typeof body.redirect !== "boolean") return invalid();
  if (body.expectedVersion !== draft.revision) return error("version_conflict", 409);
  const { collectionId, itemId } = draft, key = cmsItemKey(draft);
  if (operation === "cms.publish-plan") {
    const before = context.current?.items.find((entry) => cmsItemKey(entry) === key)?.path;
    const after = item.path;
    const currentRedirects = (context.current?.redirects ?? []).flatMap((redirect) => {
      if (redirect.from === after) return [];
      if (redirect.to === before && before !== after) return body.redirect && after ? [{ from: redirect.from, to: after }] : [];
      return [redirect];
    });
    const redirects = body.redirect && before && after && before !== after ? [...currentRedirects, { from: before, to: after }] : currentRedirects;
    const items = [...(context.current?.items ?? []).filter((entry) => cmsItemKey(entry) !== key), draft]
      .map(({ collectionId, itemId, revision }) => ({ collectionId, itemId, revision }));
    const ready = planCmsRelease({ siteId: site.siteId, locale: site.state.locale, schemaRevision: site.state.schema.schemaRevision,
      routeTableRevision: (await store.routeTable(site, "cms.publish")).revision,
      expectedReleaseId: context.current?.releaseId ?? null, items, redirects }, opaque("release"), await releaseContext(store, site, items));
    if (ready.status === "conflict") return error("version_conflict", 409);
    if (ready.status === "invalid") return json({ error: "validation_failed", fields: legacyFields(site, ready.problems) }, 422);
    const redirect = body.redirect === undefined ? {} : { redirect: body.redirect };
    const plan = await storePlan<LegacyPlan>(store, site, "cms.publish", "cms.publish", mutation.operationId,
      { expectedVersion: draft.revision, collectionId, itemId, ...redirect, proposal: ready.proposal });
    return plan ? json({ plan: { target: { siteId: site.siteId, collectionId, itemId }, expectedVersion: draft.revision,
      operationId: mutation.operationId, confirmationToken: plan.confirmationToken, item, ...redirect } }) : error("plan_unavailable", 409);
  }
  const plan = await readPlan<LegacyPlan>(store, site, "cms.publish", "cms.publish", mutation.operationId, body.confirmationToken);
  if (!plan) return notFound();
  const { candidate } = plan;
  if (candidate.expectedVersion !== draft.revision || candidate.collectionId !== collectionId || candidate.itemId !== itemId || candidate.redirect !== body.redirect)
    return error("version_conflict", 409);
  const input = { siteId: site.siteId, operationId: mutation.operationId, confirmationToken: plan.confirmationToken };
  const checked = checkCmsReleaseApply(siteScope(site), input, { ...plan, operation: "cms.release.apply", candidate: candidate.proposal }, dateNow(),
    await releaseContext(store, site, candidate.proposal.snapshot.items));
  if (checked.status !== "allowed") return error("version_conflict", 409);
  return queueRelease(store, mutation, checked.candidate, input.confirmationToken,
    { status: "publishing", operationId: mutation.operationId, item: { ...item, status: "publishing" } });
}

export function managedCmsLegacySpec(operation: string) {
  return Object.hasOwn(LEGACY, operation) ? LEGACY[operation as LegacyOp] : null;
}

async function executeLegacy(request: Request, store: CmsStore, scope: CmsScope, route: string) {
  const [name, ...args] = route.split("/"), operation = name as LegacyOp, spec = managedCmsLegacySpec(operation);
  if (!spec || args.length !== spec[2]) return notFound();
  const [method, capability] = spec;
  if (request.method !== method) return error("method_not_allowed", 405);
  const site = await store.site(scope, capability);
  if (!site) return forbidden();
  if (method === "GET" && request.body !== null) return invalid();
  if (operation === "cms.schema") return json({ collections: cmsLegacyCollections(site.state.schema) });
  if (operation === "cms.operation-status") {
    const id = args[0]!;
    if (!UUID_V4.test(id.toLowerCase())) return invalid();
    const receipt = await store.receipt(site, capability, id);
    if (!receipt) return json({ status: "unknown", operationId: id });
    const result = JSON.parse(receipt.result_json) as { item?: CollectionItem };
    if (receipt.operation === "cms.publish") {
      const delivery = await store.deliveryForReceipt(site, receipt.transaction_id);
      if (!delivery || delivery.state === "pending") return json({ status: "received", operationId: id });
      if (delivery.state !== "delivered") {
        const changed = delivery.failure === "conflict";
        return json({ status: "completed", operationId: id, httpStatus: changed ? 409 : 503,
          result: { error: changed ? "version_conflict" : "host_failure" } });
      }
      return json({ status: "completed", operationId: id, httpStatus: 200,
        result: { status: "published", operationId: id, item: { ...result.item, status: "published", publishedAt: iso(delivery.released_at!) } } });
    }
    return json({ status: "completed", operationId: id, httpStatus: 200, result });
  }
  let body: Record<string, unknown> | null = null, mutation: Mutation | null = null;
  if (method !== "GET") {
    const requestedVersion = request.headers.get(VERSION_HEADER) === "2" ? 2 : undefined;
    if (checkCmsWriteVersion(site.state.schema, requestedVersion, site.state.schema.schemaRevision).status !== "allowed")
      return error("unsupported_version", 409);
    body = await readBody(request, scope);
    if (!body || typeof body.operationId !== "string" || !UUID_V4.test(body.operationId.toLowerCase())) return invalid();
    const header = request.headers.get(OPERATION_KEY_HEADER);
    if (header !== null && header !== body.operationId) return invalid();
    mutation = { site, capability, operation, operationId: body.operationId, inputDigest: await digest({ args, body }) };
    const same = await replay(store, mutation);
    if (same) return same;
  }
  const collectionId = cmsId(args[0], "collectionId"), collection = site.state.schema.collections.find(({ id }) => id === collectionId);
  if (!collection) return notFound();
  if (operation === "cms.create") {
    exact(body!, ["operationId"]);
    if (!collection.capabilities.create) return forbidden();
    return saveDraft(store, mutation!, { collectionId, itemId: opaque("item"), values: parseCmsValues({}, collection), create: true, legacy: true });
  }
  const context = await editorContext(store, site, capability);
  if (operation === "cms.list") {
    const items = await Promise.all(Object.values(site.state.items).filter((item) => item.collectionId === collectionId && item.removedAt === null)
      .map(async (meta) => {
        const { version: _version, values: _values, ...summary } = workspaceItem(site, await store.item(site.siteId, site.state.locale, meta), meta, context);
        return summary;
      }));
    return json({ collectionId, items });
  }
  const itemId = cmsId(args[1], "itemId"), meta = storedItem(site, collectionId, itemId);
  if (!meta || meta.removedAt !== null) return notFound();
  const draft = await store.item(site.siteId, site.state.locale, meta), item = workspaceItem(site, draft, meta, context);
  if (operation === "cms.read") return json({ item });
  if (operation === "cms.save") {
    exact(body!, ["expectedVersion", "operationId", "values"]);
    if (body!.expectedVersion !== draft.revision) return json({ error: "version_conflict", current: item }, 409);
    const definition = cmsLegacyCollections(site.state.schema).find(({ id }) => id === collectionId)!;
    const rawValues = record(body!.values, "values");
    keys(rawValues, definition.fields.map(({ key }) => key), "values");
    const normalized = parseCollectionValues(rawValues, definition);
    const values = parseCmsValues(Object.fromEntries(collection.fields.map(({ fieldId, key }) => [fieldId, normalized[key]])), collection);
    return saveDraft(store, mutation!, { collectionId, itemId, values, create: false, legacy: true });
  }
  return legacyPublish(store, site, operation, draft, item, body!, mutation!, context);
}

export async function managedCmsApi(request: Request, store: CmsStore, scope: CmsScope, operation: string, version: 1 | 2) {
  if (new URL(request.url).search) return invalid();
  try {
    return version === 2 ? await executeV2(request, store, scope, operation) : await executeLegacy(request, store, scope, operation);
  } catch (failure) {
    if (failure instanceof DocumentValidationError) return invalid();
    throw failure;
  }
}
