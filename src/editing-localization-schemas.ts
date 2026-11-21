import type { EditingApiErrorCode, JsonSchema } from "./editing-api.js";
import { LOCALIZATION_LIMITS, LOCALIZATION_PERMISSIONS } from "./localization-workspace-model.js";

export type EditingLocalizationCapability =
  | "localization.read" | "localization.edit" | "localization.translate" | "localization.review" | "localization.publish" | "localization.manage" | "localization.rollback";

const string = (maxLength: number, minLength = 1, pattern?: string): JsonSchema =>
  Object.freeze({ type: "string", minLength, maxLength, ...(pattern === undefined ? {} : { pattern }) });
const choice = (...values: string[]): JsonSchema => Object.freeze({ enum: Object.freeze(values) });
const oneOf = (...alternatives: JsonSchema[]) => Object.freeze({ oneOf: Object.freeze(alternatives) });
const nil = Object.freeze({ const: null });
const nullable = (value: JsonSchema) => oneOf(value, nil);
const int = (maximum: number, minimum = 0): JsonSchema => Object.freeze({ type: "integer", minimum, maximum });
const bool = Object.freeze({ type: "boolean" });
const array = (items: JsonSchema, maxItems: number, minItems = 0, uniqueItems = false): JsonSchema =>
  Object.freeze({ type: "array", items, minItems, maxItems, ...(uniqueItems ? { uniqueItems } : {}) });
function object(required: Record<string, JsonSchema>, optional: Record<string, JsonSchema> = {}) {
  return Object.freeze({ type: "object", properties: Object.freeze({ ...required, ...optional }),
    required: Object.freeze(Object.keys(required)), additionalProperties: false });
}
const result = (status: string, properties: Record<string, JsonSchema> = {}, optional?: Record<string, JsonSchema>) =>
  object({ status: Object.freeze({ const: status }), ...properties }, optional);
const common = Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure",
  "invalid_request", "method_not_allowed", "not_found"] as const);
const writeErrors = (...errors: EditingApiErrorCode[]) => Object.freeze([...common, "version_conflict" as const, ...errors]);
const site = { siteId: string(80, 1, "^[A-Za-z][A-Za-z0-9_-]*$") };
const version = string(200), operationId = string(64, 16, "^[A-Za-z0-9_-]+$");
const id = (maximum = 80) => string(maximum, 1, "^[A-Za-z0-9_-]+$");
const itemKey = id(200), unitId = string(300, 1, "^[A-Za-z][A-Za-z0-9_.-]*$");
const token = string(512, 1, "^[A-Za-z0-9._~+/=-]+$");
const releaseId = string(128, 1, "^[A-Za-z][A-Za-z0-9_-]*$");
const cursor = nullable(id(512)), timestamp = string(40), count = int(1_000_000);
const expected = { expectedVersion: version }, write = { ...expected, operationId };
const itemTarget = { itemKey };
const unitTarget = { ...itemTarget, unitId };
const text = string(LOCALIZATION_LIMITS.text, 0);

const richNodeRef = Object.freeze({ $ref: "#/$defs/richNode" });
const richNode = oneOf(
  object({ type: choice("text"), text }),
  object({ type: choice("element"), id: string(80), tag: choice("a", "strong", "em", "b", "i", "small", "span", "br"),
    children: array(richNodeRef, 5000) }),
);
const richText = object({ kind: choice("rich-text"), children: array(richNodeRef, 5000) });
const richDefs = <T extends Exclude<JsonSchema, boolean>>(schema: T) =>
  Object.freeze({ ...schema, $defs: Object.freeze({ richNode }) });
const asset = oneOf(
  object({ kind: choice("asset"), asset: object({ provider: string(80), id: string(128) }) }),
  object({ kind: choice("image-url"), src: string(2048) }, { srcset: string(2048) }),
);
const job = object({ jobId: id(128), state: choice("queued", "running", "done", "failed"), message: nullable(string(400)) });
const settings = object({
  version, autoDraft: bool, translator: object({ connected: bool }),
  queue: object({ waiting: count, failed: count, nextRetryAt: nullable(timestamp) }),
}, { glossary: object({ version, reviewed: bool, entries: array(
  object({ source: string(LOCALIZATION_LIMITS.glossaryText), target: string(LOCALIZATION_LIMITS.glossaryText) }),
  LOCALIZATION_LIMITS.glossaryEntries,
) }) });

const progress = object({ done: count, total: int(1_000_000, 1) });
const releaseOperation = choice("publish", "rollback");
const releaseFields = { releaseId, version, label: string(300), publishedAt: timestamp, pages: int(10_000), sharedResources: int(10_000) };
const release = object(releaseFields);
const pending = object({
  operation: releaseOperation, stage: choice("prepare", "apply"), progress, resumeToken: token,
  releaseId: nullable(releaseId), startedAt: timestamp, startedBy: nullable(string(200)),
});
const blocker = object({ id: id(), message: string(400), itemKey: nullable(itemKey) });
const blockers = array(blocker, 200);
const page = { path: string(2048), title: string(200) };
const releasePlan = object({
  confirmationToken: token, expiresAt: timestamp, address: string(2048), pages: int(10_000),
  previous: nullable(release), prepared: release,
}, {
  changes: nullable(object({ added: array(object(page), 500), removed: array(object(page), 500) })),
  firstRelease: nullable(object({
    groups: array(object({ label: string(100), pages: int(10_000, 1), automaticPages: int(10_000) }), 100, 1),
    excluded: object({ count: int(10_000), examples: array(object({ ...page, reason: string(200) }), 20) }),
  })),
});
const overview = object({
  version, sourceLocale: choice("ja", "en"), targetLocale: choice("ja", "en"),
  languages: object({ source: string(40), target: string(40) }),
  permissions: array(choice(...LOCALIZATION_PERMISSIONS), LOCALIZATION_PERMISSIONS.length, 0, true),
  groups: array(object({ id: id(), label: string(200), items: count, needsWork: count, reviewed: count, excluded: count }), LOCALIZATION_LIMITS.groups),
  release: object({ current: nullable(release), pending: nullable(pending) }), blockers,
  catalog: oneOf(object({ state: choice("current") }), object({ state: choice("updating"), progress })),
  preview: nullable(object({ frameUrl: string(2048) })), settings,
}, { attention: object({ label: string(60), items: array(object({ key: itemKey, title: string(1000) }), LOCALIZATION_LIMITS.attentionItems) }) });

const unitCount = int(LOCALIZATION_LIMITS.units);
const summaryFields = {
  key: itemKey, groupId: id(), title: string(1000, 0), path: nullable(string(2048)),
  state: choice("untranslated", "draft", "source-changed", "reviewed", "excluded"), excludedReason: nullable(string(400)),
  totalUnits: unitCount, reviewedUnits: unitCount, imagesUnreviewed: unitCount,
  sourceDraftPending: bool, updatedAt: nullable(timestamp), updatedBy: nullable(string(200)),
};
const summaryOptional = { includedParts: array(string(80), 8, 0, true) };
const summary = object(summaryFields, summaryOptional);
const unitFields = {
  unitId, label: string(200), section: nullable(string(200)), required: bool, version, sourceVersion: version,
  state: choice("source", "missing", "draft", "review-needed", "reviewed"), updatedAt: nullable(timestamp), updatedBy: nullable(string(200)),
};
const editOrigin = { editOrigin: nullable(choice("AUTO", "MANUAL")) };
const valueFields = (kind: string, schema: JsonSchema) => ({
  kind: choice(kind), source: schema, value: nullable(schema), previousSource: nullable(schema),
  candidate: nullable(object({ candidateId: id(128), value: schema })),
});
const image = object({ asset, url: string(2048) });
const unit = oneOf(
  object({ ...unitFields, ...valueFields("text", text), marks: array(object({ id: id(32), label: string(80) }), LOCALIZATION_LIMITS.marks),
    maxLength: nullable(int(LOCALIZATION_LIMITS.text, 1)), singleLine: bool }, editOrigin),
  object({ ...unitFields, ...valueFields("rich-text", richText) }, editOrigin),
  object({ ...unitFields, kind: choice("image"), source: image, value: nullable(image) }),
);
const item = object({
  ...summaryFields, units: array(unit, LOCALIZATION_LIMITS.units),
  previews: array(object({ id: id(), label: string(200) }), LOCALIZATION_LIMITS.previews), job: nullable(job),
}, { ...summaryOptional, relatedItems: array(object({ key: itemKey, label: string(80) }), 8) });

const commandCapabilities = Object.freeze({
  "set-value": "localization.edit", "adopt-candidate": "localization.edit", "clear-value": "localization.edit",
  "set-image": "localization.edit", "review-current": "localization.review", "review-image": "localization.review",
} as const);

const releaseCapabilities = Object.freeze({ publish: "localization.publish", rollback: "localization.rollback" } as const);
const capabilityByOperation = Object.freeze({ field: "operation", values: releaseCapabilities } as const);
const command = (action: keyof typeof commandCapabilities, fields: Record<string, JsonSchema> = {}) =>
  object({ ...site, ...write, ...unitTarget, expectedSourceVersion: version, action: choice(action), ...fields });
const prepare = (operation: "publish" | "rollback", resuming: boolean) => object({
  ...site, ...expected, operation: choice(operation), releaseId: operation === "publish" ? nil : releaseId,
  expectedCurrentVersion: nullable(version), resumeToken: resuming ? token : nil, ...(resuming ? {} : { operationId }),
});
const apply = (resuming: boolean) => object({
  ...site, ...expected, operation: releaseOperation, confirmationToken: resuming ? nil : token, resumeToken: resuming ? token : nil,
}, { prepared: object({ releaseId, version }) });
const conflict = Object.freeze({ const: "version_conflict" });
const conflictSchema = (current?: JsonSchema) => object({ error: conflict, ...(current === undefined ? {} : { current }) });

function operation<const Id extends `localization.${string}`, const Capability extends EditingLocalizationCapability>(
  id: Id, capability: Capability, method: "GET" | "PUT" | "POST",
  inputSchema: JsonSchema, resultSchema: JsonSchema, errors: readonly EditingApiErrorCode[] = common,
) {
  return Object.freeze({ id, capability, method, path: `/sites/{siteId}/operations/${id}`, inputSchema, resultSchema, errors });
}

export const LOCALIZATION_EDITING_OPERATIONS = Object.freeze([
  operation("localization.overview", "localization.read", "GET", object(site), result("ready", { overview })),
  operation("localization.items.list", "localization.read", "GET", object(site, { cursor }),
    result("ready", { items: array(summary, LOCALIZATION_LIMITS.listPage), nextCursor: cursor })),
  operation("localization.items.read", "localization.read", "GET", object({ ...site, ...itemTarget }),
    richDefs(result("ready", { item }))),
  Object.freeze({ ...operation("localization.items.command", "localization.edit", "POST",
    richDefs(oneOf(command("set-value", { value: oneOf(text, richText) }), command("adopt-candidate", { candidateId: id(128) }),
      command("clear-value"), command("set-image", { image: nullable(asset) }), command("review-current"), command("review-image"))),
    richDefs(oneOf(result("applied", { unit, summary }), conflictSchema(object({ unit, summary })))),
    writeErrors("duplicate_operation", "validation_failed")), capabilityByInput: Object.freeze({ field: "action", values: commandCapabilities } as const) }),
  operation("localization.items.translate", "localization.translate", "POST",
    object({ ...site, ...itemTarget, ...write, unitIds: nullable(array(unitId, LOCALIZATION_LIMITS.units, 1, true)) }),
    oneOf(result("queued", { job }), conflictSchema()), writeErrors("duplicate_operation", "validation_failed")),
  operation("localization.jobs.read", "localization.read", "GET", object({ ...site, jobId: id(128) }), result("ready", { job })),
  operation("localization.catalog.advance", "localization.edit", "POST", object({ ...site, ...write }),
    oneOf(result("current"), result("updating", { progress }), conflictSchema()), writeErrors("duplicate_operation")),
  operation("localization.preview", "localization.read", "GET", object({ ...site, ...itemTarget, previewId: id() }, { cursor }),
    result("ready", { material: true, nextCursor: cursor })),
  operation("localization.release.read", "localization.read", "GET", object(site), result("ready", {
    current: nullable(release), history: array(object({ ...releaseFields, operation: releaseOperation, by: nullable(string(200)), restorable: bool }), 1000),
    pending: nullable(pending),
  })),
  Object.freeze({ ...operation("localization.release.prepare", "localization.publish", "POST",
    oneOf(prepare("publish", false), prepare("publish", true), prepare("rollback", false), prepare("rollback", true)),
    oneOf(result("ready", { plan: releasePlan }), result("preparing", { progress, resumeToken: token }), result("blocked", { blockers: array(blocker, 200, 1) }),
      result("expired"), conflictSchema()), writeErrors("duplicate_operation")), capabilityByInput: capabilityByOperation }),
  Object.freeze({ ...operation("localization.release.apply", "localization.publish", "POST", oneOf(apply(false), apply(true)),
    oneOf(result("applied", { current: release }), result("applying", { progress, resumeToken: token }, { waiting: choice("uploading", "deployment") }), result("expired"),
      conflictSchema()), writeErrors()), capabilityByInput: capabilityByOperation }),
  operation("localization.settings.save", "localization.manage", "PUT",
    oneOf(object({ ...site, ...write, autoDraft: bool }), object({ ...site, ...write, reviewGlossaryVersion: version })),
    oneOf(result("saved", { settings }), conflictSchema(settings)), writeErrors("duplicate_operation", "validation_failed")),
]);
