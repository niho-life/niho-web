import { isIsoTimestamp, parseCollectionItem, type CollectionItem, type CollectionItemStatus, type CollectionValue } from "./collection-model.js";
import { validatePagePath } from "./pages.js";
import { fail, keys, localeCode, record } from "./validation-utils.js";
import { CMS_ROUTE_RESERVATION_LIMIT, parseCmsRoutePath, parseCmsRouteRevision, parseCmsRouteTable, planCmsRouteTable, type CmsRouteTable } from "./cms-v2-routes.js";
import {
  cmsArray, cmsCollection, cmsId, cmsItemKey, cmsLegacyCollections, cmsLegacyValues, cmsReferenceProblems, cmsValueProblems,
  parseCmsItemRevision, parseCmsSchema, uniqueCmsKeys, type CmsItemKey, type CmsItemRevision, type CmsProblem, type CmsSchema
} from "./cms-v2-schema.js";

export type CmsReleasePin = CmsItemKey & { readonly revision: string };
export type CmsRedirect = { readonly from: string; readonly to: string };
export type CmsReleaseInput = {
  readonly siteId: string;
  readonly locale: string;
  readonly schemaRevision: string;
  readonly routeTableRevision: string;
  readonly expectedReleaseId: string | null;
  readonly items: readonly CmsReleasePin[];
  readonly redirects: readonly CmsRedirect[];
};
export type CmsReleaseEntry = CmsItemRevision & { readonly path: string | null };
export type CmsReleaseSnapshot = {
  readonly contractVersion: 2;
  readonly releaseId: string;
  readonly siteId: string;
  readonly locale: string;
  /** Present for a translated CMS snapshot whose routes are prefixed by its locale. */
  readonly sourceLocale?: string;
  /** Route registry used to validate this release. */
  readonly routeTableRevision: string;
  /** Complete route registry that will be published with this release. */
  readonly routeTable: CmsRouteTable;
  readonly schema: CmsSchema;
  readonly items: readonly CmsReleaseEntry[];
  readonly redirects: readonly CmsRedirect[];
};

function cmsRouteRevision(releaseId: string): string {
  const prefixed = `route_${releaseId}`;
  if (prefixed.length <= 128) return prefixed;
  let hash = 0xcbf29ce484222325n;
  for (const character of releaseId) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `route_${hash.toString(36)}`;
}
function cmsRouteReservationId(locale: string, collectionId: string): string {
  let hash = 0x811c9dc5;
  for (const character of collectionId) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  return `cms_route_${locale}_${collectionId.slice(0, 36)}_${hash.toString(36)}`;
}
export type CmsReleaseImpact = (snapshot: CmsReleaseSnapshot) => readonly CmsProblem[];
export type CmsReleaseContext = {
  readonly schema: CmsSchema;
  readonly locale: string;
  readonly sourceLocale?: string;
  readonly currentReleaseId: string | null;
  readonly routeTable: CmsRouteTable;
  readonly readRevision: (item: CmsReleasePin) => unknown;
  readonly isRemoved: (item: CmsItemKey) => boolean;
  /** Host checks fixed routes, templates, external resources, and the designated public representation of rich text. */
  readonly impact?: CmsReleaseImpact;
  /** Hosts must sanitize and approve public references before returning HTML here. */
  readonly publicRichText?: (input: CmsItemKey & { readonly fieldId: string; readonly html: string }) => string;
};
export type CmsReleaseProposal = {
  readonly expectedReleaseId: string | null;
  readonly snapshot: CmsReleaseSnapshot;
};
export type CmsReleasePlan = { readonly status: "ready"; readonly proposal: CmsReleaseProposal }
  | { readonly status: "invalid"; readonly problems: readonly CmsProblem[] }
  | { readonly status: "conflict" };

export function cmsTimestamp(input: unknown, path: string): string {
  if (!isIsoTimestamp(input)) fail(path, "invalid CMS timestamp");
  return new Date(input).toISOString();
}
function parsePin(input: unknown, path: string): CmsReleasePin {
  const value = record(input, path);
  keys(value, ["collectionId", "itemId", "revision"], path);
  return { collectionId: cmsId(value.collectionId, `${path}.collectionId`), itemId: cmsId(value.itemId, `${path}.itemId`), revision: cmsId(value.revision, `${path}.revision`) };
}
export function parseCmsReleaseInput(input: unknown): CmsReleaseInput {
  const value = record(input, "release");
  keys(value, ["siteId", "locale", "schemaRevision", "routeTableRevision", "expectedReleaseId", "items", "redirects"], "release");
  const items = cmsArray(value.items, "release.items", 25_000).map((entry, i) => parsePin(entry, `release.items[${i}]`));
  uniqueCmsKeys(items.map(cmsItemKey), "release.items");
  const redirects = cmsArray(value.redirects, "release.redirects", 25_000).map((entry, i) => {
    const at = `release.redirects[${i}]`, redirect = record(entry, at);
    keys(redirect, ["from", "to"], at);
    return { from: parseCmsRoutePath(redirect.from, `${at}.from`), to: parseCmsRoutePath(redirect.to, `${at}.to`) };
  });
  uniqueCmsKeys(redirects.map(({ from }) => from), "release.redirects");
  return {
    siteId: cmsId(value.siteId, "release.siteId"), schemaRevision: cmsId(value.schemaRevision, "release.schemaRevision"),
    routeTableRevision: parseCmsRouteRevision(value.routeTableRevision, "release.routeTableRevision"),
    locale: localeCode(value.locale, "release.locale"), expectedReleaseId: value.expectedReleaseId === null ? null : cmsId(value.expectedReleaseId, "release.expectedReleaseId"),
    items, redirects
  };
}
function freezeJson<T>(input: T): T {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) freezeJson(value);
    Object.freeze(input);
  }
  return input;
}

/** Build one complete locale snapshot from exact selected revisions. Host authorization precedes this call. */
export function planCmsRelease(input: unknown, releaseIdInput: string, context: CmsReleaseContext): CmsReleasePlan {
  const selection = parseCmsReleaseInput(input), schema = parseCmsSchema(context.schema);
  const releaseId = cmsId(releaseIdInput, "release.releaseId");
  if (selection.siteId !== schema.siteId || selection.locale !== context.locale) fail("release", "CMS site or locale mismatch");
  const currentRoutes = parseCmsRouteTable(context.routeTable, schema.siteId, selection.locale);
  if (selection.schemaRevision !== schema.schemaRevision || selection.expectedReleaseId !== context.currentReleaseId) return { status: "conflict" };
  if (selection.routeTableRevision !== currentRoutes.revision) return { status: "conflict" };
  if (releaseId === selection.expectedReleaseId) fail("release.releaseId", "release ID cannot be reused");
  const problems: CmsProblem[] = [], items: CmsReleaseEntry[] = [];
  for (const pin of selection.items) {
    const target = { collectionId: pin.collectionId, itemId: pin.itemId };
    const raw = context.readRevision(pin);
    if (raw === null || raw === undefined || context.isRemoved(pin)) {
      problems.push({ ...target, code: "value", message: "選択した版を公開できません。" });
      continue;
    }
    const item = parseCmsItemRevision(raw, schema);
    if (item.locale !== selection.locale || item.revision !== pin.revision || cmsItemKey(item) !== cmsItemKey(pin)) fail("release.items", "CMS item identity or revision mismatch");
    const collection = cmsCollection(schema, item.collectionId), values: Record<string, CollectionValue> = { ...item.values };
    for (const field of collection.fields) {
      const value = values[field.fieldId];
      // The public asset manifest resolves these stable references in later hosts.
      if ((field.type === "image" && typeof value === "string") || (field.type === "gallery" && Array.isArray(value) && value.some((entry) => typeof entry === "object" && typeof entry.image === "string"))) {
        problems.push({ ...target, fieldId: field.fieldId, code: "value", message: "公開素材を選び直してください。" });
      }
      if (field.type === "richText" && typeof value === "string" && value !== "") {
        if (!context.publicRichText) {
          problems.push({ ...target, fieldId: field.fieldId, code: "value", message: "本文の公開変換が必要です。" });
        } else {
          const html = context.publicRichText({ ...target, fieldId: field.fieldId, html: value });
          if (typeof html !== "string" || html.length > 2_000_000) fail("release.items", "invalid public rich text");
          values[field.fieldId] = html;
        }
      }
    }
    const slug = collection.slugField === null ? null : values[collection.slugField];
    const candidate = collection.pathPrefix === null ? null : `${collection.pathPrefix}${String(slug ?? "")}`;
    const path = candidate !== null && typeof slug === "string" && slug.length > 0 && validatePagePath(candidate) === null ? candidate : null;
    if (candidate !== null && path === null) problems.push({ ...target, code: "route", message: "公開 URL に使えるスラッグを入力してください。" });
    problems.push(...cmsValueProblems(collection, values).map((problem) => ({ ...problem, ...target })));
    items.push({ ...item, values, path });
  }
  const routes = items.filter((item) => item.path !== null).map(({ collectionId, itemId, path }) => ({ collectionId, itemId, path: path! }));
  const routeByItemKey = new Map(routes.map((route) => [cmsItemKey(route), route]));
  const explicitRedirectTargets = new Map(selection.redirects.map(({ from, to }) => [from, to]));
  const generatedRedirects = currentRoutes.reservations.flatMap((reservation) => {
    if (reservation.kind !== "cms-item") return [];
    const next = routeByItemKey.get(cmsItemKey(reservation));
    if (!next || reservation.path === next.path) return [];
    return [{ from: reservation.path, to: next.path }];
  }).filter((generated) => explicitRedirectTargets.get(generated.from) !== generated.to);
  if (generatedRedirects.length + selection.redirects.length > 25_000) {
    return { status: "invalid", problems: [{ code: "route", message: "公開転送の件数が上限を超えています。" }] };
  }
  const retainedReservations = currentRoutes.reservations.filter((reservation) => reservation.kind !== "cms-item"
    && !(reservation.kind === "redirect" && reservation.owner === "cms")
    && !(reservation.kind === "reserved" && reservation.reservationId.startsWith("cms_route_")));
  if (retainedReservations.length + routes.length + generatedRedirects.length + selection.redirects.length > CMS_ROUTE_RESERVATION_LIMIT) {
    return { status: "invalid", problems: [{ code: "route", message: "CMS ルート表の予約件数が上限を超えています。" }] };
  }
  const routePlan = planCmsRouteTable({ current: currentRoutes, siteId: schema.siteId, locale: selection.locale,
    expectedRevision: selection.routeTableRevision, nextRevision: cmsRouteRevision(releaseId),
    routes, redirects: [...generatedRedirects, ...selection.redirects] });
  if ("status" in routePlan) return { status: "conflict" };
  const redirects = routePlan.table.reservations.flatMap((reservation) => reservation.kind === "redirect" && reservation.owner === "cms"
    ? [{ from: reservation.path, to: reservation.targetPath }] : []);
  const routeRoot = context.sourceLocale && context.sourceLocale !== selection.locale ? `/${selection.locale}/cms` : "/cms";
  const listRoutes = schema.collections.flatMap(({ id, pathPrefix }) => pathPrefix === null ? [] : [{
    kind: "reserved" as const, path: pathPrefix.slice(0, -1), reservationId: cmsRouteReservationId(selection.locale, id)
  }]);
  const cmsRoutes = [{ kind: "reserved" as const, path: routeRoot, reservationId: `cms_route_${selection.locale}_root` }, ...listRoutes];
  const routeTable = parseCmsRouteTable({ ...routePlan.table, reservations: [...routePlan.table.reservations, ...cmsRoutes] }, schema.siteId, selection.locale);
  const snapshot = freezeJson<CmsReleaseSnapshot>({ contractVersion: 2, releaseId, siteId: schema.siteId,
    locale: selection.locale, ...(context.sourceLocale ? { sourceLocale: context.sourceLocale } : {}), routeTableRevision: selection.routeTableRevision, routeTable,
    schema, items, redirects });
  problems.push(...cmsReferenceProblems(schema, items), ...routePlan.problems, ...(context.impact?.(snapshot) ?? []));
  return problems.length ? { status: "invalid", problems } : { status: "ready", proposal: freezeJson({ expectedReleaseId: selection.expectedReleaseId, snapshot }) };
}

export type CmsDeliveryState = { readonly state: "idle" } | {
  readonly state: "pending" | "delivered" | "failed";
  readonly releaseId: string;
};
export type CmsSchedule = {
  readonly id: string;
  readonly at: string;
  readonly proposal: CmsReleaseProposal;
  readonly state: "scheduled" | "failed" | "cancelled";
};
export type CmsItemState = {
  readonly draftRevision: string;
  readonly publishedRevision: string | null;
  readonly publishedAt: string | null;
  readonly deliveryState: CmsDeliveryState;
  readonly schedule: Pick<CmsSchedule, "id" | "at" | "state"> | null;
  readonly tombstone: { readonly removedAt: string } | null;
};
export function cmsWorkspaceStatus(state: CmsItemState): { status: CollectionItemStatus; scheduledAt: string | null; publishFailed: boolean } | null {
  if (state.tombstone) return null;
  const schedule = state.schedule?.state === "cancelled" ? null : state.schedule;
  const status = state.deliveryState.state === "pending" ? "publishing"
    : state.publishedRevision !== null ? state.publishedRevision === state.draftRevision ? "published" : "changed"
    : schedule ? "scheduled" : "draft";
  return { status, scheduledAt: schedule?.at ?? null, publishFailed: schedule?.state === "failed" || state.deliveryState.state === "failed" };
}
export type CmsWorkspacePresentation = Pick<CollectionItem, "subtitle" | "imageUrl" | "path" | "updatedAt" | "updatedBy" | "order">;
/** Convert v2 state into the established CollectionWorkspace read DTO. */
export function cmsWorkspaceItem(schema: CmsSchema, item: CmsItemRevision, state: CmsItemState, presentation: CmsWorkspacePresentation): CollectionItem | null {
  const badge = cmsWorkspaceStatus(state);
  if (!badge) return null;
  const draft = parseCmsItemRevision(item, schema);
  if (draft.revision !== state.draftRevision) fail("draftRevision", "CMS workspace draft revision mismatch");
  const collection = cmsCollection(schema, draft.collectionId);
  const definition = cmsLegacyCollections({ ...schema, collections: [collection] })[0]!;
  return parseCollectionItem({ ...presentation, ...badge, id: draft.itemId, version: draft.revision, publishedAt: state.publishedAt,
    title: draft.values[collection.titleField], values: cmsLegacyValues(collection, draft.values) }, definition);
}

/** An item must first be removed from the current release and its reservation cancelled. */
export function removeCmsItem(state: CmsItemState, at: string): CmsItemState {
  if (state.tombstone) return state;
  if (state.publishedRevision !== null || state.deliveryState.state === "pending" || (state.schedule && state.schedule.state !== "cancelled")) {
    fail("item", "withdraw published and pending delivery revisions, and cancel scheduled revisions before deletion");
  }
  return { ...state, schedule: null, tombstone: { removedAt: cmsTimestamp(at, "removedAt") } };
}
export function restoreCmsItem(state: CmsItemState): CmsItemState {
  if (!state.tombstone) return state;
  return { ...state, tombstone: null };
}
export function planCmsSchedule(id: string, at: string, now: string, proposal: CmsReleaseProposal): CmsSchedule {
  const scheduledAt = cmsTimestamp(at, "schedule.at");
  if (scheduledAt <= cmsTimestamp(now, "now")) fail("schedule.at", "schedule must be in the future");
  return freezeJson({ id: cmsId(id, "schedule.id"), at: scheduledAt, proposal: structuredClone(proposal), state: "scheduled" });
}
export function dueCmsSchedule(schedule: CmsSchedule, now: string): boolean {
  return schedule.state === "scheduled" && schedule.at <= cmsTimestamp(now, "now");
}

/** Published schedules are no longer eligible for cancellation. Host CAS protects the state transition. */
export function cancelCmsSchedule(schedule: CmsSchedule): CmsSchedule {
  if (schedule.state !== "scheduled") fail("schedule", "only a pending schedule can be cancelled");
  return freezeJson({ ...structuredClone(schedule), state: "cancelled" });
}
