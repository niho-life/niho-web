import type { EditingActor, EditingAuthorizationScope } from "./editing-api.js";
import { LOCALIZATION_EDITING_OPERATIONS } from "./editing-localization-schemas.js";
import { parseLocaleReleaseId, parseLocaleReleaseToken } from "./locale-release-contract.js";
import { parseLocalizationValue } from "./localization.js";
import {
  isLocalizationOperationId, jsonBytes, LOCALIZATION_LIMITS,
  parseLocalizationCursor, parseLocalizationItemKey, parseLocalizationJobId, parseLocalizationPreviewId, parseLocalizationTextValue, parseLocalizationUnitId,
  parseLocaleReleaseApplyResult, parseLocaleReleasePrepareResult, parseLocaleReleaseStateResult,
  parseLocalizationCatalogResult, parseLocalizationCommandResult, parseLocalizationItemResult, parseLocalizationJobResult,
  parseLocalizationListResult, parseLocalizationOverviewResult, parseLocalizationPreviewResult, parseLocalizationSettingsResult, parseLocalizationTranslationResult,
  type LocaleReleaseApplyInput, type LocaleReleaseOperation, type LocaleReleasePrepareInput, type LocaleReleaseSummary,
  type LocalizationCommandInput, type LocalizationSettingsInput, type LocalizedAsset, type LocalizedRichText,
} from "./localization-workspace-model.js";
import { fail, keys, line, record } from "./validation-utils.js";

type NoInput = Readonly<Record<string, never>>;
type ItemTarget = { readonly itemKey: string };
type Versioned = { readonly expectedVersion: string };
type Write = Versioned & { readonly operationId: string };
type VersionConflict = { readonly status: "conflict" };

export type EditingLocalizationReleasePrepareInput = Omit<LocaleReleasePrepareInput, "resumeToken"> & (
  | { readonly resumeToken: null; readonly operationId: string }
  | { readonly resumeToken: string; readonly operationId?: never }
);
export type EditingLocalizationReleaseApplyInput = Versioned & LocaleReleaseApplyInput & {
  readonly operation: LocaleReleaseOperation;
  readonly prepared?: Pick<LocaleReleaseSummary, "releaseId" | "version">;
};

type Inputs = {
  "localization.overview": NoInput;
  "localization.items.list": { readonly cursor?: string | null };
  "localization.items.read": ItemTarget;
  "localization.items.command": LocalizationCommandInput;
  "localization.items.translate": ItemTarget & Write & { readonly unitIds: readonly string[] | null };
  "localization.jobs.read": { readonly jobId: string };
  "localization.catalog.advance": Write;
  "localization.preview": ItemTarget & { readonly previewId: string; readonly cursor?: string | null };
  "localization.release.read": NoInput;
  "localization.release.prepare": EditingLocalizationReleasePrepareInput;
  "localization.release.apply": EditingLocalizationReleaseApplyInput;
  "localization.settings.save": LocalizationSettingsInput & Write;
};

export type EditingLocalizationOperation = (typeof LOCALIZATION_EDITING_OPERATIONS)[number];
export type EditingLocalizationOperationId = EditingLocalizationOperation["id"];
export type EditingLocalizationInput<Id extends EditingLocalizationOperationId> = Inputs[Id];

const inputPath = "$input";
function input(value: unknown, fields: string[]): Record<string, unknown> {
  const source = record(value, inputPath);
  keys(source, fields, inputPath);
  return source;
}
const version = (value: unknown, field: string) => line(value, `${inputPath}.${field}`, 200);
const operationId = (value: unknown) => {
  if (!isLocalizationOperationId(value)) fail(`${inputPath}.operationId`, "invalid operation ID");
  return value;
};
const write = (value: Record<string, unknown>): Write => ({
  expectedVersion: version(value.expectedVersion, "expectedVersion"), operationId: operationId(value.operationId),
});
const itemKey = (value: unknown) => parseLocalizationItemKey(value, `${inputPath}.itemKey`);
function releaseOperation(value: unknown): LocaleReleaseOperation {
  if (value === "publish" || value === "rollback") return value;
  return fail(`${inputPath}.operation`, "invalid operation");
}
const token = (value: unknown, field: string) => parseLocaleReleaseToken(value, `${inputPath}.${field}`);
function noInput(value: unknown): NoInput {
  input(value, []);
  return {};
}
function commandInput(value: unknown): LocalizationCommandInput {
  const source = record(value, inputPath);
  const base = { ...write(source), itemKey: itemKey(source.itemKey), unitId: parseLocalizationUnitId(source.unitId, `${inputPath}.unitId`),
    expectedSourceVersion: version(source.expectedSourceVersion, "expectedSourceVersion") };
  const fields = [...Object.keys(base), "action"];
  switch (source.action) {
    case "set-value":
      keys(source, [...fields, "value"], inputPath);
      return { ...base, action: source.action, value: typeof source.value === "string"
        ? parseLocalizationTextValue(source.value, `${inputPath}.value`)
        : parseLocalizationValue(source.value, "rich-text", `${inputPath}.value`) as LocalizedRichText };
    case "set-image":
      keys(source, [...fields, "image"], inputPath);
      return { ...base, action: source.action, image: source.image === null ? null
        : parseLocalizationValue(source.image, "asset", `${inputPath}.image`) as LocalizedAsset };
    case "adopt-candidate":
      keys(source, [...fields, "candidateId"], inputPath);
      return { ...base, action: source.action, candidateId: parseLocalizationJobId(source.candidateId, `${inputPath}.candidateId`) };
    case "clear-value":
    case "review-current":
    case "review-image":
      keys(source, fields, inputPath);
      return { ...base, action: source.action };
    default: return fail(`${inputPath}.action`, "unknown command");
  }
}

const inputParsers: { [Id in EditingLocalizationOperationId]: (value: unknown) => Inputs[Id] } = {
  "localization.overview": noInput,
  "localization.items.list": (value) => {
    const source = input(value, ["cursor"]);
    return { cursor: parseLocalizationCursor(source.cursor ?? null, `${inputPath}.cursor`) };
  },
  "localization.items.read": (value) => ({ itemKey: itemKey(input(value, ["itemKey"]).itemKey) }),
  "localization.items.command": commandInput,
  "localization.items.translate": (value) => {
    const source = input(value, ["itemKey", "expectedVersion", "operationId", "unitIds"]);
    let unitIds: string[] | null = null;
    if (source.unitIds !== null) {
      if (!Array.isArray(source.unitIds) || !source.unitIds.length || source.unitIds.length > LOCALIZATION_LIMITS.units) {
        fail(`${inputPath}.unitIds`, "expected a bounded list of unit IDs");
      }
      unitIds = source.unitIds.map((unit, index) => parseLocalizationUnitId(unit, `${inputPath}.unitIds[${index}]`));
      if (new Set(unitIds).size !== unitIds.length) fail(`${inputPath}.unitIds`, "duplicate unit ID");
    }
    return { itemKey: itemKey(source.itemKey), ...write(source), unitIds };
  },
  "localization.jobs.read": (value) => ({ jobId: parseLocalizationJobId(input(value, ["jobId"]).jobId, `${inputPath}.jobId`) }),
  "localization.catalog.advance": (value) => write(input(value, ["expectedVersion", "operationId"])),
  "localization.preview": (value) => {
    const source = input(value, ["itemKey", "previewId", "cursor"]);
    return { itemKey: itemKey(source.itemKey), previewId: parseLocalizationPreviewId(source.previewId, `${inputPath}.previewId`),
      cursor: parseLocalizationCursor(source.cursor ?? null, `${inputPath}.cursor`) };
  },
  "localization.release.read": noInput,
  "localization.release.prepare": (value) => {
    const fields = ["operation", "releaseId", "expectedVersion", "expectedCurrentVersion", "resumeToken"];
    const source = input(value, [...fields, "operationId"]);
    const operation = releaseOperation(source.operation);
    if (operation === "publish" && source.releaseId !== null) fail(`${inputPath}.releaseId`, "publish requires null");
    const base = { operation, releaseId: operation === "publish" ? null : parseLocaleReleaseId(source.releaseId, `${inputPath}.releaseId`),
      expectedVersion: version(source.expectedVersion, "expectedVersion"),
      expectedCurrentVersion: source.expectedCurrentVersion === null ? null : version(source.expectedCurrentVersion, "expectedCurrentVersion") };
    if (source.resumeToken === null) return { ...base, resumeToken: null, operationId: operationId(source.operationId) };
    keys(source, fields, inputPath);
    return { ...base, resumeToken: token(source.resumeToken, "resumeToken") };
  },
  "localization.release.apply": (value) => {
    const source = input(value, ["operation", "expectedVersion", "confirmationToken", "resumeToken", "prepared"]);
    if ((source.confirmationToken === null) === (source.resumeToken === null)) fail(inputPath, "expected exactly one token");
    const confirmationToken = source.confirmationToken === null ? null : token(source.confirmationToken, "confirmationToken");
    const resumeToken = source.resumeToken === null ? null : token(source.resumeToken, "resumeToken");
    const base = { operation: releaseOperation(source.operation), expectedVersion: version(source.expectedVersion, "expectedVersion"), confirmationToken, resumeToken };
    if (!Object.hasOwn(source, "prepared")) return base;
    const prepared = record(source.prepared, `${inputPath}.prepared`);
    keys(prepared, ["releaseId", "version"], `${inputPath}.prepared`);
    return { ...base, prepared: { releaseId: parseLocaleReleaseId(prepared.releaseId, `${inputPath}.prepared.releaseId`),
      version: version(prepared.version, "prepared.version") } };
  },
  "localization.settings.save": (value) => {
    const source = input(value, ["expectedVersion", "operationId", "autoDraft", "reviewGlossaryVersion"]);
    if (Object.hasOwn(source, "autoDraft") === Object.hasOwn(source, "reviewGlossaryVersion")) fail(inputPath, "expected exactly one setting");
    const base = write(source);
    if (Object.hasOwn(source, "reviewGlossaryVersion")) return { ...base, reviewGlossaryVersion: version(source.reviewGlossaryVersion, "reviewGlossaryVersion") };
    if (typeof source.autoDraft !== "boolean") fail(`${inputPath}.autoDraft`, "expected boolean");
    return { ...base, autoDraft: source.autoDraft };
  },
};

const operations = new Map<string, EditingLocalizationOperation>(LOCALIZATION_EDITING_OPERATIONS.map((entry) => [entry.id, entry]));
export function editingLocalizationOperation(id: string): EditingLocalizationOperation | undefined {
  return operations.get(id);
}

export const EDITING_LOCALIZATION_INPUT_BYTES = 4 * 1024 * 1024;
export const EDITING_LOCALIZATION_RESULT_BYTES = 5 * 1024 * 1024;
export function parseEditingLocalizationInput<Id extends EditingLocalizationOperationId>(id: Id, value: unknown): Inputs[Id] {
  const parsed = inputParsers[id](value);
  if (jsonBytes(parsed) > EDITING_LOCALIZATION_INPUT_BYTES) fail(inputPath, "payload too large");
  return parsed;
}

export function editingLocalizationScope(siteId: string, value: Inputs[EditingLocalizationOperationId]): EditingAuthorizationScope {
  const scope = value as Partial<ItemTarget & { unitId: string; jobId: string; previewId: string }>;
  return { siteId,
    ...(scope.itemKey === undefined ? {} : { localizationItemKey: scope.itemKey }),
    ...(scope.unitId === undefined ? {} : { localizationUnitId: scope.unitId }),
    ...(scope.jobId === undefined ? {} : { localizationJobId: scope.jobId }),
    ...(scope.previewId === undefined ? {} : { localizationPreviewId: scope.previewId }),
  };
}
export function editingLocalizationCapability(operation: EditingLocalizationOperation, value: Inputs[EditingLocalizationOperationId]) {
  if (!("capabilityByInput" in operation)) return operation.capability;
  const mapping = operation.capabilityByInput;
  if (mapping.field === "action") return mapping.values[(value as LocalizationCommandInput).action];
  return mapping.values[(value as EditingLocalizationReleaseApplyInput | EditingLocalizationReleasePrepareInput).operation];
}

function conflictOr<T>(parse: (value: unknown) => T) {
  return (value: unknown): T | VersionConflict => {
    const source = record(value, "$result");
    if (source.status !== "conflict") return parse(value);
    keys(source, ["status"], "$result");
    return { status: "conflict" };
  };
}

type ResultParsers = {
  [Id in EditingLocalizationOperationId]: (value: unknown, expected: Inputs[Id]) => { readonly status: string };
};
const resultParsers = {
  "localization.overview": parseLocalizationOverviewResult,
  "localization.items.list": parseLocalizationListResult,
  "localization.items.read": (value, expected) => parseLocalizationItemResult(value, expected.itemKey),
  "localization.items.command": parseLocalizationCommandResult,
  "localization.items.translate": conflictOr(parseLocalizationTranslationResult),
  "localization.jobs.read": (value, expected) => parseLocalizationJobResult(value, expected.jobId),
  "localization.catalog.advance": conflictOr(parseLocalizationCatalogResult),
  "localization.preview": parseLocalizationPreviewResult,
  "localization.release.read": parseLocaleReleaseStateResult,
  "localization.release.prepare": parseLocaleReleasePrepareResult,
  "localization.release.apply": (value, expected) => parseLocaleReleaseApplyResult(value, { prepared: expected.prepared ?? null }),
  "localization.settings.save": parseLocalizationSettingsResult,
} satisfies ResultParsers;
type Results = { [Id in EditingLocalizationOperationId]: ReturnType<(typeof resultParsers)[Id]> };

const typedResultParsers: { [Id in EditingLocalizationOperationId]: (value: unknown, expected: Inputs[Id]) => Results[Id] } = resultParsers;
export function parseEditingLocalizationResult<Id extends EditingLocalizationOperationId>(id: Id, value: unknown, expected: Inputs[Id]): Results[Id] {
  return typedResultParsers[id](value, expected);
}
type HostRejection<Id extends EditingLocalizationOperationId> =
  | (Id extends "localization.release.prepare" | "localization.release.apply" ? { readonly status: "invalid_token" } : never)
  | (Id extends "localization.release.prepare" | "localization.release.apply" ? { readonly status: "publication_in_progress" } : never)
  | (Inputs[Id] extends Versioned ? { readonly status: "migration_in_progress" } : never)
  | (Inputs[Id] extends Write ? { readonly status: "duplicate" } : Id extends "localization.release.prepare" ? { readonly status: "duplicate" } : never);

export type EditingLocalizationHostAdapter = {
  /** Authenticate and authorize through the parent adapter. Persist CAS, operation capture, token binding and retry state in the host. */
  readonly [Id in EditingLocalizationOperationId]?: (
    actor: EditingActor, siteId: string, input: EditingLocalizationInput<Id>,
  ) => Promise<Results[Id] | HostRejection<Id>>;
};
export type EditingLocalizationResult<Id extends EditingLocalizationOperationId> =
  Exclude<Results[Id], { status: "forbidden" | "not_found" | "invalid" }> extends infer T
    ? T extends { status: "conflict" } ? VersionConflict : T
    : never;

export function editingLocalizationConflictBody(value: Results[EditingLocalizationOperationId] & { status: "conflict" }) {
  return { error: "version_conflict" as const,
    ...("unit" in value ? { current: { unit: value.unit, summary: value.summary } } : "settings" in value ? { current: value.settings } : {}),
  };
}
export function parseEditingLocalizationConflict<Id extends EditingLocalizationOperationId>(id: Id, value: unknown, expected: Inputs[Id]): Results[Id] {
  const body = record(value, "$result");
  const hasCurrent = id === "localization.items.command" || id === "localization.settings.save";
  keys(body, hasCurrent ? ["error", "current"] : ["error"], "$result");
  if (body.error !== "version_conflict") fail("$result.error", "invalid error");
  if (id === "localization.items.command") {
    const current = record(body.current, "$result.current");
    keys(current, ["unit", "summary"], "$result.current");
    return parseEditingLocalizationResult(id, { status: "conflict", unit: current.unit, summary: current.summary }, expected);
  }
  const current = id === "localization.settings.save" ? { settings: body.current } : {};
  return parseEditingLocalizationResult(id, { ...current, status: "conflict" }, expected);
}
