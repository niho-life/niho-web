import type { CollectionValues } from "./collection-model.js";
import { fail, keys, localeCode, record, string } from "./validation-utils.js";
import { cmsTimestamp, parseCmsReleaseInput, planCmsRelease,
  type CmsReleaseContext, type CmsReleaseInput, type CmsReleaseProposal, type CmsSchedule } from "./cms-v2-release.js";
import {
  cmsArray, cmsCollection, cmsId, parseCmsSchema, parseCmsValues, uniqueCmsKeys,
  planCmsMigrationWithRouteTables,
  type CmsItemKey, type CmsItemRevision, type CmsMigrationDraft, type CmsMigrationImpact,
  type CmsMigrationReplacement, type CmsProblem, type CmsRouteBoundMigration, type CmsSchema
} from "./cms-v2-schema.js";
import { parseCmsRouteRevision, parseCmsRouteTable, type CmsRouteTable, type CmsRouteTableVersion } from "./cms-v2-routes.js";

export type {
  CmsCollection, CmsField, CmsItemKey, CmsItemRevision, CmsMigratedItem, CmsMigration, CmsMigrationChange, CmsMigrationDraft, CmsMigrationImpact,
  CmsMigrationReplacement, CmsProblem, CmsRemovedItem, CmsRouteBoundMigration, CmsSchema
} from "./cms-v2-schema.js";
export { cmsItemKey, cmsLegacyCollections, cmsReferenceProblems, parseCmsItemRevision, parseCmsSchema, parseCmsValues, planCmsMigration, planCmsMigrationWithRouteTables } from "./cms-v2-schema.js";
export type {
  CmsDeliveryState, CmsItemState, CmsRedirect, CmsReleaseContext, CmsReleaseEntry, CmsReleaseImpact, CmsReleaseInput, CmsReleasePin,
  CmsReleasePlan, CmsReleaseProposal, CmsReleaseSnapshot, CmsSchedule, CmsWorkspacePresentation
} from "./cms-v2-release.js";
export { cancelCmsSchedule, cmsWorkspaceItem, cmsWorkspaceStatus, dueCmsSchedule, parseCmsReleaseInput, planCmsRelease, planCmsSchedule, removeCmsItem, restoreCmsItem } from "./cms-v2-release.js";
export type { CmsRouteCandidate, CmsRouteProblem, CmsRouteReservation, CmsRouteTable, CmsRouteTablePlan, CmsRouteTableVersion } from "./cms-v2-routes.js";
export { parseCmsRouteTable, planCmsRouteTable } from "./cms-v2-routes.js";

export const CMS_V2_OPERATIONS = Object.freeze({
  "cms.schema.read": "cms.read",
  "cms.schema.plan": "cms.read",
  "cms.schema.apply": "cms.schema.apply",
  "cms.items.save": "cms.edit",
  "cms.items.remove": "cms.edit",
  "cms.items.restore": "cms.edit",
  "cms.release.plan": "cms.publish",
  "cms.release.apply": "cms.publish",
  "cms.release.status": "cms.read",
  "cms.schedule.create": "cms.publish",
  "cms.schedule.cancel": "cms.publish",
  "cms.schedule.status": "cms.read",
} as const);
export type CmsV2Operation = keyof typeof CMS_V2_OPERATIONS;
export type CmsV2Capability = typeof CMS_V2_OPERATIONS[CmsV2Operation];
export type CmsDiscovery =
  | { readonly siteId: string; readonly contractVersion: 1; readonly schemaRevision: null }
  | { readonly siteId: string; readonly contractVersion: 2; readonly schemaRevision: string; readonly operations: readonly CmsV2Operation[] };
export type CmsBinding = { readonly siteId: string; readonly contractVersion: 1 } | {
  readonly siteId: string; readonly contractVersion: 2; readonly schemaRevision: string;
};
export function discoverCmsContract(binding: CmsBinding, allowed: readonly CmsV2Capability[] = []): CmsDiscovery {
  const siteId = cmsId(binding.siteId, "siteId");
  if (binding.contractVersion === 1) return { siteId, contractVersion: 1, schemaRevision: null };
  if (binding.contractVersion !== 2) fail("contractVersion", "unsupported CMS contract version");
  const schemaRevision = cmsId(binding.schemaRevision, "schemaRevision");
  return { siteId, contractVersion: 2, schemaRevision,
    operations: (Object.keys(CMS_V2_OPERATIONS) as CmsV2Operation[]).filter((operation) => allowed.includes(CMS_V2_OPERATIONS[operation])) };
}

/** Clients validate discovery against the Site they asked for before using it to select a contract. */
export function parseCmsDiscovery(input: unknown, siteId: string): CmsDiscovery {
  const value = record(input, "discovery");
  if (value.siteId !== cmsId(siteId, "siteId")) fail("discovery.siteId", "CMS site mismatch");
  if (value.contractVersion === 1) {
    keys(value, ["siteId", "contractVersion", "schemaRevision"], "discovery");
    if (value.schemaRevision !== null) fail("discovery.schemaRevision", "legacy discovery must use a null schema revision");
    return { siteId, contractVersion: 1, schemaRevision: null };
  }
  if (value.contractVersion !== 2) fail("discovery.contractVersion", "unsupported CMS contract version");
  keys(value, ["siteId", "contractVersion", "schemaRevision", "operations"], "discovery");
  const operations = cmsArray(value.operations, "discovery.operations", Object.keys(CMS_V2_OPERATIONS).length).map((operation) => {
    if (typeof operation !== "string" || !Object.hasOwn(CMS_V2_OPERATIONS, operation)) fail("discovery.operations", "unknown CMS operation");
    return operation as CmsV2Operation;
  });
  if (new Set(operations).size !== operations.length) fail("discovery.operations", "duplicate CMS operation");
  return { siteId, contractVersion: 2, schemaRevision: cmsId(value.schemaRevision, "discovery.schemaRevision"), operations };
}

export type CmsWriteGate = { readonly status: "allowed" } | { readonly status: "unsupported_version" | "conflict" };
/** Pass undefined for a legacy request. Check on the server before any mutation and inside its CAS. */
export function checkCmsWriteVersion(binding: CmsBinding, requestVersion: unknown, expectedSchemaRevision?: unknown): CmsWriteGate {
  const received = requestVersion === undefined ? 1 : requestVersion;
  if (received !== binding.contractVersion || (received !== 1 && received !== 2)) return { status: "unsupported_version" };
  if (binding.contractVersion === 2 && expectedSchemaRevision !== binding.schemaRevision) return { status: "conflict" };
  return { status: "allowed" };
}
export function cmsRoleCapabilities(role: "owner" | "editor"): readonly CmsV2Capability[] {
  if (role === "owner") return ["cms.read", "cms.edit", "cms.publish", "cms.schema.apply"];
  if (role === "editor") return ["cms.read", "cms.edit", "cms.publish"];
  return [];
}

export type CmsApplyInput = { readonly siteId: string; readonly operationId: string; readonly confirmationToken: string };
export type CmsPlanScope = { readonly siteId: string; readonly actorId: string };
export type CmsConfirmedPlan<T> = CmsPlanScope & {
  readonly operation: "cms.schema.apply" | "cms.release.apply" | "cms.schedule.create";
  readonly operationId: string;
  readonly confirmationToken: string;
  readonly expiresAt: string;
  readonly candidate: T;
};
export type CmsSchemaPlanInput = {
  readonly siteId: string;
  readonly expectedSchemaRevision: string;
  readonly routeTableVersions: readonly CmsRouteTableVersion[];
  readonly nextSchema: CmsSchema;
  readonly replacements: readonly CmsMigrationReplacement[];
};
export type CmsDraftWriteInput = CmsItemKey & {
  readonly siteId: string;
  readonly contractVersion: 2;
  readonly expectedSchemaRevision: string;
  readonly expectedRevision: string;
  readonly locale: string;
};
export type CmsOperationReceipt<T> = CmsPlanScope & {
  readonly operation: CmsConfirmedPlan<T>["operation"];
  readonly operationId: string;
  /** Host-derived identity of the exact apply request. Never disclose or log confirmation tokens. */
  readonly requestDigest: string;
  readonly result: T;
};
export type CmsOperationStatus<T> = { readonly status: "recorded"; readonly operationId: string; readonly result: T }
  | { readonly status: "not_found" };
export type CmsApplyCheck<T> = { readonly status: "allowed"; readonly candidate: T }
  | { readonly status: "conflict" | "invalid_confirmation" | "expired" };
export type CmsDraftSaveInput = CmsDraftWriteInput & { readonly values: CollectionValues };
export type CmsMutationResult<T> = CmsOperationStatus<T> | { readonly status: "conflict" | "expired" | "invalid_confirmation" };
export type CmsReleaseResult = { readonly releaseId: string; readonly locale: string };
export type CmsScheduleRequest = CmsReleaseInput & { readonly at: string };
export type CmsSchemaPlan = CmsConfirmedPlan<CmsRouteBoundMigration>;
export type CmsReleaseConfirmation = CmsConfirmedPlan<CmsReleaseProposal>;
export type CmsScheduleConfirmation = CmsConfirmedPlan<CmsSchedule>;

export function parseCmsApplyInput(input: unknown, expectedSiteId: string): CmsApplyInput {
  const value = record(input, "apply");
  keys(value, ["siteId", "operationId", "confirmationToken"], "apply");
  const siteId = cmsId(value.siteId, "apply.siteId");
  if (siteId !== cmsId(expectedSiteId, "scope.siteId")) fail("apply.siteId", "CMS site mismatch");
  const token = string(value.confirmationToken, "apply.confirmationToken", 512);
  if (!/^[A-Za-z0-9._~-]+$/u.test(token)) fail("apply.confirmationToken", "invalid confirmation token");
  return { siteId, operationId: cmsId(value.operationId, "apply.operationId"), confirmationToken: token };
}
function matchingScope(a: CmsPlanScope, b: CmsPlanScope): boolean {
  return a.siteId === b.siteId && a.actorId === b.actorId;
}
export function cmsOperationStatus<T>(scope: CmsPlanScope, operation: CmsConfirmedPlan<unknown>["operation"], operationId: string, receipt: CmsOperationReceipt<T> | undefined): CmsOperationStatus<T> {
  if (!receipt || !matchingScope(scope, receipt) || operationId !== receipt.operationId || operation !== receipt.operation) return { status: "not_found" };
  return { status: "recorded", operationId, result: structuredClone(receipt.result) };
}
export function checkCmsReplay<T>(scope: CmsPlanScope, operation: CmsConfirmedPlan<unknown>["operation"],
  operationId: string, requestDigest: string, receipt: CmsOperationReceipt<T> | undefined): CmsOperationStatus<T> | { readonly status: "conflict" } {
  if (!receipt || !matchingScope(scope, receipt) || operationId !== receipt.operationId) return { status: "not_found" };
  if (receipt.operation !== operation || receipt.requestDigest !== requestDigest) return { status: "conflict" };
  return cmsOperationStatus(scope, operation, operationId, receipt);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
}
function verifyCmsConfirmation<T>(scope: CmsPlanScope, input: unknown, operation: CmsConfirmedPlan<T>["operation"],
  plan: CmsConfirmedPlan<T>, now: string): CmsApplyCheck<T> {
  const { siteId, operationId, confirmationToken } = parseCmsApplyInput(input, scope.siteId);
  if (siteId !== plan.siteId) return { status: "invalid_confirmation" };
  if (!matchingScope(scope, plan) || plan.operation !== operation || plan.operationId !== operationId || plan.confirmationToken !== confirmationToken) {
    return { status: "invalid_confirmation" };
  }
  if (cmsTimestamp(plan.expiresAt, "expiresAt") <= cmsTimestamp(now, "now")) return { status: "expired" };
  return { status: "allowed", candidate: plan.candidate };
}
/** Rebuild from authoritative drafts and impacts immediately before the host's CAS transaction. */
export function checkCmsSchemaApply(scope: CmsPlanScope, input: unknown, plan: CmsSchemaPlan, now: string,
  before: CmsSchema, drafts: readonly CmsMigrationDraft[], routeTables: readonly CmsRouteTable[], replacements: readonly CmsMigrationReplacement[] = [], impact?: CmsMigrationImpact): CmsApplyCheck<CmsRouteBoundMigration> {
  const checked = verifyCmsConfirmation(scope, input, "cms.schema.apply", plan, now);
  if (checked.status !== "allowed") return checked;
  if (checked.candidate.schema.siteId !== scope.siteId || before.siteId !== scope.siteId || before.schemaRevision !== checked.candidate.fromRevision) return { status: "conflict" };
  const currentVersions = routeTables.map((table) => {
    const parsed = parseCmsRouteTable(table, scope.siteId);
    return { locale: parsed.locale, revision: parsed.revision };
  }).sort((a, b) => a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0);
  if (JSON.stringify(currentVersions) !== JSON.stringify(checked.candidate.routeTableVersions)) return { status: "conflict" };
  const live = planCmsMigrationWithRouteTables({ before, next: checked.candidate.schema, items: drafts, replacements,
    routeTables, expectedRouteTableVersions: checked.candidate.routeTableVersions, ...(impact ? { impact } : {}) });
  if (!live) return { status: "conflict" };
  return live.problems.length || canonicalJson(live) !== canonicalJson(checked.candidate)
    ? { status: "conflict" } : { status: "allowed", candidate: live };
}
/** Revalidate against current pointers, tombstones, routes and exact pinned revisions. Results can be committed together with the operation receipt. */
export function revalidateCmsRelease(proposal: CmsReleaseProposal, context: CmsReleaseContext): CmsApplyCheck<CmsReleaseProposal> {
  const { snapshot, expectedReleaseId } = proposal;
  if (snapshot.siteId !== context.schema.siteId || snapshot.locale !== context.locale) return { status: "conflict" };
  const planned = planCmsRelease({ siteId: snapshot.siteId, locale: snapshot.locale, schemaRevision: snapshot.schema.schemaRevision, routeTableRevision: snapshot.routeTableRevision, expectedReleaseId,
    items: snapshot.items.map(({ collectionId, itemId, revision }) => ({ collectionId, itemId, revision })), redirects: snapshot.redirects }, snapshot.releaseId, context);
  return planned.status === "ready" && canonicalJson(planned.proposal) === canonicalJson(proposal)
    ? { status: "allowed", candidate: planned.proposal } : { status: "conflict" };
}
export function checkCmsReleaseApply(scope: CmsPlanScope, input: unknown, plan: CmsReleaseConfirmation,
  now: string, context: CmsReleaseContext): CmsApplyCheck<CmsReleaseProposal> {
  const checked = verifyCmsConfirmation(scope, input, "cms.release.apply", plan, now);
  if (checked.status !== "allowed") return checked;
  if (checked.candidate.snapshot.siteId !== scope.siteId) return { status: "conflict" };
  return revalidateCmsRelease(checked.candidate, context);
}
export function checkCmsScheduleCreate(scope: CmsPlanScope, input: unknown, plan: CmsScheduleConfirmation,
  now: string, context: CmsReleaseContext): CmsApplyCheck<CmsSchedule> {
  const checked = verifyCmsConfirmation(scope, input, "cms.schedule.create", plan, now);
  if (checked.status !== "allowed") return checked;
  const schedule = checked.candidate;
  if (schedule.state !== "scheduled" || schedule.at <= cmsTimestamp(now, "now") || schedule.proposal.snapshot.siteId !== scope.siteId) return { status: "conflict" };
  const release = revalidateCmsRelease(schedule.proposal, context);
  return release.status === "allowed" ? { status: "allowed", candidate: structuredClone(schedule) } : release;
}

export type CmsV2Input = {
  "cms.schema.read": { readonly siteId: string };
  "cms.schema.plan": CmsSchemaPlanInput;
  "cms.schema.apply": CmsApplyInput;
  "cms.items.save": CmsDraftSaveInput;
  "cms.items.remove": CmsDraftWriteInput;
  "cms.items.restore": CmsDraftWriteInput;
  "cms.release.plan": CmsReleaseInput | CmsScheduleRequest;
  "cms.release.apply": CmsApplyInput;
  "cms.release.status": { readonly siteId: string; readonly operationId: string };
  "cms.schedule.create": CmsApplyInput;
  "cms.schedule.cancel": { readonly siteId: string; readonly scheduleId: string };
  "cms.schedule.status": { readonly siteId: string; readonly scheduleId: string };
};
export type CmsPlanResult<T> = { readonly status: "ready"; readonly plan: T } | { readonly status: "conflict" }
  | { readonly status: "invalid"; readonly problems: readonly CmsProblem[] };
export type CmsScheduleResult = { readonly scheduleId: string; readonly at: string; readonly releaseId: string };
export type CmsV2Result = {
  "cms.schema.read": CmsSchema;
  "cms.schema.plan": CmsPlanResult<CmsSchemaPlan>;
  "cms.schema.apply": CmsMutationResult<{ readonly schemaRevision: string }>;
  "cms.items.save": { readonly status: "saved"; readonly item: CmsItemRevision } | { readonly status: "conflict" | "not_found" };
  "cms.items.remove": { readonly status: "removed" | "conflict" | "not_found" };
  "cms.items.restore": { readonly status: "restored" | "conflict" | "not_found" };
  "cms.release.plan": CmsPlanResult<CmsReleaseConfirmation> | CmsPlanResult<CmsScheduleConfirmation>;
  "cms.release.apply": CmsMutationResult<CmsReleaseResult>;
  "cms.release.status": CmsOperationStatus<CmsReleaseResult>;
  "cms.schedule.create": CmsMutationResult<CmsScheduleResult>;
  "cms.schedule.cancel": { readonly status: "cancelled" | "conflict" | "not_found" };
  "cms.schedule.status": { readonly status: "scheduled" | "failed" | "released" | "cancelled"; readonly schedule: CmsScheduleResult } | { readonly status: "not_found" };
};
export type CmsV2Host = { readonly [Operation in CmsV2Operation]: (scope: CmsPlanScope, input: CmsV2Input[Operation]) => Promise<CmsV2Result[Operation]> };

/** Schema plan requests describe the complete desired definition and optional explicit conversion values. */
export function parseCmsSchemaPlanInput(input: unknown, siteId: string): CmsSchemaPlanInput {
  const value = record(input, "schemaPlan");
  keys(value, ["siteId", "expectedSchemaRevision", "routeTableVersions", "nextSchema", "replacements"], "schemaPlan");
  if (value.siteId !== siteId) fail("schemaPlan.siteId", "CMS site mismatch");
  const nextSchema = parseCmsSchema(value.nextSchema);
  if (nextSchema.siteId !== siteId) fail("schemaPlan.nextSchema.siteId", "CMS site mismatch");
  const routeTableVersions = cmsArray(value.routeTableVersions, "schemaPlan.routeTableVersions", 100).map((entry, index) => {
    const at = `schemaPlan.routeTableVersions[${index}]`, version = record(entry, at);
    keys(version, ["locale", "revision"], at);
    return { locale: localeCode(version.locale, `${at}.locale`), revision: parseCmsRouteRevision(version.revision, `${at}.revision`) };
  });
  if (!routeTableVersions.length) fail("schemaPlan.routeTableVersions", "route table versions are required");
  uniqueCmsKeys(routeTableVersions.map(({ locale }) => locale), "schemaPlan.routeTableVersions");
  const replacements = cmsArray(value.replacements, "schemaPlan.replacements", 25_000).map((entry, index) => {
    const at = `schemaPlan.replacements[${index}]`, replacement = record(entry, at);
    keys(replacement, ["collectionId", "itemId", "locale", "values"], at);
    const collectionId = cmsId(replacement.collectionId, `${at}.collectionId`);
    const rawValues = record(replacement.values, `${at}.values`);
    const values = parseCmsValues(rawValues, cmsCollection(nextSchema, collectionId), `${at}.values`);
    return { collectionId, itemId: cmsId(replacement.itemId, `${at}.itemId`), locale: localeCode(replacement.locale, `${at}.locale`),
      values: Object.fromEntries(Object.keys(rawValues).map((key) => [key, values[key]!])) };
  });
  return { siteId, expectedSchemaRevision: cmsId(value.expectedSchemaRevision, "schemaPlan.expectedSchemaRevision"),
    routeTableVersions: routeTableVersions.sort((a, b) => a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0), nextSchema, replacements };
}
export function parseCmsDraftWrite(input: unknown, schema: CmsSchema, operation: "save"): CmsDraftSaveInput;
export function parseCmsDraftWrite(input: unknown, schema: CmsSchema, operation: "remove" | "restore"): CmsDraftWriteInput;
export function parseCmsDraftWrite(input: unknown, schema: CmsSchema, operation: "save" | "remove" | "restore"): CmsDraftWriteInput | CmsDraftSaveInput {
  const value = record(input, "draftWrite");
  keys(value, ["siteId", "contractVersion", "expectedSchemaRevision", "expectedRevision", "locale", "collectionId", "itemId", ...(operation === "save" ? ["values"] : [])], "draftWrite");
  if (value.siteId !== schema.siteId) fail("draftWrite.siteId", "CMS site mismatch");
  const version = checkCmsWriteVersion(schema, value.contractVersion, value.expectedSchemaRevision);
  if (version.status !== "allowed") fail("draftWrite.contractVersion", version.status);
  const collection = cmsCollection(schema, cmsId(value.collectionId, "draftWrite.collectionId"));
  const target: CmsDraftWriteInput = { siteId: schema.siteId, contractVersion: 2, expectedSchemaRevision: schema.schemaRevision,
    expectedRevision: cmsId(value.expectedRevision, "draftWrite.expectedRevision"), locale: localeCode(value.locale, "draftWrite.locale"),
    collectionId: collection.id, itemId: cmsId(value.itemId, "draftWrite.itemId") };
  return operation === "save" ? { ...target, values: parseCmsValues(value.values, collection, "draftWrite.values") } : target;
}
export function parseCmsScheduleRequest(input: unknown): CmsScheduleRequest {
  const { at, ...release } = record(input, "schedule");
  return { ...parseCmsReleaseInput(release), at: cmsTimestamp(at, "schedule.at") };
}
