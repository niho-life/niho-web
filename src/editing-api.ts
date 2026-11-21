import type { BlockContracts, ComponentLibrary, PageDocument } from "./types.js";
import { parsePageDocument } from "./document.js";
import { normalizePageChange, validatePageChangePlan, validateReleasePlan } from "./editor-model.js";
import type { EditorBreakpointSettings, EditorBreakpointSettingsSaveResult, EditorBreakpointSettingsSnapshot, EditorPage, EditorPageChange, EditorPageChangePlan, EditorReleasePlan, EditorReleaseRequest, EditorSite } from "./editor-types.js";
import { assetId, identifier, isSafeHttpsOrigin, localeCode, record } from "./validation-utils.js";
import type { SiteStyles } from "./site-styles.js";
import { parseBreakpointSettings } from "./style-model.js";
import {
  parseAssetDeleteResult, parseAssetListResult, parseAssetReference, parseAssetRestoreResult, parseAssetUpdateResult,
  parseAssetUploadIntent, parseAssetUsages, parseResolvedAssets, ASSET_LIMITS,
  type AssetListQuery, type AssetReference, type AssetUpdateRequest, type AssetUpdateResult, type ResolvedAssetMap
} from "./assets.js";
import {
  parseCollectionCreateResult, parseCollectionItem, parseCollectionItemResult, parseCollectionListResult, parseCollectionPublishResult,
  parseCollectionSaveResult, parseCollectionSchemaResult, parseCollectionValues,
  type CollectionDefinition, type CollectionFieldError, type CollectionItem, type CollectionValues
} from "./collection-model.js";
import { LOCALIZATION_EDITING_OPERATIONS, type EditingLocalizationCapability } from "./editing-localization-schemas.js";
import {
  editingLocalizationCapability, editingLocalizationConflictBody, editingLocalizationOperation, editingLocalizationScope,
  EDITING_LOCALIZATION_INPUT_BYTES, EDITING_LOCALIZATION_RESULT_BYTES,
  parseEditingLocalizationInput, parseEditingLocalizationResult,
  type EditingLocalizationHostAdapter, type EditingLocalizationInput, type EditingLocalizationOperation, type EditingLocalizationOperationId,
} from "./editing-localization.js";
import { jsonBytes } from "./localization-workspace-model.js";

export type {
  EditingLocalizationHostAdapter, EditingLocalizationInput, EditingLocalizationOperationId, EditingLocalizationReleaseApplyInput,
  EditingLocalizationReleasePrepareInput, EditingLocalizationResult,
} from "./editing-localization.js";
export type { EditingLocalizationCapability } from "./editing-localization-schemas.js";

/** Stable errors returned by the host-neutral page editing wire contract. */
export const EDITING_API_ERRORS = Object.freeze([
  "authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "validation_failed", "version_conflict"
] as const);
export type EditingApiErrorCode = typeof EDITING_API_ERRORS[number];

export type EditingActor = {
  readonly kind: "human" | "machine";
  readonly subject: string;
  readonly delegatedBy?: string;
  /** hostの認証処理が検証した連絡先。必要な場合だけ監査用に渡す。 */
  readonly email?: string;
};
export type EditingPageTarget = {
  readonly siteId: string;
  readonly pageId: string;
  readonly locale: string;
};
export type EditingAuthorizationScope = { readonly siteId: string; readonly pageId?: string; readonly locale?: string; readonly collectionId?: string; readonly itemId?: string; readonly assetProvider?: string; readonly assetId?: string;
  readonly localizationItemKey?: string; readonly localizationUnitId?: string; readonly localizationJobId?: string; readonly localizationPreviewId?: string };
export type EditingPageSnapshot = {
  readonly document: PageDocument;
  readonly version: string;
  readonly componentsVersion?: string;
  readonly presentationVersion?: string;
};
export type EditingPageSaveResult = { readonly status: "saved"; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPageReleasePrepareResult = { readonly status: "prepared"; readonly plan: EditorReleasePlan } | { readonly status: "conflict" };
export type EditingPagePublishResult = { readonly status: "released"; readonly operationId: string; readonly version: string; readonly document: PageDocument } | { readonly status: "conflict" };
export type EditingPageCatalog = { readonly version: string; readonly pages: readonly EditorPage[] };
export type EditingPageChange = Exclude<EditorPageChange, { action: "duplicate" }>;
export type EditingPageManagementPlan = EditorPageChangePlan & { readonly expectedVersion: string; readonly operationId: string };
export type EditingPageManagementPrepareResult = { readonly status: "prepared"; readonly plan: EditingPageManagementPlan }
  | { readonly status: "conflict" } | { readonly status: "invalid" } | { readonly status: "not_found" } | { readonly status: "duplicate" };
export type EditingPageManagementApplyInput = { readonly expectedVersion: string; readonly operationId: string; readonly confirmationToken: string; readonly change: EditingPageChange };
export type EditingPageManagementApplyResult = { readonly status: "applied"; readonly operationId: string; readonly page: EditorPage }
  | { readonly status: "conflict" } | { readonly status: "invalid" } | { readonly status: "not_found" } | { readonly status: "duplicate" };
export type EditingCmsTarget = { readonly siteId: string; readonly collectionId: string; readonly itemId: string };
export type EditingCmsPublishPlan = { readonly target: EditingCmsTarget; readonly expectedVersion: string; readonly operationId: string; readonly confirmationToken: string; readonly item: CollectionItem; readonly redirect?: boolean };
export type EditingCmsPublishPrepareResult = { readonly status: "prepared"; readonly plan: EditingCmsPublishPlan }
  | { readonly status: "conflict" } | { readonly status: "invalid"; readonly errors: readonly CollectionFieldError[] } | { readonly status: "not_found" } | { readonly status: "duplicate" };
export type EditingCmsPublishApplyResult = { readonly status: "published" | "publishing"; readonly operationId: string; readonly item: CollectionItem }
  | { readonly status: "conflict" } | { readonly status: "invalid"; readonly errors: readonly CollectionFieldError[] } | { readonly status: "not_found" } | { readonly status: "duplicate" };
export type EditingCmsOperationStatus = { readonly status: "unknown"; readonly operationId: string }
  | { readonly status: "received"; readonly operationId: string }
  | { readonly status: "completed"; readonly operationId: string; readonly httpStatus: number; readonly result: unknown };
export type EditingPageReleaseSetItem = {
  readonly target: EditingPageTarget;
  readonly expectedVersion: string;
  readonly componentsVersion?: string;
  readonly presentationVersion?: string;
};
export type EditingPageReleaseSetPlan = {
  readonly siteId: string;
  readonly operationId: string;
  readonly confirmationToken: string;
  readonly domain: string;
  readonly items: readonly EditingPageReleaseSetItem[];
};
export type EditingPageReleaseSetPrepareResult = { readonly status: "prepared"; readonly plan: EditingPageReleaseSetPlan }
  | { readonly status: "conflict" } | { readonly status: "invalid" } | { readonly status: "not_found" } | { readonly status: "duplicate" };
export type EditingPageReleaseSetItemResult = { readonly target: EditingPageTarget; readonly status: "released"; readonly version: string }
  | { readonly target: EditingPageTarget; readonly status: "conflict" | "pending" };
export type EditingPageReleaseSetApplyResult = { readonly status: "completed" | "publishing"; readonly operationId: string; readonly items: readonly EditingPageReleaseSetItemResult[] }
  | { readonly status: "conflict" } | { readonly status: "invalid" } | { readonly status: "not_found" } | { readonly status: "duplicate" };
export type EditingPageReleaseSetStatus = EditingCmsOperationStatus;
export type PageEditingValidationContext = { readonly blocks?: BlockContracts; readonly components?: ComponentLibrary; readonly siteStyles?: SiteStyles };

export type JsonSchema = boolean | {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly type?: string;
  readonly const?: string | number | boolean | null;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly pattern?: string;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly minItems?: number;
  readonly oneOf?: readonly JsonSchema[];
};
type EditingOperationDefinitionShape = {
  readonly id: string;
  readonly capability: "pages.read" | "pages.edit" | "pages.publish" | "site.settings.read" | "site.settings.write" | "cms.read" | "cms.edit" | "cms.publish"
    | "assets.read" | "assets.edit" | "assets.upload" | "assets.delete" | EditingLocalizationCapability;
  readonly capabilityByInput?: { readonly field: "action" | "operation"; readonly values: Readonly<Record<string, EditingLocalizationCapability>> };
  readonly method: "GET" | "PUT" | "POST";
  readonly path: string;
  readonly inputSchema: JsonSchema;
  readonly resultSchema: JsonSchema;
  readonly errors: readonly EditingApiErrorCode[];
};
export type PageEditingApiOptions = { readonly basePath?: string };
export type RegisteredPageEditingHost = {
  /** Exact site IDs served by this host adapter. A site ID may be registered only once. */
  readonly siteIds: readonly string[];
  readonly adapter: PageEditingHostAdapter;
};

const documentSchema: JsonSchema = Object.freeze({
  type: "object", required: Object.freeze(["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "tokens", "body"]),
  additionalProperties: false,
  properties: Object.freeze({
    schemaVersion: Object.freeze({ const: 1 }), siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }),
    locale: Object.freeze({ type: "string" }), revision: Object.freeze({ type: "number", minimum: 1 }), title: Object.freeze({ type: "string" }),
    meta: Object.freeze({ type: "object" }), tokens: Object.freeze({ type: "object" }), textStyles: Object.freeze({ type: "object" }),
    body: Object.freeze({ type: "array", items: Object.freeze({ type: "object" }) })
  })
});
const versionSchema: JsonSchema = Object.freeze({ type: "string", minLength: 1 });
const breakpointNameSchema: JsonSchema = Object.freeze({ type: "string", enum: Object.freeze(["Mini", "Mobile", "Tablet", "Small", "PC"]) });
const breakpointSettingsSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["base", "breakpoints"]), additionalProperties: false,
  properties: Object.freeze({
    base: Object.freeze({ type: "object", required: Object.freeze(["name", "previewWidth"]), additionalProperties: false,
      properties: Object.freeze({ name: breakpointNameSchema, previewWidth: Object.freeze({ type: "integer", minimum: 320, maximum: 1920 }) }) }),
    breakpoints: Object.freeze({ type: "array", maxItems: 4, items: Object.freeze({ type: "object", required: Object.freeze(["name", "minWidth", "previewWidth"]), additionalProperties: false,
      properties: Object.freeze({ name: breakpointNameSchema, minWidth: Object.freeze({ type: "integer", minimum: 320, maximum: 1920 }), previewWidth: Object.freeze({ type: "integer", minimum: 320, maximum: 1920 }) }) }) })
  })
});
const pageTargetSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale"]), additionalProperties: false,
  properties: Object.freeze({ siteId: Object.freeze({ type: "string", minLength: 1, maxLength: 80 }), pageId: Object.freeze({ type: "string", minLength: 1, maxLength: 80 }), locale: Object.freeze({ type: "string", minLength: 2, maxLength: 40 }) }) });
const pageChangeSchema: JsonSchema = Object.freeze({ oneOf: Object.freeze([
  Object.freeze({ type: "object", required: Object.freeze(["action", "siteId", "locale", "title", "path"]), additionalProperties: false,
    properties: Object.freeze({ action: Object.freeze({ const: "create" }), siteId: Object.freeze({ type: "string", minLength: 1, maxLength: 80 }), locale: Object.freeze({ type: "string", minLength: 2, maxLength: 40 }), title: Object.freeze({ type: "string", minLength: 1, maxLength: 200 }), path: Object.freeze({ type: "string", minLength: 1, maxLength: 300 }) }) }),
  Object.freeze({ type: "object", required: Object.freeze(["action", "target", "title", "path"]), additionalProperties: false,
    properties: Object.freeze({ action: Object.freeze({ const: "update" }), target: pageTargetSchema, title: Object.freeze({ type: "string", minLength: 1, maxLength: 200 }), path: Object.freeze({ type: "string", minLength: 1, maxLength: 300 }) }) }),
  Object.freeze({ type: "object", required: Object.freeze(["action", "target", "visibility"]), additionalProperties: false,
    properties: Object.freeze({ action: Object.freeze({ const: "visibility" }), target: pageTargetSchema, visibility: Object.freeze({ type: "string", enum: Object.freeze(["public", "private"]) }) }) })
]) });
const pageCatalogItemSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale", "title"]), additionalProperties: false,
  properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }), title: Object.freeze({ type: "string" }),
    path: Object.freeze({ type: "string" }), kind: Object.freeze({ type: "string", enum: Object.freeze(["page", "template", "shared"]) }),
    visibility: Object.freeze({ type: "string", enum: Object.freeze(["public", "private"]) }), published: Object.freeze({ type: "boolean" }) }) });
const pageChangeImpactSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["linkedFrom", "navigation", "notes"]), additionalProperties: false,
  properties: Object.freeze({ before: Object.freeze({ type: "string" }), after: Object.freeze({ type: "string" }),
    redirect: Object.freeze({ type: "object", required: Object.freeze(["from", "to"]), additionalProperties: false,
      properties: Object.freeze({ from: Object.freeze({ type: "string" }), to: Object.freeze({ type: "string" }), status: Object.freeze({ type: "integer", minimum: 300, maximum: 399 }) }) }),
    linkedFrom: Object.freeze({ type: "array", maxItems: 500, items: Object.freeze({ type: "object", required: Object.freeze(["pageId", "locale", "title", "count"]), additionalProperties: false,
      properties: Object.freeze({ pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }), title: Object.freeze({ type: "string" }), count: Object.freeze({ type: "integer", minimum: 0 }) }) }) }),
    navigation: Object.freeze({ type: "array", maxItems: 100, items: Object.freeze({ type: "string" }) }), notes: Object.freeze({ type: "array", maxItems: 100, items: Object.freeze({ type: "string" }) }) }) });
const pageManagementPlanSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["expectedVersion", "operationId", "change", "confirmationToken", "domain", "impact"]), additionalProperties: false,
  properties: Object.freeze({ expectedVersion: versionSchema, operationId: Object.freeze({ type: "string", minLength: 36, maxLength: 36 }), change: pageChangeSchema,
    confirmationToken: versionSchema, domain: Object.freeze({ type: "string" }), impact: pageChangeImpactSchema }) });
const pageChangePlanPageSchema: JsonSchema = pageCatalogItemSchema;
const cmsCollectionSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["id", "label", "addLabel", "ordering", "pathPrefix", "titleField", "slugField", "imageField", "subtitleField", "capabilities", "fields"]), additionalProperties: false,
  properties: Object.freeze({ id: Object.freeze({ type: "string" }), label: Object.freeze({ type: "string" }), addLabel: Object.freeze({ type: "string" }), icon: Object.freeze({ type: "string", enum: Object.freeze(["document", "people", "person", "tag"]) }),
    ordering: Object.freeze({ type: "string", enum: Object.freeze(["publishedAt", "manual"]) }), pathPrefix: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    titleField: Object.freeze({ type: "string" }), slugField: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    imageField: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }), subtitleField: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    capabilities: Object.freeze({ type: "object", additionalProperties: true }), fields: Object.freeze({ type: "array", maxItems: 100, items: Object.freeze({ type: "object", additionalProperties: true }) }) }) });
const cmsItemSummarySchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["id", "title", "subtitle", "imageUrl", "path", "status", "publishedAt", "updatedAt", "updatedBy", "scheduledAt", "publishFailed", "order"]), additionalProperties: false,
  properties: Object.freeze({ id: Object.freeze({ type: "string" }), title: Object.freeze({ type: "string" }), subtitle: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    imageUrl: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }), path: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    status: Object.freeze({ type: "string", enum: Object.freeze(["draft", "published", "changed", "publishing", "scheduled"]) }),
    publishedAt: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }), updatedAt: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    updatedBy: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }), scheduledAt: Object.freeze({ oneOf: Object.freeze([{ type: "string" }, { const: null }]) }),
    publishFailed: Object.freeze({ type: "boolean" }), order: Object.freeze({ oneOf: Object.freeze([{ type: "number" }, { const: null }]) }) }) });
const cmsItemSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["id", "title", "subtitle", "imageUrl", "path", "status", "publishedAt", "updatedAt", "updatedBy", "scheduledAt", "publishFailed", "order", "version", "values"]), additionalProperties: false,
  properties: Object.freeze({ ...cmsItemSummarySchema.properties, version: versionSchema, values: Object.freeze({ type: "object", additionalProperties: true }) }) });
const cmsItemIdSchema: JsonSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 128 });
const cmsCollectionIdSchema: JsonSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 80 });
const operationIdSchema: JsonSchema = Object.freeze({ type: "string", minLength: 36, maxLength: 36 });
const cmsPublishPlanSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["target", "expectedVersion", "operationId", "confirmationToken", "item"]), additionalProperties: false,
  properties: Object.freeze({ target: Object.freeze({ type: "object", required: Object.freeze(["siteId", "collectionId", "itemId"]), additionalProperties: false,
    properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), collectionId: cmsCollectionIdSchema, itemId: cmsItemIdSchema }) }), expectedVersion: versionSchema,
    operationId: operationIdSchema, confirmationToken: versionSchema, item: cmsItemSchema, redirect: Object.freeze({ type: "boolean" }) }) });
const releaseRequestProperties = Object.freeze({
  siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }), expectedVersion: versionSchema,
  action: Object.freeze({ type: "string", enum: Object.freeze(["publish", "rollback"]) }), revision: Object.freeze({ type: "number", minimum: 1 }),
  componentsVersion: versionSchema, presentationVersion: versionSchema
});
const releasePlanSchema: JsonSchema = Object.freeze({ type: "object", required: Object.freeze(["target", "expectedVersion", "action", "confirmationToken", "domain", "changes"]), additionalProperties: false,
  properties: Object.freeze({
    target: Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }) }) }),
    expectedVersion: versionSchema, action: Object.freeze({ type: "string", enum: Object.freeze(["publish", "rollback"]) }), revision: Object.freeze({ type: "number", minimum: 1 }),
    componentsVersion: versionSchema, presentationVersion: versionSchema, confirmationToken: versionSchema, domain: Object.freeze({ type: "string" }),
    changes: Object.freeze({ type: "array", items: Object.freeze({ type: "object", required: Object.freeze(["path", "before", "after"]), additionalProperties: false,
      properties: Object.freeze({ path: Object.freeze({ type: "string" }), before: Object.freeze({ type: "string" }), after: Object.freeze({ type: "string" }) }) }) }),
    url: Object.freeze({ type: "string" }), affected: Object.freeze({ type: "array", items: Object.freeze({ type: "object" }) })
  })
});

const pageReleaseSetItemSchema: JsonSchema = Object.freeze({
  type: "object", required: Object.freeze(["target", "expectedVersion"]), additionalProperties: false,
  properties: Object.freeze({ target: pageTargetSchema, expectedVersion: versionSchema, componentsVersion: versionSchema, presentationVersion: versionSchema })
});
const pageReleaseSetItemsSchema: JsonSchema = Object.freeze({ type: "array", minItems: 2, maxItems: 50, items: pageReleaseSetItemSchema });
const pageReleaseSetPlanSchema: JsonSchema = Object.freeze({
  type: "object", required: Object.freeze(["siteId", "operationId", "confirmationToken", "domain", "items"]), additionalProperties: false,
  properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), operationId: operationIdSchema, confirmationToken: versionSchema,
    domain: Object.freeze({ type: "string" }), items: pageReleaseSetItemsSchema })
});
const pageReleaseSetItemResultSchema: JsonSchema = Object.freeze({ oneOf: Object.freeze([
  Object.freeze({ type: "object", required: Object.freeze(["target", "status", "version"]), additionalProperties: false,
    properties: Object.freeze({ target: pageTargetSchema, status: Object.freeze({ const: "released" }), version: versionSchema }) }),
  ...(["conflict", "pending"] as const).map((status) => Object.freeze({ type: "object", required: Object.freeze(["target", "status"]), additionalProperties: false,
    properties: Object.freeze({ target: pageTargetSchema, status: Object.freeze({ const: status }) }) }))
]) });
const pageReleaseSetResultSchema: JsonSchema = Object.freeze({
  type: "object", required: Object.freeze(["status", "operationId", "items"]), additionalProperties: false,
  properties: Object.freeze({ status: Object.freeze({ type: "string", enum: Object.freeze(["completed", "publishing"]) }), operationId: operationIdSchema,
    items: Object.freeze({ type: "array", minItems: 2, maxItems: 50, items: pageReleaseSetItemResultSchema }) })
});
const pageReleaseSetStatusSchema: JsonSchema = Object.freeze({
  type: "object", required: Object.freeze(["status", "operationId"]), additionalProperties: false,
  properties: Object.freeze({ status: Object.freeze({ type: "string", enum: Object.freeze(["unknown", "received", "completed"]) }), operationId: operationIdSchema,
    httpStatus: Object.freeze({ type: "integer", minimum: 100, maximum: 599 }), result: Object.freeze({ type: "object", additionalProperties: true }) })
});

/** Canonical resource operations for hosts to expose to GUI and machine clients. */
export const EDITING_OPERATIONS = Object.freeze([
  Object.freeze({
    id: "pages.read", capability: "pages.read", method: "GET", path: "/sites/{siteId}/operations/pages.read/{pageId}?locale={locale}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["document", "version"]), additionalProperties: false,
      properties: Object.freeze({ document: documentSchema, version: versionSchema, componentsVersion: versionSchema, presentationVersion: versionSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const)
  }),
  Object.freeze({
    id: "pages.save", capability: "pages.edit", method: "PUT", path: "/sites/{siteId}/operations/pages.save/{pageId}?locale={locale}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale", "expectedVersion", "document"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }), expectedVersion: versionSchema, document: documentSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "version", "document"]), additionalProperties: false,
      properties: Object.freeze({ status: Object.freeze({ const: "saved" }), version: versionSchema, document: documentSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({
    id: "pages.release-plan", capability: "pages.publish", method: "POST", path: "/sites/{siteId}/operations/pages.release-plan/{pageId}?locale={locale}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale", "expectedVersion", "action"]), additionalProperties: false, properties: releaseRequestProperties }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["plan"]), additionalProperties: false, properties: Object.freeze({ plan: releasePlanSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({
    id: "pages.release", capability: "pages.publish", method: "POST", path: "/sites/{siteId}/operations/pages.release/{pageId}?locale={locale}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "pageId", "locale", "expectedVersion", "confirmationToken", "operationId"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), pageId: Object.freeze({ type: "string" }), locale: Object.freeze({ type: "string" }), expectedVersion: versionSchema,
        confirmationToken: versionSchema, operationId: Object.freeze({ type: "string", minLength: 36, maxLength: 36 }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "operationId", "version", "document"]), additionalProperties: false,
      properties: Object.freeze({ status: Object.freeze({ const: "released" }), operationId: Object.freeze({ type: "string", minLength: 36, maxLength: 36 }), version: versionSchema, document: documentSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({
    id: "pages.release-set-plan", capability: "pages.publish", method: "POST", path: "/sites/{siteId}/operations/pages.release-set-plan",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "operationId", "items"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), operationId: operationIdSchema, items: pageReleaseSetItemsSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["plan"]), additionalProperties: false, properties: Object.freeze({ plan: pageReleaseSetPlanSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({
    id: "pages.release-set", capability: "pages.publish", method: "POST", path: "/sites/{siteId}/operations/pages.release-set",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "operationId", "confirmationToken", "items"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), operationId: operationIdSchema, confirmationToken: versionSchema, items: pageReleaseSetItemsSchema }) }),
    resultSchema: pageReleaseSetResultSchema,
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({
    id: "pages.release-set-status", capability: "pages.read", method: "GET", path: "/sites/{siteId}/operations/pages.release-set-status/{operationId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "operationId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), operationId: operationIdSchema }) }),
    resultSchema: pageReleaseSetStatusSchema,
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const)
  }),
  Object.freeze({
    id: "pages.catalog", capability: "pages.read", method: "GET", path: "/sites/{siteId}/operations/pages.catalog",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["version", "pages"]), additionalProperties: false,
      properties: Object.freeze({ version: versionSchema, pages: Object.freeze({ type: "array", maxItems: 500, items: pageCatalogItemSchema }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const)
  }),
  Object.freeze({
    id: "pages.change-prepare", capability: "pages.publish", method: "POST", path: "/sites/{siteId}/operations/pages.change-prepare",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["expectedVersion", "operationId", "change"]), additionalProperties: false,
      properties: Object.freeze({ expectedVersion: versionSchema, operationId: Object.freeze({ type: "string", minLength: 36, maxLength: 36 }), change: pageChangeSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["plan"]), additionalProperties: false, properties: Object.freeze({ plan: pageManagementPlanSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({
    id: "pages.change-apply", capability: "pages.publish", method: "POST", path: "/sites/{siteId}/operations/pages.change-apply",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["expectedVersion", "operationId", "confirmationToken", "change"]), additionalProperties: false,
      properties: Object.freeze({ expectedVersion: versionSchema, operationId: Object.freeze({ type: "string", minLength: 36, maxLength: 36 }), confirmationToken: versionSchema, change: pageChangeSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "operationId", "page"]), additionalProperties: false,
      properties: Object.freeze({ status: Object.freeze({ const: "applied" }), operationId: Object.freeze({ type: "string", minLength: 36, maxLength: 36 }), page: pageChangePlanPageSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({ id: "cms.schema", capability: "cms.read", method: "GET", path: "/sites/{siteId}/operations/cms.schema",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["collections"]), additionalProperties: false, properties: Object.freeze({ collections: Object.freeze({ type: "array", maxItems: 50, items: cmsCollectionSchema }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "cms.list", capability: "cms.read", method: "GET", path: "/sites/{siteId}/operations/cms.list/{collectionId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "collectionId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), collectionId: cmsCollectionIdSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["collectionId", "items"]), additionalProperties: false, properties: Object.freeze({ collectionId: cmsCollectionIdSchema, items: Object.freeze({ type: "array", maxItems: 10000, items: cmsItemSummarySchema }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "cms.read", capability: "cms.read", method: "GET", path: "/sites/{siteId}/operations/cms.read/{collectionId}/{itemId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "collectionId", "itemId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), collectionId: cmsCollectionIdSchema, itemId: cmsItemIdSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["item"]), additionalProperties: false, properties: Object.freeze({ item: cmsItemSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "cms.create", capability: "cms.edit", method: "POST", path: "/sites/{siteId}/operations/cms.create/{collectionId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["operationId"]), additionalProperties: false, properties: Object.freeze({ operationId: operationIdSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["item"]), additionalProperties: false, properties: Object.freeze({ item: cmsItemSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "cms.save", capability: "cms.edit", method: "PUT", path: "/sites/{siteId}/operations/cms.save/{collectionId}/{itemId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["expectedVersion", "operationId", "values"]), additionalProperties: false, properties: Object.freeze({ expectedVersion: versionSchema, operationId: operationIdSchema, values: Object.freeze({ type: "object", additionalProperties: true }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "item"]), additionalProperties: false, properties: Object.freeze({ status: Object.freeze({ const: "saved" }), item: cmsItemSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "validation_failed", "version_conflict"] as const) }),
  Object.freeze({ id: "cms.publish-plan", capability: "cms.publish", method: "POST", path: "/sites/{siteId}/operations/cms.publish-plan/{collectionId}/{itemId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["expectedVersion", "operationId"]), additionalProperties: false, properties: Object.freeze({ expectedVersion: versionSchema, operationId: operationIdSchema, redirect: Object.freeze({ type: "boolean" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["plan"]), additionalProperties: false, properties: Object.freeze({ plan: cmsPublishPlanSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const) }),
  Object.freeze({ id: "cms.publish", capability: "cms.publish", method: "POST", path: "/sites/{siteId}/operations/cms.publish/{collectionId}/{itemId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["expectedVersion", "operationId", "confirmationToken"]), additionalProperties: false,
      properties: Object.freeze({ expectedVersion: versionSchema, operationId: operationIdSchema, confirmationToken: versionSchema, redirect: Object.freeze({ type: "boolean" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "operationId", "item"]), additionalProperties: false,
      properties: Object.freeze({ status: Object.freeze({ type: "string", enum: Object.freeze(["published", "publishing"]) }), operationId: operationIdSchema, item: cmsItemSchema }) }),
    errors: Object.freeze(["authentication_required", "duplicate_operation", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const) }),
  Object.freeze({ id: "cms.operation-status", capability: "cms.read", method: "GET", path: "/sites/{siteId}/operations/cms.operation-status/{operationId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "operationId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), operationId: operationIdSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "operationId"]), additionalProperties: false,
      properties: Object.freeze({ status: Object.freeze({ type: "string", enum: Object.freeze(["unknown", "received", "completed"]) }), operationId: operationIdSchema,
        httpStatus: Object.freeze({ type: "integer", minimum: 100, maximum: 599 }), result: Object.freeze({ type: "object", additionalProperties: true }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({
    id: "site.breakpoints.read", capability: "site.settings.read", method: "GET", path: "/sites/{siteId}/operations/site.breakpoints.read",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["settings", "version"]), additionalProperties: false,
      properties: Object.freeze({ settings: breakpointSettingsSchema, version: versionSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const)
  }),
  Object.freeze({
    id: "site.breakpoints.save", capability: "site.settings.write", method: "PUT", path: "/sites/{siteId}/operations/site.breakpoints.save",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "expectedVersion", "settings"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), expectedVersion: versionSchema, settings: breakpointSettingsSchema }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["status", "version"]), additionalProperties: false,
      properties: Object.freeze({ status: Object.freeze({ const: "saved" }), version: versionSchema }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found", "version_conflict"] as const)
  }),
  Object.freeze({ id: "assets.list", capability: "assets.read", method: "GET", path: "/sites/{siteId}/operations/assets.list?search={search}&kind={kind}&limit={limit}&folderId={folderId}&cursor={cursor}&provider={provider}&recent={recent}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "search", "kind", "folderId", "limit"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), search: Object.freeze({ type: "string", maxLength: 200 }), kind: Object.freeze({ type: "string", enum: Object.freeze(["all", "image", "video", "pdf", "other"]) }),
        folderId: Object.freeze({ oneOf: Object.freeze([Object.freeze({ type: "string", maxLength: 128 }), Object.freeze({ const: null })]) }), limit: Object.freeze({ type: "integer", minimum: 1, maximum: ASSET_LIMITS.listAssets }),
        cursor: Object.freeze({ type: "string", maxLength: ASSET_LIMITS.cursorLength }), provider: Object.freeze({ type: "string", maxLength: 80 }), recent: Object.freeze({ type: "boolean" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["assets", "folders"]), additionalProperties: false,
      properties: Object.freeze({ assets: Object.freeze({ type: "array", maxItems: ASSET_LIMITS.listAssets, items: Object.freeze({ type: "object" }) }), folders: Object.freeze({ type: "array", maxItems: ASSET_LIMITS.folders, items: Object.freeze({ type: "object" }) }),
        quota: Object.freeze({ type: "object" }), upload: Object.freeze({ type: "object" }), nextCursor: Object.freeze({ type: "string" }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "assets.usages", capability: "assets.read", method: "GET", path: "/sites/{siteId}/operations/assets.usages/{provider}/{assetId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "provider", "assetId"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), provider: Object.freeze({ type: "string" }), assetId: Object.freeze({ type: "string" }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["usages"]), additionalProperties: false, properties: Object.freeze({ usages: Object.freeze({ type: "array", maxItems: ASSET_LIMITS.usages, items: Object.freeze({ type: "object" }) }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "assets.resolve", capability: "assets.read", method: "POST", path: "/sites/{siteId}/operations/assets.resolve",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "references"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), references: Object.freeze({ type: "array", maxItems: ASSET_LIMITS.resolvedAssets, items: Object.freeze({ type: "object" }) }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["assets"]), additionalProperties: false, properties: Object.freeze({ assets: Object.freeze({ type: "object", additionalProperties: true }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "assets.update", capability: "assets.edit", method: "PUT", path: "/sites/{siteId}/operations/assets.update/{provider}/{assetId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "provider", "assetId", "expectedVersion", "changes"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), provider: Object.freeze({ type: "string" }), assetId: Object.freeze({ type: "string" }), expectedVersion: versionSchema, changes: Object.freeze({ type: "object", additionalProperties: false,
      properties: Object.freeze({ name: Object.freeze({ type: "string", maxLength: 200 }), alt: Object.freeze({ type: "string", maxLength: 1000 }), folderId: Object.freeze({ oneOf: Object.freeze([Object.freeze({ type: "string", maxLength: 128 }), Object.freeze({ const: null })]) }) }) }) }) }),
    resultSchema: Object.freeze({ oneOf: Object.freeze([Object.freeze({ type: "object", required: Object.freeze(["status", "asset"]), additionalProperties: false, properties: Object.freeze({ status: Object.freeze({ const: "saved" }), asset: Object.freeze({ type: "object" }) }) }),
      Object.freeze({ type: "object", required: Object.freeze(["status"]), additionalProperties: false, properties: Object.freeze({ status: Object.freeze({ const: "conflict" }) }) }), Object.freeze({ type: "object", required: Object.freeze(["status", "reason"]), additionalProperties: false, properties: Object.freeze({ status: Object.freeze({ const: "rejected" }), reason: Object.freeze({ type: "string", enum: Object.freeze(["permission", "invalid"]) }) }) })]) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "assets.upload-intent", capability: "assets.upload", method: "POST", path: "/sites/{siteId}/operations/assets.upload-intent",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "name", "mimeType", "bytes", "folderId", "provider"]), additionalProperties: false,
      properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), name: Object.freeze({ type: "string", maxLength: 200 }), mimeType: Object.freeze({ type: "string", maxLength: 100 }), bytes: Object.freeze({ type: "integer", minimum: 1 }),
        folderId: Object.freeze({ oneOf: Object.freeze([Object.freeze({ type: "string", maxLength: 128 }), Object.freeze({ const: null })]) }), provider: Object.freeze({ type: "string", maxLength: 80 }) }) }),
    resultSchema: Object.freeze({ type: "object", required: Object.freeze(["uploadUrl", "uploadToken", "assetId"]), additionalProperties: false,
      properties: Object.freeze({ uploadUrl: Object.freeze({ type: "string" }), uploadToken: Object.freeze({ type: "string" }), assetId: Object.freeze({ type: "string" }) }) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "assets.delete", capability: "assets.delete", method: "POST", path: "/sites/{siteId}/operations/assets.delete/{provider}/{assetId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "provider", "assetId", "expectedVersion"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), provider: Object.freeze({ type: "string" }), assetId: Object.freeze({ type: "string" }), expectedVersion: versionSchema }) }),
    resultSchema: Object.freeze({ oneOf: Object.freeze([Object.freeze({ type: "object", required: Object.freeze(["status"]), properties: Object.freeze({ status: Object.freeze({ enum: Object.freeze(["deleted", "conflict"]) }) }) }),
      Object.freeze({ type: "object", required: Object.freeze(["status", "usages"]), properties: Object.freeze({ status: Object.freeze({ const: "in-use" }), usages: Object.freeze({ type: "array", items: Object.freeze({ type: "object" }) }) }) }),
      Object.freeze({ type: "object", required: Object.freeze(["status", "reason"]), properties: Object.freeze({ status: Object.freeze({ const: "rejected" }), reason: Object.freeze({ const: "permission" }) }) })]) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  Object.freeze({ id: "assets.restore", capability: "assets.delete", method: "POST", path: "/sites/{siteId}/operations/assets.restore/{provider}/{assetId}",
    inputSchema: Object.freeze({ type: "object", required: Object.freeze(["siteId", "provider", "assetId", "expectedVersion"]), additionalProperties: false, properties: Object.freeze({ siteId: Object.freeze({ type: "string" }), provider: Object.freeze({ type: "string" }), assetId: Object.freeze({ type: "string" }), expectedVersion: versionSchema }) }),
    resultSchema: Object.freeze({ oneOf: Object.freeze([Object.freeze({ type: "object", required: Object.freeze(["status"]), properties: Object.freeze({ status: Object.freeze({ enum: Object.freeze(["restored", "conflict"]) }) }) }),
      Object.freeze({ type: "object", required: Object.freeze(["status", "reason"]), properties: Object.freeze({ status: Object.freeze({ const: "rejected" }), reason: Object.freeze({ enum: Object.freeze(["permission", "invalid"]) }) }) })]) }),
    errors: Object.freeze(["authentication_required", "forbidden", "host_contract_violation", "host_failure", "invalid_request", "method_not_allowed", "not_found"] as const) }),
  ...LOCALIZATION_EDITING_OPERATIONS,
] as const satisfies readonly EditingOperationDefinitionShape[]);
/** Operation metadata and IDs have a single source: the catalog above. */
export type EditingOperationDefinition = (typeof EDITING_OPERATIONS)[number];
type CapabilityValues<T> = T extends { readonly capabilityByInput: { readonly values: infer Values } } ? Values[keyof Values] : never;
export type EditingCapability = EditingOperationDefinition["capability"] | CapabilityValues<EditingOperationDefinition>;
function operationCapabilities(operation: EditingOperationDefinition): readonly EditingCapability[] {
  if ("capabilityByInput" in operation) return [...new Set(Object.values(operation.capabilityByInput.values))];
  return [operation.capability];
}
export const EDITING_CAPABILITIES: readonly EditingCapability[] = Object.freeze([...new Set(EDITING_OPERATIONS.flatMap(operationCapabilities))]);

export type PageEditingHostAdapter = {
  /** Host owns login/session/API-key verification. Return null for an unauthenticated request. */
  authenticate(request: Request): Promise<EditingActor | null>;
  /** Resolve permissions from the authenticated principal for each request. */
  authorize(actor: EditingActor, capability: EditingCapability, target: EditingAuthorizationScope): Promise<boolean>;
  /** Trusted host schemas needed for custom blocks, component instances and site-wide style tokens. */
  validationContext?(actor: EditingActor, target: EditingPageTarget): Promise<PageEditingValidationContext>;
  readPage(actor: EditingActor, target: EditingPageTarget): Promise<EditingPageSnapshot | null>;
  savePage(actor: EditingActor, target: EditingPageTarget, expectedVersion: string, document: PageDocument): Promise<EditingPageSaveResult>;
  /** Return the host's trusted site metadata, including the allowed publication origins. */
  releaseSite?(actor: EditingActor, siteId: string): Promise<EditorSite | null>;
  /** Return a host-bound preview plan; host must verify current version and domain allowlist. */
  preparePageRelease?(actor: EditingActor, request: EditorReleaseRequest): Promise<EditingPageReleasePrepareResult>;
  /** Atomically publish after validating the one-use token; same actor + operationId + input must return the stored result. */
  publishPage?(actor: EditingActor, target: EditingPageTarget, input: { readonly expectedVersion: string; readonly confirmationToken: string; readonly operationId: string }): Promise<EditingPagePublishResult>;
  /**
   * Optional multi-page publish set. Bind every target and version into the one-use token, report each target's
   * released/conflict/pending state, and make retries idempotent per actor + operationId + input so completed targets are not published twice.
   * A top-level conflict must be returned before any target is published; per-target version conflicts belong in the item results.
   */
  preparePageReleaseSet?(actor: EditingActor, siteId: string, operationId: string, items: readonly EditingPageReleaseSetItem[]): Promise<EditingPageReleaseSetPrepareResult>;
  publishPageReleaseSet?(actor: EditingActor, siteId: string, input: { readonly operationId: string; readonly confirmationToken: string; readonly items: readonly EditingPageReleaseSetItem[] }): Promise<EditingPageReleaseSetApplyResult>;
  readPageReleaseSetStatus?(actor: EditingActor, siteId: string, operationId: string): Promise<EditingPageReleaseSetStatus | null>;
  /** Optional site settings share the same discovery, authentication, authorization and wire contract. */
  readBreakpointSettings?(actor: EditingActor, siteId: string): Promise<EditorBreakpointSettingsSnapshot | null>;
  saveBreakpointSettings?(actor: EditingActor, siteId: string, expectedVersion: string, settings: EditorBreakpointSettings): Promise<EditorBreakpointSettingsSaveResult>;
  /** Optional native page catalog and two phase page management operations. */
  readPageCatalog?(actor: EditingActor, siteId: string): Promise<EditingPageCatalog | null>;
  preparePageChange?(actor: EditingActor, siteId: string, expectedVersion: string, operationId: string, change: EditingPageChange): Promise<EditingPageManagementPrepareResult>;
  applyPageChange?(actor: EditingActor, siteId: string, input: EditingPageManagementApplyInput): Promise<EditingPageManagementApplyResult>;
  /** Optional CMS operations use the same site authentication, authorization, audit and wire contract as pages. */
  readCmsSchema?(actor: EditingActor, siteId: string): Promise<unknown | null>;
  listCmsItems?(actor: EditingActor, siteId: string, collectionId: string): Promise<unknown | null>;
  readCmsItem?(actor: EditingActor, target: EditingCmsTarget): Promise<unknown | null>;
  createCmsItem?(actor: EditingActor, siteId: string, collectionId: string, operationId: string): Promise<unknown>;
  saveCmsItem?(actor: EditingActor, target: EditingCmsTarget, expectedVersion: string, operationId: string, values: CollectionValues): Promise<unknown>;
  prepareCmsPublish?(actor: EditingActor, target: EditingCmsTarget, expectedVersion: string, operationId: string, options?: { readonly redirect?: boolean }): Promise<EditingCmsPublishPrepareResult>;
  publishCmsItem?(actor: EditingActor, target: EditingCmsTarget, input: { readonly expectedVersion: string; readonly operationId: string; readonly confirmationToken: string; readonly redirect?: boolean }): Promise<EditingCmsPublishApplyResult>;
  readCmsOperationStatus?(actor: EditingActor, siteId: string, operationId: string): Promise<EditingCmsOperationStatus | null>;
  /** Optional site-owned translation workspace operations. */
  localization?: EditingLocalizationHostAdapter;
  /** Optional asset operations use host-owned storage and the same actor authorization/audit path. */
  listAssets?(actor: EditingActor, query: AssetListQuery): Promise<unknown | null>;
  listAssetUsages?(actor: EditingActor, siteId: string, reference: AssetReference): Promise<unknown>;
  resolveAssets?(actor: EditingActor, siteId: string, references: readonly AssetReference[]): Promise<unknown>;
  createAssetUploadIntent?(actor: EditingActor, siteId: string, input: { readonly folderId: string | null; readonly name: string; readonly mimeType: string; readonly bytes: number; readonly provider?: string }): Promise<unknown>;
  updateAsset?(actor: EditingActor, request: AssetUpdateRequest): Promise<unknown>;
  deleteAsset?(actor: EditingActor, request: { readonly siteId: string; readonly reference: AssetReference; readonly expectedVersion: string }): Promise<unknown>;
  restoreAsset?(actor: EditingActor, request: { readonly siteId: string; readonly reference: AssetReference; readonly expectedVersion: string }): Promise<unknown>;
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff"
  } });
}
function fail(error: EditingApiErrorCode, status: number): Response { return response({ error }, status); }
function validVersion(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value); }
function validActor(value: unknown): value is EditingActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return (actor.kind === "human" || actor.kind === "machine") && validVersion(actor.subject)
    && (actor.delegatedBy === undefined || validVersion(actor.delegatedBy))
    && (actor.email === undefined || typeof actor.email === "string" && actor.email.length <= 254
      && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(actor.email));
}
function pageTarget(siteId: unknown, pageId: unknown, locale: unknown): EditingPageTarget | null {
  try { return { siteId: identifier(siteId, "$target.siteId"), pageId: identifier(pageId, "$target.pageId"), locale: localeCode(locale, "$target.locale") }; }
  catch { return null; }
}
async function readBody(request: Request, maxBytes = 4 * 1024 * 1024): Promise<Record<string, unknown> | null> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function validOperationId(value: unknown): value is string { return typeof value === "string" && OPERATION_ID.test(value); }
function supportsOperation(adapter: PageEditingHostAdapter, operation: EditingOperationDefinition): boolean {
  const localization = editingLocalizationOperation(operation.id);
  if (localization) return typeof adapter.localization?.[localization.id] === "function";
  if (operation.id === "pages.release-plan" || operation.id === "pages.release") return typeof adapter.releaseSite === "function" && typeof adapter.preparePageRelease === "function" && typeof adapter.publishPage === "function";
  if (operation.id === "pages.release-set-plan" || operation.id === "pages.release-set") return typeof adapter.releaseSite === "function" && typeof adapter.preparePageReleaseSet === "function" && typeof adapter.publishPageReleaseSet === "function";
  if (operation.id === "pages.release-set-status") return typeof adapter.readPageReleaseSetStatus === "function";
  if (operation.id === "pages.catalog") return typeof adapter.readPageCatalog === "function";
  if (operation.id === "pages.change-prepare") return typeof adapter.releaseSite === "function" && typeof adapter.preparePageChange === "function";
  if (operation.id === "pages.change-apply") return typeof adapter.releaseSite === "function" && typeof adapter.applyPageChange === "function";
  if (operation.id === "site.breakpoints.read") return typeof adapter.readBreakpointSettings === "function";
  if (operation.id === "site.breakpoints.save") return typeof adapter.saveBreakpointSettings === "function";
  if (operation.id === "cms.schema") return typeof adapter.readCmsSchema === "function";
  if (operation.id === "cms.list") return typeof adapter.listCmsItems === "function";
  if (operation.id === "cms.read") return typeof adapter.readCmsItem === "function" && typeof adapter.readCmsSchema === "function";
  if (operation.id === "cms.create") return typeof adapter.createCmsItem === "function" && typeof adapter.readCmsSchema === "function";
  if (operation.id === "cms.save") return typeof adapter.saveCmsItem === "function" && typeof adapter.readCmsSchema === "function";
  if (operation.id === "cms.publish-plan") return typeof adapter.prepareCmsPublish === "function" && typeof adapter.readCmsSchema === "function";
  if (operation.id === "cms.publish") return typeof adapter.publishCmsItem === "function" && typeof adapter.readCmsSchema === "function";
  if (operation.id === "cms.operation-status") return typeof adapter.readCmsOperationStatus === "function";
  if (operation.id === "assets.list") return typeof adapter.listAssets === "function";
  if (operation.id === "assets.usages") return typeof adapter.listAssetUsages === "function";
  if (operation.id === "assets.resolve") return typeof adapter.resolveAssets === "function";
  if (operation.id === "assets.update") return typeof adapter.updateAsset === "function";
  if (operation.id === "assets.upload-intent") return typeof adapter.createAssetUploadIntent === "function";
  if (operation.id === "assets.delete") return typeof adapter.deleteAsset === "function";
  if (operation.id === "assets.restore") return typeof adapter.restoreAsset === "function";
  return true;
}
const CMS_COLLECTION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/u;
const CMS_ITEM_ID = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}$/u;
function cmsCollectionId(value: unknown): string | null {
  return typeof value === "string" && CMS_COLLECTION_ID.test(value) && !["__proto__", "constructor", "prototype"].includes(value) ? value : null;
}
function cmsItemId(value: unknown): string | null {
  return typeof value === "string" && CMS_ITEM_ID.test(value) && value !== "." && value !== ".." && !["__proto__", "constructor", "prototype"].includes(value) ? value : null;
}
function cmsTarget(siteId: string, collectionId: unknown, itemId: unknown): EditingCmsTarget | null {
  const collection = cmsCollectionId(collectionId), item = cmsItemId(itemId);
  return collection && item ? { siteId, collectionId: collection, itemId: item } : null;
}
function pageReleaseSetItems(value: unknown, siteId: string): EditingPageReleaseSetItem[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) return null;
  const items: EditingPageReleaseSetItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const allowed = ["target", "expectedVersion", "componentsVersion", "presentationVersion"];
    if (!Object.keys(item).every((key) => allowed.includes(key)) || !item.target || typeof item.target !== "object" || Array.isArray(item.target)) return null;
    const targetValue = item.target as Record<string, unknown>;
    if (!exactKeys(targetValue, ["siteId", "pageId", "locale"])) return null;
    const target = pageTarget(targetValue.siteId, targetValue.pageId, targetValue.locale);
    if (!target || target.siteId !== siteId || !validVersion(item.expectedVersion)
      || item.componentsVersion !== undefined && !validVersion(item.componentsVersion)
      || item.presentationVersion !== undefined && !validVersion(item.presentationVersion)) return null;
    const key = `${target.pageId}\u0000${target.locale}`;
    if (seen.has(key)) return null;
    seen.add(key);
    items.push({ target, expectedVersion: item.expectedVersion,
      ...(item.componentsVersion === undefined ? {} : { componentsVersion: item.componentsVersion }),
      ...(item.presentationVersion === undefined ? {} : { presentationVersion: item.presentationVersion }) });
  }
  return items;
}
function samePageReleaseSetItems(left: readonly EditingPageReleaseSetItem[], right: readonly EditingPageReleaseSetItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return !!other && item.target.siteId === other.target.siteId && item.target.pageId === other.target.pageId && item.target.locale === other.target.locale
      && item.expectedVersion === other.expectedVersion && item.componentsVersion === other.componentsVersion && item.presentationVersion === other.presentationVersion;
  });
}
function pageReleaseSetApplyResult(value: unknown, siteId: string, operationId: string, expectedItems?: readonly EditingPageReleaseSetItem[]): EditingPageReleaseSetApplyResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, ["status", "operationId", "items"]) || result.operationId !== operationId
    || result.status !== "completed" && result.status !== "publishing" || !Array.isArray(result.items)
    || result.items.length < 2 || result.items.length > 50 || expectedItems && result.items.length !== expectedItems.length) return null;
  const seen = new Set<string>(), items: EditingPageReleaseSetItemResult[] = [];
  let hasPending = false;
  for (const [index, raw] of result.items.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (!item.target || typeof item.target !== "object" || Array.isArray(item.target)) return null;
    const targetValue = item.target as Record<string, unknown>;
    if (!exactKeys(targetValue, ["siteId", "pageId", "locale"])) return null;
    const target = pageTarget(targetValue.siteId, targetValue.pageId, targetValue.locale);
    const expected = expectedItems?.[index];
    if (!target || target.siteId !== siteId || expected && (target.pageId !== expected.target.pageId || target.locale !== expected.target.locale)) return null;
    const key = `${target.pageId}\u0000${target.locale}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (item.status === "released") {
      if (!exactKeys(item, ["target", "status", "version"]) || !validVersion(item.version)) return null;
      items.push({ target, status: "released", version: item.version });
    } else if (item.status === "conflict" || item.status === "pending") {
      if (!exactKeys(item, ["target", "status"])) return null;
      if (item.status === "pending") hasPending = true;
      items.push({ target, status: item.status });
    } else return null;
  }
  if ((result.status === "publishing") !== hasPending) return null;
  return { status: result.status, operationId, items };
}
function editingAssetReference(providerValue: unknown, assetIdValue: unknown): AssetReference | null {
  try { return parseAssetReference({ provider: providerValue, id: assetIdValue }); } catch { return null; }
}
function assetListQuery(url: URL, siteId: string): AssetListQuery | null {
  const allowed = new Set(["search", "kind", "folderId", "limit", "cursor", "provider", "recent"]);
  let invalid = false;
  url.searchParams.forEach((value, key) => { if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1 || /[\u0000-\u001f\u007f]/u.test(value)) invalid = true; });
  if (invalid) return null;
  const search = url.searchParams.get("search") ?? "", kind = url.searchParams.get("kind") ?? "all", folderValue = url.searchParams.get("folderId");
  const limitValue = url.searchParams.get("limit") ?? "60", cursor = url.searchParams.get("cursor") ?? undefined;
  const providerValue = url.searchParams.get("provider") ?? undefined, recentValue = url.searchParams.get("recent") ?? undefined;
  const limit = Number(limitValue);
  if (search.length > 200 || !["all", "image", "video", "pdf", "other"].includes(kind) || !/^\d{1,3}$/u.test(limitValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > ASSET_LIMITS.listAssets
    || folderValue !== null && !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(folderValue) || cursor !== undefined && cursor.length > ASSET_LIMITS.cursorLength
    || providerValue !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(providerValue) || recentValue !== undefined && recentValue !== "true" && recentValue !== "false") return null;
  let folderId: string | null = null;
  if (folderValue !== null) { try { folderId = assetId(folderValue, "$folderId"); } catch { return null; } }
  return { siteId, search, kind: kind as AssetListQuery["kind"], folderId, limit,
    ...(cursor === undefined ? {} : { cursor }), ...(providerValue === undefined ? {} : { provider: providerValue }),
    ...(recentValue === undefined ? {} : { recent: recentValue === "true" }) };
}
function validAssetName(value: unknown): value is string {
  return typeof value === "string" && value.length <= ASSET_LIMITS.nameLength && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validMimeType(value: unknown): value is string {
  return typeof value === "string" && value.length <= ASSET_LIMITS.mimeTypeLength && /^[a-z]+\/[a-z0-9.+-]+$/u.test(value);
}
async function cmsDefinition(adapter: PageEditingHostAdapter, actor: EditingActor, siteId: string, collectionId: string): Promise<CollectionDefinition | "forbidden" | null> {
  const raw = await adapter.readCmsSchema!(actor, siteId);
  if (!raw) return null;
  const schema = parseCollectionSchemaResult(raw);
  return schema.status === "ready" ? schema.collections.find((item) => item.id === collectionId) ?? null : "forbidden";
}
function managementChange(value: unknown, siteId: string): EditingPageChange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.action === "create" && !exactKeys(source, ["action", "siteId", "locale", "title", "path"])) return null;
  if (source.action === "update" && (!exactKeys(source, ["action", "target", "title", "path"])
    || !source.target || typeof source.target !== "object" || Array.isArray(source.target)
    || !exactKeys(source.target as Record<string, unknown>, ["siteId", "pageId", "locale"]))) return null;
  if (source.action === "visibility" && (!exactKeys(source, ["action", "target", "visibility"])
    || !source.target || typeof source.target !== "object" || Array.isArray(source.target)
    || !exactKeys(source.target as Record<string, unknown>, ["siteId", "pageId", "locale"]))) return null;
  if (!["create", "update", "visibility"].includes(String(source.action))) return null;
  const change = normalizePageChange(value);
  if (!change || change.action === "duplicate") return null;
  const targetSiteId = change.action === "create" ? change.siteId : change.target.siteId;
  return targetSiteId === siteId ? change : null;
}
function catalogPage(value: unknown, siteId: string): EditorPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["siteId", "pageId", "locale", "title", "path", "kind", "visibility", "published"].includes(key))
    || source.siteId !== siteId || typeof source.title !== "string" || !source.title.trim() || source.title.length > 300
    || source.path !== undefined && (typeof source.path !== "string" || source.path.length > 300)
    || source.kind !== undefined && !["page", "template", "shared"].includes(String(source.kind))
    || source.visibility !== undefined && !["public", "private"].includes(String(source.visibility))
    || source.published !== undefined && typeof source.published !== "boolean") return null;
  try {
    return { siteId, pageId: identifier(source.pageId, "$page.pageId"), locale: localeCode(source.locale, "$page.locale"), title: source.title,
      ...(source.path === undefined ? {} : { path: source.path as string }), ...(source.kind === undefined ? {} : { kind: source.kind as NonNullable<EditorPage["kind"]> }),
      ...(source.visibility === undefined ? {} : { visibility: source.visibility as NonNullable<EditorPage["visibility"]> }), ...(source.published === undefined ? {} : { published: source.published }) };
  } catch { return null; }
}
function releaseRequest(value: Record<string, unknown>, target: EditingPageTarget): EditorReleaseRequest | null {
  const allowed = ["expectedVersion", "action", "revision", "componentsVersion", "presentationVersion"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !validVersion(value.expectedVersion)
    || value.action !== "publish" && value.action !== "rollback"
    || value.action === "publish" && value.revision !== undefined
    || value.action === "rollback" && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    || value.componentsVersion !== undefined && !validVersion(value.componentsVersion)
    || value.presentationVersion !== undefined && !validVersion(value.presentationVersion)) return null;
  return {
    target, expectedVersion: value.expectedVersion, action: value.action,
    ...(value.revision === undefined ? {} : { revision: Number(value.revision) }),
    ...(value.componentsVersion === undefined ? {} : { componentsVersion: value.componentsVersion }),
    ...(value.presentationVersion === undefined ? {} : { presentationVersion: value.presentationVersion })
  };
}
const PLAN_KEYS = ["target", "expectedVersion", "action", "revision", "componentsVersion", "presentationVersion", "confirmationToken", "domain", "changes", "url", "affected"] as const;
function validReleasePlan(value: unknown, request: EditorReleaseRequest, site: EditorSite): value is EditorReleasePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (Object.keys(plan).some((key) => !PLAN_KEYS.includes(key as typeof PLAN_KEYS[number]))
    || !plan.target || typeof plan.target !== "object" || Array.isArray(plan.target) || !exactKeys(plan.target as Record<string, unknown>, ["siteId", "pageId", "locale"])
    || typeof plan.confirmationToken !== "string" || !validVersion(plan.confirmationToken)
    || !Array.isArray(plan.changes) || plan.changes.length > 100
    || plan.changes.some((change) => {
      if (!change || typeof change !== "object" || Array.isArray(change)) return true;
      const row = change as Record<string, unknown>;
      return !exactKeys(row, ["path", "before", "after"]) || typeof row.path !== "string" || row.path.length > 300
        || typeof row.before !== "string" || row.before.length > 1200 || typeof row.after !== "string" || row.after.length > 1200;
    })) return false;
  try {
    validateReleasePlan(value as EditorReleasePlan, request, site);
    return true;
  } catch { return false; }
}
async function documentContext(adapter: PageEditingHostAdapter, actor: EditingActor, target: EditingPageTarget): Promise<PageEditingValidationContext> {
  return adapter.validationContext ? adapter.validationContext(actor, target) : {};
}
function validatedDocument(value: unknown, context: PageEditingValidationContext): PageDocument {
  return parsePageDocument(value, context.blocks ?? {}, {
    ...(context.components ? { components: context.components } : {}),
    ...(context.siteStyles ? { siteStyles: context.siteStyles } : {})
  });
}

/** Framework-neutral HTTP handler for the host page resource API. Authentication and persistence stay in the host. */
function editingApiBasePath(value: string | undefined): string {
  const basePath = value ?? "/api/edit/v1";
  if (!/^\/[a-z0-9/_-]+$/u.test(basePath) || basePath.endsWith("/") || basePath.includes("//")) throw new Error("invalid editing API base path");
  return basePath;
}

async function handleEditingLocalization<Id extends EditingLocalizationOperationId>(
  adapter: PageEditingHostAdapter, request: Request, url: URL, siteId: string,
  operation: EditingLocalizationOperation & { readonly id: Id },
): Promise<Response> {
  if (request.method !== operation.method) return fail("method_not_allowed", 405);
  let actor: EditingActor | null;
  try { actor = await adapter.authenticate(request); }
  catch { return fail("host_failure", 503); }
  if (!actor) return fail("authentication_required", 401);
  if (!validActor(actor)) return fail("host_contract_violation", 502);

  let input: EditingLocalizationInput<Id>;
  try {
    if (operation.method === "GET") {
      if (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length")) || url.search.length > 4096) return fail("invalid_request", 400);
      const query: Record<string, string> = Object.create(null);
      let duplicate = false;
      url.searchParams.forEach((value, name) => {
        if (Object.hasOwn(query, name)) duplicate = true;
        query[name] = value;
      });
      if (duplicate) return fail("invalid_request", 400);
      input = parseEditingLocalizationInput(operation.id, query);
    } else {
      if (url.search) return fail("invalid_request", 400);
      const body = await readBody(request, EDITING_LOCALIZATION_INPUT_BYTES);
      if (!body || body.siteId !== siteId) return fail("invalid_request", 400);
      const { siteId: _siteId, ...data } = body;
      input = parseEditingLocalizationInput(operation.id, data);
    }
  } catch { return fail("invalid_request", 400); }

  const capability = editingLocalizationCapability(operation, input);
  try {
    if (await adapter.authorize(actor, capability, editingLocalizationScope(siteId, input)) !== true) return fail("forbidden", 403);
  } catch { return fail("host_failure", 503); }

  let raw: unknown;
  try { raw = await adapter.localization![operation.id]!(actor, siteId, input); }
  catch { return fail("host_failure", 503); }
  try {
    const source = record(raw, "$result");
    if (source.status === "duplicate" && "operationId" in input && operation.errors.includes("duplicate_operation")
      && exactKeys(source, ["status"])) return fail("duplicate_operation", 409);
    if (source.status === "invalid_token" && (operation.id === "localization.release.apply"
      || operation.id === "localization.release.prepare" && "resumeToken" in input && input.resumeToken !== null)
      && exactKeys(source, ["status"])) return fail("invalid_request", 400);
    const result = parseEditingLocalizationResult(operation.id, source, input);
    if (result.status === "forbidden") return fail("forbidden", 403);
    if (result.status === "not_found") return fail("not_found", 404);
    if (result.status === "invalid") return fail("validation_failed", 422);
    if (result.status === "expired") return fail("invalid_request", 400);
    const conflict = result.status === "conflict";
    const payload = conflict ? editingLocalizationConflictBody(result as typeof result & { status: "conflict" }) : result;
    if (jsonBytes(payload) > EDITING_LOCALIZATION_RESULT_BYTES) return fail("host_contract_violation", 502);
    return response(payload, conflict ? 409 : 200);
  } catch { return fail("host_contract_violation", 502); }
}

export function createPageEditingApi(adapter: PageEditingHostAdapter, options: PageEditingApiOptions = {}): (request: Request) => Promise<Response> {
  const basePath = editingApiBasePath(options.basePath);
  return async (request) => {
    const url = new URL(request.url);
    if (url.hash || url.pathname !== url.pathname.normalize("NFC")) return fail("invalid_request", 400);
    const discoveryMatch = new RegExp(`^${basePath}/sites/([^/]+)/capabilities$`, "u").exec(url.pathname);
    if (discoveryMatch) {
      if (request.method !== "GET") return fail("method_not_allowed", 405);
      if (url.search || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(discoveryMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      let actor: EditingActor | null;
      try { actor = await adapter.authenticate(request); }
      catch { return fail("host_failure", 503); }
      if (!actor) return fail("authentication_required", 401);
      if (!validActor(actor)) return fail("host_contract_violation", 502);
      const operations = [];
      for (const operation of EDITING_OPERATIONS) {
        if (!supportsOperation(adapter, operation)) continue;
        try {
          for (const capability of operationCapabilities(operation)) {
            if (await adapter.authorize(actor, capability, { siteId }) === true) {
              operations.push(operation);
              break;
            }
          }
        }
        catch { return fail("host_failure", 503); }
      }
      if (operations.length === 0) return fail("forbidden", 403);
      return response({ apiVersion: "v1", siteId, operations });
    }
    const localizationMatch = new RegExp(`^${basePath}/sites/([^/]+)/operations/(localization\\.[a-z.]+)$`, "u").exec(url.pathname);
    if (localizationMatch) {
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(localizationMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      const operation = editingLocalizationOperation(localizationMatch[2]!);
      if (!operation || typeof adapter.localization?.[operation.id] !== "function") return fail("not_found", 404);
      return handleEditingLocalization(adapter, request, url, siteId, operation);
    }
    const releaseSetMatch = new RegExp(`^${basePath}/sites/([^/]+)/operations/(pages\\.release-set-plan|pages\\.release-set|pages\\.release-set-status)(?:/([^/]+))?$`, "u").exec(url.pathname);
    if (releaseSetMatch) {
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(releaseSetMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      let operationId: string | undefined;
      try { operationId = releaseSetMatch[3] === undefined ? undefined : decodeURIComponent(releaseSetMatch[3]); }
      catch { return fail("invalid_request", 400); }
      const operation = EDITING_OPERATIONS.find((item) => item.id === releaseSetMatch[2]);
      if (!operation || !supportsOperation(adapter, operation)) return fail("not_found", 404);
      if (request.method !== operation.method) return fail("method_not_allowed", 405);
      if (url.search) return fail("invalid_request", 400);
      if (operation.id === "pages.release-set-status" && (!operationId || !validOperationId(operationId))
        || operation.id !== "pages.release-set-status" && operationId !== undefined) return fail("invalid_request", 400);
      let actor: EditingActor | null;
      try { actor = await adapter.authenticate(request); }
      catch { return fail("host_failure", 503); }
      if (!actor) return fail("authentication_required", 401);
      if (!validActor(actor)) return fail("host_contract_violation", 502);
      if (operation.id === "pages.release-set-status") {
        if (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let allowed: boolean;
        try { allowed = await adapter.authorize(actor, "pages.read", { siteId }) === true; }
        catch { return fail("host_failure", 503); }
        if (!allowed) return fail("forbidden", 403);
        let status: EditingPageReleaseSetStatus | null;
        try { status = await adapter.readPageReleaseSetStatus!(actor, siteId, operationId!); }
        catch { return fail("host_failure", 503); }
        if (!status) return response({ status: "unknown", operationId });
        if (status.operationId !== operationId || !["unknown", "received", "completed"].includes(status.status)) return fail("host_contract_violation", 502);
        if (status.status === "completed") {
          if (!Number.isInteger(status.httpStatus) || status.httpStatus < 100 || status.httpStatus > 599
            || !status.result || typeof status.result !== "object" || Array.isArray(status.result)) return fail("host_contract_violation", 502);
          if (status.httpStatus === 200 && !pageReleaseSetApplyResult(status.result, siteId, operationId!)) return fail("host_contract_violation", 502);
          return response({ status: status.status, operationId, httpStatus: status.httpStatus, result: status.result });
        }
        if (!exactKeys(status, ["status", "operationId"])) return fail("host_contract_violation", 502);
        return response({ status: status.status, operationId });
      }
      let body: Record<string, unknown> | null;
      try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
      if (!body || body.siteId !== siteId || !validOperationId(body.operationId)) return fail("invalid_request", 400);
      const items = pageReleaseSetItems(body.items, siteId);
      if (!items) return fail("invalid_request", 400);
      if (operation.id === "pages.release-set-plan") {
        if (!exactKeys(body, ["siteId", "operationId", "items"])) return fail("invalid_request", 400);
      } else if (!exactKeys(body, ["siteId", "operationId", "confirmationToken", "items"]) || !validVersion(body.confirmationToken)) {
        return fail("invalid_request", 400);
      }
      for (const item of items) {
        let allowed: boolean;
        try { allowed = await adapter.authorize(actor, "pages.publish", item.target) === true; }
        catch { return fail("host_failure", 503); }
        if (!allowed) return fail("forbidden", 403);
      }
      if (operation.id === "pages.release-set-plan") {
        let prepared: EditingPageReleaseSetPrepareResult;
        try { prepared = await adapter.preparePageReleaseSet!(actor, siteId, body.operationId, items); }
        catch { return fail("host_failure", 503); }
        if (!prepared || !["prepared", "conflict", "invalid", "not_found", "duplicate"].includes(prepared.status)) return fail("host_contract_violation", 502);
        if (prepared.status === "conflict") return fail("version_conflict", 409);
        if (prepared.status === "invalid") return fail("invalid_request", 400);
        if (prepared.status === "not_found") return fail("not_found", 404);
        if (prepared.status === "duplicate") return fail("duplicate_operation", 409);
        const plan = prepared.plan as unknown;
        if (!plan || typeof plan !== "object" || Array.isArray(plan)) return fail("host_contract_violation", 502);
        const source = plan as Record<string, unknown>;
        const planItems = pageReleaseSetItems(source.items, siteId);
        let site: EditorSite | null;
        try { site = await adapter.releaseSite!(actor, siteId); }
        catch { return fail("host_failure", 503); }
        if (!exactKeys(source, ["siteId", "operationId", "confirmationToken", "domain", "items"]) || source.siteId !== siteId
          || source.operationId !== body.operationId || !validVersion(source.confirmationToken) || !isSafeHttpsOrigin(source.domain)
          || !planItems || !samePageReleaseSetItems(items, planItems) || !site || site.id !== siteId || !Array.isArray(site.domains) || !site.domains.includes(source.domain)) {
          return fail("host_contract_violation", 502);
        }
        return response({ plan: { siteId, operationId: source.operationId, confirmationToken: source.confirmationToken, domain: source.domain, items: planItems } });
      }
      let applied: EditingPageReleaseSetApplyResult;
      try { applied = await adapter.publishPageReleaseSet!(actor, siteId, { operationId: body.operationId,
        confirmationToken: body.confirmationToken as string, items }); }
      catch { return fail("host_failure", 503); }
      if (!applied || !["completed", "publishing", "conflict", "invalid", "not_found", "duplicate"].includes(applied.status)) return fail("host_contract_violation", 502);
      if (applied.status === "conflict") return fail("version_conflict", 409);
      if (applied.status === "invalid") return fail("invalid_request", 400);
      if (applied.status === "not_found") return fail("not_found", 404);
      if (applied.status === "duplicate") return fail("duplicate_operation", 409);
      const result = pageReleaseSetApplyResult(applied, siteId, body.operationId, items);
      if (!result) return fail("host_contract_violation", 502);
      return response(result);
    }
    const siteSettingsMatch = new RegExp(`^${basePath}/sites/([^/]+)/operations/(site\\.breakpoints\\.(?:read|save))$`, "u").exec(url.pathname);
    if (siteSettingsMatch) {
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(siteSettingsMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      const operation = EDITING_OPERATIONS.find((item) => item.id === siteSettingsMatch[2]);
      if (!operation || !supportsOperation(adapter, operation)) return fail("not_found", 404);
      if (request.method !== operation.method) return fail("method_not_allowed", 405);
      if (url.search) return fail("invalid_request", 400);
      let actor: EditingActor | null;
      try { actor = await adapter.authenticate(request); }
      catch { return fail("host_failure", 503); }
      if (!actor) return fail("authentication_required", 401);
      if (!validActor(actor)) return fail("host_contract_violation", 502);
      let allowed: boolean;
      try { allowed = await adapter.authorize(actor, operation.capability, { siteId }) === true; }
      catch { return fail("host_failure", 503); }
      if (!allowed) return fail("forbidden", 403);
      if (operation.id === "site.breakpoints.read") {
        if (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let snapshot: EditorBreakpointSettingsSnapshot | null;
        try { snapshot = await adapter.readBreakpointSettings!(actor, siteId); }
        catch { return fail("host_failure", 503); }
        if (!snapshot) return fail("not_found", 404);
        if (!validVersion(snapshot.version)) return fail("host_contract_violation", 502);
        let settings: EditorBreakpointSettings;
        try { settings = parseBreakpointSettings(snapshot.settings); }
        catch { return fail("host_contract_violation", 502); }
        return response({ settings, version: snapshot.version });
      }
      let body: Record<string, unknown> | null;
      try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
      if (!body || !exactKeys(body, ["expectedVersion", "settings"]) || !validVersion(body.expectedVersion)) return fail("invalid_request", 400);
      let settings: EditorBreakpointSettings;
      try { settings = parseBreakpointSettings(body.settings); }
      catch { return fail("invalid_request", 400); }
      let result: EditorBreakpointSettingsSaveResult;
      try { result = await adapter.saveBreakpointSettings!(actor, siteId, body.expectedVersion, settings); }
      catch { return fail("host_failure", 503); }
      if (!result || typeof result !== "object" || !["saved", "conflict"].includes(result.status)) return fail("host_contract_violation", 502);
      if (result.status === "conflict") return fail("version_conflict", 409);
      if (!validVersion(result.version)) return fail("host_contract_violation", 502);
      return response({ status: "saved", version: result.version });
    }
    const cmsMatch = new RegExp(`^${basePath}/sites/([^/]+)/operations/(cms\\.(?:schema|list|read|create|save|publish-plan|publish|operation-status))(?:/([^/]+))?(?:/([^/]+))?$`, "u").exec(url.pathname);
    if (cmsMatch) {
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(cmsMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      if (url.search) return fail("invalid_request", 400);
      const operation = EDITING_OPERATIONS.find((item) => item.id === cmsMatch[2]);
      if (!operation || !supportsOperation(adapter, operation)) return fail("not_found", 404);
      if (request.method !== operation.method) return fail("method_not_allowed", 405);
      const isOperationStatus = operation.id === "cms.operation-status";
      let rawCollectionId: string | undefined, rawItemId: string | undefined;
      try {
        rawCollectionId = isOperationStatus || cmsMatch[3] === undefined ? undefined : decodeURIComponent(cmsMatch[3]);
        rawItemId = isOperationStatus || cmsMatch[4] === undefined ? undefined : decodeURIComponent(cmsMatch[4]);
      } catch { return fail("invalid_request", 400); }
      const collectionId = rawCollectionId === undefined ? undefined : cmsCollectionId(rawCollectionId);
      const itemId = rawItemId === undefined ? undefined : cmsItemId(rawItemId);
      if (rawCollectionId !== undefined && !collectionId || rawItemId !== undefined && !itemId) return fail("invalid_request", 400);
      let actor: EditingActor | null;
      try { actor = await adapter.authenticate(request); }
      catch { return fail("host_failure", 503); }
      if (!actor) return fail("authentication_required", 401);
      if (!validActor(actor)) return fail("host_contract_violation", 502);
      const scope: EditingAuthorizationScope = { siteId, ...(collectionId ? { collectionId } : {}), ...(itemId ? { itemId } : {}) };
      let allowed: boolean;
      try { allowed = await adapter.authorize(actor, operation.capability, scope) === true; }
      catch { return fail("host_failure", 503); }
      if (!allowed) return fail("forbidden", 403);

      if (operation.id === "cms.schema") {
        if (cmsMatch[3] !== undefined || cmsMatch[4] !== undefined || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let schema: ReturnType<typeof parseCollectionSchemaResult>;
        try { schema = parseCollectionSchemaResult(await adapter.readCmsSchema!(actor, siteId)); }
        catch { return fail("host_contract_violation", 502); }
        if (schema.status === "forbidden") return fail("forbidden", 403);
        return response({ collections: schema.collections });
      }
      if (operation.id === "cms.operation-status") {
        if (collectionId !== undefined || itemId !== undefined || cmsMatch[4] !== undefined || !cmsMatch[3]) return fail("invalid_request", 400);
        let operationId: string;
        try { operationId = decodeURIComponent(cmsMatch[3]); }
        catch { return fail("invalid_request", 400); }
        if (!validOperationId(operationId) || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let status: EditingCmsOperationStatus | null;
        try { status = await adapter.readCmsOperationStatus!(actor, siteId, operationId); }
        catch { return fail("host_failure", 503); }
        if (!status) return response({ status: "unknown", operationId });
        if (status.operationId !== operationId || !["unknown", "received", "completed"].includes(status.status)) return fail("host_contract_violation", 502);
        if (status.status === "completed") {
          if (!Number.isInteger(status.httpStatus) || status.httpStatus < 100 || status.httpStatus > 599
            || !status.result || typeof status.result !== "object" || Array.isArray(status.result)) return fail("host_contract_violation", 502);
          return response({ status: status.status, operationId, httpStatus: status.httpStatus, result: status.result });
        }
        if (status.status === "unknown" && !exactKeys(status, ["status", "operationId"])
          || status.status === "received" && !exactKeys(status, ["status", "operationId"])) return fail("host_contract_violation", 502);
        return response({ status: status.status, operationId });
      }
      if (!collectionId) return fail("invalid_request", 400);
      if (operation.id === "cms.list") {
        if (itemId !== undefined || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.listCmsItems!(actor, siteId, collectionId); }
        catch { return fail("host_failure", 503); }
        if (!raw) return fail("not_found", 404);
        let result: ReturnType<typeof parseCollectionListResult>;
        try { result = parseCollectionListResult(raw, collectionId); }
        catch { return fail("host_contract_violation", 502); }
        if (result.status === "forbidden") return fail("forbidden", 403);
        return response({ collectionId: result.collectionId, items: result.items });
      }
      let definition: CollectionDefinition | "forbidden" | null;
      try { definition = await cmsDefinition(adapter, actor, siteId, collectionId); }
      catch { return fail("host_contract_violation", 502); }
      if (definition === "forbidden") return fail("forbidden", 403);
      if (!definition) return fail("not_found", 404);
      if (operation.id === "cms.read") {
        if (!itemId || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.readCmsItem!(actor, { siteId, collectionId, itemId }); }
        catch { return fail("host_failure", 503); }
        if (!raw) return fail("not_found", 404);
        let result: ReturnType<typeof parseCollectionItemResult>;
        try { result = parseCollectionItemResult(raw, definition, itemId); }
        catch { return fail("host_contract_violation", 502); }
        if (result.status === "forbidden") return fail("forbidden", 403);
        if (result.status === "not_found") return fail("not_found", 404);
        return response({ item: result.item });
      }
      if (operation.id === "cms.create") {
        if (itemId !== undefined) return fail("invalid_request", 400);
        if (!definition.capabilities.create) return fail("forbidden", 403);
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, ["operationId"]) || !validOperationId(body.operationId)) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.createCmsItem!(actor, siteId, collectionId, body.operationId); }
        catch { return fail("host_failure", 503); }
        if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).status === "duplicate") return fail("duplicate_operation", 409);
        let result: ReturnType<typeof parseCollectionCreateResult>;
        try { result = parseCollectionCreateResult(raw, definition); }
        catch { return fail("host_contract_violation", 502); }
        if (result.status === "forbidden") return fail("forbidden", 403);
        if (result.status === "not_found") return fail("not_found", 404);
        return response({ item: result.item });
      }
      if (operation.id === "cms.save") {
        if (!itemId) return fail("invalid_request", 400);
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, ["expectedVersion", "operationId", "values"]) || !validVersion(body.expectedVersion) || !validOperationId(body.operationId)) return fail("invalid_request", 400);
        let values: CollectionValues;
        try { values = parseCollectionValues(body.values, definition); }
        catch { return fail("invalid_request", 400); }
        let raw: unknown;
        try { raw = await adapter.saveCmsItem!(actor, { siteId, collectionId, itemId }, body.expectedVersion, body.operationId, values); }
        catch { return fail("host_failure", 503); }
        if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).status === "duplicate") return fail("duplicate_operation", 409);
        let result: ReturnType<typeof parseCollectionSaveResult>;
        try { result = parseCollectionSaveResult(raw, definition, itemId); }
        catch { return fail("host_contract_violation", 502); }
        if (result.status === "forbidden") return fail("forbidden", 403);
        if (result.status === "not_found") return fail("not_found", 404);
        if (result.status === "invalid") return response({ error: "validation_failed", fields: result.errors }, 422);
        if (result.status === "conflict") return response({ error: "version_conflict", current: result.item }, 409);
        return response({ status: "saved", item: result.item });
      }
      if (!itemId) return fail("invalid_request", 400);
      const target = cmsTarget(siteId, collectionId, itemId);
      if (!target) return fail("invalid_request", 400);
      if (operation.id === "cms.publish-plan") {
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, body.redirect === undefined ? ["expectedVersion", "operationId"] : ["expectedVersion", "operationId", "redirect"])
          || !validVersion(body.expectedVersion) || !validOperationId(body.operationId) || body.redirect !== undefined && typeof body.redirect !== "boolean") return fail("invalid_request", 400);
        let prepared: EditingCmsPublishPrepareResult;
        try { prepared = await adapter.prepareCmsPublish!(actor, target, body.expectedVersion, body.operationId, body.redirect === undefined ? {} : { redirect: body.redirect }); }
        catch { return fail("host_failure", 503); }
        if (!prepared || typeof prepared !== "object" || !["prepared", "conflict", "invalid", "not_found", "duplicate"].includes(prepared.status)) return fail("host_contract_violation", 502);
        if (prepared.status === "conflict") return fail("version_conflict", 409);
        if (prepared.status === "invalid") {
          try {
            const invalid = parseCollectionPublishResult({ status: "invalid", errors: prepared.errors }, definition, itemId);
            return invalid.status === "invalid" ? response({ error: "validation_failed", fields: invalid.errors }, 422) : fail("host_contract_violation", 502);
          } catch { return fail("host_contract_violation", 502); }
        }
        if (prepared.status === "not_found") return fail("not_found", 404);
        if (prepared.status === "duplicate") return fail("duplicate_operation", 409);
        const plan = prepared.plan as unknown;
        if (!plan || typeof plan !== "object" || Array.isArray(plan)) return fail("host_contract_violation", 502);
        const value = plan as Record<string, unknown>;
        if (!exactKeys(value, value.redirect === undefined ? ["target", "expectedVersion", "operationId", "confirmationToken", "item"] : ["target", "expectedVersion", "operationId", "confirmationToken", "item", "redirect"])
          || value.redirect !== body.redirect || value.expectedVersion !== body.expectedVersion
          || value.operationId !== body.operationId || !validVersion(value.confirmationToken) || !value.target || typeof value.target !== "object" || Array.isArray(value.target)) return fail("host_contract_violation", 502);
        const planTarget = value.target as Record<string, unknown>;
        if (!exactKeys(planTarget, ["siteId", "collectionId", "itemId"]) || planTarget.siteId !== siteId || planTarget.collectionId !== collectionId || planTarget.itemId !== itemId) return fail("host_contract_violation", 502);
        let item: CollectionItem;
        try { item = parseCollectionItem(value.item, definition, itemId); }
        catch { return fail("host_contract_violation", 502); }
        if (item.version !== body.expectedVersion) return fail("host_contract_violation", 502);
        return response({ plan: { target, expectedVersion: body.expectedVersion, operationId: body.operationId, confirmationToken: value.confirmationToken, item,
          ...(value.redirect === undefined ? {} : { redirect: value.redirect as boolean }) } });
      }
      if (operation.id === "cms.publish") {
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, body.redirect === undefined ? ["expectedVersion", "operationId", "confirmationToken"] : ["expectedVersion", "operationId", "confirmationToken", "redirect"])
          || !validVersion(body.expectedVersion) || !validOperationId(body.operationId) || !validVersion(body.confirmationToken)
          || body.redirect !== undefined && typeof body.redirect !== "boolean") return fail("invalid_request", 400);
        let applied: EditingCmsPublishApplyResult;
        try { applied = await adapter.publishCmsItem!(actor, target, { expectedVersion: body.expectedVersion, operationId: body.operationId, confirmationToken: body.confirmationToken,
          ...(body.redirect === undefined ? {} : { redirect: body.redirect as boolean }) }); }
        catch { return fail("host_failure", 503); }
        if (!applied || typeof applied !== "object" || !["published", "publishing", "conflict", "invalid", "not_found", "duplicate"].includes(applied.status)) return fail("host_contract_violation", 502);
        if (applied.status === "conflict") return fail("version_conflict", 409);
        if (applied.status === "invalid") {
          try {
            const invalid = parseCollectionPublishResult({ status: "invalid", errors: applied.errors }, definition, itemId);
            return invalid.status === "invalid" ? response({ error: "validation_failed", fields: invalid.errors }, 422) : fail("host_contract_violation", 502);
          } catch { return fail("host_contract_violation", 502); }
        }
        if (applied.status === "not_found") return fail("not_found", 404);
        if (applied.status === "duplicate") return fail("duplicate_operation", 409);
        if (applied.operationId !== body.operationId) return fail("host_contract_violation", 502);
        let item: CollectionItem;
        try {
          const result = parseCollectionPublishResult({ status: applied.status, item: applied.item }, definition, itemId);
          if (result.status !== "published" && result.status !== "publishing") return fail("host_contract_violation", 502);
          item = result.item;
        }
        catch { return fail("host_contract_violation", 502); }
        return response({ status: applied.status, operationId: applied.operationId, item });
      }
      return fail("not_found", 404);
    }
    const assetMatch = new RegExp(`^${basePath}/sites/([^/]+)/operations/(assets\\.(?:list|usages|resolve|update|upload-intent|delete|restore))(?:/([^/]+)/([^/]+))?$`, "u").exec(url.pathname);
    if (assetMatch) {
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(assetMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      const operation = EDITING_OPERATIONS.find((item) => item.id === assetMatch[2]);
      if (!operation || !supportsOperation(adapter, operation)) return fail("not_found", 404);
      if (request.method !== operation.method) return fail("method_not_allowed", 405);
      let reference: AssetReference | undefined;
      if (assetMatch[3] !== undefined || assetMatch[4] !== undefined) {
        let providerValue: string, assetValue: string;
        try { providerValue = decodeURIComponent(assetMatch[3] ?? ""); assetValue = decodeURIComponent(assetMatch[4] ?? ""); }
        catch { return fail("invalid_request", 400); }
        reference = editingAssetReference(providerValue, assetValue) ?? undefined;
        if (!reference || assetMatch[3] === undefined || assetMatch[4] === undefined) return fail("invalid_request", 400);
      }
      if (operation.id === "assets.list") {
        if (reference || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
      } else if (operation.id === "assets.usages" || operation.id === "assets.update" || operation.id === "assets.delete" || operation.id === "assets.restore") {
        if (!reference) return fail("invalid_request", 400);
      } else if (reference) return fail("invalid_request", 400);
      const scope: EditingAuthorizationScope = { siteId, ...(reference ? { assetProvider: reference.provider, assetId: reference.id } : {}) };
      let actor: EditingActor | null;
      try { actor = await adapter.authenticate(request); }
      catch { return fail("host_failure", 503); }
      if (!actor) return fail("authentication_required", 401);
      if (!validActor(actor)) return fail("host_contract_violation", 502);
      let allowed: boolean;
      try { allowed = await adapter.authorize(actor, operation.capability, scope) === true; }
      catch { return fail("host_failure", 503); }
      if (!allowed) return fail("forbidden", 403);

      if (operation.id === "assets.list") {
        const query = assetListQuery(url, siteId);
        if (!query) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.listAssets!(actor, query); }
        catch { return fail("host_failure", 503); }
        if (raw === null) return fail("not_found", 404);
        let result: ReturnType<typeof parseAssetListResult>;
        try { result = parseAssetListResult(raw, siteId); }
        catch { return fail("host_contract_violation", 502); }
        if (result.assets.some((asset) => query.provider !== undefined && asset.provider !== query.provider)) return fail("host_contract_violation", 502);
        return response(result);
      }
      if (operation.id === "assets.usages") {
        if (url.search || request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.listAssetUsages!(actor, siteId, reference!); }
        catch { return fail("host_failure", 503); }
        try { return response({ usages: parseAssetUsages(raw) }); }
        catch { return fail("host_contract_violation", 502); }
      }
      if (operation.id === "assets.resolve") {
        if (url.search) return fail("invalid_request", 400);
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, ["references"]) || !Array.isArray(body.references) || body.references.length > ASSET_LIMITS.resolvedAssets) return fail("invalid_request", 400);
        let references: AssetReference[];
        try { references = body.references.map((value) => parseAssetReference(value)); }
        catch { return fail("invalid_request", 400); }
        let raw: unknown;
        try { raw = await adapter.resolveAssets!(actor, siteId, references); }
        catch { return fail("host_failure", 503); }
        let result: ResolvedAssetMap;
        try { result = parseResolvedAssets(raw); }
        catch { return fail("host_contract_violation", 502); }
        const requested = new Set(references.map((item) => `${item.provider}:${item.id}`));
        if (Object.keys(result).some((key) => !requested.has(key))) return fail("host_contract_violation", 502);
        return response({ assets: result });
      }
      if (operation.id === "assets.upload-intent") {
        if (url.search) return fail("invalid_request", 400);
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, ["name", "mimeType", "bytes", "folderId", "provider"]) || !validAssetName(body.name) || !validMimeType(body.mimeType)
          || !Number.isSafeInteger(body.bytes) || Number(body.bytes) < 1 || body.folderId !== null && typeof body.folderId !== "string"
          || body.folderId !== null && (() => { try { assetId(body.folderId, "$folderId"); return false; } catch { return true; } })()
          || typeof body.provider !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(body.provider)) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.createAssetUploadIntent!(actor, siteId, { name: body.name, mimeType: body.mimeType, bytes: Number(body.bytes), folderId: body.folderId as string | null, provider: body.provider }); }
        catch { return fail("host_failure", 503); }
        try { return response(parseAssetUploadIntent(raw), 201); }
        catch { return fail("host_contract_violation", 502); }
      }
      if (operation.id === "assets.update") {
        if (url.search) return fail("invalid_request", 400);
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, ["expectedVersion", "changes"]) || !validVersion(body.expectedVersion) || !body.changes || typeof body.changes !== "object" || Array.isArray(body.changes)) return fail("invalid_request", 400);
        const changes = body.changes as Record<string, unknown>;
        const changeKeys = Object.keys(changes);
        if (!changeKeys.length || changeKeys.some((key) => !["name", "alt", "folderId"].includes(key))
          || Object.hasOwn(changes, "name") && !validAssetName(changes.name)
          || Object.hasOwn(changes, "alt") && (typeof changes.alt !== "string" || changes.alt.length > ASSET_LIMITS.altLength || /[\u0000-\u001f\u007f]/u.test(changes.alt))
          || Object.hasOwn(changes, "folderId") && changes.folderId !== null && (typeof changes.folderId !== "string" || (() => { try { assetId(changes.folderId, "$folderId"); return false; } catch { return true; } })())) return fail("invalid_request", 400);
        let raw: unknown;
        try { raw = await adapter.updateAsset!(actor, { siteId, reference: reference!, expectedVersion: body.expectedVersion, changes: changes as AssetUpdateRequest["changes"] }); }
        catch { return fail("host_failure", 503); }
        let result: AssetUpdateResult;
        try { result = parseAssetUpdateResult(raw, siteId); }
        catch { return fail("host_contract_violation", 502); }
        if (result.status === "saved" && (result.asset.provider !== reference!.provider || result.asset.id !== reference!.id)) return fail("host_contract_violation", 502);
        return response(result);
      }
      if (operation.id === "assets.delete" || operation.id === "assets.restore") {
        if (url.search) return fail("invalid_request", 400);
        let body: Record<string, unknown> | null;
        try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
        if (!body || !exactKeys(body, ["expectedVersion"]) || !validVersion(body.expectedVersion)) return fail("invalid_request", 400);
        let raw: unknown;
        try {
          const requestValue = { siteId, reference: reference!, expectedVersion: body.expectedVersion };
          raw = operation.id === "assets.delete" ? await adapter.deleteAsset!(actor, requestValue) : await adapter.restoreAsset!(actor, requestValue);
        } catch { return fail("host_failure", 503); }
        try { return response(operation.id === "assets.delete" ? parseAssetDeleteResult(raw) : parseAssetRestoreResult(raw)); }
        catch { return fail("host_contract_violation", 502); }
      }
      return fail("not_found", 404);
    }
    const pageManagementMatch = new RegExp(`^${basePath}/sites/([^/]+)/operations/(pages\\.(?:catalog|change-prepare|change-apply))$`, "u").exec(url.pathname);
    if (pageManagementMatch) {
      let siteId: string;
      try { siteId = identifier(decodeURIComponent(pageManagementMatch[1]!), "$siteId"); }
      catch { return fail("invalid_request", 400); }
      if (url.search) return fail("invalid_request", 400);
      const operation = EDITING_OPERATIONS.find((item) => item.id === pageManagementMatch[2]);
      if (!operation || !supportsOperation(adapter, operation)) return fail("not_found", 404);
      if (request.method !== operation.method) return fail("method_not_allowed", 405);
      let actor: EditingActor | null;
      try { actor = await adapter.authenticate(request); }
      catch { return fail("host_failure", 503); }
      if (!actor) return fail("authentication_required", 401);
      if (!validActor(actor)) return fail("host_contract_violation", 502);
      let allowed: boolean;
      try { allowed = await adapter.authorize(actor, operation.capability, { siteId }) === true; }
      catch { return fail("host_failure", 503); }
      if (!allowed) return fail("forbidden", 403);

      if (operation.id === "pages.catalog") {
        if (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
        let catalog: EditingPageCatalog | null;
        try { catalog = await adapter.readPageCatalog!(actor, siteId); }
        catch { return fail("host_failure", 503); }
        if (!catalog) return fail("not_found", 404);
        if (!validVersion(catalog.version) || !Array.isArray(catalog.pages) || catalog.pages.length > 500) return fail("host_contract_violation", 502);
        const pages = catalog.pages.map((page) => catalogPage(page, siteId));
        if (pages.some((page) => page === null) || new Set(pages.map((page) => page && `${page.pageId}\u0000${page.locale}`)).size !== pages.length) return fail("host_contract_violation", 502);
        return response({ version: catalog.version, pages });
      }

      let body: Record<string, unknown> | null;
      try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
      if (!body || !validVersion(body.expectedVersion) || !validOperationId(body.operationId)) return fail("invalid_request", 400);
      const change = managementChange(body.change, siteId);
      if (!change) return fail("invalid_request", 400);
      if (operation.id === "pages.change-prepare") {
        if (!exactKeys(body, ["expectedVersion", "operationId", "change"])) return fail("invalid_request", 400);
        let prepared: EditingPageManagementPrepareResult;
        try { prepared = await adapter.preparePageChange!(actor, siteId, body.expectedVersion, body.operationId, change); }
        catch { return fail("host_failure", 503); }
        if (!prepared || typeof prepared !== "object" || !["prepared", "conflict", "invalid", "not_found", "duplicate"].includes(prepared.status)) return fail("host_contract_violation", 502);
        if (prepared.status === "conflict") return fail("version_conflict", 409);
        if (prepared.status === "invalid") return fail("invalid_request", 400);
        if (prepared.status === "not_found") return fail("not_found", 404);
        if (prepared.status === "duplicate") return fail("duplicate_operation", 409);
        const rawPlan = prepared.plan as unknown;
        if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) return fail("host_contract_violation", 502);
        const source = rawPlan as Record<string, unknown>;
        if (!exactKeys(source, ["expectedVersion", "operationId", "change", "confirmationToken", "domain", "impact"])
          || source.expectedVersion !== body.expectedVersion || source.operationId !== body.operationId || typeof source.confirmationToken !== "string" || !validVersion(source.confirmationToken)) {
          return fail("host_contract_violation", 502);
        }
        let site: EditorSite | null;
        try { site = await adapter.releaseSite!(actor, siteId); }
        catch { return fail("host_failure", 503); }
        if (!site || site.id !== siteId || !Array.isArray(site.domains) || site.domains.length === 0) return fail("host_contract_violation", 502);
        let checkedPlan: EditorPageChangePlan;
        try { checkedPlan = validatePageChangePlan(source, change, site); }
        catch { return fail("host_contract_violation", 502); }
        return response({ plan: { ...checkedPlan, expectedVersion: body.expectedVersion, operationId: body.operationId } });
      }

      if (!exactKeys(body, ["expectedVersion", "operationId", "confirmationToken", "change"]) || !validVersion(body.confirmationToken)) return fail("invalid_request", 400);
      let applied: EditingPageManagementApplyResult;
      try { applied = await adapter.applyPageChange!(actor, siteId, {
        expectedVersion: body.expectedVersion, operationId: body.operationId, confirmationToken: body.confirmationToken, change,
      }); }
      catch { return fail("host_failure", 503); }
      if (!applied || typeof applied !== "object" || !["applied", "conflict", "invalid", "not_found", "duplicate"].includes(applied.status)) return fail("host_contract_violation", 502);
      if (applied.status === "conflict") return fail("version_conflict", 409);
      if (applied.status === "invalid") return fail("invalid_request", 400);
      if (applied.status === "not_found") return fail("not_found", 404);
      if (applied.status === "duplicate") return fail("duplicate_operation", 409);
      const page = catalogPage(applied.page, siteId);
      if (applied.operationId !== body.operationId || !page || page.kind !== "page" || !page.path) return fail("host_contract_violation", 502);
      const matches = change.action === "create" ? page.title === change.title && page.path === change.path && page.visibility === "public" && page.published === false
        : change.action === "update" ? page.pageId === change.target.pageId && page.title === change.title && page.path === change.path
          : page.pageId === change.target.pageId && page.visibility === change.visibility;
      if (!matches) return fail("host_contract_violation", 502);
      return response({ status: "applied", operationId: applied.operationId, page });
    }
    const match = new RegExp(`^${basePath}/sites/([^/]+)/operations/(pages\\.(?:read|save|release-plan|release))/([^/]+)$`, "u").exec(url.pathname);
    if (!match) return fail("not_found", 404);
    let siteId: string, pageId: string, locale: string;
    try {
      siteId = decodeURIComponent(match[1]!); pageId = decodeURIComponent(match[3]!);
      if (url.searchParams.size !== 1 || !url.searchParams.has("locale")) return fail("invalid_request", 400);
      locale = url.searchParams.get("locale") ?? "";
    } catch { return fail("invalid_request", 400); }
    const target = pageTarget(siteId, pageId, locale);
    if (!target) return fail("invalid_request", 400);
    const operation = EDITING_OPERATIONS.find((item) => item.id === match[2]);
    if (!operation) return fail("not_found", 404);
    if (request.method !== operation.method) return fail("method_not_allowed", 405);
    let actor: EditingActor | null;
    try { actor = await adapter.authenticate(request); }
    catch { return fail("host_failure", 503); }
    if (!actor) return fail("authentication_required", 401);
    if (!validActor(actor)) return fail("host_contract_violation", 502);
    let allowed: boolean;
    try { allowed = await adapter.authorize(actor, operation.capability, target) === true; }
    catch { return fail("host_failure", 503); }
    if (!allowed) return fail("forbidden", 403);
    if (operation.id === "pages.read") {
      if (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length"))) return fail("invalid_request", 400);
      let snapshot: EditingPageSnapshot | null;
      try { snapshot = await adapter.readPage(actor, target); }
      catch { return fail("host_failure", 503); }
      if (!snapshot) return fail("not_found", 404);
      let context: PageEditingValidationContext;
      try { context = await documentContext(adapter, actor, target); }
      catch { return fail("host_failure", 503); }
      let document: PageDocument;
      try { document = validatedDocument(snapshot.document, context); }
      catch { return fail("host_contract_violation", 502); }
      if (document.siteId !== target.siteId || document.pageId !== target.pageId || document.locale !== target.locale || !validVersion(snapshot.version)) return fail("host_contract_violation", 502);
      if (snapshot.componentsVersion !== undefined && !validVersion(snapshot.componentsVersion)
        || snapshot.presentationVersion !== undefined && !validVersion(snapshot.presentationVersion)) return fail("host_contract_violation", 502);
      return response({ document, version: snapshot.version,
        ...(snapshot.componentsVersion === undefined ? {} : { componentsVersion: snapshot.componentsVersion }),
        ...(snapshot.presentationVersion === undefined ? {} : { presentationVersion: snapshot.presentationVersion }) });
    }
    if (operation.id === "pages.release-plan") {
      let body: Record<string, unknown> | null;
      try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
      const release = body && releaseRequest(body, target);
      if (!release) return fail("invalid_request", 400);
      let planResult: EditingPageReleasePrepareResult;
      let site: EditorSite | null;
      try {
        site = await adapter.releaseSite!(actor, target.siteId);
        if (!site || site.id !== target.siteId || !Array.isArray(site.domains) || site.domains.length === 0) return fail("host_contract_violation", 502);
        planResult = await adapter.preparePageRelease!(actor, release);
      } catch { return fail("host_failure", 503); }
      if (!planResult || typeof planResult !== "object" || !["prepared", "conflict"].includes(planResult.status)) return fail("host_contract_violation", 502);
      if (planResult.status === "conflict") return fail("version_conflict", 409);
      if (!validReleasePlan(planResult.plan, release, site)) return fail("host_contract_violation", 502);
      return response({ plan: planResult.plan });
    }
    if (operation.id === "pages.release") {
      let body: Record<string, unknown> | null;
      try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
      if (!body || !exactKeys(body, ["expectedVersion", "confirmationToken", "operationId"])
        || !validVersion(body.expectedVersion) || !validVersion(body.confirmationToken) || !validOperationId(body.operationId)) return fail("invalid_request", 400);
      let result: EditingPagePublishResult;
      try { result = await adapter.publishPage!(actor, target, { expectedVersion: body.expectedVersion, confirmationToken: body.confirmationToken, operationId: body.operationId }); }
      catch { return fail("host_failure", 503); }
      if (!result || typeof result !== "object" || !["released", "conflict"].includes(result.status)) return fail("host_contract_violation", 502);
      if (result.status === "conflict") return fail("version_conflict", 409);
      if (result.status !== "released" || result.operationId !== body.operationId || !validVersion(result.version)) return fail("host_contract_violation", 502);
      let document: PageDocument;
      try { document = validatedDocument(result.document, await documentContext(adapter, actor, target)); }
      catch { return fail("host_contract_violation", 502); }
      if (document.siteId !== target.siteId || document.pageId !== target.pageId || document.locale !== target.locale) return fail("host_contract_violation", 502);
      return response({ status: "released", operationId: result.operationId, version: result.version, document });
    }
    let body: Record<string, unknown> | null;
    try { body = await readBody(request); } catch { return fail("invalid_request", 400); }
    if (!body || !exactKeys(body, ["expectedVersion", "document"]) || !validVersion(body.expectedVersion)) return fail("invalid_request", 400);
    let context: PageEditingValidationContext;
    try { context = await documentContext(adapter, actor, target); }
    catch { return fail("host_failure", 503); }
    let document: PageDocument;
    try { document = validatedDocument(body.document, context); }
    catch { return fail("invalid_request", 400); }
    if (document.siteId !== target.siteId || document.pageId !== target.pageId || document.locale !== target.locale) return fail("invalid_request", 400);
    let result: EditingPageSaveResult;
    try { result = await adapter.savePage(actor, target, body.expectedVersion, document); }
    catch { return fail("host_failure", 503); }
    if (result.status === "conflict") return fail("version_conflict", 409);
    if (result.status !== "saved" || !validVersion(result.version)) return fail("host_contract_violation", 502);
    let savedDocument: PageDocument;
    try { savedDocument = validatedDocument(result.document, context); }
    catch { return fail("host_contract_violation", 502); }
    if (savedDocument.siteId !== target.siteId || savedDocument.pageId !== target.pageId || savedDocument.locale !== target.locale) return fail("host_contract_violation", 502);
    return response({ status: "saved", version: result.version, document: savedDocument });
  };
}

/** Route a multi-site host through exact registrations instead of site-name conditionals. */
export function createRegisteredPageEditingApi(registrations: readonly RegisteredPageEditingHost[], options: PageEditingApiOptions = {}): (request: Request) => Promise<Response> {
  const basePath = editingApiBasePath(options.basePath);
  if (!Array.isArray(registrations) || registrations.length === 0) throw new TypeError("at least one page editing host must be registered");
  const handlers = new Map<string, (request: Request) => Promise<Response>>();
  for (const registration of registrations) {
    if (!registration || !Array.isArray(registration.siteIds) || registration.siteIds.length === 0 || !registration.adapter) {
      throw new TypeError("invalid page editing host registration");
    }
    const handler = createPageEditingApi(registration.adapter, { basePath });
    for (const value of registration.siteIds) {
      let siteId: string;
      try { siteId = identifier(value, "$registration.siteId"); }
      catch { throw new TypeError("invalid registered page editing site ID"); }
      if (handlers.has(siteId)) throw new TypeError(`page editing site is already registered: ${siteId}`);
      handlers.set(siteId, handler);
    }
  }

  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const match = new RegExp(`^${basePath}/sites/([^/]+)(?:/|$)`, "u").exec(pathname);
    if (!match) return fail("not_found", 404);
    let siteId: string;
    try { siteId = identifier(decodeURIComponent(match[1]!), "$siteId"); }
    catch { return fail("invalid_request", 400); }
    const handler = handlers.get(siteId);
    return handler ? handler(request) : fail("not_found", 404);
  };
}
